// SDK-backed Claude sessions. One persistent `claude` process (streaming input) per
// active session. Raw SDK messages are forwarded unchanged to subscribers; only a few
// synthetic `wh_*` messages are added (user echo, permission/dialog requests, lifecycle).
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./async-queue.mjs";

const MAX_BUFFER = 6000;
const MAX_STREAM_EVENTS = 300;
const MAX_STDERR_LINES = 300;
const IDLE_CLOSE_MS = 25 * 60 * 1000;

function publicRequest(options) {
  const { signal, ...rest } = options || {};
  return rest;
}

export class ClaudeSession extends EventEmitter {
  constructor(manager, meta) {
    super();
    this.setMaxListeners(50);
    this.manager = manager;
    this.id = meta.id;
    this.cwd = meta.cwd;
    this.meta = { ...meta };
    this.persisted = Boolean(meta.persisted); // transcript exists on disk
    this.seq = 0;
    this.buffer = [];
    this.streamEvents = 0;
    this.pending = new Map(); // permission / dialog requests
    this.state = "closed"; // closed | starting | idle | running | requires_action
    this.init = null;
    this.initResult = null;
    this.input = null;
    this.query = null;
    this.stderr = [];
    this.lastActive = Date.now();
    this.startError = null;
    this.runningSince = null;
    this.lastResult = null;
  }

  get alive() {
    return Boolean(this.query);
  }

  summary() {
    return {
      id: this.id,
      cwd: this.cwd,
      state: this.state,
      alive: this.alive,
      pending: [...this.pending.values()].map((entry) => entry.request),
      meta: this.meta,
      init: this.init || this.initResult
        ? {
            model: this.init?.model ?? this.meta.model ?? null,
            permissionMode: this.init?.permissionMode ?? this.meta.permissionMode ?? this.initResult?.current_permission_mode ?? null,
            effort: this.init?.effort ?? this.meta.effort ?? null,
            tools: this.init?.tools,
            skills: this.init?.skills,
            mcp_servers: this.init?.mcp_servers,
            plugins: this.init?.plugins,
            output_style: this.init?.output_style ?? this.initResult?.output_style,
            fast_mode_state: this.init?.fast_mode_state ?? this.initResult?.fast_mode_state,
            claude_code_version: this.init?.claude_code_version ?? this.initResult?.claude_code_version,
          }
        : null,
      lastResult: this.lastResult,
      seq: this.seq,
      startError: this.startError,
    };
  }

  // ---- event plumbing ------------------------------------------------------------
  emitMessage(msg) {
    const entry = { seq: ++this.seq, msg };
    if (msg.type === "stream_event") {
      this.streamEvents += 1;
      if (this.streamEvents > MAX_STREAM_EVENTS) {
        const index = this.buffer.findIndex((item) => item.msg.type === "stream_event");
        if (index >= 0) {
          this.buffer.splice(index, 1);
          this.streamEvents -= 1;
        }
      }
    }
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    this.emit("event", entry);
    return entry;
  }

  eventsAfter(after = 0) {
    return this.buffer.filter((entry) => entry.seq > after);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (state === "running") this.runningSince = Date.now();
    this.manager.emit("session.state", this.summary());
  }

  // ---- lifecycle -----------------------------------------------------------------
  buildOptions() {
    const meta = this.meta;
    const { claudeBin, systemPromptAppend } = this.manager.config;
    const options = {
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      ...(claudeBin?.endsWith(".js") ? { executable: "node" } : {}),
      cwd: this.cwd,
      env: { ...process.env, ...(meta.env || {}) },
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      includeHookEvents: true,
      enableFileCheckpointing: true,
      promptSuggestions: true,
      agentProgressSummaries: true,
      thinking: meta.thinking || { type: "adaptive", display: "summarized" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...((meta.appendPrompt ?? systemPromptAppend) ? { append: meta.appendPrompt ?? systemPromptAppend } : {}),
      },
      canUseTool: (toolName, input, opts) => this.requestPermission(toolName, input, opts),
      onElicitation: (request, opts) => this.requestElicitation(request, opts),
      onUserDialog: (request, opts) => this.requestDialog(request, opts),
      supportedDialogKinds: ["generic"],
      stderr: (line) => {
        this.stderr.push(line);
        if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
      },
    };
    if (this.persisted) options.resume = this.id;
    else options.sessionId = this.id;
    if (meta.forkFrom) {
      options.resume = meta.forkFrom;
      options.forkSession = true;
      delete options.sessionId;
    }
    if (meta.model && meta.model !== "default") options.model = meta.model;
    if (meta.effort) options.effort = meta.effort;
    if (meta.permissionMode) options.permissionMode = meta.permissionMode;
    if (meta.allowBypass) options.allowDangerouslySkipPermissions = true;
    if (meta.addDirs?.length) options.additionalDirectories = meta.addDirs;
    if (meta.allowedTools?.length) options.allowedTools = meta.allowedTools;
    if (meta.disallowedTools?.length) options.disallowedTools = meta.disallowedTools;
    if (meta.fallbackModel) options.fallbackModel = meta.fallbackModel;
    if (meta.maxTurns) options.maxTurns = meta.maxTurns;
    if (meta.maxBudgetUsd) options.maxBudgetUsd = meta.maxBudgetUsd;
    if (meta.agent) options.agent = meta.agent;
    if (meta.agents) options.agents = meta.agents;
    if (meta.mcpServers) options.mcpServers = meta.mcpServers;
    if (meta.strictMcpConfig) options.strictMcpConfig = true;
    if (meta.plugins?.length) options.plugins = meta.plugins.map((path) => ({ type: "local", path }));
    if (meta.settings) options.settings = meta.settings;
    if (meta.betas?.length) options.betas = meta.betas;
    if (meta.extraArgs && typeof meta.extraArgs === "object") options.extraArgs = { ...(options.extraArgs || {}), ...meta.extraArgs };
    if (meta.worktree) options.extraArgs = { ...(options.extraArgs || {}), worktree: meta.worktree === true ? null : meta.worktree };
    return options;
  }

  async start() {
    if (this.query) return;
    this.startError = null;
    this.setState("starting");
    this.input = new AsyncQueue();
    const options = this.buildOptions();
    try {
      this.query = sdkQuery({ prompt: this.input, options });
    } catch (error) {
      this.query = null;
      this.startError = error.message;
      this.setState("closed");
      throw error;
    }
    this.pump(this.query).catch(() => {});
    try {
      this.initResult = await withTimeout(this.query.initializationResult(), 120_000, "initialize timed out");
      this.setState(this.state === "starting" ? "idle" : this.state);
    } catch (error) {
      this.startError = error.message;
      this.emitMessage({ type: "wh_error", where: "start", message: error.message, stderr: this.stderr.slice(-20) });
      this.close();
      throw error;
    }
  }

  async pump(q) {
    try {
      for await (const msg of q) {
        this.lastActive = Date.now();
        this.handleMessage(msg);
      }
    } catch (error) {
      if (this.query === q) {
        this.emitMessage({ type: "wh_error", where: "stream", message: error.message, stderr: this.stderr.slice(-20) });
      }
    } finally {
      if (this.query === q) {
        this.query = null;
        this.input = null;
        this.cancelAllPending("session closed");
        this.setState("closed");
        this.emitMessage({ type: "wh_closed" });
      }
    }
  }

  handleMessage(msg) {
    if (msg.type === "system" && msg.subtype === "init") {
      this.init = msg;
      this.persisted = true;
      this.meta.model = this.meta.model && this.meta.model !== "default" ? this.meta.model : msg.model;
    } else if (msg.type === "system" && msg.subtype === "session_state_changed") {
      this.setState(msg.state);
    } else if (msg.type === "result") {
      this.lastResult = {
        is_error: msg.is_error,
        subtype: msg.subtype,
        total_cost_usd: msg.total_cost_usd,
        duration_ms: msg.duration_ms,
        num_turns: msg.num_turns,
        usage: msg.usage,
        modelUsage: msg.modelUsage,
        stop_reason: msg.stop_reason,
      };
      this.persisted = true;
      if (this.state === "running") this.setState("idle");
      if (!msg.is_error && !this.titleOffered) {
        this.titleOffered = true;
        this.manager.emit("session.first-result", this);
      }
    } else if (msg.type === "system" && msg.subtype === "status" && msg.permissionMode) {
      if (this.init) this.init.permissionMode = msg.permissionMode;
      this.meta.permissionMode = msg.permissionMode;
      this.manager.emit("session.state", this.summary());
    }
    this.emitMessage(msg);
  }

  close() {
    const q = this.query;
    this.query = null;
    const input = this.input;
    this.input = null;
    this.cancelAllPending("session closed");
    try { input?.close(); } catch { /* already closed */ }
    try { q?.close(); } catch { /* already closed */ }
    this.setState("closed");
  }

  async restart(patch = {}) {
    Object.assign(this.meta, patch);
    this.close();
    await this.start();
  }

  // ---- user input ----------------------------------------------------------------
  async ensureStarted() {
    if (!this.query) await this.start();
  }

  async sendUser({ text = "", images = [], priority, uuid } = {}) {
    await this.ensureStarted();
    const content = [];
    for (const image of images) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
    }
    if (text) content.push({ type: "text", text });
    if (!content.length) throw new Error("empty message");
    const messageUuid = uuid || randomUUID();
    const message = {
      type: "user",
      uuid: messageUuid,
      session_id: this.id,
      parent_tool_use_id: null,
      origin: { kind: "human" },
      message: { role: "user", content: content.length === 1 && content[0].type === "text" ? text : content },
      ...(priority ? { priority } : {}),
    };
    this.lastActive = Date.now();
    this.emitMessage({
      type: "wh_user_message",
      uuid: messageUuid,
      text,
      images: images.map((image) => ({ mediaType: image.mediaType, name: image.name, data: image.data })),
      priority: priority || null,
      at: Date.now(),
    });
    if (this.state === "idle") this.setState("running");
    this.input.push(message);
    return { uuid: messageUuid };
  }

  async interrupt() {
    if (!this.query) return { interrupted: false };
    const receipt = await this.query.interrupt();
    return { interrupted: true, receipt: receipt || null };
  }

  // ---- control -------------------------------------------------------------------
  async control(op, args = {}) {
    const q = this.query;
    const needsLive = !["setMeta"].includes(op);
    if (needsLive && !q) throw new Error("session is not running");
    switch (op) {
      case "setModel":
        await q.setModel(args.model === "default" ? undefined : args.model);
        this.meta.model = args.model;
        return { ok: true };
      case "setPermissionMode":
        await q.setPermissionMode(args.mode);
        this.meta.permissionMode = args.mode;
        if (this.init) this.init.permissionMode = args.mode;
        return { ok: true };
      case "setEffort":
        await q.applyFlagSettings({ effortLevel: args.effort || null });
        this.meta.effort = args.effort || null;
        return { ok: true };
      case "setThinking": {
        const tokens = args.enabled === false ? 0 : null;
        await q.setMaxThinkingTokens(tokens, args.display);
        this.meta.thinkingEnabled = args.enabled !== false;
        return { ok: true };
      }
      case "applyFlagSettings":
        await q.applyFlagSettings(args.settings || {});
        return { ok: true };
      case "context":
        return q.getContextUsage();
      case "usage":
        return q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      case "commands":
        return q.supportedCommands();
      case "models":
        return q.supportedModels();
      case "agents":
        return q.supportedAgents();
      case "mcpStatus":
        return q.mcpServerStatus();
      case "mcpToggle":
        await q.toggleMcpServer(args.name, Boolean(args.enabled));
        return { ok: true };
      case "mcpReconnect":
        await q.reconnectMcpServer(args.name);
        return { ok: true };
      case "mcpSetServers":
        return q.setMcpServers(args.servers || {});
      case "reloadPlugins":
        return q.reloadPlugins(args.options);
      case "reloadSkills":
        return q.reloadSkills();
      case "reloadOutputStyles":
        return q.reloadOutputStyles();
      case "account":
        return q.accountInfo();
      case "rewind":
        return q.rewindFiles(args.userMessageId, { dryRun: Boolean(args.dryRun) });
      case "stopTask":
        await q.stopTask(args.taskId);
        return { ok: true };
      case "backgroundTasks":
        return { backgrounded: await q.backgroundTasks(args.toolUseId) };
      case "readFile":
        return q.readFile(args.path, args.options);
      case "updateSettings":
        await q.updateSettings(args.source, args.settings || {});
        return { ok: true };
      case "mcpPermissionOverride":
        return q.setMcpPermissionModeOverride(args.name, args.mode ?? null);
      default:
        throw new Error(`unknown control op: ${op}`);
    }
  }

  // ---- permission / dialogs ------------------------------------------------------
  requestPermission(toolName, input, opts) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const request = {
        id,
        kind: "permission",
        toolName,
        input,
        ...publicRequest(opts),
        at: Date.now(),
      };
      this.registerPending(id, request, resolve, opts?.signal, () => ({ behavior: "deny", message: "Request cancelled" }));
    });
  }

  requestElicitation(requestData, opts) {
    return new Promise((resolve) => {
      const id = opts?.requestId || randomUUID();
      const request = { id, kind: "elicitation", ...requestData, at: Date.now() };
      this.registerPending(id, request, resolve, opts?.signal, () => ({ action: "cancel" }));
    });
  }

  requestDialog(requestData, opts) {
    return new Promise((resolve) => {
      const id = opts?.requestId || randomUUID();
      const request = { id, kind: "dialog", ...requestData, at: Date.now() };
      this.registerPending(id, request, resolve, opts?.signal, () => ({ behavior: "cancelled" }));
    });
  }

  registerPending(id, request, resolve, signal, onCancel) {
    const entry = { request, resolve, onCancel };
    this.pending.set(id, entry);
    this.emitMessage({ type: "wh_request", request });
    this.manager.emit("session.attention", { sessionId: this.id, request });
    this.manager.emit("session.state", this.summary());
    signal?.addEventListener(
      "abort",
      () => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        this.emitMessage({ type: "wh_request_resolved", id, cancelled: true });
        resolve(onCancel());
        this.manager.emit("session.state", this.summary());
      },
      { once: true },
    );
  }

  respond(id, answer) {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("request is no longer pending");
    this.pending.delete(id);
    this.emitMessage({ type: "wh_request_resolved", id, answer: summarizeAnswer(answer) });
    entry.resolve(answer);
    this.manager.emit("session.state", this.summary());
  }

  cancelAllPending(reason) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      try { entry.resolve(entry.onCancel()); } catch { /* ignore */ }
      this.emitMessage({ type: "wh_request_resolved", id, cancelled: true, reason });
    }
  }
}

function summarizeAnswer(answer) {
  if (!answer || typeof answer !== "object") return null;
  return { behavior: answer.behavior, action: answer.action, message: answer.message };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class SessionManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.sessions = new Map();
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].map((session) => session.summary());
  }

  /** Get or create the in-memory session object (does not spawn the process). */
  open({ id, cwd, persisted = false, meta = {} }) {
    let session = this.sessions.get(id);
    if (session) {
      if (cwd && session.cwd !== cwd && !session.alive) session.cwd = cwd;
      return session;
    }
    session = new ClaudeSession(this, { ...meta, id, cwd, persisted });
    this.sessions.set(id, session);
    return session;
  }

  create({ cwd, meta = {} }) {
    return this.open({ id: randomUUID(), cwd, persisted: false, meta });
  }

  reapIdle() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.alive || session.state === "running" || session.pending.size) continue;
      if (session.listenerCount("event") > 0) continue;
      if (now - session.lastActive > IDLE_CLOSE_MS) session.close();
    }
  }

  /** Stop every Claude process but keep the manager running (used when switching profiles). */
  closeSessions() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  closeAll() {
    clearInterval(this.reaper);
    for (const session of this.sessions.values()) session.close();
  }
}
