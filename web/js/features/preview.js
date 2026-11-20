// Inspector tab "Preview": view a local dev server (http://localhost:PORT) or a project HTML / PDF file next to the chat.
// Safety: only loopback http origins on another port than Wheelhouse are framed (see core/preview-url.js); project files
// come from /api/preview/file (confined to the project folder, HTML sandboxed by header and by the iframe attribute).
import { h, ibtn, toast, errorMessage, confirmDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { bus } from "../core/state.js";
import { api } from "../core/api.js";
import { registerInspectorTab, registerCommand } from "../core/registry.js";
import { checkPreviewUrl, frameHref, sandboxForUrl, isPreviewFile, SANDBOX_FILE, SANDBOX_FILE_NO_SCRIPTS } from "../core/preview-url.js";
import { AnsiView, cwdNow, segmented } from "./workspace-common.js";

const DEVICES = { desktop: { label: () => t("Desktop"), width: "" }, tablet: { label: () => t("Tablet"), width: "768px" }, phone: { label: () => t("Phone"), width: "375px" } };
const APPROVED_KEY = "wheelhouse-preview-approved";
const START_TIMEOUT_MS = 120_000;

// ---- state (survives the panel being closed and reopened) ------------------------------------
const P = {
  cwd: null,
  stack: [], // navigation entries: { kind: "url", href } | { kind: "file", rel }
  index: -1,
  device: "desktop",
  scripts: false, // HTML files: allow scripts (opt-in)
  info: null, // last /api/preview/configs answer
  infoError: "",
  running: new Set(), // termIds the terminal reports as running
  watching: new Map(), // termId -> timer of "wait until the port opens"
  logFor: null,
  nonce: 0, // bumps on reload so the iframe is rebuilt
};
let ui = null; // { frameHost, input, back, forward, ... } while the tab is mounted
let pollTimer = null;
let logSource = null;
let logView = null;

const ownPort = () => Number(location.port) || (location.protocol === "https:" ? 443 : 80);
const current = () => P.stack[P.index] || null;
const reasonText = {
  empty: () => t("Enter a local address such as http://localhost:3000."),
  scheme: () => t("Only http:// addresses on this computer can be previewed."),
  credentials: () => t("Addresses with a user name or password are not allowed."),
  host: () => t("Only localhost, 127.0.0.1 and [::1] can be previewed. Use \"Open in browser\" for other sites."),
  port: () => t("That port number is not valid."),
  "own-port": () => t("That is Wheelhouse itself. Enter the port of your app."),
  invalid: () => t("That is not a valid address."),
};
const explain = (reason) => (reasonText[reason] || reasonText.invalid)();

// ---- navigation ------------------------------------------------------------------------------
function visit(entry, { replace = false } = {}) {
  const cur = current();
  if (cur && cur.kind === entry.kind && (cur.href || cur.rel) === (entry.href || entry.rel)) {
    P.nonce += 1; // same page again = reload
  } else if (replace && cur) {
    P.stack[P.index] = entry;
  } else {
    P.stack.splice(P.index + 1, P.stack.length, entry);
    P.index = P.stack.length - 1;
  }
  draw();
}

/** Returns an error message, or "" when the address was accepted. */
function openAddress(text) {
  if (isPreviewFile(text)) {
    visit({ kind: "file", rel: text.trim().replace(/\\/g, "/").replace(/^\.\//, "") });
    return "";
  }
  const checked = checkPreviewUrl(text, ownPort());
  if (!checked.ok) return explain(checked.reason);
  visit({ kind: "url", href: checked.url });
  return "";
}

const goBack = () => { if (P.index > 0) { P.index -= 1; draw(); } };
const goForward = () => { if (P.index < P.stack.length - 1) { P.index += 1; draw(); } };
const reload = () => { if (current()) { P.nonce += 1; draw(); } };

function openExternally() {
  const entry = current();
  if (entry?.kind !== "url") return;
  api.post("/api/open-external", { url: entry.href }).catch((error) => toast(errorMessage(error), "error"));
}

// ---- iframe ----------------------------------------------------------------------------------
function buildFrame(entry) {
  const common = { referrerpolicy: "no-referrer", title: t("Preview"), class: "pv-frame" };
  if (entry.kind === "url") {
    const checked = checkPreviewUrl(entry.href, ownPort()); // checked again right before framing, never trusted from state
    if (!checked.ok) return h("div.pv-empty", icon("alert", 16), h("p", explain(checked.reason)));
    const framed = checkPreviewUrl(frameHref(checked), ownPort()); // [::1] is framed as localhost (CSP cannot name IPv6)
    if (!framed.ok) return h("div.pv-empty", icon("alert", 16), h("p", explain(framed.reason)));
    return h("iframe", { ...common, sandbox: sandboxForUrl(framed), src: framed.url });
  }
  const isPdf = /\.pdf$/i.test(entry.rel);
  const src = `/api/preview/file?${new URLSearchParams({ cwd: cwdNow(), path: entry.rel, ...(!isPdf && P.scripts ? { scripts: "1" } : {}) })}`;
  // Chrome's PDF viewer does not run in a sandboxed frame; the PDF response itself is locked down by the server.
  if (isPdf) return h("iframe", { ...common, src });
  return h("iframe", { ...common, sandbox: P.scripts ? SANDBOX_FILE : SANDBOX_FILE_NO_SCRIPTS, src }); // never allow-same-origin
}

function draw() {
  if (!ui) return;
  const entry = current();
  ui.error.classList.add("hidden"); // a stale message must not outlive the navigation it was about
  ui.back.disabled = P.index <= 0;
  ui.forward.disabled = P.index >= P.stack.length - 1;
  ui.reload.disabled = !entry;
  ui.external.disabled = entry?.kind !== "url";
  ui.input.value = entry ? (entry.kind === "url" ? entry.href : entry.rel) : ui.input.value;
  ui.scripts.classList.toggle("hidden", !(entry?.kind === "file" && /\.html?$/i.test(entry.rel)));
  ui.scriptsBox.checked = P.scripts;
  ui.device.replaceChildren(segmented(Object.entries(DEVICES).map(([key, value]) => [key, value.label()]), P.device, (key) => { P.device = key; draw(); }));
  ui.wrap.style.width = DEVICES[P.device].width || "";
  ui.wrap.classList.toggle("pv-narrow", P.device !== "desktop");
  ui.frameHost.classList.toggle("has-page", Boolean(entry));
  ui.wrap.replaceChildren(entry ? buildFrame(entry) : h("div.pv-empty", icon("eye", 22), h("p", t("Enter a local address, start a dev server below, or open a project HTML or PDF file."))));
  ui.note.classList.toggle("hidden", entry?.kind !== "url");
}

// ---- dev servers -----------------------------------------------------------------------------
const approved = () => { try { return new Set(JSON.parse(localStorage.getItem(APPROVED_KEY) || "[]")); } catch { return new Set(); } };
const remember = (key) => { try { const set = approved(); set.add(key); localStorage.setItem(APPROVED_KEY, JSON.stringify([...set].slice(-100))); } catch { /* ignore */ } };

async function refresh({ quiet = true } = {}) {
  const cwd = cwdNow();
  if (!cwd) return;
  try {
    const info = await api.get("/api/preview/configs", { cwd });
    if (cwd !== cwdNow()) return;
    P.info = info;
    P.infoError = "";
    const states = await Promise.all(info.configs.filter((cfg) => !cfg.error).map((cfg) => api.get(`/api/term/${cfg.termId}/state`).then((state) => [cfg.termId, state.running]).catch(() => [cfg.termId, false])));
    P.running = new Set(states.filter(([, running]) => running).map(([id]) => id));
  } catch (error) {
    P.infoError = errorMessage(error);
    if (!quiet) toast(P.infoError, "error");
  }
  drawServers();
}

async function start(cfg) {
  const key = `${P.info?.root}|${cfg.command}`;
  if (!approved().has(key)) {
    const ok = await confirmDialog({
      title: t("Start this dev server?"),
      message: t("This runs the command from the project's .claude/launch.json in the project folder, with your privileges: {command}", { command: cfg.command }),
      confirmLabel: t("Start"),
    });
    if (!ok) return;
    remember(key);
  }
  try {
    await api.post("/api/term/run", { id: cfg.termId, cwd: cfg.cwd, command: cfg.command });
  } catch (error) {
    return toast(errorMessage(error), "error");
  }
  P.running.add(cfg.termId);
  P.logFor = cfg.termId;
  attachLog();
  drawServers();
  watchPort(cfg);
}

/** Wait until the configuration's port accepts connections, then show it in the iframe. */
function watchPort(cfg) {
  clearInterval(P.watching.get(cfg.termId));
  const began = Date.now();
  const timer = setInterval(async () => {
    try {
      const state = await api.get(`/api/term/${cfg.termId}/state`);
      if (!state.running) { stopWatching(cfg.termId); refresh(); return toast(t("{name} stopped before its port opened. See the output below.", { name: cfg.name }), "error"); }
      const probe = await api.post("/api/preview/probe", { port: cfg.port, cwd: P.info?.root || cwdNow() });
      if (probe.listening) {
        stopWatching(cfg.termId);
        const error = openAddress(`http://localhost:${cfg.port}`);
        if (error) toast(error, "error");
        refresh();
      } else if (Date.now() - began > START_TIMEOUT_MS) {
        stopWatching(cfg.termId);
        toast(t("{name} did not open port {port} in time.", { name: cfg.name, port: cfg.port }), "error");
      }
    } catch { /* server restarting: keep trying until the timeout */ }
  }, 800);
  P.watching.set(cfg.termId, timer);
}

function stopWatching(id) {
  clearInterval(P.watching.get(id));
  P.watching.delete(id);
}

async function stop(cfg) {
  stopWatching(cfg.termId);
  await api.post("/api/term/stop", { id: cfg.termId }).catch((error) => toast(errorMessage(error), "error"));
  setTimeout(refresh, 700);
}

function closeLog() {
  logSource?.close();
  logSource = null;
  logView = null;
}

/** Output of the selected dev server (the terminal runner's SSE stream, replayed from the start). One stream at a time. */
function attachLog() {
  closeLog();
  if (!ui || !P.logFor) return;
  const root = h("div.term-out.pv-log", { dir: "ltr", role: "log", "aria-live": "off", tabindex: "0" });
  ui.log.replaceChildren(root);
  logView = new AnsiView(root, { maxLines: 2000 });
  const view = logView;
  const source = new EventSource(`/api/term/${P.logFor}/stream?after=0`);
  logSource = source;
  const write = (event, fn) => source.addEventListener(event, (message) => { if (logView === view) fn(JSON.parse(message.data)); });
  write("start", (data) => view.write(`\x1b[1;36m>\x1b[0m ${String(data.command).replace(/\n/g, "\n> ")}\n`));
  write("out", (data) => {
    view.write(data.stream === "stderr" ? `\x1b[31m${data.text}\x1b[0m` : data.text);
    root.scrollTop = root.scrollHeight;
  });
  write("exit", (data) => { view.write(`\n\x1b[2m[${data.stopped ? t("stopped") : data.code === 0 ? t("done") : t("exit code {code}", { code: data.code })}]\x1b[0m\n`); refresh(); });
}

function drawServers() {
  if (!ui) return;
  const info = P.info;
  const rows = [];
  if (P.infoError) rows.push(h("div.pv-hint.error", icon("alert", 13), h("span", P.infoError)));
  else if (info) {
    if (info.error) rows.push(h("div.pv-hint.error", icon("alert", 13), h("span", { dir: "auto" }, `${t("launch.json problem:")} ${info.error}`)));
    for (const cfg of info.configs) {
      if (cfg.error) {
        rows.push(h("div.pv-server.bad", h("div.pv-server-main", h("span.pv-server-name", { dir: "auto" }, cfg.name), h("span.pv-server-cmd", { dir: "auto" }, cfg.error))));
        continue;
      }
      const running = P.running.has(cfg.termId);
      const starting = P.watching.has(cfg.termId);
      const status = running ? (cfg.listening ? "ok" : "accent") : cfg.listening ? "warn" : "";
      const label = running ? (cfg.listening ? t("running") : t("starting…")) : cfg.listening ? t("port in use") : t("stopped");
      rows.push(
        h(
          "div.pv-server",
          h(
            "div.pv-server-main",
            h("span.pv-server-name", { dir: "auto" }, cfg.name),
            h("span.pv-server-cmd", { dir: "ltr", title: cfg.command }, `${cfg.command}${cfg.cwdRel ? `  (${cfg.cwdRel})` : ""}`),
          ),
          h(`span.badge${status ? `.${status}` : ""}`, `:${cfg.port} ${label}`),
          h(
            "div.pv-server-actions",
            running || starting
              ? h("button.btn.small.danger", { type: "button", onclick: () => stop(cfg) }, icon("stop", 12), t("Stop"))
              : cfg.listening
                ? null
                : h("button.btn.small.primary", { type: "button", onclick: () => start(cfg) }, icon("play", 12), t("Start")),
            cfg.listening ? h("button.btn.small", { type: "button", onclick: () => { const error = openAddress(`http://localhost:${cfg.port}`); if (error) toast(error, "error"); } }, icon("eye", 12), t("Open")) : null,
            h("button.btn.small.ghost", { type: "button", onclick: () => { P.logFor = P.logFor === cfg.termId ? null : cfg.termId; attachLog(); drawServers(); } }, icon("terminal", 12), t("Output")),
          ),
        ),
      );
    }
    if (!info.configs.length && !info.error) {
      rows.push(h("div.pv-hint", icon("info", 13), h("span", info.exists ? t("launch.json has no configurations.") : t("No .claude/launch.json in this project. Add one to start a dev server from here, or enter the address of a server you already run."))));
    }
  } else rows.push(h("div.ws-loading", h("span.spinner", { style: { width: "14px", height: "14px" } }), h("span", t("Loading…"))));

  const chips = [];
  for (const port of info?.suggested || []) {
    chips.push(h("button.pv-chip", { type: "button", title: t("Something is listening on this port"), onclick: () => { const error = openAddress(`http://localhost:${port}`); if (error) toast(error, "error"); } }, icon("zap", 12), `localhost:${port}`));
  }
  const files = (info?.files || []).map((rel) => h("button.pv-chip", { type: "button", dir: "ltr", onclick: () => visit({ kind: "file", rel }) }, icon(/\.pdf$/i.test(rel) ? "file" : "file-text", 12), rel));

  ui.servers.replaceChildren(
    h("div.pv-section-head", h("span", t("Dev servers")), h("span", { style: { flex: 1 } }), ibtn("refresh", t("Refresh"), () => refresh({ quiet: false }), { size: 14 })),
    ...rows,
    chips.length ? h("div.pv-section-head.small", t("Listening now")) : null,
    chips.length ? h("div.pv-chips", chips) : null,
    files.length ? h("div.pv-section-head.small", t("Project files")) : null,
    files.length ? h("div.pv-chips", files) : null,
  );
  if (P.logFor) {
    ui.logWrap.classList.remove("hidden");
    if (!logSource) attachLog();
  } else {
    ui.logWrap.classList.add("hidden");
    closeLog();
  }
}

// ---- panel -----------------------------------------------------------------------------------
function render(container) {
  if (P.cwd !== cwdNow()) { // another project: file entries and server state belong to the old folder
    P.cwd = cwdNow();
    P.stack = [];
    P.index = -1;
    P.info = null;
    P.running = new Set();
  }
  const input = h("input.input.pv-input", { type: "text", dir: "ltr", spellcheck: "false", autocomplete: "off", placeholder: t("http://localhost:3000 or a project .html / .pdf file"), "aria-label": t("Preview address") });
  const error = h("div.pv-error.hidden", { role: "alert" });
  const back = ibtn("chevron-left", t("Back"), goBack, { size: 15 });
  const forward = ibtn("chevron-right", t("Forward"), goForward, { size: 15 });
  const reloadBtn = ibtn("refresh", t("Reload"), reload, { size: 15 });
  const external = ibtn("external", t("Open in browser"), openExternally, { size: 15 });
  const submit = () => {
    const message = openAddress(input.value);
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); } });
  const scriptsBox = h("input", { type: "checkbox", onchange: (event) => { P.scripts = event.target.checked; if (current()?.kind === "file") draw(); } });
  const scripts = h("label.pv-check.hidden", { title: t("Let the page run its own scripts (it still cannot reach Wheelhouse)") }, scriptsBox, h("span", t("Allow scripts")));
  const device = h("div.pv-device");
  const wrap = h("div.pv-wrap");
  const frameHost = h("div.pv-stage", wrap);
  const note = h(
    "div.pv-note.hidden",
    icon("info", 13),
    h("span", t("Sites that send X-Frame-Options or frame-ancestors cannot be shown here; if the page stays blank, open it in your browser.")),
    h("button.btn.small.ghost", { type: "button", onclick: openExternally }, icon("external", 12), t("Open in browser")),
  );
  const servers = h("div.pv-servers");
  const log = h("div.pv-log-host");
  const logWrap = h("div.pv-logwrap.hidden", h("div.pv-section-head.small", t("Dev server output")), log);
  ui = { error, input, back, forward, reload: reloadBtn, external, scripts, scriptsBox, device, wrap, frameHost, note, servers, log, logWrap };

  container.append(
    h(
      "div.ws-panel.pv",
      h("div.pv-bar", back, forward, reloadBtn, input, h("button.btn.small.primary", { type: "button", onclick: submit }, t("Open")), external),
      error,
      h("div.pv-sub", device, scripts),
      note,
      frameHost,
      h("div.pv-lower", servers, logWrap),
    ),
  );
  draw();
  drawServers();
  refresh();
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  return () => {
    ui = null;
    clearInterval(pollTimer);
    pollTimer = null;
    closeLog();
  };
}

registerInspectorTab({
  id: "preview",
  title: "Preview",
  icon: "eye",
  order: 35,
  render,
  badge: () => (P.running.size ? "●" : ""),
});

// Other features can ask for a page: bus.emit("preview:open", { url } | { file }).
bus.on("preview:open", ({ url, file } = {}) => {
  const error = file ? (visit({ kind: "file", rel: String(file) }), "") : openAddress(String(url || ""));
  if (error) toast(error, "error");
});

bus.on("current", () => {
  if (P.cwd && P.cwd !== cwdNow()) {
    P.cwd = cwdNow();
    P.stack = [];
    P.index = -1;
    P.info = null;
    P.running = new Set();
    P.logFor = null;
    closeLog();
    draw();
    refresh();
  }
});

registerCommand({ id: "preview-open", title: "Open preview", icon: "eye", keywords: ["browser", "localhost", "dev server", "html", "pdf"], run: (ctx) => ctx.openInspector("preview") });

