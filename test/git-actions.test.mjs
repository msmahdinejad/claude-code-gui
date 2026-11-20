// fs-git safety (ref names, non-ASCII paths, capped reads) and the Changes panel's git routes
// (push / pull / stash / worktrees / PR lookup) against throwaway repositories. Never touches the user's folders.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRefName, readTextFile, searchFiles } from "../server/lib/fs-git.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let child;
let base;
let home;
let repo;
let bare;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const initRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
};

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

const api = (path, init = {}) => fetch(base + path, { ...init, headers: { origin: base, "content-type": "application/json", ...(init.headers || {}) } });
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const action = (body) => post("/api/ws/git/action", { cwd: repo, ...body });
const q = (params) => new URLSearchParams(params).toString();

before(async () => {
  home = mkdtempSync(join(tmpdir(), "wheelhouse-git-"));
  repo = join(home, "repo");
  bare = join(home, "remote.git");
  initRepo(repo);
  writeFileSync(join(repo, "سلام.txt"), "hello\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  git(home, "init", "-q", "--bare", "-b", "main", bare);
  git(repo, "remote", "add", "origin", bare);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const configFile = join(home, "wheelhouse.config.json");
  writeFileSync(configFile, JSON.stringify({ autoTitle: false, profiles: { default: { label: "Test", configDir: join(home, "claude") } } }));
  child = spawn(process.execPath, [join(root, "server", "index.mjs"), "--port", String(port), "--config", configFile, "--data-dir", join(home, "data"), "--cwd", home], { env: serverEnv(), stdio: "ignore" });
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

// ---- fs-git unit -------------------------------------------------------------------------
test("checkRefName rejects options, pathspecs and invalid ref names", () => {
  for (const bad of [".", "..", "-b", "--output=/tmp/x", "a..b", "a b", "x.lock", "a/.b", "a//b", "a/", "@", "a@{1}", "a:b", "a~1", "a^", "", "a."]) {
    assert.throws(() => checkRefName(bad), /invalid branch name/, bad);
  }
  for (const good of ["main", "feature/x-1", "origin/main", "v1.2", "fix_ü"]) assert.equal(checkRefName(good), good);
});

test("searchFiles returns non-ASCII (Persian) names unquoted", async () => {
  const files = (await searchFiles(repo, "سلام")).map((file) => file.path);
  assert.deepEqual(files, ["سلام.txt"]);
  const all = (await searchFiles(repo, "")).map((file) => file.path);
  assert.ok(all.every((path) => !path.includes("\\") && !path.startsWith('"')), JSON.stringify(all));
});

test("readTextFile reads only up to the (capped) max", async () => {
  const big = join(home, "big.txt");
  writeFileSync(big, "x".repeat(3 * 1024 * 1024));
  const head = await readTextFile(big, { max: 100 });
  assert.equal(head.content.length, 100);
  assert.equal(head.truncated, true);
  const capped = await readTextFile(big, { max: 1e12 });
  assert.ok(capped.content.length <= 8 * 1024 * 1024);
  const small = await readTextFile(join(repo, "a.txt"));
  assert.equal(small.content, "one\n");
  assert.equal(small.truncated, false);
});

// ---- routes ------------------------------------------------------------------------------
test("legacy diff route is gone and GET /api/fs/search returns Persian names", async () => {
  const diff = await api(`/api/git/diff?${q({ cwd: repo, base: `--output=${join(home, "pwned.txt")}` })}`);
  assert.equal(diff.status, 404);
  assert.equal(existsSync(join(home, "pwned.txt")), false);
  const body = await (await api(`/api/fs/search?${q({ cwd: repo, q: "سلام" })}`)).json();
  assert.deepEqual(body.files.map((file) => file.path), ["سلام.txt"]);
});

test("checkout refuses '.' and option-like names (no discarded changes)", async () => {
  writeFileSync(join(repo, "a.txt"), "edited\n");
  for (const branch of [".", "-f", "--", "a..b"]) {
    const response = await action({ action: "checkout", branch });
    assert.equal(response.status, 400, branch);
  }
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "edited\n");
  git(repo, "checkout", "--", "a.txt");
});

test("push publishes the branch first, then pushes to its upstream", async () => {
  let plan = await (await api(`/api/ws/git/push-plan?${q({ cwd: repo })}`)).json();
  assert.equal(plan.branch, "main");
  assert.equal(plan.upstream, "");
  assert.equal(plan.remote, "origin");
  assert.equal(plan.ahead, 1);
  let response = await action({ action: "push" });
  assert.equal(response.status, 200, await response.clone().text());
  plan = await (await api(`/api/ws/git/push-plan?${q({ cwd: repo })}`)).json();
  assert.equal(plan.upstream, "origin/main");
  assert.equal(plan.ahead, 0);
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-q", "-m", "second");
  response = await action({ action: "push" });
  assert.equal(response.status, 200);
  assert.equal(git(bare, "rev-parse", "main").trim(), git(repo, "rev-parse", "HEAD").trim());
  const unknown = await action({ action: "push", remote: "--receive-pack=evil" });
  assert.equal(unknown.status, 200, "an upstream exists, so the requested remote is ignored");
});

test("pull fast-forwards by default", async () => {
  const other = join(home, "other");
  git(home, "clone", "-q", bare, other);
  git(other, "config", "user.email", "test@example.invalid");
  git(other, "config", "user.name", "Test");
  writeFileSync(join(other, "c.txt"), "three\n");
  git(other, "add", "c.txt");
  git(other, "commit", "-q", "-m", "third");
  git(other, "push", "-q", "origin", "main");
  const response = await action({ action: "pull" });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.mode, "ff-only");
  assert.equal(readFileSync(join(repo, "c.txt"), "utf8"), "three\n");
});

test("stash push / list / pop", async () => {
  writeFileSync(join(repo, "a.txt"), "stashed\n");
  let response = await action({ action: "stashPush", message: "--my work", includeUntracked: true });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\n");
  const { stashes } = await (await api(`/api/ws/git/stashes?${q({ cwd: repo })}`)).json();
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].index, 0);
  assert.match(stashes[0].subject, /--my work/);
  assert.equal((await action({ action: "stashPop", index: "0; rm" })).status, 400);
  response = await action({ action: "stashPop", index: 0 });
  assert.equal(response.status, 200);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "stashed\n");
  git(repo, "checkout", "--", "a.txt");
});

test("worktrees: list (incl. .claude/worktrees) and remove with force only when asked", async () => {
  git(repo, "worktree", "add", "-q", "-b", "wt1", join(repo, ".claude", "worktrees", "wt1"));
  writeFileSync(join(repo, ".claude", "worktrees", "wt1", "dirty.txt"), "x\n");
  const list = await (await api(`/api/ws/git/worktrees?${q({ cwd: repo })}`)).json();
  assert.equal(list.worktrees.length, 2);
  const [main, wt] = list.worktrees;
  assert.equal(main.main, true);
  assert.equal(main.current, true);
  assert.equal(wt.claude, true);
  assert.equal(wt.branch, "wt1");
  assert.equal(wt.dirty, true);
  assert.ok(wt.size > 0);
  assert.equal((await post("/api/ws/git/worktree/remove", { cwd: repo, path: main.path })).status, 400);
  assert.equal((await post("/api/ws/git/worktree/remove", { cwd: repo, path: join(home, "elsewhere") })).status, 400);
  assert.equal((await post("/api/ws/git/worktree/remove", { cwd: repo, path: wt.path })).status, 400, "dirty needs force");
  const forced = await post("/api/ws/git/worktree/remove", { cwd: repo, path: wt.path, force: true });
  assert.equal(forced.status, 200, await forced.clone().text());
  assert.equal(existsSync(wt.path), false);
  assert.match(git(repo, "branch", "--list", "wt1"), /wt1/, "the branch is kept");
});

test("files can be written into new sub-folders, never outside the project", async () => {
  const ok = await post("/api/ws/fs/write", { cwd: repo, path: "new/deep/file.txt", content: "hi", backup: false });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(readFileSync(join(repo, "new", "deep", "file.txt"), "utf8"), "hi");
  const outside = await post("/api/ws/fs/write", { cwd: repo, path: "../escape/x.txt", content: "no" });
  assert.equal(outside.status, 403);
});

test("PR lookup never fails hard (gh missing, or the remote is not on GitHub)", async () => {
  const response = await api(`/api/ws/gh/pr?${q({ cwd: repo })}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.available, "boolean");
  if (body.available) {
    assert.equal(body.pr, null);
    assert.equal(body.auth, undefined, "a non-GitHub remote is not reported as a sign-in problem");
  }
});

test("diagnostics: facts without secrets, and only allow-listed checks", async () => {
  const info = await (await api("/api/diagnostics/info")).json();
  assert.equal(info.node, process.version);
  assert.deepEqual(info.checks.sort(), ["auth", "doctor", "mcp", "version"]);
  assert.equal(info.configDir, join(home, "claude"));
  assert.equal("env" in info.profile, false);
  assert.equal((await post("/api/diagnostics/run", { check: "logout" })).status, 400);
  assert.equal((await post("/api/diagnostics/run", { check: "__proto__" })).status, 400);
});
