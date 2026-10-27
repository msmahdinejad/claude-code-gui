// Renders a Conversation as a timeline and keeps the DOM in sync incrementally.
import { h, copyText, formatCost, formatDuration, formatNumber, formatTokens, menu, raf } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { renderMarkdown, wireMarkdownActions } from "./markdown.js";
import { ToolCard } from "./tools.js";
import { isBusy } from "./reducer.js";

export class ChatView {
  constructor(root, { onAction } = {}) {
    this.root = root;
    this.onAction = onAction || (() => {});
    this.scroller = h("div.chat-scroll", { tabindex: "-1" });
    this.col = h("div.chat-col");
    this.working = h("div.working.hidden");
    this.col.append(this.working);
    this.scroller.append(this.col);
    this.jump = h("button.jump-latest.hidden", { type: "button", onclick: () => this.scrollToBottom(true) }, icon("arrow-down", 14), t("Latest"));
    root.append(this.scroller, this.jump);
    this.conv = null;
    this.nodes = new Map();
    this.cards = new Map();
    this.stick = true;
    this.schedule = raf(() => this.flush());
    this.timer = null;
    this.scroller.addEventListener("scroll", () => {
      const gap = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight;
      this.stick = gap < 120;
      this.jump.classList.toggle("hidden", this.stick);
    });
    wireMarkdownActions(this.col, (text) => copyText(text));
    new ResizeObserver(() => this.stick && this.scrollToBottom()).observe(this.col);
  }

  setConversation(conv) {
    this.conv = conv;
    for (const node of this.nodes.values()) node.el.remove();
    this.nodes.clear();
    this.cards.clear();
    this.stick = true;
    this.flush();
    this.scrollToBottom(true);
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
    if (item.error) {
      parts.push(h("div.banner.error", icon("alert", 14), h("span", describeAssistantError(item.error))));
    }
    if (item.aborted) parts.push(h("div.banner.info", icon("stop", 14), t("Interrupted")));
    if (!item.streaming && showActions) {
      const text = item.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
      if (text) {
        parts.push(
          h(
            "div.msg-actions.assistant",
            h("button.mini", { type: "button", title: t("Copy"), onclick: () => copyText(text) }, icon("copy", 13), h("span", t("Copy"))),
            item.model ? h("span.meta", item.model) : null,
            item.usage?.output_tokens ? h("span.meta", `${formatTokens(item.usage.output_tokens)} ${t("tokens out")}`) : null,
          ),
        );
      }
    }
    footer.replaceChildren(...parts);
  }

  renderNotice(node, item) {
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
    if (item.isError) children.push(h("div.banner.error", icon("alert", 14), h("span", { dir: "auto" }, item.text || t("The turn ended with an error."))));
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
  return map[error] || String(error);
}
