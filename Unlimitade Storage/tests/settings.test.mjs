import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { decryptString, encryptString } from "../src/lib/services/crypto.ts";
import { clearSettings, getSettings, isConfigured, saveSettings } from "../src/lib/services/settings.ts";
import { store } from "./setup/preferences-stub.mjs";

const SETTINGS_KEY = "unlimitade-settings";
const settings = { botToken: "test-bot-token-value", channelId: "-1000000000001" };

beforeEach(() => store.clear());

test("encryptString / decryptString round-trip, including non-ASCII text", async () => {
  const plaintext = 'token "with" quotes — ছবি 📁';
  assert.equal(await decryptString(await encryptString(plaintext)), plaintext);
});

test("every encryption uses a fresh IV and never contains the plaintext", async () => {
  const a = await encryptString("same input");
  const b = await encryptString("same input");
  assert.notEqual(a, b);
  assert.ok(!atob(a).includes("same input"));
});

test("decryptString rejects a modified ciphertext", async () => {
  const bytes = Uint8Array.from(atob(await encryptString("authentic")), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0x01;
  const tampered = btoa(String.fromCharCode(...bytes));
  await assert.rejects(decryptString(tampered));
});

test("saveSettings keeps the bot token out of the stored value", async () => {
  await saveSettings(settings);

  const stored = store.get(SETTINGS_KEY);
  assert.ok(stored, "settings should be stored");
  for (const value of store.values()) {
    assert.ok(!value.includes(settings.botToken));
    assert.ok(!value.includes(settings.channelId));
  }
  assert.deepEqual(await getSettings(), settings);
});

test("legacy plain-JSON settings are still read and are re-saved encrypted", async () => {
  store.set(SETTINGS_KEY, JSON.stringify(settings));

  assert.deepEqual(await getSettings(), settings);
  assert.ok(!store.get(SETTINGS_KEY).includes(settings.botToken));
  assert.deepEqual(await getSettings(), settings);
});

test("isConfigured needs both values; unreadable data counts as not configured", async () => {
  assert.equal(await getSettings(), null);
  assert.equal(await isConfigured(), false);

  store.set(SETTINGS_KEY, "not json and not ciphertext");
  assert.equal(await getSettings(), null);

  await saveSettings({ botToken: settings.botToken, channelId: "" });
  assert.equal(await isConfigured(), false);

  await saveSettings(settings);
  assert.equal(await isConfigured(), true);

  await clearSettings();
  assert.equal(await isConfigured(), false);
});
