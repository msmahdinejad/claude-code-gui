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

/** First chunk(s) of an SSE endpoint, until `until` matches or the timeout passes. */
async function sseHead(path, until, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  let text = "";
  try {
    const response = await fetch(base + path, { ...init, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (!until.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch { /* aborted: return what arrived */ }
  clearTimeout(timer);
  controller.abort();
  return text;
}

test("global events start with a boot id so a page can tell the server restarted", async () => {
  const head = await sseHead("/api/events", /event: hello[\s\S]*\n\n/);
  assert.match(head, /event: hello/);
  assert.match(head, /"boot":"[0-9a-f-]{36}"/);
});

test("a session stream tells a client with a stale position to start over", async () => {
  const created = await (await api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: home }) })).json();
  const stale = await sseHead(`/api/sessions/${created.id}/stream?after=500`, /event: reset/);
  assert.match(stale, /event: reset/);
  const fresh = await sseHead(`/api/sessions/${created.id}/stream?after=0`, /event: reset/);
  assert.doesNotMatch(fresh, /event: reset/);
  const unknown = await sseHead("/api/sessions/00000000-0000-0000-0000-000000000000/stream?after=0", /event: gone/);
  assert.match(unknown, /event: gone/);
});

test("status reports live session counts for the tray", async () => {
  const status = await (await api("/api/status")).json();
  assert.deepEqual({ ok: status.ok, live: status.live, running: status.running, waiting: status.waiting }, { ok: true, live: 0, running: 0, waiting: 0 });
});

test("shutdown is refused for foreign or missing origins and stops the server for the real one", async () => {
  const foreign = await fetch(`${base}/api/shutdown`, { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  const bare = await fetch(`${base}/api/shutdown`, { method: "POST" });
  assert.equal(bare.status, 403);
  assert.equal((await api("/api/health")).status, 200);

  const port = await freePort();
  const own = `http://127.0.0.1:${port}`;
  const second = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--data-dir", join(home, "data-2"), "--cwd", home], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude") },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => second.on("exit", resolve));
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${own}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const stop = await fetch(`${own}/api/shutdown`, { method: "POST", headers: { origin: own } });
  assert.equal(stop.status, 200);
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => { second.kill(); reject(new Error("server did not stop")); }, 8000))]);
});

test("unknown API endpoints return 404 JSON", async () => {
  const response = await api("/api/nope");
  assert.equal(response.status, 404);
  assert.ok((await response.json()).error);
});
