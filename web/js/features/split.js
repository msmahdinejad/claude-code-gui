// Split view: a second conversation beside the main one (like parallel sessions in Claude Desktop).
// The main pane is untouched: while a split is open #main becomes a grid (css/features/split.css) and this module adds
// a divider and a pane with its own ChatView, a compact message box and the request cards of ITS conversation.
// app.splitId is what session.js counts in the stream budget; the inspector keeps following the main conversation.
import { h, ibtn, toast, errorMessage, shortPath, debounce, raf } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { commands, registerCommand } from "../core/registry.js";
import { ChatView } from "../chat/view.js";
import { renderRequest } from "../chat/requests.js";
import { isBusy } from "../chat/reducer.js";
import * as session from "../session.js";
import { isShellInput, noteUserMessage } from "./input-more.js";
import { SPLIT_MIN_WINDOW, canSplit, clampSplitWidth, parseStoredId, parseStoredWidth, widthFromPointer } from "../ui/split-logic.js";

const ID_KEY = "wheelhouse-split-id";
const WIDTH_KEY = "wheelhouse-split-width";

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, String(value)); } catch { /* private window: not remembered */ } };

let wantedId = null; // the session chosen for the split pane; kept while the window is too narrow to show it
let shown = false; // the pane is mounted (app.splitId is set exactly then)
let ui = null; // the pane's elements, built on first use
let mainView = null; // the main pane's ChatView (announced by chatpane.js)
let restored = false;
let opening = 0; // token: a newer open request wins over one still loading
let announcedNarrow = false;

const mainEl = () => document.getElementById("main");
const isRtl = () => document.documentElement.dir === "rtl";
const splitConv = () => (app.splitId ? app.convs.get(app.splitId) : null);
const roomFor = () => canSplit({ windowWidth: window.innerWidth, mainWidth: mainEl()?.clientWidth || 0 });

bus.on("chatview", (view) => { mainView = view; });

// ---- public API ---------------------------------------------------------------------
export const isSplitOpen = () => shown;

/** Show `id` beside the main conversation (the sidebar menu, Alt+click on a session row). */
export async function openSplit(id, { cwd, silent = false } = {}) {
  if (!id) return false;
  if (id === app.currentId) {
    if (!silent) toast(t("This conversation is already open in the main pane."), "info");
    return false;
  }
  if (!roomFor()) {
    if (!silent) toast(t("There is not enough room for a split view: it needs a window at least {px}px wide with room for two panes. Widen the window or hide the sidebar or the inspector.", { px: SPLIT_MIN_WINDOW }), "info", 7000);
    return false;
  }
  const token = ++opening;
  const before = app.splitId || null;
  let conv = app.convs.get(id);
  app.splitId = id; // counted in the stream budget while the conversation loads
  if (!conv) {
    try {
      conv = await session.loadConversation(id, cwd || app.sessions.find((entry) => entry.id === id)?.cwd || app.currentCwd);
    } catch (error) {
      if (token === opening) {
        app.splitId = before;
        session.syncStreams();
        if (!silent) toast(errorMessage(error), "error");
      }
      return false;
    }
  }
  if (token !== opening) return false;
  if (id === app.currentId) { // the user opened it as the main conversation meanwhile
    app.splitId = before;
    session.syncStreams();
    return false;
  }
  wantedId = id;
  write(ID_KEY, id);
  mount();
  setPaneConversation(conv);
  session.syncStreams();
  bus.emit("split:change", id);
  return true;
}

/** Close the split pane for good (it is not restored by a reload). */
export function closeSplit() {
  opening += 1;
  wantedId = null;
  write(ID_KEY, null);
  unmount();
  bus.emit("split:change", null);
}

/** Exchange the main and the split conversation without reloading either. */
export async function swapSplit() {
  const id = app.splitId;
  const old = app.currentId;
  const oldConv = old ? app.convs.get(old) : null;
  const newConv = id ? app.convs.get(id) : null;
  if (!shown || !id || !oldConv || !newConv) return;
  saveDraftNow();
  // Each pane remembers where its reader was per conversation: hand those positions over with the conversations.
  if (mainView) {
    mainView.rememberPosition();
    ui.view.rememberPosition();
    const fromMain = mainView.positions.get(old);
    const fromSplit = ui.view.positions.get(id);
    if (fromMain) ui.view.positions.set(old, fromMain);
    if (fromSplit) mainView.positions.set(id, fromSplit);
  }
  app.splitId = old;
  wantedId = old;
  write(ID_KEY, old);
  setPaneConversation(oldConv);
  await session.openSession(id, { cwd: newConv.cwd });
  bus.emit("split:change", old);
}

// ---- mounting -------------------------------------------------------------------------
function mount() {
  const main = mainEl();
  if (!main) return;
  build();
  if (!shown) {
    main.append(ui.divider, ui.pane);
    document.body.classList.add("split-open");
    shown = true;
  }
  const width = clampSplitWidth(parseStoredWidth(read(WIDTH_KEY)), main.clientWidth);
  main.style.setProperty("--split-w", `${width}px`);
  announcedNarrow = false;
}

function unmount() {
  const hadStream = Boolean(app.splitId);
  if (shown) {
    saveDraftNow();
    ui.view.rememberPosition();
    ui.view.conv = null; // the next show rebuilds from the remembered position
    clearInterval(ui.view.timer);
    ui.view.timer = null;
    ui.cards.forEach((el) => el.remove());
    ui.cards.clear();
    ui.divider.remove();
    ui.pane.remove();
    document.body.classList.remove("split-open");
    mainEl()?.style.removeProperty("--split-w");
    shown = false;
  }
  app.splitId = null;
  if (hadStream) session.syncStreams(); // never leave the pane's stream open after it is gone
}

/** The window became too narrow (or wide enough again): hide the pane, or bring it back. */
function fit() {
  if (shown && !roomFor()) {
    opening += 1;
    unmount();
    bus.emit("split:change", null);
    if (!announcedNarrow) toast(t("The split view is hidden because there is not enough room. It comes back when the window is wider."), "info", 6000);
    announcedNarrow = true;
  } else if (!shown && wantedId && roomFor()) {
    if (wantedId === app.currentId) closeSplit();
    else openSplit(wantedId, { silent: true });
  } else if (shown) {
    const main = mainEl();
    const width = clampSplitWidth(parseStoredWidth(read(WIDTH_KEY)), main.clientWidth);
    main.style.setProperty("--split-w", `${width}px`);
  }
}

// ---- the pane ---------------------------------------------------------------------------
function build() {
  if (ui) return;
  const dot = h("span.sb-dot");
  const title = h("strong", { dir: "auto" });
  const sub = h("span.split-sub");
  const badge = h("span.split-badge.hidden", { role: "status" }, icon("help", 12), h("span", t("Waiting for your answer")));
  const head = h(
    "header.split-head",
    dot,
    h("div.split-title", title, sub),
    badge,
    ibtn("refresh", t("Swap with main (open as the main conversation)"), () => swapSplit()),
    ibtn("x", t("Close split view"), () => closeSplit()),
  );

  const chatRoot = h("div.split-chat");
  const view = new ChatView(chatRoot, { onAction: handleAction });
  const empty = h("div.split-empty.hidden", icon("message-square", 22), h("span", t("No messages yet.")));
  chatRoot.append(empty);

  const requestsHost = h("div.split-requests");
  const input = h("textarea.split-input", { rows: 1, dir: "auto", placeholder: t("Message this conversation…"), "aria-label": t("Message") });
  const send = h("button.send-btn.split-send", { type: "button", onclick: () => submit() });
  const limits = t("Attachments, slash commands, @ mentions and the message queue are only available in the main message box.");
  const hint = h("div.split-hint", { title: limits }, icon("info", 12), h("span", t("Enter to send · Shift+Enter for a new line")));
  const box = h("div.split-composer", { title: limits }, input, send);
  const dock = h("div.split-dock", requestsHost, box, hint);

  const pane = h("aside.split-pane", { "aria-label": t("Split view") }, head, chatRoot, dock);
  const divider = h("div.split-divider", { role: "separator", "aria-orientation": "vertical", tabindex: "0", title: t("Drag to resize · double-click to reset"), "aria-label": t("Resize split view") });
  ui = { dot, title, sub, badge, view, empty, requestsHost, input, send, dock, pane, divider, cards: new Map(), headKey: "", shownDraft: null };

  wireDivider(divider);
  input.addEventListener("input", () => { autosize(); refreshInput(); saveDraft(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && !event.shiftKey) {
      const ctrl = event.ctrlKey || event.metaKey;
      if (app.prefs.sendKey === "enter" || ctrl) {
        event.preventDefault();
        submit();
      }
    } else if (event.key === "Escape") {
      const conv = splitConv();
      if (conv && isBusy(conv)) session.interruptTo(app.splitId);
    }
  });
}

/** Point the pane at a conversation (also after a swap): timeline, header, request cards and the draft. */
function setPaneConversation(conv) {
  saveDraftNow();
  if (ui.view.conv !== conv) {
    ui.cards.forEach((el) => el.remove());
    ui.cards.clear();
    ui.view.setConversation(conv);
  }
  loadDraft();
  renderAll();
}

function renderAll() {
  if (!shown) return;
  renderHead();
  renderDock();
  refreshInput();
  const conv = splitConv();
  ui.empty.classList.toggle("hidden", Boolean(conv?.items.length));
}

function renderHead() {
  const conv = splitConv();
  if (!conv) return;
  const listed = app.sessions.find((entry) => entry.id === conv.id);
  const name = listed?.title || conv.title || t("New session");
  const cwd = conv.cwd || listed?.cwd || "";
  const live = app.live.get(conv.id);
  const waiting = conv.requests.size;
  const state = waiting ? "requires_action" : live?.state || conv.state || "closed";
  const key = `${conv.id}|${name}|${cwd}|${state}|${waiting}`;
  if (key === ui.headKey) return;
  ui.headKey = key;
  ui.dot.className = `sb-dot ${state}`;
  ui.title.textContent = name;
  ui.title.title = name;
  ui.sub.replaceChildren(cwd ? h("span", { title: cwd }, icon("folder", 12), session.isScratchCwd(cwd) && cwd === app.config?.workspaceRoot ? t("New folder") : shortPath(cwd, 34)) : "");
  ui.badge.classList.toggle("hidden", !waiting);
}

// The request cards of the split conversation (a background session blocked on an answer can be answered here).
function renderDock() {
  const conv = splitConv();
  if (!conv) return;
  const wanted = [...conv.requests.values()];
  const ids = new Set(wanted.map((request) => request.id));
  for (const [id, el] of ui.cards) {
    if (!ids.has(id)) {
      el.remove();
      ui.cards.delete(id);
    }
  }
  const id = conv.id;
  for (const request of wanted) {
    if (ui.cards.has(request.id)) continue;
    const el = renderRequest(request, { respond: (requestId, answer) => session.respondRequestTo(id, requestId, answer), conv, toolCard: (tool) => ui.view.cardFor(tool).el });
    ui.cards.set(request.id, el);
    ui.requestsHost.append(el);
    el.scrollIntoView?.({ block: "nearest" });
  }
}

const frame = raf(() => renderAll());

// ---- message box -----------------------------------------------------------------------------
const draftKey = (id) => `wheelhouse-draft-${id}`; // the main message box uses the same key: a draft follows a swap

const saveDraft = debounce(() => saveDraftNow(), 250);

function saveDraftNow() {
  if (!ui?.shownDraft) return;
  write(draftKey(ui.shownDraft), ui.input.value || null);
}

function loadDraft() {
  const id = app.splitId;
  if (ui.shownDraft === id) return;
  ui.shownDraft = id;
  ui.input.value = id ? read(draftKey(id)) || "" : "";
  autosize();
}

function autosize() {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 200)}px`;
}

function refreshInput() {
  const conv = splitConv();
  const busy = conv ? isBusy(conv) && conv.state !== "starting" : false;
  const hasText = Boolean(ui.input.value.trim());
  const stop = busy && !hasText;
  ui.send.classList.toggle("stop", stop);
  ui.send.replaceChildren(icon(stop ? "stop" : "arrow-up", stop ? 15 : 17));
  ui.send.disabled = !busy && !hasText;
  ui.send.title = stop ? t("Stop") : t("Send");
  ui.send.setAttribute("aria-label", ui.send.title);
}

async function submit() {
  const id = app.splitId;
  const conv = splitConv();
  if (!id || !conv) return;
  const busy = isBusy(conv) && conv.state !== "starting";
  const text = ui.input.value.trim();
  if (!text) {
    if (busy) session.interruptTo(id);
    return;
  }
  // What only the main message box can do: say so instead of sending it to Claude as plain text.
  const slash = /^\/(\S+)/.exec(text)?.[1];
  if (isShellInput(text) || (slash && commands.some((entry) => entry.slash === slash || entry.slashAliases?.includes(slash)))) {
    toast(t("Attachments, slash commands, @ mentions and the message queue are only available in the main message box."), "info");
    return;
  }
  ui.input.value = "";
  autosize();
  saveDraftNow();
  refreshInput();
  noteUserMessage(id);
  try {
    await session.sendMessageTo(id, text);
  } catch {
    // sendMessageTo already showed the error; hand the text back so nothing typed is lost
    if (app.splitId === id && !ui.input.value.trim()) {
      ui.input.value = text;
      autosize();
      refreshInput();
    }
  }
}

async function handleAction(action, item) {
  const id = app.splitId;
  try {
    if (action === "fork") await session.forkFrom(id, item.uuid);
    else if (action === "resend") {
      ui.input.value = item.text || "";
      autosize();
      refreshInput();
      ui.input.focus();
    } else if (action === "rewind") toast(t("Rewinding files is available in the main pane. Swap the panes first."), "info");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

// ---- divider ---------------------------------------------------------------------------------
function wireDivider(divider) {
  const apply = (width, persist) => {
    const main = mainEl();
    const clamped = clampSplitWidth(width, main.clientWidth);
    main.style.setProperty("--split-w", `${clamped}px`);
    if (persist) write(WIDTH_KEY, clamped);
    return clamped;
  };
  divider.addEventListener("pointerdown", (event) => {
    if (event.button) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("dragging");
    document.body.classList.add("split-dragging");
    let last = null;
    const move = (e) => { last = apply(widthFromPointer(e.clientX, mainEl().getBoundingClientRect(), isRtl())); };
    const up = () => {
      divider.classList.remove("dragging");
      document.body.classList.remove("split-dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      divider.removeEventListener("pointercancel", up);
      if (last !== null) write(WIDTH_KEY, last);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
  });
  divider.addEventListener("dblclick", () => { apply(null, false); write(WIDTH_KEY, null); });
  divider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const grow = (event.key === "ArrowLeft") !== isRtl(); // the pane sits at the inline end: its edge moves toward the start to grow it
    const current = parseFloat(mainEl().style.getPropertyValue("--split-w")) || ui.pane.getBoundingClientRect().width;
    apply(current + (grow ? 24 : -24), true);
  });
}

// ---- wiring ----------------------------------------------------------------------------------
function restore() {
  restored = true;
  const id = parseStoredId(read(ID_KEY));
  if (!id) return;
  // A session that no longer exists (or is the main one now) is dropped without a word.
  if (id === app.currentId || !app.sessions.some((entry) => entry.id === id)) {
    write(ID_KEY, null);
    return;
  }
  wantedId = id;
  if (roomFor()) openSplit(id, { silent: true }).then((ok) => { if (!ok && !shown && wantedId === id && roomFor()) closeSplit(); });
}

bus.on("current", () => {
  if (!restored) restore();
  else if (wantedId && app.currentId === wantedId) closeSplit(); // never the same conversation twice
});

bus.on("conv:update", (id) => {
  if (!shown || id !== app.splitId) return;
  const conv = app.convs.get(id);
  if (conv && ui.view.conv !== conv) setPaneConversation(conv); // reloaded from the server: a new object
  else ui.view.sync();
  frame();
});
bus.on("live", (id) => {
  if (!shown || id !== app.splitId) return;
  ui.view.sync();
  renderAll();
});
for (const name of ["sessions", "meta", "prefs"]) bus.on(name, () => { if (shown) { ui.view.sync(); renderAll(); } });
bus.on("sessions", () => {
  // The session was deleted (here or elsewhere): there is nothing left to show.
  if (wantedId && !app.sessions.some((entry) => entry.id === wantedId) && !app.convs.has(wantedId)) closeSplit();
});

window.addEventListener("resize", () => fit());
const watchMain = () => {
  const main = mainEl();
  if (!main || typeof ResizeObserver === "undefined") return;
  new ResizeObserver(raf(() => fit())).observe(main);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchMain, { once: true });
else watchMain();

registerCommand({
  id: "split-close",
  title: "Close split view",
  icon: "panel-right",
  keywords: ["split", "side by side", "parallel", "second conversation"],
  when: () => shown,
  run: () => closeSplit(),
});

