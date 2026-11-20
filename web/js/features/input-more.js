// More for the composer: Ctrl+R search in earlier prompts (Claude Code's history file), "!" shell mode that runs a
// command on this machine without involving Claude, and "continue automatically" after a claude.ai usage limit.
// composer.js imports these; nothing here registers itself with the shell.
import { h, ibtn, modal, toast, errorMessage, debounce, formatTime, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { api } from "../core/api.js";
import { isBusy } from "../chat/reducer.js";
import * as session from "../session.js";

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

// ---- continue automatically after a usage limit ----------------------------------------------------------------
// The reducer sets conv.limitHit = { resetsAt (ms), type, at } from a rate_limit_event that is "rejected". The choice
// to continue on its own is ON by default and lives here, in memory only (the ones switched off): it survives switching
// conversations, not a page reload.
export const CONTINUE_TEXT = "Please continue the task you were working on.";
const GRACE_MS = 3000; // a moment after the reset, so the limit is surely lifted
const RETRY_MS = 15_000; // the conversation was still busy at the reset
const MAX_AUTO = 3; // like Claude Code: stop after this many automatic continues in a row

const autoOff = new Set(); // conversations where the person switched it off (or it stopped after repeated hits)
const isAuto = (id) => !autoOff.has(id);
const timers = new Map(); // conversation id -> { key, handle }
const fired = new Set(); // keys that were sent (or given up on): never twice
const autoCount = new Map(); // conversation id -> automatic continues since the user last wrote

const limitKey = (id, hit) => `${id}:${hit.resetsAt}`;

/** The user sent a message of their own: the run of automatic continues starts over. */
export function noteUserMessage(id) {
  autoCount.delete(id);
}

function unplan(id) {
  const old = timers.get(id);
  if (old) clearTimeout(old.handle);
  timers.delete(id);
}

function plan(id) {
  const conv = app.convs.get(id);
  const hit = conv?.limitHit;
  const key = hit ? limitKey(id, hit) : null;
  if (!hit || !isAuto(id) || fired.has(key)) { unplan(id); return; }
  if (timers.get(id)?.key === key) return; // already counting down to this reset
  unplan(id);
  arm(id, key, Math.max(0, hit.resetsAt - Date.now()) + GRACE_MS);
}

function arm(id, key, delay) {
  const handle = setTimeout(() => fire(id, key), Math.min(delay, 2 ** 31 - 1));
  timers.set(id, { key, handle });
}

async function fire(id, key) {
  const conv = app.convs.get(id);
  const hit = conv?.limitHit;
  // Still the same limit, still switched on, nothing newer from the user, never sent before.
  if (!conv || !hit || limitKey(id, hit) !== key || !isAuto(id) || fired.has(key)) { unplan(id); return; }
  if (Date.now() < hit.resetsAt) { arm(id, key, hit.resetsAt - Date.now() + GRACE_MS); return; } // woke early
  if (isBusy(conv)) { arm(id, key, RETRY_MS); return; } // idle or closed (the process was put to rest) only
  unplan(id);
  fired.add(key);
  if ((autoCount.get(id) || 0) >= MAX_AUTO) {
    autoOff.add(id);
    toast(t("Automatic continue stopped after repeated usage-limit hits."), "error");
    bus.emit("limit:auto", id);
    return;
  }
  autoCount.set(id, (autoCount.get(id) || 0) + 1);
  try {
    await session.sendMessageTo(id, CONTINUE_TEXT);
  } catch { /* the controller already showed the error */ }
  bus.emit("limit:auto", id);
}

bus.on("conv:update", (id) => {
  if (app.convs.get(id)?.limitHit || timers.has(id)) plan(id);
});

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

  function update() {
    clearTimeout(redraw);
    const id = app.currentId;
    const hit = id ? app.convs.get(id)?.limitHit : null;
    if (!hit || fired.has(limitKey(id, hit))) {
      shown = "";
      el.classList.add("hidden");
      el.replaceChildren();
      return;
    }
    const over = Date.now() >= hit.resetsAt;
    const signature = `${limitKey(id, hit)}|${over && !isAuto(id) ? "reset" : "wait"}|${document.documentElement.lang}`; // the switch keeps its own state
    if (signature !== shown) {
      shown = signature;
      draw(id, hit, over);
    }
    if (!over) redraw = setTimeout(update, Math.min(hit.resetsAt - Date.now() + 500, 2 ** 31 - 1));
  }

  function draw(id, hit, over) {
    el.classList.remove("hidden");
    if (over && !isAuto(id)) {
      el.replaceChildren(
        icon("clock", 14),
        h("span.lb-text", t("The usage limit has reset.")),
        h("span.grow"),
        h("button.btn.small.primary", { type: "button", onclick: () => { fired.add(limitKey(id, hit)); update(); session.sendMessageTo(id, CONTINUE_TEXT).catch(() => {}); } }, t("Continue")),
      );
      return;
    }
    const toggle = h("input", { type: "checkbox", checked: isAuto(id), "aria-label": t("Continue automatically"), onchange: () => {
      if (toggle.checked) autoOff.delete(id); else autoOff.add(id);
      plan(id);
      update(); // (an over-due limit with the switch off turns into the "has reset" notice)
    } });
    el.replaceChildren(
      icon("clock", 14),
      h("span.lb-text", t("Usage limit reached — continue automatically at {time}", { time: clock(hit.resetsAt) })),
      h("span.grow"),
      h("label.switch", toggle, h("span", t("Continue automatically"))),
    );
  }

  bus.on("limit:auto", update);
  return { el, update };
}
