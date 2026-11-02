// Opening the UI: in the default browser, or in a standalone app-style window (Chrome/Edge --app mode).
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

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

/**
 * Open a link in the user's normal browser: a new tab in the browser window they already use, not a new window of
 * the standalone app's private profile. Only http(s) links; the URL is passed as one argument, never through a shell.
 * `linkBrowser: "chrome"` uses Chrome specifically (its default profile), otherwise the system default browser.
 */
export function openExternal(rawUrl, { linkBrowser = "default" } = {}) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http and https links can be opened");
  const href = parsed.href;
  if (process.env.WHEELHOUSE_NO_OPEN) return; // tests: validate, but do not launch a browser
  const chrome = linkBrowser === "chrome" ? findBrowser() : "";
  const [cmd, args] = chrome && /chrome/i.test(chrome)
    ? [chrome, [href]]
    : process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", href]]
      : process.platform === "darwin" ? ["open", [href]] : ["xdg-open", [href]];
  const child = execFile(cmd, args, () => {});
  child.on("error", () => {});
  child.unref?.();
}

/**
 * `appWindow` = standalone window with its own browser profile in `profileDir`; otherwise the default browser.
 * On Windows an already open app window is brought to the front instead of opening a second one.
 */
export function openUi(url, { appWindow = false, profileDir = "", assets = null } = {}) {
  const win = process.platform === "win32";
  const defaultOpen = () => openExternal(url);
  if (!appWindow) return defaultOpen();
  const bin = findBrowser(); // a bare name that is not installed fails through "error" below
  if (!bin) return defaultOpen();
  // "?app=1" tells the page it runs in the standalone window (links then open in your normal browser instead).
  const appUrl = `${url.replace(/\/$/, "")}/?app=1`;
  const direct = () => {
    const child = execFile(bin, [`--app=${appUrl}`, `--user-data-dir=${profileDir}`, "--window-size=1320,860"], { windowsHide: false });
    child.on("error", defaultOpen);
    child.unref();
  };
  if (!win) return direct();
  const script = join(HERE, "..", "tray", "open-app.ps1");
  const helper = execFile(
    "powershell.exe",
    [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Url", url, "-Browser", bin, "-ProfileDir", profileDir,
      ...(assets ? ["-IconFile", assets.iconFile, "-LaunchVbs", assets.launchVbs] : []),
    ],
    { windowsHide: true },
    (error) => { if (error) direct(); },
  );
  helper.on("error", direct);
}
