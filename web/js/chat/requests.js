// Interactive requests from Claude Code: permission prompts, AskUserQuestion, plan approval,
// MCP elicitations and generic dialogs. Rendered docked above the composer.
import { h, menu, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { findToolRenderer } from "../core/registry.js";
import { renderMarkdown } from "./markdown.js";
import { codeBlock } from "./tools.js";

const SCOPE_LABEL = {
  session: () => t("for this session"),
  localSettings: () => t("in this project (local)"),
  projectSettings: () => t("in this project (shared)"),
  userSettings: () => t("everywhere (user)"),
  cliArg: () => t("for this run"),
};

export function describeSuggestion(update) {
  const where = (SCOPE_LABEL[update.destination] || (() => update.destination))();
  switch (update.type) {
    case "addRules":
    case "replaceRules": {
      const rules = (update.rules || []).map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)).join(", ");
      const verb = update.behavior === "deny" ? t("Always deny") : update.behavior === "ask" ? t("Always ask for") : t("Always allow");
      return `${verb} ${rules} ${where}`;
    }
    case "removeRules":
      return `${t("Remove rule")} ${(update.rules || []).map((r) => r.toolName).join(", ")} ${where}`;
    case "setMode":
      return `${t("Switch mode to")} ${update.mode} ${where}`;
    case "addDirectories":
      return `${t("Allow access to")} ${(update.directories || []).map((d) => baseName(d)).join(", ")} ${where}`;
    case "removeDirectories":
      return `${t("Remove access to")} ${(update.directories || []).join(", ")} ${where}`;
    default:
      return update.type;
  }
}

export function renderRequest(request, { respond, conv, toolCard }) {
  if (request.kind === "permission") {
    if (request.toolName === "AskUserQuestion") return questionCard(request, respond);
    if (request.toolName === "ExitPlanMode") return planCard(request, respond);
    return permissionCard(request, respond, toolCard);
  }
  if (request.kind === "elicitation") return elicitationCard(request, respond);
  return dialogCard(request, respond);
}

// ---- permission ------------------------------------------------------------------
function permissionCard(request, respond, toolCard) {
  const tool = { id: request.toolUseID || request.id, name: request.toolName, input: request.input, status: "pending", v: 1, children: [], awaiting: request.id };
  const renderer = findToolRenderer(request.toolName);
  let preview = null;
  try {
    preview = renderer?.body ? h("div.req-preview", (renderer.body(tool, { conv: { tools: new Map() }, toolCard: () => null }) || []).flat().filter(Boolean)) : null;
  } catch { /* fall back to JSON */ }
  if (!preview?.childNodes.length) preview = h("div.req-preview", codeBlock(JSON.stringify(request.input ?? {}, null, 2), "json"));

  const deny = h("textarea.input.deny-reason.hidden", { rows: 2, dir: "auto", placeholder: t("Optional: tell Claude what to do instead") });
  const allowBtn = h("button.btn.primary", { type: "button", onclick: () => respond(request.id, { behavior: "allow", updatedInput: request.input, toolUseID: request.toolUseID }) }, icon("check", 14), t("Allow"));
  const buttons = [allowBtn];
  if (request.suggestions?.length) {
    const more = h("button.btn.split", { type: "button", title: t("Allow and remember"), onclick: (event) => {
      menu(event.currentTarget, request.suggestions.map((update) => ({
        label: describeSuggestion(update),
        icon: update.type === "setMode" ? "shield-check" : "check",
        onClick: () => respond(request.id, { behavior: "allow", updatedInput: request.input, updatedPermissions: [update], toolUseID: request.toolUseID }),
      })), { placement: "top-start", width: 360 });
    } }, t("Always…"), icon("chevron-up", 13));
    buttons.push(more);
  }
  const denyBtn = h("button.btn.danger-outline", { type: "button", onclick: () => {
    if (deny.classList.contains("hidden")) {
      deny.classList.remove("hidden");
      deny.focus();
      denyBtn.lastChild.textContent = t("Confirm deny");
      return;
    }
    respond(request.id, { behavior: "deny", message: deny.value.trim() || t("The user denied this action."), toolUseID: request.toolUseID });
  } }, icon("x", 14), h("span", t("Deny")));
  buttons.push(denyBtn);

  return h(
    "section.request.permission",
    h("header.req-head", icon("shield", 16), h("div.req-title", h("strong", request.title || request.displayName || t("Claude wants to use {tool}", { tool: request.toolName })), request.description ? h("span.muted", { dir: "auto" }, request.description) : null)),
    request.decisionReason ? h("div.req-reason", { dir: "auto" }, request.decisionReason) : null,
    request.blockedPath ? h("div.req-reason", icon("lock", 12), request.blockedPath) : null,
    preview,
    deny,
    h("div.req-actions", buttons),
  );
}

// ---- AskUserQuestion -------------------------------------------------------------
function questionCard(request, respond) {
  const questions = request.input?.questions || [];
  const answers = new Map(); // question -> Set(labels) | string
  const customInputs = new Map();
  const form = h("div.qs");
  questions.forEach((question, index) => {
    const selected = new Set();
    answers.set(question.question, selected);
    const name = `q${index}-${request.id}`;
    const custom = h("input.input.q-custom", { type: "text", dir: "auto", placeholder: t("Other…") });
    customInputs.set(question.question, custom);
    const options = (question.options || []).map((option, i) => {
      const input = h("input", { type: question.multiSelect ? "checkbox" : "radio", name, value: option.label });
      input.addEventListener("change", () => {
        if (!question.multiSelect) selected.clear();
        if (input.checked) selected.add(option.label);
        else selected.delete(option.label);
        if (!question.multiSelect) custom.value = "";
      });
      return h("label.q-option", input, h("div", h("strong", { dir: "auto" }, option.label), option.description ? h("span.muted", { dir: "auto" }, option.description) : null));
    });
    custom.addEventListener("input", () => {
      if (!question.multiSelect && custom.value) {
        selected.clear();
        form.querySelectorAll(`input[name="${name}"]`).forEach((input) => (input.checked = false));
      }
    });
    form.append(h("fieldset.q", question.header ? h("span.badge", question.header) : null, h("legend", { dir: "auto" }, question.question), h("div.q-options", options), custom));
  });
  const submit = () => {
    const result = {};
    for (const question of questions) {
      const picked = [...answers.get(question.question)];
      const extra = customInputs.get(question.question).value.trim();
      if (extra) picked.push(extra);
      result[question.question] = picked.join(", ");
    }
    respond(request.id, { behavior: "allow", updatedInput: { ...request.input, answers: result }, toolUseID: request.toolUseID });
  };
  return h(
    "section.request.question",
    h("header.req-head", icon("help", 16), h("div.req-title", h("strong", t("Claude has a question")))),
    form,
    h("div.req-actions", h("button.btn.primary", { type: "button", onclick: submit }, icon("check", 14), t("Send answers")), h("button.btn.ghost", { type: "button", onclick: () => respond(request.id, { behavior: "deny", message: t("The user skipped the question."), toolUseID: request.toolUseID }) }, t("Skip"))),
  );
}

// ---- plan ------------------------------------------------------------------------
function planCard(request, respond) {
  const feedback = h("textarea.input.hidden", { rows: 3, dir: "auto", placeholder: t("What should change in the plan?") });
  const approve = (mode) => respond(request.id, {
    behavior: "allow",
    updatedInput: request.input,
    updatedPermissions: mode ? [{ type: "setMode", mode, destination: "session" }] : undefined,
    toolUseID: request.toolUseID,
  });
  const reject = h("button.btn.danger-outline", { type: "button", onclick: () => {
    if (feedback.classList.contains("hidden")) {
      feedback.classList.remove("hidden");
      feedback.focus();
      reject.lastChild.textContent = t("Send feedback");
      return;
    }
    respond(request.id, { behavior: "deny", message: feedback.value.trim() || t("Please revise the plan."), toolUseID: request.toolUseID });
  } }, icon("edit", 14), h("span", t("Keep planning")));
  return h(
    "section.request.plan",
    h("header.req-head", icon("list", 16), h("div.req-title", h("strong", t("Review the plan")))),
    h("div.markdown.plan-body", { html: renderMarkdown(request.input?.plan || "") }),
    feedback,
    h(
      "div.req-actions",
      h("button.btn.primary", { type: "button", onclick: () => approve("acceptEdits") }, icon("check", 14), t("Approve · auto-accept edits")),
      h("button.btn", { type: "button", onclick: () => approve(null) }, t("Approve · ask for each action")),
      reject,
    ),
  );
}

// ---- MCP elicitation --------------------------------------------------------------
function elicitationCard(request, respond) {
  const fields = h("div.qs");
  const getters = [];
  const props = request.requestedSchema?.properties || {};
  const required = new Set(request.requestedSchema?.required || []);
  for (const [key, schema] of Object.entries(props)) {
    let input;
    if (schema.enum) {
      input = h("select.input", schema.enum.map((value, i) => h("option", { value }, schema.enumNames?.[i] || String(value))));
      getters.push([key, () => input.value]);
    } else if (schema.type === "boolean") {
      input = h("input", { type: "checkbox" });
      getters.push([key, () => input.checked]);
    } else if (schema.type === "number" || schema.type === "integer") {
      input = h("input.input", { type: "number" });
      getters.push([key, () => (input.value === "" ? undefined : Number(input.value))]);
    } else {
      input = h("input.input", { type: "text", dir: "auto" });
      getters.push([key, () => input.value]);
    }
    fields.append(h("label.field", h("span", `${schema.title || key}${required.has(key) ? " *" : ""}`), input, schema.description ? h("small.muted", schema.description) : null));
  }
  const actions = [];
  if (request.mode === "url" && request.url) {
    actions.push(h("a.btn", { href: request.url, target: "_blank", rel: "noreferrer noopener" }, icon("external", 14), t("Open link")));
    actions.push(h("button.btn.primary", { type: "button", onclick: () => respond(request.id, { action: "accept" }) }, t("Done")));
  } else {
    actions.push(h("button.btn.primary", { type: "button", onclick: () => respond(request.id, { action: "accept", content: Object.fromEntries(getters.map(([key, get]) => [key, get()]).filter(([, value]) => value !== undefined)) }) }, t("Submit")));
  }
  actions.push(h("button.btn.ghost", { type: "button", onclick: () => respond(request.id, { action: "decline" }) }, t("Decline")));
  return h(
    "section.request.elicitation",
    h("header.req-head", icon("plug", 16), h("div.req-title", h("strong", request.title || request.serverName), h("span.muted", { dir: "auto" }, request.message || ""))),
    fields,
    h("div.req-actions", actions),
  );
}

function dialogCard(request, respond) {
  return h(
    "section.request.dialog",
    h("header.req-head", icon("info", 16), h("div.req-title", h("strong", request.dialogKind || t("Dialog")))),
    codeBlock(JSON.stringify(request.payload ?? {}, null, 2), "json"),
    h("div.req-actions", h("button.btn.primary", { type: "button", onclick: () => respond(request.id, { behavior: "completed", result: request.payload?.default ?? null }) }, t("Continue")), h("button.btn.ghost", { type: "button", onclick: () => respond(request.id, { behavior: "cancelled" }) }, t("Dismiss"))),
  );
}
