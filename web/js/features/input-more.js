// More for the composer: Ctrl+R search in earlier prompts (Claude Code's history file), "!" shell mode that runs a
// command on this machine without involving Claude, and the banner for a session that waits for a claude.ai usage limit.
// composer.js imports these; nothing here registers itself with the shell.
import { h, ibtn, modal, toast, errorMessage, debounce, formatTime, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { outboxOf, setAutoContinue, continueNow, resumeOutbox } from "../core/outbox.js";
import { api } from "../core/api.js";

const locale = () => (document.documentElement.lang === "fa" ? "fa-IR" : undefined);

// ---- Ctrl+R: earlier prompts from every session -----------------------------------------------------------------
const oneLine = (text, max = 220) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** A searchable list of earlier prompts (GET /api/history). onPick(text) gets the chosen prompt. */
export function openHistoryPicker({ cwd, onPick }) {
  let scope = cwd ? "folder" : "all";
  let entries = [];
  let index = 0;
  let loadToken = 0;
  const search = h("input.input", { type: "search", autofocus: true, dir: "auto", placeholder: t("Search earlier prompts…"), "aria-label": t("Search earlier prompts") });
  const list = h("div.hist-list", { role: "listbox" });
  const scopes = {
    folder: h("button.chip", { type: "button", onclick: () => setScope("folder") }, t("This folder")),
    all: h("button.chip", { type: "button", onclick: () => setScope("all") }, t("All folders")),
  };
  if (!cwd) scopes.folder.disabled = true;

  const pick = (entry) => {
    dialog.close();
    if (entry) onPick(entry.text);
  };

  function render(message) {
    for (const [key, button] of Object.entries(scopes)) button.classList.toggle("active", key === scope);
    if (message || !entries.length) {
      list.replaceChildren(h("div.hist-empty.muted", message || t("No earlier prompts found.")));
      return;
    }
    list.replaceChildren(
      ...entries.map((entry, position) =>
        h(
          `button.picker-item.hist-item${position === index ? ".active" : ""}`,
          { type: "button", role: "option", "aria-selected": position === index ? "true" : "false", onclick: () => pick(entry), onmousemove: () => { if (index !== position) { index = position; mark(); } } },
          h("span.pi-main", h("span.hist-text", { dir: "auto" }, oneLine(entry.text)), h("span.hist-meta.muted", [entry.timestamp ? formatTime(entry.timestamp) : "", scope === "all" && entry.project ? baseName(entry.project) : ""].filter(Boolean).join(" · "))),
        ),
      ),
    );
  }

  function mark() {
    [...list.children].forEach((row, position) => {
      row.classList.toggle("active", position === index);
      row.setAttribute("aria-selected", position === index ? "true" : "false");
      if (position === index) row.scrollIntoView({ block: "nearest" });
    });
  }

  async function load() {
    const token = ++loadToken;
    try {
      const result = await api.get("/api/history", { project: scope === "folder" ? cwd : "", q: search.value.trim(), limit: 60 });
      if (token !== loadToken) return;
      entries = result.entries || [];
      index = 0;
      render();
    } catch (error) {
      if (token !== loadToken) return;
      entries = [];
      render(errorMessage(error));
    }
  }
  const reload = debounce(load, 150);

  function setScope(next) {
    if (scope === next) return;
    scope = next;
    render(t("Loading…"));
    load();
    search.focus();
  }

  search.addEventListener("input", reload);
  search.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length) { index = (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length; mark(); }
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(entries[index]);
    } else if (event.key === "r" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); // Ctrl+R again steps to the next match, like in the terminal
      if (entries.length) { index = (index + 1) % entries.length; mark(); }
    }
  });

  const dialog = modal({
    title: t("Earlier prompts"),
    width: 640,
    className: "hist-dialog",
    body: h("div.hist", search, h("div.hist-scope", scopes.folder, scopes.all, h("span.grow"), h("span.muted.small", t("Enter inserts the prompt in the message box"))), list),
  });
  render(t("Loading…"));
  load();
  return dialog;
}

// ---- "!" shell mode: run a command on this machine, show its output, optionally send it to Claude -----------------
export const isShellInput = (text) => String(text).startsWith("!");

const MAX_OUTPUT = 200_000; // characters kept of one command's output
const MAX_CONTEXT = 30_000; // characters of it sent to Claude

/** Plain text of what a command printed: colour codes dropped, carriage-return progress lines collapsed. */
export function cleanOutput(text) {
  return String(text)
    // PowerShell wraps what it writes to stderr in a CLIXML envelope: keep the error text only
    .replace(/#< CLIXML\r?\n?<Objs[^>]*>[\s\S]*?<\/Objs>/g, (block) => [...block.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
      .map((match) => match[1].replaceAll("_x000D__x000A_", "\n").replaceAll("_x000D_", "").replaceAll("_x000A_", "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
      .join(""))
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** The message that hands a finished command and its output to Claude as context. */
export function contextMessage(run) {
  let output = cleanOutput(run.output).trimEnd();
  let cut = "";
  if (output.length > MAX_CONTEXT) {
    output = output.slice(-MAX_CONTEXT);
    cut = `[output cut to its last ${MAX_CONTEXT} characters]\n`;
  }
  let fence = "```";
  while (output.includes(fence) || run.command.includes(fence)) fence += "`";
  const status = run.exit?.stopped ? "stopped before it finished" : `exit code ${run.exit?.code ?? "?"}`;
  return `I ran this command on my machine in ${run.cwd} (${status}):\n\n${fence}\n$ ${run.command}\n${cut}${output}\n${fence}`;
}

/**
 * Local command blocks, one per conversation (in memory). run(command) starts the command through /api/term/run and
 * follows /api/term/:id/stream; the block of the conversation on screen lives in `el`. Nothing runs unless run() is called.
 */
export function createLocalRuns({ onSend }) {
  const el = h("div.local-run-host.hidden");
  const runs = new Map(); // conversation id -> run

  function discard(run) {
    run.source?.close();
    run.source = null;
    if (run.running) api.post("/api/term/stop", { id: run.id }).catch(() => {});
    api.post("/api/term/close", { id: run.id }).catch(() => {});
  }

  function build(run) {
    const status = h("span.lr-status");
    const out = h("pre.lr-out", { dir: "ltr", tabindex: 0 });
    const error = h("div.lr-error.hidden", { dir: "auto" });
    const stop = h("button.btn.small", { type: "button", onclick: () => api.post("/api/term/stop", { id: run.id }).catch((error) => toast(errorMessage(error), "error")) }, icon("stop", 12), t("Stop"));
    const send = h("button.btn.small.primary", { type: "button", onclick: () => { run.sent = true; paint(); onSend(contextMessage(run)); } });
    const close = ibtn("x", t("Dismiss"), () => { discard(run); if (runs.get(run.convId) === run) runs.delete(run.convId); update(); }, { size: 14 });
    run.parts = { status, out, error, stop, send };
    return h(
      "div.local-run",
      h("div.lr-head", icon("terminal", 14), h("strong", t("Ran locally")), h("span.lr-note", t("on this machine, not sent to Claude")), h("span.grow"), status, close),
      h("div.lr-cmd", { dir: "ltr" }, h("span.lr-prompt", "$"), h("code", run.command)),
      error,
      out,
      h("div.lr-foot", h("span.lr-cwd.muted.small", { dir: "ltr", title: run.cwd }, run.cwd), h("span.grow"), stop, send),
    );
  }

  let painting = false;
  function paint() {
    // Output arrives in many small chunks: one repaint per frame.
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      for (const run of runs.values()) paintRun(run);
    });
  }

  function paintRun(run) {
    const { status, out, error, stop, send } = run.parts;
    const text = cleanOutput(run.output);
    const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 24;
    out.textContent = text || (run.running ? "" : t("(no output)"));
    if (stick) out.scrollTop = out.scrollHeight;
    const failed = run.error || (run.exit && (run.exit.code !== 0 || run.exit.stopped));
    run.node.classList.toggle("failed", Boolean(failed));
    status.textContent = run.error ? t("Could not run") : run.running ? t("Running…") : run.exit?.stopped ? t("Stopped") : t("Exit code {code}", { code: run.exit?.code ?? "?" });
    out.classList.toggle("hidden", Boolean(run.error));
    error.classList.toggle("hidden", !run.error);
    error.textContent = run.error || "";
    stop.classList.toggle("hidden", !run.running);
    send.classList.toggle("hidden", run.running || Boolean(run.error));
    send.disabled = Boolean(run.sent);
    send.replaceChildren(icon("send", 12), run.sent ? t("Sent to Claude") : t("Send output to Claude"));
  }

  /** Start a command in the folder of the conversation on screen. */
  async function run(command) {
    const convId = app.currentId;
    const conv = app.convs.get(convId);
    const cwd = conv?.cwd || app.currentCwd || app.config?.defaultCwd;
    const previous = runs.get(convId);
    if (previous?.running) {
      toast(t("A command is already running here. Stop it first."), "error");
      return false;
    }
    if (previous) discard(previous);
    const entry = { convId, id: `whsh${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, command, cwd, output: "", running: true, exit: null, error: null, sent: false, source: null };
    entry.node = build(entry);
    runs.set(convId, entry);
    update();
    paint();
    try {
      await api.post("/api/term/run", { id: entry.id, cwd, command });
    } catch (error) {
      entry.running = false;
      entry.error = errorMessage(error);
      paint();
      return true;
    }
    const source = new EventSource(`/api/term/${entry.id}/stream?after=0`);
    entry.source = source;
    source.addEventListener("out", (event) => {
      const data = JSON.parse(event.data);
      if (data.stream === "stdin") return;
      entry.output = (entry.output + data.text).slice(-MAX_OUTPUT);
      paint();
    });
    source.addEventListener("exit", (event) => {
      entry.exit = JSON.parse(event.data);
      entry.running = false;
      source.close();
      entry.source = null;
      api.post("/api/term/close", { id: entry.id }).catch(() => {});
      paint();
    });
    return true;
  }

  /** Show the block that belongs to the conversation on screen. */
  function update() {
    const entry = runs.get(app.currentId);
    el.classList.toggle("hidden", !entry);
    if (!entry) { el.replaceChildren(); return; }
    if (el.firstChild !== entry.node) el.replaceChildren(entry.node);
    paintRun(entry);
  }

  return { el, run, update, running: () => Boolean(runs.get(app.currentId)?.running) };
}

// ---- waiting for a usage limit ---------------------------------------------------------------------------------
// The server holds a session's queue while a claude.ai usage limit is in force and, at the reset, first continues the
// turn the limit cut off (automatic continue, on by default, per session) and then sends what waits (server/lib/outbox.mjs).
// This banner shows that state for the conversation on screen and lets the user change it; nothing is timed here.

/** The banner above the message box for the conversation on screen. update() is cheap: call it whenever things change. */
export function createLimitBanner() {
  const el = h("div.limit-banner.hidden");
  let redraw = null;
  let shown = ""; // what the banner shows now: an unchanged banner is not rebuilt (it would drop focus from its switch)
  const clock = (ms) => {
    const date = new Date(ms);
    const sameDay = date.toDateString() === new Date().toDateString();
    return date.toLocaleString(locale(), sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
  };
  const act = (work) => work().catch((error) => toast(errorMessage(error), "error"));

  function update() {
    clearTimeout(redraw);
    const id = app.currentId;
    const box = outboxOf(id);
    const hold = box?.hold;
    if (!hold) {
      shown = "";
      el.classList.add("hidden");
      el.replaceChildren();
      return;
    }
    const waiting = box.items?.length || 0;
    const signature = `${id}|${hold.resetsAt}|${hold.reset ? "reset" : "wait"}|${hold.soft ? 1 : 0}|${hold.account ? 1 : 0}|${box.auto}|${waiting}|${document.documentElement.lang}`;
    if (signature !== shown) {
      shown = signature;
      draw(id, box, hold, waiting);
    }
    // The time shown can turn into "tomorrow" style wording; refresh at the reset in case the server's word is late.
    if (!hold.reset && hold.resetsAt > Date.now()) redraw = setTimeout(update, Math.min(hold.resetsAt - Date.now() + 1000, 2 ** 31 - 1));
  }

  function draw(id, box, hold, waiting) {
    el.classList.remove("hidden");
    const queued = waiting ? h("span.lb-queued", t("{n} queued message(s) will be sent after it.", { n: waiting })) : null;
    if (hold.reset) {
      el.replaceChildren(
        icon("clock", 14),
        h("span.lb-text", t("The usage limit has reset.")),
        h("span.grow"),
        h("button.btn.small.primary", { type: "button", onclick: () => act(() => continueNow(id)) }, t("Continue")),
        ibtn("x", t("Dismiss"), () => act(() => resumeOutbox(id, { skipHold: true })), { size: 13 }),
      );
      return;
    }
    const time = clock(hold.resetsAt);
    const skip = waiting ? h("button.btn.small", { type: "button", title: t("Send the queued messages now instead of waiting for the reset"), onclick: () => act(() => resumeOutbox(id, { skipHold: true })) }, t("Send now")) : null;
    if (hold.soft || hold.account) {
      const text = hold.account
        ? t("Another session of this account reached the usage limit. Queued messages wait until {time}.", { time })
        : t("Claude stopped on a usage limit. Waiting until {time} before sending more.", { time });
      el.replaceChildren(icon("clock", 14), h("span.lb-text", text), h("span.grow"), skip || "");
      return;
    }
    const toggle = h("input", { type: "checkbox", checked: box.auto !== false, "aria-label": t("Continue automatically"), onchange: () => act(() => setAutoContinue(id, toggle.checked)) });
    el.replaceChildren(
      icon("clock", 14),
      h("span.lb-text", box.auto !== false ? t("Usage limit reached — continue automatically at {time}", { time }) : t("Usage limit reached — it resets at {time}", { time }), " ", queued || ""),
      h("span.grow"),
      skip || "",
      h("label.switch", toggle, h("span", t("Continue automatically"))),
    );
  }

  return { el, update };
}
