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

/** A query that initializes at once and streams the given messages, then stays open until closed. */
function scriptedQuery(messages) {
  return () => {
    let end;
    const ended = new Promise((resolve) => { end = resolve; });
    const queue = [...messages];
    return {
      initializationResult: async () => ({ models: [] }),
      close() { end(); },
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (queue.length) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { done: false, value: queue.shift() };
            }
            await ended;
            return { done: true, value: undefined };
          },
        };
      },
    };
  };
}

test("background work after the turn is counted (subagents and shells, not ambient watchers); limits and sends are announced", async () => {
  const tasks = [
    { task_id: "a", task_type: "local_agent", description: "research" },
    { task_id: "b", task_type: "local_bash", description: "dev server" },
    { task_id: "c", task_type: "local_agent", description: "watcher", ambient: true },
  ];
  const manager = new SessionManager({ claudeBin: undefined, chrome: false }, {
    query: scriptedQuery([
      { type: "system", subtype: "background_tasks_changed", tasks },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1800000000, rateLimitType: "five_hour" } },
      { type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: { content: [] } },
      { type: "system", subtype: "background_tasks_changed", tasks: [tasks[1]] },
    ]),
  });
  clearInterval(manager.reaper);
  const states = [];
  const limits = [];
  const sent = [];
  manager.on("session.state", (summary) => states.push(summary.agentTasks));
  manager.on("session.limit", (event) => limits.push(event.info));
  manager.on("session.sent", (event) => sent.push(event.source));
  const session = manager.create({ cwd: process.cwd() });
  await session.sendUser({ text: "hi", source: "outbox" });
  // Wait until the scripted messages are through (a fixed 80 ms was too short on a loaded machine), at most 3 s.
  for (let i = 0; i < 60 && !(limits.length >= 2 && session.agentTasks === 1); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(states.includes(2), "the subagent and the shell counted, the ambient watcher not");
  assert.equal(session.agentTasks, 1, "the shell still runs after the subagent finished");
  assert.equal(session.backgroundTasks, 1, "the shell is still a background task");
  assert.equal(limits[0].status, "rejected");
  assert.equal(limits[1].soft, true);
  assert.deepEqual(sent, ["outbox"]);
  assert.equal(session.summary().agentTasks, 1);
  session.close();
});
