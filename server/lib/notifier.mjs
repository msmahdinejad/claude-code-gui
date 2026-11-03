// Turns session activity into "Claude needs you" notifications: a turn finished, or Claude waits for an approval, an
// answer or a plan review. The tray (server/tray/tray.ps1) polls them and shows native Windows notifications, so they
// arrive even when the app window is closed; pages without a tray show them with the browser Notification API.
import { EventEmitter } from "node:events";
import { basename } from "node:path";

const MAX_ITEMS = 50;
const PRESENCE_TTL_MS = 25_000; // the page re-sends its presence every ~10 s while it has focus

const TEXT = {
  en: {
    done: "Claude finished",
    failed: "Claude stopped with an error",
    approval: "Needs your approval",
    question: "Claude has a question",
    plan: "Plan ready for your review",
    input: "Claude needs your input",
    test: "Notifications are working.",
  },
  fa: {
    done: "کار Claude تمام شد",
    failed: "کار Claude با خطا متوقف شد",
    approval: "منتظر تأیید شماست",
    question: "Claude سوالی دارد",
    plan: "طرح برای بررسی شما آماده است",
    input: "Claude به پاسخ شما نیاز دارد",
    test: "اعلان‌ها کار می‌کنند.",
  },
};

const clip = (text, max = 160) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The last thing Claude said in the session, as plain text (what a "finished" notification shows). */
function lastAssistantText(session) {
  for (let i = (session?.buffer.length ?? 0) - 1; i >= 0; i -= 1) {
    const msg = session.buffer[i].msg;
    if (msg.type === "user" || msg.type === "wh_user_message") break;
    if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) continue;
    const text = msg.message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
    if (text.trim()) return text;
  }
  return "";
}

/** One line about what a permission request is for ("npm test", a file path, a URL…). */
function describeTool(input) {
  const file = input?.file_path ?? input?.path;
  if (typeof file === "string") return clip(folderName(file), 110); // the file name; the full path is in the app
  const value = input?.command ?? input?.url ?? input?.pattern ?? input?.description;
  return typeof value === "string" ? clip(value, 110) : "";
}

export class Notifier extends EventEmitter {
  /**
   * @param manager  SessionManager (emits session.state / session.attention)
   * @param prefs    () => saved UI preferences
   * @param titleOf  (sessionId) => name to show for the session
   */
  constructor({ manager, prefs, titleOf }) {
    super();
    this.manager = manager;
    this.prefs = prefs;
    this.titleOf = titleOf;
    this.items = [];
    this.cursor = 0;
    this.presence = null; // { focused, sessionId, at } reported by the page
    this.states = new Map();
    manager.on("session.state", (summary) => this.onState(summary));
    manager.on("session.attention", ({ sessionId, request }) => this.onAttention(sessionId, request));
  }

  /** The page says whether it has focus and which conversation is open, so we do not announce what the user is reading. */
  setPresence({ focused, sessionId, lang }) {
    this.presence = { focused: Boolean(focused), sessionId: sessionId ? String(sessionId) : null, at: Date.now() };
    if (lang === "fa" || lang === "en") this.lang = lang;
  }

  get text() {
    return TEXT[this.lang || this.prefs().uiLang] || TEXT.en;
  }

  watching(sessionId) {
    const p = this.presence;
    return Boolean(p?.focused && p.sessionId === sessionId && Date.now() - p.at < PRESENCE_TTL_MS);
  }

  onState(summary) {
    const before = this.states.get(summary.id);
    this.states.set(summary.id, summary.state);
    if (before !== "running" || summary.state !== "idle") return;
    const failed = Boolean(summary.lastResult?.is_error);
    const body = failed ? this.text.failed : clip(lastAssistantText(this.manager.get(summary.id))) || this.text.done;
    this.push({ kind: failed ? "failed" : "done", sessionId: summary.id, body });
  }

  onAttention(sessionId, request) {
    const text = this.text;
    let kind = "approval";
    let body = text.approval;
    if (request.kind === "permission") {
      if (request.toolName === "AskUserQuestion") {
        kind = "question";
        body = clip(request.input?.questions?.[0]?.question) || text.question;
      } else if (request.toolName === "ExitPlanMode") {
        kind = "plan";
        body = text.plan;
      } else {
        const detail = describeTool(request.input);
        body = `${request.toolName}${detail ? `: ${detail}` : ""}`;
      }
    } else {
      kind = "question";
      body = clip(request.message || request.title) || text.input;
    }
    this.push({ kind, sessionId, body });
  }

  push({ kind, sessionId, body, force = false }) {
    if (!force && (this.prefs().notifications === false || this.watching(sessionId))) return null;
    const item = {
      id: (this.cursor += 1),
      kind,
      sessionId: sessionId || null,
      title: (sessionId && this.titleOf(sessionId)) || "Wheelhouse",
      body,
      at: Date.now(),
    };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    this.emit("notification", item);
    return item;
  }

  test() {
    return this.push({ kind: "test", sessionId: null, body: this.text.test, force: true });
  }

  /** Notifications after `since`; without a cursor only the current one is returned (a new tray must not replay history). */
  after(since) {
    return { cursor: this.cursor, items: Number.isFinite(since) ? this.items.filter((item) => item.id > since) : [] };
  }
}

export const folderName = (cwd) => (cwd ? basename(String(cwd).replace(/[\\/]+$/, "")) : "");
