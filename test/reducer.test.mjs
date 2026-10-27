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
