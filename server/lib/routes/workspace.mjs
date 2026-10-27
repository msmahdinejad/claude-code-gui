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

export default function register({ route, HttpError, fsgit }) {
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
    } catch (error) {
      if (mustExist) throw new HttpError(404, "not found");
      real = join(await realpath(dirname(full)), basename(full));
    }
    if (!within(root, real)) throw new HttpError(403, "path escapes the project folder");
    return { root, full: real };
  }

  function run(cmd, args, { cwd, input, timeout = 60_000, okCodes = [0] } = {}) {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" } }, (error, stdout, stderr) => {
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

  const branchName = (name) => {
    const value = String(name ?? "").trim();
    if (!value || value.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{|\/\/|\.lock$|\/$/.test(value)) throw bad("invalid branch name");
    return value;
  };

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
        const { stdout, stderr } = await git(root, ["checkout", name]);
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
        await git(root, args);
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
      default:
        throw bad(`unknown action: ${body.action}`);
    }
  });

  // ---- git: log / show / branches ------------------------------------------------
  route("GET", "/api/ws/git/log", async ({ query }) => {
    const root = await needRepo(query.get("cwd"));
    const limit = Math.min(Math.max(Number(query.get("limit")) || 60, 1), 400);
    const skip = Math.max(Number(query.get("skip")) || 0, 0);
    let stdout = "";
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
    const info = await fsgit.readTextFile(real, { max: Number(query.get("max")) || 1_000_000 });
    return { ...info, path: real, inside, rel: inside ? relative(root, real).split(sep).join("/") : null };
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
    const after = Number(query.get("after") || req.headers["last-event-id"] || 0);
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
