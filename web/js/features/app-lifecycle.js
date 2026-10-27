// Command palette: quit the whole app (stops the server and every running session).
import { h, confirmDialog, toast, errorMessage } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";
import { registerCommand } from "../core/registry.js";

async function quit() {
  const running = [...app.live.values()].filter((live) => ["running", "requires_action"].includes(live?.state)).length;
  const ok = await confirmDialog({
    title: t("Quit Wheelhouse"),
    message: running
      ? t("This stops the server and {n} running session(s). Conversations are kept and can be resumed later.", { n: running })
      : t("This stops the server and closes this window. Conversations are kept and can be resumed later."),
    confirmLabel: t("Quit"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.post("/api/shutdown");
  } catch (error) {
    toast(errorMessage(error), "error");
    return;
  }
  document.body.replaceChildren(h("main.stopped", { style: "display:grid;place-items:center;min-height:100vh;font:16px system-ui" }, h("p", { dir: "auto" }, t("Wheelhouse has stopped. You can close this window."))));
  window.close();
}

registerCommand({ id: "quit-app", title: "Quit Wheelhouse", icon: "power", keywords: ["exit", "stop", "close", "shutdown"], run: () => quit() });
