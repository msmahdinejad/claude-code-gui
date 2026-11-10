import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeUpdater, compareVersions, installOf } from "../server/lib/claude-updater.mjs";

const BIN = join("prefix", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

test("versions compare numerically", () => {
  assert.equal(compareVersions("2.1.9", "2.1.10"), -1);
  assert.equal(compareVersions("2.1.322", "2.1.322"), 0);
  assert.equal(compareVersions("2.2.0", "2.1.999"), 1);
});

test("an npm install is recognised and its prefix found", () => {
  assert.deepEqual(installOf(BIN), { kind: "npm", prefix: "prefix" });
  assert.deepEqual(installOf(join("home", ".local", "bin", "claude.exe")), { kind: "native" });
  assert.equal(installOf(""), null);
  if (process.platform !== "win32") assert.deepEqual(installOf(join("usr", "local", "lib", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")), { kind: "npm", prefix: join("usr", "local") });
});

function session(extra = {}) {
  return { alive: true, state: "idle", lastActive: 0, pending: new Set(), closed: 0, close() { this.closed += 1; this.alive = false; }, ...extra };
}

async function setup({ installed = "2.1.309", latest = "2.1.322", installWorks = true, sessions = [session()], enabled = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "wh-upd-"));
  const calls = [];
  let version = installed;
  const gates = [];
  const manager = { sessions: new Map(sessions.map((s, i) => [String(i), s])), hold: (promise) => gates.push(promise) };
  const catalog = { inflight: new Map(), invalidated: 0, invalidate() { this.invalidated += 1; } };
  const run = async (file, args) => {
    calls.push([file === BIN ? "claude" : "npm", ...args].join(" "));
    if (file === BIN) return version ? { code: 0, stdout: `${version} (Claude Code)`, stderr: "" } : { code: 1, stdout: "", stderr: "broken" };
    if (args[0] === "view") return { code: 0, stdout: `${latest}\n`, stderr: "" };
    if (args.includes("-g")) {
      const wanted = args.find((arg) => arg.startsWith("@anthropic-ai/claude-code@")).split("@").at(-1);
      if (wanted === latest && !installWorks) { version = null; return { code: 1, stdout: "", stderr: "EBUSY" }; }
      version = wanted;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" }; // the staging install
  };
  const updater = new ClaudeUpdater({ config: { claudeBin: BIN, dataDir }, manager, catalog, enabled: () => enabled, run, sleep: async () => { updater.onSleep?.(); } });
  return { updater, calls, manager, catalog, gates, dir: dataDir, done: () => rm(dataDir, { recursive: true, force: true }) };
}

test("downloads first, then installs when idle, stops idle sessions and verifies the version", async () => {
  const ctx = await setup();
  const updated = [];
  ctx.updater.on("updated", (event) => updated.push(event));
  await ctx.updater.tick();
  const stage = ctx.calls.findIndex((call) => call.includes("install --prefix"));
  const swap = ctx.calls.findIndex((call) => call.includes("install -g"));
  assert.ok(stage >= 0 && swap > stage, ctx.calls.join("\n"));
  assert.match(ctx.calls[swap], /--prefer-offline/);
  assert.equal(ctx.manager.sessions.get("0").closed, 1);
  assert.equal(ctx.updater.status().installed, "2.1.322");
  assert.deepEqual(updated, [{ from: "2.1.309", to: "2.1.322" }]);
  assert.equal(ctx.catalog.invalidated, 1);
  assert.equal(ctx.gates.length, 1);
  await ctx.done();
});

test("waits while a session is working and installs once it stops", async () => {
  const busy = session({ state: "running" });
  const ctx = await setup({ sessions: [busy] });
  let sleeps = 0;
  ctx.updater.onSleep = () => { sleeps += 1; if (sleeps === 3) busy.state = "idle"; };
  await ctx.updater.tick();
  assert.ok(sleeps >= 3);
  assert.equal(ctx.updater.status().installed, "2.1.322");
  // the download happened while it was busy, the swap only afterwards
  assert.ok(ctx.calls.some((call) => call.includes("install -g")));
  await ctx.done();
});

test("a session waiting for an answer or active a moment ago is not idle", async () => {
  const ctx = await setup({ sessions: [session({ pending: new Set(["x"]) })] });
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session({ lastActive: Date.now() }));
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session());
  assert.equal(ctx.updater.idle(), true);
  ctx.catalog.inflight.set("cwd", Promise.resolve());
  assert.equal(ctx.updater.idle(), false);
  await ctx.done();
});

test("a new install that does not run is rolled back to the old version", async () => {
  const ctx = await setup({ installWorks: false });
  await ctx.updater.tick();
  const state = ctx.updater.status();
  assert.equal(state.installed, "2.1.309");
  assert.match(state.error, /kept 2\.1\.309/);
  assert.equal(state.failedVersion, "2.1.322");
  assert.ok(ctx.calls.filter((call) => call.includes("install -g")).length === 2, "installed the new one, then put the old one back");
  assert.match(ctx.calls.filter((call) => call.includes("install -g")).at(-1), /claude-code@2\.1\.309/);
  // a failed version is not retried straight away
  const before = ctx.calls.length;
  await ctx.updater.tick();
  assert.ok(!ctx.calls.slice(before).some((call) => call.includes("install")));
  await ctx.done();
});

test("nothing happens when switched off, unless the user asks for it", async () => {
  const ctx = await setup({ enabled: false });
  await ctx.updater.tick();
  assert.equal(ctx.calls.length, 0);
  await ctx.updater.tick({ force: true });
  assert.equal(ctx.updater.status().installed, "2.1.322");
  await ctx.done();
});

test("no update when already on the newest version", async () => {
  const ctx = await setup({ installed: "2.1.322" });
  await ctx.updater.tick();
  assert.ok(!ctx.calls.some((call) => call.includes("install")));
  assert.equal(ctx.manager.sessions.get("0").closed, 0);
  await ctx.done();
});
