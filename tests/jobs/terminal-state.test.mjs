import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalRuntimeState, inspectTerminalAssistantEvent, reduceTerminalRuntimeState } from "../../extensions/jobs/terminal-state.ts";

function messageEnd(message) {
  return { type: "message_end", message: { role: "assistant", ...message } };
}

test("terminal state treats thinking-only stop as incomplete and schedules exit guard", () => {
  const transition = reduceTerminalRuntimeState(createTerminalRuntimeState(), messageEnd({
    stopReason: "stop",
    content: [{ type: "thinking", thinking: "still thinking" }],
  }));

  assert.equal(transition.action, "schedule_exit_guard");
  assert.equal(transition.state.sawTerminalAssistantMessage, false);
  assert.equal(transition.state.stopReason, "thinking_only_stop");
  assert.match(transition.state.errorMessage, /thinking-only/);
});

test("terminal state does not schedule guard for stopReason=error and resets on recovery", () => {
  const errored = reduceTerminalRuntimeState(createTerminalRuntimeState(), messageEnd({
    stopReason: "error",
    errorMessage: "terminated",
    content: [{ type: "thinking", thinking: "..." }],
  }));
  assert.equal(errored.action, "none");
  assert.equal(errored.state.stopReason, "error");

  const recovered = reduceTerminalRuntimeState(errored.state, { type: "auto_retry_start" });
  assert.equal(recovered.action, "cancel_exit_guard");
  assert.equal(recovered.state.stopReason, undefined);
  assert.equal(recovered.state.sawTerminalAssistantMessage, false);
});

test("terminal state recognises visible text as terminal assistant completion", () => {
  const info = inspectTerminalAssistantEvent(messageEnd({
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
  }));
  assert.equal(info.terminal, true);
  assert.equal(info.hasText, true);

  const transition = reduceTerminalRuntimeState(createTerminalRuntimeState(), messageEnd({
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
  }));
  assert.equal(transition.action, "schedule_exit_guard");
  assert.equal(transition.state.sawTerminalAssistantMessage, true);
  assert.equal(transition.state.stopReason, "stop");
});
