// Inspector tab "Files": lazy project tree, search, preview (code/markdown/image), editor with Save,
// "Add to chat", and the `open-file` bus event emitted by tool cards.
import { h, ibtn, toast, errorMessage, copyText, debounce, confirmDialog, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { api } from "../core/api.js";
import { registerInspectorTab, registerCommand } from "../core/registry.js";
import { renderMarkdown } from "../chat/markdown.js";
import { wsGet, wsPost, cwdNow, relToCwd, highlightLines, extOf, dirOf, fileName, formatBytes, loadingBox, errorBox, segmented } from "./workspace-common.js";

const DIM = new Set(["node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target", ".cache", "coverage", ".gradle", ".idea"]);
const ICON_BY_EXT = { js: "file-text", mjs: "file-text", ts: "file-text", tsx: "file-text", jsx: "file-text", py: "file-text", json: "file-text", md: "book", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", css: "file-text", html: "globe", yml: "file-text", yaml: "file-text", txt: "file", sh: "terminal", ps1: "terminal" };

const F = {
  cwd: null,
  listings: new Map(), // rel dir -> {entries,total,truncated}|{error}
  expanded: new Set([""]),
  loading: new Set(),
  gitMap: new Map(), // rel path -> code
  filter: "",
  results: null,
  view: "tree", // tree | file
  file: null, // { rel, abs, info, content, dirty, edit, mdPreview, ... }
  pendingOpen: null,
};
let els = null;

// ---- git decorations -------------------------------------------------------------------
async function loadGitMap() {
  try {
    const st = await wsGet("/api/ws/git/status");
    F.gitMap.clear();
    if (st.isRepo) {
      const rootRel = relToCwd(st.root) ?? "";
      const prefix = rootRel ? `${rootRel}/` : "";
      for (const group of [st.untracked, st.unstaged, st.staged, st.conflicts]) {
        for (const item of group) F.gitMap.set(`${prefix}${item.path}`, item.code);
      }
    }
    drawTree();
  } catch { /* not a repo / offline */ }
}

const decoration = (rel, isDir) => {
  if (!isDir) return F.gitMap.get(rel);
  const prefix = `${rel}/`;
  for (const key of F.gitMap.keys()) if (key.startsWith(prefix)) return "·";
  return undefined;
};

// ---- tree ------------------------------------------------------------------------------
async function loadDir(rel) {
  if (F.listings.has(rel) || F.loading.has(rel)) return;
  F.loading.add(rel);
  drawTree();
  try {
    F.listings.set(rel, await wsGet("/api/ws/fs/list", { path: rel || "." }));
  } catch (error) {
    F.listings.set(rel, { error: errorMessage(error), entries: [] });
  }
  F.loading.delete(rel);
  drawTree();
}

function treeRows(rel, depth, out) {
  const listing = F.listings.get(rel);
  if (!listing) return;
  if (listing.error) { out.push(h("div.ws-more", { style: { paddingInlineStart: `${depth * 16 + 12}px` } }, listing.error)); return; }
  for (const entry of listing.entries) {
    const open = entry.dir && F.expanded.has(entry.rel);
    const code = decoration(entry.rel, entry.dir);
    const row = h(
      `div.ws-row.tree${entry.dir && DIM.has(entry.name) ? ".dim" : ""}${F.file?.rel === entry.rel ? ".selected" : ""}`,
      {
        role: "treeitem",
        tabindex: "0",
        "aria-expanded": entry.dir ? String(open) : undefined,
        style: { paddingInlineStart: `${depth * 14 + 8}px` },
        onclick: () => (entry.dir ? toggleDir(entry.rel) : openFile(entry.rel)),
        onkeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); entry.dir ? toggleDir(entry.rel) : openFile(entry.rel); } },
      },
      entry.dir ? icon(open ? "chevron-down" : "chevron-right", 13) : h("span.ws-gap"),
      icon(entry.dir ? (open ? "folder-open" : "folder") : ICON_BY_EXT[extOf(entry.name)] || "file", 14, entry.dir ? "ws-folder" : ""),
      h("span.ws-name.grow", { dir: "ltr", title: entry.rel }, entry.name),
      code ? h(`span.ws-gitmark.g-${code === "?" ? "N" : code}`, { title: code }, code === "?" ? "U" : code) : null,
    );
    out.push(row);
    if (open) {
      if (F.loading.has(entry.rel) && !F.listings.has(entry.rel)) out.push(h("div.ws-more", { style: { paddingInlineStart: `${(depth + 1) * 14 + 8}px` } }, t("Loading…")));
      else treeRows(entry.rel, depth + 1, out);
    }
  }
  if (listing.truncated) out.push(h("div.ws-more", { style: { paddingInlineStart: `${depth * 14 + 8}px` } }, t("Showing the first {n} of {total} entries", { n: listing.entries.length, total: listing.total })));
  if (!listing.entries.length) out.push(h("div.ws-more", { style: { paddingInlineStart: `${depth * 14 + 8}px` } }, t("Empty folder")));
}

function toggleDir(rel) {
  if (F.expanded.has(rel)) F.expanded.delete(rel);
  else { F.expanded.add(rel); loadDir(rel); }
  drawTree();
}

function drawTree() {
  if (!els) return;
  if (F.results) {
    els.tree.replaceChildren(
      ...(F.results.length
        ? F.results.map((file) => h("div.ws-row.tree", { role: "button", tabindex: "0", onclick: () => openFile(file.path), onkeydown: (e) => e.key === "Enter" && openFile(file.path) }, icon(ICON_BY_EXT[extOf(file.path)] || "file", 14), h("span.ws-path", { dir: "ltr", title: file.path }, h("span.ws-dir", dirOf(file.path)), h("span.ws-name", fileName(file.path)))))
        : [h("div.empty", icon("search", 22), h("p", t("No matching files.")))]),
    );
    return;
  }
  const rows = [];
  if (!F.listings.has("") && F.loading.has("")) rows.push(loadingBox());
  else treeRows("", 0, rows);
  els.tree.replaceChildren(...rows);
}

const doSearch = debounce(async () => {
  const q = F.filter.trim();
  if (!q) { F.results = null; drawTree(); return; }
  try {
    F.results = (await api.get("/api/fs/search", { cwd: cwdNow(), q })).files;
  } catch (error) {
    F.results = [];
    toast(errorMessage(error), "error");
  }
  drawTree();
}, 160);

// ---- file view -------------------------------------------------------------------------
async function openFile(target, { line } = {}) {
  if (F.file?.dirty && !(await confirmDialog({ title: t("Discard unsaved changes?"), message: t("“{name}” has unsaved edits.", { name: F.file.rel || fileName(F.file.abs) }), confirmLabel: t("Discard"), danger: true }))) return;
  const rel = relToCwd(target);
  const state = { rel: rel ?? null, abs: target, loading: true, line, edit: false, dirty: false };
  F.file = state;
  F.view = "file";
  drawFile();
  if (rel) revealInTree(rel);
  try {
    const info = await wsGet("/api/ws/fs/read", { path: rel ?? target, max: 1_500_000 });
    if (F.file !== state) return;
    state.loading = false;
    state.info = info;
    state.abs = info.path;
    state.rel = info.inside ? info.rel : null;
    state.content = info.content ?? "";
    state.mdPreview = ["md", "markdown"].includes(extOf(state.abs)) ? true : undefined;
    state.readOnly = !info.inside || info.truncated;
  } catch (error) {
    state.loading = false;
    state.error = errorMessage(error);
  }
  drawFile();
}

function revealInTree(rel) {
  const parts = rel.split("/");
  parts.pop();
  let acc = "";
  F.expanded.add("");
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    F.expanded.add(acc);
    loadDir(acc);
  }
}

function backToTree() {
  F.view = "tree";
  F.file = null;
  draw();
}

async function leaveFile() {
  if (F.file?.dirty && !(await confirmDialog({ title: t("Discard unsaved changes?"), message: t("Your edits will be lost."), confirmLabel: t("Discard"), danger: true }))) return;
  backToTree();
}

async function save({ force = false } = {}) {
  const file = F.file;
  if (!file || !file.edit || !file.info?.inside) return;
  try {
    await wsPost("/api/ws/fs/write", { path: file.rel, content: els.editor.value, expectedMtime: force ? undefined : file.info.mtime });
    file.content = els.editor.value;
    file.dirty = false;
    const fresh = await wsGet("/api/ws/fs/read", { path: file.rel });
    file.info = fresh;
    toast(t("Saved"), "ok", 1500);
    bus.emit("ws:file-saved", { path: file.abs });
    loadGitMap();
    drawFile();
  } catch (error) {
    if (error.status === 409) {
      const overwrite = await confirmDialog({ title: t("File changed on disk"), message: t("The file was modified outside this editor. Overwrite it with your version?"), confirmLabel: t("Overwrite"), danger: true });
      if (overwrite) save({ force: true });
    } else toast(errorMessage(error), "error");
  }
}

function addToChat(file) {
  const path = file.rel ?? file.abs;
  const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  bus.emit("composer:insert", mention);
  const current = document.querySelector(".cmp-input");
  if (current) {
    current.value = `${current.value}${current.value && !/\s$/.test(current.value) ? " " : ""}${mention} `;
    current.dispatchEvent(new Event("input"));
    current.focus();
  }
  toast(t("Added {path} to the message", { path: mention }), "ok", 1800);
}

function drawFile() {
  if (!els) return;
  els.treeWrap.classList.toggle("hidden", F.view !== "tree");
  els.file.classList.toggle("hidden", F.view !== "file");
  const file = F.file;
  els.file.replaceChildren();
  if (!file) return;
  const head = h(
    "div.ws-file-head",
    ibtn("chevron-right", t("Back to files"), () => leaveFile(), { size: 15, cls: "ws-back" }),
    h("div.ws-file-title", h("strong", { dir: "ltr", title: file.abs }, fileName(file.abs || file.rel || "")), h("span.muted", { dir: "ltr" }, [file.rel ? dirOf(file.rel) || "./" : file.abs, file.info ? ` · ${formatBytes(file.info.size)}` : ""])),
    h("span", { style: { flex: 1 } }),
    file.info && file.info.kind === "text"
      ? [
          file.mdPreview !== undefined && !file.edit ? segmented([[true, t("Preview")], [false, t("Source")]], file.mdPreview, (v) => { file.mdPreview = v; drawFile(); }) : null,
          !file.readOnly ? h(`button.btn.small${file.edit ? ".primary" : ""}`, { type: "button", onclick: () => { file.edit = !file.edit; if (!file.edit && file.dirty) { file.dirty = false; } drawFile(); } }, icon("edit", 13), file.edit ? t("Editing") : t("Edit")) : null,
          file.edit ? h("button.btn.small.primary", { type: "button", disabled: !file.dirty, onclick: () => save() }, icon("check", 13), t("Save")) : null,
        ]
      : null,
    ibtn("at", t("Add to chat"), () => addToChat(file), { size: 15 }),
    ibtn("copy", t("Copy path"), () => copyText(file.abs), { size: 15 }),
    ibtn("refresh", t("Reload"), () => openFile(file.abs), { size: 15 }),
  );
  els.file.append(head);
  if (file.readOnly && file.info?.kind === "text") els.file.append(h("div.banner.info", icon("lock", 14), h("span", file.info.truncated ? t("Large file: showing the first part, read-only.") : t("Outside the project folder — read-only."))));
  if (file.loading) { els.file.append(loadingBox()); return; }
  if (file.error) { els.file.append(errorBox(file.error, () => openFile(file.abs))); return; }
  const info = file.info;
  if (info.kind === "image") {
    els.file.append(h("div.ws-image", h("img", { src: `data:${info.mime};base64,${info.base64}`, alt: fileName(file.abs) })));
    return;
  }
  if (info.kind === "binary") {
    els.file.append(h("div.empty", icon("file", 28), h("strong", t("Binary file")), h("p", `${formatBytes(info.size)} — ${t("no preview available.")}`)));
    return;
  }
  if (file.edit) {
    const editor = h("textarea.input.editor.ws-editor", { spellcheck: "false", dir: "ltr", wrap: "off" });
    editor.value = file.content;
    editor.addEventListener("input", () => { file.dirty = editor.value !== file.content; drawFileDirty(); });
    editor.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        const { selectionStart: s, selectionEnd: e } = editor;
        editor.setRangeText("  ", s, e, "end");
        editor.dispatchEvent(new Event("input"));
      }
    });
    els.editor = editor;
    els.file.append(editor);
    queueMicrotask(() => editor.focus());
    return;
  }
  if (file.mdPreview) {
    els.file.append(h("div.markdown.ws-md", { html: renderMarkdown(file.content) }));
    return;
  }
  const lang = extOf(file.abs);
  const lines = file.content.length > 400_000 ? file.content.split("\n").map((l) => l.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])) : highlightLines(file.content, lang);
  const code = h("div.ws-code", { dir: "ltr" });
  const frag = document.createDocumentFragment();
  lines.forEach((html, i) => {
    const row = h("div.ws-cl", { id: `ws-l${i + 1}` }, h("span.ws-ln", String(i + 1)));
    const text = h("span.ws-lt");
    text.innerHTML = html || " ";
    row.append(text);
    frag.append(row);
  });
  code.append(frag);
  els.file.append(code);
  if (file.line) setTimeout(() => { const target = code.querySelector(`#ws-l${file.line}`); target?.classList.add("flash"); target?.scrollIntoView({ block: "center" }); }, 30);
}

function drawFileDirty() {
  const save = els.file.querySelector(".btn.primary[disabled], .btn.primary");
  const buttons = [...els.file.querySelectorAll(".ws-file-head .btn")];
  const saveBtn = buttons.find((b) => b.textContent.trim() === t("Save"));
  if (saveBtn) saveBtn.disabled = !F.file.dirty;
  els.file.querySelector(".ws-file-title strong")?.classList.toggle("dirty", Boolean(F.file.dirty));
  void save;
}

// ---- panel -----------------------------------------------------------------------------
function draw() {
  if (!els) return;
  els.treeWrap.classList.toggle("hidden", F.view !== "tree");
  els.file.classList.toggle("hidden", F.view !== "file");
  if (F.view === "tree") drawTree();
  else drawFile();
}

function reset() {
  F.cwd = cwdNow();
  F.listings.clear();
  F.expanded = new Set([""]);
  F.loading.clear();
  F.gitMap.clear();
  F.filter = "";
  F.results = null;
  F.view = "tree";
  F.file = null;
}

function render(container) {
  if (F.cwd !== cwdNow()) reset();
  const filter = h("input.input", { type: "search", dir: "auto", placeholder: t("Filter files…"), "aria-label": t("Filter files"), value: F.filter });
  filter.addEventListener("input", () => { F.filter = filter.value; doSearch(); });
  filter.addEventListener("keydown", (event) => { if (event.key === "Escape") { filter.value = ""; F.filter = ""; F.results = null; drawTree(); } });
  const tree = h("div.ws-tree", { role: "tree" });
  const treeWrap = h(
    "div.ws-treewrap",
    h("div.ws-head", h("div.ws-filter", icon("search", 14), filter), ibtn("refresh", t("Refresh"), () => { F.listings.clear(); loadDir(""); [...F.expanded].forEach((p) => p && loadDir(p)); loadGitMap(); }, { size: 15 }), ibtn("chevrons-up-down", t("Collapse all"), () => { F.expanded = new Set([""]); drawTree(); }, { size: 15 })),
    h("div.ws-rootline", { dir: "ltr", title: cwdNow() }, icon("folder", 13), h("span", baseName(cwdNow()))),
    tree,
  );
  const fileHost = h("div.ws-fileview.hidden");
  els = { tree, treeWrap, file: fileHost, editor: null };
  container.append(h("div.ws-panel.files", treeWrap, fileHost));
  loadDir("");
  F.expanded.forEach((p) => p && loadDir(p));
  loadGitMap();
  if (F.pendingOpen) { const p = F.pendingOpen; F.pendingOpen = null; openFile(p.path, p); }
  else draw();
  return () => { els = null; };
}

registerInspectorTab({ id: "files", title: "Files", icon: "folder", order: 20, render });

// Tool cards emit `open-file` ({path}); show the Files tab on that file.
bus.on("open-file", async ({ path, line } = {}) => {
  if (!path) return;
  if (document.body.classList.contains("inspector-open") && app.prefs.inspectorTab === "files" && els) {
    openFile(path, { line });
    return;
  }
  F.pendingOpen = { path, line };
  const { openInspector } = await import("../ui/inspector.js");
  openInspector("files");
});
bus.on("current", () => { if (F.cwd !== cwdNow() && els) { reset(); loadDir(""); draw(); } });

registerCommand({ id: "ws-files", title: "Open files", icon: "folder", keywords: ["browse", "tree", "explorer"], run: (ctx) => ctx.openInspector("files") });
