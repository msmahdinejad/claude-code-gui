// Bootstrap.
import "./core/i18n.js";
import { $, toast, errorMessage } from "./core/dom.js";
import { app, applyServerDefaults, bus } from "./core/state.js";
import { t } from "./core/i18n.js";
import { connectGlobalEvents } from "./core/api.js";
import { commands } from "./core/registry.js";
import * as session from "./session.js";
import { makeCtx } from "./ctx.js";
import { addTranslations } from "./core/i18n.js";
import { applyPrefs } from "./features/core.js";
import { mountSidebar, toggleSidebar } from "./ui/sidebar.js";
import { mountTopbar } from "./ui/topbar.js";
import { mountInspector, toggleInspector } from "./ui/inspector.js";
import { mountChat } from "./ui/chatpane.js";
import { openPalette } from "./ui/palette.js";
import { openSettings } from "./ui/settings.js";
import { initResizers } from "./ui/resizers.js";
import { initNotifications } from "./ui/notify.js";

// Feature modules live in js/features/*.js (+ css/features/*.css, js/i18n/fa/*.js) and are
// discovered by the server, so adding a feature never requires editing a shared file.
async function loadFeatures() {
  let found = { js: [], css: [], i18n: [] };
  try {
    found = await (await fetch("/api/features")).json();
  } catch { /* server without discovery */ }
  for (const href of found.css) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }
  const polish = document.createElement("link");
  polish.rel = "stylesheet";
  polish.href = "/css/polish.css";
  document.head.append(polish);
  for (const path of found.i18n) {
    try {
      const module = await import(path);
      addTranslations(module.fa || module.default || {});
    } catch (error) {
      console.error(`[i18n] ${path}`, error);
    }
  }
  for (const path of found.js) {
    try {
      await import(path);
    } catch (error) {
      console.error(`[feature] ${path} failed to load`, error);
      toast(`Feature ${path.split("/").pop()} failed: ${errorMessage(error)}`, "error", 8000);
    }
  }
}

// Anything unexpected surfaces as a toast instead of failing silently.
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason?.name === "AbortError") return;
  toast(errorMessage(event.reason), "error", 7000);
});

// Banner while the local server is unreachable (the page reconnects by itself).
function initConnectionBanner() {
  const banner = document.createElement("div");
  banner.className = "conn-banner hidden";
  banner.textContent = t("Connection to the local server was lost. Reconnecting…");
  document.body.append(banner);
  let timer;
  bus.on("online", (online) => {
    clearTimeout(timer);
    if (online) banner.classList.add("hidden");
    else timer = setTimeout(() => banner.classList.remove("hidden"), 2500);
  });
}

async function boot() {
  await loadFeatures();
  applyPrefs();
  try {
    await session.loadConfig();
    applyServerDefaults(app.config.defaults);
  } catch (error) {
    document.body.textContent = `Cannot reach the Wheelhouse server: ${errorMessage(error)}`;
    return;
  }
  mountSidebar($("#sidebar"));
  mountTopbar($("#topbar"));
  mountChat($("#chat"), $("#dock"));
  mountInspector($("#inspector"));
  initResizers();
  initNotifications();
  initConnectionBanner();
  session.wireGlobalEvents();
  connectGlobalEvents((online) => bus.emit("online", online));
  initShortcuts();

  await session.refreshSessions();
  const match = /^#\/s\/([\w-]+)/.exec(location.hash);
  const requested = match?.[1];
  if (requested) {
    const known = app.sessions.find((entry) => entry.id === requested);
    await session.openSession(requested, { cwd: known?.cwd });
  } else {
    await session.newSession({});
  }
  window.addEventListener("hashchange", () => {
    const id = /^#\/s\/([\w-]+)/.exec(location.hash)?.[1];
    if (id && id !== app.currentId) session.openSession(id, { cwd: app.sessions.find((entry) => entry.id === id)?.cwd });
  });
}

function initShortcuts() {
  const run = (id) => commands.find((command) => command.id === id)?.run(makeCtx());
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "k") { event.preventDefault(); openPalette(); }
    else if (mod && event.key === ",") { event.preventDefault(); openSettings(); }
    else if (mod && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
    else if (mod && event.key === ".") { event.preventDefault(); toggleInspector(); }
    else if (mod && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); run("new"); }
  });
}

boot().catch((error) => {
  console.error(error);
  toast(errorMessage(error), "error", 10000);
});
