// Opening the UI: in the default browser, or in a standalone app-style window (Chrome/Edge --app mode).
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** First installed Chromium-based browser that can show an app-style window, or "" when none is found. */
export function findBrowser() {
  const win = process.platform === "win32";
  const candidates = win
    ? [
        join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];
  for (const bin of candidates) {
    try {
      if (isAbsolute(bin)) statSync(bin);
      return bin;
    } catch { /* try the next browser */ }
  }
  return "";
}

/** `appWindow` = standalone window with its own browser profile in `profileDir`; otherwise the default browser. */
export function openUi(url, { appWindow = false, profileDir = "" } = {}) {
  const win = process.platform === "win32";
  const defaultOpen = () => {
    const [cmd, args] = win ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    execFile(cmd, args, () => {}).on("error", () => {});
  };
  if (appWindow) {
    const bin = findBrowser(); // a bare name that is not installed fails through "error" below
    if (bin) {
      const child = execFile(bin, [`--app=${url}`, `--user-data-dir=${profileDir}`, "--window-size=1320,860"], { windowsHide: false });
      child.on("error", defaultOpen);
      child.unref();
      return;
    }
  }
  defaultOpen();
}
