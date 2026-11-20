import test from "node:test";
import assert from "node:assert/strict";
import { applyMessage, createConversation, loadHistory, userItems } from "../web/js/chat/reducer.js";

const stream = (event) => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s" });
const assistant = (id, content, extra = {}) => ({ type: "assistant", uuid: crypto.randomUUID(), session_id: "s", parent_tool_use_id: null, message: { id, role: "assistant", model: "m", content, ...extra } });
const userResult = (toolUseId, content, isError = false) => ({ type: "user", uuid: crypto.randomUUID(), session_id: "s", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } });

test("streamed text is replaced by the final assistant message without duplication", () => {
  const conv = createConversation("s");
  applyMessage(conv, stream({ type: "message_start", message: { id: "msg1", model: "m" } }));
  applyMessage(conv, stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "سلام " } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "دنیا" } }));
  assert.equal(conv.items.length, 1);
  assert.equal(conv.items[0].blocks[0].text, "سلام دنیا");
  assert.equal(conv.items[0].streaming, true);
  applyMessage(conv, stream({ type: "content_block_stop", index: 0 }));
  applyMessage(conv, assistant("msg1", [{ type: "text", text: "سلام دنیا!" }], { stop_reason: "end_turn" }));
  assert.equal(conv.items.length, 1);
  assert.equal(conv.items[0].blocks.length, 1);
  assert.equal(conv.items[0].blocks[0].text, "سلام دنیا!");
  assert.equal(conv.items[0].blocks[0].streaming, false);
});

test("tool_use blocks arriving as separate assistant messages merge into one item and receive results", () => {
  const conv = createConversation("s");
  applyMessage(conv, assistant("m1", [{ type: "text", text: "Let me look." }]));
  applyMessage(conv, assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } }]));
  assert.equal(conv.items.length, 1);
  assert.deepEqual(conv.items[0].blocks.map((block) => block.type), ["text", "tool"]);
  assert.equal(conv.tools.get("t1").status, "running");
  applyMessage(conv, userResult("t1", "1\thello"));
  assert.equal(conv.tools.get("t1").status, "done");
  assert.equal(conv.tools.get("t1").result.text, "1\thello");
  assert.equal(conv.items.filter((item) => item.kind === "user").length, 0, "tool results are not user bubbles");
});

test("denied and failed tool results are classified", () => {
  const conv = createConversation("s");
  applyMessage(conv, assistant("m", [{ type: "tool_use", id: "a", name: "Bash", input: { command: "rm -rf x" } }, { type: "tool_use", id: "b", name: "Bash", input: { command: "false" } }]));
  applyMessage(conv, userResult("a", "The user doesn't want to proceed with this tool use.", true));
  applyMessage(conv, userResult("b", "exit 1", true));
  assert.equal(conv.tools.get("a").status, "denied");
  assert.equal(conv.tools.get("b").status, "error");
});

test("history replay and live buffer overlap do not duplicate items", () => {
  const conv = createConversation("s");
  const u = { type: "user", uuid: "u1", session_id: "s", parent_tool_use_id: null, message: { role: "user", content: "hi" } };
  const a = assistant("m1", [{ type: "text", text: "hello" }]);
  loadHistory(conv, [u, a]);
  applyMessage(conv, { type: "wh_user_message", uuid: "u1", text: "hi", at: 1 });
  applyMessage(conv, a);
  assert.equal(conv.items.length, 2);
  assert.equal(userItems(conv).length, 1);
});

test("system-injected user text is hidden or turned into command/output items", () => {
  const conv = createConversation("s");
  const mk = (text, uuid) => ({ type: "user", uuid, session_id: "s", parent_tool_use_id: null, message: { role: "user", content: text } });
  loadHistory(conv, [
    mk("<system-reminder>ignore me</system-reminder>", "1"),
    mk("<command-name>/compact</command-name><command-args>keep tests</command-args>", "2"),
    mk("<local-command-stdout>Compacted</local-command-stdout>", "3"),
    mk("[Request interrupted by user]", "4"),
    mk("real question", "5"),
  ]);
  assert.deepEqual(conv.items.map((item) => item.kind), ["user", "output", "notice", "user"]);
  assert.equal(conv.items[0].command.name, "/compact");
  assert.equal(conv.items[3].text, "real question");
});

test("permission requests track pending state and resolve", () => {
  const conv = createConversation("s");
  applyMessage(conv, assistant("m", [{ type: "tool_use", id: "t9", name: "Write", input: { file_path: "x", content: "y" } }]));
  applyMessage(conv, { type: "wh_request", request: { id: "r1", kind: "permission", toolName: "Write", toolUseID: "t9", input: {} } });
  assert.equal(conv.requests.size, 1);
  assert.equal(conv.state, "requires_action");
  assert.equal(conv.tools.get("t9").awaiting, "r1");
  applyMessage(conv, { type: "wh_request_resolved", id: "r1", answer: { behavior: "deny", message: "no" } });
  assert.equal(conv.requests.size, 0);
  assert.equal(conv.tools.get("t9").status, "denied");
});

test("result closes the turn and records cost", () => {
  const conv = createConversation("s");
  applyMessage(conv, { type: "wh_user_message", uuid: "u", text: "x", at: 1 });
  assert.equal(conv.state, "running");
  applyMessage(conv, { type: "result", subtype: "success", uuid: "r", is_error: false, total_cost_usd: 0.05, duration_ms: 1200, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [] });
  assert.equal(conv.state, "idle");
  assert.equal(conv.items.at(-1).kind, "result");
  assert.equal(conv.items.at(-1).cost, 0.05);
});

test("TodoWrite updates conversation todos and subagent children nest under their tool", () => {
  const conv = createConversation("s");
  applyMessage(conv, assistant("m", [{ type: "tool_use", id: "td", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending" }] } }, { type: "tool_use", id: "ag", name: "Agent", input: { description: "explore" } }]));
  assert.equal(conv.todos.length, 1);
  applyMessage(conv, { ...assistant("sub", [{ type: "tool_use", id: "child", name: "Read", input: { file_path: "z" } }]), parent_tool_use_id: "ag" });
  assert.deepEqual(conv.tools.get("ag").children, ["child"]);
  assert.equal(conv.items.length, 1, "subagent output stays out of the main timeline");
});

const retry = (attempt, extra = {}) => ({ type: "system", subtype: "api_retry", attempt, max_retries: 10, retry_delay_ms: 500 * attempt, error_status: 504, error: "server_error", session_id: "s", uuid: crypto.randomUUID(), ...extra });

test("API retries of one request update a single notice with the status code", () => {
  const conv = createConversation("s");
  for (const attempt of [1, 2, 3]) applyMessage(conv, retry(attempt));
  const notices = conv.items.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].retry.attempt, 3);
  assert.equal(notices[0].retry.status, 504);
  assert.equal(notices[0].retry.delayMs, 1500);
  assert.deepEqual(notices[0].retry.history, [504, 504, 504]);
  assert.match(notices[0].text, /3\/10 \(HTTP 504\)/);
});

test("a retry after an answer starts a new notice", () => {
  const conv = createConversation("s");
  applyMessage(conv, retry(1));
  applyMessage(conv, assistant("msg9", [{ type: "text", text: "ok" }], { stop_reason: "end_turn" }));
  applyMessage(conv, retry(1, { error_status: 502 }));
  const notices = conv.items.filter((item) => item.kind === "notice");
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[1].retry.history, [502]);
});

test("background tasks still running end with the process that ran them", () => {
  const conv = createConversation("s");
  const sys = (subtype, extra) => ({ type: "system", subtype, session_id: "s", uuid: crypto.randomUUID(), ...extra });
  applyMessage(conv, sys("init", { model: "m" }));
  applyMessage(conv, sys("task_started", { task_id: "t1", tool_use_id: "toolu_1", task_type: "local_agent", description: "work" }));
  applyMessage(conv, sys("task_started", { task_id: "t2", tool_use_id: "toolu_2", task_type: "local_bash", description: "cmd" }));
  applyMessage(conv, sys("task_notification", { task_id: "t2", tool_use_id: "toolu_2", status: "completed" }));
  assert.equal(conv.tasks.get("t1").status, "running");
  applyMessage(conv, sys("init", { model: "m" })); // a new process
  assert.equal(conv.tasks.get("t1").status, "stopped");
  assert.equal(conv.tasks.get("t2").status, "completed");
});

// Claude Code emits one assistant message per content block, each with stop_reason: null, while the stream goes on.
test("per-block assistant messages keep streaming the rest of the message (thinking then text)", () => {
  const conv = createConversation("s");
  applyMessage(conv, { type: "wh_user_message", uuid: "u", text: "x", at: 1 });
  applyMessage(conv, stream({ type: "message_start", message: { id: "msg1", model: "m" } }));
  applyMessage(conv, stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }));
  applyMessage(conv, stream({ type: "content_block_stop", index: 0 }));
  applyMessage(conv, assistant("msg1", [{ type: "thinking", thinking: "hmm", signature: "x" }], { stop_reason: null }));
  applyMessage(conv, stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }));
  const item = conv.items.find((entry) => entry.kind === "assistant");
  assert.deepEqual(item.blocks.map((block) => block.type), ["thinking", "text"], "the text block streams after the thinking block");
  assert.equal(item.blocks[1].text, "Hel");
  assert.equal(item.blocks[1].streaming, true);
  assert.equal(item.streaming, true);
  applyMessage(conv, stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }));
  applyMessage(conv, stream({ type: "content_block_stop", index: 1 }));
  applyMessage(conv, assistant("msg1", [{ type: "text", text: "Hello" }], { stop_reason: null }));
  assert.equal(item.blocks.length, 2, "the final block replaces the streamed one");
  assert.equal(item.blocks[1].text, "Hello");
  applyMessage(conv, stream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }));
  applyMessage(conv, stream({ type: "message_stop" }));
  assert.equal(item.streaming, false, "message_stop ends the reply");
  assert.equal(item.stopReason, "end_turn");
  assert.equal(item.usage.output_tokens, 7);
  assert.equal(conv.drafts.size, 0);
});

test("per-block tool_use messages keep the draft until message_stop and result clears streaming", () => {
  const conv = createConversation("s");
  applyMessage(conv, stream({ type: "message_start", message: { id: "msg2", model: "m" } }));
  applyMessage(conv, stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading." } }));
  applyMessage(conv, stream({ type: "content_block_stop", index: 0 }));
  applyMessage(conv, assistant("msg2", [{ type: "text", text: "Reading." }], { stop_reason: null }));
  applyMessage(conv, stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tr", name: "Read", input: {} } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.t' } }));
  assert.equal(conv.tools.get("tr").status, "streaming");
  assert.equal(conv.tools.get("tr").input.file_path, "a.t");
  applyMessage(conv, stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'xt"}' } }));
  applyMessage(conv, stream({ type: "content_block_stop", index: 1 }));
  applyMessage(conv, assistant("msg2", [{ type: "tool_use", id: "tr", name: "Read", input: { file_path: "a.txt" } }], { stop_reason: null }));
  const item = conv.items[0];
  assert.deepEqual(item.blocks.map((block) => block.type), ["text", "tool"]);
  assert.equal(conv.tools.get("tr").status, "running");
  applyMessage(conv, stream({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
  applyMessage(conv, stream({ type: "message_stop" }));
  assert.equal(item.streaming, false);
  assert.equal(item.stopReason, "tool_use");
  applyMessage(conv, userResult("tr", "1\tok"));
  // The next model call of the same turn is its own message.
  applyMessage(conv, stream({ type: "message_start", message: { id: "msg3", model: "m" } }));
  applyMessage(conv, stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } }));
  const second = conv.items.at(-1);
  assert.equal(second.messageId, "msg3");
  assert.equal(second.blocks[0].text, "Done");
  // Without a message_stop (lost or never sent), the result still ends it.
  applyMessage(conv, { type: "result", subtype: "success", uuid: "r2", is_error: false, num_turns: 2, permission_denials: [] });
  assert.equal(second.streaming, false);
  assert.equal(second.blocks[0].streaming, false);
  assert.equal(conv.drafts.size, 0);
});

test("an interrupted streaming reply stops streaming on result and on process exit", () => {
  const conv = createConversation("s");
  applyMessage(conv, stream({ type: "message_start", message: { id: "msg4", model: "m" } }));
  applyMessage(conv, stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
  applyMessage(conv, stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me" } }));
  const item = conv.items[0];
  assert.equal(item.blocks[0].streaming, true);
  applyMessage(conv, { type: "result", subtype: "error_during_execution", uuid: "r3", is_error: true, num_turns: 1, permission_denials: [] });
  assert.equal(item.streaming, false);
  assert.equal(item.blocks[0].streaming, false);

  const other = createConversation("s2");
  applyMessage(other, stream({ type: "message_start", message: { id: "msg5", model: "m" } }));
  applyMessage(other, stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  applyMessage(other, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } }));
  applyMessage(other, { type: "wh_closed" });
  assert.equal(other.items[0].streaming, false);
  assert.equal(other.items[0].blocks[0].streaming, false);
});

test("image blocks of a tool result are kept apart from its text, with a size cap", async () => {
  const { MAX_IMAGE_CHARS } = await import("../web/js/chat/reducer.js");
  const conv = createConversation("s");
  applyMessage(conv, assistant("mi", [{ type: "tool_use", id: "img", name: "Read", input: { file_path: "a.png" } }]));
  applyMessage(conv, userResult("img", [
    { type: "text", text: "a picture" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
    { type: "image", data: "x".repeat(MAX_IMAGE_CHARS + 1), mimeType: "image/jpeg" },
  ]));
  const result = conv.tools.get("img").result;
  assert.equal(result.text, "a picture");
  assert.deepEqual(result.images[0], { mediaType: "image/png", data: "iVBORw0K" });
  assert.equal(result.images[1].omitted, "size");
  assert.equal(result.images[1].data, undefined);
});

test("a refusal fallback evicts the retracted reply and offers the refused prompt for editing", () => {
  const conv = createConversation("s");
  const u = { type: "user", uuid: "u1", session_id: "s", parent_tool_use_id: null, message: { role: "user", content: "do the thing" } };
  applyMessage(conv, u);
  const refused = { ...assistant("mr", [{ type: "text", text: "partial" }]), uuid: "a1" };
  applyMessage(conv, refused);
  assert.equal(conv.items.length, 2);
  applyMessage(conv, { type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry", scope: "session", original_model: "claude-a", fallback_model: "claude-b", request_id: null, retracted_message_uuids: ["a1", "unknown"], refused_user_message_uuid: "u1", content: "Retried", uuid: "f1", session_id: "s" });
  assert.deepEqual(conv.items.map((item) => item.kind), ["user", "notice"]);
  assert.equal(conv.byMessageId.has("mr"), false);
  assert.equal(conv.items[1].retryText, "do the thing");
  assert.equal(conv.items[1].params.fallback, "claude-b");
  assert.equal(conv.evicted, 1);
});

test("active_goal sets and clears the goal; denials keep a translatable template", () => {
  const conv = createConversation("s");
  applyMessage(conv, { type: "active_goal", value: { condition: "tests pass", iterations: 2, set_at: 1, tokens_at_start: 0, last_reason: "1 failing" }, uuid: "g1", session_id: "s" });
  assert.equal(conv.goal.condition, "tests pass");
  assert.equal(conv.goal.iterations, 2);
  applyMessage(conv, { type: "active_goal", value: null, uuid: "g2", session_id: "s" });
  assert.equal(conv.goal, null);
  applyMessage(conv, { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t", uuid: "d1", session_id: "s" });
  const notice = conv.items.at(-1);
  assert.equal(notice.text, "Denied: {tool}");
  assert.deepEqual(notice.params, { tool: "Bash" });
});

test("model names and remembered models", async () => {
  const { prettyModelName, mergeModels, isModelId } = await import("../web/js/chat/model-names.js");
  assert.equal(prettyModelName("claude-fable-5-2"), "Fable 5.2");
  assert.equal(prettyModelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(prettyModelName("claude-opus-5-5[1m]"), "Opus 5.5 (1M)");
  assert.equal(prettyModelName("gpt-6-sol"), "gpt-6-sol");
  assert.equal(isModelId("<synthetic>"), false);
  assert.equal(isModelId("claude-fable-5-2"), true);
  const cli = [{ value: "default" }, { value: "opus", resolvedModel: "claude-opus-5-5" }, { value: "claude-fable-5-1[1m]", displayName: "Fable" }];
  const merged = mergeModels(cli, [{ id: "claude-fable-5-2", at: 2 }, { id: "claude-opus-5-5", at: 3 }, { id: "claude-fable-5-1", at: 1 }, { id: "<synthetic>", at: 4 }]);
  // the CLI's Fable row now points at 5.2 (same name and tag); 5.1 stays as a row of its own, no duplicates
  assert.deepEqual(merged.map((model) => [model.value, model.displayName]).slice(2), [["claude-fable-5-2[1m]", "Fable"], ["claude-fable-5-1[1m]", "Fable 5.1 (1M)"]]);
  // a model of a family the CLI does not list is added as its own row
  const extra = mergeModels(cli, [{ id: "claude-mythos-1-0", at: 1 }]);
  assert.deepEqual(extra.slice(cli.length).map((model) => [model.value, model.displayName]), [["claude-mythos-1-0", "Mythos 1.0"]]);
});

test("the CLI's row of a model family follows the newest version that answered", async () => {
  const { upgradeModels, parseModel } = await import("../web/js/chat/model-names.js");
  assert.deepEqual(parseModel("claude-fable-5-2[1m]"), { family: "fable", version: [5, 2] });
  assert.deepEqual(parseModel("claude-sonnet-4-5-20250929"), { family: "sonnet", version: [4, 5] });
  assert.equal(parseModel("opus"), null);
  const cli = [
    { value: "default", resolvedModel: "claude-opus-5-5", description: "Use the default model" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Best" },
    { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable" },
  ];
  const out = upgradeModels(cli, [{ id: "claude-fable-5-2" }, { id: "claude-fable-5-0" }, { id: "claude-opus-5-5" }]);
  assert.equal(out[0], cli[0]);
  assert.equal(out[1], cli[1], "nothing newer for opus");
  assert.deepEqual([out[2].value, out[2].resolvedModel, out[2].description, out[2].upgradedFrom], ["claude-fable-5-2[1m]", "claude-fable-5-2", "Fable 5.2 · Most capable", "claude-fable-5-1[1m]"]);
});
