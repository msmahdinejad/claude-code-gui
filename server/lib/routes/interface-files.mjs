// Claude Code's interface files in its user config folder (CLAUDE_CONFIG_DIR or ~/.claude):
//   keybindings.json      custom keyboard shortcuts            GET / PUT   /api/keybindings
//   themes/<name>.json    custom color themes                  GET         /api/themes            (list, with contents)
//                                                              GET/PUT/DELETE /api/themes/<name>
//
// Access is confined to exactly those files: a theme name is letters, digits, "-" and "_" only (never a path),
// content must be valid JSON of the documented shape before anything is written, writes are atomic (temp file in the
// same folder + rename) and size-limited. Fields the editor does not know are kept as they are: the client sends the
// whole file back and the server writes exactly what it was given.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_KEYBINDINGS_BYTES = 512 * 1024;
export const MAX_THEME_BYTES = 128 * 1024;
export const MAX_THEMES = 500;
export const THEME_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Windows device names stay reserved with any extension ("con.json" opens the console).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function validThemeName(name) {
  return typeof name === "string" && THEME_NAME_RE.test(name) && !WINDOWS_RESERVED.test(name);
}

export function configDirPath() {
  return resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Throws Error(message) when `json` is not a usable keybindings document (unknown fields are fine). */
export function checkKeybindings(json) {
  if (!isObject(json)) throw new Error("keybindings.json must be a JSON object with a \"bindings\" array");
  if ("bindings" in json) {
    if (!Array.isArray(json.bindings)) throw new Error("\"bindings\" must be an array of { context, bindings } blocks");
    json.bindings.forEach((block, index) => {
      if (!isObject(block)) throw new Error(`bindings[${index}] must be an object`);
      if (typeof block.context !== "string" || !block.context) throw new Error(`bindings[${index}].context must be a non-empty string`);
      if (!isObject(block.bindings)) throw new Error(`bindings[${index}].bindings must be an object of key: action`);
      for (const [key, action] of Object.entries(block.bindings)) {
        if (action !== null && typeof action !== "string") throw new Error(`bindings[${index}].bindings["${key}"] must be an action name or null`);
      }
    });
  }
}

/** Throws Error(message) when `json` is not a usable theme (name / base / overrides as documented; extra fields are fine). */
export function checkTheme(json) {
  if (!isObject(json)) throw new Error("a theme must be a JSON object");
  if ("name" in json && typeof json.name !== "string") throw new Error("\"name\" must be a string");
  if ("base" in json && typeof json.base !== "string") throw new Error("\"base\" must be a string");
  if ("overrides" in json) {
    if (!isObject(json.overrides)) throw new Error("\"overrides\" must be an object of token: color");
    for (const [token, value] of Object.entries(json.overrides)) {
      if (typeof value !== "string") throw new Error(`overrides["${token}"] must be a color string`);
    }
  }
}

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function parseJson(text) {
  try {
    return { json: JSON.parse(stripBom(text)), error: null };
  } catch (error) {
    return { json: null, error: error.message };
  }
}

/** Write through a temp file in the same folder, then rename over the target. */
export async function writeAtomic(path, text, dir) {
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    // Windows briefly refuses a rename while another process (Claude Code's file watcher) has the target open.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, path);
        return;
      } catch (error) {
        if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        await new Promise((done) => setTimeout(done, 25 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export default function register({ route, HttpError, cfiles }) {
  const baseDir = () => (typeof cfiles?.configDir === "function" ? cfiles.configDir() : configDirPath());
  const keybindingsFile = () => join(baseDir(), "keybindings.json");
  const themesDir = () => join(baseDir(), "themes");

  const themeFile = (name) => {
    if (!validThemeName(name)) throw new HttpError(400, "Theme names may contain letters, digits, \"-\" and \"_\" only (at most 64 characters).");
    return join(themesDir(), `${name}.json`);
  };

  /** The document the client sent: `text` verbatim (validated) or `json` re-serialized. */
  const incoming = (body, limit, check) => {
    let text;
    if (typeof body?.text === "string") text = body.text;
    else if (body && "json" in body) text = `${JSON.stringify(body.json, null, 2)}\n`;
    else throw new HttpError(400, "Send the file as { text } (a JSON string) or { json }.");
    if (Buffer.byteLength(text, "utf8") > limit) throw new HttpError(413, `The file is too large (the limit is ${Math.round(limit / 1024)} KB).`);
    const { json, error } = parseJson(text);
    if (error) throw new HttpError(400, `Invalid JSON: ${error}`);
    try {
      check(json);
    } catch (problem) {
      throw new HttpError(400, problem.message);
    }
    return text.endsWith("\n") ? text : `${text}\n`;
  };

  /** Reads one of our files; null when it does not exist. Refuses anything that is not a regular file. */
  const readOne = async (path, limit) => {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    if (!info.isFile()) throw new HttpError(409, "That path is not a regular file.");
    if (info.size > limit) throw new HttpError(413, `The file is too large (the limit is ${Math.round(limit / 1024)} KB).`);
    const text = await readFile(path, "utf8");
    return { text, size: info.size, mtime: info.mtimeMs };
  };

  route("GET", "/api/keybindings", async () => {
    const path = keybindingsFile();
    const file = await readOne(path, MAX_KEYBINDINGS_BYTES);
    if (!file) return { path, exists: false, text: "", json: null, error: null };
    const { json, error } = parseJson(file.text);
    return { path, exists: true, text: file.text, json, error, size: file.size, mtime: file.mtime };
  });

  route("PUT", "/api/keybindings", async ({ body }) => {
    const text = incoming(body, MAX_KEYBINDINGS_BYTES, checkKeybindings);
    const path = keybindingsFile();
    await writeAtomic(path, text, baseDir());
    return { ok: true, path, size: Buffer.byteLength(text, "utf8") };
  });

  route("GET", "/api/themes", async () => {
    const dir = themesDir();
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { dir, exists: false, themes: [] };
      throw error;
    }
    const themes = [];
    for (const file of names.sort((a, b) => a.localeCompare(b))) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5);
      if (!validThemeName(name)) continue; // not something this editor can address (kept untouched)
      if (themes.length >= MAX_THEMES) break;
      const path = join(dir, file);
      try {
        const entry = await readOne(path, MAX_THEME_BYTES);
        if (!entry) continue;
        const { json, error } = parseJson(entry.text);
        themes.push({ name, path, text: entry.text, json, error, size: entry.size, mtime: entry.mtime });
      } catch (error) {
        if (error.status === 409) continue; // a folder named like a theme file
        themes.push({ name, path, text: "", json: null, error: error.message, size: 0, mtime: 0 });
      }
    }
    return { dir, exists: true, themes };
  });

  route("GET", "/api/themes/([^/]+)", async ({ params }) => {
    const path = themeFile(params[0]);
    const entry = await readOne(path, MAX_THEME_BYTES);
    if (!entry) throw new HttpError(404, "No such theme.");
    const { json, error } = parseJson(entry.text);
    return { name: params[0], path, text: entry.text, json, error, size: entry.size, mtime: entry.mtime };
  });

  route("PUT", "/api/themes/([^/]+)", async ({ params, body }) => {
    const path = themeFile(params[0]);
    const text = incoming(body, MAX_THEME_BYTES, checkTheme);
    const existing = await stat(path).then(
      (info) => {
        if (!info.isFile()) throw new HttpError(409, "That path is not a regular file.");
        return info;
      },
      (error) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      },
    );
    if (body?.create === true && existing) throw new HttpError(409, "A theme with that name already exists.");
    if (!existing) {
      const count = (await readdir(themesDir()).catch(() => [])).filter((file) => file.endsWith(".json")).length;
      if (count >= MAX_THEMES) throw new HttpError(409, `There are already ${MAX_THEMES} themes.`);
    }
    await writeAtomic(path, text, themesDir());
    return { ok: true, name: params[0], path, created: !existing, size: Buffer.byteLength(text, "utf8") };
  });

  route("DELETE", "/api/themes/([^/]+)", async ({ params }) => {
    const path = themeFile(params[0]);
    const entry = await stat(path).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!entry) throw new HttpError(404, "No such theme.");
    if (!entry.isFile()) throw new HttpError(409, "That path is not a regular file.");
    await rm(path);
    return { ok: true, name: params[0] };
  });
}
