import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Notifier } from "../server/lib/notifier.mjs";

function setup(prefs = {}) {
  const manager = new EventEmitter();
  const sessions = new Map();
  manager.get = (id) => sessions.get(id);
  const notifier = new Notifier({ manager, prefs: () => prefs, titleOf: (id) => `title ${id}` });
  const state = (id, next, extra = {}) => manager.emit("session.state", { id, state: next, ...extra });
  return { manager, notifier, sessions, state, prefs };
}

test("a finished turn is announced with the last thing Claude said", () => {
  const { notifier, sessions, state } = setup();
  sessions.set("a", { buffer: [
    { msg: { type: "wh_user_message" } },
    { msg: { type: "assistant", message: { content: [{ type: "text", text: "All  done.\nTests pass." }] } } },
  ] });
  state("a", "idle");
  state("a", "running");
  state("a", "idle");
  const { items } = notifier.after(0);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].kind, items[0].title, items[0].body], ["done", "title a", "All done. Tests pass."]);
});

test("a failed turn says so; going idle without running does not notify", () => {
  const { notifier, state } = setup();
  state("a", "idle");
  assert.equal(notifier.after(0).items.length, 0);
  state("a", "running");
  state("a", "idle", { lastResult: { is_error: true } });
  assert.equal(notifier.after(0).items[0].kind, "failed");
});

test("approvals, questions and plans get their own text", () => {
  const { manager, notifier } = setup();
  const ask = (request) => manager.emit("session.attention", { sessionId: "a", request });
  ask({ kind: "permission", toolName: "Bash", input: { command: "npm test" } });
  ask({ kind: "permission", toolName: "AskUserQuestion", input: { questions: [{ question: "Which database?" }] } });
  ask({ kind: "permission", toolName: "ExitPlanMode", input: {} });
  ask({ kind: "elicitation", message: "Pick a server" });
  const items = notifier.after(0).items;
  assert.deepEqual(items.map((item) => item.kind), ["approval", "question", "plan", "question"]);
  assert.equal(items[0].body, "Bash: npm test");
  assert.equal(items[1].body, "Which database?");
  assert.equal(items[3].body, "Pick a server");
  ask({ kind: "permission", toolName: "Write", input: { file_path: "C:\\work\\src\\app.js" } });
  assert.equal(notifier.after(0).items.at(-1).body, "Write: app.js"); // the file name, not the whole path
});

test("nothing is announced for the conversation the user is looking at, or when notifications are off", () => {
  const { manager, notifier, prefs } = setup();
  const ask = (id) => manager.emit("session.attention", { sessionId: id, request: { kind: "permission", toolName: "Bash", input: {} } });
  notifier.setPresence({ focused: true, sessionId: "a" });
  ask("a");
  assert.equal(notifier.after(0).items.length, 0);
  ask("b"); // another conversation
  assert.equal(notifier.after(0).items.length, 1);
  notifier.setPresence({ focused: false, sessionId: "a" });
  ask("a");
  assert.equal(notifier.after(0).items.length, 2);
  prefs.notifications = false;
  ask("c");
  assert.equal(notifier.after(0).items.length, 2);
});

test("a new poller starts at the cursor; the test notification ignores presence and the switch", () => {
  const { notifier, prefs } = setup();
  prefs.notifications = false;
  notifier.test();
  assert.deepEqual(notifier.after(NaN), { cursor: 1, items: [] });
  assert.equal(notifier.after(0).items[0].kind, "test");
  assert.equal(notifier.after(1).items.length, 0);
});

test("the Persian language is used once the page reports it", () => {
  const { notifier } = setup();
  notifier.setPresence({ focused: false, lang: "fa" });
  notifier.test();
  assert.match(notifier.after(0).items[0].body, /اعلان/);
});
