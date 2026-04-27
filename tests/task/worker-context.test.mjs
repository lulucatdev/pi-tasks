import test from "node:test";
import assert from "node:assert/strict";

import { estimateWorkerContextTokens, guardWorkerContext } from "../../extensions/task/worker-context.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function user(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantText(text) {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test", usage, stopReason: "stop", timestamp: Date.now() };
}

function assistantTool(id, name, args = {}) {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], api: "openai-responses", provider: "openai", model: "test", usage, stopReason: "toolUse", timestamp: Date.now() };
}

function toolResult(id, name, text) {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

test("worker context guard leaves small contexts unchanged", () => {
  const messages = [user("Do the task"), assistantText("Done")];
  const result = guardWorkerContext(messages, { contextWindow: 100_000 });

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
  assert.equal(result.droppedMessages, 0);
});

test("worker context guard compacts middle history while preserving task prompt and recent suffix", () => {
  const oldOutput = "old output ".repeat(20_000);
  const messages = [
    user("Original worker task prompt"),
    assistantTool("old-read", "read", { path: "huge.md" }),
    toolResult("old-read", "read", oldOutput),
    assistantText("I inspected the large file."),
    assistantTool("recent-grep", "grep", { pattern: "TODO" }),
    toolResult("recent-grep", "grep", "latest result"),
  ];

  const before = estimateWorkerContextTokens(messages);
  const result = guardWorkerContext(messages, {
    contextWindow: 4_000,
    reserveTokens: 500,
    keepRecentTokens: 1,
    minRecentMessages: 1,
    maxSummaryChars: 1_000,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.messages[0], messages[0]);
  assert.equal(result.messages[1].role, "custom");
  assert.match(result.messages[1].content, /context compacted/i);
  assert.equal(result.messages.at(-2), messages[4]);
  assert.equal(result.messages.at(-1), messages[5]);
  assert.ok(result.tokensAfter < before);
  assert.equal(result.droppedMessages, 3);
});

test("worker context guard never keeps a dangling tool result without its assistant tool call", () => {
  const messages = [
    user("Original worker task prompt"),
    assistantText("older".repeat(10_000)),
    assistantTool("recent-read", "read", { path: "a.md" }),
    toolResult("recent-read", "read", "recent output"),
  ];

  const result = guardWorkerContext(messages, {
    contextWindow: 2_000,
    reserveTokens: 100,
    keepRecentTokens: 1,
    minRecentMessages: 1,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.messages.at(-2), messages[2]);
  assert.equal(result.messages.at(-1), messages[3]);
});
