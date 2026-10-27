// Short, readable session title from the first prompt (no model call): first line or sentence, markup and links
// removed, cut at a word boundary. Used only when the session has no custom/auto title of its own.
const MAX = 48;
const GREETING = /^(?:hi|hello|hey|salam|slm|سلام|درود|وقت بخیر|روز بخیر|عصر بخیر)[\s,،.!:\-–—]+/iu;
const POLITE = /^(?:please|pls|لطفا|لطفاً|خواهش میکنم|ممنون میشم|بیزحمت|بی‌زحمت)[\s,،:]+/iu;

export function deriveTitle(prompt, max = MAX) {
  let text = String(prompt ?? "");
  text = text.replace(/```[\s\S]*?(?:```|$)/g, " "); // code blocks
  text = text.replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/gi, " "); // <system-reminder>-style blocks
  const withoutLinks = text.replace(/\bhttps?:\/\/\S+/gi, " ");
  if (withoutLinks.trim()) text = withoutLinks;
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^[\s>#*\-+•\d.)]+/u, "").replace(/[`*_~]+/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  let line = lines[0] || "";
  for (let i = 0; i < 2; i += 1) {
    const stripped = line.replace(GREETING, "").replace(POLITE, "").trim();
    if (stripped) line = stripped;
  }
  if (!line) return "";
  // First sentence, if it fits.
  const sentence = line.match(/^(.{8,}?[.!?؟۔])(?:\s|$)/u);
  if (sentence && sentence[1].length <= max + 8) line = sentence[1].replace(/[.!۔]+$/u, ""); // keep a question mark
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const base = space > max * 0.55 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,،:;.\-–—]+$/u, "")}…`;
}
