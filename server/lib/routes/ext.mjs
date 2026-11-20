// Routes for the Extensions feature: MCP config files, plugins (via the claude CLI) and
// resource listings (skills / commands / agents) with parsed frontmatter.
import { readFile } from "node:fs/promises";
import { MASK, maskArgs, maskMap, redactUrl } from "../redact.mjs";

/** A server definition as the browser may see it: secrets in env, headers, args and the URL replaced by MASK. */
function maskServer(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) return server;
  const out = { ...server };
  if (server.env) out.env = maskMap(server.env);
  if (server.headers) out.headers = maskMap(server.headers);
  if (server.args) out.args = maskArgs(server.args);
  if (typeof server.url === "string") out.url = redactUrl(server.url, MASK);
  return out;
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const maskServers = (servers) => (isObject(servers) ? Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, maskServer(server)])) : {});
const maskMcpFile = (json) => (isObject(json) && isObject(json.mcpServers) ? { ...json, mcpServers: maskServers(json.mcpServers) } : json);

/** Pairs of [original, masked] strings found by walking a value and its masked copy side by side. */
function maskedPairs(original, masked, out = []) {
  if (typeof original === "string") {
    if (original !== masked) out.push([original, masked]);
  } else if (original && typeof original === "object" && masked && typeof masked === "object") {
    for (const key of Object.keys(original)) maskedPairs(original[key], masked[key], out);
  }
  return out;
}

/** The .mcp.json text for the editor with its secrets masked, keeping the file's own layout where possible. */
export function maskMcpText(text, json) {
  const masked = maskMcpFile(json);
  const pairs = maskedPairs(json, masked);
  if (!pairs.length) return text;
  let out = text;
  for (const [original, hidden] of pairs) out = out.split(JSON.stringify(original)).join(JSON.stringify(hidden));
  try {
    if (JSON.stringify(JSON.parse(out)) === JSON.stringify(masked)) return out;
  } catch { /* re-serialize below */ }
  return `${JSON.stringify(masked, null, 2)}\n`;
}

/** Put the real values back where the edited text still holds a masked one (same place, or an unambiguous match). */
export function restoreMasked(edited, original) {
  const masked = maskMcpFile(original);
  const byMask = new Map();
  for (const [real, hidden] of maskedPairs(original, masked)) byMask.set(hidden, byMask.has(hidden) && byMask.get(hidden) !== real ? null : real);
  const own = (obj, key) => (isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);
  const walk = (value, real, hidden) => {
    if (typeof value === "string") {
      if (typeof real === "string" && value === hidden && real !== hidden) return real;
      if (!value.includes(MASK)) return value;
      if (byMask.get(value)) return byMask.get(value);
      throw new Error(`Replace the hidden value "${value}" with the real one (or leave that entry unchanged).`);
    }
    if (Array.isArray(value)) return value.map((item, i) => walk(item, Array.isArray(real) ? real[i] : undefined, Array.isArray(hidden) ? hidden[i] : undefined));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, own(real, key), own(hidden, key))]));
    return value;
  };
  return walk(edited, original, masked);
}

async function readJson(path) {
  try {
    return { exists: true, json: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, json: null };
    return { exists: true, json: null, error: error.message };
  }
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export default function register({ route, cfiles, fsgit, runClaudeCli, HttpError, join, resolve }) {
  // ---- MCP config files -------------------------------------------------------------
  route("GET", "/api/ext/mcp-files", async ({ query }) => {
    const cwd = resolve(query.get("cwd") || ".");
    const projectPath = join(cwd, ".mcp.json");
    const project = await readJson(projectPath);
    const userFile = await readJson(join(cfiles.configDir(), ".claude.json"));
    const userServers = userFile.json?.mcpServers || {};
    const localServers = userFile.json?.projects?.[cwd]?.mcpServers || userFile.json?.projects?.[cwd.replaceAll("\\", "/")]?.mcpServers || {};
    const raw = project.exists ? await readFile(projectPath, "utf8").catch(() => "") : '{\n  "mcpServers": {}\n}\n';
    // Text that does not parse cannot be masked value by value: the editor then starts empty rather than show secrets.
    const text = !project.exists ? raw : project.json ? maskMcpText(raw, project.json) : "";
    return {
      project: { path: projectPath, exists: project.exists, error: project.error, servers: maskServers(project.json?.mcpServers), text, masked: text !== raw },
      user: { path: join(cfiles.configDir(), ".claude.json"), servers: maskServers(userServers) },
      local: { servers: maskServers(localServers) },
    };
  });

  route("PUT", "/api/ext/mcp-project", async ({ body }) => {
    const cwd = resolve(body.cwd || ".");
    let parsed;
    try {
      parsed = JSON.parse(String(body.text ?? ""));
    } catch (error) {
      throw new HttpError(400, `Invalid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed.mcpServers ?? {}) !== "object") {
      throw new HttpError(400, 'Expected an object like {"mcpServers": {...}}');
    }
    if (!parsed.mcpServers) parsed.mcpServers = {};
    // The editor showed secrets masked: write the real values back wherever they were left as they were.
    const current = await readJson(join(cwd, ".mcp.json"));
    try {
      parsed = restoreMasked(parsed, current.json);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    return fsgit.writeTextFile(join(cwd, ".mcp.json"), `${JSON.stringify(parsed, null, 2)}\n`, { backup: false });
  });

  // ---- plugins ----------------------------------------------------------------------
  const parseJsonOut = (result) => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  };

  route("GET", "/api/ext/plugins", async ({ query }) => {
    const cwd = query.get("cwd") || undefined;
    const available = query.get("available") === "1";
    const [installed, marketplaces, avail] = await Promise.all([
      runClaudeCli(["plugin", "list", "--json"], { cwd, timeout: 90_000 }),
      runClaudeCli(["plugin", "marketplace", "list", "--json"], { cwd, timeout: 90_000 }),
      available ? runClaudeCli(["plugin", "list", "--json", "--available"], { cwd, timeout: 120_000 }) : Promise.resolve(null),
    ]);
    return {
      installed: parseJsonOut(installed),
      marketplaces: parseJsonOut(marketplaces),
      available: avail ? parseJsonOut(avail) : null,
      errors: [installed, marketplaces, avail].filter((r) => r && !r.ok).map((r) => r.stderr || r.stdout).slice(0, 3),
    };
  });

  route("GET", "/api/ext/plugin-details", async ({ query }) => {
    const name = query.get("name") || "";
    if (!name || name.startsWith("-")) throw new HttpError(400, "plugin name required");
    const result = await runClaudeCli(["plugin", "details", name], { cwd: query.get("cwd") || undefined, timeout: 60_000 });
    return { ok: result.ok, text: result.stdout || result.stderr };
  });

  // ---- resources (skills / commands / agents) with frontmatter summary --------------------
  route("GET", "/api/ext/resources", async ({ query }) => {
    const kind = query.get("kind");
    const cwd = query.get("cwd") || ".";
    const out = [];
    for (const scope of ["user", "project"]) {
      let listing;
      try {
        listing = await cfiles.listResources(kind, scope, cwd);
      } catch {
        continue;
      }
      for (const item of listing.items) {
        const info = await fsgit.readTextFile(item.path).catch(() => null);
        const fm = info?.content ? parseFrontmatter(info.content) : {};
        out.push({ name: item.name, scope, path: item.path, description: fm.description || "", model: fm.model || "", tools: fm.tools || fm["allowed-tools"] || "", color: fm.color || "" });
      }
    }
    return { items: out };
  });
}
