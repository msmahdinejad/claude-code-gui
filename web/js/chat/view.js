// Renders a Conversation as a timeline and keeps the DOM in sync incrementally.
import { h, copyText, formatCost, formatDuration, formatNumber, formatTokens, menu, raf } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { renderMarkdown, wireMarkdownActions } from "./markdown.js";
import { ToolCard, taskMeta } from "./tools.js";
import { isBusy } from "./reducer.js";
import { isAuthProblem, openLoginDialog } from "../ui/login-dialog.js";
import { describeApiFailure, failureAdvice, seconds } from "./api-errors.js";

const signInButton = () => h("button.btn.small", { type: "button", onclick: () => openLoginDialog() }, icon("unlock", 13), t("Sign in"));

export class ChatView {
  constructor(root, { onAction } = {}) {
    this.root = root;
    this.onAction = onAction || (() => {});
    this.scroller = h("div.chat-scroll", { tabindex: "-1" });
    this.col = h("div.chat-col");
    this.working = h("div.working.hidden");
    this.background = h("div.bg-work.hidden"); // subagents and commands still running after the turn ended
    this.col.append(this.working, this.background);
    this.scroller.append(this.col);
    this.jump = h("button.jump-latest.hidden", { type: "button", onclick: () => this.scrollToBottom(true) }, icon("arrow-down", 14), t("Latest"));
    root.append(this.scroller, this.jump);
    this.conv = null;
    this.nodes = new Map();
    this.cards = new Map();
    this.stick = true;
    this.positions = new Map(); // conversation id -> where the reader was, so coming back lands on the same spot
    this.schedule = raf(() => this.flush());
    this.timer = null;
    this.scroller.addEventListener("scroll", () => {
      const { scrollHeight, scrollTop, clientHeight } = this.scroller;
      if (!clientHeight) return; // hidden or minimized: the numbers mean nothing
      this.stick = scrollHeight - scrollTop - clientHeight < 120;
      this.jump.classList.toggle("hidden", this.stick);
    });
    wireMarkdownActions(this.col, (text) => copyText(text));
    const follow = () => { if (this.stick && this.scroller.clientHeight) this.scrollToBottom(); };
    const resizes = new ResizeObserver(follow);
    resizes.observe(this.col);
    resizes.observe(this.scroller);
  }

  /** Remember where the reader is: at the end (and so following new messages), or on a particular message. */
  rememberPosition() {
    const id = this.conv?.id;
    const box = this.scroller.getBoundingClientRect();
    if (!id || !box.height) return; // nothing shown (hidden window, welcome screen): keep what we had
    if (this.stick) {
      this.positions.set(id, { stick: true });
      return;
    }
    for (const [key, node] of this.nodes) {
      const top = node.el.getBoundingClientRect().bottom - box.top;
      if (top <= 1) continue;
      this.positions.set(id, { stick: false, key, offset: node.el.getBoundingClientRect().top - box.top, top: this.scroller.scrollTop });
      return;
    }
  }

  restorePosition(position) {
    if (!position || position.stick) {
      this.stick = true;
      this.scrollToBottom(true);
      return;
    }
    this.stick = false;
    const node = this.nodes.get(position.key);
    if (node) {
      const now = node.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
      this.scroller.scrollTop += now - position.offset;
    } else {
      this.scroller.scrollTop = position.top;
    }
    this.jump.classList.toggle("hidden", this.stick);
  }

  setConversation(conv) {
    this.rememberPosition();
    this.conv = conv;
    for (const node of this.nodes.values()) node.el.remove();
    this.nodes.clear();
    this.cards.clear();
    const position = this.positions.get(conv.id);
    this.stick = !position || position.stick; // flush() must not jump to the end for a reader who was higher up
    this.flush();
    this.restorePosition(position);
  }

  sync() {
    this.schedule();
  }

  scrollToBottom(force = false) {
    if (!force && !this.stick) return;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.jump.classList.add("hidden");
  }

  cardFor(tool) {
    let card = this.cards.get(tool.id);
    if (!card) {
      card = new ToolCard(tool, this.ctx());
      this.cards.set(tool.id, card);
    } else card.update(tool);
    return card;
  }

  ctx() {
    return {
      conv: this.conv,
      toolCard: (tool) => this.cardFor(tool).el,
      onAction: this.onAction,
    };
  }

  flush() {
    const conv = this.conv;
    if (!conv) return;
    let previous = null;
    for (const item of conv.items) {
      let node = this.nodes.get(item.key);
      if (!node) {
        node = { el: h(`article.msg.msg-${item.kind}`), v: 0, state: {} };
        this.nodes.set(item.key, node);
        this.col.insertBefore(node.el, this.working);
      }
      if (node.v !== item.v) {
        this.renderItem(node, item, conv);
        node.v = item.v;
      }
      const next = conv.items[conv.items.indexOf(item) + 1];
      const lastOfTurn = !next || next.kind === "user";
      if (item.kind === "assistant" && node.lastOfTurn !== lastOfTurn) {
        node.lastOfTurn = lastOfTurn;
        if (node.state.footer) this.renderFooter(node.state.footer, item, lastOfTurn);
      }
      node.el.classList.toggle("continues", Boolean(previous && previous.kind !== "user" && item.kind === "assistant" && previous.kind === "assistant"));
      previous = item;
    }
    this.updateWorking(conv);
    this.updateBackground(conv);
    if (this.stick) this.scrollToBottom();
  }

  updateWorking(conv) {
    const busy = isBusy(conv) && conv.state !== "starting";
    const streamingText = [...conv.drafts.values()].some((item) => item.streaming && item.blocks.some((block) => block.type === "text" && block.text));
    const waiting = conv.requests.size > 0;
    this.working.classList.toggle("hidden", !busy || waiting || streamingText && !conv.statusText);
    if (this.working.classList.contains("hidden")) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    const label = conv.statusText === "compacting" ? t("Compacting conversation…") : conv.statusText === "requesting" ? t("Waiting for model…") : t("Working…");
    const update = () => {
      const elapsed = conv.turnStartedAt ? formatDuration(Date.now() - conv.turnStartedAt) : "";
      this.working.replaceChildren(h("span.dots", h("i"), h("i"), h("i")), h("span", label), elapsed ? h("span.muted", elapsed) : null);
    };
    update();
    if (!this.timer) this.timer = setInterval(() => this.conv && update(), 1000);
  }

  /** One line per background task (subagent or command) that is still running; a click shows its card. */
  updateBackground(conv) {
    const running = [...conv.tasks.values()].filter((task) => ["running", "pending", "in_progress"].includes(task.status));
    this.background.classList.toggle("hidden", !running.length);
    if (!running.length) return;
    const show = (task) => {
      const card = task.toolUseId && this.cards.get(task.toolUseId);
      if (!card) return;
      if (!card.isOpen()) card.toggle();
      card.el.scrollIntoView({ block: "center", behavior: "smooth" });
      card.el.classList.add("flash");
      setTimeout(() => card.el.classList.remove("flash"), 1200);
    };
    this.background.replaceChildren(
      h("div.bg-work-head", icon("loader", 13, "spin"), h("span", t("{n} running in the background", { n: running.length }))),
      ...running.map((task) => {
        const tool = task.toolUseId ? conv.tools.get(task.toolUseId) : null;
        const agent = task.taskType === "local_agent" || tool?.name === "Agent" || tool?.name === "Task";
        const what = (agent ? tool?.input?.description : null) || task.description || "";
        const now = task.summary && task.summary !== what ? task.summary : "";
        return h(
          "button.bg-work-row",
          { type: "button", title: t("Show"), onclick: () => show(task) },
          icon(agent ? "bot" : "terminal", 13),
          h("span.grow", { dir: "auto" }, h("strong", what || t("Background task")), now ? h("span.muted", ` — ${now}`) : null),
          taskMeta(task) ? h("span.muted.small", taskMeta(task)) : null,
        );
      }),
    );
  }

  renderItem(node, item, conv) {
    switch (item.kind) {
      case "user": return this.renderUser(node, item);
      case "assistant": return this.renderAssistant(node, item, conv);
      case "notice": return this.renderNotice(node, item);
      case "boundary": return node.el.replaceChildren(h("div.boundary", h("span", t(item.text)), item.detail?.pre_tokens ? h("span.muted", ` · ${formatTokens(item.detail.pre_tokens)} → ${formatTokens(item.detail.post_tokens || 0)}`) : null));
      case "output": return node.el.replaceChildren(h(`pre.local-output${item.error ? ".error" : ""}`, { dir: "auto" }, item.text));
      case "result": return this.renderResult(node, item);
      default: return null;
    }
  }

  renderUser(node, item) {
    const bubble = h("div.bubble", { dir: "auto" });
    if (item.command) {
      bubble.append(h("span.cmd-chip", item.command.name), item.command.args ? h("span.cmd-args", item.command.args) : null);
    }
    if (item.images?.length) {
      bubble.append(h("div.thumbs", item.images.map((image) => h("img.thumb", { src: `data:${image.mediaType};base64,${image.data}`, alt: image.name || "image", onclick: () => bus.emit("view-image", image) }))));
    }
    if (item.text) bubble.append(h("div.user-text", item.text));
    const actions = h(
      "div.msg-actions",
      item.text ? h("button.mini", { type: "button", title: t("Reply"), onclick: () => bus.emit("composer:quote", item.text) }, icon("reply", 13, "mirror-rtl")) : null,
      h("button.mini", { type: "button", title: t("Copy"), onclick: () => copyText(item.text || "") }, icon("copy", 13)),
      item.uuid
        ? h("button.mini", { type: "button", title: t("More"), onclick: (event) => this.userMenu(event.currentTarget, item) }, icon("more-horizontal", 13))
        : null,
    );
    node.el.replaceChildren(h("div.user-row", bubble, actions));
    node.el.classList.toggle("pending", Boolean(item.pending));
  }

  userMenu(anchor, item) {
    menu(anchor, [
      { label: t("Copy text"), icon: "copy", onClick: () => copyText(item.text || "") },
      { label: t("Fork from here"), icon: "split", onClick: () => this.onAction("fork", item) },
      { label: t("Rewind files to here"), icon: "undo", onClick: () => this.onAction("rewind", item) },
      { label: t("Resend"), icon: "refresh", onClick: () => this.onAction("resend", item) },
    ]);
  }

  /** The user message that started the turn this reply belongs to. */
  promptOf(item) {
    const items = this.conv?.items || [];
    for (let i = items.indexOf(item) - 1; i >= 0; i -= 1) if (items[i].kind === "user") return items[i];
    return null;
  }

  replyMenu(anchor, item, text) {
    const prompt = this.promptOf(item);
    const uuid = [...(item.uuids || [])].at(-1);
    menu(anchor, [
      { label: t("Copy text"), icon: "copy", onClick: () => copyText(text) },
      uuid ? { label: t("Fork from here"), icon: "split", onClick: () => this.onAction("fork", { uuid }) } : null,
      prompt?.text ? { label: t("Ask again"), icon: "refresh", onClick: () => this.onAction("resend", prompt) } : null,
      prompt?.uuid ? { label: t("Rewind files to before this reply"), icon: "undo", onClick: () => this.onAction("rewind", prompt) } : null,
    ].filter(Boolean));
  }

  renderAssistant(node, item, conv) {
    const state = node.state;
    if (!state.body) {
      state.body = h("div.assistant-body");
      state.blocks = [];
      state.footer = h("div.msg-footer");
      node.el.replaceChildren(state.body, state.footer);
    }
    const body = state.body;
    item.blocks.forEach((block, index) => {
      let entry = state.blocks[index];
      if (!entry || entry.type !== block.type) {
        entry?.el.remove();
        entry = { type: block.type, el: h(`div.block.block-${block.type}`), last: null };
        state.blocks[index] = entry;
        body.insertBefore(entry.el, body.children[index] || null);
      }
      this.renderBlock(entry, block, item, conv);
    });
    while (state.blocks.length > item.blocks.length) state.blocks.pop().el.remove();
    this.renderFooter(state.footer, item, node.lastOfTurn !== false);
    node.el.classList.toggle("streaming", Boolean(item.streaming));
  }

  renderBlock(entry, block, item, conv) {
    const el = entry.el;
    if (block.type === "text") {
      if (entry.last !== block.text) {
        el.innerHTML = renderMarkdown(block.text);
        el.classList.add("markdown");
        entry.last = block.text;
      }
      el.classList.toggle("caret", Boolean(block.streaming));
    } else if (block.type === "thinking") {
      if (!entry.details) {
        entry.details = h("details.thinking", h("summary", icon("brain", 14), h("span.think-label"), icon("chevron-down", 12)), h("div.think-body", { dir: "auto" }));
        el.append(entry.details);
      }
      if (entry.last !== block.text || entry.streaming !== block.streaming) {
        entry.details.querySelector(".think-label").textContent = block.streaming ? t("Thinking…") : block.redacted ? t("Thought (hidden)") : t("Thought");
        entry.details.querySelector(".think-body").textContent = block.text || (block.redacted ? t("This reasoning is not shown.") : "");
        if (block.streaming && entry.streaming === undefined && app.prefs.showThinking) entry.details.open = true;
        if (!block.streaming && entry.streaming === true) entry.details.open = false;
        entry.last = block.text;
        entry.streaming = block.streaming;
      }
      el.classList.toggle("hidden", !app.prefs.showThinking && !block.streaming);
    } else if (block.type === "tool") {
      const tool = conv.tools.get(block.toolUseId);
      if (!tool) return;
      const card = this.cardFor(tool);
      if (!el.contains(card.el)) el.replaceChildren(card.el);
    } else if (entry.last !== block) {
      el.replaceChildren(h("pre.json", { dir: "ltr" }, JSON.stringify(block.raw, null, 2)));
      entry.last = block;
    }
  }

  renderFooter(footer, item, showActions = true) {
    const parts = [];
    const said = item.blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ");
    // The CLI answers with a made-up message ("Login expired · Please run /login") when the OAuth session is gone.
    const signedOut = item.error === "authentication_failed" || ((item.error || item.model === "<synthetic>") && isAuthProblem(said));
    if (item.error) {
      parts.push(h("div.banner.error", icon("alert", 14), h("span", describeAssistantError(item.error)), signedOut ? signInButton() : null));
    } else if (signedOut && !item.streaming) {
      parts.push(h("div.msg-actions.assistant", signInButton()));
    }
    if (item.aborted) parts.push(h("div.banner.info", icon("stop", 14), t("Interrupted")));
    if (!item.streaming && showActions) {
      const text = item.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
      if (text) {
        const uuid = [...(item.uuids || [])].at(-1); // the last message of this reply: what a fork continues from
        parts.push(
          h(
            "div.msg-actions.assistant",
            h("button.mini", { type: "button", title: t("Reply to this message"), onclick: () => bus.emit("composer:quote", text) }, icon("reply", 13, "mirror-rtl"), h("span", t("Reply"))),
            h("button.mini", { type: "button", title: t("Copy"), onclick: () => copyText(text) }, icon("copy", 13), h("span", t("Copy"))),
            uuid ? h("button.mini", { type: "button", title: t("Fork from here"), onclick: () => this.onAction("fork", { uuid }) }, icon("split", 13), h("span", t("Fork"))) : null,
            h("button.mini", { type: "button", title: t("More"), onclick: (event) => this.replyMenu(event.currentTarget, item, text) }, icon("more-horizontal", 13)),
            item.model ? h("span.meta", item.model) : null,
            item.usage?.output_tokens ? h("span.meta", `${formatTokens(item.usage.output_tokens)} ${t("tokens out")}`) : null,
          ),
        );
      }
    }
    footer.replaceChildren(...parts);
  }

  renderRetry(node, item) {
    const r = item.retry;
    const advice = failureAdvice(r.status, r.error);
    const progress = [
      r.status ? `HTTP ${r.status}` : null,
      t("Attempt {n} of {max}", { n: r.attempt ?? "?", max: r.max ?? "?" }),
      r.delayMs != null ? t("next try in {time}", { time: seconds(r.delayMs) }) : null,
    ].filter(Boolean);
    node.el.replaceChildren(
      h(
        "div.banner.warn",
        icon("alert", 14),
        h(
          "div.banner-text",
          h("strong", { dir: "auto" }, describeApiFailure(r.status, r.error)),
          h("span.muted", { dir: "auto" }, ` — ${progress.join(" · ")}`),
          advice ? h("div.muted", { dir: "auto" }, advice) : null,
          h("details", h("summary", t("Details")), h("pre", { dir: "ltr" }, String(item.detail))),
        ),
      ),
    );
  }

  renderNotice(node, item) {
    if (item.subtype === "retry" && item.retry) return this.renderRetry(node, item);
    const kind = item.level || "info";
    const box = h(
      `div.banner.${kind}`,
      icon(kind === "error" ? "alert" : kind === "warn" ? "alert" : "info", 14),
      h("div.banner-text", h("span", { dir: "auto" }, t(item.text)), item.detail ? h("details", h("summary", t("Details")), h("pre", String(item.detail))) : null),
    );
    node.el.replaceChildren(box);
  }

  renderResult(node, item) {
    const bits = [];
    if (item.durationMs) bits.push(formatDuration(item.durationMs));
    if (item.cost) bits.push(formatCost(item.cost));
    const tokens = (item.usage?.input_tokens || 0) + (item.usage?.cache_read_input_tokens || 0) + (item.usage?.cache_creation_input_tokens || 0);
    const out = item.usage?.output_tokens || 0;
    if (tokens) bits.push(`${t("in")} ${formatTokens(tokens)}`);
    if (out) bits.push(`${t("out")} ${formatTokens(out)}`);
    if (item.turns > 1) bits.push(t("{n} turns", { n: formatNumber(item.turns) }));
    const children = [];
    if (item.isError) children.push(h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, item.text || t("The turn ended with an error.")), isAuthProblem(item.text) ? signInButton() : null));
    if (item.denials?.length) {
      children.push(h("div.banner.warn", icon("shield", 14), h("span", t("{n} tool call(s) were denied", { n: item.denials.length }))));
    }
    if (bits.length) children.push(h("div.turn-meta", bits.map((bit) => h("bdi", bit))));
    node.el.replaceChildren(...children);
  }
}

function describeAssistantError(error) {
  const map = {
    authentication_failed: t("Authentication failed. Check the gateway key."),
    billing_error: t("Billing / usage limit reached."),
    rate_limit: t("Rate limited. Try again shortly."),
    invalid_request: t("The request was rejected as invalid."),
    server_error: t("The API returned a server error."),
    max_output_tokens: t("The reply hit the maximum output length."),
    unknown: t("Unknown error."),
  };
  const text = map[error] || String(error);
  const advice = failureAdvice(null, error);
  return advice && error === "server_error" ? `${text} ${advice}` : text;
}
