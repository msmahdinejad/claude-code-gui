// Settings dialog shell. Sections come from core/registry.js (registerSettingsSection).
import { h, modal } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";

import { settingsSections } from "../core/registry.js";
import { makeCtx } from "../ctx.js";

let open = null;

export function openSettings(sectionId) {
  if (open) {
    open.select(sectionId);
    return open;
  }
  const nav = h("nav.settings-nav");
  const main = h("div.settings-main");
  let active = null;
  const select = (id) => {
    const section = settingsSections.find((entry) => entry.id === id) || settingsSections[0];
    if (!section) return;
    active = section.id;
    nav.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.dataset.id === active));
    main.replaceChildren();
    try {
      const result = section.render(main, makeCtx());
      if (result instanceof Promise) result.catch((error) => main.append(h("div.banner.error", String(error.message || error))));
    } catch (error) {
      main.append(h("div.banner.error", String(error.message || error)));
    }
  };
  for (const section of settingsSections) {
    nav.append(h("button", { type: "button", dataset: { id: section.id }, onclick: () => select(section.id) }, icon(section.icon || "settings", 16), h("span", t(section.title))));
  }
  const dialog = modal({
    title: t("Settings"),
    width: 980,
    className: "settings-modal",
    body: h("div.settings", nav, main),
    onClose: () => { open = null; },
  });
  dialog.el.querySelector(".modal-body").style.padding = "0";
  open = { dialog, select };
  select(sectionId);
  return open;
}
