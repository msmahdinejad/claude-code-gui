import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../server/lib/session-manager.mjs";

/** A stand-in for the SDK's query(): initializes after `initMs`, streams nothing, ends when closed. */
function fakeQueries({ initMs = 60 } = {}) {
  const made = [];
  const create = () => {
    let end;
    let rejectInit;
    const ended = new Promise((resolve) => { end = resolve; });
    const init = new Promise((resolve, reject) => {
      rejectInit = reject;
      setTimeout(() => resolve({ models: [] }), initMs);
    });
    init.catch(() => {});
    const q = {
      closed: false,
      initializationResult: () => init,
      close() {
        q.closed = true;
        rejectInit(new Error("Query closed before initialize"));
        end();
      },
      [Symbol.asyncIterator]() {
        return { next: () => ended.then(() => ({ done: true, value: undefined })) };
      },
    };
    made.push(q);
    return q;
  };
  return { create, made };
}

const managerWith = (queries) => {
  const manager = new SessionManager({ claudeBin: undefined, chrome: false }, { query: queries.create });
  clearInterval(manager.reaper);
  return manager;
};

test("a restart while the first start is still initializing keeps the new process", async () => {
  const queries = fakeQueries();
  const manager = managerWith(queries);
  const session = manager.create({ cwd: process.cwd() });
  const errors = [];
  session.on("event", (entry) => { if (entry.msg.type === "wh_error") errors.push(entry.msg); });
  const first = session.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = session.restart({ model: "x" });
  await Promise.all([first, second]); // neither fails
  assert.equal(queries.made.length, 2);
  assert.equal(queries.made[0].closed, true);
  assert.equal(queries.made[1].closed, false, "the new process was not closed by the old start()");
  assert.equal(session.query, queries.made[1]);
  assert.equal(session.state, "idle");
  assert.equal(session.startError, null);
  assert.deepEqual(errors, []);
  session.close();
});

test("closing a session while it starts fails that start without touching anything else", async () => {
  const queries = fakeQueries();
  const manager = managerWith(queries);
  const session = manager.create({ cwd: process.cwd() });
  const start = session.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  session.close();
  await assert.rejects(start, /closed while it was starting/);
  assert.equal(session.state, "closed");
});

test("close() resolves once the process stream has ended; dropping sessions tells their streams", async () => {
  const queries = fakeQueries({ initMs: 1 });
  const manager = managerWith(queries);
  const session = manager.create({ cwd: process.cwd() });
  await session.start();
  let detached = 0;
  session.on("detached", () => { detached += 1; });
  manager.closeSessions();
  assert.equal(detached, 1);
  assert.equal(manager.sessions.size, 0);
  assert.equal(queries.made[0].closed, true);

  const other = manager.create({ cwd: process.cwd() });
  await other.start();
  other.on("detached", () => { detached += 1; });
  await manager.remove(other.id);
  assert.equal(detached, 2);
  assert.equal(manager.get(other.id), undefined);
});
