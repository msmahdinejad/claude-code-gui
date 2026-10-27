// Message composer: text, attachments, slash commands, @mentions, queue, pickers.
import { h, ibtn, menu, popover, toast, errorMessage, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus, currentConv } from "../core/state.js";
import { api } from "../core/api.js";
import { commands as registeredCommands } from "../core/registry.js";
import * as session from "../session.js";
import { isBusy } from "../chat/reducer.js";
import { toQuote } from "../chat/quote.js";
import { openModelPicker, openModePicker, openEffortPicker, currentModelInfo, modelLabel, modeInfo, EFFORTS } from "./pickers.js";
import { makeCtx } from "../ctx.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function mountComposer(host) {
  const textarea = h("textarea.cmp-input", { rows: 1, dir: "auto", placeholder: t("Message Claude…"), "aria-label": t("Message"), spellcheck: "true" });
  const attachments = h("div.cmp-attachments.hidden");
  const queueBox = h("div.queue.hidden");
  const sendBtn = h("button.send-btn", { type: "button", title: t("Send"), "aria-label": t("Send"), onclick: () => submit() }, icon("arrow-up", 17));
  const modelBtn = h("button.cmp-chip-btn", { type: "button", onclick: (event) => openModelPicker(event.currentTarget) });
  const modeBtn = h("button.cmp-chip-btn", { type: "button", onclick: (event) => openModePicker(event.currentTarget) });
  const effortBtn = h("button.cmp-chip-btn.effort-btn", { type: "button", title: t("Reasoning effort"), onclick: (event) => openEffortPicker(event.currentTarget) });
  const plusBtn = ibtn("plus", t("Add"), (event) => plusMenu(event.currentTarget));
  const micBtn = ibtn("mic", t("Dictate"), () => toggleDictation(), { cls: "mic" });
  const fileInput = h("input", { type: "file", accept: "image/*", multiple: true, class: "hidden", onchange: () => { addFiles([...fileInput.files]); fileInput.value = ""; } });
  const hint = h("div.footer-hint");
  const root = h("div.composer", attachments, queueBox, textarea, h("div.cmp-bar", plusBtn, modeBtn, h("span.grow"), effortBtn, modelBtn, micBtn, sendBtn), fileInput);
  host.replaceChildren(root, hint);

  let images = []; // {mediaType, data, name}
  let queue = []; // {text, images}
  let ac = null; // autocomplete popover state
  let dictation = null;

  // ---- draft persistence ----
  const draftKey = () => `wheelhouse-draft-${app.currentId}`;
  const saveDraft = debounce(() => {
    try { textarea.value ? localStorage.setItem(draftKey(), textarea.value) : localStorage.removeItem(draftKey()); } catch { /* ignore */ }
  }, 250);
  function loadDraft() {
    try { textarea.value = localStorage.getItem(draftKey()) || ""; } catch { textarea.value = ""; }
    images = [];
    queue = [];
    renderAttachments();
    renderQueue();
    autosize();
  }

  function autosize() {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
  }

  // ---- state-dependent UI ----
  function refresh() {
    const state = session.effective();
    const conv = currentConv();
    const busy = conv ? isBusy(conv) && conv.state !== "starting" : false;
    modelBtn.replaceChildren(icon("sparkles", 13), h("span", modelLabel(state.model)), icon("chevron-down", 12));
    const mode = modeInfo(state.permissionMode);
    modeBtn.className = `cmp-chip-btn mode-${state.permissionMode}`;
    modeBtn.replaceChildren(icon(mode.icon, 13), h("span", mode.title()));
    effortBtn.classList.toggle("hidden", currentModelInfo(state.model)?.supportsEffort === false);
    effortBtn.classList.toggle("set", Boolean(state.effort));
    effortBtn.replaceChildren(icon("gauge", 13), h("span", state.effort ? (EFFORTS.find((effort) => effort.id === state.effort)?.title() || state.effort) : t("Auto")));
    const hasContent = Boolean(textarea.value.trim() || images.length);
    sendBtn.classList.toggle("stop", busy && !hasContent);
    sendBtn.replaceChildren(icon(busy && !hasContent ? "stop" : "arrow-up", busy && !hasContent ? 15 : 17));
    sendBtn.disabled = !busy && !hasContent;
    sendBtn.title = busy && !hasContent ? t("Stop") : busy ? t("Queue message") : t("Send");
    hint.textContent = app.prefs.sendKey === "enter" ? t("Enter to send · Shift+Enter for a new line · / for commands · @ for files") : t("Ctrl+Enter to send · / for commands · @ for files");
    micBtn.classList.toggle("active", Boolean(dictation));
  }

  // ---- attachments ----
  function renderAttachments() {
    attachments.classList.toggle("hidden", !images.length);
    attachments.replaceChildren(...images.map((image, index) => h("div.cmp-attach", h("img", { src: `data:${image.mediaType};base64,${image.data}`, alt: image.name }), h("button", { type: "button", title: t("Remove"), onclick: () => { images.splice(index, 1); renderAttachments(); refresh(); } }, icon("x", 11)))));
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ mediaType: file.type || "image/png", name: file.name || "image", data: String(reader.result).split(",")[1] });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        toast(t("Only images can be attached. Use @ to reference a file by path."), "error");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast(t("Image is too large (max 12 MB)."), "error");
        continue;
      }
      images.push(await readFile(file));
    }
    renderAttachments();
    refresh();
  }

  textarea.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });
  root.addEventListener("dragover", (event) => { event.preventDefault(); root.classList.add("drag"); });
  root.addEventListener("dragleave", () => root.classList.remove("drag"));
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    root.classList.remove("drag");
    addFiles([...(event.dataTransfer?.files || [])]);
  });

  // ---- queue ----
  function renderQueue() {
    queueBox.classList.toggle("hidden", !queue.length);
    queueBox.replaceChildren(
      ...queue.map((entry, index) =>
        h(
          "div.queue-item",
          icon("clock", 13),
          h("span", { dir: "auto" }, entry.text || t("(image)")),
          h("button.mini", { type: "button", title: t("Send now (interrupt)"), onclick: () => sendNow(index) }, icon("zap", 13)),
          h("button.mini", { type: "button", title: t("Remove"), onclick: () => { queue.splice(index, 1); renderQueue(); } }, icon("x", 13)),
        ),
      ),
    );
  }

  async function sendNow(index) {
    const [entry] = queue.splice(index, 1);
    renderQueue();
    await session.interrupt();
    await deliver(entry.text, entry.images);
  }

  function drainQueue() {
    const conv = currentConv();
    if (!queue.length || !conv || isBusy(conv)) return;
    const entry = queue.shift();
    renderQueue();
    deliver(entry.text, entry.images);
  }

  // ---- sending ----
  async function deliver(text, imgs) {
    try {
      await session.sendMessage(text, imgs);
    } catch {
      // The controller already showed the error; put the message back so nothing typed is lost.
      if (!textarea.value.trim() && !images.length) {
        textarea.value = text;
        images = imgs;
        renderAttachments();
        autosize();
        refresh();
      }
    }
  }

  async function submit() {
    const conv = currentConv();
    const busy = conv ? isBusy(conv) && conv.state !== "starting" : false;
    const text = textarea.value.trim();
    if (!text && !images.length) {
      if (busy) session.interrupt();
      return;
    }
    if (text.startsWith("/") && !images.length) {
      const handled = await runClientSlash(text);
      if (handled) {
        clearInput();
        return;
      }
    }
    const entry = { text, images: images.slice() };
    clearInput();
    if (busy) {
      queue.push(entry);
      renderQueue();
      return;
    }
    await deliver(entry.text, entry.images);
  }

  function clearInput() {
    textarea.value = "";
    images = [];
    renderAttachments();
    autosize();
    saveDraft();
    closeAc();
    refresh();
  }

  async function runClientSlash(text) {
    const [, name, rest] = /^\/(\S+)\s*(.*)$/s.exec(text) || [];
    if (!name) return false;
    const command = registeredCommands.find((entry) => entry.slash === name || entry.slashAliases?.includes(name));
    if (!command) return false;
    try {
      await command.run(makeCtx(), rest);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
    return true;
  }

  // ---- autocomplete (/commands and @files) ----
  function closeAc() {
    ac?.pop.close();
    ac = null;
  }

  function showAc(kind, items, onPick, anchorToken) {
    if (!items.length) return closeAc();
    const list = h("div.picker");
    const rows = items.map((item, index) =>
      h(
        `button.ac-item${index === 0 ? ".active" : ""}`,
        { type: "button", onmousedown: (event) => { event.preventDefault(); onPick(item); } },
        icon(item.icon || (kind === "slash" ? "slash" : "file"), 14),
        h("span.ac-name", item.name),
        item.desc ? h("span.ac-desc", { dir: "auto" }, item.desc) : null,
      ),
    );
    list.append(...rows);
    if (!ac) {
      const pop = popover(textarea, list, { placement: "top-start", className: "ac-popover", offset: 10 });
      ac = { pop, items, index: 0, kind };
    } else {
      ac.pop.el.replaceChildren(list);
      ac.items = items;
      ac.index = 0;
    }
    ac.rows = rows;
    ac.onPick = onPick;
  }

  function moveAc(delta) {
    if (!ac) return;
    ac.rows[ac.index]?.classList.remove("active");
    ac.index = (ac.index + delta + ac.items.length) % ac.items.length;
    ac.rows[ac.index]?.classList.add("active");
    ac.rows[ac.index]?.scrollIntoView({ block: "nearest" });
  }

  function slashItems(query) {
    const catalog = (app.catalog?.commands || []).map((command) => ({ name: `/${command.name}`, desc: command.description, hint: command.argumentHint, icon: command.builtin ? "command" : "sparkles", raw: command.name }));
    const client = registeredCommands.filter((command) => command.slash).map((command) => ({ name: `/${command.slash}`, desc: t(command.title), icon: command.icon || "command", raw: command.slash, client: true }));
    const seen = new Set();
    const all = [...client, ...catalog].filter((item) => (seen.has(item.name) ? false : seen.add(item.name)));
    const needle = query.toLowerCase();
    return all
      .filter((item) => !needle || item.raw.toLowerCase().includes(needle))
      .sort((a, b) => (b.raw.toLowerCase().startsWith(needle) ? 1 : 0) - (a.raw.toLowerCase().startsWith(needle) ? 1 : 0))
      .slice(0, 40);
  }

  const searchFiles = debounce(async (query, token) => {
    try {
      const { files } = await api.get("/api/fs/search", { cwd: app.currentCwd, q: query });
      if (textarea.value.slice(token.start, token.end) !== token.text) return;
      showAc("file", files.map((file) => ({ name: file.path, icon: "file" })), (item) => insertMention(item.name, token), token);
    } catch { closeAc(); }
  }, 120);

  function insertMention(path, token) {
    const before = textarea.value.slice(0, token.start);
    const after = textarea.value.slice(token.end);
    const quoted = /\s/.test(path) ? `@"${path}"` : `@${path}`;
    textarea.value = `${before}${quoted} ${after}`;
    const pos = before.length + quoted.length + 1;
    textarea.setSelectionRange(pos, pos);
    closeAc();
    autosize();
    saveDraft();
    refresh();
    textarea.focus();
  }

  function updateAutocomplete() {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    const slash = /^\/(\S*)$/.exec(before);
    if (slash) {
      const items = slashItems(slash[1]);
      showAc("slash", items, (item) => {
        textarea.value = `${item.name} `;
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        closeAc();
        autosize();
        refresh();
        textarea.focus();
      });
      return;
    }
    const mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (mention) {
      const token = { start: pos - mention[1].length - 1, end: pos, text: `@${mention[1]}` };
      searchFiles(mention[1], token);
      return;
    }
    closeAc();
  }

  textarea.addEventListener("input", () => {
    autosize();
    saveDraft();
    refresh();
    updateAutocomplete();
  });
  textarea.addEventListener("keydown", (event) => {
    if (ac && ["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(event.key) && !event.isComposing) {
      if (event.key === "ArrowDown") { event.preventDefault(); moveAc(1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); moveAc(-1); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) { event.preventDefault(); ac.onPick(ac.items[ac.index]); return; }
      if (event.key === "Escape") { event.preventDefault(); closeAc(); return; }
    }
    if (event.key === "Enter" && !event.isComposing && !event.shiftKey) {
      const ctrl = event.ctrlKey || event.metaKey;
      if (app.prefs.sendKey === "enter" || ctrl) {
        event.preventDefault();
        submit();
      }
    }
    if (event.key === "Escape" && !ac) {
      const conv = currentConv();
      if (conv && isBusy(conv)) session.interrupt();
    }
  });

  // ---- plus menu ----
  function plusMenu(anchor) {
    menu(anchor, [
      { label: t("Attach image"), icon: "image", onClick: () => fileInput.click() },
      { label: t("Mention a file (@)"), icon: "at", onClick: () => { textarea.value += (textarea.value && !/\s$/.test(textarea.value) ? " " : "") + "@"; textarea.focus(); updateAutocomplete(); } },
      { label: t("Slash commands (/)"), icon: "slash", onClick: () => { textarea.value = "/"; textarea.focus(); updateAutocomplete(); } },
      "-",
      { label: t("Plan mode"), icon: "list", onClick: () => session.setPermissionMode("plan") },
      { label: t("Add folder to this session…"), icon: "folder", onClick: () => bus.emit("command", "add-dir") },
      { label: t("Command palette"), icon: "command", hint: "Ctrl+K", onClick: () => bus.emit("command", "palette") },
    ], { placement: "top-start" });
  }

  // ---- dictation ----
  function toggleDictation() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return toast(t("Speech recognition is not available in this browser."), "error");
    if (dictation) { dictation.stop(); return; }
    const recognition = new Recognition();
    recognition.lang = app.config?.prefs?.dictationLang || (document.documentElement.lang === "fa" ? "fa-IR" : "en-US");
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) textarea.value += `${textarea.value && !/\s$/.test(textarea.value) ? " " : ""}${event.results[i][0].transcript.trim()}`;
      }
      autosize();
      saveDraft();
      refresh();
    };
    recognition.onend = () => { dictation = null; refresh(); };
    recognition.onerror = (event) => { toast(`${t("Dictation error")}: ${event.error}`, "error"); };
    dictation = recognition;
    recognition.start();
    refresh();
  }

  bus.on("composer:fill", (text) => {
    textarea.value = text;
    autosize();
    saveDraft();
    textarea.focus();
    refresh();
  });
  // Reply: add a quote of a message (or of the selected text) above what is being typed.
  bus.on("composer:quote", (text) => {
    const quote = toQuote(text);
    if (!quote) return;
    const before = textarea.value.replace(/\s+$/, "");
    textarea.value = `${before ? `${before}\n\n` : ""}${quote}\n\n`;
    autosize();
    saveDraft();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
    refresh();
  });
  bus.on("composer:focus", () => textarea.focus());
  bus.on("current", () => {
    loadDraft();
    refresh();
    if (!matchMedia("(pointer: coarse)").matches) textarea.focus({ preventScroll: true });
  });
  bus.on("meta", refresh);
  bus.on("catalog", refresh);
  bus.on("prefs", refresh);
  bus.on("live", (id) => { if (id === app.currentId) { refresh(); drainQueue(); } });
  bus.on("conv:update", (id) => { if (id === app.currentId) { refresh(); drainQueue(); } });
  loadDraft();
  refresh();
  return { focus: () => textarea.focus(), fill: (text) => bus.emit("composer:fill", text) };
}
