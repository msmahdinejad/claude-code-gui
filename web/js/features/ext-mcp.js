// MCP servers: live status, reconnect/toggle/remove, add form (stdio/http/sse), .mcp.json editor.
import { h, toast, errorMessage, confirmDialog, copyText } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerSettingsSection, registerInspectorTab } from "../core/registry.js";
import { runCli, refreshExtensions, busyButton, statusBadge, sectionTitle, emptyNote, loading, currentScopeLabel, EXT_CHANGED } from "./ext-common.js";

const SCOPE_REMOVABLE = new Set(["local", "project", "user"]);

async function fetchStatus(ctx) {
  const live = ctx.live;
  if (live?.alive) {
    try {
      return { servers: await ctx.api.control(ctx.sessionId, "mcpStatus"), live: true };
    } catch { /* fall through to catalog */ }
  }
  const catalog = app.catalog || (await ctx.session.ensureCatalog(ctx.cwd));
  return { servers: catalog?.mcp || [], live: false };
}

function groupOf(server) {
  const scope = server.scope || "";
  const source = server.source || "";
  if (server.name?.startsWith("claude.ai ") || scope === "claudeai" || source === "claudeai") return "claudeai";
  if (server.name?.startsWith("plugin:") || scope === "plugin" || source === "plugin") return "plugin";
  if (scope === "dynamic" || scope === "sdk") return "dynamic";
  return "configured";
}

const GROUP_TITLES = {
  configured: () => t("Your servers"),
  plugin: () => t("From plugins"),
  dynamic: () => t("Dynamic"),
  claudeai: () => t("claude.ai connectors"),
};

export function renderMcp(container, ctx, { compact = false } = {}) {
  const body = h("div.ext-body");
  const banner = h("div.ext-banner-host");
  container.replaceChildren(body);
  let state = { servers: [], live: false };
  let openTools = new Set();
  let showClaudeAi = false;
  let alive = true;
  let pollTimer = null;
  let pollCount = 0;

  async function load(force = false, quiet = false) {
    if (!quiet) body.replaceChildren(loading());
    try {
      if (force) await ctx.session.ensureCatalog(ctx.cwd, true);
      state = await fetchStatus(ctx);
    } catch (error) {
      body.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
      return;
    }
    if (alive) draw();
    // Servers connect asynchronously: poll briefly while any is still pending.
    clearTimeout(pollTimer);
    if (alive && state.servers.some((server) => server.status === "pending") && pollCount < 15) {
      pollCount += 1;
      pollTimer = setTimeout(() => alive && load(false, true), 2000);
    } else if (!state.servers.some((server) => server.status === "pending")) pollCount = 0;
  }

  async function afterChange(message) {
    toast(message, "ok", 2500);
    await refreshExtensions(ctx);
    const live = ctx.live;
    if (live?.alive) {
      banner.replaceChildren(
        h("div.banner.info", icon("info", 14), h("span.grow", t("MCP configuration changed. Restart the session so Claude sees it.")), busyButton(t("Restart session"), "refresh", async () => {
          await ctx.api.restart(ctx.sessionId, ctx.cwd, {});
          banner.replaceChildren();
          toast(t("Session restarted"), "ok", 2000);
          load();
        }, { variant: "primary" })),
      );
    }
    await load();
  }

  function serverRow(server) {
    const tools = server.tools || [];
    const isOpen = openTools.has(server.name);
    const removable = SCOPE_REMOVABLE.has(server.scope) && groupOf(server) === "configured";
    const isLive = state.live;
    const row = h("div.ext-card.mcp-row");
    const info = server.serverInfo ? ` · ${server.serverInfo.name} ${server.serverInfo.version}` : "";
    row.append(
      h(
        "div.ext-card-head",
        icon("plug", 16),
        h("div.grow", h("strong", { dir: "auto" }, server.name), h("span.muted", `${server.scope || server.source || ""}${info}`)),
        statusBadge(server.status),
        tools.length ? h("button.btn.ghost.small", { type: "button", onclick: () => { isOpen ? openTools.delete(server.name) : openTools.add(server.name); draw(); } }, icon(isOpen ? "chevron-up" : "chevron-down", 13), t("{n} tools", { n: tools.length })) : null,
      ),
    );
    if (server.error) row.append(h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, server.error)));
    if (server.status === "needs-auth") {
      row.append(
        h("div.banner.warn", icon("lock", 14), h("div.banner-text", h("span", t("This server needs you to sign in.")), h("small", h("code", `claude mcp login ${server.name}`)))),
      );
    }
    const actions = h("div.ext-actions");
    {
      if (server.status === "needs-auth") {
        actions.append(busyButton(t("Sign in"), "lock", async () => {
          const result = await runCli(ctx, ["mcp", "login", server.name], { timeout: 180_000, allowFail: true });
          toast(result.ok ? t("Signed in") : (result.stderr || result.stdout || t("Sign-in did not finish")).slice(0, 200), result.ok ? "ok" : "error", 5000);
          await refreshExtensions(ctx);
          load();
        }, { title: t("Opens your browser to authorize") }));
      }
      if (isLive) {
        actions.append(
          busyButton(t("Reconnect"), "refresh", async () => { await ctx.api.control(ctx.sessionId, "mcpReconnect", { name: server.name }); await load(); }),
          busyButton(server.status === "disabled" ? t("Enable") : t("Disable"), server.status === "disabled" ? "play" : "x-circle", async () => {
            await ctx.api.control(ctx.sessionId, "mcpToggle", { name: server.name, enabled: server.status === "disabled" });
            await load();
          }),
        );
        const select = h("select.input.small-select", { title: t("Permission mode for this server's tools"), onchange: async () => {
          try {
            await ctx.api.control(ctx.sessionId, "mcpPermissionOverride", { name: server.name, mode: select.value === "inherit" ? null : select.value });
            toast(t("Saved"), "ok", 1500);
          } catch (error) { toast(errorMessage(error), "error"); }
        } }, [["inherit", t("Permissions: session")], ["default", t("Always ask")], ["auto", t("Auto classifier")]].map(([value, label]) => h("option", { value }, label)));
        actions.append(select);
      }
      if (removable) {
        actions.append(busyButton(t("Remove"), "trash", async () => {
          const ok = await confirmDialog({ title: t("Remove MCP server"), message: t("Remove “{name}” from {scope} scope?", { name: server.name, scope: server.scope }), confirmLabel: t("Remove"), danger: true });
          if (!ok) return;
          await runCli(ctx, ["mcp", "remove", server.name, "-s", server.scope]);
          await afterChange(t("Removed {name}", { name: server.name }));
        }, { variant: "danger-outline" }));
      }
    }
    if (actions.childNodes.length) row.append(actions);
    if (isOpen) {
      row.append(
        h("ul.mcp-tools", tools.map((tool) => h("li", h("code", { dir: "ltr" }, tool.name), tool.description ? h("span.muted", { dir: "auto" }, tool.description.slice(0, 160)) : null))),
      );
    }
    return row;
  }

  function draw() {
    const groups = { configured: [], plugin: [], dynamic: [], claudeai: [] };
    for (const server of state.servers) groups[groupOf(server)].push(server);
    const nodes = [];
    const refresh = busyButton(t("Refresh"), "refresh", () => load(true), { variant: "ghost" });
    nodes.push(sectionTitle(t("MCP servers"), refresh));
    if (!state.live) {
      nodes.push(
        h("div.banner.info", icon("info", 14), h("span.grow", t("Showing a snapshot. Start the session for live controls (reconnect, enable/disable).")),
          ctx.sessionId ? busyButton(t("Start session"), "play", async () => { await ctx.api.startSession(ctx.sessionId, ctx.cwd); await load(); }) : null),
      );
    }
    nodes.push(banner);
    for (const key of ["configured", "plugin", "dynamic"]) {
      if (!groups[key].length) continue;
      nodes.push(h("h4.ext-sub", GROUP_TITLES[key]()), ...groups[key].map(serverRow));
    }
    if (!groups.configured.length) nodes.push(emptyNote(t("No MCP servers configured for this project yet.")));
    if (groups.claudeai.length) {
      const connected = groups.claudeai.filter((server) => server.status === "connected").length;
      nodes.push(
        h("button.ext-fold", { type: "button", onclick: () => { showClaudeAi = !showClaudeAi; draw(); } }, icon(showClaudeAi ? "chevron-up" : "chevron-down", 14), h("span", `${GROUP_TITLES.claudeai()} (${connected}/${groups.claudeai.length} ${t("connected")})`)),
      );
      if (showClaudeAi) nodes.push(...groups.claudeai.map(serverRow));
    }
    if (!compact) {
      nodes.push(addForm(), rawFiles());
    } else {
      nodes.push(h("button.btn.small", { type: "button", onclick: () => ctx.openSettings("mcp") }, icon("settings", 14), t("Manage MCP servers…")));
    }
    body.replaceChildren(...nodes);
  }

  // ---- add form -------------------------------------------------------------------
  function addForm() {
    const details = h("details.ext-details");
    details.append(h("summary", icon("plus", 14), t("Add an MCP server")));
    const name = h("input.input", { type: "text", placeholder: "my-server", dir: "ltr", spellcheck: "false" });
    const transport = h("select.input", [["stdio", "stdio (local command)"], ["http", "HTTP"], ["sse", "SSE"]].map(([value, label]) => h("option", { value }, label)));
    const scope = h("select.input", [["local", currentScopeLabel("local")], ["project", currentScopeLabel("project")], ["user", currentScopeLabel("user")]].map(([value, label]) => h("option", { value }, label)));
    const command = h("input.input", { type: "text", placeholder: "node", dir: "ltr", spellcheck: "false" });
    const args = h("textarea.input", { rows: 3, placeholder: t("One argument per line"), dir: "ltr", spellcheck: "false" });
    const env = h("textarea.input", { rows: 2, placeholder: "API_KEY=value", dir: "ltr", spellcheck: "false" });
    const url = h("input.input", { type: "url", placeholder: "https://example.com/mcp", dir: "ltr", spellcheck: "false" });
    const headers = h("textarea.input", { rows: 2, placeholder: "Authorization: Bearer …", dir: "ltr", spellcheck: "false" });
    const stdioBox = h("div", h("label.field", h("span", t("Command")), command), h("label.field", h("span", t("Arguments")), args), h("label.field", h("span", t("Environment variables")), env));
    const httpBox = h("div.hidden", h("label.field", h("span", "URL"), url), h("label.field", h("span", t("Headers")), headers));
    transport.addEventListener("change", () => {
      stdioBox.classList.toggle("hidden", transport.value !== "stdio");
      httpBox.classList.toggle("hidden", transport.value === "stdio");
    });
    const pairs = (text, sep) => Object.fromEntries(text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const index = line.indexOf(sep);
      return index < 0 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }));
    const submit = busyButton(t("Add server"), "plus", async () => {
      const id = name.value.trim();
      if (!/^[\w.-]{1,64}$/.test(id)) throw new Error(t("Name may contain letters, digits, dot, dash and underscore."));
      let config;
      if (transport.value === "stdio") {
        if (!command.value.trim()) throw new Error(t("Command is required."));
        config = { type: "stdio", command: command.value.trim(), args: args.value.split("\n").map((line) => line.trim()).filter(Boolean) };
        const envMap = pairs(env.value, "=");
        if (Object.keys(envMap).length) config.env = envMap;
      } else {
        if (!/^https?:\/\//.test(url.value.trim())) throw new Error(t("A valid http(s) URL is required."));
        config = { type: transport.value, url: url.value.trim() };
        const headerMap = pairs(headers.value, ":");
        if (Object.keys(headerMap).length) config.headers = headerMap;
      }
      await runCli(ctx, ["mcp", "add-json", id, JSON.stringify(config), "-s", scope.value]);
      name.value = "";
      await afterChange(t("Added {name}", { name: id }));
    }, { variant: "primary", small: false });
    details.append(
      h("div.ext-form",
        h("div.ext-form-row", h("label.field", h("span", t("Name")), name), h("label.field", h("span", t("Transport")), transport), h("label.field", h("span", t("Scope")), scope)),
        stdioBox, httpBox, submit,
        h("small.muted", t("“Local” is private to you in this project, “Project” writes .mcp.json (shared with your team), “User” applies everywhere.")),
      ),
    );
    return details;
  }

  // ---- raw files ------------------------------------------------------------------
  function rawFiles() {
    const details = h("details.ext-details");
    const editorHost = h("div");
    details.append(h("summary", icon("file-text", 14), t("Configuration files")), editorHost);
    let loaded = false;
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded) return;
      loaded = true;
      editorHost.replaceChildren(loading());
      try {
        const files = await ctx.api.get("/api/ext/mcp-files", { cwd: ctx.cwd });
        const text = h("textarea.input.editor", { rows: 12, spellcheck: "false", dir: "ltr" }, files.project.text);
        const save = busyButton(t("Save .mcp.json"), "check", async () => {
          await ctx.api.put("/api/ext/mcp-project", { cwd: ctx.cwd, text: text.value });
          await afterChange(t("Saved .mcp.json"));
        }, { variant: "primary" });
        const fileList = (title, servers) => {
          const names = Object.keys(servers || {});
          return h("div.ext-fileblock", h("h4.ext-sub", title), names.length ? h("ul.mcp-tools", names.map((n) => h("li", h("code", n), h("span.muted", servers[n].command ? `${servers[n].command} ${(servers[n].args || []).join(" ")}` : servers[n].url || "")))) : emptyNote(t("None")));
        };
        editorHost.replaceChildren(
          h("div.ext-fileblock", h("h4.ext-sub", `${t("Project")}: ${files.project.path}`), files.project.error ? h("div.banner.error", files.project.error) : null, text, h("div.ext-actions", save, h("button.btn.ghost.small", { type: "button", onclick: () => copyText(files.project.path) }, icon("copy", 13), t("Copy path")))),
          fileList(`${t("Local (private)")} — ${t("secrets hidden")}`, files.local.servers),
          fileList(`${t("User")} — ${files.user.path}`, files.user.servers),
        );
      } catch (error) {
        loaded = false;
        editorHost.replaceChildren(h("div.banner.error", errorMessage(error)));
      }
    });
    return details;
  }

  // Panels are re-rendered into the same host; stop reacting once it left the document.
  const ok = () => {
    if (alive && !container.isConnected) cleanup();
    return alive;
  };
  const off = [bus.on(EXT_CHANGED, () => ok() && load()), bus.on("live", (id) => id === app.currentId && ok() && load()), bus.on("current", () => ok() && load())];
  function cleanup() {
    alive = false;
    clearTimeout(pollTimer);
    off.forEach((fn) => fn());
  }
  load();
  return cleanup;
}

registerSettingsSection({
  id: "mcp", title: "MCP servers", icon: "plug", order: 30,
  render(el, ctx) {
    const host = h("div.ext-page");
    el.append(h("h2", t("MCP servers")), h("p.lead", t("Model Context Protocol servers give Claude extra tools and data sources.")), host);
    renderMcp(host, ctx);
  },
});

registerInspectorTab({
  id: "mcp", title: "MCP", icon: "plug", order: 40,
  badge: (ctx) => {
    const servers = app.catalog?.mcp || [];
    return servers.filter((server) => groupOf(server) !== "claudeai" && (server.status === "failed" || server.status === "needs-auth")).length;
  },
  render(el, ctx) {
    const host = h("div.panel.ext-panel");
    el.append(host);
    return renderMcp(host, ctx, { compact: true });
  },
});
