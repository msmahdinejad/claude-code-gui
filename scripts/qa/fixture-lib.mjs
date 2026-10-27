// Synthetic conversation used by the QA/screenshot scripts (no model call).
export async function installFixture(page, { cwd = "", sessions = [] } = {}) {
  await page.evaluate(async (cwdArg, sessionList) => {
    const { app, bus } = await import("/js/core/state.js");
    const { createConversation, applyMessage } = await import("/js/chat/reducer.js");
    const conv = createConversation("fixture");
    conv.cwd = cwdArg || app.config.defaultCwd;
    if (sessionList.length) { app.sessions = sessionList; bus.emit("sessions"); }
    conv.state = "idle";
    app.convs.set("fixture", conv);
    const uid = () => crypto.randomUUID();
    const user = (text) => applyMessage(conv, { type: "user", uuid: uid(), message: { role: "user", content: text } }, { live: false });
    const asst = (id, content) => applyMessage(conv, { type: "assistant", uuid: uid(), parent_tool_use_id: null, message: { id, role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: "end_turn" } });
    const result = (toolId, text, isError = false) => applyMessage(conv, { type: "user", uuid: uid(), parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: text, is_error: isError }] } });

    user("سلام! لطفاً تابع `slugify` در فایل utils.py را اصلاح کن تا حروف فارسی را هم درست پشتیبانی کند و تست‌هایش را هم اجرا کن.");
    asst("m1", [
      { type: "thinking", thinking: "کاربر می‌خواهد slugify حروف فارسی را حفظ کند. اول فایل را می‌خوانم." },
      { type: "text", text: "حتماً. اول فایل را می‌خوانم تا ببینم الان چطور کار می‌کند." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/utils.py" } },
    ]);
    result("t1", "1\timport re\n2\t\n3\tdef slugify(text):\n4\t    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')");
    asst("m2", [
      { type: "text", text: "مشکل از regex است؛ حروف غیر ASCII حذف می‌شوند. این‌طور اصلاحش می‌کنم:" },
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/utils.py", old_string: "    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')", new_string: "    text = text.replace('\\u200c', '-')\n    return re.sub(r'[^\\w]+', '-', text.lower(), flags=re.UNICODE).strip('-')" } },
    ]);
    result("t2", "The file src/utils.py has been updated.");
    asst("m3", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "python -m pytest -q", description: "Run the test suite" } }]);
    result("t3", "..........                                                     [100%]\n10 passed in 0.31s");
    asst("m4", [
      { type: "tool_use", id: "t4", name: "TodoWrite", input: { todos: [{ content: "اصلاح slugify", status: "completed", activeForm: "در حال اصلاح" }, { content: "نوشتن تست برای نیم‌فاصله", status: "in_progress", activeForm: "در حال نوشتن تست" }, { content: "به‌روزرسانی README", status: "pending", activeForm: "" }] } },
    ]);
    result("t4", "Todos have been modified successfully");
    asst("m5", [{ type: "text", text: "## نتیجه\n\nتابع حالا حروف فارسی را نگه می‌دارد و **نیم‌فاصله** (ZWNJ) را به `-` تبدیل می‌کند. تغییرات:\n\n- regex از `[^a-z0-9]` به `[^\\w]` تغییر کرد\n- پرچم `re.UNICODE` اضافه شد\n- ۱۰ تست با موفقیت اجرا شد\n\n| ورودی | خروجی |\n|---|---|\n| `سلام دنیا` | `سلام-دنیا` |\n| `می‌روم` | `می-روم` |\n\n```python\ndef slugify(text):\n    text = text.replace('\\u200c', '-')\n    return re.sub(r'[^\\w]+', '-', text.lower(), flags=re.UNICODE).strip('-')\n```\n\n> نکته: برای URL فارسی بهتر است از `urllib.parse.quote` استفاده شود." }]);
    applyMessage(conv, { type: "result", uuid: uid(), subtype: "success", is_error: false, total_cost_usd: 0.0412, duration_ms: 18400, num_turns: 4, usage: { input_tokens: 21000, output_tokens: 640, cache_read_input_tokens: 80000 }, permission_denials: [] });
    user("Thanks! Can you also add an English README section explaining the change?");
    asst("m6", [{ type: "text", text: "Sure — here's a short section you can drop into the README:\n\n### Unicode slugs\n\n`slugify()` now keeps Persian and other non-ASCII letters, and converts the zero-width non-joiner (U+200C) into `-`.\n\n1. Install the package\n2. Call `slugify('سلام دنیا')`\n3. Expect `سلام-دنیا`" }]);
    asst("m7", [{ type: "tool_use", id: "t5", name: "Bash", input: { command: "git commit -am \"fix: unicode slugify\"", description: "Commit the change" } }]);
    applyMessage(conv, { type: "wh_request", request: { id: "r1", kind: "permission", toolName: "Bash", toolUseID: "t5", input: { command: "git commit -am \"fix: unicode slugify\"", description: "Commit the change" }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git commit:*" }], behavior: "allow", destination: "localSettings" }], decisionReason: "Commits change repository history." } });
    app.currentId = "fixture";
    app.currentCwd = conv.cwd;
    bus.emit("current");
  }, cwd, sessions);
}
