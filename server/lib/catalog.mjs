// Catalog of what the CLI offers for a working directory: models, slash commands/skills,
// agents, MCP servers, account. Read from a short-lived idle SDK session (no model call)
// or from a live session when one exists. Cached per cwd.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./async-queue.mjs";

const TTL_MS = 5 * 60 * 1000;

export class Catalog {
  constructor(config, manager) {
    this.config = config;
    this.manager = manager;
    this.cache = new Map(); // cwd -> { at, data }
    this.inflight = new Map();
  }

  async get(cwd, { force = false } = {}) {
    const key = cwd || this.config.defaultCwd;
    const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.data;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = this.load(key)
      .then((data) => {
        this.cache.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate() {
    this.cache.clear();
  }

  async load(cwd) {
    const live = [...this.manager.sessions.values()].find((session) => session.alive && session.cwd === cwd && session.initResult);
    if (live) return this.fromLive(live);
    const input = new AsyncQueue();
    const q = sdkQuery({
      prompt: input,
      options: {
        ...(this.config.claudeBin ? { pathToClaudeCodeExecutable: this.config.claudeBin } : {}),
        ...(this.config.claudeBin?.endsWith(".js") ? { executable: "node" } : {}),
        cwd,
        env: { ...process.env },
        settingSources: ["user", "project", "local"],
        persistSession: false,
      },
    });
    const timer = setTimeout(() => q.close(), 120_000);
    try {
      const init = await q.initializationResult();
      const [mcp, agents, commands] = await Promise.allSettled([q.mcpServerStatus(), q.supportedAgents(), q.supportedCommands()]);
      return shape(init, {
        mcp: mcp.status === "fulfilled" ? mcp.value : [],
        agents: agents.status === "fulfilled" ? agents.value : init.agents || [],
        commands: commands.status === "fulfilled" ? commands.value : init.commands || [],
      });
    } finally {
      clearTimeout(timer);
      input.close();
      q.close();
    }
  }

  async fromLive(session) {
    const q = session.query;
    const init = session.initResult;
    const [mcp, agents, commands] = await Promise.allSettled([q.mcpServerStatus(), q.supportedAgents(), q.supportedCommands()]);
    return shape(init, {
      mcp: mcp.status === "fulfilled" ? mcp.value : [],
      agents: agents.status === "fulfilled" ? agents.value : init.agents || [],
      commands: commands.status === "fulfilled" ? commands.value : init.commands || [],
    });
  }
}

function shape(init, extra) {
  return {
    models: init.models || [],
    commands: extra.commands,
    agents: extra.agents,
    mcp: extra.mcp,
    account: init.account || null,
    outputStyle: init.output_style,
    availableOutputStyles: init.available_output_styles || [],
    permissionMode: init.current_permission_mode,
    claudeCodeVersion: init.claude_code_version,
    fastMode: { state: init.fast_mode_state, disabledReason: init.fast_mode_disabled_reason },
    capabilities: init.capabilities || [],
    loadedAt: Date.now(),
  };
}
