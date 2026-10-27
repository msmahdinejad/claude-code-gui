// Extra routes for the settings editors: gateway-related process env (values redacted
// unless harmless) and the list of hook events / known setting keys.
const VISIBLE = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CONFIG_DIR", "CLAUDE_BIN", "NO_PROXY", "no_proxy", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]);
const WATCHED = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CONFIG_DIR", "CLAUDE_BIN", "CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "no_proxy",
];

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return "(set)";
  }
}

export default function register({ route, resolve, config }) {
  route("GET", "/api/settings-effective", async ({ query }) => {
    const { resolveSettings } = await import("@anthropic-ai/claude-agent-sdk");
    const result = await resolveSettings({ cwd: resolve(query.get("cwd") || process.cwd()), settingSources: ["user", "project", "local"] });
    return {
      effective: result.effective,
      provenance: result.provenance,
      sources: (result.sources || []).map((entry) => ({ source: entry.source, path: entry.path, keys: Object.keys(entry.settings || {}) })),
    };
  });

  route("GET", "/api/env-info", async () => {
    // Variables defined by the active profile are listed too (their values stay hidden unless known to be harmless).
    const names = [...new Set([...WATCHED, ...Object.keys(config.profiles[config.activeProfile]?.env || {})])];
    const entries = names.map((name) => {
      const raw = process.env[name];
      if (raw === undefined || raw === "") return { name, set: false };
      if (VISIBLE.has(name)) return { name, set: true, value: raw };
      if (/PROXY$/i.test(name)) return { name, set: true, value: redactUrl(raw) };
      return { name, set: true, value: null }; // secret: never sent to the browser
    });
    return { entries };
  });
}
