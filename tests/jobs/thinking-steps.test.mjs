import test from "node:test";
import assert from "node:assert/strict";

import { createWorkerActivityState, extractWorkerActivity, renderActivityCollapsedLine, renderActivitySummaryLines, summarizeThinkingStep } from "../../extensions/jobs/thinking-steps.ts";

test("summarizeThinkingStep derives compact headings like pi-thinking-steps", () => {
  assert.equal(summarizeThinkingStep("**Reviewing file specifics**\n\nI need to inspect README.md."), "Reviewing file specifics");
  assert.equal(summarizeThinkingStep("I need to verify the live update path before shipping."), "Verify the live update path before shipping");
});

test("extractWorkerActivity emits deduped thinking and tool activity", () => {
  const state = createWorkerActivityState();
  const ctx = { jobId: "t001", attemptId: "t001-a1", now: () => "2026-04-26T00:00:00.000Z" };
  const thinking = {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
    message: { content: [{ type: "thinking", thinking: "**Reviewing file specifics**\n\nI need to inspect README.md." }] },
  };

  const first = extractWorkerActivity(thinking, state, ctx);
  const duplicate = extractWorkerActivity(thinking, state, ctx);
  assert.equal(first?.kind, "thinking");
  assert.equal(first?.label, "Reviewing file specifics");
  assert.equal(duplicate, null);

  const tool = extractWorkerActivity({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "echo secret", token: "abc" },
  }, state, ctx);
  assert.equal(tool?.kind, "tool");
  assert.equal(tool?.label, "Run echo secret");
  assert.match(tool?.detail ?? "", /\[REDACTED\]/);
  assert.equal(renderActivityCollapsedLine(tool), "│ Thinking ◇ Run echo secret ·");
  assert.deepEqual(renderActivitySummaryLines([first, tool]), [
    "┆ Thinking Steps · Summary",
    "├─ ◫ Reviewing file specifics",
    "└─ ◇ Run echo secret",
  ]);
});
