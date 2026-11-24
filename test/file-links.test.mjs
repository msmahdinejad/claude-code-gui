// File links (parsing what Claude writes, the resolve/stat/open/read routes and their credential guard) and the artifact
// versions stored as Claude writes them.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePathRef, findPathsInText, isFileHref, hrefToRef, splitSuffix, fileUrlToPath } from "../web/js/core/file-path.js";
import { isCredentialPath } from "../server/lib/routes/workspace.mjs";
import registerArtifacts, { artifactWrites, toolResults } from "../server/lib/routes/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let child;
let base;
let home;
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
  home = mkdtempSync(join(tmpdir(), "wheelhouse-links-"));
  project = join(home, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "app.js"), "console.log(1);\n");
  writeFileSync(join(project, "README.md"), "# hi\n");
  writeFileSync(join(project, "run.ps1"), "Write-Host hi\n");
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
  writeFileSync(join(home, "notes.txt"), "outside\n");
  const configFile = join(home, "wheelhouse.config.json");
  writeFileSync(configFile, JSON.stringify({ autoTitle: false, profiles: { default: { label: "Test", configDir: join(home, "claude") } } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"), WHEELHOUSE_NO_OPEN: "1" };
  for (const key of ["WHEELHOUSE_CONFIG", "WHEELHOUSE_DATA_DIR", "WHEELHOUSE_PORT", "WHEELHOUSE_CWD", "WHEELHOUSE_WORKSPACE_ROOT", "CLAUDE_BIN"]) delete env[key];
  child = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--config", configFile, "--data-dir", join(home, "data"), "--cwd", home], { env, stdio: "ignore" });
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

const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ cwd: project, ...body }) });
const get = (path, params) => fetch(`${base}${path}?${new URLSearchParams({ cwd: project, ...params })}`);

// ---- parsing ------------------------------------------------------------------------------------
test("paths in running text: folders and an extension are needed, positions are kept", () => {
  const text = "See src/app.js:12 and D:\\proj\\docs\\x.md, also /etc/hosts.conf; not and/or or v1.2.3 or http://x.io/a.js";
  const found = findPathsInText(text);
  assert.deepEqual(found.map((f) => [f.path, f.line]), [["src/app.js", 12], ["D:\\proj\\docs\\x.md", undefined], ["/etc/hosts.conf", undefined]]);
  for (const f of found) assert.equal(text.slice(f.start, f.end), f.raw);
});

test("inline code: one whole path, bare names allowed; versions, URLs and prose are not paths", () => {
  assert.deepEqual(parsePathRef("package.json", { bare: true }), { path: "package.json" });
  assert.deepEqual(parsePathRef("src/a.ts#L3-L9"), { path: "src/a.ts", line: 3 });
  assert.deepEqual(parsePathRef("src/a.ts:42:7"), { path: "src/a.ts", line: 42, col: 7 });
  assert.equal(parsePathRef("package.json"), null); // running text needs a folder part
  assert.equal(parsePathRef("v1.2.3", { bare: true }), null);
  assert.equal(parsePathRef("https://x.io/a.js", { bare: true }), null);
  assert.equal(parsePathRef("npm run build", { bare: true }), null);
  assert.deepEqual(parsePathRef("Dockerfile", { bare: true }), { path: "Dockerfile" });
});

test("markdown link targets: files vs web addresses, file: URLs and line anchors", () => {
  assert.equal(isFileHref("src/a.ts"), true);
  assert.equal(isFileHref("./docs/x.md#L3"), true);
  assert.equal(isFileHref("D:\\a\\b.txt"), true);
  assert.equal(isFileHref("file:///D:/a/b.md"), true);
  assert.equal(isFileHref("https://example.com/a.js"), false);
  assert.equal(isFileHref("mailto:a@b.c"), false);
  assert.equal(isFileHref("#section"), false);
  assert.deepEqual(hrefToRef("docs/a.md#L7"), { path: "docs/a.md", line: 7 });
  assert.deepEqual(hrefToRef("docs/a.md#usage"), { path: "docs/a.md" });
  assert.equal(fileUrlToPath("file:///D:/a/b.md"), "D:/a/b.md");
  assert.equal(fileUrlToPath("file:///home/x/y.md"), "/home/x/y.md");
  assert.deepEqual(splitSuffix("C:\\a.ts:5"), { path: "C:\\a.ts", line: 5, col: undefined });
});

test("credential stores are recognised in any position and with either separator", () => {
  for (const path of ["/home/u/.ssh/config", "C:\\Users\\u\\.ssh\\known_hosts", "/home/u/.aws/credentials", "C:\\Users\\u\\.claude\\.credentials.json", "/x/id_rsa", "/x/server.PEM", "/x/.git-credentials", "/x/.kube/config"]) {
    assert.equal(isCredentialPath(path), true, path);
  }
  for (const path of ["/home/u/project/src/key.js", "/home/u/.claude/settings.json", "C:\\a\\ssh\\notes.md", "/x/keys.txt"]) {
    assert.equal(isCredentialPath(path), false, path);
  }
});

// ---- routes -------------------------------------------------------------------------------------
test("resolve: which mentioned paths exist (relative to the session folder, absolute, bare names), never credentials", async () => {
  const res = await post("/api/ws/fs/resolve", { paths: ["src/app.js", "README.md", "app.js", join(home, "notes.txt"), "nope/x.js", join(home, ".ssh", "id_ed25519"), "a\0b"] });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results["src/app.js"].exists, true);
  assert.equal(results["src/app.js"].inside, true);
  assert.equal(results["src/app.js"].rel, "src/app.js");
  assert.equal(results["README.md"].exists, true);
  assert.equal(results[join(home, "notes.txt")].inside, false);
  assert.equal(results[join(home, "notes.txt")].rel, null);
  assert.equal(results["nope/x.js"].exists, false);
  assert.equal(results[join(home, ".ssh", "id_ed25519")].exists, false);
  assert.equal(results["a\0b"].exists, false);
});

test("resolve answers at most 80 paths and needs a real folder", async () => {
  const many = Array.from({ length: 120 }, (_, i) => `src/f${i}.js`);
  const { results } = await (await post("/api/ws/fs/resolve", { paths: many })).json();
  assert.equal(Object.keys(results).length, 80);
  assert.equal((await post("/api/ws/fs/resolve", { cwd: join(home, "missing"), paths: ["a.js"] })).status, 400);
});

test("read shows files outside the project read-only, but never a credential store", async () => {
  const outside = await (await get("/api/ws/fs/read", { path: join(home, "notes.txt") })).json();
  assert.equal(outside.inside, false);
  assert.equal(outside.content, "outside\n");
  const key = await get("/api/ws/fs/read", { path: join(home, ".ssh", "id_ed25519") });
  assert.equal(key.status, 403);
  assert.doesNotMatch(await key.text(), /PRIVATE/);
  assert.deepEqual(await (await get("/api/ws/fs/stat", { path: join(home, ".ssh", "id_ed25519") })).json(), { exists: false });
});

test("writing stays inside the project and detects a file changed on disk", async () => {
  const info = await (await get("/api/ws/fs/read", { path: "src/app.js" })).json();
  const outside = await post("/api/ws/fs/write", { path: join(home, "notes.txt"), content: "x" });
  assert.equal(outside.status, 403);
  const escape = await post("/api/ws/fs/write", { path: "../notes.txt", content: "x" });
  assert.equal(escape.status, 403);
  writeFileSync(join(project, "src", "app.js"), "changed by someone else\n");
  const stale = new Date(Date.now() + 5000);
  const { utimesSync } = await import("node:fs");
  utimesSync(join(project, "src", "app.js"), stale, stale);
  const conflict = await post("/api/ws/fs/write", { path: "src/app.js", content: "mine", expectedMtime: info.mtime });
  assert.equal(conflict.status, 409);
  assert.equal(readFileSync(join(project, "src", "app.js"), "utf8"), "changed by someone else\n");
});

test("open: reveal works for anything, the default app only for documents, the editor never for credentials", async () => {
  assert.equal((await post("/api/ws/fs/open", { path: "README.md", action: "default" })).status, 200);
  assert.equal((await post("/api/ws/fs/open", { path: "run.ps1", action: "default" })).status, 415);
  assert.equal((await post("/api/ws/fs/open", { path: "run.ps1", action: "reveal" })).status, 200);
  assert.equal((await post("/api/ws/fs/open", { path: "src/app.js", action: "editor", line: 3 })).status, 200);
  assert.equal((await post("/api/ws/fs/open", { path: "src", action: "editor" })).status, 400);
  assert.equal((await post("/api/ws/fs/open", { path: join(home, ".ssh", "id_ed25519"), action: "editor" })).status, 403);
  assert.equal((await post("/api/ws/fs/open", { path: "README.md", action: "run" })).status, 400);
  assert.equal((await post("/api/ws/fs/open", { path: "missing.md", action: "default" })).status, 404);
});

test("open refuses a request from another site", async () => {
  const res = await fetch(`${base}/api/ws/fs/open`, { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify({ cwd: project, path: "README.md", action: "reveal" }) });
  assert.equal(res.status, 403);
});

// ---- artifacts written by Claude ------------------------------------------------------------------
test("artifactWrites / toolResults pick Claude's writes to the artifacts folder and their results", () => {
  const msg = { type: "assistant", message: { content: [
    { type: "tool_use", id: "a", name: "Write", input: { file_path: "C:\\p\\.wheelhouse\\artifacts\\chart.html", content: "x" } },
    { type: "tool_use", id: "b", name: "Edit", input: { file_path: "/p/.wheelhouse/artifacts/flow.mmd" } },
    { type: "tool_use", id: "c", name: "Write", input: { file_path: "/p/src/app.js" } },
    { type: "tool_use", id: "d", name: "Write", input: { file_path: "/p/.wheelhouse/artifacts/../evil.html" } },
    { type: "tool_use", id: "e", name: "Read", input: { file_path: "/p/.wheelhouse/artifacts/chart.html" } },
  ] } };
  assert.deepEqual(artifactWrites(msg).map((w) => [w.id, w.name]), [["a", "chart.html"], ["b", "flow.mmd"]]);
  assert.deepEqual(toolResults({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }, { type: "tool_result", tool_use_id: "b", is_error: true }, { type: "text", text: "x" }] } }), [{ id: "a", error: false }, { id: "b", error: true }]);
  assert.deepEqual(artifactWrites({ type: "user" }), []);
});

test("every revision Claude writes is stored as a version, even when nobody opens the pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wheelhouse-follow-"));
  try {
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".wheelhouse", "artifacts"), { recursive: true });
    const routes = [];
    class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
    const manager = new EventEmitter();
    const live = new EventEmitter();
    live.cwd = proj;
    manager.get = (id) => (id === "s1" ? live : null);
    manager.sessions = new Map();
    registerArtifacts({ route: (method, path, handler) => routes.push({ method, path, handler }), config: { dataDir: join(dir, "data") }, manager, HttpError });
    manager.emit("session.state", { id: "s1" });
    manager.emit("session.state", { id: "s1" }); // followed once only
    const file = join(proj, ".wheelhouse", "artifacts", "chart.html");
    const turn = async (id, content) => {
      live.emit("event", { msg: { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: file } }] } } });
      writeFileSync(file, content);
      live.emit("event", { msg: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } } });
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    await turn("t1", "<p>one</p>");
    await turn("t2", "<p>two!</p>");
    await turn("t3", "<p>three!!</p>");
    const get = routes.find((r) => r.method === "GET" && r.path === "/api/artifacts/get");
    const doc = await get.handler({ query: new URLSearchParams({ cwd: proj, name: "chart.html", version: "1" }) });
    assert.equal(doc.content, "<p>one</p>");
    assert.deepEqual(doc.versions.map((v) => v.n), [1, 2, 3]);
    assert.ok(doc.versions.every((v) => v.source === "claude"));
    assert.ok(existsSync(join(dir, "data", "artifact-versions")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
