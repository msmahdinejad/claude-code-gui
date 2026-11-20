import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  autoMemoryState, canonicalGitRoot, cleanRelPath, composeDoc, confinedPath, djb2, expandMemoryDirectory, findGitRoot, globToRegExp,
  indexHasEntry, indexStats, matchesAny, memoryMeta, parseDoc, projectDirNameOverride, removeIndexEntry, replaceBody, resolveAutoMemoryDir,
  rulePaths, sanitizeProjectName, setMemoryMeta, setRulePaths, upsertIndexEntry,
} from "../server/lib/memory-paths.mjs";

/** In-memory fs adapter: { "<path>": "dir" | "<file text>" | { link: true } }. */
function fakeFs(entries, flavour) {
  const norm = (value) => flavour.normalize(value);
  const map = new Map(Object.entries(entries).map(([key, value]) => [norm(key), value]));
  return {
    kind(target) {
      const value = map.get(norm(target));
      if (value === undefined) return null;
      if (value === "dir") return "directory";
      if (value && typeof value === "object") return "link";
      return "file";
    },
    readText(target) {
      const value = map.get(norm(target));
      return typeof value === "string" && value !== "dir" ? value : null;
    },
    realpath: (target) => norm(target),
    list(dir) {
      const prefix = norm(dir) + flavour.sep;
      return [...map.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes(flavour.sep)).map((key) => key.slice(prefix.length));
    },
  };
}

// ---- project directory name -----------------------------------------------------------------
test("sanitizeProjectName replaces every non-alphanumeric character with '-' (matches real folders)", () => {
  assert.equal(sanitizeProjectName("D:\\Torob"), "D--Torob");
  assert.equal(sanitizeProjectName("C:\\Users\\Torob.TOROB-L-001\\Desktop\\Torob"), "C--Users-Torob-TOROB-L-001-Desktop-Torob");
  assert.equal(sanitizeProjectName("/home/user/work/my-repo"), "-home-user-work-my-repo");
  assert.equal(sanitizeProjectName("/Users/you/پروژه"), "-Users-you------");
});

test("sanitizeProjectName cuts long names to 200 chars plus a base36 djb2 hash", () => {
  const long = `/srv/${"a".repeat(300)}`;
  const name = sanitizeProjectName(long);
  assert.equal(name, `${"-srv-".concat("a".repeat(195))}-${Math.abs(djb2(long)).toString(36)}`);
  assert.equal(djb2("abc"), 96354);
});

test("CLAUDE_CODE_PROJECT_DIR_NAME only counts beside CLAUDE_CONFIG_DIR and when the name is safe", () => {
  assert.equal(projectDirNameOverride({ CLAUDE_CODE_PROJECT_DIR_NAME: "work" }), undefined);
  assert.equal(projectDirNameOverride({ CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "work" }), "work");
  assert.equal(projectDirNameOverride({ CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "../x" }), undefined);
  assert.equal(projectDirNameOverride({ CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "nul" }), undefined);
});

test("findGitRoot walks up to the folder holding .git (Windows and POSIX inputs)", () => {
  const win = fakeFs({ "D:\\Torob\\repo\\.git": "dir" }, path.win32);
  assert.equal(findGitRoot("D:\\Torob\\repo\\web\\js", { path: path.win32, fs: win }), "D:\\Torob\\repo");
  assert.equal(findGitRoot("D:\\Torob\\other", { path: path.win32, fs: win }), null);
  const posix = fakeFs({ "/home/u/repo/.git": "gitdir: x" }, path.posix);
  assert.equal(findGitRoot("/home/u/repo/src", { path: path.posix, fs: posix }), "/home/u/repo");
  const link = fakeFs({ "/home/u/repo/.git": { link: true } }, path.posix);
  assert.equal(findGitRoot("/home/u/repo/src", { path: path.posix, fs: link }), null);
});

test("canonicalGitRoot maps a linked worktree to its main checkout", () => {
  const fs = fakeFs({
    "/w/feature/.git": "gitdir: /main/.git/worktrees/feature\n",
    "/main/.git/worktrees/feature/commondir": "../..\n",
    "/main/.git/worktrees/feature/gitdir": "/w/feature/.git\n",
  }, path.posix);
  assert.equal(canonicalGitRoot("/w/feature", { path: path.posix, fs }), "/main");
  const forged = fakeFs({
    "/w/feature/.git": "gitdir: /main/.git/worktrees/feature\n",
    "/main/.git/worktrees/feature/commondir": "../..\n",
    "/main/.git/worktrees/feature/gitdir": "/elsewhere/.git\n",
  }, path.posix);
  assert.equal(canonicalGitRoot("/w/feature", { path: path.posix, fs: forged }), "/w/feature");
  const winFs = fakeFs({
    "D:\\wt\\a\\.git": "gitdir: D:/repo/.git/worktrees/a",
    "D:\\repo\\.git\\worktrees\\a\\commondir": "../..",
    "D:\\repo\\.git\\worktrees\\a\\gitdir": "D:/wt/a/.git",
  }, path.win32);
  assert.equal(canonicalGitRoot("D:\\wt\\a", { path: path.win32, fs: winFs }), "D:\\repo");
});

test("resolveAutoMemoryDir: git root, plain folder, env name, autoMemoryDirectory", () => {
  const win = fakeFs({ "D:\\Torob\\wheelhouse\\.git": "dir" }, path.win32);
  const base = { configDir: "C:\\Users\\me\\.claude-x", home: "C:\\Users\\me", path: path.win32, fs: win };
  let where = resolveAutoMemoryDir({ ...base, cwd: "D:\\Torob\\wheelhouse\\web" });
  assert.equal(where.dir, "C:\\Users\\me\\.claude-x\\projects\\D--Torob-wheelhouse\\memory");
  assert.equal(where.via, "git");
  where = resolveAutoMemoryDir({ ...base, cwd: "D:\\Torob" });
  assert.equal(where.dir, "C:\\Users\\me\\.claude-x\\projects\\D--Torob\\memory");
  assert.equal(where.via, "cwd");
  where = resolveAutoMemoryDir({ ...base, cwd: "D:\\Torob", env: { CLAUDE_CONFIG_DIR: "x", CLAUDE_CODE_PROJECT_DIR_NAME: "shared" } });
  assert.equal(where.dir, "C:\\Users\\me\\.claude-x\\projects\\shared\\memory");
  where = resolveAutoMemoryDir({ ...base, cwd: "D:\\Torob", setting: { value: "~/notes", source: "user" } });
  assert.equal(where.dir, "C:\\Users\\me\\notes");
  assert.equal(where.via, "setting");
  const posix = fakeFs({}, path.posix);
  where = resolveAutoMemoryDir({ cwd: "/home/u/proj", configDir: "/home/u/.claude", home: "/home/u", path: path.posix, fs: posix });
  assert.equal(where.dir, "/home/u/.claude/projects/-home-u-proj/memory");
});

test("expandMemoryDirectory rejects relative, root-ish and escaping values", () => {
  const opts = { home: "/home/u", path: path.posix };
  assert.equal(expandMemoryDirectory("/data/mem/", opts), "/data/mem");
  assert.equal(expandMemoryDirectory("~/m", opts), "/home/u/m");
  assert.equal(expandMemoryDirectory("relative/dir", opts), null);
  assert.equal(expandMemoryDirectory("~/..", opts), null);
  assert.equal(expandMemoryDirectory("/", opts), null);
  assert.equal(expandMemoryDirectory("C:", { home: "C:\\u", path: path.win32 }), null);
  assert.equal(expandMemoryDirectory("\\\\server\\share\\m", { home: "C:\\u", path: path.win32 }), null);
});

test("autoMemoryState: env var wins both ways, then autoMemoryEnabled, default on", () => {
  assert.deepEqual(autoMemoryState({}), { enabled: true, by: "default" });
  assert.equal(autoMemoryState({ setting: { value: false, source: "user" } }).enabled, false);
  assert.equal(autoMemoryState({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, setting: { value: true } }).enabled, false);
  assert.equal(autoMemoryState({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" }, setting: { value: false } }).enabled, true);
  assert.equal(autoMemoryState({ settingsEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "true" } }).by, "settings-env");
});

// ---- traversal --------------------------------------------------------------------------------
test("cleanRelPath / confinedPath reject traversal, absolute paths and non-.md files", () => {
  assert.equal(cleanRelPath("frontend\\react.md"), "frontend/react.md");
  for (const bad of ["../x.md", "a/../../x.md", "/etc/x.md", "C:\\x.md", "C:x.md", "a//b.md", "./a.md", "x.txt", ".md", ".hidden.md", "a:b.md", "nul.md", "a/./b.md", "", "x.md\0"]) {
    assert.throws(() => cleanRelPath(bad), undefined, bad);
  }
  assert.equal(confinedPath("/root/mem", "a/b.md", path.posix), "/root/mem/a/b.md");
  assert.equal(confinedPath("C:\\mem", "a\\b.md", path.win32), "C:\\mem\\a\\b.md");
  assert.throws(() => confinedPath("/root/mem", "../mem2/x.md", path.posix));
  assert.throws(() => confinedPath("C:\\mem", "..\\x.md", path.win32));
});

// ---- frontmatter --------------------------------------------------------------------------------
const REAL = `---
name: feedback-reports-in-persian
description: "All status reports must be in Persian, even \\"after\\" long work"
metadata:
  node_type: memory
  type: feedback
  modified: 2026-11-11T07:15:30.304Z
---

Write every report in Persian.
`;

test("parseDoc/composeDoc round-trip byte for byte (LF, CRLF, BOM, no frontmatter)", () => {
  for (const text of [REAL, REAL.replace(/\n/g, "\r\n"), `\uFEFF${REAL}`, "# plain\n", "---\npaths: x\n---\nbody", "---\n---\n", ""]) {
    assert.equal(composeDoc(parseDoc(text)), text);
  }
});

test("memoryMeta reads top-level and metadata.type; setMemoryMeta edits in place", () => {
  const doc = parseDoc(REAL);
  assert.deepEqual(memoryMeta(doc), { name: "feedback-reports-in-persian", description: 'All status reports must be in Persian, even "after" long work', type: "feedback" });
  assert.equal(setMemoryMeta(REAL, {}), REAL);
  const changed = setMemoryMeta(REAL, { type: "user", description: "Short" });
  assert.match(changed, /\n {2}type: user\n/);
  assert.match(changed, /\ndescription: Short\n/);
  assert.match(changed, /node_type: memory/);
  assert.equal(parseDoc(changed).body, "Write every report in Persian.\n");
  const fresh = setMemoryMeta("Body\n", { name: "n", description: "d: x", type: "project" });
  assert.equal(fresh, '---\nname: n\ndescription: "d: x"\nmetadata:\n  type: project\n---\n\nBody\n');
  assert.deepEqual(memoryMeta(parseDoc(fresh)), { name: "n", description: "d: x", type: "project" });
  const top = setMemoryMeta("---\ntype: user\n---\nx", { type: "reference" });
  assert.equal(top, "---\ntype: reference\n---\nx");
});

test("rule paths: read list / flow / comma string, write, clear", () => {
  assert.deepEqual(rulePaths(parseDoc('---\npaths:\n  - "src/**/*.{ts,tsx}"\n  - lib/*.ts\n---\n')), ["src/**/*.{ts,tsx}", "lib/*.ts"]);
  assert.deepEqual(rulePaths(parseDoc("---\npaths: a/*.md, b/**\n---\n")), ["a/*.md", "b/**"]);
  assert.deepEqual(rulePaths(parseDoc('---\npaths: ["x", y]\n---\n')), ["x", "y"]);
  assert.deepEqual(rulePaths(parseDoc("# no frontmatter\n")), []);
  const added = setRulePaths("# API rules\n", ["src/api/**/*.ts"]);
  assert.equal(added, '---\npaths:\n  - "src/api/**/*.ts"\n---\n\n# API rules\n');
  assert.deepEqual(rulePaths(parseDoc(added)), ["src/api/**/*.ts"]);
  assert.equal(setRulePaths(added, []), "# API rules\n");
  const kept = setRulePaths("---\nowner: me\npaths:\n- a\n---\nbody", ["b"]);
  assert.equal(kept, '---\nowner: me\npaths:\n  - "b"\n---\nbody');
  assert.equal(replaceBody(kept, "new"), '---\nowner: me\npaths:\n  - "b"\n---\nnew');
});

// ---- index -------------------------------------------------------------------------------
test("MEMORY.md index: add, replace, remove, stats", () => {
  const index = "- [Role](user_role.md) — who the user is\n";
  const added = upsertIndexEntry(index, { file: "feedback_tests.md", title: "Tests", description: "run them\nfirst" });
  assert.equal(added, "- [Role](user_role.md) — who the user is\n- [Tests](feedback_tests.md) — run them first\n");
  assert.ok(indexHasEntry(added, "feedback_tests.md"));
  assert.ok(!indexHasEntry(added, "tests.md"));
  const replaced = upsertIndexEntry(added, { file: "user_role.md", title: "Role v2" });
  assert.equal(replaced.split("\n")[0], "- [Role v2](user_role.md)");
  assert.equal(removeIndexEntry(added, "feedback_tests.md"), index);
  assert.equal(upsertIndexEntry("", { file: "a.md", title: "A" }), "- [A](a.md)\n");
  assert.equal(removeIndexEntry("a\r\n- [B](b.md)\r\n", "b.md"), "a\r\n");
  const stats = indexStats(`${"x\n".repeat(170)}`);
  assert.equal(stats.lines, 170);
  assert.equal(stats.near, true);
  assert.equal(stats.over, false);
  assert.equal(indexStats("x\n".repeat(201)).over, true);
  assert.equal(indexStats("y".repeat(25_001)).over, true);
});

test("claudeMdExcludes globs", () => {
  assert.ok(globToRegExp("**/monorepo/CLAUDE.md").test("/home/u/monorepo/CLAUDE.md"));
  assert.ok(globToRegExp("/home/u/other/.claude/rules/**").test("/home/u/other/.claude/rules/a/b.md"));
  assert.ok(!globToRegExp("/home/u/*.md").test("/home/u/a/b.md"));
  assert.ok(globToRegExp("**/*.{md,txt}").test("/x/y.txt"));
  assert.equal(matchesAny("D:\\Repo\\.claude\\rules\\a.md", ["d:/repo/.claude/rules/**"], { caseInsensitive: true }), "d:/repo/.claude/rules/**");
});
