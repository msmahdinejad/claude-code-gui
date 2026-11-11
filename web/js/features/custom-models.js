// Remembers models that answered you but are not in Claude Code's list (picked with "Custom model…", or a newer model
// than the CLI shows for your plan), so the model picker lists them next time. See rememberModel() in ui/pickers.js.
import { app, bus } from "../core/state.js";
import { rememberModel } from "../ui/pickers.js";
import { isModelId } from "../chat/model-names.js";

const checked = new Map(); // conversation id -> index of the first item not looked at yet

function learn(id) {
  const conv = app.convs.get(id);
  if (!conv || !app.catalog?.models?.length) return; // without the CLI's list everything would look new
  let next = checked.get(id) || 0;
  if (next > conv.items.length) next = 0; // the conversation was reloaded
  for (let i = next; i < conv.items.length; i += 1) {
    const item = conv.items[i];
    if (item.kind !== "assistant") { next = i + 1; continue; }
    if (item.streaming) break; // look again when it is complete
    if (!item.error && item.model !== "<synthetic>" && isModelId(item.model)) rememberModel(item.model);
    next = i + 1;
  }
  checked.set(id, next);
}

bus.on("conv:update", learn);
bus.on("current", () => app.currentId && learn(app.currentId));
bus.on("catalog", () => { if (app.currentId && !app.catalogLoading) learn(app.currentId); });
