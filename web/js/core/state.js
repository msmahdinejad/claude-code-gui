// Global app state + event bus. Components read `app.*` and listen on `bus`.
class Bus {
  #listeners = new Map();
  on(name, fn) {
    if (!this.#listeners.has(name)) this.#listeners.set(name, new Set());
    this.#listeners.get(name).add(fn);
    return () => this.#listeners.get(name)?.delete(fn);
  }
  emit(name, detail) {
    for (const fn of this.#listeners.get(name) || []) {
      try { fn(detail); } catch (error) { console.error(`[bus:${name}]`, error); }
    }
  }
}

export const bus = new Bus();

export const app = {
  config: null, // /api/config
  catalog: null, // /api/catalog for the current cwd
  catalogLoading: false,
  sessions: [], // sidebar list
  currentId: null,
  currentCwd: null,
  convs: new Map(), // sessionId -> Conversation (see chat/reducer.js)
  live: new Map(), // sessionId -> server summary (state, init, pending, meta)
  drafts: new Map(), // sessionId -> draft session settings before first message
  prefs: loadPrefs(),
};

function loadPrefs() {
  const defaults = {
    theme: "auto",
    sidebarOpen: true,
    inspectorOpen: false,
    inspectorTab: "changes",
    sendKey: "enter", // enter | ctrl-enter
    fontSize: 15,
    chatWidth: "normal", // narrow | normal | wide
    showThinking: true,
    expandTools: false,
    notifications: true,
    sound: false,
    groupByProject: true,
    showArchived: false,
    defaultModel: "default",
    defaultEffort: "",
    defaultPermissionMode: "default",
    newSessionIn: "scratch", // scratch (new folder) | project (reuse the current project)
    allowBypass: false,
    prefsVersion: 2,
  };
  try {
    const stored = JSON.parse(localStorage.getItem("wheelhouse-prefs") || "{}");
    return { ...defaults, ...stored, prefsVersion: 2 };
  } catch {
    return defaults;
  }
}

// Defaults for new sessions can come from the server config; a value the user picked in Settings always wins.
const SERVER_DEFAULTS = { defaultModel: "model", defaultEffort: "effort", defaultPermissionMode: "permissionMode" };

export function applyServerDefaults(defaults = {}) {
  for (const [pref, key] of Object.entries(SERVER_DEFAULTS)) {
    if (!app.prefs.explicit?.[pref] && defaults[key] !== undefined) app.prefs[pref] = defaults[key];
  }
}

export function setPrefs(patch) {
  for (const key of Object.keys(patch)) {
    if (key in SERVER_DEFAULTS) app.prefs.explicit = { ...app.prefs.explicit, [key]: true };
  }
  Object.assign(app.prefs, patch);
  try { localStorage.setItem("wheelhouse-prefs", JSON.stringify(app.prefs)); } catch { /* ignore */ }
  bus.emit("prefs", patch);
}

export function currentConv() {
  return app.currentId ? app.convs.get(app.currentId) : null;
}

export function currentLive() {
  return app.currentId ? app.live.get(app.currentId) : null;
}
