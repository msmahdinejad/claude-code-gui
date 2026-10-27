// Hidden launcher scripts for Windows (wscript runs node without a console window):
//   launch.vbs     starts this server (and opens the app window) - used by a taskbar button pinned from the app window
//   autostart.vbs  starts this server with the tray icon at sign-in - used by "Start with Windows"
// Both re-run exactly this server: same node, same flags, same working directory.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Files the Windows app window / tray need: icon, launcher scripts. */
export function windowAssets(config) {
  const q = (value) => `""${String(value).replaceAll('"', '""')}""`;
  const base = process.argv.slice(1).filter((arg) => arg !== "--open" && arg !== "--app" && arg !== "--tray");
  const write = (name, extra) => {
    mkdirSync(config.dataDir, { recursive: true });
    const path = join(config.dataDir, name);
    const command = [process.execPath, ...base, ...extra].map(q).join(" ");
    writeFileSync(path, `Set shell = CreateObject("WScript.Shell")\r\nshell.CurrentDirectory = "${process.cwd().replaceAll('"', '""')}"\r\nshell.Run "${command}", 0, False\r\n`);
    return path;
  };
  const launchVbs = write("launch.vbs", config.tray.enabled ? ["--tray", "--app"] : ["--app"]);
  const autostartVbs = write("autostart.vbs", ["--tray"]);
  // Shortcuts and the taskbar point at a copy in the data folder: stable even if the project folder moves, and the
  // Windows shell does not draw icons from some protected folders (e.g. sandboxed project directories).
  const iconFile = join(config.dataDir, "wheelhouse.ico");
  try {
    const source = resolve(HERE, "..", "..", "web", "wheelhouse.ico");
    if (!existsSync(iconFile) || statSync(iconFile).size !== statSync(source).size) copyFileSync(source, iconFile);
  } catch { /* keep going without the icon */ }
  return { iconFile, launchVbs, autostartVbs };
}
