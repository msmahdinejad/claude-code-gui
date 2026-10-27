// Left (right in RTL) sidebar: projects, sessions, search, filters, actions.
import { h, ibtn, menu, formatTime, baseName, copyText, shortPath, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus, setPrefs } from "../core/state.js";

import { isScratchCwd, newSession, openSession, promptRename, pinSession, archiveSession, deleteSession, forkFrom } from "../session.js";
import { openSettings } from "./settings.js";


let filter = "all"; // all | pinned | running | archived
let query = "";

export function mountSidebar(root) {
  const search = h("input.input", { type: "search", placeholder: t("Search sessions"), "aria-label": t("Search sessions"), dir: "auto" });
  search.addEventListener("input", debounce(() => { query = search.value.trim().toLowerCase(); renderList(); }, 80));
  const list = h("div.sb-list");
  const filters = h("div.sb-filters");

  const head = h(
    "div.sb-head",
    h("div.brand", h("span.brand-mark", icon("sparkles", 16)), h("span", "Wheelhouse")),
    ibtn("panel-left", t("Hide sidebar"), () => toggleSidebar()),
  );
  const actions = h(
    "div.sb-actions",
    h("button.btn.sb-new", { type: "button", onclick: () => newSession({}) }, icon("plus", 15), h("span", t("New session"))),
    h("div.sb-search", icon("search", 14), search),
  );
  const foot = h("div.sb-foot");
  root.replaceChildren(head, actions, filters, list, foot);

  function renderFilters() {
    const defs = [["all", t("All")], ["pinned", t("Pinned")], ["running", t("Active")], ["archived", t("Archived")]];
    filters.replaceChildren(...defs.map(([key, label]) => h(`button.chip${filter === key ? ".active" : ""}`, { type: "button", onclick: () => { filter = key; renderFilters(); renderList(); } }, label)));
  }

  function matches(session) {
    if (filter === "archived") return session.archived;
    if (session.archived) return false;
    if (filter === "pinned" && !session.pinned) return false;
    if (filter === "running" && !["running", "requires_action"].includes(app.live.get(session.id)?.state || session.state)) return false;
    if (query) {
      const hay = `${session.title} ${session.firstPrompt || ""} ${session.cwd || ""} ${session.gitBranch || ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }

  function renderList() {
    const sessions = app.sessions.filter(matches);
    if (!sessions.length) {
      list.replaceChildren(h("div.empty", icon("message-square", 24), h("strong", query ? t("No matches") : t("No sessions yet")), h("p", query ? "" : t("Start a new session to begin."))));
      return;
    }
    const nodes = [];
    const pinned = sessions.filter((session) => session.pinned);
    if (pinned.length && filter === "all") nodes.push(group(t("Pinned"), pinned, null));
    const rest = filter === "all" ? sessions.filter((session) => !session.pinned) : sessions;
    if (app.prefs.groupByProject) {
      const byProject = new Map();
      for (const session of rest) {
        const key = isScratchCwd(session.cwd) ? "__scratch__" : session.cwd || "—";
        if (!byProject.has(key)) byProject.set(key, []);
        byProject.get(key).push(session);
      }
      for (const [cwd, items] of byProject) nodes.push(cwd === "__scratch__" ? group(t("Quick sessions"), items, null, "message-square") : group(baseName(cwd), items, cwd));
    } else {
      nodes.push(group(t("Recent"), rest, null));
    }
    list.replaceChildren(...nodes);
  }

  function group(title, sessions, cwd, iconName) {
    return h(
      "div.sb-group",
      h("div.sb-group-head", icon(cwd ? "folder" : iconName || "pin", 12), h("span.grow", { title: cwd || title }, title), cwd ? ibtn("plus", t("New session here"), () => newSession({ cwd }), { size: 13 }) : iconName === "message-square" ? ibtn("plus", t("New session"), () => newSession({ meta: { scratch: true } }), { size: 13 }) : null),
      sessions.map(item),
    );
  }

  function item(session) {
    const live = app.live.get(session.id);
    const state = live?.state || session.state || "closed";
    const pending = live?.pending?.length || session.pending || 0;
    const row = h(
      `div.sb-item${session.id === app.currentId ? ".active" : ""}`,
      { role: "button", tabindex: "0", onclick: () => { openSession(session.id, { cwd: session.cwd }); closeOnNarrow(); }, onkeydown: (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), openSession(session.id, { cwd: session.cwd }), closeOnNarrow()), oncontextmenu: (event) => { event.preventDefault(); sessionMenu(event.currentTarget, session); } },
      h(`span.sb-dot.${pending ? "requires_action" : state}`),
      h("span.sb-title", { dir: "auto", title: session.title }, session.title || t("Untitled session")),
      h("span.sb-sub", formatTime(session.lastModified)),
      h("button.icon-btn.sb-more", { type: "button", title: t("More"), onclick: (event) => { event.stopPropagation(); sessionMenu(event.currentTarget, session); } }, icon("more-horizontal", 15)),
    );
    return row;
  }

  function sessionMenu(anchor, session) {
    menu(anchor, [
      { label: t("Rename"), icon: "edit", onClick: () => promptRename(session.id) },
      { label: session.pinned ? t("Unpin") : t("Pin"), icon: "pin", onClick: () => pinSession(session.id, !session.pinned) },
      { label: session.archived ? t("Unarchive") : t("Archive"), icon: "archive", onClick: () => archiveSession(session.id, !session.archived) },
      { label: t("Fork"), icon: "split", onClick: () => forkFrom(session.id) },
      "-",
      { label: t("Copy session ID"), icon: "copy", onClick: () => copyText(session.id) },
      { label: t("Copy resume command"), icon: "terminal", onClick: () => copyText(`${app.config?.cli || "claude"} --resume ${session.id}`) },
      "-",
      { label: t("Delete"), icon: "trash", danger: true, onClick: () => deleteSession(session.id) },
    ], { placement: "bottom-end" });
  }

  const cwdLabel = h("span.grow");
  foot.append(
    h("button.btn.ghost.small", { type: "button", title: t("Change project folder"), onclick: (event) => { const anchor = event.currentTarget; import("./project-menu.js").then((m) => m.openProjectMenu(anchor, { placement: "top-start" })); } }, icon("folder", 14), cwdLabel),
    ibtn("settings", t("Settings"), () => openSettings(), { size: 16 }),
  );

  const refreshFoot = () => {
    cwdLabel.textContent = isScratchCwd(app.currentCwd) ? t("New folder") : shortPath(app.currentCwd || app.config?.defaultCwd || "", 28);
    cwdLabel.title = app.currentCwd || "";
  };

  document.getElementById("scrim")?.addEventListener("click", () => toggleSidebar(false));
  renderFilters();
  renderList();
  refreshFoot();
  bus.on("sessions", renderList);
  bus.on("live", renderList);
  bus.on("current", () => { renderList(); refreshFoot(); });
  bus.on("prefs", () => { renderList(); });
}

export const isNarrow = () => window.innerWidth < 1000;
function closeOnNarrow() {
  if (isNarrow()) document.body.classList.add("sidebar-closed");
}

export function toggleSidebar(force) {
  const closed = force === undefined ? !document.body.classList.contains("sidebar-closed") : !force;
  document.body.classList.toggle("sidebar-closed", closed);
  setPrefs({ sidebarOpen: !closed });
  bus.emit("layout");
}
