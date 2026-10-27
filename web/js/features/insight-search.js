// In-conversation search (Ctrl+F): highlights matches in the rendered timeline without touching state.
import { h, ibtn, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { bus } from "../core/state.js";
import { registerCommand } from "../core/registry.js";

let bar = null;
let input;
let counter;
let hits = [];
let index = -1;
let observer = null;

// 1:1 character folding so Arabic/Persian letter variants and ZWNJ match what people type.
const FOLD = { "\u064a": "\u06cc", "\u0643": "\u06a9", "\u0629": "\u0647", "\u0623": "\u0627", "\u0625": "\u0627", "\u0622": "\u0627", "\u200c": " ", "\u200e": " ", "\u200f": " " };
const fold = (text) => text.toLowerCase().replace(/[\u064a\u0643\u0629\u0623\u0625\u0622\u200c\u200e\u200f]/g, (ch) => FOLD[ch] || ch);

function root() {
  return document.querySelector(".chat-col");
}

function clearMarks() {
  const host = root();
  if (!host) return;
  const parents = new Set();
  host.querySelectorAll("mark.find-hit").forEach((mark) => {
    parents.add(mark.parentNode);
    mark.replaceWith(document.createTextNode(mark.textContent));
  });
  parents.forEach((parent) => parent?.normalize());
  hits = [];
  index = -1;
}

function collectTextNodes(host) {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,.working,.find-bar,.msg-actions,button,.code-head")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function highlight(keepIndex = false) {
  const previous = index;
  clearMarks();
  const host = root();
  const needle = fold(input.value.trim());
  if (!host || !needle) return updateCounter();
  observer?.disconnect();
  for (const node of collectTextNodes(host)) {
    const text = node.nodeValue;
    const haystack = fold(text);
    let from = 0;
    const ranges = [];
    for (let at = haystack.indexOf(needle, from); at >= 0; at = haystack.indexOf(needle, from)) {
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
    for (const [start, end] of ranges.reverse()) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      try {
        range.surroundContents(mark);
        hits.push(mark);
      } catch { /* range crosses an element boundary: skip */ }
    }
  }
  hits.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  index = hits.length ? (keepIndex && previous >= 0 ? Math.min(previous, hits.length - 1) : hits.length - 1) : -1;
  focusHit(!keepIndex);
  watch();
}

function focusHit(scroll = true) {
  hits.forEach((mark, i) => mark.classList.toggle("current", i === index));
  const mark = hits[index];
  if (mark && scroll) {
    let parent = mark.parentElement;
    while (parent) {
      if (parent.tagName === "DETAILS") parent.open = true;
      parent = parent.parentElement;
    }
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  updateCounter();
}

function updateCounter() {
  if (!counter) return;
  counter.textContent = hits.length ? `${index + 1}/${hits.length}` : input?.value.trim() ? t("No results") : "";
}

function step(delta) {
  if (!hits.length) return;
  index = (index + delta + hits.length) % hits.length;
  focusHit();
}

const rerun = debounce(() => bar && highlight(true), 400);
function watch() {
  const host = root();
  if (!host) return;
  observer ??= new MutationObserver((mutations) => {
    if (mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeName === "MARK" || n.nodeType === 3 && n.parentElement?.closest(".find-hit")))) return;
    rerun();
  });
  observer.observe(host, { childList: true, subtree: true });
}

export function closeSearch() {
  if (!bar) return;
  observer?.disconnect();
  observer = null;
  clearMarks();
  bar.remove();
  bar = null;
}

export function openSearch() {
  const chat = document.querySelector(".chat");
  if (!chat) return;
  if (bar) {
    input.focus();
    input.select();
    return;
  }
  input = h("input.input", { type: "search", placeholder: t("Find in conversation"), "aria-label": t("Find in conversation"), dir: "auto" });
  counter = h("span.find-count.muted");
  input.addEventListener("input", debounce(() => highlight(false), 120));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    else if (event.key === "Escape") { event.stopPropagation(); closeSearch(); }
  });
  bar = h("div.find-bar", { role: "search" }, icon("search", 14), input, counter, ibtn("chevron-up", t("Previous"), () => step(-1), { size: 14 }), ibtn("chevron-down", t("Next"), () => step(1), { size: 14 }), ibtn("x", t("Close"), closeSearch, { size: 14 }));
  chat.append(bar);
  input.focus();
}

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openSearch();
  } else if (event.key === "Escape" && bar && !event.defaultPrevented && !document.querySelector(".modal-backdrop")) {
    closeSearch();
  }
});

bus.on("current", () => { if (bar) { index = -1; highlight(false); } });

registerCommand({ id: "find", title: "Find in conversation", icon: "search", keywords: ["search", "ctrl+f"], shortcut: "Ctrl+F", run: () => openSearch() });
