// Top bar: title (rename), folder / branch / model chips, panel toggles.
import { h, ibtn, shortPath, formatCost } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus, currentConv } from "../core/state.js";
import { api } from "../core/api.js";
import { newSession, promptRename } from "../session.js";
import { toggleSidebar } from "./sidebar.js";
import { toggleInspector } from "./inspector.js";
import { openSettings } from "./settings.js";
import { modelLabel } from "./pickers.js";
import * as session from "../session.js";

const gitCache = new Map();

export function mountTopbar(root) {
  const openBtn = ibtn("panel-left", t("Show sidebar"), () => toggleSidebar(true), { cls: "tb-open" });
  const newBtn = ibtn("plus", t("New session"), () => newSession({}));
  const title = h("div.tb-title");
  const inspBtn = ibtn("panel-right", t("Toggle inspector"), () => toggleInspector());
  const searchBtn = ibtn("command", t("Command palette (Ctrl+K)"), () => bus.emit("command", "palette"));
  const settingsBtn = ibtn("settings", t("Settings"), () => openSettings());
  root.replaceChildren(openBtn, newBtn, title, searchBtn, inspBtn, settingsBtn);

  async function branchFor(cwd) {
    if (!cwd) return null;
    const cached = gitCache.get(cwd);
    if (cached && Date.now() - cached.at < 20_000) return cached.branch;
    try {
      const info = await api.get("/api/git/info", { cwd });
      gitCache.set(cwd, { at: Date.now(), branch: info.isRepo ? info.branch : null, dirty: info.files?.length || 0 });
      return info.isRepo ? info.branch : null;
    } catch {
      return null;
    }
  }

  async function render() {
    const conv = currentConv();
    const id = app.currentId;
    const listed = app.sessions.find((entry) => entry.id === id);
    const name = listed?.title || conv?.title || t("New session");
    const cwd = conv?.cwd || app.currentCwd;
    const state = session.effective();
    // total_cost_usd is cumulative per claude process: add only the increase (a restart resets it).
    let cost = 0;
    let previous = 0;
    for (const item of conv ? conv.items.filter((entry) => entry.kind === "result") : []) {
      const value = item.cost || 0;
      cost += value >= previous ? value - previous : value;
      previous = value;
    }
    const percent = app.contextUsage?.sessionId === id ? app.contextUsage.percentage : null;
    const branch = await branchFor(cwd);
    const git = gitCache.get(cwd);
    title.replaceChildren(
      h("button", { type: "button", title: t("Rename"), onclick: () => id && promptRename(id) }, h("strong", { dir: "auto" }, name)),
      h(
        "div.tb-sub",
        cwd ? h("span", { title: cwd }, icon("folder", 12), session.isScratchCwd(cwd) && cwd === app.config?.workspaceRoot ? t("New folder") : shortPath(cwd, 38)) : null,
        branch ? h("span", icon("git-branch", 12), branch, git?.dirty ? ` ●${git.dirty}` : "") : null,
        h("span", icon("sparkles", 12), modelLabel(state.model)),
        cost ? h("span", icon("coins", 12), formatCost(cost)) : null,
        percent !== null && percent !== undefined
          ? h("span", { title: t("Context window used"), style: { cursor: "pointer" }, onclick: () => import("./inspector.js").then((m) => m.openInspector("context")) }, icon("gauge", 12), `${Math.round(percent)}%`)
          : null,
      ),
    );
    openBtn.classList.toggle("hidden", !document.body.classList.contains("sidebar-closed"));
    newBtn.classList.toggle("hidden", !document.body.classList.contains("sidebar-closed"));
    inspBtn.classList.toggle("active", document.body.classList.contains("inspector-open"));
    document.title = `${name} · Wheelhouse`;
  }

  for (const event of ["current", "sessions", "meta", "layout", "live", "catalog"]) bus.on(event, render);
  bus.on("conv:update", (id) => id === app.currentId && render());
  bus.on("context:usage", render);
  render();
}
