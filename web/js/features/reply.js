// Reply by selection: select text in the conversation and a small "Reply" button appears next to it; clicking it puts
// the selection into the composer as a quote. (The per-message Reply buttons live in chat/view.js.)
import { h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { bus } from "../core/state.js";

let button = null;

function hide() {
  button?.remove();
  button = null;
}

function selectedText() {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const node = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
  if (!node?.closest(".chat-col") || node.closest("textarea, input")) return null;
  return { text, rect: selection.getRangeAt(0).getBoundingClientRect() };
}

function show() {
  const picked = selectedText();
  hide();
  if (!picked) return;
  button = h(
    "button.reply-pop",
    {
      type: "button",
      onmousedown: (event) => event.preventDefault(), // keep the selection while clicking
      onclick: () => {
        bus.emit("composer:quote", picked.text);
        getSelection()?.removeAllRanges();
        hide();
      },
    },
    icon("reply", 13, "mirror-rtl"),
    h("span", t("Reply")),
  );
  document.body.append(button);
  const width = button.offsetWidth || 80;
  const above = picked.rect.top > 52;
  button.style.top = `${above ? picked.rect.top - 40 : picked.rect.bottom + 8}px`;
  button.style.left = `${Math.min(Math.max(8, picked.rect.left + picked.rect.width / 2 - width / 2), innerWidth - width - 8)}px`;
}

document.addEventListener("mouseup", () => setTimeout(show, 0));
document.addEventListener("keyup", (event) => { if (event.shiftKey || event.key.startsWith("Arrow")) setTimeout(show, 0); });
document.addEventListener("selectionchange", () => { if (getSelection()?.isCollapsed) hide(); });
addEventListener("scroll", hide, true);
addEventListener("resize", hide);
