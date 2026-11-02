// QA: in the standalone window (page opened with ?app=1) clicking an external link must be handed to the server
// (POST /api/open-external) and must NOT navigate or open a window of the page itself; in a normal tab it must be left
// to the browser. Start the server with WHEELHOUSE_NO_OPEN=1 so no real browser is launched.
//   node scripts/browse.mjs --url "http://127.0.0.1:4199/?app=1" --script scripts/qa/e2e-external-links.mjs
export default async function (page, tools) {
  await tools.sleep(1500);
  const calls = [];
  page.on("request", (request) => { if (request.url().includes("/api/open-external")) calls.push(JSON.parse(request.postData() || "{}").url); });
  const before = (await page.browser().pages()).length;
  const result = await page.evaluate(() => {
    const make = (href, target = "_blank") => {
      const a = document.createElement("a");
      a.href = href; a.target = target; a.textContent = href; a.id = `t-${Math.random().toString(36).slice(2)}`;
      document.body.append(a);
      return a;
    };
    const out = {};
    const prevented = (a) => { let p = false; a.addEventListener("click", (e) => { p = e.defaultPrevented; e.preventDefault(); }); a.click(); return p; };
    // our handler runs first (capture phase); a bubbling listener afterwards sees whether it already prevented the default
    out.external = prevented(make("https://example.com/path?x=1&y=2"));
    out.mailto = prevented(make("mailto:someone@example.com"));
    out.sameOrigin = prevented(make(location.origin + "/#/s/abc", "_self"));
    return out;
  });
  await tools.sleep(800);
  const after = (await page.browser().pages()).length;
  return { standaloneMode: new URL(page.url()).searchParams.has("app"), ...result, serverCalls: calls, newPages: after - before };
}
