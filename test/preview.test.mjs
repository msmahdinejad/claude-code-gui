import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPreviewUrl, frameHref, sandboxForUrl, isPreviewFile, SANDBOX_APP, SANDBOX_FILE, PREVIEW_HOSTS } from "../web/js/core/preview-url.js";
import { buildCommand, parseLaunchJson, probePort, stripJsonComments, validateConfiguration, within } from "../server/lib/routes/preview.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// ---- URL allow-list ------------------------------------------------------------------------------
test("accepts loopback http origins and normalises shorthand", () => {
  for (const [input, href] of [
    ["http://localhost:3000", "http://localhost:3000/"],
    ["http://127.0.0.1:5173/app?x=1#y", "http://127.0.0.1:5173/app?x=1#y"],
    ["http://[::1]:8080", "http://[::1]:8080/"],
    ["HTTP://LOCALHOST:3000", "http://localhost:3000/"],
    ["localhost:3000", "http://localhost:3000/"],
    ["localhost:3000/a/b", "http://localhost:3000/a/b"],
    ["127.0.0.1:4200", "http://127.0.0.1:4200/"],
    ["[::1]:9000", "http://[::1]:9000/"],
    ["3000", "http://localhost:3000/"],
    [":5173", "http://localhost:5173/"],
    ["  http://localhost:3000  ", "http://localhost:3000/"],
    ["http://localhost", "http://localhost/"],
  ]) {
    const result = checkPreviewUrl(input, 4173);
    assert.equal(result.ok, true, input);
    assert.equal(result.url, href, input);
  }
});

test("rejects other hosts, schemes, userinfo and tricks", () => {
  const rejected = [
    ["http://localhost.evil.com", "host"],
    ["http://localhost.evil.com:3000", "host"],
    ["http://evil.com", "host"],
    ["evil.com:3000", "host"],
    ["http://127.0.0.1@evil.com", "credentials"],
    ["http://127.0.0.1:3000@evil.com", "credentials"],
    ["http://localhost:3000@evil.com/", "credentials"],
    ["http://user:pass@localhost:3000", "credentials"],
    ["http://user@localhost:3000", "credentials"],
    ["http://evil.com#@localhost:3000", "host"],
    ["http://evil.com\\@localhost:3000", "host"],
    ["http://localhost.:3000", "host"],
    ["http://foo.localhost:3000", "host"],
    ["http://localhost@evil.com:3000", "credentials"],
    ["http://0.0.0.0:3000", "host"],
    ["http://192.168.1.5:3000", "host"],
    ["http://10.0.0.1:80", "host"],
    ["http://[::ffff:127.0.0.1]:3000", "host"],
    ["http://[::2]:3000", "host"],
    ["http://169.254.169.254", "host"],
    ["https://localhost:3000", "scheme"],
    ["ftp://localhost:21", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,<script>1</script>", "scheme"],
    ["blob:http://localhost:3000/x", "scheme"],
    ["about:blank", "scheme"],
    ["http://localhost:0", "port"],
    ["http://localhost:99999", "invalid"],
    ["", "empty"],
    ["   ", "empty"],
    ["http://", "invalid"],
    ["//localhost:3000", "invalid"],
  ];
  for (const [input, reason] of rejected) {
    const result = checkPreviewUrl(input, 4173);
    assert.equal(result.ok, false, `${input} should be rejected`);
    if (reason !== "invalid") assert.equal(result.reason, reason, input);
  }
});

test("the framed origin is always the one that was validated (hostile spellings normalise to loopback or fail)", () => {
  for (const input of ["http://127.1:3000", "http://0x7f.0.0.1:3000", "http://2130706433:3000", "http://localhost:3000\\@evil.com", "http://127.0.0.1:3000/\\@evil.com"]) {
    const result = checkPreviewUrl(input, 4173);
    if (result.ok) {
      const url = new URL(result.url);
      assert.ok(PREVIEW_HOSTS.has(url.hostname), `${input} -> ${result.url}`);
      assert.equal(url.username, "");
    }
  }
});

test("Wheelhouse's own port is rejected on every loopback spelling", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.deepEqual(checkPreviewUrl(`http://${host}:4173`, 4173), { ok: false, reason: "own-port" });
    assert.equal(checkPreviewUrl(`http://${host}:4174`, 4173).ok, true);
  }
  assert.equal(checkPreviewUrl("4173", 4173).reason, "own-port");
  assert.equal(checkPreviewUrl("http://localhost", 80).reason, "own-port");
  assert.equal(checkPreviewUrl("http://localhost:04173", 4173).reason, "own-port"); // leading zero is the same port
});

test("sandbox: allow-same-origin only for localhost / 127.0.0.1, never for files", () => {
  assert.equal(sandboxForUrl(checkPreviewUrl("http://localhost:3000", 4173)), SANDBOX_APP);
  assert.equal(sandboxForUrl(checkPreviewUrl("http://127.0.0.1:3000", 4173)), SANDBOX_APP);
  assert.equal(sandboxForUrl(checkPreviewUrl("http://[::1]:3000", 4173)), SANDBOX_FILE);
  assert.equal(sandboxForUrl({ ok: false }), SANDBOX_FILE);
  assert.match(SANDBOX_APP, /allow-same-origin/);
  assert.doesNotMatch(SANDBOX_FILE, /allow-same-origin/);
  assert.doesNotMatch(SANDBOX_FILE, /allow-top-navigation/);
  assert.doesNotMatch(SANDBOX_APP, /allow-top-navigation|allow-popups-to-escape-sandbox/);
});

test("frameHref: [::1] is framed as localhost (CSP cannot name IPv6), the rest unchanged and re-validatable", () => {
  assert.equal(frameHref(checkPreviewUrl("http://[::1]:3000/x?y=1", 4173)), "http://localhost:3000/x?y=1");
  assert.equal(frameHref(checkPreviewUrl("http://127.0.0.1:3000", 4173)), "http://127.0.0.1:3000/");
  assert.equal(frameHref({ ok: false }), "");
  assert.equal(checkPreviewUrl(frameHref(checkPreviewUrl("http://[::1]:4173", 9)), 4173).reason, "own-port");
});

test("isPreviewFile recognises project html/pdf paths but not URLs", () => {
  assert.equal(isPreviewFile("docs/index.html"), true);
  assert.equal(isPreviewFile("a.PDF"), true);
  assert.equal(isPreviewFile("report.htm?x=1"), true);
  assert.equal(isPreviewFile("http://localhost:3000/index.html"), false);
  assert.equal(isPreviewFile("notes.txt"), false);
});

// ---- launch.json ---------------------------------------------------------------------------------
test("launch.json: comments, trailing commas and the documented shape", () => {
  const text = `{
    // dev servers
    "version": "0.0.1",
    "configurations": [
      { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000, /* default */ },
      { "name": "api", "program": "server.js", "args": ["--x"], "port": 8080, "env": { "NODE_ENV": "development" }, "cwd": "api" },
      { "name": "url only", "url": "https://app.localhost:3000" },
      { "name": "bad port", "runtimeExecutable": "npm", "port": 70000 },
      { "runtimeExecutable": "npm" },
      { "name": "web", "runtimeExecutable": "npm" },
    ],
  }`;
  const { configs, error } = parseLaunchJson(text, { ownPort: 4173 });
  assert.equal(error, undefined);
  assert.equal(configs[0].executable, "npm");
  assert.deepEqual(configs[0].args, ["run", "dev"]);
  assert.equal(configs[0].port, 3000);
  assert.equal(configs[1].executable, "node");
  assert.deepEqual(configs[1].args, ["server.js", "--x"]);
  assert.equal(configs[1].cwd, "api");
  assert.deepEqual(configs[1].env, { NODE_ENV: "development" });
  assert.match(configs[2].error, /url-only/);
  assert.match(configs[3].error, /port/);
  assert.match(configs[4].error, /name/);
  assert.match(configs[5].error, /duplicate/);
});

test("launch.json: port defaults to 3000, own port and junk are refused", () => {
  assert.equal(validateConfiguration({ name: "a", runtimeExecutable: "npm" }).port, 3000);
  assert.match(validateConfiguration({ name: "a", runtimeExecutable: "npm", port: 4173 }, { ownPort: 4173 }).error, /own port/);
  for (const raw of [
    null, [], "x", { name: "a" },
    { name: "a", runtimeExecutable: "" },
    { name: "a", runtimeExecutable: "npm\nrm" },
    { name: "a", runtimeExecutable: "npm", runtimeArgs: "run dev" },
    { name: "a", runtimeExecutable: "npm", runtimeArgs: ["ok", 5] },
    { name: "a", runtimeExecutable: "npm", runtimeArgs: ["a\u0000b"] },
    { name: "a", runtimeExecutable: "npm", port: "3000" },
    { name: "a", runtimeExecutable: "npm", port: 3000.5 },
    { name: "a", runtimeExecutable: "npm", env: { "BAD NAME": "x" } },
    { name: "a", runtimeExecutable: "npm", env: { A: 1 } },
    { name: "a", runtimeExecutable: "npm", cwd: 7 },
    { name: "x".repeat(101), runtimeExecutable: "npm" },
  ]) assert.ok(validateConfiguration(raw).error, JSON.stringify(raw));
});

test("launch.json: invalid documents never throw", () => {
  assert.match(parseLaunchJson("{ nope").error, /not valid JSON/);
  assert.match(parseLaunchJson("[]").error, /object/);
  assert.match(parseLaunchJson("{}").error, /configurations/);
  assert.deepEqual(parseLaunchJson('{"configurations": []}').configs, []);
  assert.equal(stripJsonComments('{"a": "http://x//y /* not */"} // end'), '{"a": "http://x//y /* not */"} ');
});

test("buildCommand quotes every argument for PowerShell and sh", () => {
  const config = { executable: "npm", args: ["run", "dev", "--", "it's; rm -rf /", "$(x)", "`y`"], env: { A: "it's" } };
  assert.equal(buildCommand(config, { windows: true }), "$env:A='it''s'; & 'npm' 'run' 'dev' '--' 'it''s; rm -rf /' '$(x)' '`y`'");
  assert.equal(buildCommand(config, { windows: false }), "A='it'\\''s' 'npm' 'run' 'dev' '--' 'it'\\''s; rm -rf /' '$(x)' '`y`'");
  assert.equal(buildCommand({ executable: "x", args: ["\u2019; calc"], env: {} }, { windows: true }), "& 'x' '\u2019\u2019; calc'");
});

test("within() is a proper path-prefix check", () => {
  const sep = process.platform === "win32" ? "\\" : "/";
  const p = (...parts) => (process.platform === "win32" ? "C:\\" : "/") + parts.join(sep);
  assert.equal(within(p("a", "b"), p("a", "b", "c")), true);
  assert.equal(within(p("a", "b"), p("a", "b")), true);
  assert.equal(within(p("a", "b"), p("a", "bc")), false);
  assert.equal(within(p("a", "b"), p("a")), false);
});

test("probePort sees a listening loopback port and a closed one", async () => {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.equal(await probePort(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probePort(port, { timeout: 200 }), false);
});

// ---- the real server -----------------------------------------------------------------------------
let child;
let base;
let home;
let project;
let outside;
const symlinks = { file: false, dir: false, inner: false };
let ownPort;

const freePort = () => new Promise((resolve) => {
  const server = createNetServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const api = (path, init = {}) => fetch(base + path, { ...init, headers: { origin: base, "content-type": "application/json", ...(init.headers || {}) } });
const q = (params) => `?${new URLSearchParams(params)}`;

before(async () => {
  ownPort = await freePort();
  base = `http://127.0.0.1:${ownPort}`;
  home = mkdtempSync(join(tmpdir(), "wheelhouse-pv-"));
  project = join(home, "project");
  outside = join(home, "outside");
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, "index.html"), "<h1>hi</h1><script>window.x=1</script>");
  writeFileSync(join(project, "sub", "page.htm"), "<p>sub</p>");
  writeFileSync(join(project, "doc.pdf"), "%PDF-1.4\n%fake\n");
  writeFileSync(join(project, "fake.pdf"), "<script>alert(1)</script>");
  writeFileSync(join(project, "notes.txt"), "text");
  writeFileSync(join(project, "app.svg"), "<svg onload='alert(1)'/>");
  writeFileSync(join(outside, "secret.html"), "<h1>secret</h1>");
  writeFileSync(join(outside, "secret.pdf"), "%PDF-1.4 secret");
  writeFileSync(join(home, "sibling.html"), "<h1>sibling</h1>");
  const tryLink = (target, path, type) => { try { symlinkSync(target, path, type); return true; } catch { return false; } }; // Windows needs rights for file symlinks
  symlinks.file = tryLink(join(outside, "secret.html"), join(project, "link.html"), "file");
  symlinks.dir = tryLink(outside, join(project, "linkdir"), "junction");
  symlinks.inner = tryLink(join(project, "index.html"), join(project, "inner-link.html"), "file");
  writeFileSync(join(project, ".claude", "launch.json"), `{
    // comment
    "version": "0.0.1",
    "configurations": [
      { "name": "web", "runtimeExecutable": "node", "runtimeArgs": ["-e", "1"], "port": 39871 },
      { "name": "sub", "runtimeExecutable": "node", "port": 39872, "cwd": "sub" },
      { "name": "escape", "runtimeExecutable": "node", "port": 39873, "cwd": "../outside" },
      { "name": "own", "runtimeExecutable": "node", "port": ${ownPort} },
    ]
  }`);
  const configFile = join(home, "wheelhouse.config.json");
  writeFileSync(configFile, JSON.stringify({ autoTitle: false, profiles: { default: { label: "Test", configDir: join(home, "claude") } } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude") };
  for (const key of ["WHEELHOUSE_CONFIG", "WHEELHOUSE_DATA_DIR", "WHEELHOUSE_PORT", "WHEELHOUSE_CWD", "WHEELHOUSE_WORKSPACE_ROOT", "CLAUDE_BIN"]) delete env[key];
  child = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(ownPort), "--config", configFile, "--data-dir", join(home, "data"), "--cwd", project], { env, stdio: "ignore" });
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

after(() => {
  child?.kill();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* temp folder */ }
});

test("page CSP allows framing only localhost / 127.0.0.1 (and itself)", async () => {
  const csp = (await fetch(`${base}/`)).headers.get("content-security-policy");
  assert.match(csp, /frame-src 'self' http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*;/);
  assert.doesNotMatch(csp, /\[::1\]/); // Chrome rejects IPv6 literals in CSP host sources
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /frame-src[^;]*(https:|\s\*[\s;]|\s\*$)/);
});

test("GET /api/preview/configs lists launch.json configurations, flags bad ones, and finds project files", async () => {
  const body = await (await api(`/api/preview/configs${q({ cwd: project })}`)).json();
  assert.equal(body.exists, true);
  assert.equal(body.error, null);
  const byName = Object.fromEntries(body.configs.map((entry) => [entry.name, entry]));
  assert.equal(byName.web.port, 39871);
  assert.match(byName.web.command, /node/);
  assert.match(byName.web.termId, /^pv-[0-9a-f]{20}$/);
  assert.equal(byName.web.listening, false);
  assert.equal(byName.sub.cwdRel, "sub");
  assert.match(byName.escape.error, /outside the project/);
  assert.match(byName.own.error, /own port/);
  assert.ok(body.files.includes("index.html") && body.files.includes("doc.pdf"));
  assert.ok(!body.files.includes("notes.txt") && !body.files.includes("app.svg"));
  assert.equal(body.ownPort, ownPort);
});

test("configs: no launch.json, bad cwd", async () => {
  const empty = await (await api(`/api/preview/configs${q({ cwd: outside })}`)).json();
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.configs, []);
  assert.equal((await api(`/api/preview/configs${q({ cwd: join(home, "nope") })}`)).status, 400);
  assert.equal((await api("/api/preview/configs")).status, 400);
});

test("configs: suggests listening common ports not named in launch.json, never probes others", async () => {
  const dev = createHttpServer((req, res) => res.end("ok"));
  let port = 0;
  for (const candidate of [3000, 3001, 5000, 8000, 8888, 4200]) {
    try { await new Promise((resolve, reject) => { dev.once("error", reject); dev.listen(candidate, "127.0.0.1", resolve); }); port = candidate; break; } catch { /* in use: next */ }
  }
  if (!port) return; // every common port is busy on this machine
  try {
    const body = await (await api(`/api/preview/configs${q({ cwd: outside })}`)).json();
    assert.ok(body.suggested.includes(port), `suggested ${body.suggested} should include ${port}`);
    for (const value of body.suggested) assert.ok([3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888].includes(value));
    const probe = await (await api("/api/preview/probe", { method: "POST", body: JSON.stringify({ port }) })).json();
    assert.deepEqual(probe, { port, listening: true });
  } finally {
    await new Promise((resolve) => dev.close(resolve));
  }
});

test("POST /api/preview/probe: only common ports, launch.json ports, never own port or junk", async () => {
  const post = (body) => api("/api/preview/probe", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await post({ port: 22 })).status, 403);
  assert.equal((await post({ port: 39871 })).status, 403); // launch.json port, but no cwd given
  assert.equal((await post({ port: 39871, cwd: outside })).status, 403); // a project that does not declare it
  const declared = await post({ port: 39871, cwd: project });
  assert.equal(declared.status, 200);
  assert.equal((await declared.json()).listening, false);
  assert.equal((await post({ port: 39873, cwd: project })).status, 403); // its configuration is invalid
  assert.equal((await post({ port: ownPort, cwd: project })).status, 400);
  for (const port of [0, -1, 65536, 3000.5, "3000", null, undefined]) assert.equal((await post({ port })).status, 400, String(port));
});

test("file route: serves html sandboxed, pdf with a locked policy, with safe headers", async () => {
  const html = await api(`/api/preview/file${q({ cwd: project, path: "index.html" })}`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(html.headers.get("content-security-policy"), "sandbox");
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  assert.equal(html.headers.get("referrer-policy"), "no-referrer");
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.match(await html.text(), /<h1>hi<\/h1>/);

  const scripted = await api(`/api/preview/file${q({ cwd: project, path: "index.html", scripts: "1" })}`);
  const policy = scripted.headers.get("content-security-policy");
  assert.match(policy, /^sandbox allow-scripts/);
  assert.doesNotMatch(policy, /allow-same-origin|allow-top-navigation/);
  await scripted.arrayBuffer();

  const nested = await api(`/api/preview/file${q({ cwd: project, path: "sub/page.htm" })}`);
  assert.equal(nested.status, 200);
  await nested.arrayBuffer();

  const pdf = await api(`/api/preview/file${q({ cwd: project, path: "doc.pdf" })}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(pdf.headers.get("x-content-type-options"), "nosniff");
  assert.match(pdf.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await pdf.text(), /^%PDF-/);
});

test("file route: other types, fake PDFs and missing files are refused", async () => {
  const get = (path) => api(`/api/preview/file${q({ cwd: project, path })}`);
  assert.equal((await get("notes.txt")).status, 415);
  assert.equal((await get("app.svg")).status, 415);
  assert.equal((await get(".claude/launch.json")).status, 415);
  assert.equal((await get("fake.pdf")).status, 415); // not a PDF: never served as application/pdf
  assert.equal((await get("missing.html")).status, 404);
  assert.equal((await get("sub")).status, 415);
  assert.equal((await get("")).status, 400);
  assert.equal((await api(`/api/preview/file${q({ path: "index.html" })}`)).status, 400);
  assert.equal((await api(`/api/preview/file${q({ cwd: join(home, "nope"), path: "index.html" })}`)).status, 400);
});

test("file route: confined to the project folder (traversal, absolute paths, symlinks)", async () => {
  const get = (path, cwd = project) => api(`/api/preview/file${q({ cwd, path })}`);
  for (const path of ["../sibling.html", "../outside/secret.html", "sub/../../sibling.html", "..\\sibling.html", join(home, "sibling.html"), join(outside, "secret.pdf"), "sub/%2e%2e/x.html", "..", "../"]) {
    const response = await get(path);
    assert.ok([400, 403, 404, 415].includes(response.status), `${path} -> ${response.status}`);
    assert.doesNotMatch(await response.text(), /secret|sibling/, path);
  }
  assert.equal((await get("../sibling.html")).status, 403);
  if (symlinks.file) {
    const link = await get("link.html");
    assert.equal(link.status, 403, "a symlink to a file outside the project must not be followed");
    assert.doesNotMatch(await link.text(), /secret/);
  }
  if (symlinks.dir) {
    const viaDir = await get("linkdir/secret.html");
    assert.equal(viaDir.status, 403, "a symlinked/junctioned folder pointing outside must not be followed");
    assert.doesNotMatch(await viaDir.text(), /secret/);
  }
  if (symlinks.inner) {
    const inner = await get("inner-link.html"); // a symlink that stays inside the project is fine
    assert.equal(inner.status, 200);
    await inner.arrayBuffer();
  }
  assert.ok(symlinks.file || symlinks.dir, "could not create any symlink: the escape test did not run");
});

test("preview endpoints keep the app's origin checks", async () => {
  const cross = await fetch(`${base}/api/preview/file${q({ cwd: project, path: "index.html" })}`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(cross.status, 403);
});
