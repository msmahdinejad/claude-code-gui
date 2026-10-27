// Settings → Output styles: choose the active style, manage custom style files.
import { h, toast, errorMessage } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";
import * as session from "../session.js";
import { registerSettingsSection } from "../core/registry.js";
import { group, settingRow, pageHeader, editScope, getIn, setIn, loadScope, infoBanner } from "./settings-shared.js";
import { resourcePanel } from "./settings-resources.js";

const TEMPLATE = (name) => `---
name: ${name}
description: Describe how Claude should answer in this style
keep-coding-instructions: true
---

You are an interactive CLI tool that helps users with software engineering tasks.

## Style
-
`;

const BUILTIN_DESC = {
  default: () => t("Claude's standard behavior for software engineering tasks."),
  Explanatory: () => t("Explains implementation choices and codebase patterns as it works."),
  Learning: () => t("Collaborative: asks you to write small pieces and teaches along the way."),
  Proactive: () => t("Takes initiative and keeps going without waiting for confirmation."),
};

registerSettingsSection({
  id: "output-styles",
  title: "Output styles",
  icon: "wand",
  order: 14,
  async render(el, ctx) {
    el.append(...pageHeader("Output styles", "An output style changes the system prompt to adjust tone and working method, without changing the tools."));
    const activeHost = h("div");
    const customHost = h("div.group");
    el.append(activeHost, customHost);
    let customScope = "user";

    async function persisted() {
      const found = {};
      for (const scope of ["user", "project", "local"]) {
        try { found[scope] = getIn((await loadScope(scope)).json || {}, "outputStyle", ""); } catch { found[scope] = ""; }
      }
      return found;
    }

    async function draw() {
      const catalog = app.catalog || (await session.ensureCatalog());
      const styles = (catalog?.availableOutputStyles || []).map((entry) => (typeof entry === "string" ? { name: entry } : { name: entry.name || entry.id || String(entry), description: entry.description }));
      if (!styles.some((style) => style.name === "default")) styles.unshift({ name: "default" });
      const live = app.live.get(app.currentId);
      const current = live?.init?.output_style || catalog?.outputStyle || "default";
      const saved = await persisted();
      const scopeSelect = h("select.input", ["user", "local", "project"].map((scope) => h("option", { value: scope }, scope === "user" ? t("User") : scope === "local" ? t("Local") : t("Project"))));
      scopeSelect.value = saved.local ? "local" : saved.project ? "project" : "user";
      const rows = styles.map((style) => {
        const active = style.name === current;
        return h(
          "div.list-row",
          icon(active ? "check-circle" : "circle", 16),
          h("div.grow", h("strong", style.name), h("span.muted", style.description || BUILTIN_DESC[style.name]?.() || t("Custom style"))),
          active ? h("span.badge.ok", t("active")) : h("button.btn.small", { type: "button", onclick: () => select(style.name, scopeSelect.value) }, t("Use")),
        );
      });
      activeHost.replaceChildren(
        group(
          "Active style",
          h("div.rule-list", rows),
          settingRow(t("Remember in"), t("Where the choice is saved. It also applies to the open session immediately."), scopeSelect),
          h("div.rule-actions", h("button.btn.small", { type: "button", onclick: reload }, icon("refresh", 13), t("Reload styles from disk"))),
          Object.values(saved).some(Boolean) ? infoBanner(t("Saved choices: user={u} · project={p} · local={l}", { u: saved.user || "—", p: saved.project || "—", l: saved.local || "—" })) : null,
        ),
      );
    }

    async function select(name, scope) {
      try {
        await editScope(scope, (draft) => setIn(draft, "outputStyle", name === "default" ? undefined : name), { quiet: true });
        if (app.live.get(app.currentId)?.alive) await api.control(app.currentId, "applyFlagSettings", { settings: { outputStyle: name } }).catch(() => {});
        toast(t("Output style set to {name}", { name }), "ok", 1800);
        await session.ensureCatalog(app.currentCwd, true);
        await draw();
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }

    async function reload() {
      try {
        if (app.live.get(app.currentId)?.alive) await api.control(app.currentId, "reloadOutputStyles");
        await session.ensureCatalog(app.currentCwd, true);
        await draw();
        await drawCustom();
        toast(t("Reloaded"), "ok", 1400);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }

    async function drawCustom() {
      const host = h("div");
      customHost.replaceChildren(
        h("h3", t("Custom styles")),
        h("div.seg", ["user", "project"].map((scope) => h(`button${scope === customScope ? ".active" : ""}`, { type: "button", onclick: () => { customScope = scope; drawCustom(); } }, scope === "user" ? t("User") : t("Project")))),
        host,
      );
      await resourcePanel(host, { kind: "output-styles", scope: customScope, template: TEMPLATE, emptyText: t("No custom output styles in this scope.") });
    }

    await draw();
    await drawCustom();
  },
});
