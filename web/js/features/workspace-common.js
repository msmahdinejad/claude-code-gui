// Shared helpers for the workspace panels (Changes / Files / Terminal): API access, path helpers,
// unified-diff parser + renderer (unified & side-by-side), highlighted line splitting, ANSI renderer.
// This module registers nothing; it is loaded automatically like any feature file.
import { h, toast, errorMessage, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { api } from "../core/api.js";
import { highlight } from "../chat/markdown.js";

export const cwdNow = () => app.currentCwd || app.config?.defaultCwd || "";
export const wsGet = (path, params = {}) => api.get(path, { cwd: cwdNow(), ...params });
export const wsPost = (path, body = {}) => api.post(path, { cwd: cwdNow(), ...body });

export function guarded(promise, { quiet = false } = {}) {
  return promise.catch((error) => {
    if (!quiet) toast(errorMessage(error), "error", 7000);
    return null;
  });
}

// ---- paths ---------------------------------------------------------------------------
const norm = (path) => String(path || "").replace(/\\/g, "/");
const isWin = () => app.config?.platform === "win32";

/** Path relative to the session cwd, or null if outside. Case-insensitive on Windows. */
export function relToCwd(path, cwd = cwdNow()) {
  const p = norm(path);
  const root = norm(cwd).replace(/\/+$/, "");
  if (!root) return p;
  if (!/^([A-Za-z]:)?\//.test(p)) return p.replace(/^\.\//, "");
  const a = isWin() ? p.toLowerCase() : p;
  const b = isWin() ? root.toLowerCase() : root;
  if (a === b) return "";
  if (a.startsWith(`${b}/`)) return p.slice(root.length + 1);
  return null;
}

export const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
export const fileName = (path) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
export const extOf = (path) => (fileName(path).includes(".") ? fileName(path).split(".").pop().toLowerCase() : "");

export function pathLabel(path) {
  const dir = dirOf(path);
  return h("span.ws-path", { dir: "ltr", title: path }, dir ? h("span.ws-dir", dir) : null, h("span.ws-name", fileName(path)));
}

export function formatBytes(n) {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- highlighted code -> lines -------------------------------------------------------
/** Split highlight.js HTML into per-line HTML, re-opening spans that cross line breaks. */
export function splitHighlighted(html) {
  const lines = [];
  let current = "";
  const stack = [];
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { stack.push(m[1]); current += m[1]; }
    else if (m[2]) { stack.pop(); current += m[2]; }
    else if (m[3]) {
      current += "</span>".repeat(stack.length);
      lines.push(current);
      current = stack.join("");
    } else current += m[4];
  }
  current += "</span>".repeat(stack.length);
  lines.push(current);
  return lines;
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);

/** Highlight a whole text and return one html string per line. */
export function highlightLines(text, lang) {
  const html = lang ? highlight(text, lang) : escapeHtml(text);
  return splitHighlighted(html);
}

// ---- unified diff parser -------------------------------------------------------------
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const start = (header) => {
    file = { header, oldPath: "", newPath: "", status: "modified", binary: false, hunks: [], add: 0, del: 0, meta: [] };
    files.push(file);
    hunk = null;
    const match = /^diff --git a\/(.*) b\/(.*)$/.exec(header);
    if (match) { file.oldPath = match[1]; file.newPath = match[2]; }
  };
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("diff --git ")) { start(line); continue; }
    if (!file) {
      if (line.startsWith("--- ") || line.startsWith("@@ ")) start("diff");
      else continue;
    }
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = line.slice(12); }
      else if (line.startsWith("rename to ")) file.newPath = line.slice(10);
      else if (line.startsWith("copy from ")) { file.status = "copied"; file.oldPath = line.slice(10); }
      else if (line.startsWith("similarity index ")) file.similarity = line.slice(17);
      else if (/^(Binary files|GIT binary patch)/.test(line)) { file.binary = true; file.meta.push(line); }
      else if (line.startsWith("--- ")) { if (!file.oldPath || file.oldPath === "/dev/null") file.oldPath = line.slice(4).replace(/^a\//, ""); }
      else if (line.startsWith("+++ ")) { const p = line.slice(4).replace(/^b\//, ""); if (p !== "/dev/null") file.newPath = p; }
      else if (line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode")) file.meta.push(line);
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (header) {
      hunk = { header: line, ctx: header[5] || "", oldStart: Number(header[1]), newStart: Number(header[3]), lines: [] };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === "+") { hunk.lines.push({ t: "add", text: line.slice(1), n: newNo++ }); file.add += 1; }
    else if (c === "-") { hunk.lines.push({ t: "del", text: line.slice(1), o: oldNo++ }); file.del += 1; }
    else if (c === " ") hunk.lines.push({ t: "ctx", text: line.slice(1), o: oldNo++, n: newNo++ });
    else if (c === "\\") hunk.lines.push({ t: "meta", text: line });
  }
  for (const f of files) {
    if (f.status === "modified" && f.oldPath !== f.newPath && f.oldPath && f.newPath) f.status = "renamed";
    if (!f.hunks.length && !f.binary && f.status === "modified" && !f.meta.length) f.empty = true;
  }
  return files;
}

// ---- diff renderer -------------------------------------------------------------------
const GUARD_LINES = 2500;
const HL_LIMIT = 1500;

export function diffStats(files) {
  return files.reduce((sum, file) => ({ add: sum.add + file.add, del: sum.del + file.del }), { add: 0, del: 0 });
}

/**
 * renderDiff(text|files, { mode: 'unified'|'split', wrap, truncated, showFileHeader })
 * Returns a Node. Hunks are collapsible; huge diffs ask before rendering.
 */
export function renderDiff(input, opts = {}) {
  const files = Array.isArray(input) ? input : parseDiff(input);
  const root = h("div.wsd", { dir: "ltr" });
  root.classList.toggle("wrap", Boolean(opts.wrap));
  if (!files.length) {
    root.append(h("div.wsd-empty", t("No textual changes.")));
    return root;
  }
  const total = files.reduce((n, f) => n + f.hunks.reduce((m, hk) => m + hk.lines.length, 0), 0);
  const build = (force) => {
    root.replaceChildren();
    if (total > GUARD_LINES && !force) {
      root.append(h("div.wsd-guard", icon("alert", 14), h("span", t("Large diff ({n} lines). Rendering may be slow.", { n: total })), h("button.btn.small", { type: "button", onclick: () => build(true) }, t("Show anyway"))));
      return;
    }
    const highlightOn = total <= HL_LIMIT;
    for (const file of files) root.append(renderFile(file, { ...opts, highlightOn }));
    if (opts.truncated) root.append(h("div.wsd-guard", icon("alert", 14), t("The diff was truncated because it is too large.")));
  };
  build(false);
  return root;
}

function renderFile(file, opts) {
  const box = h("div.wsd-file");
  const lang = extOf(file.newPath || file.oldPath);
  const label = file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : file.newPath || file.oldPath;
  if (opts.showFileHeader) {
    const body = h("div.wsd-file-body");
    const head = h(
      "button.wsd-file-head",
      { type: "button", onclick: () => { box.classList.toggle("collapsed"); } },
      icon("chevron-down", 13, "wsd-chev"),
      h(`span.ws-badge.st-${file.status}`, statusLetter(file.status)),
      h("span.wsd-file-name", { title: label }, label),
      h("span.ws-counts", file.binary ? t("binary") : [h("span.add", `+${file.add}`), " ", h("span.del", `−${file.del}`)]),
    );
    box.append(head, body);
    fillFile(body, file, lang, opts);
  } else {
    fillFile(box, file, lang, opts);
  }
  return box;
}

const statusLetter = (status) => ({ added: "A", deleted: "D", renamed: "R", copied: "C", modified: "M" })[status] || "M";

function fillFile(container, file, lang, opts) {
  if (file.status === "renamed" && opts.showFileHeader === false) {
    container.append(h("div.wsd-note", icon("file", 13), `${file.oldPath} → ${file.newPath}`, file.similarity ? ` (${file.similarity})` : ""));
  }
  if (file.binary) {
    container.append(h("div.wsd-note", icon("file", 13), t("Binary file changed — no text diff available.")));
    return;
  }
  if (!file.hunks.length) {
    container.append(h("div.wsd-note", file.status === "renamed" ? t("Renamed without content changes.") : t("No content changes (mode or empty file).")));
    return;
  }
  // Highlight old/new sides as a whole per hunk set, so multi-line tokens survive.
  for (const hunk of file.hunks) container.append(renderHunk(hunk, lang, opts));
}

function renderHunk(hunk, lang, opts) {
  const wrap = h("div.wsd-hunk");
  const body = h("div.wsd-hunk-body");
  const head = h(
    "button.wsd-hunk-head",
    { type: "button", onclick: () => wrap.classList.toggle("collapsed") },
    icon("chevron-down", 12, "wsd-chev"),
    h("span.wsd-hunk-range", `@@ -${hunk.oldStart} +${hunk.newStart}`),
    hunk.ctx ? h("span.wsd-hunk-ctx", hunk.ctx) : null,
    h("span.ws-counts", [h("span.add", `+${hunk.lines.filter((l) => l.t === "add").length}`), " ", h("span.del", `−${hunk.lines.filter((l) => l.t === "del").length}`)]),
  );
  wrap.append(head, body);
  // highlight old and new text separately so multi-line constructs are colored consistently
  let oldHtml = null;
  let newHtml = null;
  if (opts.highlightOn && lang) {
    const oldLines = hunk.lines.filter((l) => l.t !== "add" && l.t !== "meta");
    const newLines = hunk.lines.filter((l) => l.t !== "del" && l.t !== "meta");
    oldHtml = highlightLines(oldLines.map((l) => l.text).join("\n"), lang);
    newHtml = highlightLines(newLines.map((l) => l.text).join("\n"), lang);
  }
  let oi = 0;
  let ni = 0;
  for (const line of hunk.lines) {
    if (line.t === "ctx") { line.html = newHtml?.[ni]; oi += 1; ni += 1; }
    else if (line.t === "add") { line.html = newHtml?.[ni]; ni += 1; }
    else if (line.t === "del") { line.html = oldHtml?.[oi]; oi += 1; }
  }
  if (opts.mode === "split") body.append(...splitRows(hunk.lines));
  else body.append(...hunk.lines.map(unifiedRow));
  return wrap;
}

function cell(line) {
  const el = h("span.wsd-text");
  if (line.html !== undefined && line.html !== null) el.innerHTML = line.html || " ";
  else el.textContent = line.text || " ";
  return el;
}

function unifiedRow(line) {
  if (line.t === "meta") return h("div.wsd-row.meta", h("span.wsd-no"), h("span.wsd-no"), h("span.wsd-sign"), h("span.wsd-text", line.text));
  return h(`div.wsd-row.${line.t}`, h("span.wsd-no", line.o ?? ""), h("span.wsd-no", line.n ?? ""), h("span.wsd-sign", line.t === "add" ? "+" : line.t === "del" ? "−" : ""), cell(line));
}

function splitRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.t === "ctx") { rows.push(splitRow(line, line)); i += 1; continue; }
    if (line.t === "meta") { i += 1; continue; }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].t === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) rows.push(splitRow(dels[k], adds[k]));
  }
  return rows;
}

function splitRow(left, right) {
  const side = (line, kind) =>
    line
      ? [h("span.wsd-no", kind === "l" ? line.o ?? "" : line.n ?? ""), h(`span.wsd-half.${line.t}`, cell(line))]
      : [h("span.wsd-no"), h("span.wsd-half.empty", h("span.wsd-text", " "))];
  return h("div.wsd-row.split", ...side(left, "l"), ...side(right, "r"));
}

// ---- ANSI ----------------------------------------------------------------------------
const ANSI_BASE = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf"];
const ANSI_BRIGHT = ["#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

function color256(n) {
  if (n < 8) return ANSI_BASE[n];
  if (n < 16) return ANSI_BRIGHT[n - 8];
  if (n < 232) {
    const v = n - 16;
    const level = (x) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${level(Math.floor(v / 36))},${level(Math.floor((v % 36) / 6))},${level(v % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/** Incremental ANSI/VT text renderer into a container (one div per line, CR overwrite, line cap). */
export class AnsiView {
  constructor(container, { maxLines = 4000 } = {}) {
    this.root = container;
    this.maxLines = maxLines;
    this.style = {};
    this.carry = "";
    this.newLine();
  }

  newLine() {
    this.line = h("div.term-line");
    this.col = 0;
    this.root.append(this.line);
    while (this.root.childElementCount > this.maxLines) this.root.firstElementChild.remove();
  }

  clear() {
    this.root.replaceChildren();
    this.style = {};
    this.carry = "";
    this.newLine();
  }

  applySgr(codes) {
    const s = this.style;
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 0) { for (const key of Object.keys(s)) delete s[key]; }
      else if (c === 1) s.bold = true;
      else if (c === 2) s.dim = true;
      else if (c === 3) s.italic = true;
      else if (c === 4) s.underline = true;
      else if (c === 7) s.inverse = true;
      else if (c === 22) { delete s.bold; delete s.dim; }
      else if (c === 23) delete s.italic;
      else if (c === 24) delete s.underline;
      else if (c === 27) delete s.inverse;
      else if (c >= 30 && c <= 37) s.fg = ANSI_BASE[c - 30];
      else if (c >= 90 && c <= 97) s.fg = ANSI_BRIGHT[c - 90];
      else if (c >= 40 && c <= 47) s.bg = ANSI_BASE[c - 40];
      else if (c >= 100 && c <= 107) s.bg = ANSI_BRIGHT[c - 100];
      else if (c === 39) delete s.fg;
      else if (c === 49) delete s.bg;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) { s[key] = color256(codes[i + 2] ?? 0); i += 2; }
        else if (codes[i + 1] === 2) { s[key] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; i += 4; }
      }
    }
  }

  span(text) {
    if (!text) return;
    const s = this.style;
    if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.inverse) {
      this.line.append(document.createTextNode(text));
    } else {
      const el = h("span", { text });
      const fg = s.inverse ? s.bg || "var(--surface)" : s.fg;
      const bg = s.inverse ? s.fg || "var(--text)" : s.bg;
      if (fg) el.style.color = fg;
      if (bg) el.style.background = bg;
      if (s.bold) el.style.fontWeight = "700";
      if (s.dim) el.style.opacity = ".65";
      if (s.italic) el.style.fontStyle = "italic";
      if (s.underline) el.style.textDecoration = "underline";
      this.line.append(el);
    }
    this.col += text.length;
  }

  write(chunk) {
    let text = this.carry + chunk;
    this.carry = "";
    // A chunk may end between "\r" and "\n": hold the CR so CRLF is never read as "overwrite line".
    const trailing = /\r+$/.exec(text);
    if (trailing) {
      this.carry = trailing[0];
      text = text.slice(0, trailing.index);
    }
    const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r+\n|\r|\n|[^\x1b\r\n]+|\x1b/g;
    let m;
    let last = 0;
    while ((m = re.exec(text))) {
      last = re.lastIndex;
      const token = m[0];
      if (m[2] !== undefined) {
        if (m[2] === "m") this.applySgr((m[1] || "0").split(";").map((n) => Number(n) || 0));
        else if (m[2] === "K" && (m[1] === "" || m[1] === "0" || m[1] === "2")) { if (m[1] === "2") this.line.replaceChildren(); }
      } else if (token === "\n" || /^\r+\n$/.test(token)) this.newLine();
      else if (token === "\r") { this.line.replaceChildren(); this.col = 0; }
      else if (token === "\x1b") { this.carry = text.slice(m.index); break; }
      else if (token.startsWith("\x1b]")) { /* OSC title etc: drop */ }
      else this.span(token);
    }
    if (last < text.length && !this.carry && /\x1b\[[0-9;?]*$/.test(text.slice(last))) this.carry = text.slice(last);
  }

  plainText() {
    return [...this.root.children].map((line) => line.textContent).join("\n");
  }
}

// ---- small UI bits -------------------------------------------------------------------
export function segmented(options, current, onPick) {
  return h("div.seg", options.map(([value, label]) => h(`button${current === value ? ".active" : ""}`, { type: "button", onclick: () => onPick(value) }, label)));
}

export function loadingBox() {
  return h("div.ws-loading", h("span.spinner", { style: { width: "16px", height: "16px" } }), h("span", t("Loading…")));
}

export function errorBox(message, retry) {
  return h("div.banner.error", icon("alert", 14), h("div.banner-text", h("span", { dir: "auto" }, message), retry ? h("button.btn.small", { type: "button", style: { marginInlineStart: "10px" }, onclick: retry }, t("Retry")) : null));
}

export { baseName };
