// Terminal tab, "PTY mode": a real pseudo-terminal rendered by xterm.js. The server side is server/lib/routes/pty.mjs
// (SSE for output, POST for input/resize, DELETE to close). workspace-terminal.js decides between this mode and the
// line-based fallback. Tabs live in module state, so closing/reopening the inspector keeps the shells running.
import { h, ibtn, toast, errorMessage, menu, copyText } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { api } from "../core/api.js";
import { cwdNow } from "./workspace-common.js";

const STORE_KEY = "wheelhouse-pty-tabs"; // sessionStorage: shells to re-attach after a page reload
const MAX_CHUNK = 48 * 1024;
const MAX_TRANSCRIPT_LINES = 400;

// ---- capability probe + lazy library ---------------------------------------------------------
let infoPromise = null;
export function loadPtyInfo(force = false) {
  if (!infoPromise || force) {
    infoPromise = api.get("/api/pty/info").catch((error) => ({ available: false, reason: errorMessage(error), shells: [] }));
  }
  return infoPromise;
}

let libPromise = null;
function loadLib() {
  if (!libPromise) {
    libPromise = import("../../vendor/xterm.js").then((lib) => {
      const link = h("link", { rel: "stylesheet", href: "/vendor/xterm.css" });
      document.head.append(link);
      return lib;
    });
    libPromise.catch(() => { libPromise = null; });
  }
  return libPromise;
}

export async function ptyReady() {
  const info = await loadPtyInfo();
  if (!info.available) return { ok: false, reason: info.reason || "", info };
  try {
    return { ok: true, info, lib: await loadLib() };
  } catch (error) {
    return { ok: false, reason: errorMessage(error), info };
  }
}

// ---- theme from the app's CSS tokens ----------------------------------------------------------
const probe = h("span", { style: { display: "none" } });
function cssColor(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  if (!probe.isConnected) document.body.append(probe);
  probe.style.color = "";
  probe.style.color = raw;
  return getComputedStyle(probe).color || fallback;
}
const luminance = (color) => {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : 1;
};

function terminalTheme() {
  const background = cssColor("--code-bg", "#f4f2ea");
  const dark = luminance(background) < 0.5;
  const foreground = cssColor("--code-text", dark ? "#e8e6dc" : "#2b2a27");
  const accent = cssColor("--accent", "#c96442");
  const pick = (light, night) => (dark ? night : light);
  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: pick("rgba(201, 100, 66, 0.28)", "rgba(217, 119, 87, 0.38)"),
    black: pick("#2b2a27", "#55554f"),
    red: cssColor("--danger", "#b3261e"),
    green: cssColor("--ok", "#2f7d4f"),
    yellow: cssColor("--warn", "#a8620a"),
    blue: cssColor("--info", "#2d6cb5"),
    magenta: pick("#8a4fb0", "#c79bea"),
    cyan: pick("#1f7a8c", "#6cc6d6"),
    white: pick("#a9a69b", "#e8e6dc"),
    brightBlack: pick("#6b6860", "#8f8d84"),
    brightRed: pick("#d03a30", "#ffa89c"),
    brightGreen: pick("#3d9a63", "#8ee0ae"),
    brightYellow: pick("#c27a14", "#f6cd84"),
    brightBlue: pick("#3f85d4", "#a3c9f5"),
    brightMagenta: pick("#a468cc", "#dcb8f4"),
    brightCyan: pick("#2a95aa", "#92dbe8"),
    brightWhite: pick("#55534d", "#faf9f5"),
  };
}
const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "Consolas, monospace";

// ---- helpers ----------------------------------------------------------------------------------
const decode = (b64) => {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const inAppWindow = new URLSearchParams(location.search).has("app");
/** Only http(s) links are ever opened; in the standalone window the server opens them in the user's browser. */
function openLink(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  if (inAppWindow && parsed.origin !== location.origin) api.post("/api/open-external", { url: parsed.href }).catch((error) => toast(errorMessage(error), "error"));
  else window.open(parsed.href, "_blank", "noopener,noreferrer");
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
function linkProvider(term) {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links = [];
      for (const match of text.matchAll(URL_RE)) {
        const clean = match[0].replace(/[.,;:!?)\]}>]+$/, "");
        if (clean.length < 8) continue;
        links.push({ range: { start: { x: match.index + 1, y }, end: { x: match.index + clean.length, y } }, text: clean, activate: (_event, value) => openLink(value) });
      }
      callback(links.length ? links : undefined);
    },
  };
}

// ---- tabs (module state survives the panel being closed/reopened) -----------------------------
let counter = 0;
const tabs = []; // { key, id(server), title, cwd, shell, label, term, fit, root, screen, source, seq, running, exit, inbox, sending, failed }
let activeKey = null;
let ui = null; // { strip, host, status, tools }
let shells = [];
let lib = null;
let observer = null;
let restored = false;
let themeWatch = null;

const activeTab = () => tabs.find((tab) => tab.key === activeKey);
export const ptyRunning = () => tabs.some((tab) => tab.running);

function persist() {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(tabs.filter((tab) => tab.id).map(({ id, title, shell }) => ({ id, title, shell })))); } catch { /* ignore */ }
}

function makeTab({ title, shell, cwd, id = null }) {
  counter += 1;
  const key = `pty-tab-${counter}-${Math.random().toString(36).slice(2, 7)}`;
  const screen = h("div.pty-screen", { dir: "ltr" });
  const root = h("div.pty-mount");
  screen.append(root);
  const tab = { key, id, title: title || `${t("Terminal")} ${counter}`, cwd: cwd || cwdNow(), shell: shell || "default", label: "", term: null, fit: null, root, screen, source: null, seq: 0, running: false, exit: null, inbox: "", sending: false, failed: false, resizeTimer: null };
  const term = new lib.Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontSize: 13,
    fontFamily: monoFont(),
    theme: terminalTheme(),
    allowProposedApi: true,
    macOptionIsMeta: true,
    linkHandler: { allowNonHttpProtocols: false, activate: (_event, text) => openLink(text) },
  });
  const fit = new lib.FitAddon();
  term.loadAddon(fit);
  term.open(root);
  term.registerLinkProvider(linkProvider(term));
  term.onData((data) => queueInput(tab, data));
  term.onResize(({ cols, rows }) => scheduleResize(tab, cols, rows));
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    if (mod && key === "c" && (event.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) { copyText(term.getSelection(), t("Copied")); term.clearSelection(); }
      return false; // plain Ctrl+C without a selection goes to the process as ^C
    }
    if (mod && key === "v") return false; // the browser's paste event reaches xterm (bracketed paste aware)
    return true;
  });
  screen.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (term.hasSelection()) { copyText(term.getSelection(), t("Copied")); term.clearSelection(); }
    else pasteInto(tab);
  });
  tab.term = term;
  tab.fit = fit;
  tabs.push(tab);
  return tab;
}

async function pasteInto(tab) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) tab.term.paste(text);
  } catch {
    toast(t("The browser blocked reading the clipboard. Use Ctrl+V instead."), "error");
  }
  tab.term.focus();
}

// ---- server side ------------------------------------------------------------------------------
async function openOnServer(tab) {
  tab.failed = false;
  try {
    const info = await api.post("/api/pty/open", { cwd: tab.cwd, cols: tab.term.cols, rows: tab.term.rows, shell: tab.shell });
    tab.id = info.id;
    tab.label = info.label;
    tab.cwd = info.cwd || tab.cwd;
    tab.running = true;
    tab.seq = 0;
    persist();
    connect(tab);
    flushInput(tab);
  } catch (error) {
    tab.failed = true;
    tab.term.write(`\x1b[31;2m${errorMessage(error).replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
    toast(errorMessage(error), "error");
  }
  refreshUi();
}

function connect(tab) {
  tab.source?.close();
  if (!tab.id) return;
  const source = new EventSource(`/api/pty/${tab.id}/stream?after=${tab.seq}`);
  tab.source = source;
  const seen = (event) => { const n = Number(event.lastEventId); if (n) tab.seq = Math.max(tab.seq, n); };
  source.addEventListener("hello", (event) => {
    const data = JSON.parse(event.data);
    tab.running = Boolean(data.running);
    tab.label = data.label || tab.label;
    if (data.cwd) tab.cwd = data.cwd;
    if (data.exit) tab.exit = data.exit;
    if (tab.seq > 0 && data.oldest > tab.seq + 1) {
      // Output was dropped from the server's scrollback while this tab was hidden: start over from what is left.
      source.close();
      tab.source = null;
      tab.seq = 0;
      tab.term.reset();
      connect(tab);
      return;
    }
    refreshUi();
    if (tab.running && tab.key === activeKey) pushSize(tab);
  });
  source.addEventListener("data", (event) => {
    seen(event);
    tab.term.write(decode(JSON.parse(event.data).d));
  });
  source.addEventListener("exit", (event) => {
    seen(event);
    const data = JSON.parse(event.data);
    tab.running = false;
    tab.exit = data;
    tab.term.write(`\r\n\x1b[${data.code === 0 ? "32" : "31"};2m[${t("process exited")}${data.code !== null && data.code !== undefined ? ` (${data.code})` : ""}]\x1b[0m\r\n`);
    refreshUi();
    bus.emit("conv:update", app.currentId);
  });
  source.onerror = () => {
    // The server forgot this terminal (restart, idle cleanup)? EventSource would retry forever: check once.
    api.get(`/api/pty/${tab.id}/state`).catch((error) => {
      if (error.status !== 404 || tab.source !== source) return;
      source.close();
      tab.source = null;
      tab.running = false;
      tab.exit = { code: null };
      tab.term.write(`\r\n\x1b[31;2m[${t("terminal closed on the server")}]\x1b[0m\r\n`);
      persist();
      refreshUi();
    });
  };
}

function syncStreams() {
  for (const tab of tabs) {
    const want = Boolean(ui) && tab.key === activeKey && tab.id;
    if (want && !tab.source) connect(tab);
    else if (!want && tab.source) { tab.source.close(); tab.source = null; }
  }
}

// Keystrokes are sent in order: one request at a time, everything typed meanwhile goes out as one chunk.
function queueInput(tab, data) {
  tab.inbox += data;
  flushInput(tab);
}

async function flushInput(tab) {
  if (tab.sending || !tab.id || !tab.inbox) return;
  tab.sending = true;
  try {
    while (tab.inbox && tab.id) {
      const chunk = tab.inbox.slice(0, MAX_CHUNK);
      tab.inbox = tab.inbox.slice(chunk.length);
      await api.post(`/api/pty/${tab.id}/input`, { data: chunk });
    }
  } catch (error) {
    tab.inbox = "";
    if (error.status !== 409 && error.status !== 404) toast(errorMessage(error), "error");
  } finally {
    tab.sending = false;
  }
}

function scheduleResize(tab, cols, rows) {
  clearTimeout(tab.resizeTimer);
  tab.resizeTimer = setTimeout(() => { if (tab.id && tab.running) api.post(`/api/pty/${tab.id}/resize`, { cols, rows }).catch(() => {}); }, 80);
}
const pushSize = (tab) => scheduleResize(tab, tab.term.cols, tab.term.rows);

function fitTab(tab) {
  if (!tab.screen.isConnected || !tab.root.clientWidth || !tab.root.clientHeight) return;
  try { tab.fit.fit(); } catch { /* not laid out yet */ }
}

// ---- actions ----------------------------------------------------------------------------------
async function newTab(shell) {
  const tab = makeTab({ shell, cwd: cwdNow() });
  activeKey = tab.key;
  mountActive();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  fitTab(tab);
  await openOnServer(tab);
}

function closeTab(key) {
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  tab.source?.close();
  clearTimeout(tab.resizeTimer);
  if (tab.id) api.del(`/api/pty/${tab.id}`).catch(() => {});
  tab.term.dispose();
  persist();
  if (!tabs.length) { newTab(); return; }
  if (activeKey === key) activeKey = tabs[Math.max(0, index - 1)].key;
  mountActive();
}

async function restart(tab) {
  tab.source?.close();
  tab.source = null;
  if (tab.id) api.del(`/api/pty/${tab.id}`).catch(() => {});
  tab.id = null;
  tab.exit = null;
  tab.running = false;
  tab.inbox = "";
  tab.term.reset();
  tab.cwd = cwdNow();
  fitTab(tab);
  await openOnServer(tab);
}

function transcript(tab) {
  const buffer = tab.term.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buffer.length - MAX_TRANSCRIPT_LINES); i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sendToClaude() {
  const tab = activeTab();
  if (!tab) return;
  const selected = tab.term.hasSelection() ? tab.term.getSelection() : "";
  const text = (selected || transcript(tab)).trim();
  if (!text) return toast(t("Nothing to send yet."), "error");
  const out = text.length > 12000 ? `…\n${text.slice(-12000)}` : text;
  bus.emit("composer:fill", `${t("This is the terminal output:")}\n\n\`\`\`\n${out}\n\`\`\`\n\n`);
  toast(t("Output placed in the composer"), "ok", 1800);
}

// ---- UI ---------------------------------------------------------------------------------------
function refreshUi() {
  if (!ui) return;
  const tab = activeTab();
  ui.strip.replaceChildren(
    ...tabs.map((entry) =>
      h(
        `div.term-tab${entry.key === activeKey ? ".active" : ""}`,
        { role: "tab", "aria-selected": entry.key === activeKey ? "true" : "false", onclick: () => { activeKey = entry.key; mountActive(); } },
        icon("terminal", 12),
        h("span", entry.title),
        h("button.term-x", { type: "button", title: t("Close tab"), "aria-label": t("Close tab"), onclick: (event) => { event.stopPropagation(); closeTab(entry.key); } }, icon("x", 11)),
      ),
    ),
    ibtn("plus", t("New terminal"), () => newTab(), { size: 14 }),
    shells.length > 1
      ? ibtn("chevron-down", t("Choose a shell"), (event) => menu(event.currentTarget, shells.map((shell) => ({ label: shell.label, onClick: () => newTab(shell.id) }))), { size: 14 })
      : null,
  );
  if (!tab) return;
  ui.status.replaceChildren(
    icon("folder", 12),
    h("span.term-cwd", { dir: "ltr", title: tab.cwd }, tab.cwd || ""),
    h("span", { style: { flex: 1 } }),
    tab.label ? h("span.badge", { dir: "ltr" }, tab.label) : null,
    tab.running ? h("span.badge.accent", t("running")) : tab.exit ? h(`span.badge.${tab.exit.code === 0 ? "ok" : "danger"}`, tab.exit.code === null || tab.exit.code === undefined ? t("exited") : `${tab.exit.code}`) : null,
  );
  ui.restart.classList.toggle("hidden", tab.running || !(tab.exit || tab.failed));
}

function mountActive() {
  if (!ui) return;
  const tab = activeTab();
  if (!tab) return;
  ui.host.replaceChildren(tab.screen);
  syncStreams();
  refreshUi();
  observer?.disconnect();
  observer = new ResizeObserver(() => requestAnimationFrame(() => { fitTab(tab); }));
  observer.observe(tab.root);
  requestAnimationFrame(() => {
    fitTab(tab);
    tab.term.refresh(0, tab.term.rows - 1);
    tab.term.focus();
    pushSize(tab);
  });
}

function applyTheme() {
  const theme = terminalTheme();
  for (const tab of tabs) tab.term.options.theme = theme;
}

/** Fills `container` with the PTY terminal. `ready` comes from ptyReady(); `switchToBasic` leaves PTY mode. Returns cleanup. */
export function renderPty(container, ready, { switchToBasic } = {}) {
  lib = ready.lib;
  shells = ready.info.shells || [];
  const strip = h("div.term-tabs", { role: "tablist" });
  const host = h("div.term-host.pty-host");
  const status = h("div.term-status");
  const restartBtn = h("button.btn.small.ghost.hidden", { type: "button", onclick: () => { const tab = activeTab(); if (tab) restart(tab); } }, icon("refresh", 13), t("Restart"));
  ui = { strip, host, status, restart: restartBtn };
  container.append(
    h(
      "div.ws-panel.term.pty",
      strip,
      host,
      status,
      h(
        "div.term-tools",
        h("button.btn.small.ghost", { type: "button", onclick: sendToClaude }, icon("sparkles", 13), t("Send output to Claude")),
        h("button.btn.small.ghost", { type: "button", onclick: () => { const tab = activeTab(); if (tab?.term.hasSelection()) { copyText(tab.term.getSelection(), t("Copied")); tab.term.clearSelection(); } else toast(t("Select some text first."), "info", 1800); } }, icon("copy", 13), t("Copy")),
        h("button.btn.small.ghost", { type: "button", onclick: () => { const tab = activeTab(); if (tab) pasteInto(tab); } }, icon("file-plus", 13), t("Paste")),
        h("button.btn.small.ghost", { type: "button", onclick: () => { const tab = activeTab(); if (tab) { tab.term.clear(); tab.term.focus(); } } }, icon("trash", 13), t("Clear")),
        restartBtn,
        switchToBasic ? h("button.btn.small.ghost.pty-switch", { type: "button", title: t("Use the basic line-based terminal"), onclick: switchToBasic }, t("Basic terminal")) : null,
      ),
    ),
  );
  if (!themeWatch) {
    const mql = matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener?.("change", applyTheme);
    themeWatch = new MutationObserver(applyTheme);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    bus.on("prefs", applyTheme);
  }
  if (!tabs.length && !restored) {
    restored = true;
    restoreTabs().then((any) => { if (!any && !tabs.length) newTab(); });
  } else if (!tabs.length) newTab();
  else mountActive();
  return () => {
    ui = null;
    observer?.disconnect();
    observer = null;
    syncStreams();
  };
}

async function restoreTabs() {
  let saved = [];
  try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]"); } catch { /* ignore */ }
  let any = false;
  for (const entry of Array.isArray(saved) ? saved : []) {
    if (!entry?.id || typeof entry.id !== "string") continue;
    try {
      const state = await api.get(`/api/pty/${entry.id}/state`);
      const tab = makeTab({ id: entry.id, title: entry.title, shell: entry.shell, cwd: state.cwd });
      tab.running = state.running;
      tab.label = state.label;
      tab.exit = state.exit;
      activeKey = activeKey || tab.key;
      any = true;
    } catch { /* gone */ }
  }
  persist();
  if (any) mountActive();
  return any;
}
