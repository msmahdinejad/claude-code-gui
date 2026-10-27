// Right (left in RTL) inspector: tabbed side panel fed by registerInspectorTab().
import { h, ibtn, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus, setPrefs } from "../core/state.js";
import { inspectorTabs } from "../core/registry.js";
import { makeCtx } from "../ctx.js";

let root;
let tabsEl;
let bodyEl;
let rendered = null; // { id, cleanup }

export function mountInspector(host) {
  root = host;
  tabsEl = h("div.insp-tabs");
  bodyEl = h("div.insp-body");
  root.replaceChildren(tabsEl, bodyEl);
  bus.on("current", () => document.body.classList.contains("inspector-open") && renderBody(true));
  bus.on("insp:refresh", () => document.body.classList.contains("inspector-open") && renderBody(true));
  bus.on("conv:update", (id) => {
    if (id === app.currentId) renderTabs();
  });
  applyOpen(app.prefs.inspectorOpen);
}

function applyOpen(open) {
  document.body.classList.toggle("inspector-open", open);
  if (open) {
    renderTabs();
    renderBody(true);
  } else {
    rendered?.cleanup?.();
    rendered = null;
  }
  bus.emit("layout");
}

export function toggleInspector(force) {
  const open = force === undefined ? !document.body.classList.contains("inspector-open") : force;
  setPrefs({ inspectorOpen: open });
  applyOpen(open);
}

export function openInspector(tabId) {
  if (tabId) setPrefs({ inspectorTab: tabId });
  setPrefs({ inspectorOpen: true });
  applyOpen(true);
}

function visibleTabs() {
  const ctx = makeCtx();
  return inspectorTabs.filter((tab) => !tab.when || tab.when(ctx));
}

function renderTabs() {
  const tabs = visibleTabs();
  const ctx = makeCtx();
  const scroller = h("div.insp-tabs-scroll");
  scroller.append(
    ...tabs.map((tab) => {
      const badge = tab.badge?.(ctx);
      return h(
        `button.insp-tab${tab.id === app.prefs.inspectorTab ? ".active" : ""}`,
        { type: "button", title: t(tab.title), "aria-label": t(tab.title), onclick: () => { setPrefs({ inspectorTab: tab.id }); renderTabs(); renderBody(true); } },
        icon(tab.icon || "layers", 14),
        h("span", t(tab.title)),
        badge ? h("span.count", String(badge)) : null,
      );
    }),
  );
  tabsEl.replaceChildren(scroller, ibtn("x", t("Close panel"), () => toggleInspector(false), { size: 14, cls: "insp-close" }));
}

function renderBody(force = false) {
  const tabs = visibleTabs();
  const tab = tabs.find((entry) => entry.id === app.prefs.inspectorTab) || tabs[0];
  if (!tab) return clear(bodyEl);
  if (!force && rendered?.id === tab.id) return;
  rendered?.cleanup?.();
  clear(bodyEl);
  const container = h("div.insp-content");
  bodyEl.append(container);
  let cleanup;
  try {
    const result = tab.render(container, makeCtx());
    if (result instanceof Promise) result.then((fn) => { cleanup = typeof fn === "function" ? fn : undefined; rendered = { id: tab.id, cleanup }; }).catch((error) => container.append(h("div.banner.error", String(error.message || error))));
    else cleanup = typeof result === "function" ? result : undefined;
  } catch (error) {
    container.append(h("div.banner.error", String(error.message || error)));
  }
  rendered = { id: tab.id, cleanup };
}
