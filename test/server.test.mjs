import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let child;
let base;
let home;

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
  home = mkdtempSync(join(tmpdir(), "wheelhouse-srv-"));
  child = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--data-dir", join(home, "data"), "--cwd", home], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude") },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not start");
});

after(() => child?.kill());

const api = (path, init = {}) => fetch(base + path, { ...init, headers: { origin: base, "content-type": "application/json", ...(init.headers || {}) } });

test("serves the app shell with a strict CSP", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await response.text(), /<title>Wheelhouse<\/title>/);
});

test("static files cannot escape the web root", async () => {
  const response = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.ok([403, 404].includes(response.status));
});

test("API rejects cross-origin requests and state changes without an Origin", async () => {
  const foreign = await fetch(`${base}/api/config`, { headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  const post = await fetch(`${base}/api/prefs`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 403);
});

test("config exposes version, defaults and profiles", async () => {
  const body = await (await api("/api/config")).json();
  assert.match(body.version, /^\d+\.\d+\.\d+/);
  assert.equal(body.defaults.model, "default");
  const profile = await (await api("/api/profile")).json();
  assert.equal(profile.active, "default");
  assert.ok(Array.isArray(profile.profiles));
});

test("feature discovery lists modules, styles and translations", async () => {
  const features = await (await api("/api/features")).json();
  assert.ok(features.js.some((path) => path.endsWith("connection.js")));
  assert.ok(features.css.length > 0);
  assert.ok(features.i18n.some((path) => path.endsWith("core.js")));
});

test("filesystem routes list real folders and fail cleanly on missing files", async () => {
  const list = await api(`/api/fs/list?path=${encodeURIComponent(home)}`);
  assert.equal(list.status, 200);
  const missing = await api(`/api/fs/read?path=${encodeURIComponent(join(home, "does-not-exist"))}`);
  assert.notEqual(missing.status, 200);
  assert.ok((await missing.json()).error);
});

test("unknown API endpoints return 404 JSON", async () => {
  const response = await api("/api/nope");
  assert.equal(response.status, 404);
  assert.ok((await response.json()).error);
});
