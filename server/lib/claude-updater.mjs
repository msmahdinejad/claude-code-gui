// Keeps the Claude Code executable of the active profile up to date.
//
// Claude Code lists only the models it knew about when it was built, so a new model (and new features) show up in
// Wheelhouse only after the CLI is updated. A profile that sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also turns off
// the CLI's own auto-updater, so Wheelhouse does it, in two steps:
//
//   1. As soon as a newer version is published it is installed into Wheelhouse's own folder (<dataDir>/claude-code/<v>)
//      and, once `--version` confirms it runs, used for every new Claude process and for the model list. Nothing that is
//      running is touched: sessions that are working keep their process (and the old version) until it restarts.
//   2. The profile's own installation (what the terminal uses) is updated too, but only in a quiet moment: no session
//      working, waiting for an answer or running background work. Idle processes are stopped for a few seconds (they
//      start again on the next message), the package is swapped from npm's cache, verified, and put back if it does not
//      run. After that the profile's own executable is used again.
//
// Only an npm-style install (…/node_modules/@anthropic-ai/claude-code) is updated this way; a native install is updated
// with `claude update`.
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";

const PACKAGE = "@anthropic-ai/claude-code";
const VERSION = /^\d+\.\d+\.\d+$/;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const IDLE_MS = 2 * 60 * 1000; // no session activity for this long counts as idle
const IDLE_POLL_MS = 30 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const STAGE_TIMEOUT_MS = 60 * 60 * 1000; // slow proxies: the package is ~300 MB
const SWAP_TIMEOUT_MS = 10 * 60 * 1000;

/** -1 / 0 / 1 for dotted numeric versions. */
export function compareVersions(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const newer = (a, b) => Boolean(a && (!b || compareVersions(a, b) > 0));

/** How the executable at `binPath` was installed: { kind: "npm", prefix } (global npm package), { kind: "native" } or null. */
export function installOf(binPath, platform = process.platform) {
  if (!binPath) return null;
  const marker = `${sep}node_modules${sep}@anthropic-ai${sep}claude-code${sep}`;
  const haystack = platform === "win32" ? binPath.toLowerCase() : binPath;
  const at = haystack.indexOf(marker);
  if (at > 0) {
    let prefix = binPath.slice(0, at);
    if (platform !== "win32" && prefix.endsWith(`${sep}lib`)) prefix = prefix.slice(0, -4); // Unix: <prefix>/lib/node_modules
    return { kind: "npm", prefix };
  }
  return { kind: "native" };
}

/** The executable inside an install made with `npm install --prefix <dir>`. */
export const binIn = (dir) => join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

const quote = (path) => (process.platform === "win32" ? `"${path}"` : path); // npm.cmd runs through a shell on Windows

const defaultRun = (file, args, { timeoutMs = 120_000, env = process.env, shell = false } = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env, shell, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || error?.message || "") });
    });
  });

export class ClaudeUpdater extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.config     Wheelhouse config (claudeBin is what new processes run; dataDir)
   * @param {object} deps.manager    SessionManager (sessions, hold())
   * @param {object} deps.catalog    Catalog (invalidate(), inflight)
   * @param {() => string|null} deps.profileBin  the active profile's own executable (what the terminal runs)
   * @param {() => boolean} deps.enabled
   * @param {() => string} [deps.channel]  npm dist-tag to follow: "latest" (default) or "stable"
   * @param {Function} [deps.run]    (file, args, options) => { code, stdout, stderr }; injected by tests
   * @param {Function} [deps.sleep]
   * @param {Function} [deps.exists]
   */
  constructor({ config, manager, catalog, profileBin, enabled = () => true, channel = () => "latest", run = defaultRun, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()), exists = existsSync }) {
    super();
    Object.assign(this, { config, manager, catalog, profileBin, isEnabled: enabled, channel, run, sleep, exists });
    this.state = { installed: null, active: null, latest: null, phase: "idle", checkedAt: 0, updatedAt: 0, updatedFrom: null, updatedTo: null, error: null, failedVersion: null, failedAt: 0 };
    this.job = null;
    this.timers = [];
  }

  get root() {
    return join(this.config.dataDir, "claude-code");
  }

  start() {
    const first = setTimeout(() => this.tick().catch(() => {}), FIRST_CHECK_MS);
    const every = setInterval(() => this.tick().catch(() => {}), CHECK_EVERY_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop() {
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
  }

  status() {
    const own = this.profileBin();
    const install = installOf(own);
    const current = [this.state.active, this.state.installed].filter(Boolean).sort(compareVersions).at(-1);
    return {
      enabled: Boolean(this.isEnabled()),
      supported: Boolean(own),
      install: install?.kind || null,
      channel: this.channel(),
      ...this.state,
      busy: Boolean(this.job),
      usingOwnCopy: Boolean(this.config.claudeBin && own && this.config.claudeBin !== own),
      updateAvailable: newer(this.state.latest, current),
    };
  }

  async version(bin) {
    if (!bin) return null;
    const result = await this.run(bin, ["--version"], { timeoutMs: 30_000, env: process.env });
    return result.code === 0 ? /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] || null : null;
  }

  async readLatest() {
    const tag = /^[a-z]+$/.test(this.channel()) ? this.channel() : "latest";
    const result = await this.npm(["view", `${PACKAGE}@${tag}`, "version"], { timeoutMs: 60_000 });
    const version = result.stdout.trim().split(/\s+/).at(-1);
    return result.code === 0 && VERSION.test(version || "") ? version : null;
  }

  npm(args, { timeoutMs } = {}) {
    const windows = process.platform === "win32";
    // On Windows npm is npm.cmd, which needs a shell; every argument here is a fixed word, a validated version or a quoted path.
    return this.run(windows ? "npm.cmd" : "npm", args, { timeoutMs, env: process.env, shell: windows });
  }

  /** Versions of the profile's install, of what new processes run, and of the newest release. Never throws. */
  async check() {
    const own = this.profileBin();
    if (!own) { this.state.error = "No Claude Code executable"; return this.status(); }
    const [installed, active, latest] = await Promise.all([this.version(own), this.config.claudeBin && this.config.claudeBin !== own ? this.version(this.config.claudeBin) : null, this.readLatest()]);
    this.state.checkedAt = Date.now();
    if (installed) this.state.installed = installed;
    this.state.active = active || installed || this.state.active;
    if (latest) this.state.latest = latest;
    this.state.error = !installed ? "Could not run claude --version" : !latest ? "Could not reach the npm registry" : null;
    return this.status();
  }

  /** Start using our own copy of `version` (already installed and verified) for new processes and the model list. */
  activate(version, bin, from) {
    if (this.config.claudeBin === bin) return;
    this.config.claudeBin = bin;
    this.config.claudeExecutable = { path: bin, source: "update" };
    Object.assign(this.state, { active: version, updatedAt: Date.now(), updatedFrom: from, updatedTo: version });
    this.catalog?.invalidate();
    this.emit("updated", { from, to: version });
  }

  /** At start: use the newest copy that is already installed (and newer than the profile's), without asking the network. */
  async useInstalled() {
    const own = this.profileBin();
    const installed = await this.version(own);
    if (installed) this.state.installed = installed;
    const names = await readdir(this.root).catch(() => []); // none yet
    const best = names.filter((name) => VERSION.test(name)).sort(compareVersions).reverse();
    for (const version of best) {
      if (!newer(version, installed)) break;
      const bin = binIn(join(this.root, version));
      if (this.exists(bin) && (await this.version(bin)) === version) {
        this.activate(version, bin, installed);
        return version;
      }
    }
    this.state.active = installed;
    return null;
  }

  /** Check, install our own copy, then (when quiet) the profile's install. One run at a time; `force` runs with the switch off. */
  tick({ force = false } = {}) {
    if (this.job) return this.job;
    if (!force && !this.isEnabled()) return Promise.resolve(this.status());
    this.job = this.update({ force })
      .catch((error) => { this.state.error = error.message; })
      .finally(() => { this.job = null; this.state.phase = "idle"; });
    return this.job;
  }

  async update({ force }) {
    this.state.phase = "checking";
    await this.check();
    const { installed, latest } = this.state;
    if (!installed || !latest) return this.status();
    if (!force && this.state.failedVersion === latest && Date.now() - this.state.failedAt < RETRY_AFTER_FAILURE_MS) return this.status();

    // Step 1: our own copy, used at once.
    if (newer(latest, this.state.active)) {
      this.state.phase = "downloading";
      const bin = await this.installCopy(latest);
      this.activate(latest, bin, this.state.active);
    }

    // Step 2: the profile's install, in a quiet moment.
    const own = this.profileBin();
    const install = installOf(own);
    if (!newer(latest, installed) || install?.kind !== "npm") return this.status();
    if (!/^[^"%&|<>^\r\n]+$/.test(install.prefix)) return this.status();
    this.state.phase = "waiting";
    while (!this.idle()) {
      if (!force && !this.isEnabled()) return this.status();
      await this.sleep(IDLE_POLL_MS);
    }
    this.state.phase = "installing";
    await this.swap(install, own, installed, latest);
    return this.status();
  }

  /** Install `version` into <dataDir>/claude-code/<version> (also fills npm's cache) and check that it runs. */
  async installCopy(version) {
    const dir = join(this.root, version);
    const bin = binIn(dir);
    if (this.exists(bin) && (await this.version(bin)) === version) return bin;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const result = await this.npm(["install", "--prefix", quote(dir), `${PACKAGE}@${version}`, "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"], { timeoutMs: STAGE_TIMEOUT_MS });
    if (result.code !== 0 || (await this.version(bin)) !== version) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      Object.assign(this.state, { failedVersion: version, failedAt: Date.now() });
      throw new Error(`Could not install ${version}: ${result.stderr.trim().split("\n").at(-1) || "it does not run"}`);
    }
    return bin;
  }

  /** True when nothing is working, waiting for an answer, running background work or was active a moment ago. */
  idle(now = Date.now()) {
    if (this.catalog?.inflight?.size) return false;
    for (const session of this.manager.sessions.values()) {
      if (!session.alive) continue;
      if (["running", "starting"].includes(session.state) || session.pending?.size || session.backgroundTasks) return false;
      if (now - (session.lastActive || 0) < IDLE_MS) return false;
    }
    return true;
  }

  async swap(install, own, from, to) {
    let release;
    this.manager.hold?.(new Promise((resolve) => { release = resolve; })); // sessions and catalog loads wait while the files change
    try {
      // Only processes that run the profile's executable hold its files; ours (the copy) can keep running.
      for (const session of this.manager.sessions.values()) if (session.alive && (!session.bin || session.bin === own)) session.close();
      await this.sleep(1500); // let the processes exit so the files are free
      const ok = await this.install(install, own, to);
      const now = await this.version(own);
      if (ok && now === to) {
        this.state.installed = to;
        // The profile's own executable is current again: use it, and drop the copies that are no longer needed.
        if (this.config.claudeBin !== own) {
          this.config.claudeBin = own;
          this.config.claudeExecutable = { path: own, source: "path" };
          this.catalog?.invalidate();
        }
        this.state.active = to;
        await this.prune();
        return;
      }
      Object.assign(this.state, { failedVersion: to, failedAt: Date.now(), error: `Could not update the installed Claude Code to ${to}; kept ${from}` });
      if (now !== from) await this.install(install, own, from); // put the old version back
    } finally {
      release?.();
    }
  }

  async install(install, own, version) {
    if (install?.kind === "npm") {
      const result = await this.npm(["install", "-g", "--prefix", quote(install.prefix), `${PACKAGE}@${version}`, "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"], { timeoutMs: SWAP_TIMEOUT_MS });
      return result.code === 0;
    }
    const result = await this.run(own, ["update"], { timeoutMs: SWAP_TIMEOUT_MS, env: process.env });
    return result.code === 0;
  }

  /** Remove our copies that are not in use. */
  async prune() {
    const names = await readdir(this.root).catch(() => []);
    for (const name of names) {
      const bin = binIn(join(this.root, name));
      const used = [...this.manager.sessions.values()].some((session) => session.alive && session.bin === bin);
      if (!used && this.config.claudeBin !== bin) await rm(join(this.root, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}
