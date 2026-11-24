import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, CONTINUE_TEXT, MAX_AUTO } from "../server/lib/outbox.mjs";
import { Notifier } from "../server/lib/notifier.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ID = "sess-1";

/** A manager with one fake session whose state the test drives; `sent` records what reached it. */
function setup({ dir = mkdtempSync(join(tmpdir(), "wh-outbox-")), failTimes = 0, retryMs = [20, 20, 20] } = {}) {
  const manager = new EventEmitter();
  const live = { id: ID, cwd: "C:/work", state: "idle", pending: new Map() };
  live.summary = () => ({ id: ID, cwd: live.cwd, state: live.state, outbox: manager.outboxView?.(ID) || null });
  manager.get = (id) => (id === ID ? live : undefined);
  const sent = [];
  let failures = failTimes;
  const setState = (state) => {
    live.state = state;
    manager.emit("session.state", live.summary());
  };
  const outbox = new Outbox({
    dir,
    manager,
    profile: () => "work",
    settleMs: 5,
    graceMs: 5,
    retryMs,
    send: async (id, entry) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("boom");
      }
      sent.push({ id, ...entry });
      setState("running");
    },
  });
  manager.outboxView = (id) => outbox.view(id);
  outbox.start({ startDelayMs: 0 });
  const cleanup = () => { outbox.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { manager, live, outbox, sent, setState, dir, cleanup };
}

test("outbox: a message queued while Claude works is sent when the turn ends, one per turn", async () => {
  const { outbox, sent, setState, cleanup } = setup();
  setState("running");
  outbox.add(ID, { text: "first" });
  outbox.add(ID, { text: "second" });
  await wait(30);
  assert.equal(sent.length, 0, "nothing goes while the session runs");
  setState("idle");
  await wait(30);
  assert.deepEqual(sent.map((entry) => entry.text), ["first"]);
  assert.equal(sent[0].source, "outbox");
  setState("idle");
  await wait(30);
  assert.deepEqual(sent.map((entry) => entry.text), ["first", "second"]);
  assert.equal(outbox.view(ID), null, "an empty queue leaves nothing behind");
  cleanup();
});

test("outbox: waits while Claude asks for an answer", async () => {
  const { outbox, live, sent, setState, cleanup } = setup();
  live.pending.set("r1", {});
  outbox.add(ID, { text: "later" });
  await wait(30);
  assert.equal(sent.length, 0);
  live.pending.clear();
  setState("idle");
  await wait(30);
  assert.equal(sent.length, 1);
  cleanup();
});

test("outbox: a usage limit holds the queue; at the reset the cut-off turn is continued first, then the queue", async () => {
  const { manager, outbox, sent, setState, cleanup } = setup();
  setState("running");
  outbox.add(ID, { text: "queued" });
  manager.emit("session.limit", { id: ID, info: { status: "rejected", resetsAt: Date.now() + 80, rateLimitType: "five_hour" } });
  setState("idle"); // the turn ended on the limit
  await wait(40);
  assert.equal(sent.length, 0, "nothing is sent into the limit");
  assert.equal(outbox.held(ID), true);
  await wait(80);
  assert.deepEqual(sent.map((entry) => [entry.text, entry.source]), [[CONTINUE_TEXT, "auto-continue"]]);
  setState("idle"); // the continued turn finished
  await wait(30);
  assert.deepEqual(sent.map((entry) => entry.text), [CONTINUE_TEXT, "queued"]);
  cleanup();
});

test("outbox: with automatic continue off the reset leaves a notice and the queue goes on", async () => {
  const { manager, outbox, sent, setState, cleanup } = setup();
  outbox.setAuto(ID, false);
  manager.emit("session.limit", { id: ID, info: { status: "rejected", resetsAt: Date.now() + 40 } });
  outbox.add(ID, { text: "queued" });
  await wait(20);
  assert.equal(sent.length, 0);
  await wait(60);
  assert.deepEqual(sent.map((entry) => entry.text), ["queued"]);
  assert.equal(outbox.view(ID).hold.reset, true, "the 'has reset' notice stays");
  assert.equal(outbox.held(ID), false, "but it holds nothing back");
  setState("idle");
  outbox.continueNow(ID);
  await wait(30);
  assert.equal(sent.at(-1).text, CONTINUE_TEXT);
  cleanup();
});

test("outbox: a message the user sends on their own ends the wait; an 'allowed' event lifts the hold", async () => {
  const { manager, outbox, cleanup } = setup();
  manager.emit("session.limit", { id: ID, info: { status: "rejected", resetsAt: Date.now() + 60_000, rateLimitType: "five_hour" } });
  outbox.add(ID, { text: "x" });
  assert.equal(outbox.held(ID), true);
  manager.emit("session.limit", { id: ID, info: { status: "allowed", rateLimitType: "seven_day" } });
  assert.equal(outbox.held(ID), true, "another window's 'allowed' does not lift it");
  manager.emit("session.limit", { id: ID, info: { status: "allowed", rateLimitType: "five_hour" } });
  assert.equal(outbox.held(ID), false);
  manager.emit("session.limit", { id: ID, info: { status: "rejected", resetsAt: Date.now() + 60_000 } });
  manager.emit("session.sent", { id: ID, source: "outbox" });
  assert.equal(outbox.held(ID), true, "the outbox's own send does not count");
  manager.emit("session.sent", { id: ID, source: "user" });
  assert.equal(outbox.held(ID), false);
  cleanup();
});

test("outbox: a limit without a reset time holds the queue for a while, without a continue", async () => {
  const { manager, outbox, cleanup } = setup();
  manager.emit("session.limit", { id: ID, info: { status: "rejected", soft: true } });
  const view = outbox.view(ID);
  assert.equal(view.hold.soft, true);
  assert.ok(view.hold.resetsAt > Date.now() + 60_000);
  // A real reset time arriving first is never replaced by the guess.
  const real = Date.now() + 10 * 60_000;
  manager.emit("session.limit", { id: ID, info: { status: "rejected", resetsAt: real } });
  manager.emit("session.limit", { id: ID, info: { status: "rejected", soft: true } });
  assert.equal(outbox.view(ID).hold.resetsAt, real);
  cleanup();
});

test("outbox: automatic continue stops after repeated limit hits in a row", async () => {
  const { manager, outbox, sent, setState, cleanup } = setup();
  for (let round = 0; round <= MAX_AUTO; round += 1) {
    manager.emit("session.limit", { id: ID, info: { status: "rejected", resetsAt: Date.now() + 20 + round } });
    setState("idle");
    await wait(60);
  }
  assert.equal(sent.filter((entry) => entry.source === "auto-continue").length, MAX_AUTO);
  assert.equal(outbox.view(ID).auto, false);
  assert.equal(outbox.view(ID).hold.reset, true);
  cleanup();
});

test("outbox: the queue survives a restart and is sent afterwards", async () => {
  const first = setup();
  first.setState("running");
  first.outbox.add(first.manager.get(ID).id, { text: "keep me", images: [{ mediaType: "image/png", name: "a.png", data: "AAAA" }], cwd: "C:/work" });
  first.outbox.stop();
  assert.deepEqual(readdirSync(first.dir), [`${ID}.json`]);
  const second = setup({ dir: first.dir }); // a fresh server on the same folder; its session is idle
  await wait(40);
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].text, "keep me");
  assert.equal(second.sent[0].images[0].name, "a.png");
  assert.equal(second.sent[0].cwd, "C:/work");
  second.cleanup();
});

test("outbox: a failed send keeps the message, retries, then pauses until asked", async () => {
  const { outbox, sent, cleanup } = setup({ failTimes: 10, retryMs: [10, 10] });
  outbox.add(ID, { text: "stubborn" });
  await wait(80);
  const view = outbox.view(ID);
  assert.equal(sent.length, 0);
  assert.equal(view.items.length, 1, "the message is still there");
  assert.equal(view.paused, true);
  assert.equal(view.error.attempts, 3);
  cleanup();
});

test("outbox: a queue of another profile waits for that profile", async () => {
  const { outbox, sent, cleanup } = setup();
  outbox.add(ID, { text: "for later" });
  outbox.box(ID).profile = "personal";
  outbox.box(ID).items.push({ id: "x", text: "more", images: [], at: 1 });
  await outbox.drain(ID);
  assert.ok(sent.length <= 1);
  const before = sent.length;
  await outbox.drain(ID);
  assert.equal(sent.length, before, "nothing more under the wrong profile");
  cleanup();
});

test("notifier: a turn whose subagents still work is not announced as finished until they are done", () => {
  const manager = new EventEmitter();
  manager.get = () => null;
  const notifier = new Notifier({ manager, prefs: () => ({}), titleOf: () => "s" });
  const pushed = [];
  notifier.on("notification", (item) => pushed.push(item.kind));
  manager.emit("session.state", { id: "a", state: "running" });
  manager.emit("session.state", { id: "a", state: "idle", agentTasks: 2 });
  assert.deepEqual(pushed, []);
  manager.emit("session.state", { id: "a", state: "idle", agentTasks: 0 });
  assert.deepEqual(pushed, ["done"]);
  // The next queued message is about to go: not finished yet.
  manager.emit("session.state", { id: "a", state: "running" });
  manager.emit("session.state", { id: "a", state: "idle", outbox: { items: [{ id: "q" }], hold: null } });
  assert.deepEqual(pushed, ["done"]);
});

test("outbox: state changes after a failed send do not hurry the next try", async () => {
  const { outbox, setState, cleanup } = setup({ failTimes: 10, retryMs: [200, 200, 200] });
  outbox.add(ID, { text: "x" });
  await wait(20);
  for (let i = 0; i < 5; i += 1) { setState("closed"); setState("idle"); await wait(10); }
  await wait(30);
  assert.equal(outbox.view(ID).error.attempts, 1, "still waiting for the first retry");
  cleanup();
});

test("outbox: a limit of the account holds the queues of its other sessions too", async () => {
  const { manager, outbox, sent, cleanup } = setup();
  const other = "sess-2";
  outbox.add(other, { text: "other queue" }); // sent at once: nothing holds it yet
  await wait(20);
  assert.equal(sent.length, 1);
  manager.emit("session.limit", { id: ID, info: { status: "rejected", resetsAt: Date.now() + 80, rateLimitType: "five_hour" } });
  outbox.add(other, { text: "waits for the reset" });
  await wait(30);
  assert.equal(sent.length, 1, "nothing goes into the account's limit");
  assert.equal(outbox.view(other).hold.account, true);
  assert.equal(outbox.held(other), true);
  await wait(90);
  assert.ok(sent.some((entry) => entry.id === other && entry.text === "waits for the reset"), "sent after the reset");
  cleanup();
});

test("outbox: Stop pauses what waits; Resume or a new message goes on", async () => {
  const { manager, outbox, sent, setState, cleanup } = setup();
  setState("running");
  outbox.add(ID, { text: "after the turn" });
  manager.emit("session.interrupted", { id: ID });
  setState("idle");
  await wait(30);
  assert.equal(sent.length, 0);
  assert.equal(outbox.view(ID).stopped, true);
  outbox.add(ID, { text: "new one" }); // sending something new means go on, in order
  await wait(30);
  assert.deepEqual(sent.map((entry) => entry.text), ["after the turn"]);
  setState("idle");
  await wait(30);
  assert.deepEqual(sent.map((entry) => entry.text), ["after the turn", "new one"]);
  cleanup();
});

test("outbox: a message caught mid-send by a restart comes back paused, never sent again by itself", async () => {
  const first = setup();
  let release;
  first.outbox.sendFn = () => new Promise((resolve) => { release = resolve; }); // the send hangs (process starting)
  first.outbox.add(ID, { text: "in flight" });
  await wait(20);
  assert.ok(first.outbox.box(ID).inflight);
  first.outbox.stop(); // the server goes away here
  const second = setup({ dir: first.dir });
  await wait(30);
  assert.equal(second.sent.length, 0, "not sent again on its own");
  const view = second.outbox.view(ID);
  assert.equal(view.items[0].text, "in flight");
  assert.equal(view.paused, true);
  release();
  second.cleanup();
});

test("outbox: the restart's own continue message replaces the automatic one", async () => {
  const { manager, outbox, cleanup } = setup();
  outbox.box(ID, true).continueDue = true;
  manager.emit("session.sent", { id: ID, source: "resume" });
  assert.equal(outbox.box(ID)?.continueDue ?? false, false);
  cleanup();
});
