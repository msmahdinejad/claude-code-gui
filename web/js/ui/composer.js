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
import { openHistoryPicker, isShellInput, createLocalRuns, createLimitBanner } from "../features/input-more.js";
import { saveDraft as storeDraft, loadDraft as fetchDraft, localText, flushDrafts } from "../core/drafts.js";
import { outboxOf, mustQueue, enqueue, unqueue, sendQueuedNow, resumeOutbox } from "../core/outbox.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 500 * 1024;
// Text and code files are told apart by extension: browsers leave file.type empty for most of them.
const TEXT_EXTENSIONS = new Set("txt md markdown rst json jsonc json5 yaml yml toml xml csv tsv log ini cfg conf env properties js mjs cjs jsx ts tsx mts cts py rb go rs java kt kts scala c h cc cpp cxx hpp cs php sh bash zsh fish ps1 psm1 bat cmd sql html htm css scss sass less vue svelte astro swift lua r pl dart ex exs erl hs clj tex diff patch graphql gql proto tf dockerfile gitignore editorconfig lock".split(" "));
const FILE_ACCEPT = ["image/*", "application/pdf", "text/*", ...[...TEXT_EXTENSIONS].map((ext) => `.${ext}`)].join(",");

const extensionOf = (name) => (String(name).includes(".") ? String(name).split(".").pop().toLowerCase() : String(name).toLowerCase());
/** "image" | "pdf" | "text" | null for a file the composer can attach. */
function fileKind(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || extensionOf(file.name) === "pdf") return "pdf";
  if (file.type.startsWith("text/") || ["application/json", "application/xml", "application/x-yaml", "application/javascript"].includes(file.type) || TEXT_EXTENSIONS.has(extensionOf(file.name))) return "text";
  return null;
}
const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

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
  const fileInput = h("input", { type: "file", accept: FILE_ACCEPT, multiple: true, class: "hidden", onchange: () => { addFiles([...fileInput.files]); fileInput.value = ""; } });
  const hint = h("div.footer-hint");
  const limitBanner = createLimitBanner();
  const localRuns = createLocalRuns({ onSend: (text) => sendContext(text) });
  const root = h("div.composer", limitBanner.el, localRuns.el, attachments, queueBox, textarea, h("div.cmp-bar", plusBtn, modeBtn, h("span.grow"), effortBtn, modelBtn, micBtn, sendBtn), fileInput);
  host.replaceChildren(root, hint);

  let images = []; // every attachment: {mediaType, data (base64), name, size}; pictures, PDFs and text files
  // Messages waiting to be sent live on the server (core/outbox.js): they survive restarts and are sent even when this
  // conversation is not on screen or no window is open.
  let shownId = null; // the conversation the composer is currently showing
  let ac = null; // autocomplete popover state
  let dictation = null;

  // ---- draft persistence (core/drafts.js: on the server, with the text also kept in this browser) ----
  let edited = false; // the box changed since this conversation's draft was loaded: a late server answer must not overwrite it
  let loadToken = 0;
  let imagesLoaded = false; // the server's draft (with its attachments) has been read for the conversation on screen
  let imagesChanged = false; // attachments were added or removed since the last save that carried them
  function saveDraft() {
    edited = true;
    if (!shownId) return;
    // Attachments are only sent when they changed (and once the server's were read): typing does not re-upload them.
    if (imagesChanged && imagesLoaded) {
      storeDraft(shownId, { text: textarea.value, images });
      imagesChanged = false;
    } else {
      storeDraft(shownId, { text: textarea.value, keepImages: true });
    }
  }
  const attachmentsChanged = () => { imagesChanged = true; };
  function loadDraft() {
    // "current" is also emitted for a rename, a reload or the window coming back: only a real switch resets the input.
    if (shownId !== app.currentId) {
      flushDrafts(); // what was typed in the conversation we leave goes out now
      shownId = app.currentId;
      recall = null;
      edited = false;
      imagesLoaded = !shownId;
      imagesChanged = false;
      textarea.value = shownId ? localText(shownId) : "";
      images = [];
      renderAttachments();
      autosize();
      const id = shownId;
      const token = ++loadToken;
      if (id) {
        fetchDraft(id).then((draft) => {
          if (shownId !== id || token !== loadToken) return;
          imagesLoaded = true;
          if (imagesChanged) saveDraft(); // attachments added while we waited go out now
          if (edited) return;
          if (draft.text === textarea.value && !draft.images?.length) return;
          textarea.value = draft.text || "";
          images = draft.images || [];
          renderAttachments();
          autosize();
          refresh();
        }).catch(() => { if (shownId === id && token === loadToken) imagesLoaded = true; });
      }
    }
    renderQueue();
    localRuns.update();
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
    const shell = isShellInput(textarea.value) && !images.length;
    root.classList.toggle("shell-mode", shell);
    const queues = hasContent && !busy && mustQueue(app.currentId);
    sendBtn.title = shell ? t("Run on this machine") : busy && !hasContent ? t("Stop") : busy || queues ? t("Queue message") : t("Send");
    limitBanner.update();
    hint.textContent = shell ? t("Shell mode: Enter runs the command on this machine. Nothing is sent to Claude.") : app.prefs.sendKey === "enter" ? t("Enter to send · Shift+Enter for a new line · / for commands · @ for files") : t("Ctrl+Enter to send · / for commands · @ for files");
    micBtn.classList.toggle("active", Boolean(dictation));
  }

  // ---- attachments ----
  function renderAttachments() {
    attachments.classList.toggle("hidden", !images.length);
    attachments.replaceChildren(
      ...images.map((image, index) => {
        const remove = h("button", { type: "button", title: t("Remove"), onclick: () => { images.splice(index, 1); renderAttachments(); attachmentsChanged(); saveDraft(); refresh(); } }, icon("x", 11));
        if (image.mediaType.startsWith("image/")) return h("div.cmp-attach", h("img", { src: `data:${image.mediaType};base64,${image.data}`, alt: image.name }), remove);
        return h("div.cmp-attach.file", { title: image.name }, icon(image.mediaType === "application/pdf" ? "file" : "file-text", 16), h("span.cmp-file-name", { dir: "auto" }, image.name), image.size ? h("span.cmp-file-size", formatSize(image.size)) : null, remove);
      }),
    );
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ mediaType: file.type || "image/png", name: file.name || "image", size: file.size, data: String(reader.result).split(",")[1] });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    for (const file of files) {
      const kind = fileKind(file);
      if (!kind) {
        toast(t("This file type cannot be attached. Pictures, PDFs and text or code files work; use @ to reference other files by path."), "error");
        continue;
      }
      if (kind === "image" && file.size > MAX_IMAGE_BYTES) {
        toast(t("Image is too large (max 12 MB)."), "error");
        continue;
      }
      if (kind === "pdf" && file.size > MAX_PDF_BYTES) {
        toast(t("{name} is too large (PDF: max 10 MB).", { name: file.name }), "error");
        continue;
      }
      if (kind === "text") {
        if (file.size > MAX_TEXT_BYTES) {
          toast(t("{name} is too large (text: max 500 KB).", { name: file.name }), "error");
          continue;
        }
        const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        if (head.includes(0)) { // a binary file with a text-like name
          toast(t("{name} is not a text file.", { name: file.name }), "error");
          continue;
        }
      }
      try {
        const item = await readFile(file);
        if (kind === "pdf") item.mediaType = "application/pdf";
        else if (kind === "text") item.mediaType = "text/plain";
        images.push(item);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }
    renderAttachments();
    attachmentsChanged();
    saveDraft();
    refresh();
  }

  textarea.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => fileKind(file));
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

  // ---- queue (kept by the server) ----
  const describe = (entry) => entry.text || ((entry.attachments || []).every((file) => String(file.mediaType).startsWith("image/")) ? t("(image)") : t("(attachment)"));
  const act = (work) => work().catch((error) => toast(errorMessage(error), "error"));

  function renderQueue() {
    const id = app.currentId;
    const box = outboxOf(id);
    const items = box?.items || [];
    const rows = items.map((entry) =>
      h(
        "div.queue-item",
        icon("clock", 13),
        h("span", { dir: "auto", title: entry.text || "" }, describe(entry)),
        h("button.mini", { type: "button", title: t("Edit"), onclick: () => act(() => editQueued(id, entry.id)) }, icon("edit", 13)),
        h("button.mini", { type: "button", title: t("Send now (interrupt)"), onclick: () => act(() => sendQueuedNow(id, entry.id)) }, icon("zap", 13)),
        h("button.mini", { type: "button", title: t("Remove"), onclick: () => act(() => unqueue(id, entry.id)) }, icon("x", 13)),
      ),
    );
    if (box?.stopped && box.paused && !box.error && items.length) {
      rows.push(h(
        "div.queue-item.queue-paused",
        icon("clock", 13),
        h("span", { dir: "auto" }, t("Paused because you stopped Claude. Sending a new message resumes it too.")),
        h("button.btn.small", { type: "button", onclick: () => act(() => resumeOutbox(id)) }, t("Resume")),
      ));
    }
    if (box?.error && (items.length || box.continueDue)) {
      rows.push(h(
        "div.queue-item.queue-error",
        icon("alert", 13),
        h("span", { dir: "auto", title: box.error.message }, box.paused ? t("Could not send: {error}", { error: t(box.error.message) }) : t("Could not send, trying again: {error}", { error: t(box.error.message) })),
        box.paused ? h("button.btn.small", { type: "button", onclick: () => act(() => resumeOutbox(id)) }, t("Try again")) : null,
      ));
    }
    queueBox.classList.toggle("hidden", !rows.length);
    queueBox.replaceChildren(...rows);
  }

  /** Take a waiting message back into the box to change it (it is queued again like any new message). */
  async function editQueued(id, itemId) {
    const item = await unqueue(id, itemId);
    if (!item) return;
    if (shownId !== id) {
      // Another conversation is on screen now: the message goes into its own conversation's draft instead of being lost.
      const before = localText(id).trim();
      const text = before ? `${item.text}\n\n${before}` : item.text;
      storeDraft(id, item.images?.length ? { text, images: item.images } : { text, keepImages: true });
      return;
    }
    const typed = textarea.value.trim();
    textarea.value = typed ? `${item.text}\n\n${textarea.value}` : item.text;
    images = [...(item.images || []), ...images];
    renderAttachments();
    autosize();
    attachmentsChanged();
    saveDraft();
    refresh();
    focusInput();
  }

  async function queueMessage(entry) {
    try {
      await enqueue(app.currentId, entry);
    } catch (error) {
      toast(errorMessage(error), "error");
      handBack(entry.text, entry.images);
    }
  }

  // ---- sending ----
  async function deliver(text, imgs) {
    try {
      await session.sendMessage(text, imgs);
    } catch {
      handBack(text, imgs); // the controller already showed the error
    }
  }

  /** A message that could not be sent or queued goes back into the box, so nothing typed is lost. */
  function handBack(text, imgs) {
    if (!textarea.value.trim() && !images.length) {
      textarea.value = text;
      images = imgs;
    } else {
      textarea.value = textarea.value.trim() ? `${text}\n\n${textarea.value}` : text;
      images = [...imgs, ...images];
    }
    renderAttachments();
    autosize();
    if (imgs.length) attachmentsChanged();
    saveDraft();
    refresh();
  }

  async function submit() {
    const conv = currentConv();
    const busy = conv ? isBusy(conv) && conv.state !== "starting" : false;
    const text = textarea.value.trim();
    if (!text && !images.length) {
      if (busy) session.interrupt();
      return;
    }
    if (isShellInput(text) && !images.length) {
      const command = text.slice(1).trim();
      if (!command) return;
      if (await localRuns.run(command)) clearInput();
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
    // Claude is working, a usage limit holds the session, or earlier messages still wait: this one queues behind them.
    if (mustQueue(app.currentId)) {
      await queueMessage(entry);
      return;
    }
    await deliver(entry.text, entry.images);
  }

  // The output of a local command, sent on purpose with its button: queued like any message while Claude is working.
  async function sendContext(text) {
    if (mustQueue(app.currentId)) {
      await queueMessage({ text, images: [] });
      return;
    }
    await deliver(text, []);
  }

  function clearInput() {
    recall = null;
    textarea.value = "";
    if (images.length) attachmentsChanged();
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
      const pop = popover(textarea, list, { placement: "top-start", className: "ac-popover", offset: 10, focus: false, onClose: () => { ac = null; } });
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

  // ---- earlier messages: Up/Down in the box walks through what was sent in this conversation, like the CLI ----
  let recall = null; // { index, draft } while stepping through earlier messages; draft is what was being typed

  function sentMessages() {
    const texts = (currentConv()?.items || []).filter((item) => item.kind === "user" && item.text).map((item) => item.text);
    return texts.filter((text, index) => text !== texts[index - 1]);
  }

  function recallMessage(direction) {
    const history = sentMessages();
    const start = textarea.selectionStart;
    const collapsed = start === textarea.selectionEnd;
    if (!collapsed) return false;
    if (direction < 0) {
      // Only from the very start of the box (Up first moves the caret there), or while already stepping.
      if (!recall && start !== 0) return false;
      if (recall && textarea.value.slice(0, start).includes("\n")) return false;
      if (!history.length) return false;
      if (!recall) recall = { index: history.length, draft: textarea.value };
      recall.index = Math.max(0, recall.index - 1);
    } else {
      if (!recall || textarea.value.slice(start).includes("\n")) return false;
      recall.index += 1;
    }
    const restored = recall.index >= history.length;
    textarea.value = restored ? recall.draft : history[recall.index];
    if (restored) recall = null;
    closeAc();
    autosize();
    refresh();
    // Going back leaves the caret at the top, so the next Up keeps stepping; going forward leaves it at the end.
    const caret = direction < 0 ? 0 : textarea.value.length;
    textarea.setSelectionRange(caret, caret);
    textarea.scrollTop = direction < 0 ? 0 : textarea.scrollHeight;
    return true;
  }

  textarea.addEventListener("input", () => {
    recall = null;
    autosize();
    saveDraft();
    refresh();
    updateAutocomplete();
  });
  function insertHistory(text) {
    const before = textarea.value.replace(/\s+$/, "");
    textarea.value = before ? `${before}\n\n${text}` : text;
    recall = null;
    autosize();
    saveDraft();
    refresh();
    focusInput();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function openHistory() {
    closeAc();
    openHistoryPicker({ cwd: currentConv()?.cwd || app.currentCwd, onPick: insertHistory });
  }

  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !event.isComposing && (event.code === "KeyR" || event.key.toLowerCase() === "r")) {
      event.preventDefault(); // not the browser's reload: Ctrl+R searches earlier prompts, like in Claude Code
      openHistory();
      return;
    }
    if (ac && ["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(event.key) && !event.isComposing) {
      if (event.key === "ArrowDown") { event.preventDefault(); moveAc(1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); moveAc(-1); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) { event.preventDefault(); ac.onPick(ac.items[ac.index]); return; }
      if (event.key === "Escape") { event.preventDefault(); closeAc(); return; }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.isComposing && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (recallMessage(event.key === "ArrowUp" ? -1 : 1)) {
        event.preventDefault();
        return;
      }
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
      { label: t("Attach file or image"), icon: "paperclip", onClick: () => fileInput.click() },
      { label: t("Mention a file (@)"), icon: "at", onClick: () => { textarea.value += (textarea.value && !/\s$/.test(textarea.value) ? " " : "") + "@"; textarea.focus(); updateAutocomplete(); } },
      { label: t("Slash commands (/)"), icon: "slash", onClick: () => { textarea.value = "/"; textarea.focus(); updateAutocomplete(); } },
      { label: t("Earlier prompts"), icon: "history", hint: "Ctrl+R", onClick: openHistory },
      { label: t("Run a command here (!)"), icon: "terminal", onClick: () => { textarea.value = "!"; textarea.focus(); autosize(); refresh(); } },
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

  // Focus the box now and once more after the click that asked for it has finished (a button that was just clicked
  // can take the focus back), so one can type straight away.
  function focusInput() {
    textarea.focus({ preventScroll: true });
    requestAnimationFrame(() => { if (document.activeElement !== textarea) textarea.focus({ preventScroll: true }); });
  }

  bus.on("composer:fill", (text) => {
    textarea.value = text;
    autosize();
    saveDraft();
    focusInput();
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
    focusInput();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
    refresh();
  });
  bus.on("composer:focus", focusInput);
  bus.on("current", () => {
    loadDraft();
    refresh();
    if (!matchMedia("(pointer: coarse)").matches) textarea.focus({ preventScroll: true });
  });
  bus.on("meta", refresh);
  bus.on("catalog", refresh);
  bus.on("prefs", refresh);
  bus.on("live", (id) => { if (id === app.currentId) { refresh(); renderQueue(); } });
  bus.on("conv:update", (id) => { if (id === app.currentId) refresh(); });
  loadDraft();
  refresh();
  return { focus: () => textarea.focus(), fill: (text) => bus.emit("composer:fill", text) };
}
