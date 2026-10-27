// Auto-mode tool use in a new-folder session (Sonnet, high effort by default).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: Boolean(ok), extra }); console.error(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

export default async function (page, tools) {
  await page.focus(".cmp-input");
  await page.keyboard.type("Create a file named hello.txt containing the Persian word سلام, then read it back and tell me exactly what it contains.");
  await page.keyboard.press("Enter");
  let approvals = 0;
  const start = Date.now();
  let done = false;
  while (Date.now() - start < 150_000 && !done) {
    await tools.sleep(700);
    const status = await page.evaluate(async () => {
      const { app } = await import("/js/core/state.js");
      const conv = app.convs.get(app.currentId);
      const pending = conv.requests.size;
      if (pending) document.querySelector(".request .btn.primary")?.click();
      return { pending, idle: conv.state === "idle" && conv.items.some((i) => i.kind === "result") };
    });
    if (status.pending) approvals += 1;
    done = status.idle;
  }
  check("turn finished", done);
  const info = await page.evaluate(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return { cwd: conv.cwd, tools: [...conv.tools.values()].map((t) => `${t.name}:${t.status}`), text: conv.items.filter((i) => i.kind === "assistant").flatMap((i) => i.blocks.filter((b) => b.type === "text").map((b) => b.text)).join(" ").slice(-160) };
  });
  console.error("approvals needed:", approvals, "tools:", info.tools.join(","));
  const file = join(info.cwd, "hello.txt");
  check("file exists in the new session folder", existsSync(file), file);
  check("file has the right content", existsSync(file) && /سلام/.test(readFileSync(file, "utf8")));
  check("reply mentions the content", /سلام/.test(info.text), info.text);
  return results;
}
