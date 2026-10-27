// End-to-end checks of core flows with a real model (haiku, tiny prompts).
// node scripts/browse.mjs --url http://127.0.0.1:4174 --script scripts/qa/e2e-core.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok), extra });
  console.error(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

import { deflateSync } from "node:zlib";
function solidPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export default async function (page, tools) {
  const waitFor = async (fn, timeout = 90_000, arg) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await page.evaluate(fn, arg)) return true;
      await tools.sleep(400);
    }
    return false;
  };
  const state = () => page.evaluate(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return { id: app.currentId, state: conv?.state, items: conv?.items.map((item) => item.kind), requests: conv?.requests.size };
  });
  const lastAssistantText = () => page.evaluate(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return conv.items.filter((item) => item.kind === "assistant").flatMap((item) => item.blocks.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
  });
  const idle = () => waitFor(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return conv && conv.state === "idle" && conv.items.some((item) => item.kind === "result");
  });

  // new session + choose Haiku through the picker UI
  // work inside this repository so @-mentions have real files to find
  await page.evaluate(async (cwd) => (await import("/js/session.js")).newSession({ cwd }), process.cwd());
  await tools.sleep(800);
  await page.evaluate(() => document.querySelectorAll(".cmp-chip-btn")[1].click());
  await tools.sleep(400);
  await page.evaluate(() => [...document.querySelectorAll(".popover .picker-item")].find((b) => /Haiku/.test(b.textContent)).click());
  await tools.sleep(600);
  const chip = await page.evaluate(() => document.querySelectorAll(".cmp-chip-btn")[1].innerText);
  check("model picker selects Haiku", /Haiku/.test(chip), chip);

  // permission mode via picker: acceptEdits then back
  await page.evaluate(() => document.querySelectorAll(".cmp-chip-btn")[0].click());
  await tools.sleep(300);
  await page.evaluate(() => [...document.querySelectorAll(".popover .picker-item")][1].click());
  await tools.sleep(500);
  const modeChip = await page.evaluate(() => document.querySelectorAll(".cmp-chip-btn")[0].className);
  check("mode picker selects acceptEdits", /mode-acceptEdits/.test(modeChip), modeChip);

  // send a persian prompt
  await page.focus(".cmp-input");
  await page.keyboard.type("فقط یک کلمه بنویس: پایتخت ایران؟");
  await page.keyboard.press("Enter");
  check("reply arrives", await idle());
  const reply = await lastAssistantText();
  check("reply is a non-empty Persian/English answer", reply.trim().length > 0, reply.slice(0, 60));
  const live = await page.evaluate(async () => (await import("/js/core/state.js")).app.live.get((await import("/js/core/state.js")).app.currentId));
  check("live session reports haiku", /haiku/i.test(live?.init?.model || ""), live?.init?.model);

  // title shows in sidebar
  await tools.sleep(1800);
  const sidebarTitle = await page.evaluate(() => document.querySelector(".sb-item.active .sb-title")?.textContent);
  check("sidebar lists the session with a title", Boolean(sidebarTitle), sidebarTitle);

  // image attach through the hidden file input + send
  writeFileSync(join(tmpdir(), "red.png"), solidPng(96, 96, [220, 20, 20]));
  const input = await page.$('input[type="file"]');
  await input.uploadFile(join(tmpdir(), "red.png"));
  await tools.sleep(600);
  check("image attachment chip appears", (await page.$$(".cmp-attach")).length === 1);
  await page.focus(".cmp-input");
  await page.keyboard.type("What single color is this image? One word.");
  await page.keyboard.press("Enter");
  check("image turn completes", await waitFor(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return conv.state === "idle" && conv.items.filter((item) => item.kind === "result").length >= 2;
  }));
  check("image bubble rendered", (await page.$$(".msg-user .thumb")).length === 1);
  const colorReply = await lastAssistantText();
  check("model saw the red image", /red/i.test(colorReply), colorReply.slice(-80));

  // @ mention popup
  await page.focus(".cmp-input");
  await page.keyboard.type("look at @pack");
  await tools.sleep(900);
  const mentions = await page.evaluate(() => [...document.querySelectorAll(".ac-item .ac-name")].map((el) => el.textContent));
  check("@ popup lists package.json", mentions.includes("package.json"), mentions.join(","));
  await page.keyboard.press("Enter");
  await tools.sleep(300);
  const text = await page.evaluate(() => document.querySelector(".cmp-input").value);
  check("@ mention inserted", /@package\.json\s$/.test(text), text);
  await page.evaluate(() => { const el = document.querySelector(".cmp-input"); el.value = ""; el.dispatchEvent(new Event("input")); });

  // (queue + interrupt are covered by e2e-queue.mjs)

  // rename + pin + delete via sidebar menu
  await page.evaluate(() => document.querySelector(".sb-item.active .sb-more").click());
  await tools.sleep(300);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll(".menu-item")].map((el) => el.textContent.trim()));
  check("sidebar menu has rename/pin/archive/fork/delete", menuItems.length >= 6, menuItems.join("|"));
  await page.keyboard.press("Escape");

  const final = await state();
  console.error("final", JSON.stringify(final));
  return results;
}
