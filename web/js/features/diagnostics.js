// Settings → Diagnostics: which Claude Code Wheelhouse runs (executable, profile, config folder, versions,
// update status) and read-only CLI checks (`claude doctor`, `auth status`, `--version`, `mcp list`).
// Server side: server/lib/routes/diagnostics.mjs (fixed allow-list; the page only sends a check id).
import { h, toast, errorMessage, copyText } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { api } from "../core/api.js";
import { registerSettingsSection } from "../core/registry.js";

const CHECKS = [
  { id: "doctor", title: () => t("Installation check"), desc: () => t("Install health, invalid settings files and Remote Control eligibility.") },
  { id: "auth", title: () => t("Sign-in status"), desc: () => t("Which account or key Claude Code uses.") },
  { id: "version", title: () => t("Version"), desc: () => t("The version the active executable reports.") },
  { id: "mcp", title: () => t("MCP servers"), desc: () => t("Connects to each MCP server configured for the current folder and reports its health.") },
];

const results = new Map(); // check id -> { running, result, error } (kept while the page is reopened)

function pretty(text) {
  const trimmed = String(text || "").trim();
  if (/^[[{]/.test(trimmed)) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* not JSON */ }
  }
  return trimmed;
}

function factRow(label, value, { mono = true, copy = true } = {}) {
  return h(
    "div.diag-fact",
    h("span.diag-label", label),
    h(mono ? "code.diag-value" : "span.diag-value", { dir: mono ? "ltr" : "auto", title: value || "" }, value || "—"),
    copy && value ? h("button.icon-btn", { type: "button", title: t("Copy"), "aria-label": t("Copy"), onclick: () => copyText(value) }, icon("copy", 13)) : h("span"),
  );
}

registerSettingsSection({
  id: "diagnostics",
  title: "Diagnostics",
  icon: "gauge",
  order: 95,
  async render(el) {
    el.append(h("h2", t("Diagnostics")), h("p.lead", t("Read-only information about the Claude Code that Wheelhouse runs. Nothing here changes your settings.")));
    const factsHost = h("div.group", h("h3", t("Environment")), h("div.muted", t("Loading…")));
    const checksHost = h("div.group");
    el.append(factsHost, checksHost);

    async function drawFacts() {
      try {
        const [info, update] = await Promise.all([api.get("/api/diagnostics/info"), api.get("/api/update").catch(() => null)]);
        const exe = info.executable.path || (info.executable.source === "bundled" ? t("(bundled with the SDK)") : "");
        const updateText = !update
          ? "—"
          : [
              update.active ? `${t("In use")}: ${update.active}` : null,
              update.installed && update.installed !== update.active ? `${t("Terminal")}: ${update.installed}` : null,
              update.latest ? `${t("Newest")}: ${update.latest}` : null,
              update.updateAvailable ? t("A newer version is available.") : update.active ? t("Claude Code is up to date.") : null,
              update.enabled ? t("automatic updates on") : t("automatic updates off"),
              update.error ? t(update.error) : null,
            ].filter(Boolean).join(" · ");
        factsHost.replaceChildren(
          h("h3", t("Environment")),
          factRow(t("Executable"), exe),
          info.executable.problem ? h("div.banner.warn", icon("alert", 14), h("span", { dir: "auto" }, info.executable.problem)) : null,
          factRow(t("Profile"), info.profile.label === info.profile.name ? info.profile.name : `${info.profile.label} (${info.profile.name})`, { mono: false }),
          factRow(t("Config folder"), info.configDir),
          factRow(t("Wheelhouse config file"), info.configFile),
          factRow(t("Default folder"), info.defaultCwd),
          factRow(t("Wheelhouse"), info.wheelhouse),
          factRow("Node.js", info.node),
          factRow(t("Operating system"), info.os),
          factRow(t("Updates"), updateText, { mono: false, copy: false }),
        );
      } catch (error) {
        factsHost.replaceChildren(h("h3", t("Environment")), h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, errorMessage(error))));
      }
    }

    function drawChecks() {
      checksHost.replaceChildren(
        h("h3", t("Checks")),
        h("div.diag-bar", h("button.btn.small", { type: "button", onclick: () => CHECKS.forEach((check) => run(check.id)) }, icon("play", 13), t("Run all"))),
        ...CHECKS.map((check) => {
          const state = results.get(check.id) || {};
          const result = state.result;
          const output = result ? [pretty(result.stdout), pretty(result.stderr)].filter(Boolean).join("\n\n") : "";
          return h(
            "div.diag-check",
            h(
              "div.diag-check-head",
              state.running ? h("span.spinner", { style: { width: "14px", height: "14px" } }) : icon(result ? (result.ok ? "check-circle" : "x-circle") : "circle", 16, result ? (result.ok ? "diag-ok" : "diag-bad") : ""),
              h("div.grow", h("strong", check.title()), h("small.muted", check.desc())),
              result ? h("code.diag-cmd", { dir: "ltr" }, result.command) : null,
              h("button.btn.small", { type: "button", disabled: state.running, onclick: () => run(check.id) }, icon(result ? "refresh" : "play", 13), result ? t("Run again") : t("Run")),
            ),
            state.error ? h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, state.error)) : null,
            result
              ? h(
                  "div.diag-out-wrap",
                  h("pre.diag-out", { dir: "ltr" }, output || t("(no output)")),
                  h("div.diag-out-meta.muted", result.ok ? t("Finished in {s} s", { s: (result.ms / 1000).toFixed(1) }) : t("Exited with code {code}", { code: result.code ?? "?" }), output ? h("button.btn.small.ghost", { type: "button", onclick: () => copyText(`$ ${result.command}\n${output}`) }, icon("copy", 12), t("Copy output")) : null),
                )
              : null,
          );
        }),
      );
    }

    async function run(id) {
      const state = results.get(id) || {};
      if (state.running) return;
      results.set(id, { ...state, running: true, error: null });
      drawChecks();
      try {
        const result = await api.post("/api/diagnostics/run", { check: id, cwd: app.currentCwd || undefined });
        results.set(id, { result });
      } catch (error) {
        results.set(id, { ...state, running: false, error: errorMessage(error) });
        toast(errorMessage(error), "error");
      }
      if (checksHost.isConnected) drawChecks();
    }

    drawChecks();
    await drawFacts();
  },
});
