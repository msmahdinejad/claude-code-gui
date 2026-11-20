import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { validThemeName, checkKeybindings, checkTheme, MAX_THEME_BYTES, MAX_KEYBINDINGS_BYTES } from "../server/lib/routes/interface-files.mjs";
import { validateChord, parseThemeColor, hexForPicker, isKnownAction, lintKeybindings, validThemeSlug, KEY_ACTIONS, DEFAULT_BINDINGS, KEY_CONTEXTS, THEME_TOKENS } from "../web/js/features/interface-data.js";
import { ENV_VARS, isSecretName } from "../web/js/features/interface-env-data.js";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Registers the routes on a tiny fake router and calls them the way server/index.mjs does. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "wh-iface-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const routes = [];
  register({ route: (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler }), HttpError });
  const call = async (method, path, body = {}) => {
    for (const entry of routes) {
      if (entry.method !== method) continue;
      const match = path.match(entry.pattern);
      if (match) return entry.handler({ params: match.slice(1).map(decodeURIComponent), query: new URLSearchParams(), body });
    }
    throw new Error(`no route ${method} ${path}`);
  };
  const rejects = (method, path, body, status) => assert.rejects(call(method, path, body), (error) => error instanceof HttpError && error.status === status);
  return {
    dir,
    call,
    rejects,
    done: async () => {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("theme names are letters, digits, - and _ only", () => {
  for (const good of ["dracula", "My-Theme_2", "a", "x".repeat(64)]) assert.equal(validThemeName(good), true, good);
  for (const bad of ["", "a/b", "a\\b", "..", "../x", "a.b", "a b", "x".repeat(65), "tëst", "con", "NUL", "com1", "lpt9", "dracula.json", "%2e%2e", null, undefined, 5]) assert.equal(validThemeName(bad), false, String(bad));
  assert.equal(validThemeSlug("ok-name"), true);
  assert.equal(validThemeSlug("a/b"), false);
});

test("document shape checks accept documented files and keep unknown fields valid", () => {
  checkKeybindings({ $schema: "x", extra: 1, bindings: [{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor", "ctrl+s": null } }] });
  checkKeybindings({});
  for (const bad of [[], "x", null, { bindings: {} }, { bindings: [1] }, { bindings: [{ context: "Chat" }] }, { bindings: [{ context: "Chat", bindings: { a: 5 } }] }, { bindings: [{ bindings: {} }] }]) assert.throws(() => checkKeybindings(bad));
  checkTheme({ name: "Dracula", base: "dark", overrides: { claude: "#bd93f9" }, other: true });
  checkTheme({});
  for (const bad of [[], null, { name: 1 }, { base: 2 }, { overrides: [] }, { overrides: { claude: 5 } }]) assert.throws(() => checkTheme(bad));
});

test("keybindings.json round trip in a temp CLAUDE_CONFIG_DIR keeps unknown fields", async () => {
  const env = await setup();
  try {
    const missing = await env.call("GET", "/api/keybindings");
    assert.equal(missing.exists, false);
    assert.equal(missing.path, join(env.dir, "keybindings.json"));
    const doc = { $schema: "https://www.schemastore.org/claude-code-keybindings.json", $docs: "https://code.claude.com/docs/en/keybindings", future: { a: [1, 2] }, bindings: [{ context: "Chat", note: "kept", bindings: { "ctrl+e": "chat:externalEditor", "ctrl+s": null } }] };
    const put = await env.call("PUT", "/api/keybindings", { text: JSON.stringify(doc, null, 2) });
    assert.equal(put.ok, true);
    const back = await env.call("GET", "/api/keybindings");
    assert.equal(back.exists, true);
    assert.equal(back.error, null);
    assert.deepEqual(back.json, doc);
    assert.ok(back.text.endsWith("\n"));
    // { json } is accepted too
    await env.call("PUT", "/api/keybindings", { json: { bindings: [] } });
    assert.deepEqual((await env.call("GET", "/api/keybindings")).json, { bindings: [] });
    // no temp files are left behind
    assert.deepEqual(await readdir(env.dir), ["keybindings.json"]);
  } finally {
    await env.done();
  }
});

test("invalid keybindings are rejected and the existing file is untouched", async () => {
  const env = await setup();
  try {
    await env.call("PUT", "/api/keybindings", { text: '{"bindings":[]}' });
    await env.rejects("PUT", "/api/keybindings", { text: "{ nope" }, 400);
    await env.rejects("PUT", "/api/keybindings", { text: "[]" }, 400);
    await env.rejects("PUT", "/api/keybindings", { text: '{"bindings":{}}' }, 400);
    await env.rejects("PUT", "/api/keybindings", {}, 400);
    await env.rejects("PUT", "/api/keybindings", { text: " ".repeat(MAX_KEYBINDINGS_BYTES + 1) }, 413);
    assert.equal(await readFile(join(env.dir, "keybindings.json"), "utf8"), '{"bindings":[]}\n');
    assert.deepEqual(await readdir(env.dir), ["keybindings.json"]);
  } finally {
    await env.done();
  }
});

test("a keybindings.json that is not valid JSON is reported, not thrown", async () => {
  const env = await setup();
  try {
    await writeFile(join(env.dir, "keybindings.json"), "{ broken", "utf8");
    const result = await env.call("GET", "/api/keybindings");
    assert.equal(result.exists, true);
    assert.equal(result.json, null);
    assert.match(result.error, /JSON/);
    assert.equal(result.text, "{ broken");
    await writeFile(join(env.dir, "keybindings.json"), '﻿{"bindings":[]}', "utf8");
    assert.deepEqual((await env.call("GET", "/api/keybindings")).json, { bindings: [] });
  } finally {
    await env.done();
  }
});

test("themes: create, list, read, update, delete round trip", async () => {
  const env = await setup();
  try {
    assert.deepEqual(await env.call("GET", "/api/themes"), { dir: join(env.dir, "themes"), exists: false, themes: [] });
    const theme = { name: "Dracula", base: "dark", overrides: { claude: "#bd93f9", error: "#ff5555" }, custom: "kept" };
    const created = await env.call("PUT", "/api/themes/dracula", { text: JSON.stringify(theme), create: true });
    assert.equal(created.created, true);
    await env.rejects("PUT", "/api/themes/dracula", { text: JSON.stringify(theme), create: true }, 409);
    await env.call("PUT", "/api/themes/midnight", { json: { name: "Midnight", base: "light", overrides: {} } });
    const list = await env.call("GET", "/api/themes");
    assert.deepEqual(list.themes.map((entry) => entry.name), ["dracula", "midnight"]);
    assert.deepEqual(list.themes[0].json, theme);
    const one = await env.call("GET", "/api/themes/dracula");
    assert.deepEqual(one.json, theme);
    const updated = await env.call("PUT", "/api/themes/dracula", { text: JSON.stringify({ ...theme, name: "Dracula 2" }) });
    assert.equal(updated.created, false);
    assert.equal((await env.call("GET", "/api/themes/dracula")).json.name, "Dracula 2");
    assert.deepEqual((await readdir(join(env.dir, "themes"))).sort(), ["dracula.json", "midnight.json"]);
    assert.deepEqual(await env.call("DELETE", "/api/themes/dracula"), { ok: true, name: "dracula" });
    await env.rejects("GET", "/api/themes/dracula", {}, 404);
    await env.rejects("DELETE", "/api/themes/dracula", {}, 404);
    assert.deepEqual((await env.call("GET", "/api/themes")).themes.map((entry) => entry.name), ["midnight"]);
  } finally {
    await env.done();
  }
});

test("themes: traversal and odd names never reach the file system", async () => {
  const env = await setup();
  try {
    await mkdir(join(env.dir, "themes"), { recursive: true });
    await writeFile(join(env.dir, "settings.json"), '{"keep":true}', "utf8");
    // Route params arrive URL-decoded from server/index.mjs, so "%2e%2e%2fsettings" is "../settings" by then.
    for (const name of ["../settings", "..\\settings", "..", "a/b", "a.json", "con", "x".repeat(65), "sub%2Fdir"]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const routePath = `/api/themes/${encodeURIComponent(name)}`;
        await assert.rejects(env.call(method, routePath, { text: "{}" }), (error) => error instanceof HttpError && error.status === 400, `${method} ${name}`);
      }
    }
    assert.equal(await readFile(join(env.dir, "settings.json"), "utf8"), '{"keep":true}');
    assert.deepEqual(await readdir(join(env.dir, "themes")), []);
    assert.deepEqual((await readdir(env.dir)).sort(), ["settings.json", "themes"]);
  } finally {
    await env.done();
  }
});

test("themes: invalid or oversize content is rejected before writing; stray files are ignored", async () => {
  const env = await setup();
  try {
    await env.rejects("PUT", "/api/themes/bad", { text: "not json" }, 400);
    await env.rejects("PUT", "/api/themes/bad", { text: "[]" }, 400);
    await env.rejects("PUT", "/api/themes/bad", { text: '{"overrides":{"claude":1}}' }, 400);
    await env.rejects("PUT", "/api/themes/big", { text: JSON.stringify({ name: "x".repeat(MAX_THEME_BYTES) }) }, 413);
    await env.rejects("PUT", "/api/themes/bad", {}, 400);
    assert.equal(await stat(join(env.dir, "themes")).then(() => true, () => false), false);
    await mkdir(join(env.dir, "themes", "folder.json"), { recursive: true });
    await writeFile(join(env.dir, "themes", "notes.txt"), "x", "utf8");
    await writeFile(join(env.dir, "themes", "has space.json"), "{}", "utf8");
    await writeFile(join(env.dir, "themes", "broken.json"), "{ nope", "utf8");
    await writeFile(join(env.dir, "themes", "fine.json"), '{"name":"Fine"}', "utf8");
    const { themes } = await env.call("GET", "/api/themes");
    assert.deepEqual(themes.map((entry) => entry.name), ["broken", "fine"]);
    const broken = themes.find((entry) => entry.name === "broken");
    assert.equal(broken.json, null);
    assert.ok(broken.error);
    await env.rejects("GET", "/api/themes/folder", {}, 409);
    await env.rejects("DELETE", "/api/themes/folder", {}, 409);
  } finally {
    await env.done();
  }
});

test("chord validation follows the documented syntax", () => {
  const ok = (text) => assert.deepEqual(validateChord(text).errors, [], text);
  const bad = (text, pattern) => {
    const result = validateChord(text);
    assert.ok(result.errors.length, text);
    if (pattern) assert.match(result.errors[0], pattern, text);
    assert.equal(result.canonical, "");
  };
  for (const text of ["ctrl+k", "ctrl+k ctrl+s", "shift+tab", "meta+p", "ctrl+shift+c", "ctrl+x ctrl+=", "ctrl+_", "ctrl+shift+-", "/", "?", "escape", "esc", "return", "wheelup", "ctrl++", "CTRL+K", "Control+Option+Command+x", "q", "7", "pageup", "ctrl+x enter"]) ok(text);
  bad("", /Enter a key/);
  bad("ctl+k", /Unknown modifier/);
  bad("ctrl+ k", /space next to/);
  bad("ctrl +k", /space next to/);
  bad("ctrl+", /ends with/);
  bad("+x", /Unknown modifier|empty/);
  bad("ctrl+c", /reserved/);
  bad("control+D", /reserved/);
  bad("ctrl+[", /reserved/);
  bad("ctrl+h", /reserved/);
  // case and alias folding
  assert.equal(validateChord("Ctrl+K").canonical, validateChord("control+k").canonical);
  assert.equal(validateChord("option+p").canonical, validateChord("meta+p").canonical);
  assert.equal(validateChord("shift+ctrl+x").canonical, "ctrl+shift+x");
  assert.equal(validateChord("esc").canonical, "escape");
  assert.equal(validateChord("ctrl+k   ctrl+s").canonical, "ctrl+k ctrl+s");
  // warnings never block
  assert.ok(validateChord("ctrl+b").warnings.length && !validateChord("ctrl+b").errors.length);
  assert.ok(validateChord("cmd+k").warnings.length && !validateChord("cmd+k").errors.length);
  assert.ok(validateChord("f5").warnings.length && !validateChord("f5").errors.length);
});

test("actions, contexts and defaults are consistent with each other", () => {
  assert.equal(KEY_CONTEXTS.length, 27);
  assert.equal(new Set(KEY_ACTIONS.map((entry) => entry[0])).size, KEY_ACTIONS.length);
  const contexts = new Set(KEY_CONTEXTS.map((entry) => entry[0]));
  for (const [context, action, keys] of DEFAULT_BINDINGS) {
    if (context !== null) assert.ok(contexts.has(context), `context ${context}`);
    assert.ok(isKnownAction(action), `action ${action}`);
    for (const key of keys) assert.deepEqual(validateChord(key).errors.filter((message) => !/reserved/.test(message)), [], `${context} ${action} ${key}`);
  }
  for (const entry of KEY_ACTIONS) for (const home of entry[1]) assert.ok(contexts.has(home), `${entry[0]} home ${home}`);
  assert.ok(isKnownAction("command:compact"));
  assert.ok(!isKnownAction("command:"));
  assert.ok(!isKnownAction("chat:nope"));
  assert.ok(!isKnownAction(null));
  assert.ok(THEME_TOKENS.length >= 60);
  assert.equal(new Set(THEME_TOKENS.map((entry) => entry[0])).size, THEME_TOKENS.length);
});

test("keybinding lint reports what Claude Code would ignore", () => {
  const doc = { bindings: [{ context: "Chat", bindings: { "ctl+k": "chat:submit", "ctrl+e": "chat:nope", "ctrl+j": "chat:newline", "CTRL+J": "chat:newline", "ctrl+s": null } }, { context: "Nowhere", bindings: {} }] };
  const problems = lintKeybindings(doc);
  assert.equal(problems.filter((entry) => entry.level === "error").length, 1);
  assert.ok(problems.some((entry) => /Unknown action/.test(entry.text)));
  assert.ok(problems.some((entry) => /Unknown context/.test(entry.text)));
  assert.ok(problems.some((entry) => /more than once/.test(entry.text)));
  assert.deepEqual(lintKeybindings({ bindings: [{ context: "Chat", bindings: { "ctrl+e": "chat:externalEditor" } }] }), []);
});

test("theme colors accept the documented formats only", () => {
  for (const good of ["#bd93f9", "#fff", "#FFAA00", "rgb(1,2,3)", "rgb( 255 , 0 , 10 )", "ansi256(0)", "ansi256(255)", "ansi:red", "ansi:cyanBright"]) assert.equal(parseThemeColor(good).ok, true, good);
  for (const bad of ["", "red", "#ff", "#ggg", "#12345", "rgb(256,0,0)", "rgb(1,2)", "ansi256(256)", "ansi:purple", "ansi:", "hsl(1,2%,3%)"]) assert.equal(parseThemeColor(bad).ok, false, bad);
  assert.equal(parseThemeColor("ansi256(16)").css, "#000000");
  assert.equal(parseThemeColor("ansi256(231)").css, "#ffffff");
  assert.equal(hexForPicker("#abc"), "#aabbcc");
  assert.equal(hexForPicker("rgb(1,2,3)"), null);
});

test("environment variable catalog: documented names, secrets masked", () => {
  assert.ok(ENV_VARS.length > 200);
  assert.equal(new Set(ENV_VARS.map((entry) => entry.name)).size, ENV_VARS.length);
  for (const entry of ENV_VARS) {
    assert.match(entry.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.ok(entry.en && entry.fa, entry.name);
  }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "MCP_CLIENT_SECRET", "GITHUB_TOKEN", "MY_PASSWORD"]) assert.equal(isSecretName(name), true, name);
  for (const name of ["MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "ANTHROPIC_MODEL", "HTTPS_PROXY", "API_TIMEOUT_MS", "CLAUDE_CODE_SKIP_BEDROCK_AUTH"]) assert.equal(isSecretName(name), false, name);
});
