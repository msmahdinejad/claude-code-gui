import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeUpdater, binIn, compareVersions, installOf } from "../server/lib/claude-updater.mjs";

const OWN = join("prefix", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

test("versions compare numerically", () => {
  assert.equal(compareVersions("2.1.9", "2.1.10"), -1);
  assert.equal(compareVersions("2.1.322", "2.1.322"), 0);
  assert.equal(compareVersions("2.2.0", "2.1.999"), 1);
});

test("an npm install is recognised and its prefix found", () => {
  assert.deepEqual(installOf(OWN), { kind: "npm", prefix: "prefix" });
  assert.deepEqual(installOf(join("home", ".local", "bin", "claude.exe")), { kind: "native" });
  assert.equal(installOf(""), null);
  if (process.platform !== "win32") assert.deepEqual(installOf(join("usr", "local", "lib", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")), { kind: "npm", prefix: join("usr", "local") });
});

function session(extra = {}) {
  return { alive: true, state: "idle", lastActive: 0, pending: new Set(), backgroundTasks: 0, bin: OWN, closed: 0, close() { this.closed += 1; this.alive = false; }, ...extra };
}

/** A fake npm/claude: versions per executable; `npm install --prefix <dir>` creates a working copy, `-g` changes OWN. */
async function setup({ installed = "2.1.309", latest = "2.1.322", copyWorks = true, swapWorks = true, sessions = [session()], enabled = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "wh-upd-"));
  const versions = new Map([[OWN, installed]]);
  const calls = [];
  const gates = [];
  const config = { claudeBin: OWN, dataDir };
  const manager = { sessions: new Map(sessions.map((s, i) => [String(i), s])), hold: (promise) => gates.push(promise) };
  const catalog = { inflight: new Map(), invalidated: 0, invalidate() { this.invalidated += 1; } };
  const run = async (file, args) => {
    if (versions.has(file) || file.endsWith("claude.exe")) {
      calls.push(`run ${file === OWN ? "own" : "copy"} ${args.join(" ")}`);
      const version = versions.get(file);
      return version ? { code: 0, stdout: `${version} (Claude Code)`, stderr: "" } : { code: 1, stdout: "", stderr: "broken" };
    }
    calls.push(`npm ${args.join(" ")}`);
    if (args[0] === "view") return { code: 0, stdout: `${latest}\n`, stderr: "" };
    const wanted = args.find((arg) => arg.startsWith("@anthropic-ai/claude-code@")).split("@").at(-1);
    if (args.includes("-g")) {
      if (wanted === latest && !swapWorks) { versions.set(OWN, null); return { code: 1, stdout: "", stderr: "EBUSY" }; }
      versions.set(OWN, wanted);
      return { code: 0, stdout: "", stderr: "" };
    }
    const dir = args[args.indexOf("--prefix") + 1].replace(/"/g, "");
    if (copyWorks) versions.set(binIn(dir), wanted);
    return { code: copyWorks ? 0 : 1, stdout: "", stderr: copyWorks ? "" : "ETIMEDOUT" };
  };
  const updater = new ClaudeUpdater({
    config, manager, catalog, profileBin: () => OWN, enabled: () => enabled, run,
    exists: (path) => Boolean(versions.get(path)),
    sleep: async () => { updater.onSleep?.(); },
  });
  return { updater, calls, config, manager, catalog, gates, versions, dataDir, done: () => rm(dataDir, { recursive: true, force: true }) };
}

test("a newer version is used at once for new processes, even while sessions work", async () => {
  const busy = session({ state: "running" });
  const ctx = await setup({ sessions: [busy] });
  const updated = [];
  ctx.updater.on("updated", (event) => updated.push(event));
  let sleeps = 0;
  ctx.updater.onSleep = () => {
    sleeps += 1;
    if (sleeps === 1) {
      // still busy: our copy is already what new processes run, the working session was not touched
      assert.equal(ctx.config.claudeBin, binIn(join(ctx.dataDir, "claude-code", "2.1.322")));
      assert.equal(busy.closed, 0);
      assert.deepEqual(updated, [{ from: "2.1.309", to: "2.1.322" }]);
      assert.equal(ctx.updater.status().phase, "waiting");
    }
    if (sleeps === 3) busy.state = "idle";
  };
  await ctx.updater.tick();
  assert.ok(sleeps >= 3);
  // then, once quiet, the profile's own install was updated and is used again
  assert.equal(busy.closed, 1);
  assert.equal(ctx.versions.get(OWN), "2.1.322");
  assert.equal(ctx.config.claudeBin, OWN);
  assert.match(ctx.calls.find((call) => call.includes("install -g")), /--prefer-offline/);
  assert.equal(ctx.gates.length, 1);
  assert.equal(ctx.updater.status().updateAvailable, false);
  await ctx.done();
});

test("processes that run our copy are not stopped for the swap", async () => {
  const ctx = await setup({ sessions: [] });
  ctx.updater.onSleep = () => {
    if (!ctx.manager.sessions.size) ctx.manager.sessions.set("copy", session({ bin: ctx.config.claudeBin, lastActive: 0 }));
  };
  // make the copy session appear right after activation
  ctx.updater.once("updated", () => ctx.manager.sessions.set("copy", session({ bin: ctx.config.claudeBin })));
  await ctx.updater.tick();
  assert.equal(ctx.manager.sessions.get("copy").closed, 0);
  await ctx.done();
});

test("a failed update of the installed Claude Code is rolled back and our copy stays in use", async () => {
  const ctx = await setup({ swapWorks: false });
  await ctx.updater.tick();
  const state = ctx.updater.status();
  assert.equal(ctx.versions.get(OWN), "2.1.309", "old version put back");
  assert.match(ctx.calls.filter((call) => call.includes("install -g")).at(-1), /claude-code@2\.1\.309/);
  assert.equal(ctx.config.claudeBin, binIn(join(ctx.dataDir, "claude-code", "2.1.322")));
  assert.equal(state.active, "2.1.322");
  assert.match(state.error, /kept 2\.1\.309/);
  await ctx.done();
});

test("a copy that does not install leaves everything as it was", async () => {
  const ctx = await setup({ copyWorks: false });
  await ctx.updater.tick();
  assert.equal(ctx.config.claudeBin, OWN);
  assert.match(ctx.updater.status().error, /Could not install 2\.1\.322/);
  assert.ok(!ctx.calls.some((call) => call.includes("install -g")));
  await ctx.done();
});

test("a copy installed earlier is used at start without the network", async () => {
  const ctx = await setup();
  const dir = join(ctx.dataDir, "claude-code", "2.1.322");
  await mkdir(dir, { recursive: true });
  ctx.versions.set(binIn(dir), "2.1.322");
  assert.equal(await ctx.updater.useInstalled(), "2.1.322");
  assert.equal(ctx.config.claudeBin, binIn(dir));
  assert.ok(!ctx.calls.some((call) => call.startsWith("npm")));
  await ctx.done();
});

test("busy means working, waiting for an answer, background work or activity a moment ago", async () => {
  const ctx = await setup({ sessions: [session({ pending: new Set(["x"]) })] });
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session({ backgroundTasks: 2 }));
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session({ lastActive: Date.now() }));
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session());
  assert.equal(ctx.updater.idle(), true);
  ctx.catalog.inflight.set("cwd", Promise.resolve());
  assert.equal(ctx.updater.idle(), false);
  await ctx.done();
});

test("nothing happens when switched off, unless the user asks for it", async () => {
  const ctx = await setup({ enabled: false });
  await ctx.updater.tick();
  assert.equal(ctx.calls.length, 0);
  await ctx.updater.tick({ force: true });
  assert.equal(ctx.versions.get(OWN), "2.1.322");
  await ctx.done();
});

test("no update when already on the newest version", async () => {
  const ctx = await setup({ installed: "2.1.322" });
  await ctx.updater.tick();
  assert.ok(!ctx.calls.some((call) => call.includes("install")));
  assert.equal(ctx.manager.sessions.get("0").closed, 0);
  await ctx.done();
});
