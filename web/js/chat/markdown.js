// Markdown -> sanitized HTML with syntax highlighting and per-block RTL/LTR direction.
import { Marked, DOMPurify, hljs } from "../../vendor/md.js";
import { t } from "../core/i18n.js";
import { isFileHref } from "../core/file-path.js";

// Fenced code blocks of these languages get an "Open as artifact" button (see features/artifacts.js).
const ARTIFACT_LANGS = new Set(["html", "svg", "mermaid", "mmd"]);

// Features decorate rendered markdown (file links, ...): decorateMarkdown(el, { streaming }) runs every hook on it.
const markdownHooks = [];
export function onMarkdownRendered(fn) { markdownHooks.push(fn); }
export function decorateMarkdown(el, options = {}) {
  for (const fn of markdownHooks) {
    try { fn(el, options); } catch { /* a decoration must never break the message */ }
  }
  return el;
}

const RTL_RE = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/gu;
const LTR_LETTER = /[A-Za-zÀ-ɏЀ-ӿ]/g;
const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TD", "TH", "DT", "DD", "SUMMARY", "UL", "OL"]);

/** Visible prose of a node for direction detection: inline code, code blocks and nested lists do not count. */
function proseOf(node) {
  const copy = node.cloneNode(true);
  copy.querySelectorAll("code, pre, .code-block").forEach((el) => el.remove());
  if (node.tagName !== "UL" && node.tagName !== "OL") copy.querySelectorAll("ul, ol").forEach((el) => el.remove());
  return copy.textContent;
}

/** Direction of a text block: whichever script has more letters (Persian prose with English terms stays RTL,
 *  an English sentence quoting one Persian word stays LTR). Ties follow the first strong letter. */
export function textDirection(text) {
  const value = String(text || "");
  if (!RTL_RE.test(value)) return "ltr";
  const rtl = (value.match(RTL_LETTER) || []).length;
  const ltr = (value.match(LTR_LETTER) || []).length;
  if (rtl !== ltr) return rtl > ltr ? "rtl" : "ltr";
  return RTL_RE.test(value.match(/[\p{L}]/u)?.[0] || "") ? "rtl" : "ltr";
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);

export function highlight(code, lang) {
  const name = (lang || "").toLowerCase();
  try {
    if (name && hljs.getLanguage(name)) return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch { /* fall through */ }
  return escapeHtml(code);
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang || "").split(/\s+/)[0];
      return (
        `<div class="code-block" dir="ltr"><div class="code-head"><span class="code-lang">${escapeHtml(language || "text")}</span>` +
        (ARTIFACT_LANGS.has(language.toLowerCase()) ? `<button class="copy-code" type="button" data-artifact-open>${escapeHtml(t("Open as artifact"))}</button>` : "") +
        `<button class="copy-code" type="button" data-copy-code>${escapeHtml(t("Copy"))}</button></div>` +
        `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${highlight(text, language)}</code></pre></div>`
      );
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safe = /^(https?:|mailto:|#)/i.test(href) ? href : "#";
      // A link to a file ("[a.ts](src/a.ts#L3)", "file:///D:/x.md"): features/file-actions.js turns it into a file link.
      if (safe === "#" && isFileHref(href)) return `<a href="#" data-file-href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`;
      return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ""} target="_blank" rel="noreferrer noopener">${label}</a>`;
    },
  },
});

// Wrap tables for horizontal scroll, mark direction on text blocks.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  }
  if (BLOCK_TAGS.has(node.tagName) && !node.getAttribute("dir")) {
    node.setAttribute("dir", textDirection(proseOf(node)));
  }
});

const PURIFY = {
  ADD_ATTR: ["target", "data-copy-code", "data-artifact-open", "data-file-href"],
  ADD_TAGS: ["button"],
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
};

export function renderMarkdown(source) {
  const raw = marked.parse(String(source ?? ""), { async: false });
  const clean = DOMPurify.sanitize(raw, PURIFY);
  return clean.replace(/<table/g, '<div class="md-table-wrap"><table').replace(/<\/table>/g, "</table></div>");
}

/** Attach once on a container: copy buttons inside rendered markdown. */
export function wireMarkdownActions(container, copyFn) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-copy-code]");
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("code")?.textContent || "";
    copyFn(code);
    button.textContent = "✓";
    setTimeout(() => (button.textContent = t("Copy")), 1200);
  });
}
