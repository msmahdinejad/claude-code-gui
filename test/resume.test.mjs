import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_WINDOW_MS, InterruptedSessions, MAX_AT_ONCE, OFFER_WINDOW_MS, PROMPT } from "../server/lib/resume.mjs";

const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "wh-resume-")); dirs.push(dir); return dir; };
test.after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup({ enabled = false, skip, exists = () => true } = {}) {
  const dir = temp();
  const manager = new EventEmitter();
  const sent = [];
  const clock = { t: 1_000_000_000_000 };
  const sessions = new Map();
  const tracker = new InterruptedSessions({
    dir, manager, enabled: () => enabled, skip, exists, now: () => clock.t, sleep: async () => {}, spacingMs: 0,
    open: (id, cwd) => {
      if (!sessions.has(id)) sessions.set(id, { id, cwd, state: "closed", sendUser: async ({ text }) => { sent.push({ id, text }); } });
      return sessions.get(id);
    },
  });
  const emit = (id, state, extra = {}) => manager.emit("session.state", { id, cwd: `C:\\work\\${id}`, state, meta: {}, ...extra });
  return { dir, manager, tracker, sent, clock, sessions, emit, read: (name) => JSON.parse(readFileSync(join(dir, name), "utf8")) };
}

test("working sessions are listed while they work and removed when the turn ends", () => {
  const { tracker, emit, read } = setup();
  tracker.start({ autoDelayMs: -1 });
  emit("a", "running");
  emit("b", "running");
  assert.deepEqual(read("running.json").sessions.map((s) => s.id), ["a", "b"]);
  emit("a", "idle");
  assert.deepEqual(read("running.json").sessions.map((s) => s.id), ["b"]);
  emit("b", "closed"); // closed on purpose while the server stays up
  assert.deepEqual(read("running.json").sessions, []);
  tracker.freeze();
});

test("what was working at shutdown becomes pending at the next start, even though the shutdown closes the sessions", () => {
  const first = setup();
  first.tracker.start({ autoDelayMs: -1 });
  first.emit("a", "running");
  first.emit("b", "running");
  first.emit("b", "idle");
  first.tracker.freeze(); // the server is about to close everything
  first.emit("a", "closed"); // ignored: the shutdown did it
  assert.deepEqual(first.read("running.json").sessions.map((s) => s.id), ["a"]);

  const second = setup();
  writeFileSync(join(second.dir, "running.json"), readFileSync(join(first.dir, "running.json")));
  const pending = second.tracker.start({ autoDelayMs: -1 });
  assert.deepEqual(pending.map((entry) => entry.id), ["a"]);
  assert.deepEqual(second.read("running.json").sessions, [], "a fresh list for the new run");
  assert.deepEqual(second.read("pending.json").sessions.map((s) => s.id), ["a"], "kept until continued or dismissed");
});

test("a profile switch is a deliberate stop: nothing is left to continue", () => {
  const { tracker, emit, read } = setup();
  tracker.start({ autoDelayMs: -1 });
  emit("a", "running");
  tracker.clear();
  assert.deepEqual(read("running.json").sessions, []);
});

test("scheduled runs are never tracked", () => {
  const { tracker, emit, read } = setup({ skip: (id, meta) => Boolean(meta.scheduledTaskId) });
  tracker.start({ autoDelayMs: -1 });
  emit("a", "running", { meta: { scheduledTaskId: "t1" } });
  emit("b", "running");
  assert.deepEqual(read("running.json").sessions.map((s) => s.id), ["b"]);
});

function interrupted(ids, { at } = {}) {
  const ctx = setup({ enabled: true });
  writeFileSync(join(ctx.dir, "running.json"), JSON.stringify({ updatedAt: at ?? ctx.clock.t - 60_000, sessions: ids.map((id) => ({ id, cwd: `C:\\work\\${id}`, since: ctx.clock.t - 120_000 })) }));
  return ctx;
}

test("automatic continue is off unless the switch is on, and the page can still offer them", async () => {
  const ctx = setup({ enabled: false });
  writeFileSync(join(ctx.dir, "running.json"), JSON.stringify({ updatedAt: ctx.clock.t - 1000, sessions: [{ id: "a", cwd: "C:\\work\\a" }] }));
  ctx.tracker.start({ autoDelayMs: -1 });
  assert.equal(await ctx.tracker.autoResume(), null);
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.tracker.status().pending.length, 1);
});

test("automatic continue sends one message per session, at most three, and only recently interrupted ones", async () => {
  const ctx = interrupted(["a", "b", "c", "d", "e"]);
  ctx.tracker.start({ autoDelayMs: -1 });
  const outcome = await ctx.tracker.autoResume();
  assert.equal(outcome.ok.length, MAX_AT_ONCE);
  assert.equal(ctx.sent.length, MAX_AT_ONCE);
  assert.ok(ctx.sent.every((entry) => entry.text === PROMPT));
  assert.equal(new Set(ctx.sent.map((entry) => entry.id)).size, MAX_AT_ONCE, "each session once");
  assert.equal(ctx.tracker.status().pending.length, 2, "the rest stay on offer");
  await ctx.tracker.resume(null, { auto: true }); // the next automatic round continues the rest, never the same ones
  assert.equal(ctx.sent.length, 5);
  assert.equal(new Set(ctx.sent.map((entry) => entry.id)).size, 5);
});

test("a session interrupted long ago is offered but not continued by itself", async () => {
  const ctx = interrupted(["a"], { at: 1_000_000_000_000 - AUTO_WINDOW_MS - 60_000 });
  ctx.tracker.start({ autoDelayMs: -1 });
  assert.equal(ctx.tracker.status().pending.length, 1);
  await ctx.tracker.autoResume();
  assert.equal(ctx.sent.length, 0);
  await ctx.tracker.resume(["a"]); // the person asked
  assert.equal(ctx.sent.length, 1);
});

test("entries older than the offer window are dropped", () => {
  const ctx = interrupted(["a"], { at: 1_000_000_000_000 - OFFER_WINDOW_MS - 1000 });
  assert.deepEqual(ctx.tracker.start({ autoDelayMs: -1 }), []);
});

test("a missing folder or an already working session is reported, not sent", async () => {
  const ctx = setup({ enabled: true, exists: (cwd) => !cwd.endsWith("gone") });
  writeFileSync(join(ctx.dir, "running.json"), JSON.stringify({ updatedAt: ctx.clock.t - 1000, sessions: [{ id: "gone", cwd: "C:\\work\\gone" }, { id: "busy", cwd: "C:\\work\\busy" }, { id: "ok", cwd: "C:\\work\\ok" }] }));
  ctx.tracker.start({ autoDelayMs: -1 });
  ctx.open = null;
  ctx.sessions.set("busy", { id: "busy", cwd: "C:\\work\\busy", state: "running", sendUser: async () => assert.fail("must not send to a working session") });
  const outcome = await ctx.tracker.resume();
  assert.deepEqual(outcome.ok, ["ok"]);
  assert.deepEqual(outcome.failed.map((entry) => entry.id).sort(), ["busy", "gone"]);
  assert.equal(ctx.tracker.status().pending.length, 0, "taken off the list either way: no second attempt");
});

test("dismiss clears the offer, all or some", () => {
  const ctx = interrupted(["a", "b"]);
  ctx.tracker.start({ autoDelayMs: -1 });
  assert.equal(ctx.tracker.dismiss(["a"]).pending.length, 1);
  assert.equal(ctx.tracker.dismiss().pending.length, 0);
  assert.deepEqual(ctx.read("pending.json").sessions, []);
});

test("damaged state files are ignored", () => {
  const ctx = setup();
  writeFileSync(join(ctx.dir, "running.json"), "{ not json");
  writeFileSync(join(ctx.dir, "pending.json"), JSON.stringify({ sessions: [null, { id: 5 }, { id: "x" }] }));
  assert.deepEqual(ctx.tracker.start({ autoDelayMs: -1 }), []);
});
