// File links everywhere: every path Claude mentions (answers, tool cards, diffs, lists) is a link that shows the file name,
// opens the file beside the conversation (the Files tab) and has a right-click menu (open in the editor / default app,
// show in the folder, copy path, copy as @mention...).
//
// Markup contract (used by the chat, the tool cards, the Files tree and the Changes list):
//   [data-file-path="…"]       clickable: a click opens the file beside the chat (optional data-file-line, data-file-abs)
//   [data-file-menu-path="…"]  right-click menu only (rows that already have their own click behaviour)
import { h, menu, toast, errorMessage, copyText } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { api } from "../core/api.js";
import { findPathsInText, parsePathRef, hrefToRef, isFileHref, linkLabel, mentionFor, baseNameOf, dirNameOf } from "../core/file-path.js";
import { cwdNow, relToCwd } from "./workspace-common.js";

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
/** Show a file beside the conversation (the Files tab of the side panel). */
export function openFileRef(ref) {
  if (!ref?.path) return;
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

function addToMessage(path) {
  const mention = mentionFor(path);
  bus.emit("composer:insert", mention);
  const input = document.querySelector(".cmp-input");
  if (input) {
    input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? " " : ""}${mention} `;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }
  toast(t("Added {path} to the message", { path: mention }), "ok", 1800);
}

/** The items of the right-click menu for a file (also used by the "…" button of the file viewer). */
export async function fileMenuItems(ref) {
  const info = await resolveOne(ref.path);
  const abs = info.abs || absoluteOf(ref.path);
  const rel = info.exists ? info.rel : relToCwd(abs);
  const here = { ...ref, abs: info.exists ? info.abs : ref.abs };
  const missing = !info.exists;
  const name = baseNameOf(abs);
  return [
    missing ? { header: t("File not found") } : null,
    { label: t("Open beside the chat"), icon: "panel-right", disabled: missing, onClick: () => openFileRef(here) },
    { label: t("Open in editor"), icon: "edit", disabled: missing || info.dir, onClick: () => systemOpen(here, "editor") },
    { label: t("Open in default app"), icon: "external", disabled: missing, onClick: () => systemOpen(here, "default") },
    { label: revealLabel(), icon: "folder-open", disabled: missing, onClick: () => systemOpen(here, "reveal") },
    "-",
    { label: t("Copy path"), icon: "copy", onClick: () => copyText(abs) },
    rel ? { label: t("Copy relative path"), icon: "copy", onClick: () => copyText(rel) } : null,
    { label: t("Copy file name"), icon: "copy", onClick: () => copyText(name) },
    ref.line ? { label: t("Copy path with line"), icon: "copy", onClick: () => copyText(`${abs}:${ref.line}`) } : null,
    "-",
    { label: t("Copy as @mention"), icon: "at", onClick: () => copyText(mentionFor(rel ?? abs)) },
    { label: t("Add to message"), icon: "at", onClick: () => addToMessage(rel ?? abs) },
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
  resolvePaths(asked).then(() => { if (root.isConnected) apply(root); });
}

/** A markdown box (assistant text, a subagent's report, a plan) with its file paths linked. */
export function markdownNode(el) {
  queueMicrotask(() => linkifyFiles(el));
  return el;
}

// ---- delegated events -----------------------------------------------------------------------
if (typeof document !== "undefined") {
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
