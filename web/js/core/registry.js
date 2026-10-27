// Extension points. Feature modules register themselves here; main.js renders them.
//
//   registerSettingsSection({ id, title, icon, order, render(container, ctx) })
//   registerInspectorTab({ id, title, icon, order, render(container, ctx), badge?(ctx) })
//   registerCommand({ id, title, icon, keywords, shortcut, run(ctx), when?(ctx) })
//   registerToolRenderer(match, { summary(tool), body(tool, ctx), icon })  // match: string | RegExp | string[]
//
// ctx (see main.js makeCtx): { app, bus, api, cwd, sessionId, live, conv, toast, openSettings, openInspector }

export const settingsSections = [];
export const inspectorTabs = [];
export const commands = [];
const toolRenderers = [];

const byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100);

export function registerSettingsSection(section) {
  settingsSections.push(section);
  settingsSections.sort(byOrder);
}

export function registerInspectorTab(tab) {
  inspectorTabs.push(tab);
  inspectorTabs.sort(byOrder);
}

export function registerCommand(command) {
  commands.push(command);
}

export function registerToolRenderer(match, renderer) {
  toolRenderers.push({ match, renderer });
}

export function findToolRenderer(name) {
  for (const { match, renderer } of toolRenderers) {
    if (typeof match === "string" && match === name) return renderer;
    if (Array.isArray(match) && match.includes(name)) return renderer;
    if (match instanceof RegExp && match.test(name)) return renderer;
  }
  return null;
}
