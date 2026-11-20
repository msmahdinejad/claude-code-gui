// Session controller: owns conversations, streams and all session-level actions.
import { api, onServerEvent, openSessionStream } from "./core/api.js";
import { app, bus, currentConv } from "./core/state.js";
import { toast, errorMessage, confirmDialog, promptDialog } from "./core/dom.js";
import { t } from "./core/i18n.js";
import { applyMessage, createConversation, isBusy, loadHistory, userItems } from "./chat/reducer.js";

const streams = new Map();

export function convFor(id) {
  return app.convs.get(id);
}

export function effective(id = app.currentId) {
  const conv = id ? app.convs.get(id) : null;
  const live = id ? app.live.get(id) : null;
  const meta = { ...(conv?.meta || {}), ...(live?.meta || {}) };
  const init = live?.init || {};
  // meta holds what the user chose last (kept fresh by control calls and status events);
  // init is the snapshot from process start.
  return {
    model: meta.model || init.model || app.prefs.defaultModel || "default",
    effort: meta.effort ?? init.effort ?? (app.prefs.defaultEffort || null),
    permissionMode: meta.permissionMode || init.permissionMode || app.prefs.defaultPermissionMode || "default",
    thinkingEnabled: meta.thinkingEnabled !== false,
    alive: Boolean(live?.alive),
    state: live?.state || conv?.state || "closed",
  };
}

/** The session's options as the server sees them (live meta wins over the conversation's). */
export function effectiveMeta(id = app.currentId) {
  return { ...(app.convs.get(id)?.meta || {}), ...(app.live.get(id)?.meta || {}) };
}

export async function loadConfig() {
  app.config = await api.config();
  return app.config;
}

export async function refreshSessions() {
  try {
    const { sessions } = await api.sessions();
    app.sessions = sessions;
    bus.emit("sessions");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

export async function ensureCatalog(cwd = app.currentCwd || app.config?.defaultCwd, force = false) {
  if (app.catalogLoading && !force) return app.catalog;
  app.catalogLoading = true;
  bus.emit("catalog");
  try {
    app.catalog = await api.catalog(cwd, force);
  } catch (error) {
    toast(`${t("Could not load models and commands")}: ${errorMessage(error)}`, "error");
  } finally {
    app.catalogLoading = false;
    bus.emit("catalog");
  }
  return app.catalog;
}

// Sessions the server did not know when we asked (e.g. after a restart): their stream ended with "gone". They are
// re-attached as soon as the server starts them (global "session.state" event or our own send), otherwise their
// messages would never show up and the conversation would just say "Working…".
const goneStreams = new Set();

function wireStream(id, conv, after) {
  streams.get(id)?.close();
  goneStreams.delete(id);
  const stream = openSessionStream(id, after, {
    onMessage: (entry) => {
      applyMessage(conv, entry.msg, { live: true });
      bus.emit("conv:update", id);
      if (entry.msg.type === "result" || entry.msg.type === "wh_closed") refreshSessionsSoon();
    },
    onGone: () => goneStreams.add(id),
    onReset: () => reloadConversation(id),
  });
  streams.set(id, stream);
}

function reattachIfGone(id) {
  const conv = app.convs.get(id);
  if (conv && goneStreams.has(id)) wireStream(id, conv, 0);
}

// A browser allows only 6 simultaneous connections per site, and every open stream holds one for good. A page that
// followed every conversation it had ever opened (plus the global stream) left nothing for ordinary requests, so
// Settings and other pages hung on "Loading…". Only the current conversation and sessions that are working keep a
// stream (at most MAX_SESSION_STREAMS); the others are closed and re-attached from where they stopped when needed.
const MAX_SESSION_STREAMS = 3;
const streamPosition = new Map(); // id -> last seq seen before its stream was closed to free a connection
const LIVE_STATES = ["starting", "running", "requires_action"];

function syncStreams() {
  const wanted = [...app.convs.keys()]
    .filter((id) => id === app.currentId || LIVE_STATES.includes(app.live.get(id)?.state))
    .sort((a, b) => Number(b === app.currentId) - Number(a === app.currentId))
    .slice(0, MAX_SESSION_STREAMS);
  const keep = new Set(wanted);
  for (const [id, stream] of streams) {
    if (keep.has(id)) continue;
    streamPosition.set(id, stream.seq);
    stream.close();
    streams.delete(id);
  }
  for (const id of keep) if (!streams.has(id)) wireStream(id, app.convs.get(id), streamPosition.get(id) ?? 0);
}

/** Rebuild a cached conversation from the server (history + live buffer) and re-attach its stream. */
export async function reloadConversation(id) {
  const old = app.convs.get(id);
  if (!old) return;
  try {
    await loadConversation(id, old.cwd);
  } catch {
    return; // keep what we have; the next event or reload tries again
  }
  if (app.currentId === id) bus.emit("current");
  bus.emit("conv:update", id);
  bus.emit("live", id);
}

let refreshTimer;
function refreshSessionsSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshSessions, 600);
}

export async function loadConversation(id, cwd) {
  const snap = await api.session(id, cwd);
  const conv = createConversation(id);
  conv.meta = snap.meta || {};
  conv.cwd = snap.cwd;
  conv.title = snap.info?.title || snap.meta?.title || "";
  loadHistory(conv, snap.history || []);
  for (const entry of snap.buffer || []) {
    if (entry.msg.type === "stream_event") continue;
    applyMessage(conv, entry.msg, { live: true });
  }
  if (snap.live) {
    app.live.set(id, snap.live);
    conv.state = snap.live.state;
    for (const request of snap.live.pending || []) conv.requests.set(request.id, request);
  } else {
    conv.state = "closed";
  }
  app.convs.set(id, conv);
  streamPosition.delete(id);
  wireStream(id, conv, snap.seq || 0);
  syncStreams();
  return conv;
}

export async function openSession(id, { cwd } = {}) {
  const previous = { id: app.currentId, cwd: app.currentCwd };
  app.currentId = id;
  if (cwd) app.currentCwd = cwd;
  let conv = app.convs.get(id);
  if (!conv) {
    bus.emit("loading", true);
    try {
      conv = await loadConversation(id, cwd || sessionCwd(id));
    } catch (error) {
      toast(errorMessage(error), "error");
      if (app.currentId === id) { // still the one we tried: go back to what was shown before
        app.currentId = previous.id;
        app.currentCwd = previous.cwd;
      }
      bus.emit("loading", false);
      return null;
    }
    bus.emit("loading", false);
    if (app.currentId !== id) return conv; // the user chose another conversation while this one loaded
  }
  app.currentCwd = conv.cwd || cwd || app.currentCwd;
  location.hash = `#/s/${id}`;
  syncStreams(); // the conversation we now look at gets (back) its stream, replaying what it missed
  bus.emit("current");
  ensureCatalog(app.currentCwd);
  return conv;
}

function sessionCwd(id) {
  return app.sessions.find((session) => session.id === id)?.cwd || app.currentCwd || app.config?.defaultCwd;
}

/** True for folders under the default workspace root (sessions started with "new folder"). */
export function isScratchCwd(cwd) {
  const root = app.config?.workspaceRoot;
  if (!root || !cwd) return false;
  const norm = (path) => String(path).replace(/[\\/]+$/, "").toLowerCase().replaceAll("/", "\\");
  return norm(cwd) === norm(root) || norm(cwd).startsWith(norm(root) + "\\");
}

export async function newSession({ cwd, meta = {} } = {}) {
  // No folder given: follow the preference (a fresh folder like Claude Desktop, or the current project).
  const scratch = Boolean(meta.scratch) || !cwd && (app.prefs.newSessionIn !== "project" || !app.currentCwd || isScratchCwd(app.currentCwd));
  if (scratch) {
    meta = { ...meta, scratch: true };
    cwd = app.config?.workspaceRoot;
  } else if (!cwd) {
    cwd = app.currentCwd || app.config?.defaultCwd;
  }
  const defaults = {
    model: app.prefs.defaultModel !== "default" ? app.prefs.defaultModel : undefined,
    effort: app.prefs.defaultEffort || undefined,
    permissionMode: app.prefs.defaultPermissionMode !== "default" ? app.prefs.defaultPermissionMode : undefined,
    allowBypass: app.prefs.allowBypass || undefined,
  };
  const created = await api.createSession(cwd, { ...defaults, ...meta });
  app.live.set(created.id, created);
  const conv = createConversation(created.id);
  conv.cwd = cwd;
  conv.meta = created.meta || {};
  app.convs.set(created.id, conv);
  wireStream(created.id, conv, 0);
  app.currentId = created.id;
  app.currentCwd = cwd;
  syncStreams();
  location.hash = `#/s/${created.id}`;
  bus.emit("current");
  ensureCatalog(cwd);
  return conv;
}

export async function sendMessage(text, images = [], { priority } = {}) {
  const id = app.currentId;
  if (!id) return;
  const conv = app.convs.get(id);
  try {
    await api.send(id, { text, images, priority, cwd: conv?.cwd || app.currentCwd, meta: conv?.meta });
    reattachIfGone(id); // the server only now created the session object we were waiting for
    if (!app.sessions.some((session) => session.id === id)) refreshSessionsSoon(); // a brand-new session: list it now
  } catch (error) {
    toast(errorMessage(error), "error");
    throw error;
  }
}

export async function interrupt() {
  const id = app.currentId;
  if (!id) return;
  try {
    await api.interrupt(id);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

export async function respondRequest(requestId, answer) {
  const id = app.currentId;
  try {
    await api.respond(id, requestId, answer);
    return true;
  } catch (error) {
    toast(errorMessage(error), "error");
    return false; // the card unlocks so the answer can be retried
  }
}

async function liveControl(op, args, persist) {
  const id = app.currentId;
  if (!id) return;
  const live = app.live.get(id);
  try {
    if (live?.alive) await api.control(id, op, args);
    await api.patchMeta(id, persist);
    const conv = app.convs.get(id);
    if (conv) Object.assign(conv.meta, persist);
    if (live?.meta) Object.assign(live.meta, persist);
    bus.emit("meta", id);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

export const setModel = (model) => liveControl("setModel", { model }, { model });
export const setEffort = (effort) => liveControl("setEffort", { effort }, { effort: effort || null });
export const setPermissionMode = (mode) => liveControl("setPermissionMode", { mode }, { permissionMode: mode });

/**
 * Session-scoped Claude Code settings (fastMode, ultracode, advisorModel...): applied to the running process with
 * applyFlagSettings and kept in meta.settings, which the server passes as `settings` when the process (re)starts.
 * A null value clears the key.
 */
export async function setFlagSettings(settings) {
  const id = app.currentId;
  if (!id) return false;
  try {
    if (app.live.get(id)?.alive) await api.control(id, "applyFlagSettings", { settings });
    const base = effectiveMeta(id).settings;
    const merged = { ...(base && typeof base === "object" ? base : {}), ...settings };
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
    await api.patchMeta(id, { settings: merged });
    const conv = app.convs.get(id);
    if (conv) conv.meta.settings = merged;
    const liveMeta = app.live.get(id)?.meta;
    if (liveMeta) liveMeta.settings = merged;
    bus.emit("meta", id);
    return true;
  } catch (error) {
    toast(errorMessage(error), "error");
    return false;
  }
}

export async function setThinking(enabled) {
  const id = app.currentId;
  if (!id) return;
  try {
    if (app.live.get(id)?.alive) await api.control(id, "setThinking", { enabled });
    await api.patchMeta(id, { thinkingEnabled: enabled });
    const conv = app.convs.get(id);
    if (conv) conv.meta.thinkingEnabled = enabled;
    const liveMeta = app.live.get(id)?.meta; // effective() lets live meta win over the conversation's
    if (liveMeta) liveMeta.thinkingEnabled = enabled;
    bus.emit("meta", id);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

/** Options only the process start can take (dirs, tools, agent...): restart in place. */
export async function applyStartOptions(patch) {
  const id = app.currentId;
  if (!id) return;
  const live = app.live.get(id);
  try {
    if (live?.alive) await api.restart(id, app.currentCwd, patch);
    else await api.patchMeta(id, patch);
    const conv = app.convs.get(id);
    if (conv) Object.assign(conv.meta, patch);
    const liveMeta = app.live.get(id)?.meta;
    if (liveMeta) Object.assign(liveMeta, patch);
    toast(t("Applied. It takes effect for the next message."), "ok");
    bus.emit("meta", id);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

export async function renameSession(id, title) {
  await api.rename(id, title, sessionCwd(id));
  const conv = app.convs.get(id);
  if (conv) conv.title = title;
  await refreshSessions();
  bus.emit("current");
}

export async function promptRename(id) {
  const current = app.sessions.find((session) => session.id === id)?.title || app.convs.get(id)?.title || "";
  const title = await promptDialog({ title: t("Rename session"), value: current, label: t("Title") });
  if (title?.trim()) await renameSession(id, title.trim());
}

/** A session carries at most one tag (the SDK's tagSession); null clears it. */
export async function tagSession(id, tag) {
  const value = String(tag ?? "").trim().slice(0, 40) || null;
  try {
    await api.post(`/api/sessions/${id}/tag`, { tag: value, cwd: sessionCwd(id) });
    await refreshSessions();
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

export async function promptTag(id) {
  const current = app.sessions.find((session) => session.id === id)?.tag || "";
  const tag = await promptDialog({ title: t("Session tag"), label: t("Tag (empty removes it)"), value: current, placeholder: t("e.g. billing, review") });
  if (tag !== null && tag.trim() !== current) await tagSession(id, tag);
}

export async function pinSession(id, pinned) {
  await api.pin(id, pinned);
  await refreshSessions();
}

export async function archiveSession(id, archived) {
  await api.archive(id, archived);
  await refreshSessions();
  if (archived && id === app.currentId) await newSession({});
}

export async function deleteSession(id) {
  const ok = await confirmDialog({ title: t("Delete session"), message: t("This permanently removes the conversation transcript. Files changed by Claude are not touched."), confirmLabel: t("Delete"), danger: true });
  if (!ok) return;
  await api.deleteSession(id, sessionCwd(id));
  streams.get(id)?.close();
  streams.delete(id);
  streamPosition.delete(id);
  goneStreams.delete(id);
  app.convs.delete(id);
  app.live.delete(id);
  await refreshSessions();
  if (id === app.currentId) await newSession({});
}

export async function forkFrom(id, upToMessageId) {
  try {
    const result = await api.fork(id, sessionCwd(id), upToMessageId);
    await refreshSessions();
    toast(t("Forked into a new session"), "ok");
    await openSession(result.sessionId, { cwd: sessionCwd(id) });
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

export async function rewindTo(userMessageId) {
  const id = app.currentId;
  if (!id) return;
  try {
    if (!app.live.get(id)?.alive) await api.startSession(id, app.currentCwd);
    const preview = await api.control(id, "rewind", { userMessageId, dryRun: true });
    if (!preview.canRewind) {
      toast(preview.error || t("These files cannot be rewound."), "error");
      return;
    }
    const files = preview.filesChanged?.length ?? 0;
    const ok = await confirmDialog({
      title: t("Rewind files"),
      message: t("Restore {n} file(s) to how they were at this message? (+{ins} −{del} lines)", { n: files, ins: preview.insertions ?? 0, del: preview.deletions ?? 0 }),
      confirmLabel: t("Rewind"),
      danger: true,
    });
    if (!ok) return;
    await api.control(id, "rewind", { userMessageId, dryRun: false });
    toast(t("Files restored"), "ok");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

export function lastUserUuid() {
  const conv = currentConv();
  return conv ? userItems(conv).at(-1)?.uuid : null;
}

// ---- global events ---------------------------------------------------------------
export function wireGlobalEvents() {
  // A new boot id means the server restarted while this page stayed open: every cached conversation is stale.
  onServerEvent("hello", (data) => {
    if (!data?.boot) return;
    const restarted = app.boot && app.boot !== data.boot;
    app.boot = data.boot;
    if (!restarted) return;
    app.live.clear();
    for (const summary of data.live || []) app.live.set(summary.id, summary);
    for (const id of [...app.convs.keys()]) reloadConversation(id);
    refreshSessionsSoon();
  });
  onServerEvent("session.state", (summary) => {
    app.live.set(summary.id, summary);
    reattachIfGone(summary.id);
    syncStreams(); // a session that starts working gets a stream; one that went idle gives its connection back
    if (summary.state !== "closed" && !app.sessions.some((session) => session.id === summary.id)) refreshSessionsSoon();
    const conv = app.convs.get(summary.id);
    if (conv) {
      // A "new folder" session gets its folder when the first message is sent.
      if (summary.cwd && conv.cwd !== summary.cwd) {
        conv.cwd = summary.cwd;
        if (summary.id === app.currentId) {
          app.currentCwd = summary.cwd;
          bus.emit("meta", summary.id);
        }
      }
      conv.state = summary.state;
      if (summary.state === "closed") conv.requests.clear();
    }
    bus.emit("live", summary.id);
  });
  onServerEvent("session.attention", ({ sessionId, request }) => {
    bus.emit("attention", { sessionId, request });
  });
  onServerEvent("sessions.changed", () => refreshSessionsSoon());
}

export { isBusy };
