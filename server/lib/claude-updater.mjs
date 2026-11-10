// Keeps the Claude Code executable of the active profile up to date.
//
// Claude Code lists only the models it knew about when it was built, so a new model (and new features) show up in
// Wheelhouse only after the CLI is updated. A profile that sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also turns off
// the CLI's own auto-updater, so Wheelhouse does it:
//   1. check the npm registry now and then;
//   2. download the new version in the background (an install into a scratch folder fills npm's cache; nothing in use changes);
//   3. when no session is working or waiting, stop the idle Claude processes (they start again on the next message) and
//      swap the installed package from the cache, which takes a few seconds;
//   4. verify `claude --version`; if the new install does not run, put the old version back.
// Only an npm-style install (…/node_modules/@anthropic-ai/claude-code) is updated this way; a native install is updated
// with `claude update`.
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";

const PACKAGE = "@anthropic-ai/claude-code";
const VERSION = /^\d+\.\d+\.\d+$/;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 90 * 1000;
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
   * @param {object} deps.config   Wheelhouse config (claudeBin, dataDir)
   * @param {object} deps.manager  SessionManager (sessions, hold())
   * @param {object} deps.catalog  Catalog (invalidate(), inflight)
   * @param {() => boolean} deps.enabled
   * @param {() => string} [deps.channel]  npm dist-tag to follow: "latest" (default) or "stable"
   * @param {Function} [deps.run]  (file, args, options) => { code, stdout, stderr }; injected by tests
   * @param {Function} [deps.sleep]
   */
  constructor({ config, manager, catalog, enabled = () => true, channel = () => "latest", run = defaultRun, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()) }) {
    super();
    Object.assign(this, { config, manager, catalog, isEnabled: enabled, channel, run, sleep });
    this.state = { installed: null, latest: null, staged: null, phase: "idle", checkedAt: 0, updatedAt: 0, updatedFrom: null, updatedTo: null, error: null, failedVersion: null, failedAt: 0 };
    this.job = null;
    this.timers = [];
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

  get bin() {
    return this.config.claudeBin || null;
  }

  status() {
    const install = installOf(this.bin);
    return { enabled: Boolean(this.isEnabled()), supported: Boolean(this.bin), install: install?.kind || null, channel: this.channel(), ...this.state, busy: Boolean(this.job), updateAvailable: Boolean(this.state.installed && this.state.latest && compareVersions(this.state.installed, this.state.latest) < 0) };
  }

  /** Installed and newest published version. Never throws; problems end up in `state.error`. */
  async check() {
    if (!this.bin) { this.state.error = "No Claude Code executable"; return this.status(); }
    const [installed, latest] = await Promise.all([this.readInstalled(), this.readLatest()]);
    this.state.checkedAt = Date.now();
    if (installed) this.state.installed = installed;
    if (latest) this.state.latest = latest;
    this.state.error = !installed ? "Could not run claude --version" : !latest ? "Could not reach the npm registry" : null;
    return this.status();
  }

  async readInstalled() {
    const result = await this.run(this.bin, ["--version"], { timeoutMs: 30_000, env: process.env });
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

  /** True when nothing is working, waiting for an answer or was active a moment ago. */
  idle(now = Date.now()) {
    if (this.catalog?.inflight?.size) return false;
    for (const session of this.manager.sessions.values()) {
      if (!session.alive) continue;
      if (["running", "starting"].includes(session.state) || session.pending?.size) return false;
      if (now - (session.lastActive || 0) < IDLE_MS) return false;
    }
    return true;
  }

  /** Check, download, wait until idle, install. One run at a time; `force` also runs while the switch is off ("Update now"). */
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
    if (!installed || !latest || compareVersions(installed, latest) >= 0) return this.status();
    if (!force && this.state.failedVersion === latest && Date.now() - this.state.failedAt < RETRY_AFTER_FAILURE_MS) return this.status();
    const install = installOf(this.bin);
    if (install?.kind === "npm" && !/^[^"%&|<>^\r\n]+$/.test(install.prefix)) { this.state.error = "Unsupported install path"; return this.status(); }

    if (install?.kind === "npm" && this.state.staged !== latest) {
      this.state.phase = "downloading";
      await this.stage(latest);
    }
    // Wait for a quiet moment; stop waiting when the switch is turned off (unless the user asked for it).
    this.state.phase = "waiting";
    while (!this.idle()) {
      if (!force && !this.isEnabled()) return this.status();
      await this.sleep(IDLE_POLL_MS);
    }
    this.state.phase = "installing";
    await this.swap(install, installed, latest);
    return this.status();
  }

  /** Install into a scratch folder: nothing in use changes, but npm's cache now holds every tarball. */
  async stage(version) {
    const dir = join(this.config.dataDir, "updates", version);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      const result = await this.npm(["install", "--prefix", quote(dir), `${PACKAGE}@${version}`, "--no-audit", "--no-fund", "--loglevel=error"], { timeoutMs: STAGE_TIMEOUT_MS });
      if (result.code !== 0) throw new Error(`Download failed: ${result.stderr.trim().split("\n").at(-1) || result.code}`);
      this.state.staged = version;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async swap(install, from, to) {
    let release;
    this.manager.hold?.(new Promise((resolve) => { release = resolve; })); // sessions and catalog loads wait while the files change
    try {
      for (const session of this.manager.sessions.values()) if (session.alive) session.close(); // they start again on the next message
      await this.sleep(1500); // let the processes exit so the files are free
      const ok = await this.install(install, to);
      const now = await this.readInstalled();
      if (ok && now === to) {
        Object.assign(this.state, { installed: to, updatedAt: Date.now(), updatedFrom: from, updatedTo: to, error: null, failedVersion: null });
        this.catalog?.invalidate();
        this.emit("updated", { from, to });
        return;
      }
      // The new install is not usable: put the old version back.
      Object.assign(this.state, { failedVersion: to, failedAt: Date.now(), error: `Could not install ${to}; kept ${from}` });
      if (now !== from) await this.install(install, from);
      this.catalog?.invalidate();
    } finally {
      release?.();
    }
  }

  async install(install, version) {
    if (install?.kind === "npm") {
      const result = await this.npm(["install", "-g", "--prefix", quote(install.prefix), `${PACKAGE}@${version}`, "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"], { timeoutMs: SWAP_TIMEOUT_MS });
      return result.code === 0;
    }
    const result = await this.run(this.bin, ["update"], { timeoutMs: SWAP_TIMEOUT_MS, env: process.env });
    return result.code === 0;
  }
}
