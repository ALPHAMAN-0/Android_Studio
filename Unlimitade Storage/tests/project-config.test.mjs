// Guards for files that run on a developer's machine or decide what the Android app may do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

// vite.config.ts and capacitor.config.ts are executed by `vite` and `cap` with full access to the
// machine, so they have to stay plain declarative configuration.
const NOT_ALLOWED_IN_CONFIG = {
  "evaluating code from a string": /\b(eval|Function)\s*\(/,
  "decoding embedded data": /\b(atob|Buffer\s*\.\s*from)\s*\(/,
  "reading environment variables": /\bprocess\s*\.\s*env\b|import\s*\.\s*meta\s*\.\s*env\b/,
  "network access": /\b(fetch|XMLHttpRequest|WebSocket)\b|["'](node:)?(https?|net|dgram|dns)["']/,
  "starting processes": /child[_-]process|\b(exec|spawn|fork)(Sync)?\s*\(/,
  "loading modules at run time": /\bimport\s*\(|\brequire\s*\(/,
  "imports that only run code": /^\s*import\s*["']/m,
};

for (const file of ["vite.config.ts", "capacitor.config.ts"]) {
  test(`${file} is declarative configuration only`, () => {
    const source = read(file);
    for (const [what, pattern] of Object.entries(NOT_ALLOWED_IN_CONFIG)) {
      assert.doesNotMatch(source, pattern, `${file} must not contain ${what}`);
    }
  });
}

test("package.json defines no scripts that run automatically on install", () => {
  const { scripts = {} } = JSON.parse(read("package.json"));
  const automatic = ["preinstall", "install", "postinstall", "prepare", "prepublish", "preprepare", "postprepare"];
  assert.deepEqual(Object.keys(scripts).filter((name) => automatic.includes(name)), []);
});

test("the Capacitor shell only loads the bundled app over HTTPS-only networking", () => {
  const capacitorConfig = read("capacitor.config.ts");
  assert.match(capacitorConfig, /allowMixedContent:\s*false/);
  assert.doesNotMatch(capacitorConfig, /cleartext:\s*true|\burl:\s*["']/);

  const networkConfig = read("android/app/src/main/res/xml/network_security_config.xml");
  assert.match(networkConfig, /<base-config cleartextTrafficPermitted="false">/);
  assert.doesNotMatch(networkConfig, /cleartextTrafficPermitted="true"|src="user"/);
});

test("the Android manifest keeps app data out of backups and requests only INTERNET", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);

  const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(permissions, ["android.permission.INTERNET"]);

  const provider = manifest.match(/<provider[\s\S]*?>/)[0];
  assert.match(provider, /android:exported="false"/);
});
