// Command palette (Ctrl+K): actions, sessions, slash commands.
import { h, modal, debounce, formatTime } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { commands } from "../core/registry.js";
import { openSession } from "../session.js";
import { makeCtx } from "../ctx.js";

export function openPalette() {
  const input = h("input.input.pal-input", { type: "text", placeholder: t("Type a command or search sessions…"), dir: "auto", autofocus: true });
  const list = h("div.pal-list");
  let items = [];
  let index = 0;
  let dialog;

  const ctx = makeCtx();
  const build = (query) => {
    const needle = query.trim().toLowerCase();
    const actions = commands
      .filter((command) => !command.when || command.when(ctx))
      .map((command) => ({ kind: "command", icon: command.icon || "command", title: t(command.title), hint: command.shortcut, keywords: `${command.title} ${(command.keywords || []).join(" ")}`, run: () => command.run(ctx) }));
    const sessions = app.sessions.filter((session) => !session.archived).map((session) => ({ kind: "session", icon: "message-square", title: session.title || t("Untitled session"), hint: formatTime(session.lastModified), keywords: `${session.title} ${session.cwd} ${session.firstPrompt || ""}`, run: () => openSession(session.id, { cwd: session.cwd }) }));
    const slash = (app.catalog?.commands || []).map((command) => ({ kind: "slash", icon: "slash", title: `/${command.name}`, hint: command.description, keywords: `${command.name} ${command.description}`, run: () => ctx.fillComposer(`/${command.name} `) }));
    const all = needle ? [...actions, ...sessions, ...slash] : [...actions, ...sessions.slice(0, 8)];
    items = all.filter((item) => !needle || item.keywords.toLowerCase().includes(needle)).slice(0, 60);
    index = 0;
    list.replaceChildren(
      ...items.map((item, i) =>
        h(`button.pal-row${i === 0 ? ".active" : ""}`, { type: "button", onclick: () => choose(i), onmousemove: () => setActive(i) }, icon(item.icon, 15), h("span.pal-title", { dir: "auto" }, item.title), item.hint ? h("span.pal-hint", { dir: "auto" }, item.hint) : null),
      ),
    );
    if (!items.length) list.append(h("div.empty", h("p", t("Nothing matches."))));
  };

  const setActive = (i) => {
    list.children[index]?.classList.remove("active");
    index = i;
    list.children[index]?.classList.add("active");
    list.children[index]?.scrollIntoView({ block: "nearest" });
  };

  const choose = (i) => {
    const item = items[i];
    if (!item) return;
    dialog.close();
    setTimeout(() => item.run(), 0);
  };

  input.addEventListener("input", debounce(() => build(input.value), 50));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(Math.min(items.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(0, index - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(index); }
  });
  dialog = modal({ body: h("div.palette", input, list), width: 620, className: "palette-modal" });
  build("");
  return dialog;
}
