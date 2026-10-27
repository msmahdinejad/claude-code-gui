// Configuration: file + CLI flags + environment, and "profiles" (which Claude Code executable to run and with
// what environment). A profile is how Wheelhouse is pointed at a gateway, a wrapper script or another
// Claude Code installation. See docs/CONFIGURATION.md.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_SYSTEM_PROMPT =
  "Reply in the language the user writes in. Keep code, shell commands, file paths and identifiers unchanged, in their original left-to-right form. Use clear, well-structured Markdown.";

/** JSON with // and /* *\/ comments and trailing commas. */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** ${VAR} and ${VAR:-fallback} from `env`; a leading ~ expands to the home directory. */
export function interpolate(value, env, { home = true } = {}) {
  if (typeof value !== "string") return value;
  let out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => env[name] ?? fallback ?? "");
  if (home && (out === "~" || out.startsWith("~/") || out.startsWith("~\\"))) out = join(homedir(), out.slice(1));
  return out;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { args._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split("=");
    const flag = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) args[flag] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--") && !["open", "app", "tray", "help", "version"].includes(flag)) args[flag] = argv[++i];
    else args[flag] = true;
  }
  return args;
}

function findConfigFile(args, env, { home, cwd }) {
  const candidates = [args.config, env.WHEELHOUSE_CONFIG, resolve(cwd, "wheelhouse.config.json"), join(home, ".wheelhouse", "config.json")].filter(Boolean);
  return candidates.find((path) => existsSync(path)) || null;
}

/** Locate an executable the SDK can spawn. Returns { path, source, problem? }. */
export function resolveCommand(command, env = process.env) {
  const win = process.platform === "win32";
  const exts = win ? [".exe"] : [""];
  const wanted = command || "claude";
  const tryPath = (candidate) => {
    for (const ext of exts) {
      const full = candidate.toLowerCase().endsWith(ext) || !ext ? candidate : candidate + ext;
      try { if (statSync(full).isFile()) return full; } catch { /* keep looking */ }
    }
    return null;
  };
  if (isAbsolute(wanted) || /[\\/]/.test(wanted)) {
    const found = tryPath(resolve(wanted));
    if (found) return { path: found, source: command ? "config" : "path" };
    return { path: null, source: "config", problem: `Executable not found: ${wanted}` };
  }
  for (const dir of (env.PATH || env.Path || "").split(delimiter).filter(Boolean)) {
    const found = tryPath(join(dir, wanted));
    if (found) return { path: found, source: "path" };
    if (win) {
      // npm global installs expose claude.cmd; the real binary lives next to it.
      for (const shim of [".cmd", ".ps1", ""]) {
        if (!existsSync(join(dir, wanted + shim))) continue;
        const native = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (existsSync(native)) return { path: native, source: "path" };
      }
    }
  }
  if (!command) return { path: null, source: "bundled" }; // fall back to the binary shipped with the SDK
  return { path: null, source: "config", problem: `Command not found on PATH: ${wanted}` };
}

function normalizeProfile(name, raw, baseline) {
  const env = {};
  for (const [key, value] of Object.entries(raw.env || {})) env[key] = interpolate(String(value), baseline, { home: false });
  return {
    name,
    label: raw.label || name,
    description: raw.description || "",
    command: raw.command ? interpolate(raw.command, baseline) : "",
    cli: raw.cli || raw.command || "claude",
    configDir: raw.configDir ? resolve(interpolate(raw.configDir, baseline)) : "",
    env,
    unset: Array.isArray(raw.unset) ? raw.unset : [],
    proxyBypass: Array.isArray(raw.proxyBypass) ? raw.proxyBypass : [],
  };
}

/** `home` and `cwd` are injectable for tests. */
export function loadConfig({ argv = process.argv.slice(2), env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const baseline = { ...env };
  const file = findConfigFile(args, env, { home, cwd });
  let raw = {};
  if (file) {
    try {
      raw = parseJsonc(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read config ${file}: ${error.message}`, { cause: error });
    }
  }
  const rawProfiles = raw.profiles && Object.keys(raw.profiles).length ? raw.profiles : { default: { label: "Claude Code", ...(env.CLAUDE_BIN ? { command: env.CLAUDE_BIN } : {}) } };
  const profiles = Object.fromEntries(Object.entries(rawProfiles).map(([name, profile]) => [name, normalizeProfile(name, profile, baseline)]));
  const defaultProfile = profiles[raw.defaultProfile] ? raw.defaultProfile : Object.keys(profiles)[0];
  const dataDir = resolve(interpolate(args.dataDir || env.WHEELHOUSE_DATA_DIR || raw.dataDir || join(home, ".wheelhouse"), baseline));
  return {
    file,
    baseline,
    port: Number(args.port || env.WHEELHOUSE_PORT || raw.port || 4173),
    host: "127.0.0.1", // loopback only by design
    defaultCwd: resolve(interpolate(args.cwd || env.WHEELHOUSE_CWD || raw.defaultCwd || home, baseline)),
    dataDir,
    workspaceRoot: raw.workspaceRoot ? resolve(interpolate(raw.workspaceRoot, baseline)) : env.WHEELHOUSE_WORKSPACE_ROOT ? resolve(env.WHEELHOUSE_WORKSPACE_ROOT) : "",
    systemPromptAppend: env.WHEELHOUSE_SYSTEM_PROMPT ?? raw.systemPromptAppend ?? DEFAULT_SYSTEM_PROMPT,
    defaults: {
      model: raw.defaults?.model || "default",
      effort: raw.defaults?.effort || "",
      permissionMode: raw.defaults?.permissionMode || "default",
    },
    profiles,
    defaultProfile,
    tray: {
      enabled: Boolean(args.tray) || (raw.tray?.enabled ?? false),
      hotkey: raw.tray?.hotkey ?? "Ctrl+Alt+W",
      browserHotkey: raw.tray?.browserHotkey ?? "Ctrl+Alt+Shift+W",
    },
    open: Boolean(args.open),
    appWindow: Boolean(args.app),
    help: Boolean(args.help),
    version: Boolean(args.version),
    // filled by applyProfile():
    activeProfile: defaultProfile,
    claudeBin: undefined,
    claudeExecutable: { path: null, source: "bundled" },
  };
}

/** Environment a profile runs with: the original process environment + the profile's changes. */
export function profileEnv(config, name) {
  const profile = config.profiles[name];
  const env = { ...config.baseline };
  for (const key of profile.unset) delete env[key];
  Object.assign(env, profile.env);
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  if (profile.proxyBypass.length) {
    const merged = [env.NO_PROXY || env.no_proxy, ...profile.proxyBypass].filter(Boolean).join(",");
    env.NO_PROXY = merged;
    env.no_proxy = merged;
  }
  return env;
}

/** Make `name` the active profile: process.env is reset to the baseline and the profile layered on top. */
export function applyProfile(config, name) {
  if (!config.profiles[name]) throw new Error(`Unknown profile: ${name}`);
  const next = profileEnv(config, name);
  for (const key of Object.keys(process.env)) if (!(key in next)) delete process.env[key];
  Object.assign(process.env, next);
  const executable = resolveCommand(config.profiles[name].command, next);
  config.activeProfile = name;
  config.claudeExecutable = executable;
  config.claudeBin = executable.path || undefined;
  return executable;
}

export function profileSummary(config) {
  return {
    active: config.activeProfile,
    configFile: config.file,
    profiles: Object.values(config.profiles).map((profile) => {
      const executable = profile.name === config.activeProfile ? config.claudeExecutable : resolveCommand(profile.command, profileEnv(config, profile.name));
      return {
        name: profile.name,
        label: profile.label,
        description: profile.description,
        command: profile.command || "claude",
        resolved: executable.path || (executable.source === "bundled" ? "(bundled with the SDK)" : ""),
        problem: executable.problem || "",
        cli: profile.cli,
        configDir: profile.configDir || profileEnv(config, profile.name).CLAUDE_CONFIG_DIR || "",
        envKeys: Object.keys(profile.env),
      };
    }),
  };
}

const run = (file, args, env, timeout = 20_000) =>
  new Promise((resolvePromise) => {
    execFile(file, args, { env, timeout, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim(), code: error?.code });
    });
  });

/** Check a profile: does the executable run, which version, signed in? Never returns secrets. */
export async function testProfile(config, name) {
  const profile = config.profiles[name];
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  const env = profileEnv(config, name);
  const executable = resolveCommand(profile.command, env);
  if (executable.problem) return { ok: false, error: executable.problem };
  const target = executable.path;
  if (!target) return { ok: true, bundled: true, version: "bundled with the SDK", loggedIn: null };
  const version = await run(target, ["--version"], env);
  if (!version.ok) return { ok: false, error: version.stderr || `Could not run ${target}` };
  const auth = await run(target, ["auth", "status"], env);
  let status = null;
  try { status = JSON.parse(auth.stdout); } catch { /* older CLIs */ }
  return {
    ok: true,
    path: target,
    version: version.stdout.split("\n")[0],
    loggedIn: status ? Boolean(status.loggedIn) : null,
    authMethod: status?.authMethod ?? null,
    apiProvider: status?.apiProvider ?? null,
  };
}

