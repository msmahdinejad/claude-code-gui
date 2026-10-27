// System tray icon with open / quit menu and global shortcuts. Windows only for now: the tray itself is a small
// PowerShell host (server/tray/tray.ps1) so no native dependency is needed.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./ui-launch.mjs";
import { windowAssets } from "./launchers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Start the tray host. It outlives this process on purpose and cleans up after it (see tray.ps1). */
export function startTray({ config, url, serverPid = process.pid }) {
  if (process.platform !== "win32") {
    console.log("  tray:        not available on this platform yet (Windows only)");
    return;
  }
  mkdirSync(config.dataDir, { recursive: true });
  const assets = windowAssets(config);
  const q = (value) => `"${String(value).replaceAll('"', "")}"`;
  const args = [
    "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
    "-File", q(join(HERE, "..", "tray", "tray.ps1")),
    "-Url", q(url),
    "-ServerPid", String(serverPid),
    "-Browser", q(findBrowser()),
    "-ProfileDir", q(join(config.dataDir, "app-profile")),
    "-IconPath", q(resolve(HERE, "..", "tray", "icon.png")),
    "-IconFile", q(assets.iconFile),
    "-LaunchVbs", q(assets.launchVbs),
    "-Hotkey", q(config.tray.hotkey),
    "-BrowserHotkey", q(config.tray.browserHotkey),
    "-AutostartVbs", q(assets.autostartVbs),
    "-LogPath", q(join(config.dataDir, "tray.log")),
  ];
  if (process.env.WHEELHOUSE_TRAY_SELFTEST) args.push("-SelfTest");
  // `start /B` through cmd: a direct child of a non-detached spawn dies with the server (libuv job object), which
  // would leave a ghost icon. Started this way the tray survives, notices the server is gone and removes itself.
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `"start "" /B powershell.exe ${args.join(" ")}"`], {
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: "ignore",
  });
  child.on("error", (error) => console.error(`[wheelhouse] tray failed to start: ${error.message}`));
  child.unref();
}
