// File references in text: what Claude writes ("src/app.ts:42", "D:\proj\a.md", "[a.md](docs/a.md#L3)", file:// links)
// turned into { path, line, col }. Pure functions (no DOM), shared by the chat renderer and the tests.

const EXT = "[A-Za-z][A-Za-z0-9]{0,7}";
const SEG = "[\\w@.+~-]+";
/** ":42", ":42:7" or "#L42" / "#L42-L50" after a path. */
const SUFFIX = "(?::(\\d{1,7})(?::(\\d{1,5}))?|#L(\\d{1,7})(?:C(\\d{1,5}))?(?:-L?\\d{1,7})?)?";

// Candidates inside running text. Each needs a file extension, so prose such as "and/or" is left alone, and each is only
// turned into a link after the server confirmed that the file exists.
const WIN_ABS = `[A-Za-z]:[\\\\/](?:[^\\s<>"'\`|?*:\\\\/]+[\\\\/])*[^\\s<>"'\`|?*:\\\\/]+\\.${EXT}`;
const POSIX_ABS = `(?<![\\w:/.\\\\@~+-])/(?:${SEG}/)+${SEG}\\.${EXT}`;
const REL = `(?<![\\w@./\\\\:~+-])(?:\\.{1,2}/)*(?:${SEG}/)+${SEG}\\.${EXT}`;
const IN_TEXT = new RegExp(`(?:${WIN_ABS})${SUFFIX}|(?:${POSIX_ABS})${SUFFIX}|(?:${REL})${SUFFIX}`, "g");

const DOTFILE = /^\.[A-Za-z][\w.-]*$/;
const KNOWN_BARE = new Set(["Dockerfile", "Makefile", "LICENSE", "Procfile", "Gemfile", "Jenkinsfile", "Rakefile", "Vagrantfile", "CODEOWNERS"]);
const VERSION = /^v?\d+(?:\.\d+)+/;

const num = (value) => (value === undefined || value === "" ? undefined : Number(value));

/** Split "path:12:3" / "path#L12" into the path and its position. */
export function splitSuffix(text) {
  const value = String(text ?? "").trim();
  let m = /^(.*?[^:\\/]):(\d{1,7})(?::(\d{1,5}))?$/.exec(value);
  if (m && !/^[A-Za-z]$/.test(m[1])) return { path: m[1], line: num(m[2]), col: num(m[3]) };
  m = /^(.*?)#L(\d{1,7})(?:C(\d{1,5}))?(?:-L?\d{1,7})?$/.exec(value);
  if (m && m[1]) return { path: m[1], line: num(m[2]), col: num(m[3]) };
  return { path: value };
}

/** A `file:` URL as a plain path ("file:///D:/a/b.md" -> "D:/a/b.md", "file:///home/x" -> "/home/x"). */
export function fileUrlToPath(href) {
  if (!/^file:/i.test(href)) return null;
  let rest = href.replace(/^file:\/\//i, "");
  if (/^localhost\//i.test(rest)) rest = rest.slice("localhost".length);
  try { rest = decodeURIComponent(rest); } catch { /* keep as is */ }
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1);
  return rest || null;
}

/**
 * The reference a link target or an inline `code` text stands for, or null when it is not a file path.
 * `bare` allows a lone file name ("package.json") - fine for `code`, too noisy for running text.
 */
export function parsePathRef(text, { bare = false } = {}) {
  let value = String(text ?? "").trim();
  if (!value || value.length > 600 || /[\0\n\r<>|"*?]/.test(value)) return null;
  value = value.replace(/^[`'"([]+|[`'")\].,;]+$/g, "");
  const fromUrl = fileUrlToPath(value);
  if (fromUrl) value = fromUrl;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(mailto|tel|data|javascript):/i.test(value)) return null;
  const { path, line, col } = splitSuffix(value);
  if (!path || path === "." || path === "..") return null;
  const last = baseNameOf(path);
  const named = new RegExp(`\\.${EXT}$`).test(last) || KNOWN_BARE.has(last) || DOTFILE.test(last);
  if (!named || VERSION.test(last)) return null;
  if (!/[\\/]/.test(path) && !bare) return null;
  return { path, ...(line ? { line } : {}), ...(col ? { col } : {}) };
}

/** Is a markdown link target a file rather than a web address? ("src/a.ts:12", "./docs/x.md#L3", "D:\a.txt", "file:///..") */
export function isFileHref(href) {
  const value = String(href ?? "").trim();
  if (!value || value.startsWith("#")) return false;
  if (/^file:/i.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return false; // http:, mailto:, vscode: ...
  if (value.startsWith("//")) return false;
  const { path } = splitSuffix(value.replace(/[?#](?!L\d).*$/, ""));
  return /[\\/]/.test(path) || new RegExp(`\\.${EXT}$`).test(path);
}

/** The "path" part of a markdown link target, with a "#section" anchor dropped. */
export function hrefToRef(href) {
  const value = String(href ?? "").trim();
  const fromUrl = fileUrlToPath(value);
  const cleaned = (fromUrl ?? value).replace(/[?#](?!L\d).*$/, "");
  const { path, line, col } = splitSuffix(cleaned);
  return path ? { path, ...(line ? { line } : {}), ...(col ? { col } : {}) } : null;
}

/** Paths inside a piece of running text: [{ start, end, raw, path, line?, col? }] in order of appearance. */
export function findPathsInText(text) {
  const out = [];
  const source = String(text ?? "");
  if (source.length < 3 || source.length > 100_000) return out;
  for (const match of source.matchAll(IN_TEXT)) {
    const raw = match[0];
    const ref = parsePathRef(raw, { bare: false });
    if (!ref) continue;
    out.push({ start: match.index, end: match.index + raw.length, raw, ...ref });
  }
  return out;
}

export const baseNameOf = (path) => String(path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(path ?? "");
export const dirNameOf = (path) => {
  const value = String(path ?? "").replace(/\\/g, "/");
  const at = value.lastIndexOf("/");
  return at < 0 ? "" : value.slice(0, at + 1);
};

/** "foo.ts" or "foo.ts:42" - what a link shows instead of the whole path. */
export const linkLabel = ({ path, line }) => `${baseNameOf(path)}${line ? `:${line}` : ""}`;

/** "@src/a.ts" - a file mention for the message box (quoted when the path has spaces). */
export const mentionFor = (path) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/** Same path, "/" separators. */
export const slashed = (path) => String(path ?? "").replace(/\\/g, "/");

/** Extensions that may be handed to the operating system's default app ("Open in default app"). Programs and scripts are not here. */
export const SAFE_OPEN_EXT = new Set([
  "md", "markdown", "txt", "log", "pdf", "html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico",
  "json", "jsonl", "csv", "tsv", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "mmd", "diff", "patch",
  "mp3", "wav", "ogg", "mp4", "webm", "mov",
]);
