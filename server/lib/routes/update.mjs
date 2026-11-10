// Keeps Claude Code up to date (see ../claude-updater.mjs).
import { ClaudeUpdater } from "../claude-updater.mjs";
import { resolveCommand } from "../config.mjs";

export default function register({ route, config, manager, catalog, store }) {
  const updater = new ClaudeUpdater({
    config,
    manager,
    catalog,
    // The active profile's own executable, whatever Wheelhouse currently runs.
    profileBin: () => resolveCommand(config.profiles[config.activeProfile]?.command, process.env).path || null,
    enabled: () => store.data.prefs.autoUpdateClaude !== false,
    channel: () => (store.data.prefs.updateChannel === "stable" ? "stable" : "latest"),
  });
  // A copy installed earlier is used straight away; then look at the registry.
  updater.useInstalled().catch(() => {}).finally(() => updater.start());

  route("GET", "/api/update", async () => updater.status());
  // Look at the registry now (and install a newer version when there is one).
  route("POST", "/api/update/check", async () => {
    const status = await updater.check();
    if (updater.isEnabled() && status.updateAvailable) updater.tick().catch(() => {});
    return updater.status();
  });
  // "Update now": the same, even with the automatic switch off.
  route("POST", "/api/update/apply", async () => {
    updater.tick({ force: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    return updater.status();
  });
}
