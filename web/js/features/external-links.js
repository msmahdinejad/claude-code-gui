// Links in the conversation. In the standalone window (opened with "?app=1") a clicked link would open in the window's
// own private browser profile, i.e. "a new Chrome". Send it to the server instead, which opens it in the browser the
// user already works in. In a normal browser tab the browser handles links itself.
import { api } from "../core/api.js";
import { toast, errorMessage } from "../core/dom.js";

const inAppWindow = new URLSearchParams(location.search).has("app");

if (inAppWindow) {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button > 1) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link) return;
      let url;
      try { url = new URL(link.href, location.href); } catch { return; }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (url.origin === location.origin) return; // our own pages stay in the window
      event.preventDefault();
      api.post("/api/open-external", { url: url.href }).catch((error) => toast(errorMessage(error), "error"));
    },
    true,
  );
}
