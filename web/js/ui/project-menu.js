// Project / folder selection: native OS dialog (falls back to the in-app browser), recent projects,
// and "new folder" (a fresh session folder in the default location, like Claude Desktop).
import { menu, toast, errorMessage, baseName } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { api } from "../core/api.js";
import * as session from "../session.js";
import { pickFolder } from "./folder-picker.js";

/** Ask the OS for a folder. Returns a path, null (cancelled) or undefined (no native dialog available). */
export async function nativeFolderDialog(start) {
  try {
    const { path } = await api.post("/api/pick-folder", { start, title: t("Choose a project folder") });
    return path || null;
  } catch {
    return undefined;
  }
}

/** Native dialog when possible, otherwise the in-app folder browser. */
export async function chooseFolder(start = app.currentCwd) {
  toast(t("Choose a folder in the window that just opened."), "info", 2500);
  const native = await nativeFolderDialog(start);
  if (native !== undefined) return native;
  return pickFolder(start);
}

export async function openFolderAsSession() {
  const dir = await chooseFolder();
  if (dir) await session.newSession({ cwd: dir });
}

export function openProjectMenu(anchor, options = {}) {
  const recents = (app.config?.recentProjects || [])
    .filter((path) => !session.isScratchCwd(path))
    .slice(0, 6)
    .map((path) => ({ label: baseName(path), icon: "folder", hint: path === app.currentCwd ? "✓" : "", onClick: () => session.newSession({ cwd: path }) }));
  const items = [
    ...(recents.length ? [{ header: t("Recent projects") }, ...recents, "-"] : []),
    { label: t("Choose folder…"), icon: "folder-open", onClick: () => openFolderAsSession() },
    { label: t("New folder (default location)"), icon: "plus", onClick: () => session.newSession({ meta: { scratch: true }, cwd: undefined }).catch((error) => toast(errorMessage(error), "error")) },
  ];
  return menu(anchor, items, { placement: options.placement || "bottom-start", width: 280 });
}
