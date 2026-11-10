// Keeps Claude Code up to date while nothing is running (see ../claude-updater.mjs).
import { ClaudeUpdater } from "../claude-updater.mjs";

export default function register({ route, config, manager, catalog, store }) {
  const updater = new ClaudeUpdater({
    config,
    manager,
    catalog,
    enabled: () => store.data.prefs.autoUpdateClaude !== false,
    channel: () => (store.data.prefs.updateChannel === "stable" ? "stable" : "latest"),
  });
  updater.start();
  // The first look at the installed version, so Settings has something to show before the first scheduled check.
  updater.check().catch(() => {});

  route("GET", "/api/update", async () => updater.status());
  // Look at the registry now (and, when there is something newer, download it and install it once nothing is working).
  route("POST", "/api/update/check", async () => {
    await updater.check();
    if (updater.isEnabled()) updater.tick().catch(() => {});
    return updater.status();
  });
  // "Update now": the same, even with the automatic switch off.
  route("POST", "/api/update/apply", async () => {
    updater.tick({ force: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    return updater.status();
  });
}
