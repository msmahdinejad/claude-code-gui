// Tiny DOM toolkit: h(), toast, modal, popover, menu. No framework.
import { icon } from "./icons.js";
import { t } from "./i18n.js";

// replaceChildren() would render null/false as the text "null"; make it ignore empties and flatten arrays.
const nativeReplaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function replaceChildren(...nodes) {
  return nativeReplaceChildren.apply(this, nodes.flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false));
};

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** h("div.class#id", {onclick, dataset:{}, style:{}, ...attrs}, ...children) */
export function h(spec, props, ...children) {
  const match = /^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i.exec(spec.replace(/\.+$/, "")); // tolerate `div.modal.${""}`
  const tag = match?.[1] || "div";
  const el = document.createElement(tag);
  if (match?.[2]) {
    for (const part of match[2].match(/[.#][\w-]+/g)) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.classList.add(...String(value).split(/\s+/).filter(Boolean));
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "html") el.innerHTML = value;
    else if (key === "text") el.textContent = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  if (props?.dir === "auto" && (tag === "input" || tag === "textarea")) autoDirection(el);
  append(el, children);
  return el;
}

/** dir="auto" on an empty field resolves to LTR, so placeholders would sit on the wrong side in Persian.
 *  Follow the UI direction while empty and switch to content-based direction once there is text. */
export function autoDirection(el) {
  const update = () => { el.dir = el.value ? "auto" : document.documentElement.dir || "ltr"; };
  el.addEventListener("input", update);
  update();
  queueMicrotask(update);
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function ibtn(name, label, onclick, { size = 16, cls = "" } = {}) {
  return h(`button.icon-btn${cls ? `.${cls}` : ""}`, { type: "button", title: label, "aria-label": label, onclick }, icon(name, size));
}

export function btn(label, onclick, { variant = "", iconName = "", disabled = false, title = "" } = {}) {
  return h(`button.btn${variant ? `.${variant}` : ""}`, { type: "button", onclick, disabled, title: title || undefined }, iconName ? icon(iconName, 14) : null, label ? h("span", label) : null);
}

export function debounce(fn, ms = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function raf(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

// ---- toast ---------------------------------------------------------------------
let toastHost;
export function toast(message, kind = "info", ms = 4200) {
  if (!toastHost) {
    toastHost = h("div.toast-host", { "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const el = h(`div.toast.${kind}`, icon(kind === "error" ? "alert" : kind === "ok" ? "check-circle" : "info", 16), h("span", String(message)));
  toastHost.append(el);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 300);
  return el;
}

export function errorMessage(error) {
  return error?.message || String(error);
}

// ---- modal ---------------------------------------------------------------------
const modalStack = [];
export function modal({ title, body, actions = [], width = 560, onClose, className = "" }) {
  const close = () => {
    const index = modalStack.indexOf(api);
    if (index >= 0) modalStack.splice(index, 1);
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === "Escape" && modalStack.at(-1) === api) {
      event.stopPropagation();
      close();
    }
  };
  const panel = h(
    `div.modal.${className}`,
    { role: "dialog", "aria-modal": "true", "aria-label": title, style: { width: `min(${width}px, calc(100vw - 32px))` } },
    title
      ? h("header.modal-head", h("h2", title), ibtn("x", t("Close"), close))
      : null,
    h("div.modal-body", body),
    actions.length ? h("footer.modal-foot", actions.map((action) => (action instanceof Node ? action : btn(action.label, () => action.onClick?.(api), action)))) : null,
  );
  const backdrop = h("div.modal-backdrop", { onmousedown: (event) => event.target === backdrop && close() }, panel);
  const api = { close, el: panel, backdrop };
  modalStack.push(api);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  queueMicrotask(() => (panel.querySelector("[autofocus]") || panel.querySelector("input,textarea,select,button.primary"))?.focus());
  return api;
}

export function confirmDialog({ title, message, confirmLabel = t("Confirm"), danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dialog = modal({
      title,
      body: h("p.muted", message),
      width: 440,
      onClose: () => done(false),
      actions: [
        { label: t("Cancel"), onClick: (m) => { done(false); m.close(); } },
        { label: confirmLabel, variant: danger ? "danger" : "primary", onClick: (m) => { done(true); m.close(); } },
      ],
    });
    return dialog;
  });
}

export function promptDialog({ title, label = "", value = "", placeholder = "", confirmLabel = t("Save"), multiline = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const input = multiline
      ? h("textarea.input", { rows: 6, placeholder, autofocus: true, dir: "auto" }, value)
      : h("input.input", { type: "text", value, placeholder, autofocus: true, dir: "auto" });
    const submit = (m) => { done(input.value); m.close(); };
    const dialog = modal({
      title,
      width: 460,
      body: h("label.field", label ? h("span", label) : null, input),
      onClose: () => done(null),
      actions: [
        { label: t("Cancel"), onClick: (m) => { done(null); m.close(); } },
        { label: confirmLabel, variant: "primary", onClick: submit },
      ],
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) submit(dialog);
    });
  });
}

// ---- popover / menu ------------------------------------------------------------
let activePopover = null;
export function closePopover() {
  activePopover?.close();
}

/** Anchor a floating panel to an element. Returns {close, el}. */
export function popover(anchor, content, { placement = "bottom-start", width, className = "", onClose, offset = 6 } = {}) {
  closePopover();
  const el = h(`div.popover.${className}`, { role: "dialog" }, content);
  if (width) el.style.width = typeof width === "number" ? `${width}px` : width;
  document.body.append(el);
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const rtl = document.documentElement.dir === "rtl";
    let top = placement.startsWith("top") ? rect.top - box.height - offset : rect.bottom + offset;
    if (top + box.height > innerHeight - 8) top = Math.max(8, rect.top - box.height - offset);
    if (top < 8) top = 8;
    let left;
    if (placement.endsWith("end")) left = rect.right - box.width;
    else left = rect.left;
    if (placement.endsWith("start") && rtl) left = rect.right - box.width;
    left = Math.min(Math.max(8, left), innerWidth - box.width - 8);
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  };
  place();
  requestAnimationFrame(place);
  const outside = (event) => {
    if (!el.contains(event.target) && !anchor.contains(event.target)) api.close();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      api.close();
      anchor.focus?.();
    }
  };
  setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  const api = {
    el,
    place,
    close() {
      if (activePopover === api) activePopover = null;
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      el.remove();
      onClose?.();
    },
  };
  activePopover = api;
  return api;
}

/** items: [{label, icon, onClick, danger, disabled, checked, hint}] | "-" separator | {header} */
export function menu(anchor, items, options = {}) {
  const list = h("div.menu", { role: "menu" });
  let pop;
  for (const item of items) {
    if (!item) continue;
    if (item === "-") {
      list.append(h("div.menu-sep"));
      continue;
    }
    if (item.header) {
      list.append(h("div.menu-header", item.header));
      continue;
    }
    list.append(
      h(
        `button.menu-item${item.danger ? ".danger" : ""}${item.checked ? ".checked" : ""}`,
        {
          type: "button",
          role: "menuitem",
          disabled: item.disabled,
          onclick: () => {
            pop.close();
            item.onClick?.();
          },
        },
        item.icon ? icon(item.icon, 15) : h("span.menu-icon-gap"),
        h("span.menu-label", item.label),
        item.hint ? h("span.menu-hint", item.hint) : null,
        item.checked ? icon("check", 14) : null,
      ),
    );
  }
  pop = popover(anchor, list, { className: "menu-popover", ...options });
  return pop;
}

export function spinner(size = 16) {
  return h("span.spinner", { style: { width: `${size}px`, height: `${size}px` } });
}

export function emptyState(iconName, title, text, action) {
  return h("div.empty", icon(iconName, 28), h("strong", title), text ? h("p", text) : null, action || null);
}

export function copyText(text, label = t("Copied")) {
  return navigator.clipboard.writeText(text).then(() => toast(label, "ok", 1500)).catch(() => toast(t("Copy failed"), "error"));
}

export function formatTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const minute = 60_000;
  if (diff < minute) return t("just now");
  if (diff < 60 * minute) return t("{n}m ago", { n: Math.floor(diff / minute) });
  if (diff < 24 * 60 * minute) return t("{n}h ago", { n: Math.floor(diff / (60 * minute)) });
  if (diff < 7 * 24 * 60 * minute) return t("{n}d ago", { n: Math.floor(diff / (24 * 60 * minute)) });
  return new Date(ms).toLocaleDateString(document.documentElement.lang === "fa" ? "fa-IR" : undefined);
}

export function faDigits(value) {
  return String(value).replace(/d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit]);
}

export function formatNumber(n) {
  if (n === null || n === undefined) return "";
  return new Intl.NumberFormat(document.documentElement.lang === "fa" ? "fa-IR" : undefined).format(n);
}

export function formatTokens(n) {
  if (n === null || n === undefined) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatDuration(ms) {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function formatCost(usd) {
  if (usd === null || usd === undefined) return "";
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

export function shortPath(path, max = 42) {
  if (!path || path.length <= max) return path || "";
  const parts = path.split(/[\\/]/);
  const tail = parts.slice(-2).join("/");
  return `…/${tail}`.slice(-max);
}

export function baseName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || path;
}
