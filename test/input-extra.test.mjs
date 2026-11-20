import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../server/lib/session-manager.mjs";

/** A started session whose input queue is replaced by a recorder, plus the events it emits. */
async function startedSession() {
  const create = () => ({
    initializationResult: () => Promise.resolve({ models: [] }),
    close() {},
    [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; },
  });
  const manager = new SessionManager({ claudeBin: undefined, chrome: false }, { query: create });
  clearInterval(manager.reaper);
  const session = manager.create({ cwd: process.cwd() });
  await session.start();
  const pushed = [];
  session.input = { push: (message) => pushed.push(message), close() {} };
  const events = [];
  session.on("event", (entry) => events.push(entry.msg));
  return { session, pushed, events };
}

const b64 = (text) => Buffer.from(text).toString("base64");

test("sendUser turns a PDF into a document block, text files into named text blocks, images stay images", async () => {
  const { session, pushed, events } = await startedSession();
  await session.sendUser({
    text: "summarize",
    images: [
      { mediaType: "image/png", name: "a.png", data: "AAAA" },
      { mediaType: "application/pdf", name: "spec.pdf", data: b64("%PDF-1.4") },
      { mediaType: "text/plain", name: "notes.py", data: b64("print('hi')") },
    ],
  });
  const content = pushed[0].message.content;
  assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  assert.deepEqual(content[1], { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: b64("%PDF-1.4") } });
  assert.deepEqual(content[2], { type: "text", text: "<file name=\"notes.py\">\nprint('hi')\n</file>" });
  assert.deepEqual(content[3], { type: "text", text: "summarize" });
  const shown = events.find((msg) => msg.type === "wh_user_message");
  assert.equal(shown.images.length, 1, "only pictures are drawn as thumbnails");
  assert.equal(shown.text, "summarize\n\n[spec.pdf]\n\n[notes.py]");
  session.close();
});

test("sendUser rejects oversized PDFs and text files, and a lone text file is still a block list", async () => {
  const { session, pushed } = await startedSession();
  await assert.rejects(session.sendUser({ images: [{ mediaType: "application/pdf", name: "big.pdf", data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }] }), /too large/);
  await assert.rejects(session.sendUser({ images: [{ mediaType: "text/plain", name: "big.txt", data: Buffer.alloc(500 * 1024 + 1, "a").toString("base64") }] }), /too large/);
  assert.equal(pushed.length, 0);
  await session.sendUser({ images: [{ mediaType: "text/plain", name: "a.txt", data: b64("x") }] });
  assert.ok(Array.isArray(pushed[0].message.content));
  session.close();
});
