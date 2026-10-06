import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { useUploadStore } from "../src/stores/upload-store.ts";

const state = () => useUploadStore.getState();
const fakeFile = (name, size) => ({ name, size });

beforeEach(() => useUploadStore.setState({ uploads: [] }));

test("addUpload queues a file under a unique id", () => {
  const first = state().addUpload(fakeFile("a.txt", 10));
  const second = state().addUpload(fakeFile("a.txt", 10));

  assert.notEqual(first, second);
  assert.deepEqual(state().uploads[0], {
    id: first,
    filename: "a.txt",
    size: 10,
    progress: 0,
    status: "queued",
  });
});

test("updateUpload changes only the targeted upload", () => {
  const first = state().addUpload(fakeFile("a.txt", 10));
  const second = state().addUpload(fakeFile("b.txt", 20));

  state().updateUpload(second, { status: "error", error: "Upload failed" });
  state().updateUpload("unknown-id", { status: "done" });

  const [a, b] = state().uploads;
  assert.equal(a.id, first);
  assert.equal(a.status, "queued");
  assert.equal(b.status, "error");
  assert.equal(b.error, "Upload failed");
  assert.equal(b.filename, "b.txt");
});

test("removeUpload and clearCompleted drop the right entries", () => {
  const done = state().addUpload(fakeFile("done.txt", 1));
  const failed = state().addUpload(fakeFile("failed.txt", 1));
  const running = state().addUpload(fakeFile("running.txt", 1));
  state().updateUpload(done, { status: "done", progress: 100 });
  state().updateUpload(failed, { status: "error" });
  state().updateUpload(running, { status: "uploading", progress: 40 });

  state().clearCompleted();
  assert.deepEqual(state().uploads.map((u) => u.filename), ["failed.txt", "running.txt"]);

  state().removeUpload(failed);
  assert.deepEqual(state().uploads.map((u) => u.filename), ["running.txt"]);
});
