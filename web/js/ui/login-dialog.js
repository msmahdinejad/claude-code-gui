// "Sign in" dialog: runs the CLI's `auth login` for a connection profile on the server and relays the sign-in link and
// the code from the web page, so an expired OAuth session can be renewed without a terminal.
import { h, modal, toast, errorMessage, spinner } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { api } from "../core/api.js";

const POLL_MS = 1200;
let open = null; // one dialog at a time

/** Error text of a failed turn / a notice that means "you have to sign in again". */
export function isAuthProblem(text) {
  return /\/login\b|oauth session|failed to authenticate|authentication failed|not logged in|login expired|invalid api key|please run .*login/i.test(String(text || ""));
}

export function openLoginDialog(profile = app.config?.profile) {
  if (open) return open;
  let flow = null;
  let timer = null;
  let closed = false;
  const body = h("div.login-body");
  const dialog = modal({
    title: t("Sign in"),
    body,
    width: 520,
    onClose: () => {
      closed = true;
      clearTimeout(timer);
      open = null;
      if (flow?.state === "starting" || flow?.state === "waiting") api.post(`/api/auth/login/${flow.id}/cancel`).catch(() => {});
    },
  });
  open = dialog;

  const codeInput = h("input.input", { type: "text", autocomplete: "off", spellcheck: false, dir: "ltr", placeholder: t("Paste the code here") });
  const submitCode = async () => {
    const code = codeInput.value.trim();
    if (!code || !flow) return;
    codeInput.disabled = true;
    try {
      await api.post(`/api/auth/login/${flow.id}/code`, { code });
      codeInput.value = "";
    } catch (error) {
      toast(errorMessage(error), "error");
    }
    codeInput.disabled = false;
    poll(0);
  };
  codeInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submitCode(); } });

  function draw() {
    const state = flow?.state || "starting";
    const nodes = [];
    if (state === "starting") {
      nodes.push(h("p.muted", spinner(14), " ", t("Starting the sign-in…")));
    } else if (state === "waiting") {
      nodes.push(
        h("p", t("Finish signing in on the page that opened in your browser.")),
        h("p.muted", t("If a code is shown after you sign in, paste it here. Otherwise this window closes by itself once you are signed in.")),
        h("div.row-inline", codeInput, h("button.btn.primary", { type: "button", onclick: submitCode }, t("Continue"))),
        flow.note ? h("div.banner.warn", icon("alert", 14), h("span", { dir: "auto" }, flow.note)) : null, // e.g. the CLI says the code was wrong
        flow.url ? h("p", h("button.btn.small", { type: "button", onclick: () => api.post("/api/open-external", { url: flow.url }).catch((error) => toast(errorMessage(error), "error")) }, icon("external", 13), t("Open the sign-in page again"))) : null,
      );
    } else if (state === "done") {
      nodes.push(h("div.banner.info", icon("check-circle", 14), h("span", t("Signed in. Send your message again; if it still fails, start a new session."))));
    } else {
      nodes.push(
        h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, flow?.error || t("The sign-in did not finish."))),
        h("p", h("button.btn.primary", { type: "button", onclick: start }, t("Try again"))),
      );
    }
    body.replaceChildren(...nodes);
  }

  function poll(delay = POLL_MS) {
    clearTimeout(timer);
    if (closed || !flow?.id) return;
    timer = setTimeout(async () => {
      try {
        flow = await api.get(`/api/auth/login/${flow.id}`);
      } catch (error) {
        flow = { ...flow, state: "failed", error: errorMessage(error) };
      }
      if (closed) return;
      draw();
      if (flow.state === "done") return finished();
      if (flow.state === "starting" || flow.state === "waiting") poll();
    }, delay);
  }

  async function finished() {
    api.get("/api/profile/status", { force: 1 }).catch(() => {});
    bus.emit("auth:changed", flow.profile);
    toast(t("Signed in"), "ok");
    setTimeout(() => dialog.close(), 2200);
  }

  async function start() {
    flow = null;
    draw();
    try {
      flow = await api.post("/api/auth/login", { name: profile });
    } catch (error) {
      flow = { state: "failed", error: errorMessage(error) };
    }
    draw();
    poll(400);
  }

  start();
  return dialog;
}
