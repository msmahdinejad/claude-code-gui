// Settings → Connection: which Claude Code executable/environment Wheelhouse runs (connection profiles).
import { h, toast, errorMessage, confirmDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";

import { registerSettingsSection } from "../core/registry.js";
import { api } from "../core/api.js";

const DOCS = "https://github.com/msmahdinejad/claude-code-gui/blob/main/docs/CONFIGURATION.md";

function resultLine(result) {
  if (!result) return null;
  if (!result.ok) return h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, result.error || t("Could not run the executable.")));
  const bits = [result.version, result.apiProvider, result.loggedIn === true ? t("signed in") : result.loggedIn === false ? t("not signed in") : null].filter(Boolean);
  return h(`div.banner.${result.loggedIn === false ? "warn" : "info"}`, icon(result.loggedIn === false ? "alert" : "check-circle", 14), h("span", { dir: "ltr" }, bits.join(" · ")));
}

registerSettingsSection({
  id: "connection", title: "Connection", icon: "plug", order: 2,
  async render(el) {
    const host = h("div");
    el.append(h("h2", t("Connection")), h("p.lead", t("Choose which Claude Code installation Wheelhouse runs. Profiles live in your config file and can point at another executable, a wrapper, or a gateway.")), host);
    const tests = new Map();

    async function draw() {
      const info = await api.get("/api/profile");
      host.replaceChildren(
        h("div.group", h("h3", t("Profiles")),
          ...info.profiles.map((profile) => {
            const active = profile.name === info.active;
            const out = h("div", resultLine(tests.get(profile.name)));
            return h("div.list-row", { style: { flexDirection: "column", alignItems: "stretch", gap: "8px", marginBottom: "10px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
                h("div.grow", h("strong", { dir: "auto" }, profile.label), profile.description ? h("span.muted", { dir: "auto" }, profile.description) : null),
                active ? h("span.badge.ok", t("Active")) : null,
                h("button.btn.small", { type: "button", onclick: async () => {
                  tests.set(profile.name, { ok: true, version: t("Testing…") });
                  out.replaceChildren(resultLine(tests.get(profile.name)));
                  try { tests.set(profile.name, await api.post("/api/profile/test", { name: profile.name })); } catch (error) { tests.set(profile.name, { ok: false, error: errorMessage(error) }); }
                  out.replaceChildren(resultLine(tests.get(profile.name)));
                } }, t("Test")),
                !active ? h("button.btn.small.primary", { type: "button", onclick: async () => {
                  const ok = await confirmDialog({ title: t("Switch connection"), message: t("Running sessions stop and the list reloads from the other profile's configuration directory."), confirmLabel: t("Switch") });
                  if (!ok) return;
                  try { await api.post("/api/profile/switch", { name: profile.name }); location.reload(); } catch (error) { toast(errorMessage(error), "error"); }
                } }, t("Use this")) : null),
              h("dl.kv", { dir: "ltr" },
                h("dt", t("Command")), h("dd", profile.resolved || profile.command),
                h("dt", t("Config directory")), h("dd", profile.configDir || "—"),
                profile.envKeys.length ? [h("dt", t("Environment")), h("dd", profile.envKeys.join(", "))] : null),
              profile.problem ? h("div.banner.error", icon("alert", 14), profile.problem) : null,
              out);
          })),
        h("div.group", h("h3", t("Configuration file")),
          h("p.muted", info.configFile ? info.configFile : t("No config file found. The default profile runs `claude` from your PATH.")),
          h("a.btn", { href: DOCS, target: "_blank", rel: "noreferrer noopener" }, icon("book", 14), t("How to write profiles"))),
      );
    }
    try { await draw(); } catch (error) { host.append(h("div.banner.error", errorMessage(error))); }
  },
});
