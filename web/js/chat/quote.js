// Turns text into a Markdown block quote for replying to part of a conversation.
const MAX_CHARS = 1500;

export function toQuote(text, max = MAX_CHARS) {
  let body = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return "";
  if (body.length > max) body = `${body.slice(0, max).replace(/\s+\S*$/, "")} …`;
  return body.split("\n").map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}
