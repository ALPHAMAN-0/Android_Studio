import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as db from "../src/lib/services/database.ts";
import { store } from "./setup/preferences-stub.mjs";

const DB_KEY = "unlimitade-db";

function fileData(overrides = {}) {
  return {
    originalName: "notes.txt",
    mimeType: "text/plain",
    size: 42,
    telegramFileId: "file-id",
    telegramMessageId: 1,
    isImage: false,
    isVideo: false,
    ...overrides,
  };
}

const names = (items) => items.map((item) => item.originalName ?? item.name).sort();

before(() => {
  // initDatabase() fetches the sql.js wasm; serve it from node_modules instead of the network.
  globalThis.fetch = async (url) => new Response(await readFile(fileURLToPath(String(url))));
});

beforeEach(async () => {
  store.clear();
  await db.initDatabase();
});

test("createFile stores a row that getFiles and getFileById return", async () => {
  const folder = await db.createFolder("Docs");
  const rootFile = await db.createFile(fileData({ size: 1234 }));
  const inFolder = await db.createFile(fileData({ originalName: "cv.pdf", folderId: folder.id }));

  assert.deepEqual(names(db.getFiles(null)), ["notes.txt"]);
  assert.deepEqual(names(db.getFiles(folder.id)), ["cv.pdf"]);

  const loaded = db.getFileById(rootFile.id);
  assert.equal(loaded.size, "1234");
  assert.equal(loaded.isFavorite, false);
  assert.equal(loaded.folderId, null);
  assert.equal(loaded.chunks, null);
  assert.equal(db.getFileById(inFolder.id).folderId, folder.id);
  assert.equal(db.getFileById("missing"), null);
});

test("search terms with SQL metacharacters are matched as text, not executed", async () => {
  await db.createFile(fileData({ originalName: "report.pdf" }));
  await db.createFile(fileData({ originalName: "it's a ' OR '1'='1 file.txt" }));

  assert.deepEqual(names(db.searchFiles({ q: "' OR '1'='1" })), ["it's a ' OR '1'='1 file.txt"]);
  assert.deepEqual(db.searchFiles({ q: "x'; DROP TABLE files; --" }), []);
  assert.deepEqual(names(db.searchFiles({ q: "report", dateFrom: "2000-01-01' OR 1=1 --" })), ["report.pdf"]);
  assert.equal(db.getFiles(null).length, 2, "files table must be intact");
});

test("hostile file and folder names are stored verbatim", async () => {
  const evil = `"); DROP TABLE folders; --`;
  const folder = await db.createFolder(evil);
  const file = await db.createFile(fileData({ originalName: evil, folderId: folder.id }));
  await db.updateFolder(folder.id, `${evil}2`);
  await db.updateFile(file.id, { originalName: `${evil}3` });

  assert.equal(db.getFolderById(folder.id).name, `${evil}2`);
  assert.equal(db.getFileById(file.id).originalName, `${evil}3`);
  assert.equal(db.getFolders(null).length, 1);
});

test("searchFiles filters by name, type and date", async () => {
  await db.createFile(fileData({ originalName: "beach.jpg", mimeType: "image/jpeg", isImage: true }));
  await db.createFile(fileData({ originalName: "beach.mp4", mimeType: "video/mp4", isVideo: true }));
  await db.createFile(fileData({ originalName: "song.mp3", mimeType: "audio/mpeg" }));
  await db.createFile(fileData({ originalName: "beach-guide.pdf", mimeType: "application/pdf" }));

  assert.deepEqual(names(db.searchFiles({ q: "beach" })), ["beach-guide.pdf", "beach.jpg", "beach.mp4"]);
  assert.deepEqual(names(db.searchFiles({ q: "beach", type: "images" })), ["beach.jpg"]);
  assert.deepEqual(names(db.searchFiles({ q: "beach", type: "videos" })), ["beach.mp4"]);
  assert.deepEqual(names(db.searchFiles({ type: "audio" })), ["song.mp3"]);
  assert.deepEqual(names(db.searchFiles({ type: "pdfs" })), ["beach-guide.pdf"]);
  assert.equal(db.searchFiles({ dateFrom: "2000-01-01", dateTo: "2999-12-31" }).length, 4);
  assert.deepEqual(db.searchFiles({ dateTo: "2000-01-01" }), []);
});

test("updateFile changes favourite, name and folder; deleteFile returns the removed row", async () => {
  const folder = await db.createFolder("Archive");
  const file = await db.createFile(fileData());

  await db.updateFile(file.id, {});
  await db.updateFile(file.id, { isFavorite: true, originalName: "renamed.txt", folderId: folder.id });

  const updated = db.getFileById(file.id);
  assert.equal(updated.isFavorite, true);
  assert.equal(updated.originalName, "renamed.txt");
  assert.equal(updated.folderId, folder.id);
  assert.deepEqual(names(db.getFavorites()), ["renamed.txt"]);

  assert.equal((await db.deleteFile(file.id)).originalName, "renamed.txt");
  assert.equal(await db.deleteFile(file.id), null);
  assert.deepEqual(db.getFavorites(), []);
});

test("folders report their path and counts; deleting one moves its content to the root", async () => {
  const parent = await db.createFolder("Parent");
  const child = await db.createFolder("Child", parent.id);
  const grandchild = await db.createFolder("Grandchild", child.id);
  await db.createFile(fileData({ originalName: "inside.txt", folderId: child.id }));

  assert.deepEqual(db.getFolderPath(grandchild.id).map((f) => f.name), ["Parent", "Child", "Grandchild"]);
  assert.deepEqual(db.getFolderById(child.id)._count, { files: 1, children: 1 });
  assert.deepEqual(names(db.getFolders(parent.id)), ["Child"]);

  await db.deleteFolder(child.id);

  assert.equal(db.getFolderById(child.id), null);
  assert.deepEqual(names(db.getFolders(null)), ["Grandchild", "Parent"]);
  assert.deepEqual(names(db.getFiles(null)), ["inside.txt"]);
});

test("getPhotos lists images and videos, newest capture date first", async () => {
  await db.createFile(fileData({ originalName: "old.jpg", isImage: true, dateTaken: "2020-01-01T00:00:00.000Z" }));
  await db.createFile(fileData({ originalName: "clip.mp4", isVideo: true, dateTaken: "2024-06-01T00:00:00.000Z" }));
  await db.createFile(fileData({ originalName: "doc.txt" }));

  const photos = db.getPhotos();
  assert.deepEqual(photos.map((p) => p.originalName), ["clip.mp4", "old.jpg"]);
});

test("the database is restored from storage; undecodable data starts an empty database", async () => {
  const chunks = [
    { telegramFileId: "part-0", telegramMessageId: 10 },
    { telegramFileId: "part-1", telegramMessageId: 11 },
  ];
  const file = await db.createFile(fileData({ originalName: "big.bin", chunks }));

  await db.initDatabase();
  assert.deepEqual(db.getFileById(file.id).chunks, chunks);

  store.set(DB_KEY, "%%% not base64 %%%");
  await db.initDatabase();
  assert.deepEqual(db.getFiles(null), []);
});

test("a database larger than 150 KB is still saved and restored", async () => {
  // Regression: the export used to be spread into String.fromCharCode(), which throws a
  // RangeError once it has more than ~100 000 bytes - from then on nothing was persisted.
  const longName = "x".repeat(200_000);
  const file = await db.createFile(fileData({ originalName: longName }));

  const stored = store.get(DB_KEY);
  assert.ok(stored.length > 200_000);
  assert.ok(atob(stored).startsWith("SQLite format 3"));

  await db.initDatabase();
  assert.equal(db.getFileById(file.id).originalName, longName);
});
