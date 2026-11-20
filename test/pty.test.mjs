import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDLE_MS, MAX_INPUT_CHARS, RingBuffer, SHELL_IDS, createPtyService, resolveShell, validateInput, validateSize } from "../server/lib/routes/pty.mjs";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- pure helpers -------------------------------------------------------------------------
test("ring buffer keeps the newest entries within its byte limit and resumes by sequence", () => {
  const ring = new RingBuffer(100);
  for (let i = 1; i <= 10; i += 1) ring.push("data", `"${i}"`, 30);
  assert.equal(ring.seq, 10);
  assert.ok(ring.bytes <= 100);
  assert.deepEqual(ring.entries.map((entry) => entry.seq), [8, 9, 10]);
  assert.equal(ring.oldest, 8);
  assert.deepEqual(ring.after(8).map((entry) => entry.seq), [9, 10]);
  assert.equal(ring.after(0).length, 3);
  assert.equal(ring.after(10).length, 0);
  // a single entry bigger than the limit is still kept (the newest data must never vanish)
  const small = new RingBuffer(10);
  small.push("data", "x", 50);
  assert.equal(small.entries.length, 1);
});

test("shell ids come from a fixed allow-list; paths and unknown names are refused", () => {
  const win = { platform: "win32", env: { PATH: "C:\\bin", ComSpec: "C:\\Windows\\System32\\cmd.exe" }, exists: () => true };
  for (const bad of ["C:\\Windows\\System32\\cmd.exe", "/bin/sh", "bash.exe", "powershell.exe -c calc", "", null, undefined, 7, "../bash", "PowerShell"]) {
    assert.equal(resolveShell(bad, win), null, String(bad));
  }
  for (const id of SHELL_IDS) assert.ok(resolveShell(id, win), id);
  assert.equal(resolveShell("default", win).id, "powershell");
  assert.equal(resolveShell("default", { ...win, defaultShell: "cmd" }).id, "cmd");
  assert.equal(resolveShell("default", { ...win, defaultShell: "C:\\evil.exe" }).id, "powershell"); // not an allow-list id
  assert.match(resolveShell("bash", win).file, /bin[\\/]bash\.exe$/);
  assert.equal(resolveShell("bash", { ...win, exists: () => false }), null); // never a bare "bash.exe" (the WSL launcher)
  assert.equal(resolveShell("pwsh", { ...win, exists: () => false }), null);
  const posix = { platform: "linux", env: { PATH: "/usr/bin" }, exists: (path) => path === "/bin/bash" };
  assert.equal(resolveShell("bash", posix).file, "/bin/bash");
  assert.equal(resolveShell("cmd", posix), null);
  assert.equal(resolveShell("powershell", posix), null);
  assert.equal(resolveShell("default", posix).file, "/bin/bash");
  assert.equal(resolveShell("default", { ...posix, exists: () => false }).file, "/bin/sh");
});

test("size and input validation", () => {
  assert.deepEqual(validateSize({}), { cols: 80, rows: 24 });
  assert.deepEqual(validateSize({ cols: 120, rows: 40 }), { cols: 120, rows: 40 });
  for (const body of [{ cols: 1 }, { cols: 501 }, { rows: 0 }, { rows: 301 }, { cols: 80.5 }, { cols: "80" }, { rows: -3 }, { cols: NaN }]) assert.throws(() => validateSize(body), JSON.stringify(body));
  assert.equal(validateInput("ls\r"), "ls\r");
  for (const bad of ["", null, undefined, 5, {}, ["a"]]) assert.throws(() => validateInput(bad));
  assert.throws(() => validateInput("x".repeat(MAX_INPUT_CHARS + 1)), (error) => error.status === 413);
});

// ---- service with a fake node-pty ----------------------------------------------------------
function fakePty() {
  const spawned = [];
  const api = {
    spawn(file, args, options) {
      const handlers = { data: [], exit: [] };
      const proc = {
        pid: undefined, // no real process: the tree kill is skipped
        file, args, options, written: [], resized: [], killed: false,
        onData: (fn) => handlers.data.push(fn),
        onExit: (fn) => handlers.exit.push(fn),
        write(text) { this.written.push(text); },
        resize(cols, rows) { this.resized.push([cols, rows]); },
        kill() { this.killed = true; },
        emit(text) { for (const fn of handlers.data) fn(text); },
        finish(exitCode) { for (const fn of handlers.exit) fn({ exitCode, signal: 0 }); },
      };
      spawned.push(proc);
      return proc;
    },
  };
  return { api, spawned };
}

const fakeRes = () => ({ chunks: [], ended: false, head: null, writeHead(status, headers) { this.head = { status, headers }; }, write(text) { this.chunks.push(text); }, end() { this.ended = true; } });
const fakeReq = (headers = {}) => { const handlers = {}; return { headers, on: (event, fn) => { handlers[event] = fn; }, close: () => handlers.close?.() }; };
const decodeData = (chunks) => chunks.join("").split("\n\n").filter((frame) => frame.includes("event: data")).map((frame) => Buffer.from(JSON.parse(frame.split("data: ")[1]).d, "base64").toString("utf8")).join("");

function makeService(overrides = {}) {
  const fake = fakePty();
  const service = createPtyService({ HttpError, loadPty: async () => fake.api, env: () => ({ PATH: process.env.PATH, Path: process.env.Path, SECRET_KEY: "from-profile", GONE: undefined }), platform: process.platform === "win32" ? "win32" : "linux", ...overrides });
  return { service, fake };
}
const workdir = mkdtempSync(join(tmpdir(), "wheelhouse-pty-"));

test("info reports unavailability when node-pty cannot be loaded, and open is refused with 501", async () => {
  const service = createPtyService({ HttpError, loadPty: async () => { throw new Error("Cannot find package 'node-pty'\nstack..."); } });
  const info = await service.info();
  assert.equal(info.available, false);
  assert.match(info.reason, /node-pty/);
  assert.ok(!info.reason.includes("stack"));
  await assert.rejects(service.open({ cwd: workdir }), (error) => error.status === 501);
});

test("open validates shell, size and cwd, uses the profile environment, and enforces the limit", async () => {
  const { service, fake } = makeService({ max: 2 });
  assert.equal((await service.info()).available, true);
  await assert.rejects(service.open({ cwd: workdir, shell: "C:\\Windows\\System32\\cmd.exe" }), (error) => error.status === 400);
  await assert.rejects(service.open({ cwd: workdir, shell: "../../bin/sh" }), (error) => error.status === 400);
  await assert.rejects(service.open({ cwd: workdir, cols: 9999 }), (error) => error.status === 400);
  await assert.rejects(service.open({ cwd: join(workdir, "missing") }), (error) => error.status === 400);
  await assert.rejects(service.open({}), (error) => error.status === 400);
  await assert.rejects(service.open({ cwd: 42 }), (error) => error.status === 400);
  assert.equal(fake.spawned.length, 0);

  const a = await service.open({ cwd: workdir, cols: 100, rows: 30 });
  assert.match(a.id, /^pty-[0-9a-f]{18}$/);
  assert.equal(a.running, true);
  const proc = fake.spawned[0];
  assert.equal(proc.options.cols, 100);
  assert.equal(proc.options.rows, 30);
  assert.equal(proc.options.env.SECRET_KEY, "from-profile");
  assert.ok(!("GONE" in proc.options.env));
  assert.equal(proc.options.env.TERM, "xterm-256color");
  assert.equal(proc.options.cwd, a.cwd);

  await service.open({ cwd: workdir });
  await assert.rejects(service.open({ cwd: workdir }), (error) => error.status === 429);
  service.close(a.id);
  assert.equal(proc.killed, true);
  await service.open({ cwd: workdir }); // a slot is free again
  service.closeAll();
  assert.equal(service.ptys.size, 0);
});

test("input, resize and close go to the right terminal and reject bad ids and payloads", async () => {
  const { service, fake } = makeService();
  const { id } = await service.open({ cwd: workdir });
  const proc = fake.spawned[0];
  service.input(id, "echo hi\r");
  assert.deepEqual(proc.written, ["echo hi\r"]);
  assert.throws(() => service.input(id, ""), (error) => error.status === 400);
  assert.throws(() => service.input(id, "x".repeat(MAX_INPUT_CHARS + 1)), (error) => error.status === 413);
  assert.throws(() => service.input("nope", "x"), (error) => error.status === 404);
  assert.throws(() => service.input("../../etc", "x"), (error) => error.status === 404);
  service.resize(id, { cols: 90, rows: 20 });
  assert.deepEqual(proc.resized, [[90, 20]]);
  assert.throws(() => service.resize(id, { cols: 90 }), (error) => error.status === 400);
  assert.throws(() => service.resize(id, { cols: 1, rows: 1 }), (error) => error.status === 400);
  proc.finish(0);
  assert.throws(() => service.input(id, "x"), (error) => error.status === 409);
  assert.equal(service.close("pty-ffffffffffffffffff").ok, true); // closing something unknown is not an error
  service.closeAll();
});

test("stream sends base64 chunks with sequence numbers and resumes after a given sequence", async () => {
  const { service, fake } = makeService();
  const { id } = await service.open({ cwd: workdir });
  const proc = fake.spawned[0];
  proc.emit("héllo ");
  await sleep(40);
  const req = fakeReq();
  const res = fakeRes();
  service.stream(req, res, id, 0);
  assert.equal(res.head.status, 200);
  assert.match(res.head.headers["Content-Type"], /text\/event-stream/);
  assert.match(res.chunks[0], /^event: hello/);
  proc.emit("wörld");
  await sleep(40);
  assert.equal(decodeData(res.chunks), "héllo wörld");
  assert.ok(res.chunks.join("").match(/^id: \d+$/gm).length >= 2);
  proc.finish(3);
  assert.match(res.chunks.join(""), /event: exit\ndata: \{"code":3,"signal":null\}/);

  // resume: only what came after seq 1 is replayed (the exit event included)
  const res2 = fakeRes();
  service.stream(fakeReq(), res2, id, 1);
  assert.equal(decodeData(res2.chunks), "wörld");
  assert.match(res2.chunks.join(""), /event: exit/);
  // a client that is ahead of the server (it restarted) starts over
  const res3 = fakeRes();
  service.stream(fakeReq({ "last-event-id": "99" }), res3, id, 0);
  assert.equal(decodeData(res3.chunks), "héllo wörld");
  req.close();
  assert.equal(service.ptys.get(id).clients.size, 2); // the closed viewer is gone; res2 and res3 are attached
  assert.throws(() => service.stream(fakeReq(), fakeRes(), "pty-000000000000000000"), (error) => error.status === 404);
  service.closeAll();
  assert.equal(res2.ended, true);
});

test("scrollback is bounded", async () => {
  const { service, fake } = makeService({ scrollback: 4096 });
  const { id } = await service.open({ cwd: workdir });
  const proc = fake.spawned[0];
  for (let i = 0; i < 30; i += 1) { proc.emit("x".repeat(1000)); await sleep(12); }
  assert.ok(service.ptys.get(id).ring.bytes <= 4096 + 1000);
  const res = fakeRes();
  service.stream(fakeReq(), res, id, 0);
  assert.ok(decodeData(res.chunks).length <= 5096);
  assert.ok(JSON.parse(res.chunks[0].split("data: ")[1]).oldest > 1);
  service.closeAll();
});

test("idle terminals without a viewer are closed; viewed and recent ones stay", async () => {
  let clock = 1_000_000;
  const { service, fake } = makeService({ now: () => clock });
  const idle = await service.open({ cwd: workdir });
  const watched = await service.open({ cwd: workdir });
  service.stream(fakeReq(), fakeRes(), watched.id, 0);
  clock += 60_000;
  service.sweep();
  assert.equal(service.ptys.size, 2);
  clock += IDLE_MS;
  service.sweep();
  assert.ok(!service.ptys.has(idle.id));
  assert.equal(fake.spawned[0].killed, true);
  assert.ok(service.ptys.has(watched.id));
  service.closeAll();
});

// ---- real server (the PTY endpoints go through the same guards as every /api route) -------
const root = fileURLToPath(new URL("..", import.meta.url));
let nodePtyLoads = false;
try { await import("node-pty"); nodePtyLoads = true; } catch { /* optional dependency not installed */ }
let child;
let base;
let home;

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const api = (path, init = {}) => fetch(base + path, { ...init, headers: { origin: base, "content-type": "application/json", ...(init.headers || {}) } });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "wheelhouse-pty-srv-"));
  mkdirSync(join(home, "claude"));
  const configFile = join(home, "wheelhouse.config.json");
  writeFileSync(configFile, JSON.stringify({ autoTitle: false, profiles: { default: { label: "Test", configDir: join(home, "claude") } } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude") };
  for (const key of ["WHEELHOUSE_CONFIG", "WHEELHOUSE_DATA_DIR", "WHEELHOUSE_PORT", "WHEELHOUSE_CWD", "WHEELHOUSE_WORKSPACE_ROOT", "CLAUDE_BIN"]) delete env[key];
  child = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--config", configFile, "--data-dir", join(home, "data"), "--cwd", home], { env, stdio: "ignore" });
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) { await api("/api/prefs", { method: "PUT", body: JSON.stringify({ autoUpdateClaude: false }) }); return; }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("server did not start");
});

after(() => child?.kill());

test("server: PTY endpoints refuse cross-site requests and bad input", async () => {
  const foreign = await fetch(`${base}/api/pty/open`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ cwd: home }) });
  assert.equal(foreign.status, 403);
  const noOrigin = await fetch(`${base}/api/pty/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: home }) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await fetch(`${base}/api/pty/info`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${base}/api/pty/pty-000000000000000000/stream`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const info = await (await api("/api/pty/info")).json();
  assert.equal(typeof info.available, "boolean");
  const shell = await api("/api/pty/open", { method: "POST", body: JSON.stringify({ cwd: home, shell: "C:\\Windows\\System32\\cmd.exe" }) });
  assert.ok(shell.status === 400 || (!info.available && shell.status === 501), `status ${shell.status}`);
  const cwd = await api("/api/pty/open", { method: "POST", body: JSON.stringify({ cwd: join(home, "nope") }) });
  assert.ok(cwd.status === 400 || (!info.available && cwd.status === 501), `status ${cwd.status}`);
  assert.equal((await api("/api/pty/pty-000000000000000000/state")).status, 404);
  assert.equal((await api("/api/pty/not-an-id/state")).status, 404);
});

test("server: a real shell round trip over SSE + POST", { skip: !nodePtyLoads && "node-pty is not installed", timeout: 60_000 }, async () => {
  const info = await (await api("/api/pty/info")).json();
  assert.equal(info.available, true, info.reason);
  const opened = await (await api("/api/pty/open", { method: "POST", body: JSON.stringify({ cwd: home, cols: 100, rows: 30 }) })).json();
  assert.match(opened.id, /^pty-/);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/pty/${opened.id}/stream?after=0`, { headers: { origin: base }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let output = "";
  const pump = async (until, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !until()) {
      const result = await Promise.race([reader.read(), sleep(500).then(() => null)]);
      if (result?.done) break;
      if (!result) continue;
      raw += decoder.decode(result.value, { stream: true });
      output = decodeData([raw]);
    }
  };
  await pump(() => output.length > 0, 20_000); // the shell printed its banner or prompt
  // the typed text never contains "hello-pty" contiguously, so seeing it proves the command ran
  const command = process.platform === "win32" ? "Write-Output ('hel'+'lo-pty')\r" : "echo hel\"\"lo-pty\r";
  assert.equal((await api(`/api/pty/${opened.id}/input`, { method: "POST", body: JSON.stringify({ data: command }) })).status, 200);
  await pump(() => output.includes("hello-pty"), 20_000);
  assert.ok(output.includes("hello-pty"), `output was: ${JSON.stringify(output.slice(-300))}`);
  assert.equal((await api(`/api/pty/${opened.id}/resize`, { method: "POST", body: JSON.stringify({ cols: 90, rows: 20 }) })).status, 200);
  assert.equal((await api(`/api/pty/${opened.id}`, { method: "DELETE" })).status, 200);
  controller.abort();
  assert.equal((await api(`/api/pty/${opened.id}/state`)).status, 404);
});
