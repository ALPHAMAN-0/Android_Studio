import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as telegram from "../src/lib/services/telegram.ts";

const TOKEN = "test-bot-token";
const CHANNEL = "-1000000000001";
const API = `https://api.telegram.org/bot${TOKEN}`;

const realFetch = globalThis.fetch;
let calls;

// Replace fetch with a scripted one: each call consumes the next reply.
function scriptFetch(...replies) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// Minimal XMLHttpRequest double for the upload functions (Node has no XHR).
class FakeXHR {
  static last = null;
  listeners = {};
  upload = { addEventListener: (type, cb) => (this.listeners[`upload:${type}`] = cb) };
  constructor() {
    FakeXHR.last = this;
  }
  addEventListener(type, cb) {
    this.listeners[type] = cb;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  send(body) {
    this.body = body;
  }
  respond(text) {
    this.responseText = text;
    this.listeners.load();
  }
}

beforeEach(() => {
  globalThis.XMLHttpRequest = FakeXHR;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.XMLHttpRequest;
});

test("testConnection reports the bot name, an invalid token, or a network failure", async () => {
  scriptFetch(json({ ok: true, result: { first_name: "StorageBot" } }));
  assert.deepEqual(await telegram.testConnection(TOKEN), { ok: true, botName: "StorageBot" });
  assert.equal(calls[0].url, `${API}/getMe`);

  scriptFetch(json({ ok: false, description: "Unauthorized" }, 401));
  assert.deepEqual(await telegram.testConnection(TOKEN), { ok: false, error: "Invalid bot token" });

  scriptFetch(new TypeError("fetch failed"));
  const offline = await telegram.testConnection(TOKEN);
  assert.equal(offline.ok, false);
  assert.match(offline.error, /Network error/);
});

test("getFileUrl resolves the download URL and fails when Telegram returns no path", async () => {
  scriptFetch(json({ ok: true, result: { file_path: "documents/file_7.pdf" } }));
  assert.equal(
    await telegram.getFileUrl("FILE_ID", TOKEN),
    `https://api.telegram.org/file/bot${TOKEN}/documents/file_7.pdf`
  );
  assert.equal(calls[0].url, `${API}/getFile?file_id=FILE_ID`);

  scriptFetch(json({ ok: false }));
  await assert.rejects(telegram.getFileUrl("FILE_ID", TOKEN), /Could not get file path/);

  scriptFetch(json({ ok: true, result: {} }));
  await assert.rejects(telegram.getFileUrl("FILE_ID", TOKEN), /Could not get file path/);
});

test("downloadFile returns the content and rejects an HTTP error", async () => {
  scriptFetch(json({ ok: true, result: { file_path: "a.bin" } }), new Response("payload"));
  assert.equal(await (await telegram.downloadFile("FILE_ID", TOKEN)).text(), "payload");

  scriptFetch(json({ ok: true, result: { file_path: "a.bin" } }), new Response("gone", { status: 404 }));
  await assert.rejects(telegram.downloadFile("FILE_ID", TOKEN), /Download failed: 404/);
});

test("downloadChunkedFile joins the parts in order and names the part that failed", async () => {
  const path = (name) => json({ ok: true, result: { file_path: name } });
  const parts = [{ telegramFileId: "p0" }, { telegramFileId: "p1" }];
  const progress = [];

  scriptFetch(path("p0"), new Response("Hello, "), path("p1"), new Response("world"));
  const blob = await telegram.downloadChunkedFile(parts, TOKEN, (p) => progress.push(p));
  assert.equal(await blob.text(), "Hello, world");
  assert.deepEqual(progress, [50, 100]);

  scriptFetch(path("p0"), new Response("Hello, "), path("p1"), new Response("", { status: 500 }));
  await assert.rejects(telegram.downloadChunkedFile(parts, TOKEN), /chunk 2 of 2/);
});

test("uploadThumbnail returns the largest photo size, or null when the upload fails", async () => {
  const photo = [{ file_id: "small" }, { file_id: "large" }];
  scriptFetch(json({ ok: true, result: { photo, message_id: 9 } }));
  assert.deepEqual(await telegram.uploadThumbnail(new Blob(["x"]), "a.jpg", TOKEN, CHANNEL), {
    fileId: "large",
    messageId: 9,
  });
  assert.equal(calls[0].url, `${API}/sendPhoto`);
  assert.equal(calls[0].init.body.get("chat_id"), CHANNEL);
  assert.equal(calls[0].init.body.get("caption"), "thumbnail:a.jpg");

  scriptFetch(json({ ok: false }));
  assert.equal(await telegram.uploadThumbnail(new Blob(["x"]), "a.jpg", TOKEN, CHANNEL), null);

  scriptFetch(new TypeError("fetch failed"));
  assert.equal(await telegram.uploadThumbnail(new Blob(["x"]), "a.jpg", TOKEN, CHANNEL), null);
});

test("deleteMessage posts the channel and message id as JSON", async () => {
  scriptFetch(json({ ok: true }));
  await telegram.deleteMessage(77, TOKEN, CHANNEL);

  assert.equal(calls[0].url, `${API}/deleteMessage`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: CHANNEL, message_id: 77 });
});

test("uploadFile sends the document and resolves with Telegram's ids", async () => {
  const progress = [];
  const file = new File(["hello"], "hello.txt", { type: "text/plain" });
  const pending = telegram.uploadFile(file, TOKEN, CHANNEL, (p) => progress.push(p));
  const xhr = FakeXHR.last;

  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, `${API}/sendDocument`);
  assert.equal(xhr.body.get("chat_id"), CHANNEL);
  assert.equal(xhr.body.get("caption"), "hello.txt");
  assert.equal(xhr.body.get("document").name, "hello.txt");

  xhr.listeners["upload:progress"]({ lengthComputable: true, loaded: 1, total: 4 });
  xhr.listeners["upload:progress"]({ lengthComputable: false, loaded: 2, total: 0 });
  xhr.respond(JSON.stringify({ ok: true, result: { document: { file_id: "DOC" }, message_id: 5 } }));

  assert.deepEqual(await pending, { telegramFileId: "DOC", telegramMessageId: 5 });
  assert.deepEqual(progress, [25]);
});

test("uploadFile rejects on an API error, a reply without a document, bad JSON and network errors", async () => {
  const file = new File(["hello"], "hello.txt");
  const attempt = (finish) => {
    const pending = telegram.uploadFile(file, TOKEN, CHANNEL);
    finish(FakeXHR.last);
    return pending;
  };

  await assert.rejects(attempt((xhr) => xhr.respond(JSON.stringify({ ok: false }))), /Upload failed/);
  await assert.rejects(attempt((xhr) => xhr.respond(JSON.stringify({ ok: true, result: {} }))), /Upload failed/);
  await assert.rejects(attempt((xhr) => xhr.respond("<html>502</html>")), /Upload failed/);
  await assert.rejects(attempt((xhr) => xhr.listeners.error()), /Network error during upload/);
  await assert.rejects(attempt((xhr) => xhr.listeners.abort()), /Upload cancelled/);
});

test("uploadChunk labels each part so the file can be reassembled", async () => {
  const pending = telegram.uploadChunk(new Blob(["part"]), "video.mp4", 1, 3, TOKEN, CHANNEL);
  const xhr = FakeXHR.last;

  assert.equal(xhr.url, `${API}/sendDocument`);
  assert.equal(xhr.body.get("caption"), "__chunk__:video.mp4:1:3");
  assert.equal(xhr.body.get("document").name, "video.mp4.part1");

  xhr.respond(JSON.stringify({ ok: false }));
  await assert.rejects(pending, /Upload failed \(part 2\)/);
});
