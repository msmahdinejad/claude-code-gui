// Settings → Diagnostics: read-only facts about the Claude Code install Wheelhouse runs, plus a few
// allow-listed CLI checks. Nothing here changes settings; the client never sends arguments, only a check id.
import { readFile, stat } from "node:fs/promises";
import { arch, homedir, release, type } from "node:os";
import { join, resolve } from "node:path";

// The only commands this module runs (fixed argument arrays; no user text reaches the CLI).
const CHECKS = {
  version: { args: ["--version"], timeout: 30_000 },
  doctor: { args: ["doctor"], timeout: 90_000 }, // prints read-only diagnostics without starting a session
  auth: { args: ["auth", "status"], timeout: 30_000 },
  mcp: { args: ["mcp", "list"], timeout: 120_000, cwd: true }, // health-checks the servers configured for the folder
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export default function register({ route, config, runClaudeCli, HttpError }) {
  const running = new Map(); // check id -> promise (a second click joins the run in flight)

  let wheelhouseVersion = "";
  readFile(new URL("../../../package.json", import.meta.url), "utf8").then((text) => { wheelhouseVersion = JSON.parse(text).version || ""; }).catch(() => {});

  route("GET", "/api/diagnostics/info", async () => {
    const profile = config.profiles?.[config.activeProfile] || {};
    const executable = config.claudeExecutable || {};
    return {
      wheelhouse: wheelhouseVersion,
      profile: { name: config.activeProfile || "", label: profile.label || config.activeProfile || "", command: profile.command || "claude" },
      executable: { path: config.claudeBin || "", source: executable.source || "", problem: executable.problem || "" },
      configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      configDirFromProfile: Boolean(profile.configDir),
      configFile: config.file || "",
      node: process.version,
      os: `${type()} ${release()} (${process.platform}-${arch()})`,
      defaultCwd: config.defaultCwd || "",
      checks: Object.keys(CHECKS),
    };
  });

  route("POST", "/api/diagnostics/run", async ({ body }) => {
    const id = String(body?.check || "");
    const check = Object.hasOwn(CHECKS, id) ? CHECKS[id] : null;
    if (!check) throw new HttpError(400, "unknown check");
    let cwd = config.defaultCwd;
    if (check.cwd && typeof body.cwd === "string" && body.cwd) {
      const full = resolve(body.cwd);
      const info = await stat(full).catch(() => null);
      if (!info?.isDirectory()) throw new HttpError(400, "not a directory");
      cwd = full;
    }
    const key = `${id}\0${check.cwd ? cwd : ""}`;
    if (!running.has(key)) {
      const started = Date.now();
      running.set(key, runClaudeCli(check.args, { cwd, timeout: check.timeout }).then((result) => ({
        check: id,
        command: `claude ${check.args.join(" ")}`,
        cwd: check.cwd ? cwd : undefined,
        ok: result.ok,
        code: result.code,
        stdout: result.stdout.replace(ANSI, ""),
        stderr: result.stderr.replace(ANSI, ""),
        ms: Date.now() - started,
      })).finally(() => running.delete(key)));
    }
    return running.get(key);
  });
}
