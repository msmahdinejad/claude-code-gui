// Signs a connection profile in through the CLI's own `auth login`, so nobody has to open a terminal when the
// OAuth session expires. The CLI prints a sign-in link and then waits: either the browser reaches its local callback,
// or the code shown on the web page is typed into its prompt. We relay both; the CLI keeps all credential handling.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_OUTPUT = 4000;
const MAX_CODE = 4096;
const TIMEOUT_MS = 10 * 60_000;

export class LoginFlows extends EventEmitter {
  /**
   * @param resolve  (profileName) => { path, args?, env } the executable to run (args go before `auth login`),
   *                 or { problem } when the profile cannot be run
   */
  constructor({ resolve, timeoutMs = TIMEOUT_MS }) {
    super();
    this.resolve = resolve;
    this.timeoutMs = timeoutMs;
    this.flows = new Map();
    process.once("exit", () => this.closeAll());
  }

  /** Start signing `profile` in (a flow already running for it is replaced). */
  start(profile) {
    const target = this.resolve(profile);
    if (target.problem) throw new Error(target.problem);
    if (!target.path) throw new Error("This profile uses the Claude Code bundled with the SDK, which cannot sign in from here. Run `claude auth login` in a terminal.");
    for (const flow of this.flows.values()) if (flow.profile === profile && flow.active) this.cancel(flow.id);

    const flow = { id: randomUUID(), profile, state: "starting", url: null, output: "", error: null, active: true, child: null, timer: null };
    this.flows.set(flow.id, flow);
    // Keep the table small: only the newest few flows are worth remembering.
    for (const [id, old] of this.flows) if (!old.active && this.flows.size > 5) this.flows.delete(id);

    const child = spawn(target.path, [...(target.args || []), "auth", "login"], { env: target.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    flow.child = child;
    const onData = (chunk) => {
      flow.output = (flow.output + String(chunk).replace(ANSI, "")).slice(-MAX_OUTPUT);
      if (!flow.url) {
        const found = URL_PATTERN.exec(flow.output);
        if (found) {
          flow.url = found[0];
          if (flow.state === "starting") flow.state = "waiting";
        }
      }
      this.emit("change", flow);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {}); // the CLI may exit before it reads what we send
    child.on("error", (error) => this.finish(flow, "failed", error.message));
    child.on("close", (code) => this.finish(flow, code === 0 ? "done" : "failed", code === 0 ? null : lastLine(flow.output) || `The sign-in exited with code ${code}.`));
    flow.timer = setTimeout(() => {
      this.finish(flow, "failed", "Timed out waiting for the sign-in to finish.");
      child.kill();
    }, this.timeoutMs);
    flow.timer.unref?.();
    return this.view(flow);
  }

  finish(flow, state, error) {
    if (!flow.active) return;
    flow.active = false;
    clearTimeout(flow.timer);
    flow.state = flow.state === "cancelled" ? "cancelled" : state;
    flow.error = flow.state === "failed" ? error : null;
    this.emit("change", flow);
    this.emit(flow.state, flow);
  }

  get(id) {
    const flow = this.flows.get(id);
    return flow ? this.view(flow) : null;
  }

  /** Type the code shown on the sign-in page into the CLI's prompt. */
  submitCode(id, code) {
    const flow = this.flows.get(id);
    if (!flow?.active) throw new Error("This sign-in is no longer running.");
    const clean = String(code ?? "").trim();
    if (!clean || clean.length > MAX_CODE || /[\r\n]/.test(clean)) throw new Error("That does not look like a sign-in code.");
    flow.child.stdin.write(`${clean}\n`);
    return this.view(flow);
  }

  cancel(id) {
    const flow = this.flows.get(id);
    if (!flow) return null;
    if (flow.active) {
      flow.state = "cancelled";
      this.finish(flow, "cancelled");
      flow.child.kill();
    }
    return this.view(flow);
  }

  closeAll() {
    for (const flow of this.flows.values()) if (flow.active) flow.child?.kill();
  }

  /** What the page may see: never the code, never the environment. */
  view(flow) {
    return { id: flow.id, profile: flow.profile, state: flow.state, url: flow.url, error: flow.error, note: flow.state === "waiting" ? promptReply(flow.output) : "" };
  }
}

/** What the CLI said after its "Paste code here" prompt (for example that the code was wrong), if anything. */
function promptReply(output) {
  const parts = String(output).split(/Paste code here if prompted\s*>/);
  return parts.length > 1 ? lastLine(parts.pop()) : "";
}

const lastLine = (text) => String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || "";
