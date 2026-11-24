// Workspace panels backend: git (status/diff/actions/log/branches), sandboxed file tree/read/write,
// and a non-PTY terminal (spawn + SSE). All paths are validated against the session cwd / repo root.
import { execFile, spawn } from "node:child_process";
import { realpath, readdir, stat, readFile, writeFile, rm, mkdir } from "node:fs/promises";

import { StringDecoder } from "node:string_decoder";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";

const MAX_DIFF_BYTES = 1_500_000;
const MAX_LIST = 2000;
const TERM_BUFFER_BYTES = 2 * 1024 * 1024;
const IS_WIN = process.platform === "win32";

export default function register({ route, HttpError, fsgit, config }) {
  // ---- helpers -------------------------------------------------------------------
  const bad = (message) => new HttpError(400, message);

  async function realDir(cwd) {
    if (!cwd || typeof cwd !== "string") throw bad("cwd is required");
    const full = resolve(cwd);
    let info;
    try { info = await stat(full); } catch { throw bad(`not a directory: ${cwd}`); }
    if (!info.isDirectory()) throw bad(`not a directory: ${cwd}`);
    return realpath(full);
  }

  const within = (root, target) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  };

  /** Resolve `path` (absolute or relative to cwd) and ensure it is inside cwd (symlinks resolved). */
  async function insideCwd(cwd, path, { mustExist = true } = {}) {
    const root = await realDir(cwd);
    const full = resolve(root, String(path ?? ""));
    if (!within(root, full)) throw new HttpError(403, "path is outside the project folder");
    let real;
    try {
      real = await realpath(full);
    } catch {
      if (mustExist) throw new HttpError(404, "not found");
      // New file, possibly in new folders: resolve the nearest existing ancestor, re-append the rest.
      let base = dirname(full);
      const rest = [basename(full)];
      for (;;) {
        try { real = join(await realpath(base), ...rest); break; } catch { /* missing: go up */ }
        const parent = dirname(base);
        if (parent === base) throw new HttpError(404, "not found");
        rest.unshift(basename(base));
        base = parent;
      }
    }
    if (!within(root, real)) throw new HttpError(403, "path escapes the project folder");
    return { root, full: real };
  }

  function run(cmd, args, { cwd, input, timeout = 60_000, okCodes = [0], env = {} } = {}) {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8", ...env } }, (error, stdout, stderr) => {
        if (error && !okCodes.includes(error.code)) {
          const err = new HttpError(400, (stderr || error.message || "").trim().split("\n").slice(0, 6).join("\n") || "command failed");
          err.stderr = stderr;
          err.code = error.code;
          return reject(err);
        }
        resolvePromise({ stdout, stderr });
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  const git = (root, args, opts) => run("git", ["-c", "core.quotepath=false", "-c", "color.ui=never", ...args], { cwd: root, ...opts });

  async function repoRoot(cwd) {
    const dir = await realDir(cwd);
    try {
      const { stdout } = await git(dir, ["rev-parse", "--show-toplevel"]);
      return await realpath(stdout.trim());
    } catch {
      return null;
    }
  }

  async function needRepo(cwd) {
    const root = await repoRoot(cwd);
    if (!root) throw bad("not a git repository");
    return root;
  }

  /** Validate repo-relative paths from the client (no absolute, no traversal, no option injection). */
  async function cleanPaths(root, paths) {
    if (!Array.isArray(paths) || !paths.length) throw bad("paths required");
    const out = [];
    for (const raw of paths) {
      const path = String(raw).replace(/\\/g, "/");
      if (!path || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw bad(`invalid path: ${raw}`);
      const full = resolve(root, path);
      if (!within(root, full)) throw new HttpError(403, `path is outside the repository: ${raw}`);
      out.push(relative(root, full).split(sep).join("/") || ".");
    }
    return out;
  }

  // Same rules as fs-git (git check-ref-format, plus no "-x" options and no "." / ".." pathspecs).
  const branchName = (name) => {
    try { return fsgit.checkRefName(name); } catch { throw bad("invalid branch name"); }
  };

  const stashRef = (index) => {
    const n = Number(index ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 9999) throw bad("invalid stash index");
    return `stash@{${n}}`;
  };

  const gitOut = async (root, args) => (await git(root, args).catch(() => ({ stdout: "" }))).stdout.trim();

  /** What a push would do now: the branch, the remote, the upstream (or none: first push publishes it), counts. */
  async function pushPlan(root, requestedRemote) {
    const branch = await gitOut(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const remotes = (await gitOut(root, ["remote"])).split(/\r?\n/).filter(Boolean);
    let remote = "";
    let merge = "";
    let upstream = "";
    if (branch) {
      remote = await gitOut(root, ["config", "--get", `branch.${branch}.remote`]);
      merge = await gitOut(root, ["config", "--get", `branch.${branch}.merge`]);
      upstream = remote && merge && remotes.includes(remote) ? await gitOut(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) : "";
      if (!upstream) { remote = ""; merge = ""; }
    }
    if (!remote) {
      const wanted = requestedRemote ? String(requestedRemote) : "";
      if (wanted && !remotes.includes(wanted)) throw bad(`unknown remote: ${wanted}`);
      remote = wanted || (remotes.includes("origin") ? "origin" : remotes[0] || "");
    }
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const [b, a] = (await gitOut(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).split(/\s+/).map(Number);
      ahead = a || 0;
      behind = b || 0;
    } else if (branch) {
      ahead = Number(await gitOut(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) || 0;
    }
    if (remote.startsWith("-")) throw bad(`invalid remote: ${remote}`);
    return { branch, remote, remotes, upstream, merge, ahead, behind };
  }

  // ---- git: worktrees (incl. Claude Code's <repo>/.claude/worktrees/) ------------------
  const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

  async function listWorktrees(root) {
    const { stdout } = await git(root, ["worktree", "list", "--porcelain", "-z"]);
    const items = [];
    let current = null;
    for (const field of stdout.split("\0")) {
      if (!field) { current = null; continue; }
      const space = field.indexOf(" ");
      const key = space < 0 ? field : field.slice(0, space);
      const value = space < 0 ? "" : field.slice(space + 1);
      if (key === "worktree") { current = { path: resolve(value), head: "", branch: "", detached: false, bare: false, locked: false, prunable: false }; items.push(current); continue; }
      if (!current) continue;
      if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") current.detached = true;
      else if (key === "bare") current.bare = true;
      else if (key === "locked") { current.locked = true; current.lockReason = value; }
      else if (key === "prunable") { current.prunable = true; current.prunableReason = value; }
    }
    return items;
  }

  /** Total size of a folder (files only, symlinks not followed), with an entry/time budget. */
  async function folderSize(dir, { maxEntries = 150_000, maxMs = 4000 } = {}) {
    const started = Date.now();
    let bytes = 0;
    let entries = 0;
    let partial = false;
    const stack = [dir];
    while (stack.length) {
      if (entries > maxEntries || Date.now() - started > maxMs) { partial = true; break; }
      const current = stack.pop();
      let list;
      try { list = await readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of list) {
        entries += 1;
        const full = join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) { try { bytes += (await stat(full)).size; } catch { /* vanished */ } }
      }
    }
    return { bytes, partial };
  }

  route("GET", "/api/ws/git/worktrees", async ({ query }) => {
    const here = await needRepo(query.get("cwd"));
    const items = await listWorktrees(here);
    const main = items[0]?.path || here;
    const claudeDir = join(main, ".claude", "worktrees");
    const detailed = await Promise.all(items.map(async (item, index) => {
      const out = { ...item, main: index === 0, current: samePath(item.path, here), claude: within(claudeDir, item.path) && !samePath(item.path, claudeDir) };
      const exists = await stat(item.path).then((info) => info.isDirectory(), () => false);
      out.missing = !exists;
      if (!exists || item.bare) return out;
      const [status, size] = await Promise.all([
        git(item.path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).then((r) => r.stdout.split("\0").filter((x) => x && /^[ MADRCU?!]{2} /.test(x)).length, () => null),
        index === 0 ? Promise.resolve(null) : folderSize(item.path),
      ]);
      out.changes = status;
      out.dirty = Boolean(status);
      if (size) { out.size = size.bytes; out.sizePartial = size.partial; }
      return out;
    }));
    return { root: main, worktrees: detailed };
  });

  route("POST", "/api/ws/git/worktree/remove", async ({ body }) => {
    const here = await needRepo(body.cwd);
    const items = await listWorktrees(here);
    const target = items.find((item) => samePath(item.path, resolve(String(body.path || ""))));
    if (!target) throw bad("not a worktree of this repository");
    if (target === items[0]) throw bad("the main worktree cannot be removed");
    if (samePath(target.path, here)) throw bad("this session works in that worktree; open another folder first");
    if (target.locked) throw bad(`the worktree is locked${target.lockReason ? `: ${target.lockReason}` : ""}`);
    const args = ["worktree", "remove"];
    if (body.force) args.push("--force");
    const { stdout, stderr } = await git(items[0].path, [...args, target.path], { timeout: 120_000 });
    return { ok: true, output: (stdout + stderr).trim() };
  });

  // ---- GitHub CLI (pull requests) ----------------------------------------------------
  const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0" };
  const gh = (root, args, opts = {}) => run("gh", args, { cwd: root, env: GH_ENV, ...opts });
  let ghPresent = null; // null = unknown, then true/false (re-checked after a minute when missing)
  let ghCheckedAt = 0;
  async function ghAvailable() {
    if (ghPresent === true || (ghPresent === false && Date.now() - ghCheckedAt < 60_000)) return ghPresent;
    ghCheckedAt = Date.now();
    ghPresent = await run("gh", ["--version"], { timeout: 15_000 }).then(() => true, () => false);
    return ghPresent;
  }

  const CHECK_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const CHECK_FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
  /** Fold gh's statusCheckRollup (CheckRun | StatusContext items) into pass / fail / pending. */
  function summarizeChecks(rollup = []) {
    const checks = (Array.isArray(rollup) ? rollup : []).map((item) => {
      const raw = String(item.conclusion || item.state || item.status || "").toUpperCase();
      const state = CHECK_PASS.has(raw) ? "pass" : CHECK_FAIL.has(raw) ? "fail" : "pending";
      return { name: item.name || item.context || item.workflowName || "check", state, url: item.detailsUrl || item.targetUrl || "" };
    });
    const count = (state) => checks.filter((check) => check.state === state).length;
    return { total: checks.length, pass: count("pass"), fail: count("fail"), pending: count("pending"), checks: checks.slice(0, 60) };
  }

  route("GET", "/api/ws/gh/pr", async ({ query }) => {
    const root = await needRepo(query.get("cwd"));
    if (!(await ghAvailable())) return { available: false };
    const branch = await gitOut(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!branch) return { available: true, branch: "", pr: null };
    try {
      const { stdout } = await gh(root, ["pr", "view", "--json", "number,title,state,url,statusCheckRollup,mergeable,isDraft,headRefName,baseRefName,reviewDecision"], { timeout: 45_000 });
      const pr = JSON.parse(stdout);
      const { statusCheckRollup, ...rest } = pr;
      return { available: true, branch, pr: { ...rest, checks: summarizeChecks(statusCheckRollup) } };
    } catch (error) {
      const text = String(error.stderr || error.message || "");
      if (/no (open )?pull requests? found/i.test(text)) return { available: true, branch, pr: null };
      // (this message also mentions `gh auth login`, so it is matched before the sign-in case)
      if (/none of the git remotes|not a github|no git remotes/i.test(text)) return { available: true, branch, pr: null, notGithub: true };
      if (/gh auth login|not logged in|authentication/i.test(text)) return { available: true, branch, pr: null, auth: false, error: text.trim().split("\n")[0] };
      return { available: true, branch, pr: null, error: text.trim().split("\n").slice(0, 3).join("\n") || "gh failed" };
    }
  });

  route("POST", "/api/ws/gh/pr/create", async ({ body }) => {
    const root = await needRepo(body.cwd);
    if (!(await ghAvailable())) throw bad("the GitHub CLI (gh) is not installed");
    const plan = await pushPlan(root);
    if (!plan.branch) throw bad("HEAD is detached: check out a branch first");
    if (!plan.upstream) throw bad("push the branch first: it has no upstream yet");
    const title = String(body.title ?? "").trim();
    const text = String(body.body ?? "");
    if (title.length > 300 || text.length > 60_000) throw bad("title or description is too long");
    // Options use the --flag=value form, so a title or body that starts with "-" stays a value.
    const args = ["pr", "create", `--head=${plan.merge.replace(/^refs\/heads\//, "") || plan.branch}`];
    if (!title) args.push("--fill");
    else args.push(`--title=${title}`, `--body=${text}`);
    if (body.draft) args.push("--draft");
    if (body.base) args.push(`--base=${branchName(body.base)}`);
    const { stdout, stderr } = await gh(root, args, { timeout: 120_000 });
    const url = /https?:\/\/\S+/.exec(stdout)?.[0] || "";
    return { ok: true, url, output: (stdout + stderr).trim() };
  });

  route("GET", "/api/ws/git/push-plan", async ({ query }) => pushPlan(await needRepo(query.get("cwd")), query.get("remote") || ""));

  route("GET", "/api/ws/git/stashes", async ({ query }) => {
    const root = await needRepo(query.get("cwd"));
    const out = await gitOut(root, ["stash", "list", "--format=%gd%x1f%s%x1f%cI%x1e"]);
    const stashes = out.split("\x1e").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
      const [ref, subject, date] = chunk.split("\x1f");
      return { index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? -1), ref, subject, date };
    }).filter((item) => item.index >= 0);
    return { stashes };
  });

  // ---- git: status ---------------------------------------------------------------
  route("GET", "/api/ws/git/status", async ({ query }) => {
    const cwd = query.get("cwd");
    const root = await repoRoot(cwd);
    if (!root) return { isRepo: false };
    const [{ stdout: status }, branchInfo] = await Promise.all([
      git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"]).catch(() => ({ stdout: "" })),
    ]);
    let branch = "";
    let upstream = "";
    let ahead = 0;
    let behind = 0;
    let oid = "";
    for (const line of branchInfo.stdout.split("\0")) {
      if (line.startsWith("# branch.head ")) branch = line.slice(14);
      else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
      else if (line.startsWith("# branch.oid ")) oid = line.slice(13);
      else if (line.startsWith("# branch.ab ")) {
        const [a, b] = line.slice(12).split(" ");
        ahead = Math.abs(Number(a));
        behind = Math.abs(Number(b));
      }
    }
    const entries = [];
    const parts = status.split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const code = parts[i].slice(0, 2);
      const path = parts[i].slice(3);
      let orig = null;
      if (code[0] === "R" || code[0] === "C") orig = parts[++i];
      entries.push({ x: code[0], y: code[1], path, orig, untracked: code === "??", conflict: /U|AA|DD/.test(code) });
    }
    const numstat = async (args) => {
      const map = new Map();
      try {
        const { stdout } = await git(root, ["diff", "--numstat", "-z", ...args]);
        const items = stdout.split("\0");
        for (let i = 0; i < items.length; i += 1) {
          const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(items[i]);
          if (!match) continue;
          let path = match[3];
          if (path === "") { path = items[i + 2]; i += 2; } // rename: next two are old/new
          map.set(path, { add: match[1] === "-" ? null : Number(match[1]), del: match[2] === "-" ? null : Number(match[2]) });
        }
      } catch { /* ignore */ }
      return map;
    };
    const [unstagedStats, stagedStats] = await Promise.all([numstat([]), numstat(["--cached"])]);
    const staged = [];
    const unstaged = [];
    const untracked = [];
    const conflicts = [];
    for (const entry of entries) {
      if (entry.path.endsWith(".wheelhouse-backup")) continue;
      if (entry.conflict) { conflicts.push({ ...entry, code: "U" }); continue; }
      if (entry.untracked) { untracked.push({ path: entry.path, code: "?" }); continue; }
      if (entry.x !== " ") staged.push({ path: entry.path, orig: entry.orig, code: entry.x, ...stagedStats.get(entry.path) });
      if (entry.y !== " ") unstaged.push({ path: entry.path, code: entry.y, ...unstagedStats.get(entry.path) });
    }
    return { isRepo: true, root, branch, upstream, ahead, behind, oid, detached: branch === "(detached)", staged, unstaged, untracked, conflicts };
  });

  // ---- git: diff -----------------------------------------------------------------
  route("GET", "/api/ws/git/diff", async ({ query }) => {
    const root = await needRepo(query.get("cwd"));
    const mode = query.get("mode") || "unstaged"; // staged | unstaged | head | untracked | commit
    const [path] = query.get("path") ? await cleanPaths(root, [query.get("path")]) : [null];
    const orig = query.get("orig") ? (await cleanPaths(root, [query.get("orig")]))[0] : null;
    const ctxLines = Math.min(Math.max(Number(query.get("context")) || 3, 0), 50);
    const args = ["diff", "--no-ext-diff", "--no-color", "-M", `-U${ctxLines}`];
    let result;
    if (mode === "untracked") {
      if (!path) throw bad("path required");
      result = await git(root, ["diff", "--no-index", "--no-color", `-U${ctxLines}`, "--", IS_WIN ? "NUL" : "/dev/null", path], { okCodes: [0, 1] });
    } else {
      if (mode === "staged") args.push("--cached");
      if (mode === "head") args.push("HEAD");
      args.push("--");
      if (path) args.push(...(orig ? [orig, path] : [path]));
      result = await git(root, args, { okCodes: [0, 1] }).catch(async (error) => {
        if (mode === "head") return git(root, ["diff", "--no-color", "--cached", "--", ...(path ? [path] : [])]); // no commits yet
        throw error;
      });
    }
    let diff = result.stdout;
    let truncated = false;
    if (diff.length > MAX_DIFF_BYTES) {
      diff = diff.slice(0, MAX_DIFF_BYTES);
      truncated = true;
    }
    return { diff, truncated };
  });

  route("POST", "/api/ws/git/init", async ({ body }) => {
    const dir = await realDir(body.cwd);
    if (await repoRoot(dir)) throw bad("already inside a git repository");
    await git(dir, ["init", "-q"]);
    return { ok: true };
  });

  // ---- git: actions --------------------------------------------------------------
  route("POST", "/api/ws/git/action", async ({ body }) => {
    const root = await needRepo(body.cwd);
    switch (body.action) {
      case "stage":
        await git(root, ["add", "--", ...(await cleanPaths(root, body.paths))]);
        return { ok: true };
      case "stageAll":
        await git(root, ["add", "-A"]);
        return { ok: true };
      case "unstage": {
        const paths = await cleanPaths(root, body.paths);
        await git(root, ["restore", "--staged", "--", ...paths]).catch(() => git(root, ["rm", "--cached", "-r", "-q", "--", ...paths])); // no HEAD yet
        return { ok: true };
      }
      case "unstageAll":
        await git(root, ["reset", "-q"]).catch(() => git(root, ["rm", "--cached", "-r", "-q", "."]));
        return { ok: true };
      case "discard": {
        const paths = await cleanPaths(root, body.paths);
        const kind = body.kind === "untracked" ? "untracked" : "tracked";
        if (kind === "untracked") await git(root, ["clean", "-f", "-d", "--", ...paths]);
        else await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
        return { ok: true };
      }
      case "commit": {
        const message = String(body.message ?? "").trim();
        if (!message && !body.amend) throw bad("commit message required");
        if (body.stageAll) await git(root, ["add", "-A"]);
        const args = ["commit"];
        if (body.amend) args.push("--amend");
        if (message) args.push("-m", message);
        else args.push("--no-edit");
        const { stdout } = await git(root, args);
        return { ok: true, output: stdout.trim() };
      }
      case "checkout": {
        const name = branchName(body.branch);
        const { stdout, stderr } = await git(root, ["checkout", name, "--"]);
        return { ok: true, output: (stdout + stderr).trim() };
      }
      case "checkoutRemote": {
        const name = branchName(body.branch);
        const local = name.replace(/^[^/]+\//, "");
        const { stdout, stderr } = await git(root, ["checkout", "-b", branchName(local), "--track", name]);
        return { ok: true, output: (stdout + stderr).trim() };
      }
      case "createBranch": {
        const name = branchName(body.branch);
        const args = ["checkout", "-b", name];
        if (body.from) args.push(branchName(body.from));
        await git(root, [...args, "--"]);
        return { ok: true };
      }
      case "deleteBranch":
        await git(root, ["branch", body.force ? "-D" : "-d", branchName(body.branch)]);
        return { ok: true };
      case "renameBranch":
        await git(root, ["branch", "-m", branchName(body.branch), branchName(body.to)]);
        return { ok: true };
      case "fetch": {
        const { stdout, stderr } = await git(root, ["fetch", "--prune"], { timeout: 120_000 });
        return { ok: true, output: (stdout + stderr).trim() };
      }
      case "push": {
        const plan = await pushPlan(root, body.remote);
        if (!plan.branch) throw bad("HEAD is detached: check out a branch before pushing");
        if (!plan.remote) throw bad("this repository has no remote to push to");
        // First push of a branch: publish it and set its upstream; later pushes go to the upstream.
        const args = plan.upstream
          ? ["push", "--porcelain", plan.remote, `HEAD:${plan.merge}`]
          : ["push", "--porcelain", "--set-upstream", plan.remote, `HEAD:refs/heads/${plan.branch}`];
        const { stdout, stderr } = await git(root, args, { timeout: 180_000 });
        return { ok: true, output: (stdout + stderr).trim(), ...plan };
      }
      case "pull": {
        const mode = body.mode === "rebase" ? "rebase" : "ff-only";
        const { stdout, stderr } = await git(root, ["pull", mode === "rebase" ? "--rebase" : "--ff-only", "--no-edit"], { timeout: 180_000 });
        return { ok: true, mode, output: (stdout + stderr).trim() };
      }
      case "stashPush": {
        const args = ["stash", "push"];
        if (body.includeUntracked) args.push("--include-untracked");
        const message = String(body.message ?? "").trim();
        if (message) args.push(`--message=${message.slice(0, 500)}`);
        const { stdout, stderr } = await git(root, args);
        return { ok: true, output: (stdout + stderr).trim() };
      }
      case "stashPop":
      case "stashApply":
      case "stashDrop": {
        const ref = stashRef(body.index);
        const verb = body.action === "stashPop" ? "pop" : body.action === "stashApply" ? "apply" : "drop";
        const { stdout, stderr } = await git(root, ["stash", verb, ref]);
        return { ok: true, output: (stdout + stderr).trim() };
      }
      default:
        throw bad(`unknown action: ${body.action}`);
    }
  });

  // ---- git: log / show / branches ------------------------------------------------
  route("GET", "/api/ws/git/log", async ({ query }) => {
    const root = await needRepo(query.get("cwd"));
    const limit = Math.min(Math.max(Number(query.get("limit")) || 60, 1), 400);
    const skip = Math.max(Number(query.get("skip")) || 0, 0);
    let stdout;
    try {
      ({ stdout } = await git(root, ["log", "--all", "--topo-order", `-n${limit}`, `--skip=${skip}`, "--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1e"]));
    } catch {
      return { commits: [] }; // empty repo
    }
    const commits = stdout.split("\x1e").map((chunk) => chunk.replace(/^\n/, "")).filter(Boolean).map((chunk) => {
      const [hash, parents, author, date, refs, subject] = chunk.split("\x1f");
      return { hash, parents: parents ? parents.split(" ") : [], author, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject };
    });
    return { commits, hasMore: commits.length === limit };
  });

  route("GET", "/api/ws/git/show", async ({ query }) => {
    const root = await needRepo(query.get("cwd"));
    const hash = String(query.get("hash") || "");
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw bad("invalid commit hash");
    const { stdout: meta } = await git(root, ["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B", hash]);
    const [full, author, email, date, ...bodyParts] = meta.split("\x1f");
    const { stdout } = await git(root, ["show", "--no-color", "--no-ext-diff", "-M", "--format=", "-U3", hash]);
    let diff = stdout;
    let truncated = false;
    if (diff.length > MAX_DIFF_BYTES) { diff = diff.slice(0, MAX_DIFF_BYTES); truncated = true; }
    return { hash: full.trim(), author, email, date, message: bodyParts.join("\x1f").trim(), diff, truncated };
  });

  route("GET", "/api/ws/git/branches", async ({ query }) => {
    const root = await needRepo(query.get("cwd"));
    const { stdout } = await git(root, ["for-each-ref", "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(objectname:short)%1f%(subject)%1f%(committerdate:iso-strict)", "refs/heads", "refs/remotes"]);
    const branches = stdout.split("\n").filter(Boolean).map((line) => {
      const [ref, name, head, upstream, hash, subject, date] = line.split("\x1f");
      return { ref, name, current: head === "*", upstream, hash, subject, date, remote: ref.startsWith("refs/remotes/") };
    }).filter((branch) => !branch.name.endsWith("/HEAD"));
    return { branches };
  });

  // ---- files ---------------------------------------------------------------------
  route("GET", "/api/ws/fs/list", async ({ query }) => {
    const { root, full } = await insideCwd(query.get("cwd"), query.get("path") || ".");
    const entries = await readdir(full, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name.endsWith(".wheelhouse-backup")) continue;
      items.push({ name: entry.name, dir: entry.isDirectory(), symlink: entry.isSymbolicLink(), rel: relative(root, join(full, entry.name)).split(sep).join("/") });
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
    return { root, path: relative(root, full).split(sep).join("/"), entries: items.slice(0, MAX_LIST), total: items.length, truncated: items.length > MAX_LIST };
  });

  route("GET", "/api/ws/fs/read", async ({ query }) => {
    const cwd = query.get("cwd");
    const root = await realDir(cwd);
    const target = resolve(root, String(query.get("path") || ""));
    let real;
    try { real = await realpath(target); } catch { throw new HttpError(404, "not found"); }
    const inside = within(root, real);
    const max = Math.min(Math.max(Number(query.get("max")) || 1_000_000, 1), 4_000_000);
    const info = await fsgit.readTextFile(real, { max });
    return { ...info, path: real, inside, rel: inside ? relative(root, real).split(sep).join("/") : null };
  });

  // ---- file links: which of the paths Claude mentioned exist, and what the OS may do with them ------------
  const MAX_RESOLVE = 80;
  const MAX_BARE_SEARCHES = 10;

  /** Existence of the paths the chat mentions (relative ones against the session folder, then the repository root). Reads nothing. */
  route("POST", "/api/ws/fs/resolve", async ({ body }) => {
    const root = await realDir(body.cwd);
    const repo = await repoRoot(root);
    const wanted = (Array.isArray(body.paths) ? body.paths : []).filter((item) => typeof item === "string").slice(0, MAX_RESOLVE);
    const results = {};
    let searches = 0;
    const describe = async (candidate) => {
      let info;
      try { info = await stat(candidate); } catch { return null; }
      if (!info.isFile() && !info.isDirectory()) return null;
      const real = await realpath(candidate).catch(() => null);
      if (!real) return null;
      const inside = within(root, real);
      return { exists: true, dir: info.isDirectory(), abs: real, inside, rel: inside ? relative(root, real).split(sep).join("/") : null, size: info.isFile() ? info.size : null };
    };
    for (const raw of wanted) {
      if (!raw || raw.length > 1000 || raw.includes("\0")) { results[raw] = { exists: false }; continue; }
      const absolute = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
      const candidates = absolute ? [resolve(raw)] : [...new Set([resolve(root, raw), ...(repo ? [resolve(repo, raw)] : [])])];
      let found = null;
      for (const candidate of candidates) {
        found = await describe(candidate);
        if (found) break;
      }
      // A lone file name ("tools.js"): when exactly one tracked file has that name, that is the one meant.
      if (!found && !absolute && !/[\\/]/.test(raw) && searches < MAX_BARE_SEARCHES) {
        searches += 1;
        const hits = (await fsgit.searchFiles(root, raw, 30).catch(() => [])).filter((hit) => basename(hit.path).toLowerCase() === raw.toLowerCase());
        if (hits.length === 1) found = await describe(resolve(root, hits[0].path));
      }
      results[raw] = found || { exists: false };
    }
    return { results };
  });

  route("GET", "/api/ws/fs/stat", async ({ query }) => {
    const root = await realDir(query.get("cwd"));
    let real;
    try { real = await realpath(resolve(root, String(query.get("path") || ""))); } catch { return { exists: false }; }
    const info = await stat(real).catch(() => null);
    if (!info) return { exists: false };
    return { exists: true, kind: info.isDirectory() ? "dir" : "file", size: info.size, mtime: info.mtimeMs, inside: within(root, real) };
  });

  // What the operating system may open on its own. Programs and scripts are left out: a path printed in a chat must never
  // become "run this". Source code goes to the editor instead.
  const OPEN_EXT = new Set([
    "md", "markdown", "txt", "log", "pdf", "html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico",
    "json", "jsonl", "csv", "tsv", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "mmd", "diff", "patch",
    "mp3", "wav", "ogg", "mp4", "webm", "mov",
  ]);

  function launch(command, args) {
    return new Promise((done, fail) => {
      let child;
      try { child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false }); } catch (error) { fail(new HttpError(501, `could not start ${command}: ${error.message}`)); return; }
      child.once("error", (error) => fail(new HttpError(501, `could not start ${command}: ${error.code === "ENOENT" ? "not found" : error.message}`)));
      child.once("spawn", () => { child.unref(); done(); });
    });
  }

  /** The editor to open files in: `editor` from the config, else VS Code / Cursor where they usually are, else `code` on the PATH. */
  async function findEditor() {
    const configured = String(config?.editor || process.env.WHEELHOUSE_EDITOR || "").trim();
    if (configured) {
      if (IS_WIN && /\.(cmd|bat)$/i.test(configured)) throw new HttpError(501, "set the editor to its .exe (a .cmd file cannot be started safely)");
      return configured;
    }
    if (!IS_WIN) return "code";
    const local = process.env.LOCALAPPDATA || "";
    const programs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
    const guesses = [
      join(local, "Programs", "Microsoft VS Code", "Code.exe"), ...programs.map((dir) => join(dir, "Microsoft VS Code", "Code.exe")),
      join(local, "Programs", "cursor", "Cursor.exe"), join(local, "Programs", "Windsurf", "Windsurf.exe"),
    ];
    for (const guess of guesses) if (await stat(guess).then((info) => info.isFile(), () => false)) return guess;
    for (const dir of String(process.env.PATH || "").split(";").filter(Boolean)) { // ...\Microsoft VS Code\bin\code.cmd -> ...\Code.exe
      if (await stat(join(dir, "code.cmd")).then((info) => info.isFile(), () => false)) {
        const exe = resolve(dir, "..", "Code.exe");
        if (await stat(exe).then((info) => info.isFile(), () => false)) return exe;
      }
    }
    throw new HttpError(501, "no editor found: set \"editor\" in the Wheelhouse config to the path of your editor (for example Code.exe)");
  }

  route("POST", "/api/ws/fs/open", async ({ body }) => {
    const root = await realDir(body.cwd);
    let real;
    try { real = await realpath(resolve(root, String(body.path ?? ""))); } catch { throw new HttpError(404, "not found"); }
    const info = await stat(real);
    const action = String(body.action || "default");
    const line = Number.isInteger(body.line) && body.line > 0 && body.line < 10_000_000 ? body.line : 0;
    const dry = Boolean(process.env.WHEELHOUSE_NO_OPEN); // tests: validate, but start nothing
    if (action === "reveal") {
      if (!dry) {
        if (IS_WIN) await launch("explorer.exe", [`/select,${real}`]);
        else if (process.platform === "darwin") await launch("open", ["-R", real]);
        else await launch("xdg-open", [info.isDirectory() ? real : dirname(real)]);
      }
      return { ok: true, action };
    }
    if (action === "editor") {
      if (info.isDirectory()) throw bad("an editor opens files, not folders");
      if (dry) return { ok: true, action };
      const editor = await findEditor();
      await launch(editor, ["--goto", `${real}${line ? `:${line}` : ""}`]);
      return { ok: true, action };
    }
    if (action !== "default") throw bad("unknown action");
    if (info.isFile() && !OPEN_EXT.has(real.split(".").pop().toLowerCase())) throw new HttpError(415, "this kind of file is not opened by the system from here; use the editor or show it in the folder");
    if (!dry) {
      if (IS_WIN) await launch("explorer.exe", [real]);
      else await launch(process.platform === "darwin" ? "open" : "xdg-open", [real]);
    }
    return { ok: true, action };
  });

  route("POST", "/api/ws/fs/write", async ({ body }) => {
    const { full } = await insideCwd(body.cwd, body.path, { mustExist: false });
    if (typeof body.content !== "string") throw bad("content required");
    if (body.expectedMtime) {
      try {
        const info = await stat(full);
        if (Math.abs(info.mtimeMs - body.expectedMtime) > 2) throw new HttpError(409, "file changed on disk since it was opened");
      } catch (error) {
        if (error instanceof HttpError) throw error;
      }
    }
    const result = await fsgit.writeTextFile(full, body.content, { backup: body.backup !== false });
    await excludeBackups(body.cwd);
    return result;
  });

  // Keep "*.wheelhouse-backup" out of `git status` for this repo (local-only: .git/info/exclude).
  async function excludeBackups(cwd) {
    try {
      const root = await repoRoot(cwd);
      if (!root) return;
      const { stdout } = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
      const file = resolve(root, stdout.trim());
      const current = await readFile(file, "utf8").catch(() => "");
      if (current.includes("*.wheelhouse-backup")) return;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}*.wheelhouse-backup\n`, "utf8");
    } catch { /* best effort */ }
  }

  route("POST", "/api/ws/fs/delete-backup", async ({ body }) => {
    const { full } = await insideCwd(body.cwd, `${body.path}.wheelhouse-backup`, { mustExist: false });
    await rm(full, { force: true });
    return { ok: true };
  });

  // ---- terminal ------------------------------------------------------------------
  const terms = new Map(); // id -> term

  function getTerm(id) {
    if (!/^[\w-]{6,64}$/.test(String(id))) throw bad("invalid terminal id");
    let term = terms.get(id);
    if (!term) {
      term = { id, cwd: null, child: null, running: false, chunks: [], bytes: 0, seq: 0, clients: new Set(), command: null };
      terms.set(id, term);
    }
    return term;
  }

  function emit(term, event, data) {
    const entry = { seq: ++term.seq, event, data };
    if (event === "out" || event === "start" || event === "exit") {
      term.chunks.push(entry);
      term.bytes += (data.text?.length || 0) + 64;
      while (term.bytes > TERM_BUFFER_BYTES && term.chunks.length > 1) {
        const dropped = term.chunks.shift();
        term.bytes -= (dropped.data.text?.length || 0) + 64;
      }
    }
    for (const res of term.clients) writeSse(res, entry);
  }

  function writeSse(res, entry) {
    res.write(`id: ${entry.seq}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
  }

  const MARK = "<<WHEELHOUSE:";
  function buildScript(cwd, command) {
    if (IS_WIN) {
      const esc = (value) => value.replace(/'/g, "''");
      return [
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; $ProgressPreference='SilentlyContinue'",
        `Set-Location -LiteralPath '${esc(cwd)}'`,
        command,
        "$__ok = $?; $__ec = if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } elseif ($__ok) { 0 } else { 1 }",
        `[Console]::Out.Write("\`n${MARK}" + (Get-Location).Path + "|" + $__ec + ">>")`,
      ].join("\n");
    }
    const q = (value) => `'${value.replace(/'/g, "'\\''")}'`;
    return `cd ${q(cwd)} || exit 1\n${command}\n__ec=$?; printf '\\n${MARK}%s|%s>>' "$PWD" "$__ec"`;
  }

  function killTree(child) {
    if (!child?.pid) return;
    if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } }
  }

  route("POST", "/api/term/run", async ({ body }) => {
    const term = getTerm(body.id);
    if (term.running) throw new HttpError(409, "a command is already running in this tab");
    const command = String(body.command ?? "");
    if (!command.trim()) throw bad("command required");
    if (command.length > 20_000) throw bad("command too long");
    const cwd = await realDir(body.cwd || term.cwd);
    term.cwd = cwd;
    term.command = command;
    term.running = true;
    term.pending = "";
    term.lastExit = null;
    const script = buildScript(cwd, command);
    const child = IS_WIN
      ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn("/bin/sh", ["-c", script], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    term.child = child;
    emit(term, "start", { command, cwd, at: Date.now() });

    const flush = (final) => {
      let text = term.pending;
      let marker = null;
      const at = text.lastIndexOf(`\n${MARK}`);
      if (at >= 0) {
        const end = text.indexOf(">>", at);
        if (end >= 0) {
          const match = /^(.*)\|(-?\d+)$/s.exec(text.slice(at + 1 + MARK.length, end));
          if (match) marker = { cwd: match[1], code: Number(match[2]) };
          text = text.slice(0, at) + text.slice(end + 2);
          term.pending = "";
        } else if (!final) {
          term.pending = text.slice(at);
          text = text.slice(0, at);
        } else term.pending = "";
      } else if (!final) {
        // hold back a possible partial "\n<<WHEELHOUSE:" prefix at the end
        const probe = `\n${MARK}`;
        let keep = 0;
        for (let i = Math.min(probe.length - 1, text.length); i > 0; i -= 1) {
          if (text.endsWith(probe.slice(0, i))) { keep = i; break; }
        }
        term.pending = keep ? text.slice(-keep) : "";
        if (keep) text = text.slice(0, -keep);
      } else term.pending = "";
      if (text) emit(term, "out", { stream: "stdout", text });
      return marker;
    };

    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    let marker = null;
    child.stdout.on("data", (chunk) => {
      term.pending += outDec.write(chunk);
      marker = flush(false) || marker;
    });
    child.stderr.on("data", (chunk) => {
      const text = errDec.write(chunk);
      if (text) emit(term, "out", { stream: "stderr", text });
    });
    child.on("error", (error) => emit(term, "out", { stream: "stderr", text: `${error.message}\n` }));
    child.on("close", (code, signal) => {
      term.pending += outDec.end();
      marker = flush(true) || marker;
      term.running = false;
      term.child = null;
      if (marker?.cwd) term.cwd = marker.cwd;
      const exit = { code: marker ? marker.code : code ?? (signal ? 137 : 1), cwd: term.cwd, signal: signal || null, stopped: Boolean(term.stopped) };
      term.stopped = false;
      term.lastExit = exit;
      emit(term, "exit", exit);
    });
    return { ok: true };
  });

  route("POST", "/api/term/stop", async ({ body }) => {
    const term = getTerm(body.id);
    if (term.child) {
      term.stopped = true;
      killTree(term.child);
    }
    return { ok: true };
  });

  route("POST", "/api/term/stdin", async ({ body }) => {
    const term = getTerm(body.id);
    if (!term.child?.stdin?.writable) throw new HttpError(409, "nothing is running");
    term.child.stdin.write(`${String(body.text ?? "")}\n`);
    emit(term, "out", { stream: "stdin", text: `${String(body.text ?? "")}\n` });
    return { ok: true };
  });

  route("POST", "/api/term/close", async ({ body }) => {
    const term = terms.get(body.id);
    if (term) {
      killTree(term.child);
      for (const res of term.clients) res.end();
      terms.delete(body.id);
    }
    return { ok: true };
  });

  route("GET", "/api/term/([^/]+)/state", async ({ params }) => {
    const term = getTerm(params[0]);
    return { running: term.running, cwd: term.cwd, command: term.command, lastExit: term.lastExit || null, seq: term.seq };
  });

  route("GET", "/api/term/([^/]+)/stream", async ({ req, res, params, query }) => {
    const term = getTerm(params[0]);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    // An EventSource reconnect keeps the original ?after= but sends Last-Event-ID: resume from the later one.
    const after = Math.max(Number(query.get("after")) || 0, Number(req.headers["last-event-id"]) || 0);
    res.write(`event: hello\ndata: ${JSON.stringify({ running: term.running, cwd: term.cwd, seq: term.seq })}\n\n`);
    for (const entry of term.chunks) if (entry.seq > after) writeSse(res, entry);
    term.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      term.clients.delete(res);
    });
  });

  process.on("exit", () => { for (const term of terms.values()) killTree(term.child); });
}
