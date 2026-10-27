// Settings → Environment: settings.env key/value table + read-only gateway environment.
import { h, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { registerSettingsSection } from "../core/registry.js";
import { scopedPage, group, getIn, setIn, infoBanner } from "./settings-shared.js";

const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|HEADERS)/i;
const KNOWN = [
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "DISABLE_TELEMETRY", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
];

registerSettingsSection({
  id: "environment",
  title: "Environment",
  icon: "terminal",
  order: 11,
  async render(el) {
    scopedPage(el, {
      title: "Environment",
      lead: "Variables set here are injected into every Claude Code session and its tools (settings.json → env).",
      async render(body, { json, edit }) {
        const env = getIn(json, "env", {});
        const entries = Object.entries(env);
        const revealed = new Set();
        const table = h("div.env-table");
        const datalist = h("datalist", { id: "env-known" }, KNOWN.map((name) => h("option", { value: name })));

        const draw = () => {
          table.replaceChildren();
          if (!entries.length) table.append(h("div.muted.rule-empty", t("No variables defined in this scope.")));
          entries.forEach(([key, value], index) => {
            const secret = SECRET_RE.test(key);
            const show = !secret || revealed.has(key);
            const valueInput = h("input.input.mono", { type: show ? "text" : "password", value: String(value), dir: "ltr", spellcheck: "false", autocomplete: "off" });
            const keyInput = h("input.input.mono", { type: "text", value: key, dir: "ltr", spellcheck: "false", list: "env-known" });
            const commit = () => edit((draft) => {
              const next = {};
              for (const [k, v] of Object.entries(getIn(draft, "env", {}))) {
                if (k === key) {
                  const newKey = keyInput.value.trim();
                  if (newKey) next[newKey] = valueInput.value;
                } else next[k] = v;
              }
              setIn(draft, "env", next);
            });
            keyInput.addEventListener("change", commit);
            valueInput.addEventListener("change", commit);
            table.append(
              h(
                "div.env-row",
                keyInput,
                valueInput,
                secret ? h("button.icon-btn", { type: "button", title: revealed.has(key) ? t("Hide value") : t("Reveal value"), onclick: () => { revealed.has(key) ? revealed.delete(key) : revealed.add(key); draw(); } }, icon("eye", 14)) : h("span.icon-gap"),
                h("button.icon-btn", { type: "button", title: t("Remove"), onclick: () => edit((draft) => { const next = { ...getIn(draft, "env", {}) }; delete next[key]; setIn(draft, "env", next); }) }, icon("trash", 14)),
              ),
            );
          });
        };
        draw();

        const newKey = h("input.input.mono", { type: "text", placeholder: "NAME", dir: "ltr", list: "env-known", spellcheck: "false" });
        const newValue = h("input.input.mono", { type: "text", placeholder: t("value"), dir: "ltr", spellcheck: "false", autocomplete: "off" });
        const add = () => {
          const key = newKey.value.trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return toast(t("Variable names may contain letters, digits and underscores only."), "error");
          edit((draft) => setIn(draft, "env", { ...getIn(draft, "env", {}), [key]: newValue.value }));
        };
        newValue.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), add()));

        body.append(
          group("Variables", datalist, table, h("div.env-row.env-add", newKey, newValue, h("button.btn.small", { type: "button", onclick: add }, icon("plus", 13), t("Add")))),
          infoBanner(t("Values are stored in plain text in the settings file. Names containing KEY, TOKEN or SECRET are masked here but not encrypted on disk.")),
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
