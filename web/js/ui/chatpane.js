// Chat pane: timeline + welcome screen + docked requests + suggestion chip + composer host.
import { h, toast, errorMessage, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus, currentConv } from "../core/state.js";
import { api } from "../core/api.js";
import { ChatView } from "../chat/view.js";
import { renderRequest } from "../chat/requests.js";
import { isBusy } from "../chat/reducer.js";
import * as session from "../session.js";
import { mountComposer } from "./composer.js";

export function mountChat(chatRoot, dockRoot) {
  const view = new ChatView(chatRoot, { onAction: handleAction });
  const welcome = buildWelcome();
  const notice = h("div.welcome-notice.hidden");
  welcome.append(notice);
  api.get("/api/profile/status").then((status) => {
    let banner = null;
    if (!status.ok) banner = h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, t("Claude Code could not be started: {error}", { error: status.error || "" })));
    else if (status.loggedIn === false && !app.config?.gateway) banner = h("div.banner.warn", icon("alert", 14), h("span", { dir: "auto" }, t("You are not signed in. Run `{cli} auth login` in a terminal, or point a connection profile at an API key or gateway.", { cli: app.config?.cli || "claude" })));
    if (!banner) return;
    banner.append(h("button.btn.small", { type: "button", onclick: () => import("./settings.js").then((m) => m.openSettings("connection")) }, t("Open connection settings")));
    notice.replaceChildren(banner);
    notice.classList.remove("hidden");
  }).catch(() => {});
  const loadingEl = h("div.chat-loading.hidden", h("span.spinner"));
  chatRoot.append(welcome, loadingEl);

  const requestsHost = h("div.requests");
  const suggestionHost = h("div.suggestion-host");
  const composerHost = h("div.composer-host");
  const quickHost = h("div.quick-start");
  const inner = h("div.dock-inner", requestsHost, suggestionHost, composerHost, quickHost);
  dockRoot.replaceChildren(inner);
  mountComposer(composerHost);

  const cards = new Map(); // request id -> element

  function renderDock() {
    const conv = currentConv();
    const wanted = conv ? [...conv.requests.values()] : [];
    const ids = new Set(wanted.map((request) => request.id));
    for (const [id, el] of cards) {
      if (!ids.has(id)) {
        el.remove();
        cards.delete(id);
      }
    }
    for (const request of wanted) {
      if (cards.has(request.id)) continue;
      const el = renderRequest(request, { respond: session.respondRequest, conv, toolCard: (tool) => view.cardFor(tool).el });
      cards.set(request.id, el);
      requestsHost.append(el);
      el.scrollIntoView?.({ block: "nearest" });
    }
    const showSuggestion = conv?.suggestion && !isBusy(conv) && !wanted.length;
    suggestionHost.replaceChildren(
      showSuggestion
        ? h("button.suggestion-chip", { type: "button", title: t("Use suggested prompt"), onclick: () => bus.emit("composer:fill", conv.suggestion) }, icon("sparkles", 13), h("span", { dir: "auto" }, conv.suggestion))
        : null,
    );
  }

  function renderWelcome() {
    const conv = currentConv();
    const empty = !conv?.items.length && !app.loading;
    welcome.classList.toggle("hidden", !empty);
    quickHost.classList.toggle("hidden", !empty);
    document.body.classList.toggle("chat-empty", empty);
    if (empty) fillWelcome();
  }

  // Greeting + project chip + a few starting points; rebuilt on language/project change.
  function fillWelcome() {
    const cwd = app.currentCwd || app.config?.defaultCwd || "";
    const projectButton = welcome.querySelector(".welcome-project");
    if (projectButton) projectButton.querySelector("span").textContent = session.isScratchCwd(cwd) ? t("New folder") : baseName(cwd);
    quickHost.replaceChildren(...quickStarts().map((item) => h("button.quick-pill", { type: "button", onclick: () => bus.emit("composer:fill", item.prompt) }, item.label)));
  }

  function switchConversation() {
    const conv = currentConv();
    cards.forEach((el) => el.remove());
    cards.clear();
    if (conv) view.setConversation(conv);
    renderDock();
    renderWelcome();
  }

  bus.on("current", switchConversation);
  bus.on("conv:update", (id) => {
    if (id !== app.currentId) return;
    view.sync();
    renderDock();
    renderWelcome();
  });
  bus.on("live", (id) => {
    if (id !== app.currentId) return;
    view.sync();
    renderDock();
  });
  bus.on("loading", (loading) => {
    app.loading = loading;
    loadingEl.classList.toggle("hidden", !loading);
    renderWelcome();
  });
  bus.on("prefs", () => view.sync());
  return view;
}

function quickStarts() {
  return [
    { label: t("Explore this project"), prompt: t("Explore this project and summarize its structure, main modules and how to run it.") },
    { label: t("Review my changes"), prompt: t("Review the current git changes and point out bugs, risks and missing tests.") },
    { label: t("Find and fix a bug"), prompt: t("I have a bug: ") },
    { label: t("Plan a feature"), prompt: t("Plan how to implement: ") },
  ];
}

function buildWelcome() {
  return h(
    "div.welcome",
    h("div.welcome-mark", icon("sparkles", 30)),
    h("h1", t("What should we work on?")),
    h("button.welcome-project", { type: "button", title: t("Change project folder"), onclick: (event) => { const anchor = event.currentTarget; import("./project-menu.js").then((m) => m.openProjectMenu(anchor, { placement: "bottom-start" })); } }, icon("folder", 14), h("span", ""), icon("chevron-down", 12)),
  );
}

async function handleAction(action, item) {
  try {
    if (action === "fork") await session.forkFrom(app.currentId, item.uuid);
    else if (action === "rewind") await session.rewindTo(item.uuid);
    else if (action === "resend") bus.emit("composer:fill", item.text || "");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}
