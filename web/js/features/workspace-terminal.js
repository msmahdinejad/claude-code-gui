// Inspector tab "Terminal": a non-interactive command runner (spawn + SSE, no PTY).
// Multiple tabs, history, ANSI colors, stop, stdin line for running processes, "Send output to Claude".
import { h, ibtn, toast, errorMessage, copyText, baseName, shortPath } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { bus } from "../core/state.js";
import { api } from "../core/api.js";
import { registerInspectorTab, registerCommand } from "../core/registry.js";
import { AnsiView, cwdNow } from "./workspace-common.js";

const HISTORY_KEY = "wheelhouse-term-history";
const MAX_TRANSCRIPT = 400_000;

const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; } };
const history = loadHistory();
const remember = (command) => {
  if (history[history.length - 1] === command) return;
  history.push(command);
  while (history.length > 200) history.shift();
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
};

// ---- tabs (module state survives the panel being closed/reopened) ----------------------
let counter = 0;
const tabs = []; // { id, title, cwd, running, view(AnsiView), root(el), source, lastCommand, transcript, exit, histIndex, draft }
let activeId = null;
let ui = null; // { strip, host, input, stdinRow, status, runBtn, stopBtn }

function newId() {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTab() {
  const id = newId();
  counter += 1;
  const root = h("div.term-out", { dir: "ltr", role: "log", "aria-live": "off", tabindex: "0" });
  const tab = { id, title: `${t("Terminal")} ${counter}`, cwd: cwdNow(), running: false, root, view: new AnsiView(root, { maxLines: 5000 }), source: null, lastCommand: "", transcript: "", exit: null, histIndex: -1, draft: "", seq: 0 };
  tabs.push(tab);
  connect(tab);
  activeId = id;
  return tab;
}

function connect(tab) {
  tab.source?.close();
  const source = new EventSource(`/api/term/${tab.id}/stream?after=${tab.seq}`);
  tab.source = source;
  const seen = (event) => { const id = Number(event.lastEventId); if (id) tab.seq = Math.max(tab.seq, id); };
  source.addEventListener("hello", (event) => {
    const data = JSON.parse(event.data);
    tab.running = Boolean(data.running);
    if (data.cwd) tab.cwd = data.cwd;
    refreshUi();
  });
  source.addEventListener("start", (event) => {
    seen(event);
    const data = JSON.parse(event.data);
    tab.running = true;
    tab.cwd = data.cwd || tab.cwd;
    tab.exit = null;
    tab.lastCommand = data.command;
    tab.transcript = "";
    tab.view.write(`\x1b[1;36m${prompt(tab.cwd)}\x1b[0m ${data.command.replace(/\n/g, "\n> ")}\n`);
    refreshUi();
  });
  source.addEventListener("out", (event) => {
    seen(event);
    const data = JSON.parse(event.data);
    tab.view.write(data.stream === "stderr" ? `\x1b[31m${data.text}\x1b[0m` : data.stream === "stdin" ? `\x1b[2m${data.text}\x1b[0m` : data.text);
    tab.transcript = (tab.transcript + data.text).slice(-MAX_TRANSCRIPT);
    if (tab.id === activeId) stickToBottom(tab);
  });
  source.addEventListener("exit", (event) => {
    seen(event);
    const data = JSON.parse(event.data);
    tab.running = false;
    tab.exit = data;
    if (data.cwd) tab.cwd = data.cwd;
    const note = data.stopped ? t("stopped") : data.code === 0 ? t("done") : t("exit code {code}", { code: data.code });
    tab.view.write(`\n\x1b[${data.code === 0 && !data.stopped ? "32" : "31"};2m[${note}]\x1b[0m\n`);
    if (tab.id === activeId) stickToBottom(tab);
    refreshUi();
    if (tab.id === activeId && ui) ui.input.focus();
  });
  source.onerror = () => { /* EventSource retries by itself; the server replays from tab.seq */ };
}

const prompt = (cwd) => `${baseName(cwd || "") || cwd}>`;

function stickToBottom(tab) {
  const el = tab.root;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

const activeTab = () => tabs.find((tab) => tab.id === activeId);

// ---- actions ---------------------------------------------------------------------------
async function run(command) {
  const tab = activeTab();
  if (!tab || !command.trim()) return;
  if (tab.running) return toast(t("A command is already running in this tab."), "error");
  remember(command);
  tab.histIndex = -1;
  tab.draft = "";
  try {
    await api.post("/api/term/run", { id: tab.id, cwd: tab.cwd || cwdNow(), command });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function stop() {
  const tab = activeTab();
  if (tab?.running) await api.post("/api/term/stop", { id: tab.id }).catch((error) => toast(errorMessage(error), "error"));
}

async function sendStdin(text) {
  const tab = activeTab();
  if (!tab?.running) return;
  await api.post("/api/term/stdin", { id: tab.id, text }).catch((error) => toast(errorMessage(error), "error"));
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  tab.source?.close();
  api.post("/api/term/close", { id }).catch(() => {});
  if (!tabs.length) createTab();
  else if (activeId === id) activeId = tabs[Math.max(0, index - 1)].id;
  mountActive();
}

function sendToClaude() {
  const tab = activeTab();
  if (!tab?.lastCommand) return toast(t("Run a command first."), "error");
  const text = tab.view.plainText().replace(/\n{3,}/g, "\n\n").trim();
  const out = text.length > 12000 ? `…\n${text.slice(-12000)}` : text;
  bus.emit("composer:fill", `${t("I ran this command in the terminal:")}\n\n\`\`\`\n${out}\n\`\`\`\n\n`);
  toast(t("Output placed in the composer"), "ok", 1800);
}

// ---- UI --------------------------------------------------------------------------------
function refreshUi() {
  if (!ui) return;
  const tab = activeTab();
  ui.strip.replaceChildren(
    ...tabs.map((entry) =>
      h(
        `div.term-tab${entry.id === activeId ? ".active" : ""}`,
        { role: "tab", onclick: () => { activeId = entry.id; mountActive(); } },
        entry.running ? h("span.spinner", { style: { width: "10px", height: "10px" } }) : icon("terminal", 12),
        h("span", entry.title),
        tabs.length > 1 || entry.lastCommand ? h("button.term-x", { type: "button", title: t("Close tab"), onclick: (event) => { event.stopPropagation(); closeTab(entry.id); } }, icon("x", 11)) : null,
      ),
    ),
    ibtn("plus", t("New terminal"), () => { createTab(); mountActive(); }, { size: 14 }),
  );
  if (!tab) return;
  ui.promptLabel.textContent = prompt(tab.cwd);
  ui.promptLabel.title = tab.cwd || "";
  ui.status.replaceChildren(
    icon("folder", 12),
    h("span.term-cwd", { dir: "ltr", title: tab.cwd }, shortPath(tab.cwd || "", 46)),
    h("span", { style: { flex: 1 } }),
    tab.running ? h("span.badge.accent", t("running")) : tab.exit ? h(`span.badge.${tab.exit.code === 0 && !tab.exit.stopped ? "ok" : "danger"}`, tab.exit.stopped ? t("stopped") : `${tab.exit.code}`) : null,
  );
  ui.runBtn.classList.toggle("hidden", tab.running);
  ui.stopBtn.classList.toggle("hidden", !tab.running);
  ui.stdinRow.classList.toggle("hidden", !tab.running);
  ui.input.disabled = tab.running;
}

function mountActive() {
  if (!ui) return;
  const tab = activeTab();
  ui.host.replaceChildren(tab.root);
  refreshUi();
  requestAnimationFrame(() => { tab.root.scrollTop = tab.root.scrollHeight; });
}

function render(container) {
  if (!tabs.length) createTab();
  const input = h("input.input.term-input", { type: "text", dir: "ltr", spellcheck: "false", autocomplete: "off", placeholder: t("Type a command and press Enter"), "aria-label": t("Command") });
  const promptLabel = h("span.term-prompt", { dir: "ltr" });
  const runBtn = h("button.btn.small.primary", { type: "button", onclick: () => submit() }, icon("play", 12), t("Run"));
  const stopBtn = h("button.btn.small.danger", { type: "button", onclick: stop }, icon("stop", 12), t("Stop"));
  const stdin = h("input.input", { type: "text", dir: "ltr", placeholder: t("Send a line to the running process (Enter)"), "aria-label": t("Standard input") });
  stdin.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); sendStdin(stdin.value); stdin.value = ""; } });
  const stdinRow = h("div.term-stdin.hidden", icon("chevron-right", 12), stdin);
  const strip = h("div.term-tabs", { role: "tablist" });
  const host = h("div.term-host");
  const status = h("div.term-status");
  ui = { strip, host, input, promptLabel, status, runBtn, stopBtn, stdinRow };

  const submit = () => { const value = input.value; input.value = ""; run(value); };
  input.addEventListener("keydown", (event) => {
    const tab = activeTab();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    else if (event.key === "ArrowUp") {
      if (!history.length) return;
      event.preventDefault();
      if (tab.histIndex === -1) { tab.draft = input.value; tab.histIndex = history.length; }
      tab.histIndex = Math.max(0, tab.histIndex - 1);
      input.value = history[tab.histIndex];
    } else if (event.key === "ArrowDown") {
      if (tab.histIndex === -1) return;
      event.preventDefault();
      tab.histIndex += 1;
      if (tab.histIndex >= history.length) { tab.histIndex = -1; input.value = tab.draft; } else input.value = history[tab.histIndex];
    } else if (event.key === "c" && event.ctrlKey && tab.running) { event.preventDefault(); stop(); }
    else if (event.key === "l" && event.ctrlKey) { event.preventDefault(); tab.view.clear(); }
  });

  container.append(
    h(
      "div.ws-panel.term",
      strip,
      h("div.term-note", icon("info", 13), h("span", t("Runs commands without a TTY. Interactive programs that wait for key presses won't work; you can send lines to stdin while a command runs."))),
      host,
      status,
      h("div.term-bar", promptLabel, input, runBtn, stopBtn),
      stdinRow,
      h("div.term-tools", h("button.btn.small.ghost", { type: "button", onclick: sendToClaude }, icon("sparkles", 13), t("Send output to Claude")), h("button.btn.small.ghost", { type: "button", onclick: () => { activeTab()?.view.clear(); } }, icon("trash", 13), t("Clear")), h("button.btn.small.ghost", { type: "button", onclick: () => copyText(activeTab()?.view.plainText() || "") }, icon("copy", 13), t("Copy output"))),
    ),
  );
  mountActive();
  // New session folder: terminals that never ran anything follow the session cwd.
  for (const tab of tabs) if (!tab.lastCommand && !tab.running) tab.cwd = cwdNow();
  refreshUi();
  setTimeout(() => !input.disabled && input.focus(), 50);
  return () => { ui = null; };
}

registerInspectorTab({ id: "terminal", title: "Terminal", icon: "terminal", order: 30, render, badge: () => (tabs.some((tab) => tab.running) ? "●" : "") });

bus.on("current", () => {
  for (const tab of tabs) if (!tab.lastCommand && !tab.running) tab.cwd = cwdNow();
  refreshUi();
});

registerCommand({ id: "ws-terminal", title: "Open terminal", icon: "terminal", keywords: ["shell", "command", "powershell"], run: (ctx) => ctx.openInspector("terminal") });
