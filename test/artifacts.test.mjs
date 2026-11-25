import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_HINT, SessionManager } from "../server/lib/session-manager.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let child;
let base;
let home;
let data;
let project;

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "wheelhouse-art-"));
  data = join(home, "data");
  project = join(home, "project");
  mkdirSync(project);
  const configFile = join(home, "wheelhouse.config.json");
  writeFileSync(configFile, JSON.stringify({ autoTitle: false, profiles: { default: { label: "Test", configDir: join(home, "claude") } } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude") };
  for (const key of ["WHEELHOUSE_CONFIG", "WHEELHOUSE_DATA_DIR", "WHEELHOUSE_PORT", "WHEELHOUSE_CWD", "WHEELHOUSE_WORKSPACE_ROOT", "WHEELHOUSE_ARTIFACTS", "CLAUDE_BIN"]) delete env[key];
  child = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--config", configFile, "--data-dir", data, "--cwd", home], { env, stdio: "ignore" });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not start");
});

after(() => {
  child?.kill();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
});

const get = (path, params = {}) => fetch(`${base}${path}?${new URLSearchParams({ cwd: project, ...params })}`);
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ cwd: project, ...body }) });
const art = (name) => join(project, ".wheelhouse", "artifacts", name);
const write = (name, text) => { mkdirSync(join(project, ".wheelhouse", "artifacts"), { recursive: true }); writeFileSync(art(name), text); };
const json = async (response) => response.json();

test("an empty project has no artifacts", async () => {
  const response = await get("/api/artifacts");
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { dir: ".wheelhouse/artifacts", items: [] });
});

test("list, get and versions follow the file as Claude rewrites it", async () => {
  write("sales.html", "<h1>one</h1>");
  let list = await json(await get("/api/artifacts"));
  assert.equal(list.items.length, 1);
  assert.deepEqual({ name: list.items[0].name, kind: list.items[0].kind, versions: list.items[0].versions, size: list.items[0].size }, { name: "sales.html", kind: "html", versions: 1, size: 12 });
  assert.equal(typeof list.items[0].mtime, "number");
  assert.match(list.items[0].updatedAt, /^\d{4}-\d\d-\d\dT/);

  const first = await json(await get("/api/artifacts/get", { name: "sales.html" }));
  assert.equal(first.content, "<h1>one</h1>");
  assert.equal(first.version, 1);
  assert.equal(first.latest, true);
  assert.deepEqual(first.versions.map((v) => v.n), [1]);

  write("sales.html", "<h1>two</h1>");
  list = await json(await get("/api/artifacts"));
  assert.equal(list.items[0].versions, 2);
  const latest = await json(await get("/api/artifacts/get", { name: "sales.html" }));
  assert.equal(latest.content, "<h1>two</h1>");
  assert.equal(latest.version, 2);
  assert.equal(latest.latest, true);
  assert.deepEqual(latest.versions.map((v) => [v.n, v.source]), [[1, "claude"], [2, "claude"]]);
  const old = await json(await get("/api/artifacts/get", { name: "sales.html", version: "1" }));
  assert.equal(old.content, "<h1>one</h1>");
  assert.equal(old.latest, false);
  // unchanged content adds no version
  await get("/api/artifacts");
  assert.equal((await json(await get("/api/artifacts/get", { name: "sales.html" }))).versions.length, 2);
  assert.equal((await get("/api/artifacts/get", { name: "sales.html", version: "9" })).status, 404);
  assert.equal((await get("/api/artifacts/get", { name: "sales.html", version: "0" })).status, 400);
  assert.equal((await get("/api/artifacts/get", { name: "nothing.html" })).status, 404);
  assert.ok(existsSync(join(data, "artifact-versions")));
});

test("list is newest first", async () => {
  write("older.md", "# a");
  write("newer.mmd", "graph TD; A-->B");
  const { utimesSync } = await import("node:fs");
  utimesSync(art("older.md"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const list = await json(await get("/api/artifacts"));
  assert.ok(list.items.findIndex((i) => i.name === "newer.mmd") < list.items.findIndex((i) => i.name === "older.md"));
  assert.equal(list.items.find((i) => i.name === "older.md").kind, "markdown");
  assert.equal(list.items.find((i) => i.name === "newer.mmd").kind, "mermaid");
});

test("names are validated (traversal, folders, extensions)", async () => {
  for (const name of ["../x.html", "a/b.html", "..\\x.html", ".html", ".hidden.html", "x.js", "x.html.exe", "x", "", "a b.html", `${"a".repeat(90)}.html`]) {
    assert.equal((await get("/api/artifacts/get", { name })).status, 400, `get ${name}`);
    assert.equal((await get("/api/artifacts/view", { name })).status, 400, `view ${name}`);
    assert.equal((await post("/api/artifacts/delete", { name })).status, 400, `delete ${name}`);
    assert.equal((await post("/api/artifacts/save", { name, content: "x" })).status, 400, `save ${name}`);
  }
  writeFileSync(join(home, "secret.html"), "top secret");
  assert.equal((await get("/api/artifacts/view", { name: "../../../secret.html" })).status, 400);
});

test("a symlink inside the artifacts folder is never followed", async (t) => {
  write("real.html", "<p>x</p>");
  try { symlinkSync(join(home, "secret.html"), art("link.html")); } catch { return t.skip("symlinks are not allowed here"); }
  assert.equal((await get("/api/artifacts/get", { name: "link.html" })).status, 404);
  assert.equal((await get("/api/artifacts/view", { name: "link.html" })).status, 404);
  const list = await json(await get("/api/artifacts"));
  assert.equal(list.items.some((i) => i.name === "link.html"), false);
  assert.equal(list.items.some((i) => i.name === "real.html"), true);
});

test("an artifacts folder that is a symlink out of the project is refused", async (t) => {
  const other = join(home, "other");
  mkdirSync(join(other, ".wheelhouse"), { recursive: true });
  const outside = join(home, "outside-art");
  mkdirSync(outside);
  writeFileSync(join(outside, "x.html"), "outside");
  try { symlinkSync(outside, join(other, ".wheelhouse", "artifacts"), "junction"); } catch { return t.skip("symlinks are not allowed here"); }
  const response = await fetch(`${base}/api/artifacts?${new URLSearchParams({ cwd: other })}`);
  assert.equal(response.status, 403);
});

test("view serves html with a locked-down CSP", async () => {
  write("page.html", "<!doctype html><title>t</title><b>hi</b>");
  const response = await get("/api/artifacts/view", { name: "page.html" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<!doctype html><title>t</title><b>hi</b>");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /^sandbox allow-scripts allow-forms allow-modals allow-popups;/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  for (const part of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", "img-src data: blob:", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "script-src 'self' 'unsafe-inline'"]) assert.ok(csp.includes(part), part);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("content-disposition"), "inline");
  const download = await get("/api/artifacts/view", { name: "page.html", download: "1" });
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="page.html"');
  await download.arrayBuffer();
});

test("view serves svg as an image with scripts blocked, markdown and mermaid as plain text", async () => {
  write("pic.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const svg = await get("/api/artifacts/view", { name: "pic.svg" });
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal(svg.headers.get("content-security-policy"), "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'");
  await svg.arrayBuffer();
  for (const name of ["notes.md", "flow.mmd"]) {
    write(name, "# <script>x</script>");
    const response = await get("/api/artifacts/view", { name });
    assert.match(response.headers.get("content-type"), /^text\/plain/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    await response.arrayBuffer();
  }
});

test("view can show an older version", async () => {
  const old = await get("/api/artifacts/view", { name: "sales.html", version: "1" });
  assert.equal(await old.text(), "<h1>one</h1>");
});

test("a page can be opened on its own: a plain top-level GET (no Origin header) works", async () => {
  const response = await fetch(`${base}/api/artifacts/view?${new URLSearchParams({ cwd: project, name: "page.html" })}`, { headers: { "sec-fetch-site": "none" } });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
});

test("save writes a new artifact, never overwrites silently, and records a version", async () => {
  const first = await json(await post("/api/artifacts/save", { kind: "markdown", title: "Weekly Report!", content: "# one", source: "message" }));
  assert.deepEqual(first, { name: "weekly-report.md", kind: "markdown", version: 1 });
  assert.equal(readFileSync(art("weekly-report.md"), "utf8"), "# one");
  const second = await json(await post("/api/artifacts/save", { kind: "markdown", title: "Weekly Report!", content: "# two" }));
  assert.equal(second.name, "weekly-report-2.md");
  assert.equal(readFileSync(art("weekly-report.md"), "utf8"), "# one");
  const named = await json(await post("/api/artifacts/save", { name: "weekly-report.md", content: "# three", overwrite: true }));
  assert.deepEqual(named, { name: "weekly-report.md", kind: "markdown", version: 2 });
  const got = await json(await get("/api/artifacts/get", { name: "weekly-report.md" }));
  assert.deepEqual(got.versions.map((v) => [v.n, v.source]), [[1, "message"], [2, "manual"]]);
  const auto = await json(await post("/api/artifacts/save", { kind: "mermaid", content: "graph TD; A-->B" }));
  assert.match(auto.name, /^mermaid-\d{8}-\d{6}\.mmd$/);
  assert.equal((await post("/api/artifacts/save", { kind: "pdf", content: "x" })).status, 400);
  assert.equal((await post("/api/artifacts/save", { kind: "html" })).status, 400);
  assert.equal((await post("/api/artifacts/save", { kind: "html", content: "x".repeat(5 * 1024 * 1024 + 1) })).status, 413);
});

test("only 50 versions are kept", async () => {
  write("busy.mmd", "graph TD; A-->B0");
  await get("/api/artifacts");
  for (let i = 1; i < 55; i += 1) {
    write("busy.mmd", `graph TD; A-->B${i}`);
    await get("/api/artifacts/get", { name: "busy.mmd" });
  }
  const got = await json(await get("/api/artifacts/get", { name: "busy.mmd" }));
  assert.equal(got.versions.length, 50);
  assert.equal(got.version, 55);
  assert.equal(got.versions[0].n, 6);
  assert.equal((await get("/api/artifacts/get", { name: "busy.mmd", version: "5" })).status, 404);
});

test("concurrent lookups of a changed file store exactly one new version", async () => {
  write("race.html", "<p>a</p>");
  await get("/api/artifacts/get", { name: "race.html" });
  write("race.html", "<p>b</p>");
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? get("/api/artifacts") : get("/api/artifacts/get", { name: "race.html" })).then((r) => r.arrayBuffer())));
  const got = await json(await get("/api/artifacts/get", { name: "race.html" }));
  assert.deepEqual(got.versions.map((v) => v.n), [1, 2]);
});

test("delete removes the file and its stored versions", async () => {
  write("gone.html", "<p>x</p>");
  await get("/api/artifacts/get", { name: "gone.html" });
  const { createHash } = await import("node:crypto");
  const realRoot = readdirSync(join(data, "artifact-versions"));
  const dirs = realRoot.map((hash) => join(data, "artifact-versions", hash, "gone.html")).filter((dir) => existsSync(dir));
  assert.equal(dirs.length, 1);
  assert.ok(createHash); // (the folder name is the project's sha1; only its existence matters here)
  const response = await post("/api/artifacts/delete", { name: "gone.html" });
  assert.deepEqual(await json(response), { ok: true });
  assert.equal(existsSync(art("gone.html")), false);
  assert.equal(existsSync(dirs[0]), false);
  assert.equal((await get("/api/artifacts/get", { name: "gone.html" })).status, 404);
  assert.equal((await post("/api/artifacts/delete", { name: "gone.html" })).status, 200); // deleting twice is fine
});

test("cwd is required and must be a folder", async () => {
  assert.equal((await fetch(`${base}/api/artifacts`)).status, 400);
  assert.equal((await fetch(`${base}/api/artifacts?cwd=${encodeURIComponent(join(home, "nope"))}`)).status, 400);
});

test(".wheelhouse/ is kept out of git status of a repository", async (t) => {
  const repo = join(home, "repo");
  mkdirSync(repo);
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
  } catch {
    return t.skip("git is not available");
  }
  const response = await post("/api/artifacts/save", { cwd: repo, kind: "html", title: "Dash", content: "<p>x</p>" });
  assert.equal(response.status, 200);
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.wheelhouse\/$/m);
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  assert.equal(status.trim(), "");
  await post("/api/artifacts/save", { cwd: repo, kind: "html", title: "Dash two", content: "<p>y</p>" });
  assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").match(/^\.wheelhouse\/$/gm).length, 1);
});

// ---- the system prompt hint ---------------------------------------------------------------------------------------
function optionsFor(config, prefs = {}) {
  const manager = new SessionManager({ claudeBin: undefined, systemPromptAppend: "Be brief.", chrome: false, ...config }, { prefs: () => prefs });
  try {
    return manager.create({ cwd: process.cwd(), meta: {} }).buildOptions();
  } finally {
    clearInterval(manager.reaper);
  }
}

test("the artifact hint is appended exactly when artifacts are on (Settings toggle wins)", () => {
  assert.ok(ARTIFACT_HINT.length < 1000);
  assert.match(ARTIFACT_HINT, /\.wheelhouse\/artifacts\//);
  assert.match(ARTIFACT_HINT, /\/vendor\/chart\.umd\.js/);
  assert.equal(optionsFor({ artifacts: false }).systemPrompt.append, "Be brief.");
  assert.equal(optionsFor({}).systemPrompt.append, "Be brief.");
  assert.equal(optionsFor({ artifacts: true }).systemPrompt.append, `Be brief.\n\n${ARTIFACT_HINT}`);
  assert.equal(optionsFor({ artifacts: true }, { artifacts: false }).systemPrompt.append, "Be brief.");
  assert.equal(optionsFor({ artifacts: false }, { artifacts: true }).systemPrompt.append, `Be brief.\n\n${ARTIFACT_HINT}`);
});

test("the artifacts option defaults to on and can be turned off by config or environment", async () => {
  const { loadConfig } = await import("../server/lib/config.mjs");
  const file = join(home, "cfg-off.json");
  writeFileSync(file, JSON.stringify({ artifacts: false }));
  const none = join(home, "cfg-none.json");
  writeFileSync(none, JSON.stringify({}));
  const env = { HOME: home, USERPROFILE: home };
  assert.equal(loadConfig({ argv: ["--config", none], env }).artifacts, true);
  assert.equal(loadConfig({ argv: ["--config", file], env }).artifacts, false);
  assert.equal(loadConfig({ argv: ["--config", none], env: { ...env, WHEELHOUSE_ARTIFACTS: "0" } }).artifacts, false);
  assert.equal(loadConfig({ argv: ["--config", file], env: { ...env, WHEELHOUSE_ARTIFACTS: "1" } }).artifacts, true);
});

test("the config endpoint reports the setting and PUT /api/prefs {artifacts} overrides it", async () => {
  const cfg = await json(await fetch(`${base}/api/config`, { headers: { origin: base } }));
  assert.equal(cfg.artifacts, true);
  await fetch(`${base}/api/prefs`, { method: "PUT", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ artifacts: false }) });
  assert.equal((await json(await fetch(`${base}/api/config`, { headers: { origin: base } }))).artifacts, false);
});

test("Mermaid and Chart.js are vendored and the entry's chunks resolve", () => {
  assert.ok(existsSync(join(root, "web", "vendor", "chart.umd.js")));
  const entry = join(root, "web", "vendor", "mermaid", "mermaid.esm.min.mjs");
  const source = readFileSync(entry, "utf8");
  const imports = [...source.matchAll(/from"(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 3);
  for (const spec of imports) assert.ok(existsSync(join(root, "web", "vendor", "mermaid", spec)), spec);
});
