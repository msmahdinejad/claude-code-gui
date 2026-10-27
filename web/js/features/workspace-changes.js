// Inspector tab "Changes": git status, inline diffs, stage/unstage/discard, commit, branches, log graph,
// and the list of files Claude changed in this session.
import { h, ibtn, popover, confirmDialog, promptDialog, toast, errorMessage, formatTime, copyText, debounce, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerInspectorTab, registerCommand } from "../core/registry.js";
import { lineDiff } from "../chat/tools.js";
import { wsGet, wsPost, guarded, cwdNow, relToCwd, pathLabel, renderDiff, parseDiff, diffStats, segmented, loadingBox, errorBox } from "./workspace-common.js";

// ---- persisted view prefs --------------------------------------------------------------
const PREF_KEY = "wheelhouse-ws-diff";
const prefs = (() => {
  try { return { mode: "unified", wrap: false, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return { mode: "unified", wrap: false }; }
})();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// ---- module state ----------------------------------------------------------------------
const S = {
  view: "changes", // changes | session | log | branches
  status: null,
  statusFor: null,
  error: null,
  loading: false,
  open: new Set(), // keys of rows whose diff is expanded
  diffs: new Map(), // key -> { loading, error, diff, truncated }
  dirsOpen: new Set(),
  log: null,
  logOpen: new Set(),
  commits: new Map(),
  branches: null,
  message: "",
  amend: false,
  stageAll: false,
  focusCommit: false,
};
let root = null; // current panel container
let els = null;
let lastBadge = -1;

const letterFor = { M: "M", A: "A", D: "D", R: "R", C: "C", T: "T", "?": "U", U: "!" };
const stClass = { M: "M", A: "A", D: "D", R: "R", C: "R", T: "M", "?": "N", U: "X" };

export const changeCount = () => (S.status?.isRepo ? S.status.staged.length + S.status.unstaged.length + S.status.untracked.length + S.status.conflicts.length : 0);

// ---- data ------------------------------------------------------------------------------
async function refresh({ quiet = false } = {}) {
  const cwd = cwdNow();
  if (!cwd) return;
  if (!quiet && !S.status) { S.loading = true; draw(); }
  try {
    const status = await wsGet("/api/ws/git/status");
    if (cwd !== cwdNow()) return;
    S.status = status;
    S.statusFor = cwd;
    S.error = null;
    // Drop cached diffs of rows that no longer exist.
    S.diffs.clear();
  } catch (error) {
    S.error = errorMessage(error);
  }
  S.loading = false;
  updateBadge();
  draw();
}

function updateBadge() {
  const n = changeCount();
  if (n !== lastBadge) {
    lastBadge = n;
    if (document.body.classList.contains("inspector-open")) bus.emit("conv:update", app.currentId);
  }
}

async function act(action, body = {}, { success } = {}) {
  const result = await guarded(wsPost("/api/ws/git/action", { action, ...body }));
  if (result && success) toast(success, "ok", 2200);
  await refresh({ quiet: true });
  if (S.view === "branches") S.branches = null, draw();
  if (S.view === "log") S.log = null, draw();
  return result;
}

async function loadDiff(key, params) {
  S.diffs.set(key, { loading: true });
  draw();
  try {
    const result = await wsGet("/api/ws/git/diff", params);
    S.diffs.set(key, { diff: result.diff, truncated: result.truncated });
  } catch (error) {
    S.diffs.set(key, { error: errorMessage(error) });
  }
  draw();
}

// ---- drawing ---------------------------------------------------------------------------
function draw() {
  if (!root || !els) return;
  const scroller = root.closest(".insp-body");
  const top = scroller?.scrollTop ?? 0;
  drawHead();
  els.body.replaceChildren(bodyFor());
  els.commit.classList.toggle("hidden", S.view !== "changes" || !S.status?.isRepo);
  drawCommit();
  if (scroller) scroller.scrollTop = top;
}

function drawHead() {
  const st = S.status;
  const branchLabel = st?.isRepo ? (st.detached ? `HEAD ${st.oid?.slice(0, 7) || ""}` : st.branch || "—") : t("No repository");
  els.head.replaceChildren(
    h(
      "button.ws-branch",
      { type: "button", disabled: !st?.isRepo, title: t("Switch branch"), onclick: (event) => branchPopover(event.currentTarget) },
      icon("git-branch", 14),
      h("span", { dir: "ltr" }, branchLabel),
      icon("chevron-down", 12),
    ),
    st?.ahead ? h("span.badge.accent", { title: t("Commits ahead of upstream") }, `↑${st.ahead}`) : null,
    st?.behind ? h("span.badge.warn", { title: t("Commits behind upstream") }, `↓${st.behind}`) : null,
    h("span", { style: { flex: 1 } }),
    ibtn("refresh", t("Refresh"), () => refresh(), { size: 15 }),
  );
  const count = (n) => (n ? ` ${n}` : "");
  const tabs = [
    ["changes", t("Changes") + count(changeCount())],
    ["session", t("Session")],
    ["log", t("Log")],
    ["branches", t("Branches")],
  ];
  els.tabs.replaceChildren(...tabs.map(([id, label]) => h(`button${S.view === id ? ".active" : ""}`, { type: "button", onclick: () => { S.view = id; if (id === "log") S.log = null; if (id === "branches") S.branches = null; draw(); if (id === "log") loadLog(); if (id === "branches") loadBranches(); } }, label)));
}

function bodyFor() {
  if (S.loading && !S.status) return loadingBox();
  if (S.error && !S.status) return errorBox(S.error, () => refresh());
  if (S.view === "session") return sessionView();
  if (!S.status?.isRepo) {
    return h(
      "div.empty",
      icon("git-branch", 28),
      h("strong", t("Not a git repository")),
      h("p", t("Initialize git to track Claude's changes, diff them and commit.")),
      h("button.btn.primary", { type: "button", onclick: async () => { await guarded(wsPost("/api/ws/git/init")); await refresh(); } }, t("Initialize repository")),
    );
  }
  if (S.view === "log") return logView();
  if (S.view === "branches") return branchesView();
  return changesView();
}

// ---- changes view ----------------------------------------------------------------------
function changesView() {
  const st = S.status;
  if (!changeCount()) {
    return h("div.empty", icon("check-circle", 28), h("strong", t("Working tree clean")), h("p", t("Nothing to commit. Ask Claude to make a change and it will show up here.")));
  }
  const parts = [];
  if (st.conflicts.length) parts.push(group(t("Merge conflicts"), "conflict", st.conflicts, [], "danger"));
  if (st.staged.length) parts.push(group(t("Staged"), "staged", st.staged, [{ icon: "minus", label: t("Unstage all"), run: () => act("unstageAll") }]));
  if (st.unstaged.length) parts.push(group(t("Changes"), "unstaged", st.unstaged, [{ icon: "plus", label: t("Stage all"), run: () => act("stage", { paths: st.unstaged.map((f) => f.path) }) }]));
  if (st.untracked.length) parts.push(group(t("Untracked"), "untracked", st.untracked, [{ icon: "plus", label: t("Stage all"), run: () => act("stage", { paths: topLevelUntracked(st.untracked) }) }]));
  return h("div.ws-groups", parts);
}

function topLevelUntracked(list) {
  // Staging every untracked file individually can be thousands of args; stage by top-level folder instead.
  const roots = new Set();
  for (const item of list) roots.add(item.path.includes("/") ? item.path.split("/")[0] : item.path);
  return [...roots];
}

function group(title, kind, files, actions, tone = "") {
  const head = h(
    "div.ws-group-head",
    h("span", { class: tone ? `ws-group-title ${tone}` : "ws-group-title" }, title),
    h("span.badge", String(files.length)),
    h("span", { style: { flex: 1 } }),
    ...actions.map((action) => ibtn(action.icon, action.label, action.run, { size: 14 })),
  );
  let rows;
  if (kind === "untracked" && files.length > 100) rows = untrackedFolders(files);
  else rows = files.map((file) => fileRow(file, kind));
  return h("section.ws-group", head, h("div.ws-rows", rows));
}

function untrackedFolders(files) {
  const byDir = new Map();
  for (const file of files) {
    const dir = file.path.includes("/") ? file.path.split("/")[0] : "";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(file);
  }
  const rows = [];
  for (const [dir, list] of byDir) {
    if (!dir) { list.forEach((file) => rows.push(fileRow(file, "untracked"))); continue; }
    const open = S.dirsOpen.has(dir);
    rows.push(
      h(
        "div.ws-row.dir",
        { onclick: () => { open ? S.dirsOpen.delete(dir) : S.dirsOpen.add(dir); draw(); } },
        icon(open ? "chevron-down" : "chevron-right", 13),
        icon("folder", 14),
        h("span.ws-path", { dir: "ltr" }, h("span.ws-name", `${dir}/`)),
        h("span.badge", String(list.length)),
        h("span.ws-actions", ibtn("plus", t("Stage"), (event) => { event.stopPropagation(); act("stage", { paths: [dir] }); }, { size: 14 }), ibtn("trash", t("Delete"), (event) => { event.stopPropagation(); discard([dir], "untracked", `${dir}/ (${list.length})`); }, { size: 14 })),
      ),
    );
    if (open) list.slice(0, 200).forEach((file) => rows.push(fileRow(file, "untracked")));
    if (open && list.length > 200) rows.push(h("div.ws-more", t("… and {n} more files", { n: list.length - 200 })));
  }
  return rows;
}

function fileRow(file, kind) {
  const key = `${kind}:${file.path}`;
  const open = S.open.has(key);
  const code = file.code;
  const row = h(
    "div.ws-row",
    { role: "button", tabindex: "0", onclick: () => toggleDiff(key, kind, file), onkeydown: (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), toggleDiff(key, kind, file)) },
    icon(open ? "chevron-down" : "chevron-right", 13),
    h(`span.ws-badge.st-${stClass[code] || "M"}`, { title: statusTitle(code) }, letterFor[code] || code),
    file.orig ? h("span.ws-path", { dir: "ltr", title: `${file.orig} → ${file.path}` }, h("span.ws-dir", `${baseName(file.orig)} → `), h("span.ws-name", baseName(file.path))) : pathLabel(file.path),
    file.add !== undefined || file.del !== undefined ? h("span.ws-counts", file.add === null ? t("binary") : [h("span.add", `+${file.add ?? 0}`), " ", h("span.del", `−${file.del ?? 0}`)]) : null,
    h("span.ws-actions", rowActions(file, kind)),
  );
  const nodes = [row];
  if (open) nodes.push(diffBox(key));
  return h("div.ws-item", nodes);
}

function rowActions(file, kind) {
  const actions = [];
  const stop = (fn) => (event) => { event.stopPropagation(); fn(); };
  if (kind === "staged") actions.push(ibtn("minus", t("Unstage"), stop(() => act("unstage", { paths: [file.path, ...(file.orig ? [file.orig] : [])] })), { size: 14 }));
  else actions.push(ibtn("plus", t("Stage"), stop(() => act("stage", { paths: [file.path] })), { size: 14 }));
  if (kind !== "conflict" && file.code !== "D" || kind === "unstaged") actions.push(ibtn("file", t("Open file"), stop(() => bus.emit("open-file", { path: `${S.status.root}/${file.path}` })), { size: 14 }));
  if (kind === "untracked") actions.push(ibtn("trash", t("Delete file"), stop(() => discard([file.path], "untracked", file.path)), { size: 14 }));
  else if (kind !== "conflict") actions.push(ibtn("undo", t("Discard changes"), stop(() => discard([file.path], "tracked", file.path)), { size: 14 }));
  return actions;
}

const statusTitle = (code) => ({ M: t("Modified"), A: t("Added"), D: t("Removed"), R: t("Renamed"), C: t("File copied"), T: t("Type changed"), "?": t("Untracked"), U: t("Conflict") })[code] || code;

async function discard(paths, kind, label) {
  const ok = await confirmDialog({
    title: kind === "untracked" ? t("Delete untracked file?") : t("Discard changes?"),
    message: kind === "untracked" ? t("“{path}” will be permanently deleted from disk.", { path: label }) : t("All uncommitted changes to “{path}” will be lost. This cannot be undone.", { path: label }),
    confirmLabel: kind === "untracked" ? t("Delete") : t("Discard"),
    danger: true,
  });
  if (ok) await act("discard", { paths, kind }, { success: t("Done") });
}

function toggleDiff(key, kind, file) {
  if (S.open.has(key)) S.open.delete(key);
  else {
    S.open.add(key);
    loadDiff(key, diffParams(kind, file));
    return;
  }
  draw();
}

const diffParams = (kind, file) => ({ mode: kind === "conflict" ? "unstaged" : kind, path: file.path, ...(file.orig ? { orig: file.orig } : {}) });

function diffBox(key) {
  const entry = S.diffs.get(key);
  const box = h("div.ws-diffbox");
  if (!entry || entry.loading) { box.append(loadingBox()); return box; }
  if (entry.error) { box.append(errorBox(entry.error)); return box; }
  box.append(diffToolbar(entry.diff), renderDiff(entry.diff, { mode: prefs.mode, wrap: prefs.wrap, truncated: entry.truncated, showFileHeader: false }));
  return box;
}

function diffToolbar(diff) {
  const stats = diffStats(parseDiff(diff));
  return h(
    "div.wsd-toolbar",
    h("span.ws-counts", [h("span.add", `+${stats.add}`), " ", h("span.del", `−${stats.del}`)]),
    h("span", { style: { flex: 1 } }),
    segmented([["unified", t("Unified")], ["split", t("Split")]], prefs.mode, (value) => { prefs.mode = value; savePrefs(); draw(); }),
    h(`button.btn.small.ghost${prefs.wrap ? ".active" : ""}`, { type: "button", title: t("Wrap long lines"), onclick: () => { prefs.wrap = !prefs.wrap; savePrefs(); draw(); } }, icon("expand", 13)),
    ibtn("copy", t("Copy diff"), () => copyText(diff), { size: 14 }),
  );
}

// ---- commit box ------------------------------------------------------------------------
function buildCommitBox() {
  const textarea = h("textarea.input.ws-msg", { rows: 3, dir: "auto", placeholder: t("Commit message"), "aria-label": t("Commit message") });
  textarea.addEventListener("input", () => { S.message = textarea.value; drawCommit(); });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
  });
  const amend = h("input", { type: "checkbox" });
  amend.addEventListener("change", () => { S.amend = amend.checked; drawCommit(); });
  const stageAll = h("input", { type: "checkbox" });
  stageAll.addEventListener("change", () => { S.stageAll = stageAll.checked; drawCommit(); });
  const commitBtn = h("button.btn.primary", { type: "button", onclick: () => commit() });
  const genBtn = h("button.btn.small.ghost", { type: "button", title: t("Ask Claude to write the message"), onclick: generateMessage }, icon("sparkles", 13), t("Write with Claude"));
  const useBtn = h("button.btn.small.ghost", { type: "button", title: t("Use Claude's last reply as the message"), onclick: useLastReply }, icon("message-square", 13), t("Use last reply"));
  const box = h("div.ws-commit", textarea, h("div.ws-commit-opts", h("label.switch", amend, h("span", t("Amend"))), h("label.switch.stageall", stageAll, h("span", t("Stage all first")))), h("div.ws-commit-bar", genBtn, useBtn, h("span", { style: { flex: 1 } }), commitBtn));
  els.commitParts = { textarea, amend, stageAll, commitBtn, stageAllLabel: box.querySelector(".stageall") };
  return box;
}

function drawCommit() {
  const parts = els?.commitParts;
  if (!parts || !S.status?.isRepo) return;
  const staged = S.status.staged.length;
  const other = S.status.unstaged.length + S.status.untracked.length;
  if (parts.textarea.value !== S.message) parts.textarea.value = S.message;
  parts.amend.checked = S.amend;
  parts.stageAll.checked = S.stageAll;
  parts.stageAllLabel.classList.toggle("hidden", staged > 0 || !other);
  const canCommit = (S.message.trim() || S.amend) && (staged > 0 || (S.stageAll && other > 0) || S.amend);
  parts.commitBtn.disabled = !canCommit;
  parts.commitBtn.replaceChildren(icon("git-commit", 14), S.amend ? t("Amend commit") : staged ? t("Commit {n} file(s)", { n: staged }) : t("Commit"));
  if (S.focusCommit) { S.focusCommit = false; parts.textarea.focus(); }
}

async function commit() {
  const stagedNone = !S.status.staged.length;
  const result = await act("commit", { message: S.message, amend: S.amend, stageAll: stagedNone && S.stageAll }, { success: t("Committed") });
  if (result) { S.message = ""; S.amend = false; S.stageAll = false; drawCommit(); }
}

function generateMessage() {
  bus.emit("composer:fill", t("Write a concise commit message (Conventional Commits style) for the currently staged changes. Run `git diff --staged` to see them and reply with only the message text."));
  toast(t("Prompt placed in the composer — send it, then use “Use last reply”."), "info", 4500);
}

function useLastReply() {
  const conv = app.convs.get(app.currentId);
  const last = conv && [...conv.items].reverse().find((item) => item.kind === "assistant" && item.blocks.some((block) => block.type === "text" && block.text.trim()));
  const text = last?.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
  if (!text) return toast(t("No reply from Claude yet."), "error");
  S.message = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").replace(/^["'`]|["'`]$/g, "").trim();
  drawCommit();
  els.commitParts.textarea.focus();
}

// ---- branches --------------------------------------------------------------------------
async function loadBranches() {
  try {
    S.branches = (await wsGet("/api/ws/git/branches")).branches;
  } catch (error) {
    S.branches = { error: errorMessage(error) };
  }
  draw();
}

async function createBranch(from) {
  const name = await promptDialog({ title: t("New branch"), label: from ? t("Branch name (from {from})", { from }) : t("Branch name"), placeholder: "feature/my-change", confirmLabel: t("Create") });
  if (name?.trim()) await act("createBranch", { branch: name.trim(), from }, { success: t("Branch created") });
}

function branchPopover(anchor) {
  const filter = h("input.input", { type: "search", placeholder: t("Filter branches…"), dir: "ltr" });
  const list = h("div.ws-branch-list");
  const body = h("div.ws-branch-pop", h("div.ws-branch-filter", filter), list, h("div.menu-sep"), h("button.menu-item", { type: "button", onclick: () => { pop.close(); createBranch(); } }, icon("plus", 15), h("span.menu-label", t("New branch…"))), h("button.menu-item", { type: "button", onclick: async () => { pop.close(); const r = await guarded(wsPost("/api/ws/git/action", { action: "fetch" })); if (r) toast(t("Fetched"), "ok", 1800); refresh({ quiet: true }); } }, icon("download", 15), h("span.menu-label", t("Fetch remotes"))));
  const pop = popover(anchor, body, { width: 300, className: "ws-branch-popover" });
  const render = (branches) => {
    const needle = filter.value.trim().toLowerCase();
    const items = (branches || []).filter((b) => !needle || b.name.toLowerCase().includes(needle));
    list.replaceChildren(
      ...items.map((b) => h(`button.menu-item${b.current ? ".checked" : ""}`, { type: "button", onclick: () => { pop.close(); if (!b.current) switchBranch(b); } }, icon(b.remote ? "globe" : "git-branch", 14), h("span.menu-label", { dir: "ltr" }, b.name), b.current ? icon("check", 14) : null)),
      !items.length ? h("div.muted", { style: { padding: "10px" } }, t("No branches")) : null,
    );
  };
  filter.addEventListener("input", () => render(Array.isArray(S.branches) ? S.branches : []));
  wsGet("/api/ws/git/branches").then((r) => { S.branches = r.branches; render(r.branches); }).catch((e) => list.replaceChildren(errorBox(errorMessage(e))));
  filter.focus();
}

async function switchBranch(branch) {
  const dirty = changeCount();
  if (dirty && !branch.remote) {
    // git will refuse if changes conflict; let it decide and show its message.
  }
  await act(branch.remote ? "checkoutRemote" : "checkout", { branch: branch.name }, { success: t("Switched to {name}", { name: branch.name }) });
}

function branchesView() {
  if (!S.branches) return loadingBox();
  if (S.branches.error) return errorBox(S.branches.error, loadBranches);
  const local = S.branches.filter((b) => !b.remote);
  const remote = S.branches.filter((b) => b.remote);
  const row = (b) =>
    h(
      "div.ws-row.branch",
      icon(b.remote ? "globe" : "git-branch", 14),
      h("div.ws-branch-info", h("span.ws-name", { dir: "ltr" }, b.name, b.current ? h("span.badge.accent", { style: { marginInlineStart: "6px" } }, t("current")) : null), h("span.muted", { dir: "auto" }, `${b.hash} · ${b.subject || ""}`)),
      h(
        "span.ws-actions.always",
        !b.current ? ibtn("check", t("Checkout"), () => switchBranch(b), { size: 14 }) : null,
        !b.remote ? ibtn("split", t("New branch from here"), () => createBranch(b.name), { size: 14 }) : null,
        !b.current && !b.remote ? ibtn("trash", t("Delete branch"), () => deleteBranch(b), { size: 14 }) : null,
      ),
    );
  return h("div.ws-groups", h("section.ws-group", h("div.ws-group-head", h("span.ws-group-title", t("Local")), h("span.badge", String(local.length)), h("span", { style: { flex: 1 } }), ibtn("plus", t("New branch…"), () => createBranch(), { size: 14 })), h("div.ws-rows", local.map(row))), remote.length ? h("section.ws-group", h("div.ws-group-head", h("span.ws-group-title", t("Remote")), h("span.badge", String(remote.length))), h("div.ws-rows", remote.map(row))) : null);
}

async function deleteBranch(branch) {
  const ok = await confirmDialog({ title: t("Delete branch?"), message: t("Delete local branch “{name}”?", { name: branch.name }), confirmLabel: t("Delete"), danger: true });
  if (!ok) return;
  try {
    await wsPost("/api/ws/git/action", { action: "deleteBranch", branch: branch.name });
  } catch (error) {
    const force = await confirmDialog({ title: t("Branch is not fully merged"), message: `${errorMessage(error)}\n\n${t("Force delete anyway?")}`, confirmLabel: t("Force delete"), danger: true });
    if (force) await guarded(wsPost("/api/ws/git/action", { action: "deleteBranch", branch: branch.name, force: true }));
  }
  loadBranches();
  refresh({ quiet: true });
}

// ---- log + graph -----------------------------------------------------------------------
async function loadLog(more = false) {
  try {
    const skip = more && S.log ? S.log.commits.length : 0;
    const result = await wsGet("/api/ws/git/log", { limit: 60, skip });
    S.log = more && S.log ? { commits: [...S.log.commits, ...result.commits], hasMore: result.hasMore } : result;
  } catch (error) {
    S.log = { error: errorMessage(error), commits: [] };
  }
  draw();
}

const LANE = 12;
const LANE_COLORS = ["#c96442", "#2d6cb5", "#2f7d4f", "#8a5db5", "#b5632a", "#06989a", "#b0476b"];

/** Assign lanes so merges/branches draw as a classic git graph. Returns [{lane, before, after, merges}] per commit. */
function layoutGraph(commits) {
  let lanes = [];
  const rows = [];
  for (const commit of commits) {
    const before = lanes.slice();
    let lane = lanes.indexOf(commit.hash);
    const convergent = [];
    lanes.forEach((hash, i) => { if (hash === commit.hash && i !== lane) convergent.push(i); });
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = commit.hash;
    }
    for (const i of convergent) lanes[i] = null;
    const parents = commit.parents;
    const mergeLanes = [];
    if (parents.length) {
      lanes[lane] = parents[0];
      for (const parent of parents.slice(1)) {
        let target = lanes.indexOf(parent);
        if (target === -1) {
          target = lanes.indexOf(null);
          if (target === -1) target = lanes.length;
          lanes[target] = parent;
        }
        mergeLanes.push(target);
      }
    } else lanes[lane] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ lane, before, after: lanes.slice(), convergent, mergeLanes, hadBefore: before[lane] === commit.hash });
  }
  return rows;
}

function graphCell(row, width) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const height = 46;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("class", "ws-graph");
  const x = (i) => 8 + i * LANE;
  const mid = height / 2;
  const add = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.append(el); return el; };
  const color = (i) => LANE_COLORS[i % LANE_COLORS.length];
  const line = (x1, y1, x2, y2, c) => add("path", { d: x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`, stroke: color(c), "stroke-width": 1.6, fill: "none" });
  row.before.forEach((hash, i) => {
    if (!hash) return;
    if (i === row.lane) line(x(i), 0, x(i), mid, i);
    else if (row.convergent.includes(i)) line(x(i), 0, x(row.lane), mid, i);
    else if (row.after[i] === hash) line(x(i), 0, x(i), height, i);
  });
  if (row.after[row.lane] && row.after[row.lane] !== undefined) line(x(row.lane), mid, x(row.lane), height, row.lane);
  row.mergeLanes.forEach((target) => line(x(row.lane), mid, x(target), height, target));
  add("circle", { cx: x(row.lane), cy: mid, r: 4, fill: color(row.lane), stroke: "var(--surface)", "stroke-width": 1.5 });
  return svg;
}

function logView() {
  if (!S.log) return loadingBox();
  if (S.log.error) return errorBox(S.log.error, () => loadLog());
  if (!S.log.commits.length) return h("div.empty", icon("history", 26), h("strong", t("No commits yet")));
  const layout = layoutGraph(S.log.commits);
  const maxLanes = Math.max(2, ...layout.map((row) => Math.max(row.before.length, row.after.length, row.lane + 1)));
  const width = 12 + maxLanes * LANE;
  const rows = S.log.commits.map((commit, i) => {
    const open = S.logOpen.has(commit.hash);
    const refs = commit.refs.map((ref) => {
      const clean = ref.replace(/^HEAD -> /, "").replace(/^tag: /, "");
      const kind = ref.startsWith("tag: ") ? "warn" : ref.startsWith("HEAD") ? "accent" : ref.includes("/") && !ref.startsWith("feature/") ? "" : "ok";
      return h(`span.badge.${kind || "ok"}`, { dir: "ltr" }, clean);
    });
    const row = h(
      "div.ws-row.commit",
      { role: "button", tabindex: "0", onclick: () => toggleCommit(commit.hash), onkeydown: (e) => (e.key === "Enter") && toggleCommit(commit.hash) },
      graphCell(layout[i], width),
      h("div.ws-commit-info", h("div.ws-commit-subject", { dir: "auto" }, commit.subject, refs.length ? h("span.ws-refs", refs) : null), h("span.muted", `${commit.hash.slice(0, 7)} · ${commit.author} · ${formatTime(Date.parse(commit.date))}`)),
    );
    return h("div.ws-item", row, open ? commitDetail(commit) : null);
  });
  return h("div.ws-log", rows, S.log.hasMore ? h("button.btn.small", { style: { margin: "10px auto", display: "flex" }, type: "button", onclick: () => loadLog(true) }, t("Load more")) : null);
}

async function toggleCommit(hash) {
  if (S.logOpen.has(hash)) { S.logOpen.delete(hash); draw(); return; }
  S.logOpen.add(hash);
  if (!S.commits.has(hash)) {
    S.commits.set(hash, { loading: true });
    draw();
    try { S.commits.set(hash, await wsGet("/api/ws/git/show", { hash })); } catch (error) { S.commits.set(hash, { error: errorMessage(error) }); }
  }
  draw();
}

function commitDetail(commit) {
  const data = S.commits.get(commit.hash);
  const box = h("div.ws-diffbox");
  if (!data || data.loading) { box.append(loadingBox()); return box; }
  if (data.error) { box.append(errorBox(data.error)); return box; }
  box.append(
    h("div.ws-commit-meta", h("div.ws-commit-msg", { dir: "auto" }, data.message), h("div.muted", { dir: "ltr" }, `${data.hash} · ${data.email}`), h("div", ibtn("copy", t("Copy hash"), () => copyText(data.hash), { size: 14 }), ibtn("git-branch", t("Branch from here"), () => createBranch(data.hash.slice(0, 10)), { size: 14 }))),
    diffToolbar(data.diff),
    renderDiff(data.diff, { mode: prefs.mode, wrap: prefs.wrap, truncated: data.truncated, showFileHeader: true }),
  );
  return box;
}

// ---- files changed in this session ------------------------------------------------------
function sessionFiles() {
  const conv = app.convs.get(app.currentId);
  const files = new Map();
  if (!conv) return [];
  for (const tool of conv.tools.values()) {
    if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool.name) || tool.status === "error" || tool.status === "denied" || tool.status === "interrupted") continue;
    const path = tool.input?.file_path || tool.input?.notebook_path;
    if (!path) continue;
    const entry = files.get(path) || { path, edits: [], created: false };
    entry.edits.push(tool);
    if (tool.name === "Write") entry.created = true;
    files.set(path, entry);
  }
  return [...files.values()];
}

function sessionView() {
  const files = sessionFiles();
  if (!files.length) return h("div.empty", icon("file-diff", 28), h("strong", t("No file changes yet")), h("p", t("Files Claude edits or creates in this session are listed here.")));
  const rows = files.map((file) => {
    const key = `session:${file.path}`;
    const open = S.open.has(key);
    const rel = relToCwd(file.path);
    const inside = rel !== null && S.status?.isRepo;
    const row = h(
      "div.ws-row",
      { role: "button", tabindex: "0", onclick: () => { if (open) S.open.delete(key); else { S.open.add(key); if (inside) loadDiff(key, { mode: "head", path: rel }); } draw(); } },
      icon(open ? "chevron-down" : "chevron-right", 13),
      h(`span.ws-badge.st-${file.created ? "A" : "M"}`, file.created ? "A" : "M"),
      pathLabel(rel ?? file.path),
      h("span.badge", { title: t("Number of edits") }, `×${file.edits.length}`),
      h("span.ws-actions.always", ibtn("file", t("Open file"), (event) => { event.stopPropagation(); bus.emit("open-file", { path: file.path }); }, { size: 14 })),
    );
    return h("div.ws-item", row, open ? sessionDiff(key, file, inside) : null);
  });
  return h("div.ws-groups", h("section.ws-group", h("div.ws-group-head", h("span.ws-group-title", t("Changed by Claude in this session")), h("span.badge", String(files.length))), h("div.ws-rows", rows)));
}

function sessionDiff(key, file, inside) {
  const entry = S.diffs.get(key);
  const box = h("div.ws-diffbox");
  if (inside && entry?.diff) {
    box.append(diffToolbar(entry.diff), renderDiff(entry.diff, { mode: prefs.mode, wrap: prefs.wrap, truncated: entry.truncated, showFileHeader: false }));
    if (!entry.diff.trim()) box.append(editsDiff(file));
    return box;
  }
  if (inside && (!entry || entry.loading)) { box.append(loadingBox()); return box; }
  box.append(editsDiff(file)); // outside the repo / error: show the edits Claude made
  return box;
}

function editsDiff(file) {
  const blocks = [];
  for (const tool of file.edits) {
    const input = tool.input || {};
    const edits = tool.name === "MultiEdit" ? input.edits || [] : tool.name === "Write" ? [{ old_string: "", new_string: input.content ?? "" }] : [input];
    for (const edit of edits) {
      const lines = lineDiff(edit.old_string ?? "", edit.new_string ?? edit.new_source ?? "");
      const text = ["--- a/x", "+++ b/x", "@@ -1 +1 @@", ...lines.map((line) => (line.t === "add" ? "+" : line.t === "del" ? "-" : " ") + line.text)].join("\n");
      blocks.push(renderDiff(text, { mode: prefs.mode, wrap: prefs.wrap, showFileHeader: false }));
    }
  }
  return h("div", h("div.muted", { style: { padding: "4px 8px", fontSize: ".8em" } }, t("Edits made by Claude (git diff unavailable)")), blocks);
}

// ---- tab registration ------------------------------------------------------------------
function render(container) {
  root = container;
  const head = h("div.ws-head");
  const tabs = h("div.tabs-inline.ws-subtabs");
  const body = h("div.ws-body");
  const commitHost = h("div.ws-commit-host");
  els = { head, tabs, body, commit: commitHost };
  commitHost.append(buildCommitBox());
  container.append(h("div.ws-panel", head, tabs, body, commitHost));
  if (S.statusFor !== cwdNow()) { S.status = null; S.open.clear(); S.diffs.clear(); S.branches = null; S.log = null; }
  draw();
  refresh({ quiet: Boolean(S.status) });
  return () => { root = null; els = null; };
}

registerInspectorTab({ id: "changes", title: "Changes", icon: "git-branch", order: 10, badge: () => (changeCount() || ""), render });

// Refresh when Claude finishes a tool that can change files, and when the window regains focus.
const refreshSoon = debounce(() => { if (document.body.classList.contains("inspector-open") && app.prefs.inspectorTab === "changes") refresh({ quiet: true }); }, 700);
let toolSig = "";
bus.on("conv:update", (id) => {
  if (id !== app.currentId) return;
  const conv = app.convs.get(id);
  if (!conv) return;
  let sig = conv.state;
  for (const tool of conv.tools.values()) if (tool.status === "done" && ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "PowerShell"].includes(tool.name)) sig += tool.id;
  if (sig !== toolSig) { toolSig = sig; refreshSoon(); if (S.view === "session") draw(); }
});
bus.on("current", () => { S.status = null; S.statusFor = null; S.open.clear(); S.diffs.clear(); S.branches = null; S.log = null; refreshSoon(); });
window.addEventListener("focus", refreshSoon);

registerCommand({ id: "ws-changes", title: "Open changes", icon: "git-branch", keywords: ["git", "diff", "status"], run: (ctx) => ctx.openInspector("changes") });
registerCommand({ id: "ws-commit", title: "Commit…", icon: "git-commit", keywords: ["git", "commit"], run: async (ctx) => { S.view = "changes"; S.focusCommit = true; await ctx.openInspector("changes"); setTimeout(() => { drawCommit(); }, 200); } });
registerCommand({ id: "ws-stage-all", title: "Stage all", icon: "plus", keywords: ["git", "add"], run: async () => { await act("stageAll", {}, { success: t("All changes staged") }); } });
