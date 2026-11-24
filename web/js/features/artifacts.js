// Inspector tab "Artifacts": the visual deliverables of the project (HTML pages, SVG, Mermaid diagrams, Markdown
// documents) shown beside the conversation, with every version Claude wrote.
//
// How an artifact comes to exist (see docs/FEATURES.md):
//   1. Claude writes one self-contained file to <project>/.wheelhouse/artifacts/ (the system prompt tells it so when
//      Settings → Artifacts is on); revising means editing the same file. The server stores each new content as a version.
//   2. "Open as artifact" on an html / svg / mermaid code block of a reply saves that block as an artifact.
//
// Safety: HTML runs in an iframe sandbox WITHOUT allow-same-origin (an opaque origin: it cannot read the app, its
// storage or call its API) and the server adds a CSP that blocks network requests; SVG is shown as an <img> (no scripts);
// Markdown goes through the chat's DOMPurify renderer; Mermaid renders with securityLevel "strict".
import { h, ibtn, toast, errorMessage, copyText, confirmDialog, menu, formatTime } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus, currentConv, currentLive } from "../core/state.js";
import { api } from "../core/api.js";
import { registerInspectorTab, registerCommand } from "../core/registry.js";
import { renderMarkdown, decorateMarkdown, highlight } from "../chat/markdown.js";
import { cwdNow, segmented, loadingBox, errorBox, formatBytes } from "./workspace-common.js";
import { addToMessage } from "./file-actions.js";

const KIND = {
  html: { icon: "globe", label: () => t("Page"), lang: "html" },
  svg: { icon: "image", label: () => t("Image"), lang: "xml" },
  markdown: { icon: "book", label: () => t("Document"), lang: "markdown" },
  mermaid: { icon: "split", label: () => t("Diagram"), lang: "" },
};
const ARTIFACT_PATH_RE = /(?:^|[\\/])\.wheelhouse[\\/]artifacts[\\/]([^\\/]+\.(?:html?|svg|md|mmd))$/i;
const IFRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

// ---- state (survives the panel being closed and reopened) ------------------------------------
const A = {
  cwd: null,
  items: null, // [{ name, kind, size, mtime, versions }]
  error: "",
  loading: false,
  selected: null, // artifact name
  doc: null, // /api/artifacts/get answer for the selected artifact
  docError: "",
  pinnedVersion: null, // a version the user picked (null = follow the newest)
  mode: "view", // view | source
};
let ui = null; // { list, detail } while the tab is mounted
const seenTools = new Map(); // session id -> Set of tool ids already looked at

const isDark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

const viewUrl = (name, { version, download } = {}) => `/api/artifacts/view?${new URLSearchParams({ cwd: cwdNow(), name, ...(version ? { version: String(version) } : {}), ...(download ? { download: "1" } : {}) })}`;

// ---- Mermaid (lazy: about 3 MB, loaded only when a diagram is shown) -----------------------------
let mermaidPromise = null;
let mermaidTheme = null;
let renderCount = 0;
async function loadMermaid() {
  mermaidPromise ??= import("../../vendor/mermaid/mermaid.esm.min.mjs").then((module) => module.default);
  const mermaid = await mermaidPromise;
  const theme = isDark() ? "dark" : "default";
  if (theme !== mermaidTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "inherit" });
    mermaidTheme = theme;
  }
  return mermaid;
}

/** Render Mermaid source into a host element (the SVG, or the parse error with the source). */
export async function renderMermaidInto(host, source) {
  host.replaceChildren(loadingBox());
  try {
    const mermaid = await loadMermaid();
    renderCount += 1;
    const { svg } = await mermaid.render(`wh-mermaid-${renderCount}`, String(source ?? "").trim());
    host.innerHTML = svg; // produced by Mermaid in strict mode (sanitized, no scripts, no event handlers)
    host.classList.add("art-mermaid");
  } catch (error) {
    document.getElementById(`dwh-mermaid-${renderCount}`)?.remove(); // Mermaid leaves its scratch element behind on errors
    host.replaceChildren(h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, t("This diagram could not be drawn: {error}", { error: String(error?.message || error).split("\n")[0] }))), h("pre.art-source", { dir: "ltr" }, String(source ?? "")));
  }
}

// ---- data ---------------------------------------------------------------------------------------
async function loadList({ quiet = false } = {}) {
  const cwd = cwdNow();
  if (!cwd) return;
  if (!quiet) { A.loading = true; draw(); }
  try {
    const res = await api.get("/api/artifacts", { cwd });
    if (cwd !== cwdNow()) return;
    A.items = res.items || [];
    A.error = "";
  } catch (error) {
    A.error = errorMessage(error);
  }
  A.loading = false;
  draw();
}

async function loadDoc(name, { version = A.pinnedVersion } = {}) {
  const cwd = cwdNow();
  try {
    const doc = await api.get("/api/artifacts/get", { cwd, name, ...(version ? { version } : {}) });
    if (A.selected !== name || cwd !== cwdNow()) return;
    A.doc = doc;
    A.docError = "";
  } catch (error) {
    if (A.selected !== name) return;
    if (version && error.status === 404) { A.pinnedVersion = null; loadDoc(name, { version: null }); return; }
    A.doc = null;
    A.docError = errorMessage(error);
  }
  draw();
}

function select(name, { version = null } = {}) {
  A.selected = name;
  A.pinnedVersion = version;
  A.doc = null;
  A.docError = "";
  A.mode = "view";
  draw();
  loadDoc(name);
}

function back() {
  A.selected = null;
  A.doc = null;
  draw();
  loadList({ quiet: true });
}

/** Open the Artifacts tab on one artifact (file links, tool cards, "Open as artifact"). */
export async function openArtifact(name) {
  const { openInspector } = await import("../ui/inspector.js");
  if (A.cwd !== cwdNow()) reset();
  select(name);
  if (!(document.body.classList.contains("inspector-open") && app.prefs.inspectorTab === "artifacts")) openInspector("artifacts");
  loadList({ quiet: true });
}

// ---- actions ----------------------------------------------------------------------------------
function download(doc) {
  const link = h("a", { href: viewUrl(doc.name, { version: doc.latest ? undefined : doc.version, download: true }), download: doc.name });
  document.body.append(link);
  link.click();
  link.remove();
}

function openInBrowser(doc) {
  const url = new URL(viewUrl(doc.name, { version: doc.latest ? undefined : doc.version }), location.href).href;
  // The standalone window would open its own private browser: hand the address to the browser the user works in.
  if (new URLSearchParams(location.search).has("app")) api.post("/api/open-external", { url }).catch((error) => toast(errorMessage(error), "error"));
  else window.open(url, "_blank", "noopener");
}

function askClaude(doc) {
  addToMessage(`.wheelhouse/artifacts/${doc.name}`, { quiet: true });
  toast(t("Describe the change and send: Claude edits the same file, and the new version shows up here."), "info", 4000);
}

async function restore(doc) {
  try {
    await api.post("/api/artifacts/save", { cwd: cwdNow(), name: doc.name, content: doc.content, overwrite: true, source: "manual" });
    toast(t("Version {n} is the newest version again", { n: doc.version }), "ok", 2200);
    A.pinnedVersion = null;
    loadDoc(doc.name);
    loadList({ quiet: true });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function remove(name) {
  const ok = await confirmDialog({ title: t("Delete artifact?"), message: t("“{name}” and all of its versions will be deleted.", { name }), confirmLabel: t("Delete"), danger: true });
  if (!ok) return;
  try {
    await api.post("/api/artifacts/delete", { cwd: cwdNow(), name });
    if (A.selected === name) { A.selected = null; A.doc = null; }
    loadList();
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

function itemMenu(anchor, item) {
  menu(anchor, [
    { label: t("Open"), icon: "eye", onClick: () => select(item.name) },
    { label: t("Ask Claude to change it"), icon: "message-square", onClick: () => askClaude(item) },
    "-",
    { label: t("Open in browser"), icon: "external", onClick: () => openInBrowser({ ...item, latest: true }) },
    { label: t("Download"), icon: "download", onClick: () => download({ ...item, latest: true }) },
    { label: t("Copy path"), icon: "copy", onClick: () => copyText(`.wheelhouse/artifacts/${item.name}`) },
    "-",
    { label: t("Delete"), icon: "trash", danger: true, onClick: () => remove(item.name) },
  ], { placement: "bottom-end" });
}

// ---- drawing ----------------------------------------------------------------------------------
function draw() {
  if (!ui) return;
  if (A.selected) drawDetail();
  else drawList();
}

function drawList() {
  const body = [];
  if (A.loading && !A.items) body.push(loadingBox());
  else if (A.error) body.push(errorBox(A.error, () => loadList()));
  else if (!A.items?.length) {
    body.push(h(
      "div.empty.art-empty",
      icon("layers", 30),
      h("strong", t("No artifacts yet")),
      h("p", t("Ask Claude for a page, a chart, a diagram or a document. It appears here, beside the conversation, and every revision is kept as a version.")),
      app.config?.artifacts === false ? h("p.muted", t("Artifacts are turned off in Settings → Model & behavior, so Claude is not told about them.")) : null,
    ));
  } else {
    body.push(h("div.art-list", { role: "list" }, A.items.map((item) => {
      const kind = KIND[item.kind] || KIND.html;
      return h(
        "div.art-item",
        { role: "listitem", tabindex: "0", onclick: () => select(item.name), onkeydown: (event) => { if (event.key === "Enter") select(item.name); }, oncontextmenu: (event) => { event.preventDefault(); itemMenu(event.currentTarget, item); } },
        h(`span.art-icon.k-${item.kind}`, icon(kind.icon, 16)),
        h("span.art-main",
          h("span.art-name", { dir: "ltr", title: item.name }, item.name),
          h("span.art-meta", [kind.label(), item.versions > 1 ? t("{n} versions", { n: item.versions }) : null, formatTime(item.mtime)].filter(Boolean).join(" · ")),
        ),
        ibtn("more-horizontal", t("More"), (event) => { event.stopPropagation(); itemMenu(event.currentTarget, item); }, { size: 15 }),
      );
    })));
  }
  ui.root.replaceChildren(
    h("div.art-head", h("strong.grow", t("Artifacts")), ibtn("refresh", t("Refresh"), () => loadList(), { size: 15 })),
    h("div.art-scroll", body),
  );
}

const disabled = (button, off) => { button.disabled = off; return button; };

function versionPicker(doc) {
  const list = doc.versions || [];
  if (list.length < 2) return h("span.art-ver.single", t("v{n}", { n: doc.version }));
  const at = list.findIndex((entry) => entry.n === doc.version);
  const go = (index) => {
    const entry = list[index];
    if (!entry) return;
    A.pinnedVersion = index === list.length - 1 ? null : entry.n;
    loadDoc(doc.name, { version: entry.n });
  };
  const sel = h("select.input.art-ver-select", { "aria-label": t("Version") }, list.map((entry, index) => h("option", { value: String(index), selected: index === at }, `${t("v{n}", { n: entry.n })}${index === list.length - 1 ? ` · ${t("newest")}` : ""} · ${formatTime(entry.mtime)}`)));
  sel.addEventListener("change", () => go(Number(sel.value)));
  // In RTL the "older" arrow points right: the arrows follow reading order, not screen sides.
  const rtl = document.documentElement.dir === "rtl";
  return h("div.art-ver",
    disabled(ibtn(rtl ? "chevron-right" : "chevron-left", t("Older version"), () => go(at - 1), { size: 14 }), at <= 0),
    sel,
    disabled(ibtn(rtl ? "chevron-left" : "chevron-right", t("Newer version"), () => go(at + 1), { size: 14 }), at >= list.length - 1),
  );
}

function drawDetail() {
  const doc = A.doc;
  const kind = KIND[doc?.kind] || KIND.html;
  const head = h(
    "div.art-head",
    ibtn(document.documentElement.dir === "rtl" ? "chevron-right" : "chevron-left", t("All artifacts"), back, { size: 15 }),
    h(`span.art-icon.k-${doc?.kind || "html"}`, icon(kind.icon, 15)),
    h("strong.art-title.grow", { dir: "ltr", title: A.selected }, A.selected),
    doc ? ibtn("more-horizontal", t("More"), (event) => itemMenu(event.currentTarget, { ...doc, name: doc.name }), { size: 15 }) : null,
  );
  if (!doc) {
    ui.root.replaceChildren(head, A.docError ? errorBox(A.docError, () => loadDoc(A.selected)) : loadingBox());
    return;
  }
  const bar = h(
    "div.art-bar",
    versionPicker(doc),
    segmented([["view", t("Preview")], ["source", t("Source")]], A.mode, (mode) => { A.mode = mode; draw(); }),
    h("span.grow"),
    ibtn("copy", t("Copy"), () => copyText(doc.content), { size: 15 }),
    ibtn("download", t("Download"), () => download(doc), { size: 15 }),
    doc.kind === "html" || doc.kind === "svg" ? ibtn("external", t("Open in browser"), () => openInBrowser(doc), { size: 15 }) : null,
    ibtn("message-square", t("Ask Claude to change it"), () => askClaude(doc), { size: 15 }),
  );
  const notes = [];
  if (!doc.latest) notes.push(h("div.banner.info.art-note", icon("history", 14), h("span.grow", t("You are looking at version {n}, not the newest one.", { n: doc.version })), h("button.btn.small", { type: "button", onclick: () => restore(doc) }, t("Make this the newest"))));
  ui.root.replaceChildren(head, bar, ...notes, h("div.art-stage", stage(doc)), h("div.art-foot.muted", `${formatBytes(doc.size)} · ${formatTime(doc.mtime)}`));
}

function stage(doc) {
  if (A.mode === "source") {
    const pre = h("pre.art-source", { dir: "ltr" });
    const lang = KIND[doc.kind]?.lang;
    pre.innerHTML = lang ? highlight(doc.content, lang) : doc.content.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
    return pre;
  }
  const version = doc.latest ? undefined : doc.version;
  if (doc.kind === "html") {
    // No allow-same-origin: the page gets an opaque origin, so it cannot reach the app's storage, cookies or API.
    return h("iframe.art-frame", { src: viewUrl(doc.name, { version }), sandbox: IFRAME_SANDBOX, referrerpolicy: "no-referrer", title: doc.name });
  }
  if (doc.kind === "svg") return h("div.art-image.checker", h("img", { src: viewUrl(doc.name, { version }), alt: doc.name }));
  if (doc.kind === "mermaid") {
    const host = h("div.art-diagram");
    renderMermaidInto(host, doc.content);
    return host;
  }
  const md = decorateMarkdown(h("div.markdown.art-md", { html: renderMarkdown(doc.content) }));
  for (const block of md.querySelectorAll(".code-block code.language-mermaid")) {
    const host = h("div.art-diagram");
    block.closest(".code-block").replaceWith(host);
    renderMermaidInto(host, block.textContent);
  }
  return md;
}

// ---- panel ------------------------------------------------------------------------------------
function reset() {
  A.cwd = cwdNow();
  A.items = null;
  A.error = "";
  A.selected = null;
  A.doc = null;
  A.pinnedVersion = null;
}

function render(container) {
  if (A.cwd !== cwdNow()) reset();
  const root = h("div.art-panel");
  container.append(root);
  ui = { root };
  draw();
  loadList({ quiet: Boolean(A.items) });
  if (A.selected) loadDoc(A.selected);
  return () => { ui = null; };
}

registerInspectorTab({
  id: "artifacts",
  title: "Artifacts",
  icon: "layers",
  order: 22,
  render,
  badge: () => (A.cwd === cwdNow() && A.items?.length ? String(A.items.length) : ""),
});

registerCommand({ id: "artifacts-open", title: "Open artifacts", icon: "layers", keywords: ["artifact", "html", "svg", "mermaid", "diagram", "chart"], run: (ctx) => ctx.openInspector("artifacts") });

// ---- follow Claude's writes -----------------------------------------------------------------------
/** Artifact names written by the finished Write/Edit calls of a conversation that were not looked at yet. */
function newWrites(id, conv) {
  let seen = seenTools.get(id);
  const first = !seen;
  if (!seen) { seen = new Set(); seenTools.set(id, seen); }
  const names = [];
  for (const tool of conv.tools.values()) {
    if (seen.has(tool.id) || tool.status !== "done") continue;
    seen.add(tool.id);
    if (!["Write", "Edit", "MultiEdit"].includes(tool.name)) continue;
    const m = ARTIFACT_PATH_RE.exec(String(tool.input?.file_path || ""));
    if (m && !first) names.push({ name: m[1], created: tool.name === "Write" });
  }
  return names; // the first look at a conversation is its history: nothing in it is new
}

bus.on("conv:update", (id) => {
  if (id !== app.currentId) return;
  const conv = currentConv();
  if (!conv?.tools) return;
  const writes = newWrites(id, conv);
  if (!writes.length) return;
  const last = writes.at(-1);
  const open = document.body.classList.contains("inspector-open") && app.prefs.inspectorTab === "artifacts";
  const working = ["starting", "running", "requires_action"].includes(currentLive()?.state);
  if (open && A.selected === last.name) { A.pinnedVersion = null; loadDoc(last.name); loadList({ quiet: true }); }
  else if (working && (open || app.prefs.artifactsAutoOpen !== false)) openArtifact(last.name);
  else loadList({ quiet: true });
});

bus.on("current", () => {
  if (A.cwd !== cwdNow()) {
    reset();
    if (ui) { draw(); loadList(); }
  }
  const conv = currentConv();
  if (conv?.tools) newWrites(app.currentId, conv); // mark the history as seen
});

bus.on("artifact:open", ({ name } = {}) => { if (name) openArtifact(name); });

// ---- "Open as artifact" on a code block of a reply ---------------------------------------------
const EXT_BY_LANG = { html: "html", svg: "svg", mermaid: "mmd", mmd: "mmd" };

async function sha(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 5)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function openCodeBlock(block) {
  const code = block.querySelector("code");
  const lang = (/language-(\S+)/.exec(code?.className || "")?.[1] || "").toLowerCase();
  const ext = EXT_BY_LANG[lang];
  if (!ext || !code) return;
  const content = code.textContent;
  // The same block always becomes the same artifact (named after its content), so clicking twice opens it again.
  const name = `snippet-${await sha(content)}.${ext}`;
  try {
    const list = await api.get("/api/artifacts", { cwd: cwdNow() });
    if (!(list.items || []).some((item) => item.name === name)) await api.post("/api/artifacts/save", { cwd: cwdNow(), name, content, source: "message" });
    openArtifact(name);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-artifact-open]") : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const block = button.closest(".code-block");
    if (block) openCodeBlock(block);
  }, true);
}
