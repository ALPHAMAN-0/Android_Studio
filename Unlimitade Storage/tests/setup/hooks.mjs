// Resolve hooks that let node:test load the app's TypeScript modules without a bundler.
// Node strips the type annotations itself; these hooks only cover what Vite normally resolves.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcDir = path.join(projectRoot, "src");
const preferencesStub = pathToFileURL(path.join(projectRoot, "tests", "setup", "preferences-stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  // The real plugin needs a WebView; tests use an in-memory stand-in.
  if (specifier === "@capacitor/preferences") {
    return { url: preferencesStub, shortCircuit: true };
  }

  // Vite's `?url` suffix: export the location of the asset instead of its content.
  if (specifier.endsWith("?url")) {
    const asset = await nextResolve(specifier.slice(0, -"?url".length), context);
    const source = `export default ${JSON.stringify(asset.url)};`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }

  // The "@/" alias from tsconfig.json / vite.config.ts, with the extension left out.
  if (specifier.startsWith("@/")) {
    const base = path.join(srcDir, specifier.slice(2));
    const file = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
      (candidate) => path.extname(candidate) !== "" && existsSync(candidate)
    );
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
