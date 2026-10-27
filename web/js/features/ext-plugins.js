// Plugins: installed list, marketplaces, browse/install, validate, reload.
import { h, toast, errorMessage, confirmDialog, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { bus } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { runCli, refreshExtensions, busyButton, sectionTitle, emptyNote, loading, currentScopeLabel, EXT_CHANGED } from "./ext-common.js";

const idOf = (plugin) => plugin.id || plugin.pluginId || (plugin.name && plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name) || "";
const nameOf = (plugin) => plugin.name || idOf(plugin).split("@")[0];
const isEnabled = (plugin) => plugin.enabled !== false;
const scopeOf = (plugin) => plugin.scope || "user";

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value).flat();
  return [];
}

function render(el, ctx) {
  const host = h("div.ext-page");
  el.append(h("h2", t("Plugins")), h("p.lead", t("Plugins bundle skills, agents, slash commands, hooks and MCP servers.")), host);
  let data = null;
  let browse = null;
  let browseQuery = "";
  const openDetails = new Map();
  const validateOut = h("pre.ext-pre.hidden", { dir: "ltr" });
  let alive = true;

  async function load(withAvailable = false) {
    host.replaceChildren(loading());
    try {
      data = await ctx.api.get("/api/ext/plugins", { cwd: ctx.cwd, available: withAvailable ? 1 : "" });
      if (withAvailable) browse = normalizeList(data.available);
    } catch (error) {
      host.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
      return;
    }
    if (alive) draw();
  }

  async function mutate(args, message, { timeout = 180_000, reload = true } = {}) {
    // The CLI's own confirmation is skipped with -y, so ask here: plugins can ship hooks and commands that run code.
    if (args.includes("-y")) {
      const ok = await confirmDialog({
        title: t("Install or update plugin?"),
        message: t("{plugin} can add skills, hooks and commands that run on your machine. Only continue for sources you trust.", { plugin: args[2] }),
        confirmLabel: t("Continue"),
      });
      if (!ok) return;
    }
    await runCli(ctx, args, { timeout });
    toast(message, "ok", 2500);
    await refreshExtensions(ctx, { control: reload ? "reloadPlugins" : undefined }); // emits EXT_CHANGED -> reload below
  }

  function installedRow(plugin) {
    const id = idOf(plugin);
    const row = h("div.ext-card");
    row.append(
      h("div.ext-card-head", icon("puzzle", 16),
        h("div.grow", h("strong", { dir: "auto" }, nameOf(plugin)), h("span.muted", `${plugin.version ? `v${plugin.version} · ` : ""}${currentScopeLabel(scopeOf(plugin))}${plugin.marketplace ? ` · ${plugin.marketplace}` : ""}`)),
        h(`span.badge${isEnabled(plugin) ? ".ok" : ""}`, isEnabled(plugin) ? t("Enabled") : t("Disabled"))),
    );
    if (plugin.description) row.append(h("div.muted.ext-desc", { dir: "auto" }, plugin.description));
    const detailBox = openDetails.get(id);
    row.append(
      h("div.ext-actions",
        busyButton(isEnabled(plugin) ? t("Disable") : t("Enable"), isEnabled(plugin) ? "x-circle" : "play", () => mutate(["plugin", isEnabled(plugin) ? "disable" : "enable", id, "-s", scopeOf(plugin)], isEnabled(plugin) ? t("Disabled {name}", { name: nameOf(plugin) }) : t("Enabled {name}", { name: nameOf(plugin) }))),
        busyButton(t("Update"), "refresh", () => mutate(["plugin", "update", id, "-s", scopeOf(plugin), "-y"], t("Updated {name}", { name: nameOf(plugin) }))),
        busyButton(t("Contents"), "layers", async () => {
          if (openDetails.has(id)) openDetails.delete(id);
          else {
            const result = await ctx.api.get("/api/ext/plugin-details", { name: id, cwd: ctx.cwd });
            openDetails.set(id, result.text || t("No details available."));
          }
          draw();
        }),
        busyButton(t("Uninstall"), "trash", async () => {
          const ok = await confirmDialog({ title: t("Uninstall plugin"), message: t("Uninstall “{name}”?", { name: nameOf(plugin) }), confirmLabel: t("Uninstall"), danger: true });
          if (ok) await mutate(["plugin", "uninstall", id, "-s", scopeOf(plugin)], t("Uninstalled {name}", { name: nameOf(plugin) }));
        }, { variant: "danger-outline" }),
      ),
    );
    if (detailBox) row.append(h("pre.ext-pre", { dir: "ltr" }, detailBox));
    return row;
  }

  function marketplaceRow(market) {
    return h("div.ext-card",
      h("div.ext-card-head", icon("globe", 16),
        h("div.grow", h("strong", market.name), h("span.muted", { dir: "ltr" }, market.repo || market.url || market.path || market.source || "")),
        busyButton(t("Update"), "refresh", () => mutate(["plugin", "marketplace", "update", market.name], t("Updated {name}", { name: market.name }), { reload: false })),
        busyButton(t("Remove"), "trash", async () => {
          const ok = await confirmDialog({ title: t("Remove marketplace"), message: t("Remove “{name}”? Plugins installed from it stay installed.", { name: market.name }), confirmLabel: t("Remove"), danger: true });
          if (ok) await mutate(["plugin", "marketplace", "remove", market.name], t("Removed {name}", { name: market.name }), { reload: false });
        }, { variant: "danger-outline" })),
    );
  }

  function addMarketplaceForm() {
    const source = h("input.input", { type: "text", dir: "ltr", placeholder: "owner/repo  ·  https://…git  ·  C:\\path", spellcheck: "false" });
    const scope = h("select.input", ["user", "project", "local"].map((value) => h("option", { value }, currentScopeLabel(value))));
    return h("div.ext-form",
      h("div.ext-form-row", h("label.field.grow", h("span", t("Add a marketplace")), source), h("label.field", h("span", t("Scope")), scope)),
      busyButton(t("Add marketplace"), "plus", async () => {
        if (!source.value.trim()) throw new Error(t("Enter a GitHub repo, git URL or path."));
        await mutate(["plugin", "marketplace", "add", source.value.trim(), "--scope", scope.value], t("Marketplace added"), { reload: false });
        source.value = "";
      }, { variant: "primary", small: false }));
  }

  function browseSection() {
    const box = h("div");
    if (!browse) {
      box.append(busyButton(t("Browse available plugins"), "search", () => load(true)));
      return box;
    }
    const search = h("input.input", { type: "search", placeholder: t("Search plugins"), dir: "auto", value: browseQuery });
    const list = h("div.ext-list");
    const installedIds = new Set(normalizeList(data.installed).map(idOf));
    const paint = () => {
      const needle = browseQuery.toLowerCase();
      const shown = browse.filter((plugin) => !needle || `${idOf(plugin)} ${plugin.description || ""}`.toLowerCase().includes(needle)).slice(0, 60);
      list.replaceChildren(...shown.map((plugin) => {
        const id = idOf(plugin);
        return h("div.ext-card",
          h("div.ext-card-head", icon("puzzle", 16), h("div.grow", h("strong", nameOf(plugin)), h("span.muted", { dir: "auto" }, plugin.description || id)),
            installedIds.has(id) ? h("span.badge.ok", t("Installed")) : busyButton(t("Install"), "download", () => mutate(["plugin", "install", id, "-s", "user", "-y"], t("Installed {name}", { name: nameOf(plugin) })), { variant: "primary" })));
      }));
      if (!shown.length) list.append(emptyNote(t("No plugins match.")));
    };
    search.addEventListener("input", debounce(() => { browseQuery = search.value; paint(); }, 100));
    paint();
    box.append(search, list);
    return box;
  }

  function installByName() {
    const input = h("input.input", { type: "text", dir: "ltr", placeholder: "plugin@marketplace", spellcheck: "false" });
    const scope = h("select.input", ["user", "project", "local"].map((value) => h("option", { value }, currentScopeLabel(value))));
    return h("div.ext-form-row", h("label.field.grow", h("span", t("Install by name")), input), h("label.field", h("span", t("Scope")), scope),
      busyButton(t("Install"), "download", async () => {
        if (!input.value.trim()) throw new Error(t("Enter plugin@marketplace."));
        await mutate(["plugin", "install", input.value.trim(), "-s", scope.value, "-y"], t("Installed {name}", { name: input.value.trim() }));
        input.value = "";
      }, { variant: "primary", small: false }));
  }

  function validator() {
    const input = h("input.input", { type: "text", dir: "ltr", placeholder: "C:\\path\\to\\plugin", spellcheck: "false" });
    const out = validateOut; // survives redraws
    return h("div", h("div.ext-form-row", h("label.field.grow", h("span", t("Validate a local plugin or marketplace folder")), input),
      busyButton(t("Validate"), "shield-check", async () => {
        if (!input.value.trim()) throw new Error(t("Enter a folder path."));
        const result = await runCli(ctx, ["plugin", "validate", input.value.trim()], { allowFail: true, timeout: 60_000 });
        out.classList.remove("hidden");
        out.textContent = `${result.ok ? "✓ " : "✗ "}${(result.stdout || result.stderr).trim()}`;
      }, { small: false })), out);
  }

  function draw() {
    const installed = normalizeList(data.installed);
    const markets = normalizeList(data.marketplaces);
    const errors = ctx.conv?.init?.plugin_errors || [];
    const nodes = [];
    nodes.push(sectionTitle(t("Installed"), h("div.ext-actions",
      busyButton(t("Reload plugins"), "refresh", async () => { await refreshExtensions(ctx, { control: "reloadPlugins" }); toast(t("Plugins reloaded"), "ok", 1800); }, { variant: "ghost" }))));
    if (errors.length) nodes.push(...errors.map((error) => h("div.banner.error", icon("alert", 14), h("div.banner-text", h("strong", error.plugin), h("span", { dir: "auto" }, error.message)))));
    if (data.errors?.length) nodes.push(h("div.banner.warn", icon("alert", 14), h("span", { dir: "auto" }, data.errors[0].slice(0, 300))));
    nodes.push(...(installed.length ? installed.map(installedRow) : [emptyNote(t("No plugins installed."))]));
    nodes.push(installByName());
    nodes.push(sectionTitle(t("Marketplaces")), ...(markets.length ? markets.map(marketplaceRow) : [emptyNote(t("No marketplaces configured."))]), addMarketplaceForm());
    nodes.push(sectionTitle(t("Browse")), browseSection());
    nodes.push(sectionTitle(t("Developer")), validator());
    host.replaceChildren(...nodes);
  }

  const off = bus.on(EXT_CHANGED, () => {
    if (alive && !host.isConnected) { alive = false; off(); }
    if (alive) load(Boolean(browse));
  });
  load();
  return () => { alive = false; off(); };
}

registerSettingsSection({ id: "plugins", title: "Plugins", icon: "puzzle", order: 31, render });
