// Small JSON file for UI-owned state that Claude Code itself does not keep:
// pinned sessions, per-session overrides (model/effort/mode...), recent projects, prefs.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class UiStore {
  constructor(path) {
    this.path = path;
    this.data = { pins: [], archived: [], sessionMeta: {}, recentProjects: [], prefs: {} };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      this.data = { ...this.data, ...raw };
    } catch { /* first run */ }
    return this;
  }

  save() {
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
      await rename(tmp, this.path);
    }).catch(() => {});
    return this.writing;
  }

  sessionMeta(id) {
    return this.data.sessionMeta[id] || {};
  }

  patchSessionMeta(id, patch) {
    this.data.sessionMeta[id] = { ...this.data.sessionMeta[id], ...patch };
    return this.save();
  }

  setPinned(id, pinned) {
    const set = new Set(this.data.pins);
    if (pinned) set.add(id); else set.delete(id);
    this.data.pins = [...set];
    return this.save();
  }

  setArchived(id, archived) {
    const set = new Set(this.data.archived);
    if (archived) set.add(id); else set.delete(id);
    this.data.archived = [...set];
    return this.save();
  }

  touchProject(cwd) {
    if (!cwd) return;
    this.data.recentProjects = [cwd, ...this.data.recentProjects.filter((item) => item !== cwd)].slice(0, 30);
    return this.save();
  }

  setPrefs(patch) {
    this.data.prefs = { ...this.data.prefs, ...patch };
    return this.save();
  }
}
