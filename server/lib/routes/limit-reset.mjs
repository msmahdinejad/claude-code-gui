// Limit resets ("Reset for free"): opens Claude Code's own `/limit-reset` in a terminal window, signed in as the profile.
//
// The resets of an account are only offered to Claude Code itself (claude.ai answers other clients with
// `ineligible_reason: "surface"`), and the command is an interactive terminal screen that the SDK cannot run, so
// Wheelhouse starts the real CLI in a new console window and lets it list, choose and use them.
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";
import { hasProfile, profileEnv, resolveCommand } from "../config.mjs";
import { trackClaude } from "../claude-processes.mjs";

const KINDS = ["fable", "full", "5-hour", "weekly"];
const MIN_VERSION = "2.1.322"; // first Claude Code with /limit-reset
const KEEP_MS = 30 * 60_000; // the window can outlive this server: keep its Claude Code files that long

const older = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

const versionOf = (bin, env) =>
  new Promise((resolve) => {
    execFile(bin, ["--version"], { env, timeout: 30_000, windowsHide: true }, (error, stdout) => resolve(error ? null : /\d+\.\d+\.\d+/.exec(String(stdout))?.[0] || null));
  });

export default function register({ route, config, manager, HttpError }) {
  route("POST", "/api/limit-reset/open", async ({ body }) => {
    const kind = body?.kind ? String(body.kind) : "";
    if (kind && !KINDS.includes(kind)) throw new HttpError(400, `Unknown reset: ${kind}`);
    const name = body?.profile || config.activeProfile;
    if (!hasProfile(config, name)) throw new HttpError(400, `Unknown profile: ${name}`);
    const env = profileEnv(config, name);
    await manager.ready(); // not while an update replaces the files
    // The requested profile's own executable (for the active one: what new sessions run, possibly an updated copy).
    const bin = name === config.activeProfile ? config.claudeBin : resolveCommand(config.profiles[name].command, env).path;
    if (!bin) throw new HttpError(409, "Claude Code was not found for this profile.");
    // That switch also turns off the feature checks the command depends on; the window only talks to claude.ai.
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    const version = await versionOf(bin, env);
    if (!version) throw new HttpError(500, "Could not run Claude Code.");
    if (older(version, MIN_VERSION)) throw new HttpError(409, `Limit resets need Claude Code ${MIN_VERSION} or newer (this is ${version}). Update it in Settings → Updates.`);
    const command = kind ? `/limit-reset ${kind}` : "/limit-reset";
    if (process.platform !== "win32") throw new HttpError(501, `Run \`${command}\` in Claude Code in a terminal.`);
    // detached: on Windows the child gets its own (visible) console window and outlives this request.
    const child = spawn(bin, [command], { cwd: homedir(), env, detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    trackClaude(bin, child, { keepMs: KEEP_MS });
    child.unref();
    return { ok: true, version, command, profile: name };
  });
}
