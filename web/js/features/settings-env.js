// Settings → Environment: settings.env key/value table + documented-variable catalog + read-only gateway environment.
import { h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { registerSettingsSection } from "../core/registry.js";
import { scopedPage, group, getIn, setIn, safeEdit, infoBanner } from "./settings-shared.js";
import { ENV_GROUPS, ENV_VARS, ENV_BY_NAME, isSecretName } from "./interface-env-data.js";
import { pick } from "./interface-ui.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const groupTitle = new Map(ENV_GROUPS.map((entry) => [entry.id, entry.title]));

registerSettingsSection({
  id: "environment",
  title: "Environment",
  icon: "terminal",
  order: 11,
  async render(el) {
    scopedPage(el, {
      title: "Environment",
      lead: "Variables set here are injected into every Claude Code session and its tools (settings.json → env).",
      async render(body, { json, scope }) {
        const rows = new Map(); // name -> row state (the name currently saved in the file)
        let order = Object.entries(getIn(json, "env", {})).map(([key, value]) => [key, String(value)]);
        const table = h("div.env-table");
        const description = h("div.env-desc");
        const datalist = h("datalist", { id: "env-known" }, ENV_VARS.map((entry) => h("option", { value: entry.name, label: pick(entry).slice(0, 80) })));

        const describe = (name) => {
          const entry = ENV_BY_NAME.get(name.trim());
          if (!entry) {
            description.replaceChildren(name.trim() ? h("span.muted", t("Not one of the documented variables; it is passed to Claude Code as written.")) : h("span.muted", t("Pick a name to see what it does. Names containing KEY, TOKEN or SECRET are masked.")));
            return;
          }
          description.replaceChildren(
            h("code", { dir: "ltr" }, entry.name),
            " ",
            h("span.badge", pick(groupTitle.get(entry.group))),
            entry.secret ? h("span.badge.warn", icon("lock", 11), t("secret")) : "",
            h("p", pick(entry)),
          );
        };

        const emptyNote = () => {
          if (!rows.size && !table.querySelector(".rule-empty")) table.append(h("div.muted.rule-empty", t("No variables defined in this scope.")));
        };

        const addRow = ([key, value]) => {
          table.querySelector(".rule-empty")?.remove();
          const row = { key, value };
          const keyInput = h("input.input.mono", { type: "text", value: key, dir: "ltr", spellcheck: "false", list: "env-known", title: ENV_BY_NAME.has(key) ? pick(ENV_BY_NAME.get(key)) : "", "aria-label": t("Name") });
          const valueInput = h("input.input.mono", { type: "text", value, dir: "ltr", spellcheck: "false", autocomplete: "off", "aria-label": t("Value") });
          const error = h("div.env-error");
          let revealed = false;
          const reveal = h("button.icon-btn", { type: "button", onclick: () => { revealed = !revealed; decorate(); } }, icon("eye", 14));
          const gap = h("span.icon-gap");
          const decorate = () => {
            const secret = isSecretName(keyInput.value.trim());
            valueInput.type = secret && !revealed ? "password" : "text";
            reveal.hidden = !secret;
            gap.hidden = secret;
            reveal.title = revealed ? t("Hide value") : t("Reveal value");
            keyInput.title = ENV_BY_NAME.has(keyInput.value.trim()) ? pick(ENV_BY_NAME.get(keyInput.value.trim())) : "";
          };
          const fail = (message) => error.replaceChildren(message ? icon("alert", 12) : "", message || "");
          const commit = async () => {
            const newKey = keyInput.value.trim();
            const newValue = valueInput.value;
            if (newKey === row.key && newValue === row.value) return fail("");
            if (!NAME_RE.test(newKey)) return fail(t("Variable names may contain letters, digits and underscores only."));
            if (newKey !== row.key && rows.has(newKey)) return fail(t("A variable named {name} already exists here. Edit that one or pick another name.", { name: newKey }));
            fail("");
            const saved = await safeEdit(scope, (draft) => {
              const current = getIn(draft, "env", {});
              if (newKey !== row.key && newKey in current) throw new Error(t("A variable named {name} already exists here. Edit that one or pick another name.", { name: newKey }));
              const next = {};
              let placed = false;
              for (const [k, v] of Object.entries(current)) {
                if (k === row.key) {
                  next[newKey] = newValue;
                  placed = true;
                } else next[k] = v;
              }
              if (!placed) next[newKey] = newValue;
              setIn(draft, "env", next);
            });
            if (!saved) return fail(t("Not saved."));
            rows.delete(row.key);
            row.key = newKey;
            row.value = newValue;
            rows.set(newKey, row);
          };
          // Name and value are committed together when focus leaves the row (or on Enter), never between the two fields.
          const wrap = h("div.env-item");
          wrap.addEventListener("focusout", (event) => {
            if (!wrap.contains(event.relatedTarget)) commit();
          });
          for (const input of [keyInput, valueInput]) input.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), commit()));
          keyInput.addEventListener("input", () => { decorate(); describe(keyInput.value); });
          keyInput.addEventListener("focus", () => describe(keyInput.value));
          valueInput.addEventListener("focus", () => describe(keyInput.value));
          wrap.addEventListener("mouseenter", () => describe(keyInput.value));
          const remove = h("button.icon-btn", {
            type: "button",
            title: t("Remove"),
            onclick: async () => {
              const saved = await safeEdit(scope, (draft) => { const next = { ...getIn(draft, "env", {}) }; delete next[row.key]; setIn(draft, "env", next); });
              if (!saved) return;
              rows.delete(row.key);
              wrap.remove();
              emptyNote();
            },
          }, icon("trash", 14));
          wrap.append(h("div.env-row", keyInput, valueInput, reveal, gap, remove), error);
          rows.set(key, row);
          decorate();
          table.append(wrap);
        };

        if (!order.length) emptyNote();
        order.forEach(addRow);
        order = null;

        // ---- add row ----
        const newKey = h("input.input.mono", { type: "text", placeholder: "NAME", dir: "ltr", list: "env-known", spellcheck: "false", "aria-label": t("Name") });
        const newValue = h("input.input.mono", { type: "text", placeholder: t("value"), dir: "ltr", spellcheck: "false", autocomplete: "off", "aria-label": t("Value") });
        const addError = h("div.env-error");
        let addRevealed = false;
        const addReveal = h("button.icon-btn", { type: "button", onclick: () => { addRevealed = !addRevealed; syncAdd(); } }, icon("eye", 14));
        const addGap = h("span.icon-gap");
        const syncAdd = () => {
          const secret = isSecretName(newKey.value.trim());
          newValue.type = secret && !addRevealed ? "password" : "text";
          addReveal.hidden = !secret;
          addGap.hidden = secret;
          addReveal.title = addRevealed ? t("Hide value") : t("Reveal value");
        };
        newKey.addEventListener("input", () => { syncAdd(); describe(newKey.value); });
        newKey.addEventListener("focus", () => describe(newKey.value));
        const add = async () => {
          const key = newKey.value.trim();
          addError.replaceChildren();
          const problem = !NAME_RE.test(key) ? t("Variable names may contain letters, digits and underscores only.") : rows.has(key) ? t("A variable named {name} already exists here. Edit that one or pick another name.", { name: key }) : "";
          if (problem) return addError.replaceChildren(icon("alert", 12), problem);
          const value = newValue.value;
          const saved = await safeEdit(scope, (draft) => {
            if (key in getIn(draft, "env", {})) throw new Error(t("A variable named {name} already exists here. Edit that one or pick another name.", { name: key }));
            setIn(draft, "env", { ...getIn(draft, "env", {}), [key]: value });
          });
          if (!saved) return;
          addRow([key, value]);
          newKey.value = "";
          newValue.value = "";
          syncAdd();
          newKey.focus();
        };
        newValue.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), add()));
        newKey.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), newValue.focus()));
        syncAdd();
        describe("");

        // ---- documented-variable catalog ----
        const search = h("input.input", { type: "search", placeholder: t("Search documented variables"), dir: "auto", "aria-label": t("Search") });
        const catalog = h("div.env-catalog");
        const drawCatalog = () => {
          catalog.replaceChildren();
          const needle = search.value.trim().toLowerCase();
          for (const grp of ENV_GROUPS) {
            const vars = grp.vars.filter((entry) => !needle || entry.name.toLowerCase().includes(needle) || entry.en.toLowerCase().includes(needle) || entry.fa.includes(needle));
            if (!vars.length) continue;
            const details = h("details.env-group", { open: Boolean(needle) }, h("summary", h("strong", pick(grp.title)), h("span.badge", String(vars.length))));
            let filled = false;
            const fill = () => {
              if (filled) return;
              filled = true;
              for (const entry of vars) {
                details.append(
                  h(
                    "div.env-cat-row",
                    h("span.grow", h("code", { dir: "ltr" }, entry.name), entry.secret ? h("span.badge.warn", icon("lock", 11), t("secret")) : null, h("small.muted", pick(entry))),
                    h("button.btn.small.ghost", { type: "button", onclick: () => { newKey.value = entry.name; syncAdd(); describe(entry.name); newValue.focus(); newKey.scrollIntoView({ block: "center" }); } }, icon("plus", 12), t("Use")),
                  ),
                );
              }
            };
            details.addEventListener("toggle", () => details.open && fill());
            if (details.open) fill();
            catalog.append(details);
          }
          if (!catalog.children.length) catalog.append(h("div.muted.rule-empty", t("No documented variable matches.")));
        };
        search.addEventListener("input", drawCatalog);
        drawCatalog();

        body.append(
          group("Variables", datalist, table, h("div.env-row.env-add", newKey, newValue, addReveal, addGap, h("button.btn.small", { type: "button", onclick: add }, icon("plus", 13), t("Add"))), addError, description),
          infoBanner(t("Values are stored in plain text in the settings file. Variables the docs mark as secrets, and names containing KEY, TOKEN or SECRET, are masked here but not encrypted on disk.")),
          group("Documented variables", h("p.muted.small", t("Claude Code's documented environment variables, grouped. “Use” fills the name above; shell-only ones (for example CLAUDE_CONFIG_DIR in project settings) may be ignored in a settings file.")), search, catalog),
        );
      },
    });
    el.append(await gatewayGroup());
  },
});

async function gatewayGroup() {
  const box = group("Gateway environment (read-only)");
  try {
    const { entries } = await api.get("/api/env-info");
    box.append(
      h("p.muted.small", t("These come from how the Wheelhouse server was started (and the active connection profile). Secrets are never sent to the browser.")),
      h(
        "dl.kv.env-info",
        entries.flatMap((entry) => [
          h("dt", { dir: "ltr" }, entry.name),
          h("dd", { dir: "ltr" }, !entry.set ? h("span.muted", t("not set")) : entry.value ? entry.value : h("span.badge.ok", t("set (hidden)"))),
        ]),
      ),
    );
  } catch (error) {
    box.append(h("div.muted", String(error.message || error)));
  }
  return box;
}
