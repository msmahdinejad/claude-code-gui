// Inspector tab: one-glance overview of extensions with links to the settings pages.
import { h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerInspectorTab, registerCommand } from "../core/registry.js";
import { statusBadge, sectionTitle, emptyNote, EXT_CHANGED } from "./ext-common.js";

function overview(el, ctx) {
  const host = h("div.panel.ext-panel");
  el.append(host);
  let alive = true;

  const link = (target, label) => h("button.btn.ghost.small", { type: "button", onclick: () => ctx.openSettings(target) }, icon("settings", 13), label);

  function draw() {
    const catalog = app.catalog;
    const mcp = (catalog?.mcp || []).filter((server) => !server.name?.startsWith("claude.ai "));
    const connectors = (catalog?.mcp || []).filter((server) => server.name?.startsWith("claude.ai "));
    const commands = catalog?.commands || [];
    const skills = commands.filter((command) => !command.builtin);
    const agents = catalog?.agents || [];
    const plugins = ctx.live?.init?.plugins || ctx.conv?.init?.plugins || [];
    host.replaceChildren(
      sectionTitle(t("MCP servers"), link("mcp", t("Manage"))),
      ...(mcp.length ? mcp.slice(0, 8).map((server) => h("div.list-row", h("div.grow", h("strong", server.name), h("span.muted", server.scope || "")), statusBadge(server.status))) : [emptyNote(t("No project MCP servers."))]),
      connectors.length ? h("div.muted", `${connectors.filter((s) => s.status === "connected").length}/${connectors.length} ${t("claude.ai connectors connected")}`) : null,
      sectionTitle(t("Plugins"), link("plugins", t("Manage"))),
      ...(plugins.length ? plugins.map((plugin) => h("div.list-row", icon("puzzle", 15), h("div.grow", h("strong", plugin.name), h("span.muted", plugin.version ? `v${plugin.version}` : "")))) : [emptyNote(t("No plugins loaded in this session."))]),
      sectionTitle(t("Skills & commands"), link("skills", t("Manage"))),
      h("div.kv", h("dt", t("Skills / custom commands")), h("dd", String(skills.length)), h("dt", t("Built-in commands")), h("dd", String(commands.length - skills.length))),
      sectionTitle(t("Agents"), link("agents", t("Manage"))),
      ...(agents.length ? agents.map((agent) => h("div.list-row", icon("bot", 15), h("div.grow", h("strong", agent.name), h("span.muted", { dir: "auto" }, (agent.description || "").slice(0, 90))), agent.model ? h("span.badge", agent.model) : null)) : [emptyNote(t("No agents."))]),
    );
  }

  const stop = () => { alive = false; off.forEach((fn) => fn()); };
  const redraw = () => {
    if (alive && !host.isConnected) stop();
    if (alive) draw();
  };
  const off = [bus.on("catalog", redraw), bus.on(EXT_CHANGED, redraw), bus.on("live", redraw)];
  draw();
  if (!app.catalog) ctx.session.ensureCatalog(ctx.cwd);
  return stop;
}

registerInspectorTab({ id: "extensions", title: "Extensions", icon: "puzzle", order: 41, render: overview });

registerCommand({ id: "ext-mcp", title: "Manage MCP servers", icon: "plug", keywords: ["mcp", "server", "tools"], slash: "mcp", run: (ctx) => ctx.openSettings("mcp") });
registerCommand({ id: "ext-plugins", title: "Manage plugins", icon: "puzzle", keywords: ["plugin", "marketplace"], slash: "plugin", slashAliases: ["plugins"], run: (ctx) => ctx.openSettings("plugins") });
registerCommand({ id: "ext-agents", title: "Manage agents", icon: "bot", keywords: ["agent", "subagent"], slash: "agents", run: (ctx) => ctx.openSettings("agents") });
registerCommand({ id: "ext-skills", title: "Manage skills", icon: "sparkles", keywords: ["skill"], run: (ctx) => ctx.openSettings("skills") });
registerCommand({ id: "ext-commands", title: "Manage slash commands", icon: "slash", keywords: ["command", "slash"], run: (ctx) => ctx.openSettings("commands") });
