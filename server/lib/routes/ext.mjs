// Routes for the Extensions feature: MCP config files, plugins (via the claude CLI) and
// resource listings (skills / commands / agents) with parsed frontmatter.
import { readFile } from "node:fs/promises";

const SECRET_KEYS = /(key|token|secret|password|authorization|auth|cookie)/i;

function maskMap(map) {
  if (!map || typeof map !== "object") return map;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, SECRET_KEYS.test(key) ? "••••••" : value]));
}

function maskServer(server) {
  if (!server || typeof server !== "object") return server;
  return { ...server, env: maskMap(server.env), headers: maskMap(server.headers) };
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
    const mask = (servers) => Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, maskServer(server)]));
    return {
      project: { path: projectPath, exists: project.exists, error: project.error, servers: project.json?.mcpServers || {}, text: project.exists ? await readFile(projectPath, "utf8").catch(() => "") : '{\n  "mcpServers": {}\n}\n' },
      user: { path: join(cfiles.configDir(), ".claude.json"), servers: mask(userServers) },
      local: { servers: mask(localServers) },
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
