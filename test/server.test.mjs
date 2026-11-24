import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let child;
let base;
let home;
let configFile;

/** Never the user's own config, data or Claude Code folders: everything lives in a temp folder. */
function serverEnv() {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude") };
  for (const key of ["WHEELHOUSE_CONFIG", "WHEELHOUSE_DATA_DIR", "WHEELHOUSE_PORT", "WHEELHOUSE_CWD", "WHEELHOUSE_WORKSPACE_ROOT", "CLAUDE_BIN"]) delete env[key];
  return env;
}

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
  configFile = join(home, "wheelhouse.config.json");
  writeFileSync(configFile, JSON.stringify({ autoTitle: false, profiles: { default: { label: "Test", configDir: join(home, "claude") } } }));
  child = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--config", configFile, "--data-dir", join(home, "data"), "--cwd", home], {
    env: serverEnv(),
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        await api("/api/prefs", { method: "PUT", body: JSON.stringify({ autoUpdateClaude: false }) });
        return;
      }
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

test("drafts are kept by the server, keep attachments on a text-only save, and go when emptied", async () => {
  const id = "draft-test-1";
  const empty = await (await api(`/api/drafts/${id}`)).json();
  assert.deepEqual(empty, { text: "", images: [], at: 0 });
  const image = { mediaType: "image/png", name: "a.png", size: 3, data: "AAAA" };
  assert.equal((await api(`/api/drafts/${id}`, { method: "PUT", body: JSON.stringify({ text: "hello", images: [image], at: 5 }) })).status, 200);
  let draft = await (await api(`/api/drafts/${id}`)).json();
  assert.equal(draft.text, "hello");
  assert.equal(draft.images[0].name, "a.png");
  await api(`/api/drafts/${id}`, { method: "PUT", body: JSON.stringify({ text: "hello again", keepImages: true, at: 6 }) });
  draft = await (await api(`/api/drafts/${id}`)).json();
  assert.equal(draft.text, "hello again");
  assert.equal(draft.images.length, 1, "the split pane's text-only save keeps the attachments");
  await api(`/api/drafts/${id}`, { method: "PUT", body: JSON.stringify({ text: "", images: [], at: 7 }) });
  const cleared = await (await api(`/api/drafts/${id}`)).json();
  assert.equal(cleared.text, "");
  assert.deepEqual(cleared.images, []);
  await api(`/api/drafts/${id}`, { method: "PUT", body: JSON.stringify({ text: "an older save", at: 6 }) });
  assert.equal((await (await api(`/api/drafts/${id}`)).json()).text, "", "an older save does not bring old text back");
  assert.equal((await api("/api/drafts/..%2fx", { method: "PUT", body: "{}" })).status, 400);
});

test("the outbox refuses empty messages and reports an empty queue as null", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const view = await (await api(`/api/sessions/${id}/outbox`)).json();
  assert.equal(view.outbox, null);
  const empty = await api(`/api/sessions/${id}/outbox`, { method: "POST", body: JSON.stringify({ text: "  ", cwd: home }) });
  assert.equal(empty.status, 400);
  const missing = await api(`/api/sessions/${id}/outbox/00000000-0000-4000-8000-000000000000`, { method: "DELETE" });
  assert.equal(missing.status, 404);
});

test("shutdown is refused for foreign or missing origins and stops the server for the real one", async () => {
  const foreign = await fetch(`${base}/api/shutdown`, { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  const bare = await fetch(`${base}/api/shutdown`, { method: "POST" });
  assert.equal(bare.status, 403);
  assert.equal((await api("/api/health")).status, 200);

  const port = await freePort();
  const own = `http://127.0.0.1:${port}`;
  const second = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--config", configFile, "--data-dir", join(home, "data-2"), "--cwd", home], {
    env: serverEnv(),
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

test("open-external rejects other schemes and foreign origins", async () => {
  const bad = await api("/api/open-external", { method: "POST", body: JSON.stringify({ url: "file:///C:/Windows/System32/calc.exe" }) });
  assert.equal(bad.status, 400);
  const foreign = await fetch(`${base}/api/open-external`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
  assert.equal(foreign.status, 403);
});

test("notification endpoints: cursor, test notification, presence and focus validation", async () => {
  const start = await (await api("/api/notifications")).json();
  assert.deepEqual(start.items, []);
  const sent = await (await api("/api/notify-test", { method: "POST", body: "{}" })).json();
  assert.equal(sent.item.kind, "test");
  const after = await (await api(`/api/notifications?since=${start.cursor}`)).json();
  assert.equal(after.items.length, 1);
  assert.equal((await api("/api/presence", { method: "POST", body: JSON.stringify({ focused: true, sessionId: "x" }) })).status, 200);
  assert.equal((await api("/api/focus", { method: "POST", body: JSON.stringify({ sessionId: "../x" }) })).status, 400);
  assert.equal((await api("/api/focus", { method: "POST", body: JSON.stringify({ sessionId: "abc-123" }) })).status, 200);
  const foreign = await fetch(`${base}/api/notify-test`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(foreign.status, 403);
});

test("unknown API endpoints return 404 JSON", async () => {
  const response = await api("/api/nope");
  assert.equal(response.status, 404);
  assert.ok((await response.json()).error);
});

test("sign-in routes: unknown profile, unknown flow and foreign origins are refused", async () => {
  const unknown = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ name: "nope" }) });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /Unknown profile/);
  assert.equal((await api("/api/auth/login/not-a-flow")).status, 404);
  assert.equal((await api("/api/auth/login/not-a-flow/code", { method: "POST", body: JSON.stringify({ code: "x" }) })).status, 404);
  const foreign = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(foreign.status, 403);
});

test("Origin-less requests from other sites are refused; tools without browser headers and page navigation still work", async () => {
  const crossSite = await fetch(`${base}/api/catalog?force=1`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  const sameSite = await fetch(`${base}/api/fs/search?q=x`, { headers: { "sec-fetch-site": "same-site" } });
  assert.equal(sameSite.status, 403);
  const foreignReferer = await fetch(`${base}/api/git/info`, { headers: { referer: "https://evil.example/page" } });
  assert.equal(foreignReferer.status, 403);
  const tray = await fetch(`${base}/api/status`); // the tray: no Origin, no Sec-Fetch-* headers
  assert.equal(tray.status, 200);
  const page = await fetch(`${base}/api/status`, { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(page.status, 200);
  const shell = await fetch(`${base}/`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(shell.status, 200);
});

test("the legacy git routes are gone (the workspace routes replace them)", async () => {
  for (const path of ["/api/git/diff", "/api/git/log", "/api/git/branches"]) assert.equal((await api(path)).status, 404);
  assert.equal((await api("/api/git/action", { method: "POST", body: "{}" })).status, 404);
});

test("profile names that are Object.prototype keys are unknown profiles", async () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.equal((await api("/api/profile/switch", { method: "POST", body: JSON.stringify({ name }) })).status, 404);
    assert.equal((await api("/api/profile/test", { method: "POST", body: JSON.stringify({ name }) })).status, 404);
    assert.equal((await api("/api/auth/login", { method: "POST", body: JSON.stringify({ name }) })).status, 400);
    assert.equal((await api("/api/limit-reset/open", { method: "POST", body: JSON.stringify({ profile: name }) })).status, 400);
  }
  assert.equal((await (await api("/api/profile")).json()).active, "default");
});

test("a session stream ends with \"gone\" when a profile switch drops the session", async () => {
  const created = await (await api("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: home }) })).json();
  const stream = sseHead(`/api/sessions/${created.id}/stream?after=abc`, /event: gone/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await api("/api/profile/switch", { method: "POST", body: JSON.stringify({ name: "default" }) })).status, 200);
  assert.match(await stream, /event: gone/);
});
