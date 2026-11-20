// Pure helpers for the Preview pane (no DOM, no Node APIs): the URL allow-list shared by the browser and the
// server tests. Only loopback http origins may be framed, and never Wheelhouse's own port.

export const PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Hosts whose framed pages may keep their own origin (cookies, storage): a DIFFERENT port is a different origin.
export const SAME_ORIGIN_SANDBOX_HOSTS = new Set(["localhost", "127.0.0.1"]);

export const SANDBOX_APP = "allow-scripts allow-forms allow-same-origin allow-popups allow-modals";
export const SANDBOX_FILE = "allow-scripts allow-forms allow-popups allow-modals"; // never allow-same-origin
export const SANDBOX_FILE_NO_SCRIPTS = "allow-forms allow-popups allow-modals";

/**
 * Validate what the user typed. Returns `{ ok: true, url, host, port, origin }` with a normalised href, or
 * `{ ok: false, reason }` (reason is a stable code: empty | invalid | scheme | credentials | host | port | own-port).
 * "3000", ":3000" and "localhost:3000" are accepted as shorthand for http://localhost:3000.
 */
export function checkPreviewUrl(input, ownPort) {
  let text = String(input ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > 2000) return { ok: false, reason: "invalid" };
  if (/^:?\d{1,5}(?:[/?#].*)?$/.test(text)) text = `http://localhost${text.startsWith(":") ? "" : ":"}${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // "localhost:3000/x" parses as a URL with scheme "localhost:", so only a bare host[:port] gets "http://" added.
    if (/^[^/?#:@\\\s]+(?::\d+)?(?:[/?#].*)?$/.test(text) || /^\[[^\]]*\](?::\d+)?(?:[/?#].*)?$/.test(text)) text = `http://${text}`;
    else return { ok: false, reason: /^[a-z][a-z0-9+.-]*:/i.test(text) ? "scheme" : "invalid" };
  }
  let url;
  try { url = new URL(text); } catch { return { ok: false, reason: "invalid" }; }
  if (url.protocol !== "http:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (!PREVIEW_HOSTS.has(url.hostname)) return { ok: false, reason: "host" };
  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "port" };
  if (ownPort !== undefined && ownPort !== null && port === Number(ownPort)) return { ok: false, reason: "own-port" };
  return { ok: true, url: url.href, host: url.hostname, port, origin: url.origin };
}

/** iframe sandbox for a checked URL result: same-origin only for localhost / 127.0.0.1 (never the app's own port). */
export function sandboxForUrl(checked) {
  return checked?.ok && SAME_ORIGIN_SANDBOX_HOSTS.has(checked.host) ? SANDBOX_APP : SANDBOX_FILE;
}

/** Looks like a project file (html / pdf) rather than a URL? */
export const isPreviewFile = (text) => /\.(?:html?|pdf)$/i.test(String(text).trim().split(/[?#]/)[0]) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(String(text).trim());

/**
 * What actually goes into the iframe. The page CSP cannot name IPv6 literals (Chrome rejects `http://[::1]:*` as a
 * frame-src source), so [::1] is framed as localhost (the browser tries ::1 as well as 127.0.0.1 for that name).
 * Always re-validate the result before using it.
 */
export function frameHref(checked) {
  if (!checked?.ok) return "";
  if (checked.host !== "[::1]") return checked.url;
  const url = new URL(checked.url);
  url.hostname = "localhost";
  return url.href;
}
