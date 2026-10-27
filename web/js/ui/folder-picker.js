// Modal folder browser backed by /api/fs/list.
import { h, modal, toast, errorMessage, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { api } from "../core/api.js";

export function pickFolder(start) {
  return new Promise((resolve) => {
    let current = start || app.config?.defaultCwd || app.config?.home || "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const pathInput = h("input.input", { type: "text", dir: "ltr", spellcheck: "false" });
    const list = h("div.fp-list");
    const recents = h("div.fp-recents");

    const parentOf = (path) => {
      const trimmed = path.replace(/[\\/]+$/, "");
      const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
      if (index <= 0) return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed.slice(0, index + 1) || "/";
      const parent = trimmed.slice(0, index);
      return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
    };

    async function go(path) {
      try {
        const { entries } = await api.get("/api/fs/list", { path });
        current = path;
        pathInput.value = path;
        const dirs = entries.filter((entry) => entry.dir);
        list.replaceChildren(
          h("button.fp-row", { type: "button", onclick: () => go(parentOf(path)) }, icon("chevron-up", 15), h("span", "..")),
          ...dirs.map((entry) => h("button.fp-row", { type: "button", ondblclick: () => go(entry.path), onclick: () => go(entry.path) }, icon("folder", 15), h("span", { dir: "auto" }, entry.name))),
          !dirs.length ? h("div.muted.fp-empty", t("No subfolders")) : null,
        );
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }

    const dialog = modal({
      title: t("Choose project folder"),
      width: 560,
      onClose: () => finish(null),
      body: h(
        "div.fp",
        h("button.btn.fp-native", { type: "button", onclick: async () => {
          const { nativeFolderDialog } = await import("./project-menu.js");
          const chosen = await nativeFolderDialog(current);
          if (chosen) { finish(chosen); dialog.close(); }
        } }, icon("folder-open", 14), t("Open system folder dialog")),
        h("div.fp-bar", pathInput, h("button.btn", { type: "button", onclick: () => go(pathInput.value.trim()) }, t("Go"))),
        (app.config?.recentProjects?.length || 0) ? h("div.fp-recent-title", t("Recent")) : null,
        recents,
        list,
      ),
      actions: [
        { label: t("Cancel"), onClick: (m) => { finish(null); m.close(); } },
        { label: t("Use this folder"), variant: "primary", onClick: (m) => { finish(current); m.close(); } },
      ],
    });
    pathInput.addEventListener("keydown", (event) => event.key === "Enter" && go(pathInput.value.trim()));
    recents.replaceChildren(...(app.config?.recentProjects || []).slice(0, 6).map((path) => h("button.chip", { type: "button", title: path, onclick: () => go(path) }, baseName(path))));
    go(current);
    return dialog;
  });
}
