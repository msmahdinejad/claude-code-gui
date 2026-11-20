// Pure helpers for Claude Code "memory": where auto memory lives, safe relative paths,
// a small frontmatter reader/writer (rules `paths`, memory `name`/`description`/`type`) and
// MEMORY.md index edits. No fs imports: callers pass a `path` flavour (node:path win32/posix)
// and an `fs` adapter, so every rule here is unit-testable for both Windows and POSIX inputs.
//
// The project-directory rule mirrors Claude Code (docs: memory.md "Storage location",
// env-vars.md CLAUDE_CODE_PROJECT_DIR_NAME, settings-reference.md autoMemoryDirectory):
//   dir  = autoMemoryDirectory (first of policy > flag > local > project > user, "~/" expanded)
//       ?? <configDir>/projects/<key>/memory
//   key  = CLAUDE_CODE_PROJECT_DIR_NAME (only with CLAUDE_CONFIG_DIR set, [A-Za-z0-9_-]{1,64})
//       ?? sanitize(canonical git root of cwd ?? cwd)
//   sanitize(p) = p with every non-alphanumeric char replaced by "-", cut to 200 chars plus
//                 "-" + base36(|djb2(p)|) when longer.

export const INDEX_NAME = "MEMORY.md";
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
export const FILE_MAX_BYTES = 1024 * 1024;
const MAX_KEY = 200;

// ---- project directory name -------------------------------------------------------------
export function djb2(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return hash;
}

export function sanitizeProjectName(path) {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_KEY) return name;
  return `${name.slice(0, MAX_KEY)}-${Math.abs(djb2(path)).toString(36)}`;
}

/** CLAUDE_CODE_PROJECT_DIR_NAME, honored only beside CLAUDE_CONFIG_DIR and when it is a safe name. */
export function projectDirNameOverride(env = {}) {
  if (!env.CLAUDE_CONFIG_DIR) return undefined;
  const value = env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) return undefined;
  return value;
}

/** Walks up from `start` to the first folder holding a `.git` dir or file. A `.git` symlink stops the search. */
export function findGitRoot(start, { path, fs }) {
  let dir = path.resolve(start);
  const top = path.parse(dir).root || dir;
  for (;;) {
    const kind = fs.kind(path.join(dir, ".git"));
    if (kind === "link") return null;
    if (kind === "directory" || kind === "file") return dir;
    if (dir === top) return null;
    const parent = path.dirname(dir);
    dir = parent === dir ? top : parent;
  }
}

/**
 * For a linked worktree (`.git` file → gitdir: <main>/.git/worktrees/<name>) returns the main
 * checkout, so every worktree of one repository shares one memory folder. Anything that does not
 * read exactly like git's own layout falls back to `root`.
 */
export function canonicalGitRoot(root, { path, fs }) {
  try {
    if (fs.kind(path.join(root, ".git")) !== "file") return root;
    const text = (fs.readText(path.join(root, ".git")) || "").trim();
    if (!text.startsWith("gitdir:")) return root;
    const gitDir = path.resolve(root, text.slice(7).trim());
    const common = (fs.readText(path.join(gitDir, "commondir")) || "").trim();
    if (!common) return root;
    const commonDir = path.resolve(gitDir, common);
    if (path.resolve(path.dirname(gitDir)) !== path.join(commonDir, "worktrees")) return root;
    const back = (fs.readText(path.join(gitDir, "gitdir")) || "").trim();
    if (!back) return root;
    const real = fs.realpath || ((value) => value);
    if (real(path.resolve(gitDir, back)) !== path.join(real(root), ".git")) return root;
    if (path.basename(commonDir) !== ".git") return commonDir; // bare repository
    return path.dirname(commonDir);
  } catch {
    return root;
  }
}

/** autoMemoryDirectory value → absolute folder, or null when Claude Code would ignore it. */
export function expandMemoryDirectory(value, { home, path }) {
  if (typeof value !== "string" || !value) return null;
  let target = value;
  if (target.startsWith("~/") || target.startsWith("~\\")) {
    const rest = target.slice(2);
    const normal = path.normalize(rest || ".");
    if (normal === "." || normal === ".." || normal.startsWith("../") || normal.startsWith("..\\")) return null;
    target = path.join(home, rest);
  }
  const normal = path.normalize(target).replace(/[/\\]+$/, "");
  if (!path.isAbsolute(normal) || normal.length < 3 || /^[A-Za-z]:$/.test(normal) || normal.startsWith("\\\\") || normal.includes("\0")) return null;
  return normal.normalize("NFC");
}

/**
 * setting: { value, source } for autoMemoryDirectory from the effective settings (or undefined).
 * Returns { dir, via: "setting"|"env"|"git"|"cwd", base, key, projectsDir }.
 */
export function resolveAutoMemoryDir({ cwd, configDir, env = {}, setting, home, path, fs }) {
  const projectsDir = path.join(configDir, "projects");
  if (setting?.value !== undefined && setting?.value !== null) {
    const custom = expandMemoryDirectory(setting.value, { home, path });
    if (custom) return { dir: custom, via: "setting", source: setting.source, projectsDir };
  }
  const override = projectDirNameOverride(env);
  if (override) return { dir: path.join(projectsDir, override, "memory").normalize("NFC"), via: "env", key: override, projectsDir };
  if (!cwd) return { dir: null, via: "none", projectsDir };
  const start = path.resolve(cwd);
  const gitRoot = findGitRoot(start, { path, fs });
  const base = gitRoot ? canonicalGitRoot(gitRoot, { path, fs }) : start;
  let key = sanitizeProjectName(base);
  if (key.length > MAX_KEY && fs.kind(path.join(projectsDir, key)) === null && fs.list) {
    // Builds that hashed long names differently: reuse a folder with the same 200-char prefix.
    const fold = (text) => (path.sep === "\\" ? text.toLowerCase() : text);
    const prefix = fold(`${key.slice(0, MAX_KEY)}-`);
    const match = fs.list(projectsDir).find((name) => fold(name).startsWith(prefix));
    if (match) key = match;
  }
  return { dir: path.join(projectsDir, key, "memory").normalize("NFC"), via: gitRoot ? "git" : "cwd", base, gitRoot, key, projectsDir };
}

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

/**
 * Whether auto memory is on. CLAUDE_CODE_DISABLE_AUTO_MEMORY wins in either direction
 * (process env first, then a settings `env` block), else autoMemoryEnabled (default true).
 */
export function autoMemoryState({ env = {}, settingsEnv = {}, setting }) {
  for (const [from, bag] of [["env", env], ["settings-env", settingsEnv || {}]]) {
    const raw = bag.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const value = String(raw).trim().toLowerCase();
    if (TRUE.has(value)) return { enabled: false, by: from, value: String(raw) };
    if (FALSE.has(value)) return { enabled: true, by: from, value: String(raw) };
  }
  if (typeof setting?.value === "boolean") return { enabled: setting.value, by: "setting", source: setting.source };
  return { enabled: true, by: "default" };
}

// ---- safe relative paths ---------------------------------------------------------------
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Validates a relative `*.md` path ("a/b.md"); throws on traversal, absolute paths and odd names. */
export function cleanRelPath(rel, { ext = ".md" } = {}) {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("file name is required");
  const text = rel.trim().replace(/\\/g, "/");
  if (text.length > 240) throw new Error("file name is too long");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.includes("\0")) throw new Error("absolute paths are not allowed");
  const parts = text.split("/");
  if (parts.length > 6) throw new Error("folder nesting is too deep");
  for (const part of parts) {
    if (!part || part === "." || part === "..") throw new Error("“..” and empty path parts are not allowed");
    if (/[<>:"|?*\x00-\x1f]/.test(part) || part.startsWith(".") || /[. ]$/.test(part) || RESERVED.test(part)) throw new Error(`invalid file name: ${part}`);
  }
  if (ext && !parts.at(-1).toLowerCase().endsWith(ext)) throw new Error(`only ${ext} files are allowed`);
  if (ext && parts.at(-1).length <= ext.length) throw new Error("file name is required");
  return parts.join("/");
}

/** Joins root + rel lexically and proves the result stays strictly inside root. */
export function confinedPath(root, rel, path, options) {
  const clean = cleanRelPath(rel, options);
  const base = path.resolve(root);
  const full = path.resolve(base, ...clean.split("/"));
  if (!isInside(base, full, path)) throw new Error("path escapes its folder");
  return full;
}

export function isInside(root, target, path) {
  const rel = path.relative(root, target);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---- frontmatter ---------------------------------------------------------------------
/**
 * Splits a markdown file into frontmatter lines and body without losing a byte:
 * compose(parseDoc(x)) === x. `data` holds a forgiving read of the YAML (scalars, lists,
 * one level of nested maps); `error` is set when a top-level line is not `key: value`.
 */
export function parseDoc(text) {
  const source = String(text ?? "");
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const raw = source.slice(bom.length);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const open = /^---[ \t]*\r?\n/.exec(raw);
  if (!open) return { hasFrontmatter: false, bom, eol, lines: [], gap: "", body: raw, data: {}, error: null };
  const rest = raw.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) return { hasFrontmatter: false, bom, eol, lines: [], gap: "", body: raw, data: {}, error: "frontmatter is not closed" };
  const fmText = rest.slice(0, close.index);
  const after = rest.slice(close.index + close[0].length);
  const gap = /^(?:[ \t]*\r?\n)*/.exec(after)[0];
  const lines = fmText ? fmText.split(/\r?\n/) : [];
  const { data, error } = readYaml(lines);
  return { hasFrontmatter: true, bom, eol, open: open[0], close: close[0].replace(/^\r?\n/, ""), lines, gap, body: after.slice(gap.length), data, error };
}

export function composeDoc(doc) {
  if (!doc.hasFrontmatter) return `${doc.bom || ""}${doc.body}`;
  const open = doc.open || `---${doc.eol}`;
  const close = doc.close || `---${doc.eol}`;
  const fm = doc.lines.length ? `${doc.lines.join(doc.eol)}${doc.eol}` : "";
  const closeLine = /\r?\n$/.test(close) || !doc.body && !doc.gap ? close : `${close}${doc.eol}`;
  return `${doc.bom || ""}${open}${fm}${closeLine}${doc.gap}${doc.body}`;
}

function unquote(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  return text.replace(/\s+#.*$/, "");
}

function splitOutside(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function readScalarOrFlow(value) {
  const text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) return splitOutside(text.slice(1, -1), ",").map(unquote).filter((item) => item !== "");
  return unquote(text);
}

function readYaml(lines) {
  const data = {};
  let error = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!match) {
      error = error || `cannot read line: ${line.trim().slice(0, 60)}`;
      index += 1;
      continue;
    }
    const [, key, inline = ""] = match;
    const end = blockEnd(lines, index);
    const children = lines.slice(index + 1, end).filter((child) => child.trim() && !child.trim().startsWith("#"));
    if (inline.trim() && !/^[|>][+-]?\d*$/.test(inline.trim())) data[key] = readScalarOrFlow(inline);
    else if (/^[|>]/.test(inline.trim())) data[key] = children.map((child) => child.trim()).join(inline.trim().startsWith("|") ? "\n" : " ");
    else if (children.length && children.every((child) => /^\s*-(\s|$)/.test(child))) data[key] = children.map((child) => unquote(child.replace(/^\s*-\s?/, ""))).filter((item) => item !== "");
    else if (children.length) {
      const map = {};
      for (const child of children) {
        const pair = /^\s+([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/.exec(child);
        if (pair) map[pair[1]] = pair[2] === undefined ? "" : readScalarOrFlow(pair[2]);
      }
      data[key] = map;
    } else data[key] = "";
    index = end;
  }
  return { data, error };
}

/** Index after the block that starts at `start` (its indented / list continuation lines). */
function blockEnd(lines, start) {
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^-(\s|$)/.test(lines[end]))) end += 1;
  return end;
}

function findKey(lines, key) {
  const pattern = new RegExp(`^${key}\\s*:`);
  return lines.findIndex((line) => pattern.test(line));
}

function setBlock(lines, key, block) {
  const next = lines.slice();
  const at = findKey(next, key);
  if (at < 0) {
    if (block) next.push(...block);
    return next;
  }
  next.splice(at, blockEnd(next, at) - at, ...(block || []));
  return next;
}

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_ .,/()+@-]*$/;
const AMBIGUOUS = /^(?:true|false|null|yes|no|on|off|~|[-+]?\d[\d._]*(?:e[-+]?\d+)?)$/i;

export function yamlScalar(value) {
  const text = String(value);
  if (PLAIN.test(text) && !AMBIGUOUS.test(text) && !text.endsWith(" ")) return text;
  return JSON.stringify(text);
}

function withLines(text, mutate) {
  const doc = parseDoc(text);
  const lines = mutate(doc.lines.slice(), doc);
  if (!lines.some((line) => line.trim())) {
    if (!doc.hasFrontmatter) return text;
    return `${doc.bom}${doc.body}`; // nothing left: drop the empty frontmatter block
  }
  if (!doc.hasFrontmatter) return composeDoc({ ...doc, hasFrontmatter: true, lines, gap: doc.body ? doc.eol : "", body: doc.body, close: `---${doc.eol}` });
  return composeDoc({ ...doc, lines });
}

/** A rule's `paths` list (YAML list, flow list or comma-separated string); [] when it has none. */
export function rulePaths(doc) {
  const value = doc.data?.paths;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return splitOutside(value, ",").map((item) => unquote(item)).filter(Boolean);
  return [];
}

export function setRulePaths(text, paths) {
  const clean = (paths || []).map((item) => String(item).trim()).filter(Boolean);
  return withLines(text, (lines) => setBlock(lines, "paths", clean.length ? ["paths:", ...clean.map((item) => `  - ${JSON.stringify(item)}`)] : null));
}

/** { name, description, type } of an auto-memory topic file (`type` top-level or under `metadata:`). */
export function memoryMeta(doc) {
  const data = doc.data || {};
  const nested = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata : {};
  const pick = (value) => (typeof value === "string" ? value : "");
  return { name: pick(data.name), description: pick(data.description), type: pick(data.type) || pick(nested.type) };
}

export function setMemoryMeta(text, { name, description, type } = {}) {
  return withLines(text, (input) => {
    let lines = input;
    if (name !== undefined) lines = setBlock(lines, "name", name ? [`name: ${yamlScalar(name)}`] : null);
    if (description !== undefined) lines = setBlock(lines, "description", description ? [`description: ${yamlScalar(description)}`] : null);
    if (type !== undefined) lines = setType(lines, type);
    return lines;
  });
}

function setType(lines, type) {
  if (findKey(lines, "type") >= 0) return setBlock(lines, "type", type ? [`type: ${yamlScalar(type)}`] : null);
  const meta = findKey(lines, "metadata");
  if (meta < 0 || /^metadata\s*:\s*\S/.test(lines[meta])) {
    if (!type) return lines;
    return meta < 0 ? [...lines, "metadata:", `  type: ${yamlScalar(type)}`] : setBlock(lines, "type", [`type: ${yamlScalar(type)}`]);
  }
  const end = blockEnd(lines, meta);
  const next = lines.slice();
  const child = next.slice(meta + 1, end).findIndex((line) => /^\s+type\s*:/.test(line));
  if (child >= 0) {
    const at = meta + 1 + child;
    const indent = /^\s+/.exec(next[at])[0];
    if (type) next[at] = `${indent}type: ${yamlScalar(type)}`;
    else next.splice(at, 1);
    if (!type && !next.slice(meta + 1, end - 1).some((line) => line.trim())) next.splice(meta, 1); // metadata now empty
    return next;
  }
  if (!type) return next;
  const indent = end > meta + 1 ? /^\s+/.exec(next[meta + 1])?.[0] || "  " : "  ";
  next.splice(meta + 1, 0, `${indent}type: ${yamlScalar(type)}`);
  return next;
}

/** Replaces the markdown body, keeping the frontmatter and the blank line(s) after it. */
export function replaceBody(text, body) {
  const doc = parseDoc(text);
  if (!doc.hasFrontmatter) return `${doc.bom}${body}`;
  const gap = doc.gap || (!doc.body && body ? doc.eol : ""); // keep the file's own spacing
  return composeDoc({ ...doc, gap, body });
}

// ---- MEMORY.md index -------------------------------------------------------------------
export function indexStats(text) {
  const source = String(text ?? "");
  const bytes = Buffer.byteLength(source, "utf8");
  const lines = source ? source.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
  return {
    lines,
    bytes,
    maxLines: INDEX_MAX_LINES,
    maxBytes: INDEX_MAX_BYTES,
    near: lines >= INDEX_MAX_LINES * 0.8 || bytes >= INDEX_MAX_BYTES * 0.8,
    over: lines > INDEX_MAX_LINES || bytes > INDEX_MAX_BYTES,
  };
}

const linkTarget = (file) => new RegExp(`\\]\\(\\s*(?:\\./)?${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "(?: |%20)")}\\s*\\)`);

export function indexHasEntry(text, file) {
  return String(text ?? "").split(/\r?\n/).some((line) => linkTarget(file).test(line));
}

/** One index line, in the shape Claude Code writes: "- [Title](file.md) — description". */
export function indexEntryLine({ file, title, description }) {
  const label = String(title || file.replace(/\.md$/i, "")).replace(/[[\]\r\n]/g, " ").trim();
  const target = file.includes(" ") ? file.replace(/ /g, "%20") : file;
  const note = String(description || "").replace(/\s*\r?\n\s*/g, " ").trim();
  return `- [${label}](${target})${note ? ` — ${note}` : ""}`;
}

/** Adds (or replaces) the index line that links to `entry.file`. */
export function upsertIndexEntry(text, entry) {
  const source = String(text ?? "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const line = indexEntryLine(entry);
  const lines = source ? source.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const at = lines.findIndex((item) => linkTarget(entry.file).test(item));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return `${lines.join(eol)}${eol}`;
}

export function removeIndexEntry(text, file) {
  const source = String(text ?? "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const ends = /\r?\n$/.test(source);
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/).filter((line) => !linkTarget(file).test(line));
  const out = lines.join(eol);
  return out && ends ? `${out}${eol}` : out;
}

// ---- claudeMdExcludes ------------------------------------------------------------------
/** Glob (**, *, ?, {a,b}, [..]) → RegExp over forward-slash paths. */
export function globToRegExp(glob, { caseInsensitive = false } = {}) {
  const text = String(glob).replace(/\\/g, "/");
  let out = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "*") {
      if (text[index + 1] === "*") {
        const slash = text[index + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else if (char === "{") {
      depth += 1;
      out += "(?:";
    } else if (char === "}" && depth) {
      depth -= 1;
      out += ")";
    } else if (char === "," && depth) out += "|";
    else if (char === "[") {
      const close = text.indexOf("]", index + 1);
      if (close > index + 1) {
        out += `[${text.slice(index + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        index = close;
      } else out += "\\[";
    } else out += char.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, caseInsensitive ? "i" : "");
}

export function matchesAny(file, patterns, { caseInsensitive = false } = {}) {
  const target = String(file).replace(/\\/g, "/");
  for (const pattern of patterns || []) {
    try {
      if (globToRegExp(pattern, { caseInsensitive }).test(target)) return pattern;
    } catch { /* bad pattern */ }
  }
  return null;
}
