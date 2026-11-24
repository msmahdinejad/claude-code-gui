// A small code editor for the Files tab: a plain <textarea> (native undo, selection, IME, spell-check off) laid over a
// syntax-highlighted copy of its text, with line numbers. No library: highlight.js is already vendored for the chat.
// Very large texts skip the highlighting (it would make typing slow) and stay a plain, fast textarea.
import { h } from "../core/dom.js";
import { highlight } from "../chat/markdown.js";

const HIGHLIGHT_MAX = 200_000; // characters
const INDENT = "  ";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);

/**
 * createCodeEditor({ value, lang, onChange(value), onSave() }) -> { el, textarea, focus(), setSelection(start, end, scrollTop), goToLine(n) }
 */
export function createCodeEditor({ value = "", lang = "", onChange, onSave, label } = {}) {
  const textarea = h("textarea.ce-input", { spellcheck: "false", autocapitalize: "off", autocomplete: "off", dir: "ltr", wrap: "off", "aria-label": label || "Editor" });
  textarea.value = value;
  const code = h("code.hljs");
  const layer = h("pre.ce-layer", { "aria-hidden": "true" }, code);
  const numbers = h("div.ce-numbers", { "aria-hidden": "true" });
  const gutter = h("div.ce-gutter", numbers);
  const main = h("div.ce-main", layer, textarea);
  const el = h("div.ce", { dir: "ltr" }, gutter, main);

  let lineCount = 0;
  let frame = 0;
  const plain = () => textarea.value.length > HIGHLIGHT_MAX;

  function paintNumbers() {
    const count = textarea.value.split("\n").length;
    if (count === lineCount) return;
    lineCount = count;
    numbers.textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n");
  }

  function paint() {
    frame = 0;
    el.classList.toggle("plain", plain());
    // The trailing newline keeps the last (empty) line as tall as the textarea's.
    if (!plain()) code.innerHTML = `${lang ? highlight(textarea.value, lang) : escapeHtml(textarea.value)}\n`;
    else code.textContent = "";
    paintNumbers();
    sync();
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

  function sync() {
    layer.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    numbers.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }

  /** Replace the selection with `text` through the browser's editing commands, so Ctrl+Z still undoes it. */
  function insert(text) {
    if (!document.execCommand?.("insertText", false, text)) textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function lineStartOf(index) {
    return textarea.value.lastIndexOf("\n", index - 1) + 1;
  }

  /** Indent or outdent every line the selection touches. */
  function shiftLines(outdent) {
    const { selectionStart: start, selectionEnd: end, value: text } = textarea;
    const from = lineStartOf(start);
    const to = end > start && text[end - 1] === "\n" ? end - 1 : end;
    const block = text.slice(from, to);
    const lines = block.split("\n");
    const changed = lines.map((line) => (outdent ? line.replace(new RegExp(`^( {1,${INDENT.length}}|\\t)`), "") : INDENT + line)).join("\n");
    if (changed === block) return;
    textarea.setSelectionRange(from, to);
    insert(changed);
    textarea.setSelectionRange(from, from + changed.length);
  }

  textarea.addEventListener("input", () => { schedule(); onChange?.(textarea.value); });
  textarea.addEventListener("scroll", sync, { passive: true });
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave?.();
      return;
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const multi = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).includes("\n");
      if (event.shiftKey || multi) shiftLines(event.shiftKey);
      else insert(INDENT);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      // Keep the indentation of the current line.
      const start = lineStartOf(textarea.selectionStart);
      const indent = /^[ \t]*/.exec(textarea.value.slice(start, textarea.selectionStart))[0];
      if (!indent) return;
      event.preventDefault();
      insert(`\n${indent}`);
    }
  });

  paint();
  return {
    el,
    textarea,
    focus: () => textarea.focus({ preventScroll: true }),
    setSelection(start, end, scrollTop) {
      textarea.setSelectionRange(start, end);
      if (scrollTop !== undefined) textarea.scrollTop = scrollTop;
      sync();
    },
    goToLine(line) {
      const lines = textarea.value.split("\n");
      const n = Math.min(Math.max(1, line), lines.length);
      const start = lines.slice(0, n - 1).reduce((sum, text) => sum + text.length + 1, 0);
      textarea.setSelectionRange(start, start + lines[n - 1].length);
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
      textarea.scrollTop = Math.max(0, (n - 1) * lineHeight - textarea.clientHeight / 2);
      sync();
    },
  };
}
