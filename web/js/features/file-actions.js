// File links everywhere, like Claude Desktop: every path Claude mentions (answers, markdown links, tool cards, lists) is a
// link that shows the file name and opens the file beside the conversation: HTML and PDF of the project in the Preview tab
// (Desktop's Browser pane), artifacts in the Artifacts tab, everything else in the Files tab (view, edit, save). A right
// click shows Claude Desktop's file menu: Attach as context, Open in (editor), Show in Explorer/Finder, Copy (absolute
// path, relative path, file name); plus "Open beside the chat" and "Open in default app" (documents and media only).
//
// Markup contract (used by the chat, the tool cards, the Files tree and the Changes list):
//   [data-file-path="…"]       clickable: a click opens the file beside the chat (optional data-file-line, data-file-abs)
//   [data-file-menu-path="…"]  right-click menu only (rows that already have their own click behaviour)
import { h, menu, toast, errorMessage, copyText } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { api } from "../core/api.js";
import { findPathsInText, parsePathRef, hrefToRef, isFileHref, linkLabel, mentionFor, baseNameOf, dirNameOf, SAFE_OPEN_EXT } from "../core/file-path.js";
import { cwdNow, relToCwd } from "./workspace-common.js";
import { onMarkdownRendered } from "../chat/markdown.js";

export { isFileHref, hrefToRef };

// ---- existence checks (which mentioned paths are real files) -----------------------------
const FOUND_MS = 120_000;
const MISSING_MS = 8_000;
const cache = new Map(); // `${cwd}\n${path}` -> { at, info }
const inflight = new Map(); // key -> Promise<info>
const keyOf = (path) => `${cwdNow()}\n${path}`;

function fresh(path) {
  const hit = cache.get(keyOf(path));
  if (!hit) return null;
  return Date.now() - hit.at < (hit.info.exists ? FOUND_MS : MISSING_MS) ? hit.info : null;
}

/** Ask the server which of these paths exist (batched, cached). Resolves with { path: info }. */
export async function resolvePaths(paths) {
  const out = {};
  const need = [];
  for (const path of new Set(paths)) {
    const known = fresh(path);
    if (known) out[path] = known;
    else if (inflight.has(keyOf(path))) need.push(path);
    else need.push(path);
  }
  const todo = need.filter((path) => !inflight.has(keyOf(path)));
  const cwd = cwdNow();
  if (todo.length && cwd) {
    const request = api.post("/api/ws/fs/resolve", { cwd, paths: todo }).then((res) => res.results || {}, () => ({}));
    for (const path of todo) {
      inflight.set(`${cwd}\n${path}`, request.then((results) => {
        const info = results[path] || { exists: false };
        cache.set(`${cwd}\n${path}`, { at: Date.now(), info });
        inflight.delete(`${cwd}\n${path}`);
        return info;
      }));
    }
  }
  await Promise.all(need.map(async (path) => { out[path] = await inflight.get(keyOf(path)) ?? fresh(path) ?? { exists: false }; }));
  return out;
}

const resolveOne = async (path) => (await resolvePaths([path]))[path] || { exists: false };

// ---- opening -------------------------------------------------------------------------
const ARTIFACT_RE = /(?:^|[\\/])\.wheelhouse[\\/]artifacts[\\/]([^\\/]+\.(?:html?|svg|md|mmd))$/i;
const PREVIEW_RE = /\.(html?|pdf)$/i;

const insideCwd = (path) => { const rel = relToCwd(absoluteOf(path)); return rel !== null && !rel.startsWith("../"); };

/** Where a click on a file link goes: "artifact" (Artifacts tab), "preview" (HTML/PDF of the project) or "files". */
export function fileTarget(ref, info = {}) {
  const path = ref?.abs || ref?.path || "";
  if (ARTIFACT_RE.test(path)) return "artifact";
  if (PREVIEW_RE.test(path) && !ref?.line && (info.inside ?? insideCwd(path))) return "preview";
  return "files";
}

/** Show a file beside the conversation: the Artifacts, Preview or Files tab of the side panel. */
export async function openFileRef(ref, { plain = false } = {}) {
  if (!ref?.path) return;
  const target = plain ? "files" : fileTarget(ref);
  if (target === "artifact") {
    bus.emit("artifact:open", { name: ARTIFACT_RE.exec(ref.abs || ref.path)[1] });
    return;
  }
  if (target === "preview") {
    const rel = relToCwd(absoluteOf(ref.abs || ref.path));
    if (rel && !rel.startsWith("../")) {
      const { openInspector } = await import("../ui/inspector.js");
      openInspector("preview");
      bus.emit("preview:open", { file: rel });
      return;
    }
  }
  bus.emit("open-file", { path: ref.abs || ref.path, line: ref.line });
}

const sepOf = () => (app.config?.platform === "win32" ? "\\" : "/");
const isAbsolutePath = (path) => /^([A-Za-z]:[\\/]|[\\/])/.test(path);

/** The absolute form of a path as Claude wrote it (relative ones are relative to the session folder). */
export function absoluteOf(path) {
  if (isAbsolutePath(path)) return path;
  const cwd = cwdNow().replace(/[\\/]+$/, "");
  const sep = sepOf();
  return `${cwd}${sep}${path.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep)}`;
}

async function systemOpen(ref, action) {
  try {
    await api.post("/api/ws/fs/open", { cwd: cwdNow(), path: ref.abs || ref.path, action, line: ref.line });
  } catch (error) {
    toast(errorMessage(error), "error", 6000);
  }
}

const revealLabel = () => (app.config?.platform === "win32" ? t("Show in File Explorer") : app.config?.platform === "darwin" ? t("Show in Finder") : t("Show in folder"));

/** Put an @mention of a file into the message box (Claude Desktop's "Attach as context"). */
export function addToMessage(path, { quiet = false } = {}) {
  const mention = mentionFor(path);
  const input = document.querySelector(".cmp-input");
  if (input) {
    input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? " " : ""}${mention} `;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }
  if (!quiet) toast(t("Added {path} to the message", { path: mention }), "ok", 1800);
}

/** The items of the right-click menu for a file (also used by the "…" button of the file viewer). */
export async function fileMenuItems(ref) {
  const info = await resolveOne(ref.path);
  const abs = info.abs || absoluteOf(ref.path);
  const rel = info.exists ? info.rel : relToCwd(abs);
  const here = { ...ref, abs: info.exists ? info.abs : ref.abs };
  const missing = !info.exists;
  const name = baseNameOf(abs);
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const target = fileTarget(here, info);
  // Claude Desktop's menu (Attach as context, Open in, Show in Explorer/Finder, Copy ▸ Absolute path / Relative path /
  // Filename) with the side-panel actions first; Desktop's "Copy" submenu is a labelled group here.
  return [
    missing ? { header: t("File not found") } : null,
    { label: target === "artifact" ? t("Open in Artifacts") : target === "preview" ? t("Open in Preview") : t("Open beside the chat"), icon: target === "files" ? "panel-right" : "eye", disabled: missing, onClick: () => openFileRef(here) },
    target !== "files" ? { label: t("View source"), icon: "file-text", disabled: missing, onClick: () => openFileRef(here, { plain: true }) } : null,
    { label: t("Attach as context"), icon: "at", disabled: missing, onClick: () => addToMessage(rel ?? abs) },
    "-",
    { label: t("Open in editor"), icon: "edit", disabled: missing || info.dir, onClick: () => systemOpen(here, "editor") },
    SAFE_OPEN_EXT.has(ext) || info.dir ? { label: t("Open in default app"), icon: "external", disabled: missing, onClick: () => systemOpen(here, "default") } : null,
    { label: revealLabel(), icon: "folder-open", disabled: missing, onClick: () => systemOpen(here, "reveal") },
    "-",
    { header: t("Copy") },
    { label: t("Absolute path"), icon: "copy", onClick: () => copyText(ref.line ? `${abs}:${ref.line}` : abs) },
    rel ? { label: t("Relative path"), icon: "copy", onClick: () => copyText(ref.line ? `${rel}:${ref.line}` : rel) } : null,
    { label: t("File name"), icon: "copy", onClick: () => copyText(name) },
  ].filter(Boolean);
}

/** Open the file menu at a point (a right click) or under an element (the "…" button). */
export async function showFileMenu(target, ref) {
  let anchor = target;
  let temporary = null;
  if (!(target instanceof Element)) {
    temporary = h("div", { style: { position: "fixed", left: `${target.clientX}px`, top: `${target.clientY}px`, width: "1px", height: "1px", pointerEvents: "none" } });
    document.body.append(temporary);
    anchor = temporary;
  }
  const items = await fileMenuItems(ref);
  menu(anchor, items, { placement: "bottom-start", onClose: () => temporary?.remove() });
}

// ---- link elements ---------------------------------------------------------------------
const refOf = (el) => {
  const path = el.dataset.filePath ?? el.dataset.fileMenuPath;
  if (!path) return null;
  return { path, abs: el.dataset.fileAbs || undefined, line: el.dataset.fileLine ? Number(el.dataset.fileLine) : undefined };
};

const dataFor = ({ path, abs, line }) => ({ filePath: path, ...(abs ? { fileAbs: abs } : {}), ...(line ? { fileLine: String(line) } : {}) });

/** A link (a span: it may sit inside a button) that shows the file name. */
export function fileSpan(path, { line, abs, label, cls = "" } = {}) {
  return h(`span.file-link${cls ? `.${cls}` : ""}`, { role: "link", tabindex: "0", dir: "ltr", title: abs || path, dataset: dataFor({ path, abs, line }) }, label ?? linkLabel({ path, line }));
}

/** A chip with a file icon and the file name (tool cards, lists). */
export function fileChip(path, { line, abs, extra = "" } = {}) {
  return h("button.file-chip", { type: "button", title: abs || path, dataset: dataFor({ path, abs, line }) }, icon("file", 13), h("span", linkLabel({ path, line }) + extra));
}

// ---- turning mentioned paths in rendered markdown into links -------------------------------
const SKIP_TEXT = "pre, code, a, button, .file-link, script, style, textarea, .md-table-wrap thead";

function makeLink(ref, info, text) {
  const link = h("a.file-link", { href: "#", dir: "ltr", title: info.abs || ref.path, dataset: dataFor({ path: info.rel ?? ref.path, abs: info.abs, line: ref.line }) }, text);
  return link;
}

function apply(root) {
  let pending = false;
  const asked = [];
  // markdown links to files ("[label](src/a.ts#L3)"): chat/markdown.js marks them with data-file-href
  for (const link of root.querySelectorAll("a[data-file-href]:not([data-file-path])")) {
    link.removeAttribute("target");
    const ref = hrefToRef(link.dataset.fileHref);
    if (!ref) continue;
    const info = fresh(ref.path);
    if (!info) { asked.push(ref.path); continue; }
    if (!info.exists) { link.classList.add("file-missing"); link.title = t("File not found"); continue; }
    link.classList.add("file-link");
    link.title = info.abs;
    Object.assign(link.dataset, dataFor({ path: info.rel ?? ref.path, abs: info.abs, line: ref.line }));
  }
  // inline `code`: the whole text is one path
  for (const code of root.querySelectorAll("code")) {
    if (code.closest("pre, a, .file-link")) continue;
    const ref = parsePathRef(code.textContent, { bare: true });
    if (!ref) continue;
    const info = fresh(ref.path);
    if (!info) { asked.push(ref.path); continue; }
    if (!info.exists || info.dir) continue;
    code.classList.add("file-link");
    code.setAttribute("tabindex", "0");
    code.setAttribute("role", "link");
    code.setAttribute("title", info.abs);
    code.setAttribute("dir", "ltr");
    Object.assign(code.dataset, dataFor({ path: info.rel ?? ref.path, abs: info.abs, line: ref.line }));
    code.textContent = linkLabel(ref);
  }
  // running text: paths with a folder part and an extension
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeValue.length > 2 && !node.parentElement?.closest(SKIP_TEXT) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const matches = findPathsInText(node.nodeValue);
    if (!matches.length) continue;
    let rest = node;
    let consumed = 0;
    for (const match of matches) {
      const info = fresh(match.path);
      if (!info) { asked.push(match.path); continue; }
      if (!info.exists || info.dir) continue;
      const start = match.start - consumed;
      const tail = rest.splitText(start); // rest keeps the text before the match
      const after = tail.splitText(match.end - match.start);
      tail.replaceWith(makeLink(match, info, linkLabel(match)));
      rest = after;
      consumed = match.end;
      pending = true;
    }
  }
  return { asked, changed: pending };
}

/**
 * Make the file paths in a rendered markdown block clickable. Paths whose existence is not known yet are asked from the
 * server once (not while the answer is still streaming: half-typed paths would only cause useless requests).
 */
export function linkifyFiles(root, { streaming = false } = {}) {
  if (!root || !cwdNow()) return;
  const { asked } = apply(root);
  if (streaming || !asked.length) return;
  resolvePaths(asked).then(() => apply(root));
}

/** A markdown box (assistant text, a subagent's report, a plan) with its file paths linked. */
export function markdownNode(el) {
  queueMicrotask(() => linkifyFiles(el));
  return el;
}

// ---- delegated events -----------------------------------------------------------------------
onMarkdownRendered((el, { streaming } = {}) => linkifyFiles(el, { streaming }));

if (typeof document !== "undefined") {
  // A markdown link to a file that does not exist (or is not resolved yet) must not open the app again in a new tab.
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[data-file-href]:not([data-file-path])") : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    toast(t("File not found"), "info", 1800);
  }, true);

  const closestFile = (event, selector) => (event.target instanceof Element ? event.target.closest(selector) : null);

  document.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    const el = closestFile(event, "[data-file-path]");
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const ref = refOf(el);
    if (!ref) return;
    if (event.ctrlKey || event.metaKey) systemOpen(ref, "editor");
    else openFileRef(ref);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const el = closestFile(event, "[data-file-path][tabindex]");
    if (!el || el.tagName === "BUTTON") return;
    event.preventDefault();
    event.stopPropagation();
    const ref = refOf(el);
    if (ref) openFileRef(ref);
  }, true);

  document.addEventListener("contextmenu", (event) => {
    const el = closestFile(event, "[data-file-path], [data-file-menu-path]");
    if (!el) return;
    const ref = refOf(el);
    if (!ref) return;
    event.preventDefault();
    event.stopPropagation();
    showFileMenu(event, ref);
  }, true);

  bus.on("current", () => { cache.clear(); });
}

export { dirNameOf, baseNameOf };
