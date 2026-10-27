// Generates the README screenshots from a synthetic conversation (no model call, no personal data).
// env: SHOTS_DIR (output), DEMO_CWD (a small git repo with uncommitted changes), SHOT_SET = chat | rtl | settings | changes
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installFixture } from "./fixture-lib.mjs";

const SESSIONS = [
  { id: "s1", title: "Fix unicode slugify", cwd: "/home/me/demo-app", lastModified: Date.now() - 120_000, state: "idle", pending: 1 },
  { id: "s2", title: "Add dark mode toggle", cwd: "/home/me/demo-app", lastModified: Date.now() - 3_600_000, state: "idle" },
  { id: "s3", title: "Explain the build pipeline", cwd: "/home/me/demo-app", lastModified: Date.now() - 86_400_000, state: "idle" },
  { id: "s4", title: "تبدیل README به فارسی", cwd: "/home/me/notes", lastModified: Date.now() - 172_800_000, state: "idle" },
];

export default async function (page, tools) {
  const dir = process.env.SHOTS_DIR || ".";
  const set = process.env.SHOT_SET || "chat";
  mkdirSync(dir, { recursive: true });
  await installFixture(page, { cwd: process.env.DEMO_CWD || "", sessions: SESSIONS });
  await tools.sleep(900);
  if (set === "chat" || set === "rtl") {
    await page.screenshot({ path: join(dir, set === "chat" ? "chat-dark.png" : "chat-rtl-light.png") });
  }
  if (set === "settings") {
    await page.evaluate(() => document.querySelector(".sb-foot .icon-btn")?.click());
    await tools.sleep(600);
    await page.evaluate(() => [...document.querySelectorAll(".settings-nav button")].find((b) => /Model & behavior|مدل و رفتار/.test(b.textContent))?.click());
    await tools.sleep(900);
    await page.screenshot({ path: join(dir, "settings.png") });
  }
  if (set === "changes") {
    await page.evaluate(async () => {
      const { setPrefs } = await import("/js/core/state.js");
      const { openInspector } = await import("/js/ui/inspector.js");
      setPrefs({ inspectorTab: "changes" });
      openInspector("changes");
    });
    await tools.sleep(1800);
    await page.evaluate(() => [...document.querySelectorAll(".insp-body button, .insp-body [role=button], .insp-body .ws-file")].find((el) => /\.js|\.py|\.md/.test(el.textContent))?.click());
    await tools.sleep(1200);
    await page.screenshot({ path: join(dir, "changes.png") });
  }
  return "ok";
}
