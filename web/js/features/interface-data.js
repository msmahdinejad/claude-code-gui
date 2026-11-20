// Reference data for the "Keyboard shortcuts" and "Themes" settings pages, taken from the Claude Code docs
// (keybindings.md and the "Create a custom theme" section of terminal-config.md). Nothing here touches the DOM, so it
// also loads in Node (test/interface-files.test.mjs). Descriptions are [English, Persian] pairs.
//
// This file registers nothing; it is only imported by settings-keybindings.js and settings-themes.js.

// ---- keyboard shortcuts --------------------------------------------------------------------------------------

/** Every documented context: [id, English, Persian]. */
export const KEY_CONTEXTS = [
  ["Global", "Applies everywhere in the app", "در کل برنامه اعمال می‌شود"],
  ["Chat", "Main chat input area", "ورودی اصلی گفتگو"],
  ["Autocomplete", "Autocomplete menu is open", "منوی تکمیل خودکار باز است"],
  ["Settings", "Settings menu", "منوی تنظیمات"],
  ["Confirmation", "Permission and confirmation dialogs", "پنجره‌های مجوز و تأیید"],
  ["Tabs", "Tab navigation components", "اجزای پیمایش تب‌ها"],
  ["Help", "Help menu is visible", "منوی راهنما نمایان است"],
  ["Transcript", "Transcript viewer", "نمایشگر رونوشت گفتگو"],
  ["HistorySearch", "History search mode (Ctrl+R)", "حالت جستجوی تاریخچه (Ctrl+R)"],
  ["Task", "A task is running in the foreground", "یک کار در پیش‌زمینه در حال اجراست"],
  ["ThemePicker", "Theme picker dialog", "پنجرهٔ انتخاب تم"],
  ["Attachments", "Image attachment navigation in select dialogs", "پیمایش پیوست‌های تصویر در پنجره‌های انتخاب"],
  ["Footer", "Footer indicator navigation (tasks, teams, diff, artifacts)", "پیمایش نشانگرهای پایین صفحه (کارها، تیم‌ها، تغییرات، آرتیفکت‌ها)"],
  ["MessageSelector", "Rewind and summarize dialog message selection", "انتخاب پیام در پنجرهٔ بازگشت و خلاصه‌سازی"],
  ["DiffDialog", "Diff viewer navigation", "پیمایش در نمایشگر تغییرات"],
  ["DiffPanel", "The diff panel is open", "پنل تغییرات باز است"],
  ["ModelPicker", "Model picker effort level", "سطح تلاش در انتخابگر مدل"],
  ["EffortSlider", "Effort slider opened by /effort", "لغزندهٔ تلاش که /effort باز می‌کند"],
  ["Select", "Generic select/list components", "اجزای عمومی انتخاب و فهرست"],
  ["Plugin", "Plugin dialog (browse, discover, manage)", "پنجرهٔ افزونه‌ها (مرور، کشف، مدیریت)"],
  ["AbovePrompt", "The band above the prompt, or a button in it, has keyboard focus", "نوار بالای پرامپت یا یک دکمهٔ آن فوکوس صفحه‌کلید دارد"],
  ["AbovePromptInput", "An input field in the band above the prompt or in a mod's pane has keyboard focus", "یک فیلد ورودی در نوار بالای پرامپت یا پنل یک مود فوکوس دارد"],
  ["AbovePromptSelect", "A select in the band above the prompt or in a mod's pane has keyboard focus", "یک انتخابگر در نوار بالای پرامپت یا پنل یک مود فوکوس دارد"],
  ["Pane", "A pane drawn by a mod has keyboard focus", "پنلی که یک مود کشیده فوکوس صفحه‌کلید دارد"],
  ["PaneField", "An input field or select in a mod's pane has keyboard focus", "یک فیلد یا انتخابگر در پنل یک مود فوکوس دارد"],
  ["Agents", "Agent view (claude agents)", "نمای ایجنت‌ها (claude agents)"],
  ["Scroll", "Conversation scrolling and text selection in fullscreen mode", "اسکرول گفتگو و انتخاب متن در حالت تمام‌صفحه"],
];

/**
 * Every documented action: [id, home contexts, English, Persian, legacy?].
 * "Home contexts" are where the docs list the action; the same action may be bound in another context too
 * (the docs reuse Select actions in MessageSelector / DiffDialog, for example), so the editor only suggests by home.
 */
export const KEY_ACTIONS = [
  // Global
  ["app:interrupt", ["Global"], "Cancel current operation", "لغو عملیات جاری"],
  ["app:exit", ["Global"], "Exit Claude Code (press twice within 800 ms to confirm)", "خروج از Claude Code (برای تأیید دو بار در ۸۰۰ میلی‌ثانیه فشار دهید)"],
  ["app:redraw", ["Global"], "Force terminal redraw", "بازکشی اجباری ترمینال"],
  ["app:toggleTodos", ["Global"], "Toggle visibility of Claude's to-do checklist (not the /tasks view)", "نمایش یا پنهان‌کردن فهرست کارهای Claude (نه نمای /tasks)"],
  ["app:toggleTranscript", ["Global"], "Toggle the verbose transcript", "روشن/خاموش کردن رونوشت مفصل"],
  ["app:toggleReplTab", ["Global"], "Open or close the diff panel (earlier diff panel only)", "باز یا بستن پنل تغییرات (فقط پنل قدیمی)"],
  ["app:diffFileListUp", ["Global"], "Scroll the diff panel's file list up when it overflows", "اسکرول فهرست فایل‌های پنل تغییرات به بالا"],
  ["app:diffFileListDown", ["Global"], "Scroll the diff panel's file list down when it overflows", "اسکرول فهرست فایل‌های پنل تغییرات به پایین"],
  ["app:toggleDiffNoiseFilter", ["Global"], "Show or hide test and generated files in the panel (earlier panel only)", "نمایش یا پنهان‌کردن فایل‌های آزمون و تولیدشده در پنل (فقط پنل قدیمی)"],
  ["app:toggleDiffPreSession", ["Global"], "Expand or collapse the changes from before this session (earlier panel only)", "باز یا بستن تغییرات قبل از این سشن (فقط پنل قدیمی)"],
  ["pane:next", ["Global"], "Show the next open pane (while more than one pane is open)", "نمایش پنل باز بعدی (وقتی بیش از یک پنل باز است)"],
  ["pane:previous", ["Global"], "Show the previous open pane (while more than one pane is open)", "نمایش پنل باز قبلی (وقتی بیش از یک پنل باز است)"],
  ["app:cycleDiffBase", ["DiffPanel"], "Cycle the panel's comparison base: this session, uncommitted, then branch", "چرخش مبنای مقایسهٔ پنل: این سشن، ثبت‌نشده، سپس شاخه"],
  // History (the docs do not say which context these belong to)
  ["history:search", [], "Open history search", "باز کردن جستجوی تاریخچه"],
  ["history:previous", [], "Previous history item", "مورد قبلی تاریخچه"],
  ["history:next", [], "Next history item", "مورد بعدی تاریخچه"],
  // Chat
  ["chat:cancel", ["Chat"], "Cancel current input", "لغو ورودی جاری"],
  ["chat:clearInput", ["Chat"], "Force a full screen redraw, preserving input and conversation", "بازکشی کامل صفحه با حفظ ورودی و گفتگو"],
  ["chat:clearScreen", ["Chat"], "Same as chat:clearInput", "مانند chat:clearInput"],
  ["chat:killAgents", ["Chat"], "Stop all running background subagents in this session and turn off artifact auto-replies (press twice within 3 s)", "توقف همهٔ زیرایجنت‌های پس‌زمینهٔ این سشن و خاموش‌کردن پاسخ خودکار آرتیفکت (دو بار در ۳ ثانیه)"],
  ["chat:cycleMode", ["Chat"], "Cycle permission modes", "چرخش بین حالت‌های مجوز"],
  ["chat:modelPicker", ["Chat"], "Open the model picker", "باز کردن انتخابگر مدل"],
  ["chat:fastMode", ["Chat"], "Toggle fast mode", "روشن/خاموش کردن حالت سریع"],
  ["chat:thinkingToggle", ["Chat"], "Toggle extended thinking", "روشن/خاموش کردن تفکر گسترده"],
  ["chat:submit", ["Chat"], "Submit the message", "ارسال پیام"],
  ["chat:queueSubmit", ["Chat"], "Submit the message, queued: it waits its turn and never interrupts the running turn (v2.1.247+)", "ارسال پیام در صف: منتظر نوبتش می‌ماند و نوبت جاری را قطع نمی‌کند (نسخهٔ 2.1.247 به بعد)"],
  ["chat:sendNow", ["Chat"], "Send your queued messages, and your draft with them, right away (v2.1.275+)", "ارسال فوری پیام‌های صف‌شده و پیش‌نویس (نسخهٔ 2.1.275 به بعد)"],
  ["chat:newline", ["Chat"], "Insert a newline without submitting", "درج خط جدید بدون ارسال"],
  ["chat:undo", ["Chat"], "Undo last action", "واگرد آخرین کار"],
  ["chat:externalEditor", ["Chat"], "Open the input in an external editor", "باز کردن ورودی در ویرایشگر بیرونی"],
  ["chat:stash", ["Chat"], "Stash the current prompt", "کنار گذاشتن پرامپت جاری"],
  ["chat:imagePaste", ["Chat"], "Paste an image from the clipboard (Ctrl+V; Alt+V on Windows and WSL)", "چسباندن تصویر از کلیپ‌بورد (Ctrl+V؛ در ویندوز و WSL کلید Alt+V)"],
  ["command:<name>", ["Chat"], "Run the slash command /<name>, for example \"meta+g\": \"command:compact\" runs /compact", "اجرای دستور اسلشی /<name>؛ مثلاً \"meta+g\": \"command:compact\" دستور /compact را اجرا می‌کند"],
  ["voice:pushToTalk", ["Chat"], "Dictate a prompt (hold or tap depending on /voice mode; needs voice dictation enabled)", "دیکته‌کردن پرامپت (نگه‌داشتن یا ضربه بسته به حالت /voice؛ نیازمند فعال‌بودن دیکته)"],
  ["abovePrompt:toggle", ["Chat"], "Collapse the band above the prompt to a one-row hint, or expand it again", "جمع‌کردن نوار بالای پرامپت به یک خط یا بازکردن دوباره"],
  ["abovePrompt:focus", ["Chat"], "Move keyboard focus into the band, then through each open pane, then back to the prompt", "انتقال فوکوس به نوار، سپس به هر پنل باز و در آخر بازگشت به پرامپت"],
  // Autocomplete
  ["autocomplete:accept", ["Autocomplete"], "Accept suggestion", "پذیرفتن پیشنهاد"],
  ["autocomplete:dismiss", ["Autocomplete"], "Dismiss the menu", "بستن منو"],
  ["autocomplete:previous", ["Autocomplete"], "Previous suggestion", "پیشنهاد قبلی"],
  ["autocomplete:next", ["Autocomplete"], "Next suggestion", "پیشنهاد بعدی"],
  // Confirmation
  ["confirm:yes", ["Confirmation"], "Confirm action", "تأیید"],
  ["confirm:no", ["Confirmation", "Settings"], "Decline action (closes the Settings panel; changes are already saved)", "رد کردن (در تنظیمات پنل را می‌بندد؛ تغییرات از قبل ذخیره شده‌اند)"],
  ["confirm:previous", ["Confirmation"], "Previous option", "گزینهٔ قبلی"],
  ["confirm:next", ["Confirmation"], "Next option", "گزینهٔ بعدی"],
  ["confirm:nextField", ["Confirmation"], "In the /fast dialog, turn fast mode on or off", "در پنجرهٔ /fast حالت سریع را روشن یا خاموش می‌کند"],
  ["confirm:previousField", ["Confirmation"], "Claude Code does not respond to this action; a file that names it stays valid", "Claude Code به این عمل پاسخ نمی‌دهد؛ فایلی که آن را نام ببرد معتبر می‌ماند"],
  ["confirm:toggle", ["Confirmation"], "Toggle selection", "تغییر انتخاب"],
  ["confirm:cycleMode", ["Confirmation"], "On a file permission prompt: close an open comment field, or allow the action for the rest of the session", "در درخواست مجوز فایل: بستن فیلد توضیح، یا اجازه‌دادن تا پایان سشن"],
  ["permission:toggleDebug", ["Confirmation"], "Claude Code does not respond to this action; a file that names it stays valid", "Claude Code به این عمل پاسخ نمی‌دهد؛ فایلی که آن را نام ببرد معتبر می‌ماند"],
  // Transcript
  ["transcript:toggleShowAll", ["Transcript"], "Toggle show all content (classic renderer only)", "نمایش یا پنهان‌کردن کل محتوا (فقط رندر کلاسیک)"],
  ["transcript:exit", ["Transcript"], "Exit transcript view", "خروج از نمای رونوشت"],
  // HistorySearch
  ["historySearch:next", ["HistorySearch"], "Next match", "نتیجهٔ بعدی"],
  ["historySearch:accept", ["HistorySearch"], "Accept selection", "پذیرفتن انتخاب"],
  ["historySearch:cancel", ["HistorySearch"], "Cancel search", "لغو جستجو"],
  ["historySearch:execute", ["HistorySearch"], "Execute the selected command", "اجرای فرمان انتخاب‌شده"],
  ["historySearch:cycleScope", ["HistorySearch"], "Cycle scope: session, project, everywhere (fullscreen rendering only)", "چرخش دامنه: سشن، پروژه، همه‌جا (فقط حالت تمام‌صفحه)"],
  // Task, ThemePicker, Help
  ["task:background", ["Task"], "Background the current task", "ارسال کار جاری به پس‌زمینه"],
  ["theme:toggleSyntaxHighlighting", ["ThemePicker"], "Toggle syntax highlighting", "روشن/خاموش کردن رنگ‌آمیزی نحو"],
  ["help:dismiss", ["Help"], "Close the help menu", "بستن منوی راهنما"],
  // Tabs, Attachments, Footer
  ["tabs:next", ["Tabs"], "Next tab", "تب بعدی"],
  ["tabs:previous", ["Tabs"], "Previous tab", "تب قبلی"],
  ["attachments:next", ["Attachments"], "Next attachment", "پیوست بعدی"],
  ["attachments:previous", ["Attachments"], "Previous attachment", "پیوست قبلی"],
  ["attachments:remove", ["Attachments"], "Remove the selected attachment", "حذف پیوست انتخاب‌شده"],
  ["attachments:exit", ["Attachments"], "Exit attachment navigation", "خروج از پیمایش پیوست‌ها"],
  ["footer:next", ["Footer"], "Next footer item", "مورد بعدی پایین صفحه"],
  ["footer:previous", ["Footer"], "Previous footer item", "مورد قبلی پایین صفحه"],
  ["footer:up", ["Footer"], "Navigate up in the footer (deselects at the top)", "حرکت به بالا در پایین صفحه (در بالاترین مورد انتخاب برداشته می‌شود)"],
  ["footer:down", ["Footer"], "Navigate down in the footer", "حرکت به پایین در پایین صفحه"],
  ["footer:openSelected", ["Footer"], "Open the selected footer item", "باز کردن مورد انتخاب‌شده"],
  ["footer:clearSelection", ["Footer"], "Clear the footer selection", "برداشتن انتخاب"],
  ["footer:close", ["Footer"], "Stop the selected agent or workflow, or dismiss its row if it is no longer running", "توقف ایجنت یا گردش‌کار انتخاب‌شده، یا حذف ردیف آن اگر دیگر اجرا نمی‌شود"],
  ["footer:dismiss", ["Footer"], "Binding a key to this action has no effect; a file that names it stays valid", "بستن کلید به این عمل اثری ندارد؛ فایلی که آن را نام ببرد معتبر می‌ماند"],
  // Diff dialog
  ["diff:dismiss", ["DiffDialog"], "Close the diff viewer; from the detail view, return to the file list", "بستن نمایشگر تغییرات؛ از نمای جزئیات به فهرست فایل‌ها برمی‌گردد"],
  ["diff:previousSource", ["DiffDialog"], "Previous diff source", "منبع قبلی تغییرات"],
  ["diff:nextSource", ["DiffDialog"], "Next diff source", "منبع بعدی تغییرات"],
  ["diff:previousFile", ["DiffDialog"], "Previous file in the list; scroll up one line in the detail view", "فایل قبلی در فهرست؛ در نمای جزئیات یک خط اسکرول به بالا"],
  ["diff:nextFile", ["DiffDialog"], "Next file in the list; scroll down one line in the detail view", "فایل بعدی در فهرست؛ در نمای جزئیات یک خط اسکرول به پایین"],
  ["diff:back", ["DiffDialog"], "Go back in the diff viewer (Escape already does this through diff:dismiss)", "بازگشت در نمایشگر تغییرات (Escape از طریق diff:dismiss همین کار را می‌کند)"],
  ["diff:viewDetails", ["DiffDialog"], "Older name: still works in the file list as select:accept", "نام قدیمی: در فهرست فایل‌ها هنوز مثل select:accept کار می‌کند", true],
  // Message selector (older names)
  ["messageSelector:up", ["MessageSelector"], "Older name: still works as the matching Select action", "نام قدیمی: هنوز به‌عنوان عمل Select متناظر کار می‌کند", true],
  ["messageSelector:down", ["MessageSelector"], "Older name: still works as the matching Select action", "نام قدیمی: هنوز به‌عنوان عمل Select متناظر کار می‌کند", true],
  ["messageSelector:top", ["MessageSelector"], "Older name: still works as the matching Select action", "نام قدیمی: هنوز به‌عنوان عمل Select متناظر کار می‌کند", true],
  ["messageSelector:bottom", ["MessageSelector"], "Older name: still works as the matching Select action", "نام قدیمی: هنوز به‌عنوان عمل Select متناظر کار می‌کند", true],
  ["messageSelector:select", ["MessageSelector"], "Older name: still works as the matching Select action", "نام قدیمی: هنوز به‌عنوان عمل Select متناظر کار می‌کند", true],
  // Scroll (Scroll context and the diff detail view)
  ["scroll:lineUp", ["Scroll"], "Scroll up one line (the mouse wheel triggers this)", "یک خط اسکرول به بالا (چرخ ماوس این را فعال می‌کند)"],
  ["scroll:lineDown", ["Scroll"], "Scroll down one line (the mouse wheel triggers this)", "یک خط اسکرول به پایین (چرخ ماوس این را فعال می‌کند)"],
  ["scroll:pageUp", ["Scroll", "DiffDialog"], "Scroll up half a viewport", "اسکرول نیم صفحه به بالا"],
  ["scroll:pageDown", ["Scroll", "DiffDialog"], "Scroll down half a viewport", "اسکرول نیم صفحه به پایین"],
  ["scroll:top", ["Scroll", "DiffDialog"], "Jump to the start", "پرش به ابتدا"],
  ["scroll:bottom", ["Scroll", "DiffDialog"], "Jump to the end (in Scroll: latest message, and re-enable auto-follow)", "پرش به انتها (در Scroll: آخرین پیام و فعال‌شدن دنبال‌کردن خودکار)"],
  ["scroll:halfPageUp", ["Scroll"], "Scroll up half the viewport; same as scroll:pageUp, for vi-style rebinds", "نیم صفحه به بالا؛ مثل scroll:pageUp، برای کلیدهای شبیه vi"],
  ["scroll:halfPageDown", ["Scroll"], "Scroll down half the viewport; same as scroll:pageDown, for vi-style rebinds", "نیم صفحه به پایین؛ مثل scroll:pageDown، برای کلیدهای شبیه vi"],
  ["scroll:fullPageUp", ["Scroll", "DiffDialog"], "Scroll up a full viewport", "یک صفحهٔ کامل به بالا"],
  ["scroll:fullPageDown", ["Scroll", "DiffDialog"], "Scroll down a full viewport", "یک صفحهٔ کامل به پایین"],
  ["selection:copy", ["Scroll"], "Copy the selected text to the clipboard", "کپی متن انتخاب‌شده در کلیپ‌بورد"],
  ["selection:clear", ["Scroll"], "Clear the active text selection (v2.1.234+)", "پاک‌کردن انتخاب متن (نسخهٔ 2.1.234 به بعد)"],
  ["selection:extendLeft", ["Scroll"], "Extend the selection one column left", "گسترش انتخاب یک ستون به چپ"],
  ["selection:extendRight", ["Scroll"], "Extend the selection one column right", "گسترش انتخاب یک ستون به راست"],
  ["selection:extendUp", ["Scroll"], "Extend the selection one row up (scrolls at the top edge)", "گسترش انتخاب یک سطر به بالا (در لبهٔ بالا اسکرول می‌شود)"],
  ["selection:extendDown", ["Scroll"], "Extend the selection one row down (scrolls at the bottom edge)", "گسترش انتخاب یک سطر به پایین (در لبهٔ پایین اسکرول می‌شود)"],
  ["selection:extendLineStart", ["Scroll"], "Extend the selection to the start of the line", "گسترش انتخاب تا ابتدای خط"],
  ["selection:extendLineEnd", ["Scroll"], "Extend the selection to the end of the line", "گسترش انتخاب تا انتهای خط"],
  // Model picker, effort slider
  ["modelPicker:decreaseEffort", ["ModelPicker"], "Decrease effort level", "کاهش سطح تلاش"],
  ["modelPicker:increaseEffort", ["ModelPicker"], "Increase effort level", "افزایش سطح تلاش"],
  ["modelPicker:thisSessionOnly", ["ModelPicker"], "Apply the highlighted model to this session only", "اعمال مدل انتخاب‌شده فقط برای این سشن"],
  ["effortSlider:decreaseEffort", ["EffortSlider"], "Move the slider to the next lower effort level (v2.1.284+)", "حرکت لغزنده به سطح تلاش پایین‌تر (نسخهٔ 2.1.284 به بعد)"],
  ["effortSlider:increaseEffort", ["EffortSlider"], "Move the slider to the next higher effort level (v2.1.284+)", "حرکت لغزنده به سطح تلاش بالاتر (نسخهٔ 2.1.284 به بعد)"],
  ["effortSlider:toggleUltracode", ["EffortSlider"], "Turn ultracode on or off for this session, when the slider offers it (v2.1.284+)", "روشن/خاموش کردن ultracode برای این سشن، وقتی لغزنده آن را عرضه می‌کند (نسخهٔ 2.1.284 به بعد)"],
  ["effortSlider:thisSessionOnly", ["EffortSlider"], "Apply the focused effort level to this session only (v2.1.257+)", "اعمال سطح تلاش انتخاب‌شده فقط برای این سشن (نسخهٔ 2.1.257 به بعد)"],
  // Select
  ["select:next", ["Select"], "Next option", "گزینهٔ بعدی"],
  ["select:previous", ["Select"], "Previous option", "گزینهٔ قبلی"],
  ["select:pageUp", ["Select"], "Move up one page of options", "یک صفحه بالاتر"],
  ["select:pageDown", ["Select"], "Move down one page of options", "یک صفحه پایین‌تر"],
  ["select:first", ["Select"], "First option", "اولین گزینه"],
  ["select:last", ["Select"], "Last option", "آخرین گزینه"],
  ["select:accept", ["Select", "Settings", "MessageSelector", "DiffDialog"], "Accept the selection", "پذیرفتن انتخاب"],
  ["select:cancel", ["Select"], "Cancel selection", "لغو انتخاب"],
  // Plugin
  ["plugin:toggle", ["Plugin"], "Toggle plugin selection", "انتخاب یا لغو انتخاب افزونه"],
  ["plugin:install", ["Plugin"], "Install selected plugins", "نصب افزونه‌های انتخاب‌شده"],
  ["plugin:favorite", ["Plugin"], "Favorite the selected plugin so it sorts near the top of the Installed tab", "علاقه‌مندی افزونهٔ انتخاب‌شده تا در تب نصب‌شده‌ها بالا بیاید"],
  // Above prompt
  ["abovePrompt:next", ["AbovePrompt", "AbovePromptInput", "AbovePromptSelect", "Pane"], "Focus the next control", "فوکوس روی کنترل بعدی"],
  ["abovePrompt:previous", ["AbovePrompt", "AbovePromptInput", "AbovePromptSelect", "Pane"], "Focus the previous control", "فوکوس روی کنترل قبلی"],
  ["abovePrompt:press", ["AbovePrompt", "AbovePromptInput", "AbovePromptSelect", "Pane"], "Press the focused button, submit the focused input, or pick the highlighted option", "فشردن دکمهٔ فوکوس‌شده، ثبت ورودی یا انتخاب گزینهٔ هایلایت‌شده"],
  ["abovePrompt:leave", ["AbovePrompt", "AbovePromptInput", "AbovePromptSelect", "Pane"], "Return keyboard focus to the prompt", "بازگرداندن فوکوس به پرامپت"],
  ["abovePrompt:highlightNext", ["AbovePromptSelect"], "Highlight the next option in a focused select", "هایلایت گزینهٔ بعدی در انتخابگر"],
  ["abovePrompt:highlightPrevious", ["AbovePromptSelect"], "Highlight the previous option in a focused select", "هایلایت گزینهٔ قبلی در انتخابگر"],
  // Pane
  ["pane:scrollUp", ["Pane", "AbovePrompt"], "Scroll the pane up when it has more rows than it can show", "اسکرول پنل به بالا"],
  ["pane:scrollDown", ["Pane", "AbovePrompt"], "Scroll the pane down when it has more rows than it can show", "اسکرول پنل به پایین"],
  ["pane:pageUp", ["Pane", "AbovePrompt"], "Scroll the pane up a page", "یک صفحه اسکرول پنل به بالا"],
  ["pane:pageDown", ["Pane", "AbovePrompt"], "Scroll the pane down a page", "یک صفحه اسکرول پنل به پایین"],
  ["pane:top", ["Pane", "AbovePrompt"], "Jump to the top of the pane", "پرش به بالای پنل"],
  ["pane:bottom", ["Pane", "AbovePrompt"], "Jump to the bottom of the pane", "پرش به پایین پنل"],
  ["pane:grow", ["Pane"], "Give the pane more room (width beside the transcript, height above the prompt)", "فضای بیشتر برای پنل (عرض کنار رونوشت، ارتفاع بالای پرامپت)"],
  ["pane:shrink", ["Pane"], "Give the pane less room", "فضای کمتر برای پنل"],
  ["pane:close", ["Pane", "PaneField"], "Close the pane", "بستن پنل"],
  // Settings
  ["settings:search", ["Settings"], "Enter search mode", "ورود به حالت جستجو"],
  ["settings:retry", ["Settings"], "Retry loading usage data on error", "تلاش دوباره برای بارگذاری داده‌های مصرف"],
  ["settings:fixUsage", ["Settings"], "Send your session the /usage recommendations Claude Code can apply (v2.1.305+)", "ارسال توصیه‌های /usage که Claude Code می‌تواند اعمال کند به سشن (نسخهٔ 2.1.305 به بعد)"],
  // Agents
  ["agents:switchView", ["Agents"], "Switch session grouping between state and directory (v2.1.257+)", "تغییر گروه‌بندی سشن‌ها بین وضعیت و پوشه (نسخهٔ 2.1.257 به بعد)"],
  ["agents:togglePin", ["Agents"], "Pin or unpin the selected session", "سنجاق‌کردن یا برداشتن سنجاق سشن انتخاب‌شده"],
  ["agents:find", ["Agents"], "Find sessions by name, with the n: filter (v2.1.288+)", "یافتن سشن‌ها با نام، با فیلتر n: (نسخهٔ 2.1.288 به بعد)"],
  ["agents:rename", ["Agents"], "Rename the selected session (v2.1.288+)", "تغییر نام سشن انتخاب‌شده (نسخهٔ 2.1.288 به بعد)"],
  ["agents:previousGroup", ["Agents"], "Jump to the previous group header (v2.1.288+)", "پرش به سرگروه قبلی (نسخهٔ 2.1.288 به بعد)"],
  ["agents:nextGroup", ["Agents"], "Jump to the next group header (v2.1.288+)", "پرش به سرگروه بعدی (نسخهٔ 2.1.288 به بعد)"],
];

/** Documented default bindings: [context, action, [keys...]]. An empty key list means the action is unbound by default. */
export const DEFAULT_BINDINGS = [
  ["Global", "app:interrupt", ["ctrl+c"]],
  ["Global", "app:exit", ["ctrl+d"]],
  ["Global", "app:redraw", []],
  ["Global", "app:toggleTodos", ["ctrl+t"]],
  ["Global", "app:toggleTranscript", ["ctrl+o"]],
  ["Global", "app:toggleReplTab", []],
  ["Global", "app:diffFileListUp", ["ctrl+up", "meta+up"]],
  ["Global", "app:diffFileListDown", ["ctrl+down", "meta+down"]],
  ["Global", "app:toggleDiffNoiseFilter", []],
  ["Global", "app:toggleDiffPreSession", []],
  ["Global", "pane:next", []],
  ["Global", "pane:previous", []],
  [null, "history:search", ["ctrl+r"]],
  [null, "history:previous", ["up"]],
  [null, "history:next", ["down"]],
  ["Chat", "chat:cancel", ["escape"]],
  ["Chat", "chat:clearInput", ["ctrl+l"]],
  ["Chat", "chat:clearScreen", ["cmd+k"]],
  ["Chat", "chat:killAgents", ["ctrl+x ctrl+k"]],
  ["Chat", "chat:cycleMode", ["shift+tab"]],
  ["Chat", "chat:modelPicker", ["meta+p"]],
  ["Chat", "chat:fastMode", ["meta+o"]],
  ["Chat", "chat:thinkingToggle", ["meta+t"]],
  ["Chat", "chat:submit", ["enter"]],
  ["Chat", "chat:queueSubmit", ["ctrl+x enter"]],
  ["Chat", "chat:sendNow", ["ctrl+enter", "ctrl+x ctrl+s"]],
  ["Chat", "chat:newline", ["ctrl+j"]],
  ["Chat", "chat:undo", ["ctrl+_", "ctrl+shift+-"]],
  ["Chat", "chat:externalEditor", ["ctrl+g", "ctrl+x ctrl+e"]],
  ["Chat", "chat:stash", ["ctrl+s"]],
  ["Chat", "chat:imagePaste", ["ctrl+v"]],
  ["Chat", "command:<name>", []],
  ["Chat", "voice:pushToTalk", ["space"]],
  ["Chat", "abovePrompt:toggle", ["ctrl+x ctrl+a"]],
  ["Chat", "abovePrompt:focus", ["ctrl+x tab"]],
  ["Autocomplete", "autocomplete:accept", ["tab"]],
  ["Autocomplete", "autocomplete:dismiss", ["escape"]],
  ["Autocomplete", "autocomplete:previous", ["up"]],
  ["Autocomplete", "autocomplete:next", ["down"]],
  ["Confirmation", "confirm:yes", ["enter"]],
  ["Confirmation", "confirm:no", ["escape"]],
  ["Confirmation", "confirm:previous", ["up"]],
  ["Confirmation", "confirm:next", ["down"]],
  ["Confirmation", "confirm:nextField", ["tab"]],
  ["Confirmation", "confirm:previousField", []],
  ["Confirmation", "confirm:toggle", ["space"]],
  ["Confirmation", "confirm:cycleMode", ["shift+tab"]],
  ["Confirmation", "permission:toggleDebug", []],
  ["Transcript", "transcript:toggleShowAll", ["ctrl+e"]],
  ["Transcript", "transcript:exit", ["q", "ctrl+c", "escape"]],
  ["HistorySearch", "historySearch:next", ["ctrl+r"]],
  ["HistorySearch", "historySearch:accept", ["escape", "tab"]],
  ["HistorySearch", "historySearch:cancel", ["ctrl+c"]],
  ["HistorySearch", "historySearch:execute", ["enter"]],
  ["HistorySearch", "historySearch:cycleScope", ["ctrl+s"]],
  ["Task", "task:background", ["ctrl+b", "ctrl+x ctrl+b"]],
  ["ThemePicker", "theme:toggleSyntaxHighlighting", ["ctrl+t"]],
  ["Help", "help:dismiss", ["escape"]],
  ["Tabs", "tabs:next", ["tab", "right"]],
  ["Tabs", "tabs:previous", ["shift+tab", "left"]],
  ["Attachments", "attachments:next", ["right"]],
  ["Attachments", "attachments:previous", ["left"]],
  ["Attachments", "attachments:remove", ["backspace", "delete"]],
  ["Attachments", "attachments:exit", ["down", "escape"]],
  ["Footer", "footer:next", ["right"]],
  ["Footer", "footer:previous", ["left"]],
  ["Footer", "footer:up", ["up", "ctrl+p"]],
  ["Footer", "footer:down", ["down", "ctrl+n"]],
  ["Footer", "footer:openSelected", ["enter"]],
  ["Footer", "footer:clearSelection", ["escape"]],
  ["Footer", "footer:close", ["x"]],
  ["Footer", "footer:dismiss", []],
  ["DiffDialog", "diff:dismiss", ["escape"]],
  ["DiffDialog", "diff:previousSource", ["left"]],
  ["DiffDialog", "diff:nextSource", ["right"]],
  ["DiffDialog", "diff:previousFile", ["up", "k"]],
  ["DiffDialog", "diff:nextFile", ["down", "j"]],
  ["DiffDialog", "diff:back", []],
  ["DiffDialog", "scroll:pageUp", ["pageup"]],
  ["DiffDialog", "scroll:pageDown", ["pagedown"]],
  ["DiffDialog", "scroll:fullPageUp", ["shift+space", "b"]],
  ["DiffDialog", "scroll:fullPageDown", ["space"]],
  ["DiffDialog", "scroll:top", ["g", "home"]],
  ["DiffDialog", "scroll:bottom", ["shift+g", "end"]],
  ["DiffPanel", "app:cycleDiffBase", ["ctrl+x b"]],
  ["ModelPicker", "modelPicker:decreaseEffort", ["left"]],
  ["ModelPicker", "modelPicker:increaseEffort", ["right"]],
  ["ModelPicker", "modelPicker:thisSessionOnly", ["s"]],
  ["EffortSlider", "effortSlider:decreaseEffort", ["left"]],
  ["EffortSlider", "effortSlider:increaseEffort", ["right"]],
  ["EffortSlider", "effortSlider:toggleUltracode", ["tab"]],
  ["EffortSlider", "effortSlider:thisSessionOnly", ["s"]],
  ["Select", "select:next", ["down", "j", "ctrl+n"]],
  ["Select", "select:previous", ["up", "k", "ctrl+p"]],
  ["Select", "select:pageUp", ["pageup"]],
  ["Select", "select:pageDown", ["pagedown"]],
  ["Select", "select:first", ["home"]],
  ["Select", "select:last", ["end"]],
  ["Select", "select:accept", ["enter"]],
  ["Select", "select:cancel", ["escape"]],
  ["Plugin", "plugin:toggle", ["space"]],
  ["Plugin", "plugin:install", ["i"]],
  ["Plugin", "plugin:favorite", ["f"]],
  ["AbovePrompt", "abovePrompt:next", ["tab", "right"]],
  ["AbovePrompt", "abovePrompt:previous", ["shift+tab", "left"]],
  ["AbovePrompt", "abovePrompt:press", ["enter", "space"]],
  ["AbovePrompt", "abovePrompt:leave", ["escape"]],
  ["AbovePrompt", "pane:scrollUp", ["up"]],
  ["AbovePrompt", "pane:scrollDown", ["down"]],
  ["AbovePrompt", "pane:pageUp", ["pageup"]],
  ["AbovePrompt", "pane:pageDown", ["pagedown"]],
  ["AbovePrompt", "pane:top", ["home"]],
  ["AbovePrompt", "pane:bottom", ["end"]],
  ["AbovePromptSelect", "abovePrompt:highlightNext", ["down"]],
  ["AbovePromptSelect", "abovePrompt:highlightPrevious", ["up"]],
  ["Pane", "pane:scrollUp", ["up"]],
  ["Pane", "pane:scrollDown", ["down"]],
  ["Pane", "pane:pageUp", ["pageup"]],
  ["Pane", "pane:pageDown", ["pagedown"]],
  ["Pane", "pane:top", ["home"]],
  ["Pane", "pane:bottom", ["end"]],
  ["Pane", "pane:grow", ["ctrl+x left", "ctrl+x up"]],
  ["Pane", "pane:shrink", ["ctrl+x right", "ctrl+x down"]],
  ["Pane", "pane:close", ["ctrl+x x"]],
  ["Pane", "abovePrompt:next", ["tab"]],
  ["Pane", "abovePrompt:previous", ["shift+tab"]],
  ["Pane", "abovePrompt:press", ["enter"]],
  ["Pane", "abovePrompt:leave", ["escape"]],
  ["PaneField", "pane:close", ["ctrl+x x"]],
  ["Settings", "settings:search", ["/"]],
  ["Settings", "settings:retry", ["r"]],
  ["Settings", "settings:fixUsage", ["f"]],
  ["Settings", "select:accept", ["enter", "space"]],
  ["Settings", "confirm:no", ["escape"]],
  ["Agents", "agents:switchView", ["ctrl+s"]],
  ["Agents", "agents:togglePin", ["ctrl+t"]],
  ["Agents", "agents:find", ["ctrl+f"]],
  ["Agents", "agents:rename", ["ctrl+r"]],
  ["Agents", "agents:previousGroup", ["ctrl+up", "meta+up"]],
  ["Agents", "agents:nextGroup", ["ctrl+down", "meta+down"]],
  ["Scroll", "scroll:lineUp", ["wheelup"]],
  ["Scroll", "scroll:lineDown", ["wheeldown"]],
  ["Scroll", "scroll:pageUp", ["pageup"]],
  ["Scroll", "scroll:pageDown", ["pagedown"]],
  ["Scroll", "scroll:top", ["ctrl+home"]],
  ["Scroll", "scroll:bottom", ["ctrl+end"]],
  ["Scroll", "scroll:halfPageUp", []],
  ["Scroll", "scroll:halfPageDown", []],
  ["Scroll", "scroll:fullPageUp", []],
  ["Scroll", "scroll:fullPageDown", []],
  ["Scroll", "selection:copy", ["ctrl+shift+c", "cmd+c"]],
  ["Scroll", "selection:clear", []],
  ["Scroll", "selection:extendLeft", ["shift+left"]],
  ["Scroll", "selection:extendRight", ["shift+right"]],
  ["Scroll", "selection:extendUp", ["shift+up"]],
  ["Scroll", "selection:extendDown", ["shift+down"]],
  ["Scroll", "selection:extendLineStart", ["shift+home"]],
  ["Scroll", "selection:extendLineEnd", ["shift+end"]],
];

/** Default chords on the ctrl+x prefix that have no action name in the docs (still unbindable with null). */
export const CTRL_X_EXTRA_CHORDS = ["ctrl+x ctrl+=", "ctrl+x ctrl+-", "ctrl+x ctrl+_", "ctrl+x =", "ctrl+x -"];

export const ACTION_IDS = new Set(KEY_ACTIONS.map((entry) => entry[0]));
export const CONTEXT_IDS = new Set(KEY_CONTEXTS.map((entry) => entry[0]));

/** A documented action name; `command:<name>` accepts any non-empty command name. */
export function isKnownAction(action) {
  if (typeof action !== "string") return false;
  if (ACTION_IDS.has(action)) return true;
  return /^command:[^\s:<>][^\s]*$/.test(action);
}

const MODIFIER_CANON = new Map([
  ["ctrl", "ctrl"], ["control", "ctrl"],
  ["shift", "shift"],
  ["alt", "alt"], ["opt", "alt"], ["option", "alt"], ["meta", "alt"],
  ["cmd", "cmd"], ["command", "cmd"], ["super", "cmd"], ["win", "cmd"],
]);
const MODIFIER_ORDER = ["ctrl", "shift", "alt", "cmd"];
const SPECIAL_KEYS = new Map([
  ["escape", "escape"], ["esc", "escape"], ["enter", "enter"], ["return", "enter"], ["tab", "tab"], ["space", "space"],
  ["up", "up"], ["down", "down"], ["left", "left"], ["right", "right"], ["pageup", "pageup"], ["pagedown", "pagedown"],
  ["home", "home"], ["end", "end"], ["backspace", "backspace"], ["delete", "delete"], ["wheelup", "wheelup"], ["wheeldown", "wheeldown"],
]);
const RESERVED = new Set(["ctrl+c", "ctrl+d", "ctrl+m", "ctrl+[", "ctrl+i", "ctrl+h"]);

const plain = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? vars[name] : `{${name}}`)) : text);

/**
 * Check a key string as the docs define it: keystrokes separated by spaces (a chord), each keystroke modifiers joined
 * with "+" and then a key. `t(text, vars)` translates the messages (the UI passes its own; the default is English).
 * Returns { errors, warnings, canonical }: errors block saving, warnings do not; `canonical` is for comparing chords
 * (case-insensitive, modifier aliases and key aliases folded), or "" when there are errors.
 */
export function validateChord(input, t = plain) {
  const errors = [];
  const warnings = [];
  const text = String(input ?? "").trim();
  if (!text) return { errors: [t("Enter a key, for example ctrl+k or ctrl+k ctrl+s.")], warnings, canonical: "" };
  if (/\+\s|\s\+/.test(text)) {
    errors.push(t("Remove the space next to “+”: a space separates the keystrokes of a chord, so “ctrl+ k” would be read as “ctrl+” then “k”."));
    return { errors, warnings, canonical: "" };
  }
  const steps = text.split(/\s+/);
  const canonicalSteps = [];
  let usesCmd = false;
  for (const step of steps) {
    const lower = step.toLowerCase();
    let modifierText;
    let keyText;
    if (/^\+[^+]/.test(lower)) {
      errors.push(t("“{step}” has an empty part around “+”.", { step }));
      continue;
    }
    if (lower === "+") {
      modifierText = "";
      keyText = "+";
    } else if (lower.endsWith("++")) {
      modifierText = lower.slice(0, -2);
      keyText = "+";
    } else {
      const cut = lower.lastIndexOf("+");
      modifierText = cut < 0 ? "" : lower.slice(0, cut);
      keyText = cut < 0 ? lower : lower.slice(cut + 1);
    }
    const modifiers = [];
    let stepOk = true;
    if (modifierText) {
      for (const word of modifierText.split("+")) {
        const canon = MODIFIER_CANON.get(word);
        if (!canon) {
          errors.push(word ? t("Unknown modifier “{name}”. Use ctrl, shift, alt (also opt, option, meta) or cmd (also command, super, win).", { name: word }) : t("“{step}” has an empty part around “+”.", { step }));
          stepOk = false;
        } else if (!modifiers.includes(canon)) modifiers.push(canon);
      }
    }
    if (!keyText) {
      errors.push(t("“{step}” ends with “+” but names no key.", { step }));
      stepOk = false;
    } else if (!SPECIAL_KEYS.has(keyText) && [...keyText].length !== 1) {
      warnings.push(t("“{name}” is not one of the documented key names (escape, enter, tab, space, up, down, left, right, pageup, pagedown, home, end, backspace, delete, wheelup, wheeldown), so Claude Code may ignore it.", { name: keyText }));
    }
    if (!stepOk) continue;
    if (modifiers.includes("cmd")) usesCmd = true;
    const key = SPECIAL_KEYS.get(keyText) || keyText;
    canonicalSteps.push([...MODIFIER_ORDER.filter((name) => modifiers.includes(name)), key].join("+"));
  }
  if (errors.length) return { errors, warnings, canonical: "" };
  const canonical = canonicalSteps.join(" ");
  if (canonicalSteps.length === 1 && RESERVED.has(canonical)) errors.push(t("{key} is reserved and cannot be rebound (Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I, Ctrl+H and Caps Lock).", { key: canonical }));
  if (canonical === "ctrl+b") warnings.push(t("Ctrl+B is the tmux prefix (press twice to send it)."));
  if (canonical === "ctrl+a") warnings.push(t("Ctrl+A is the GNU screen prefix."));
  if (canonical === "ctrl+z") warnings.push(t("Ctrl+Z suspends the process in a Unix shell."));
  if (usesCmd) warnings.push(t("cmd, command, super and win are only detected in terminals that report the Super modifier (such as Kitty keyboard protocol terminals); use ctrl or meta for bindings that must work everywhere."));
  return { errors, warnings, canonical: errors.length ? "" : canonical };
}

// ---- themes --------------------------------------------------------------------------------------------------

export const THEME_BASES = ["dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"];

const SUBAGENT_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
const RAINBOW_COLORS = ["red", "orange", "yellow", "green", "blue", "indigo", "violet"];

/** Documented color tokens by group: { id, title: [en, fa], tokens: [[name, English, Persian]] }. */
export const THEME_GROUPS = [
  {
    id: "text",
    title: ["Text and accent", "متن و رنگ تأکید"],
    tokens: [
      ["claude", "Primary brand accent: the spinner and the assistant label", "رنگ اصلی برند: چرخنده و برچسب دستیار"],
      ["text", "Default foreground text", "متن پیش‌فرض"],
      ["inverseText", "Text drawn on a colored background, such as status badges", "متن روی پس‌زمینهٔ رنگی، مثل نشان‌های وضعیت"],
      ["inactive", "Secondary text: hints, timestamps, disabled items", "متن ثانویه: راهنما، زمان، موارد غیرفعال"],
      ["subtle", "Faint borders, dividers and symbols", "کادرها، جداکننده‌ها و نمادهای کم‌رنگ"],
      ["suggestion", "Autocomplete suggestions and the selection highlight in pickers", "پیشنهادهای تکمیل خودکار و هایلایت انتخاب در انتخابگرها"],
      ["permission", "Dialog borders, including permission prompts and pickers", "کادر پنجره‌ها، از جمله درخواست مجوز و انتخابگرها"],
      ["remember", "Memory and CLAUDE.md indicators", "نشانگرهای حافظه و CLAUDE.md"],
    ],
  },
  {
    id: "status",
    title: ["Status colors", "رنگ‌های وضعیت"],
    tokens: [
      ["success", "Success messages and passing checks", "پیام‌های موفقیت و بررسی‌های موفق"],
      ["error", "Error messages and failures", "پیام‌های خطا و شکست"],
      ["warning", "Warnings, caution messages and the auto mode indicator", "هشدارها، پیام‌های احتیاط و نشانگر حالت خودکار"],
      ["merged", "Merged pull request status", "وضعیت pull request ادغام‌شده"],
    ],
  },
  {
    id: "input",
    title: ["Input box and mode indicators", "کادر ورودی و نشانگر حالت‌ها"],
    tokens: [
      ["promptBorder", "Input box border", "کادر ورودی"],
      ["planMode", "Plan mode accent, plan messages and plan-mode dialogs", "رنگ حالت برنامه‌ریزی، پیام‌ها و پنجره‌های آن"],
      ["autoAccept", "Accept-edits mode accent", "رنگ حالت پذیرش خودکار ویرایش‌ها"],
      ["bashBorder", "Input box border when entering a ! shell command", "کادر ورودی هنگام نوشتن فرمان شل با !"],
      ["ide", "IDE connection indicator", "نشانگر اتصال به IDE"],
      ["fastMode", "Fast mode indicator", "نشانگر حالت سریع"],
      ["effortUltra", "The ultracode tag on the input box border while ultracode is on (v2.1.239+)", "برچسب ultracode روی کادر ورودی وقتی روشن است (نسخهٔ 2.1.239 به بعد)"],
    ],
  },
  {
    id: "diff",
    title: ["Diff rendering", "نمایش تغییرات"],
    tokens: [
      ["diffAdded", "Background of added lines", "پس‌زمینهٔ خطوط افزوده‌شده"],
      ["diffRemoved", "Background of removed lines", "پس‌زمینهٔ خطوط حذف‌شده"],
      ["diffAddedDimmed", "Background of added lines in the dimmed diff shown after you reject an edit", "پس‌زمینهٔ خطوط افزوده‌شده در نمای کم‌رنگ پس از رد یک ویرایش"],
      ["diffRemovedDimmed", "Background of removed lines in the dimmed diff shown after you reject an edit", "پس‌زمینهٔ خطوط حذف‌شده در نمای کم‌رنگ پس از رد یک ویرایش"],
      ["diffAddedWord", "Word-level highlight within an added line", "هایلایت سطح کلمه در خط افزوده‌شده"],
      ["diffRemovedWord", "Word-level highlight within a removed line", "هایلایت سطح کلمه در خط حذف‌شده"],
    ],
  },
  {
    id: "fullscreen",
    title: ["Message backgrounds and fullscreen mode", "پس‌زمینهٔ پیام‌ها و حالت تمام‌صفحه"],
    tokens: [
      ["userMessageBackground", "Background behind your messages in the transcript", "پس‌زمینهٔ پیام‌های شما در رونوشت"],
      ["userMessageBackgroundHover", "Background behind a message while hovered or expanded (fullscreen only)", "پس‌زمینهٔ پیام هنگام hover یا بازشدن (فقط تمام‌صفحه)"],
      ["bashMessageBackgroundColor", "Background behind ! shell command entries in the transcript", "پس‌زمینهٔ فرمان‌های شل (!) در رونوشت"],
      ["memoryBackgroundColor", "Background behind # memory entries in the transcript", "پس‌زمینهٔ ورودی‌های حافظه (#) در رونوشت"],
      ["selectionBg", "Background of text selected with the mouse (fullscreen only)", "پس‌زمینهٔ متن انتخاب‌شده با ماوس (فقط تمام‌صفحه)"],
      ["composerSidebarBackground", "Background of the panel beside the conversation, such as the diff panel or a mod's pane (fullscreen only)", "پس‌زمینهٔ پنل کنار گفتگو، مثل پنل تغییرات یا پنل یک مود (فقط تمام‌صفحه)"],
    ],
  },
  {
    id: "usage",
    title: ["Usage meter and speaker labels", "نوار مصرف و برچسب گوینده"],
    tokens: [
      ["rate_limit_fill", "Filled portion of the usage meter", "بخش پرشدهٔ نوار مصرف"],
      ["rate_limit_empty", "Unfilled portion of the usage meter", "بخش خالی نوار مصرف"],
      ["briefLabelYou", "Color of the You label on your messages", "رنگ برچسب «You» روی پیام‌های شما"],
      ["briefLabelClaude", "Color of the Claude label on assistant messages", "رنگ برچسب «Claude» روی پیام‌های دستیار"],
    ],
  },
  {
    id: "shimmer",
    title: ["Shimmer variants (spinner animation)", "گونه‌های درخشان (انیمیشن چرخنده)"],
    tokens: [
      ["claudeShimmer", "Lighter color of claude in the spinner's animated gradient", "رنگ روشن‌تر claude در گرادیان متحرک چرخنده"],
      ["warningShimmer", "Lighter color of warning in the spinner's animated gradient", "رنگ روشن‌تر warning در گرادیان متحرک چرخنده"],
      ["permissionShimmer", "Lighter color of permission in the spinner's animated gradient", "رنگ روشن‌تر permission در گرادیان متحرک چرخنده"],
      ["promptBorderShimmer", "Lighter color of promptBorder in the spinner's animated gradient", "رنگ روشن‌تر promptBorder در گرادیان متحرک چرخنده"],
      ["inactiveShimmer", "Lighter color of inactive in the spinner's animated gradient", "رنگ روشن‌تر inactive در گرادیان متحرک چرخنده"],
      ["fastModeShimmer", "Lighter color of fastMode in the spinner's animated gradient", "رنگ روشن‌تر fastMode در گرادیان متحرک چرخنده"],
    ],
  },
  {
    id: "subagents",
    title: ["Subagent colors", "رنگ زیرایجنت‌ها"],
    tokens: SUBAGENT_COLORS.map((name) => [`${name}_FOR_SUBAGENTS_ONLY`, `How a subagent with color: ${name} is drawn`, `رنگ نمایش زیرایجنتی که color: ${name} دارد`]),
  },
  {
    id: "rainbow",
    title: ["Ultrathink rainbow", "رنگین‌کمان ultrathink"],
    tokens: RAINBOW_COLORS.flatMap((name) => [
      [`rainbow_${name}`, `${name[0].toUpperCase()}${name.slice(1)} step of the gradient on the word ultrathink in the prompt input`, `گام ${name} از گرادیان کلمهٔ ultrathink در ورودی`],
      [`rainbow_${name}_shimmer`, `Lighter ${name} step of that gradient`, `گام روشن‌تر ${name} از آن گرادیان`],
    ]),
  },
];

export const THEME_TOKENS = THEME_GROUPS.flatMap((group) => group.tokens);
export const THEME_TOKEN_IDS = new Set(THEME_TOKENS.map((entry) => entry[0]));

const ANSI_NAMES = {
  black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
  blackBright: "#666666", redBright: "#f14c4c", greenBright: "#23d18b", yellowBright: "#f5f543", blueBright: "#3b8eea", magentaBright: "#d670d6", cyanBright: "#29b8db", whiteBright: "#ffffff",
};
export const ANSI_COLOR_NAMES = Object.keys(ANSI_NAMES);

function ansi256ToHex(n) {
  if (n < 16) return ANSI_NAMES[ANSI_COLOR_NAMES[n]];
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    const hex = level.toString(16).padStart(2, "0");
    return `#${hex}${hex}${hex}`;
  }
  const index = n - 16;
  const part = (value) => (value === 0 ? 0 : 55 + value * 40).toString(16).padStart(2, "0");
  return `#${part(Math.floor(index / 36))}${part(Math.floor(index / 6) % 6)}${part(index % 6)}`;
}

/**
 * Check a theme color value (#rrggbb, #rgb, rgb(r,g,b), ansi256(n), ansi:<name>). Returns { ok, css } where css is a
 * CSS color for the swatch (ANSI colors are approximated: terminals draw them from their own palette).
 */
export function parseThemeColor(value) {
  const text = String(value ?? "").trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return { ok: true, css: text.toLowerCase(), kind: "hex" };
  const match = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(text);
  if (match) {
    const parts = match.slice(1).map(Number);
    if (parts.every((part) => part <= 255)) return { ok: true, css: `rgb(${parts.join(",")})`, kind: "rgb" };
    return { ok: false, css: null };
  }
  const ansi = /^ansi256\(\s*(\d{1,3})\s*\)$/i.exec(text);
  if (ansi) {
    const n = Number(ansi[1]);
    return n <= 255 ? { ok: true, css: ansi256ToHex(n), kind: "ansi256" } : { ok: false, css: null };
  }
  const named = /^ansi:([A-Za-z]+)$/.exec(text);
  if (named && named[1] in ANSI_NAMES) return { ok: true, css: ANSI_NAMES[named[1]], kind: "ansi" };
  return { ok: false, css: null };
}

/** Normalize a #rgb / #rrggbb value to #rrggbb (for an <input type="color">), or null. */
export function hexForPicker(value) {
  const text = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() : null;
}

/**
 * Check a parsed keybindings.json against the docs' validation list (unknown contexts and actions, misspelled
 * modifiers, reserved keys, duplicates in one context). Returns [{ level: "error" | "warn", text }]; none of these
 * stop Claude Code from starting, it only ignores the offending binding. `t(text, vars)` translates the messages.
 */
export function lintKeybindings(doc, t = plain) {
  const problems = [];
  const blocks = doc && Array.isArray(doc.bindings) ? doc.bindings : [];
  const seen = new Map();
  blocks.forEach((block) => {
    if (!block || typeof block !== "object" || typeof block.bindings !== "object" || !block.bindings) return;
    const context = String(block.context);
    if (!CONTEXT_IDS.has(context)) problems.push({ level: "warn", text: t("Unknown context “{context}”: Claude Code ignores that block.", { context }) });
    for (const [key, action] of Object.entries(block.bindings)) {
      const check = validateChord(key, t);
      if (check.errors.length) {
        problems.push({ level: "error", text: t("“{key}” in {context} is ignored: {problem}", { key, context, problem: check.errors[0] }) });
        continue;
      }
      if (action !== null && !isKnownAction(action)) problems.push({ level: "warn", text: t("Unknown action “{action}” in {context}: the binding is skipped and the default for “{key}” stays.", { action: String(action), context, key }) });
      const id = `${context}\n${check.canonical}`;
      if (seen.has(id)) problems.push({ level: "warn", text: t("“{key}” is bound more than once in {context}.", { key, context }) });
      seen.set(id, true);
    }
  });
  return problems;
}

/** A theme's file name (without .json): letters, digits, "-" and "_" only, as the server requires. */
export const THEME_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const validThemeSlug = (name) => THEME_SLUG_RE.test(String(name)) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(String(name));
