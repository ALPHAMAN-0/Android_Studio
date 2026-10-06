import assert from "node:assert/strict";
import { test } from "node:test";

import { formatFileSize, generateId, sanitizeName } from "../src/lib/utils.ts";

test("sanitizeName strips path separators, control characters and shell-unsafe characters", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "....etcpasswd");
  assert.equal(sanitizeName("..\\..\\windows\\system32"), "....windowssystem32");
  assert.equal(sanitizeName("report\u0000\n\t.pdf"), "report.pdf");
  assert.equal(sanitizeName('a<b>c:d"e|f?g*h'), "abcdefgh");
});

test("sanitizeName rejects names that are empty or reserved after cleaning", () => {
  for (const bad of ["", "   ", ".", "..", "/", "\\/", "<>:?*", " . ", "a".repeat(256)]) {
    assert.equal(sanitizeName(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("sanitizeName keeps ordinary names and trims surrounding whitespace", () => {
  assert.equal(sanitizeName("  Holiday photos 2026  "), "Holiday photos 2026");
  assert.equal(sanitizeName("ছবি-০১.jpg"), "ছবি-০১.jpg");
  assert.equal(sanitizeName("archive.tar.gz"), "archive.tar.gz");
  assert.equal(sanitizeName("a".repeat(255)), "a".repeat(255));
});

test("formatFileSize formats numbers and numeric strings", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(1024), "1 KB");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize("3482911"), "3.3 MB");
  assert.equal(formatFileSize(5 * 1024 ** 3), "5 GB");
});

test("generateId returns unique 128-bit hex identifiers", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});
