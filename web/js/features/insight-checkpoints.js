// Checkpoints tab: every user message is a restore point (rewind files / fork / copy).
import { h, copyText, formatTime, spinner, ibtn, btn, errorMessage, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerInspectorTab } from "../core/registry.js";
import { userItems } from "../chat/reducer.js";
import { liveControl } from "./insight-shared.js";
import { exportMarkdown, exportJson, copyMarkdown } from "./insight-export.js";

const previews = new Map(); // `${sessionId}:${uuid}` -> result | {error}

async function preview(item) {
  const key = `${app.currentId}:${item.uuid}`;
  try {
    const result = await liveControl("rewind", { userMessageId: item.uuid, dryRun: true });
    previews.set(key, result);
  } catch (error) {
    previews.set(key, { canRewind: false, error: errorMessage(error) });
  }
  return previews.get(key);
}

function previewView(result) {
  if (!result) return null;
  if (!result.canRewind) return h("div.muted.small", icon("info", 12), ` ${result.error || t("No file changes are tracked for this point.")}`);
  const files = result.filesChanged || [];
  return h(
    "div.cp-files",
    h("div.small", files.length ? t("{n} file(s) would change", { n: files.length }) : t("No files would change"), result.insertions || result.deletions ? h("span.muted", ` · +${result.insertions || 0} −${result.deletions || 0}`) : null),
    files.length ? h("div.chip-row", files.slice(0, 30).map((file) => h("button.file-chip", { type: "button", title: file, onclick: () => bus.emit("open-file", { path: file }) }, icon("file", 12), h("span", baseName(file))))) : null,
  );
}

registerInspectorTab({
  id: "checkpoints",
  title: "Checkpoints",
  icon: "undo",
  order: 24,
  render(container, ctx) {
    let alive = true;

    function paint() {
      if (!alive) return;
      const conv = app.convs.get(app.currentId);
      const items = conv ? userItems(conv) : [];
      const toolbar = h("div.row-inline", btn(t("Markdown"), exportMarkdown, { iconName: "download", variant: "small" }), btn("JSON", exportJson, { iconName: "download", variant: "small" }), btn(t("Copy as Markdown"), copyMarkdown, { iconName: "copy", variant: "small" }));
      container.replaceChildren(
        h(
          "div.panel.checkpoints",
          h("div.panel-head", h("h3", t("Checkpoints")), ibtn("refresh", t("Refresh"), paint, { size: 14 })),
          h("div.muted.small", t("Each of your messages is a restore point. Rewinding restores files Claude edited since that message; the conversation is kept.")),
          h("div.panel-section", h("h4", t("Export")), toolbar),
          items.length
            ? h("ol.cp-list", items.map((item, index) => checkpoint(item, index, ctx)))
            : h("div.empty", icon("undo", 24), h("p", t("No messages yet."))),
        ),
      );
    }

    function checkpoint(item, index, ctx) {
      const key = `${app.currentId}:${item.uuid}`;
      const holder = h("div.cp-preview", previewView(previews.get(key)));
      const previewBtn = btn(t("Preview changes"), async () => {
        holder.replaceChildren(spinner(14));
        holder.replaceChildren(previewView(await preview(item)));
      }, { variant: "small", iconName: "eye" });
      return h(
        "li.cp-item",
        h("div.row-inline", h("span.badge", `#${index + 1}`), h("span.muted.small", item.at ? formatTime(item.at) : ""), h("span.grow")),
        h("div.cp-text", { dir: "auto" }, item.command ? `${item.command.name} ${item.command.args || ""}` : (item.text || t("(image)")).slice(0, 220)),
        h("div.row-inline", previewBtn, btn(t("Rewind files"), () => ctx.session.rewindTo(item.uuid), { variant: "small", iconName: "undo" }), btn(t("Fork"), () => ctx.session.forkFrom(app.currentId, item.uuid), { variant: "small", iconName: "split" }), ibtn("copy", t("Copy"), () => copyText(item.text || ""), { size: 14 })),
        holder,
      );
    }

    const offs = [bus.on("conv:update", (id) => id === app.currentId && paint()), bus.on("current", paint)];
    paint();
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  },
});
