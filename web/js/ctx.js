// The context object handed to feature modules (settings sections, inspector tabs, commands).
import { api } from "./core/api.js";
import { app, bus, currentConv, currentLive, setPrefs } from "./core/state.js";
import { toast, errorMessage } from "./core/dom.js";
import * as session from "./session.js";

export function makeCtx() {
  return {
    app,
    bus,
    api,
    toast,
    errorMessage,
    session, // session controller: sendMessage, setModel, newSession, ...
    setPrefs,
    get cwd() { return app.currentCwd || app.config?.defaultCwd; },
    get sessionId() { return app.currentId; },
    get live() { return currentLive(); },
    get conv() { return currentConv(); },
    openSettings: (id) => import("./ui/settings.js").then((m) => m.openSettings(id)),
    openInspector: (id) => import("./ui/inspector.js").then((m) => m.openInspector(id)),
    runPrompt: (text) => session.sendMessage(text),
    fillComposer: (text) => bus.emit("composer:fill", text),
  };
}
