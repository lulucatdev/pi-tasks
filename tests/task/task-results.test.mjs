import test from "node:test";
import assert from "node:assert/strict";

import { buildResultText } from "../../extensions/task/run-tasks.ts";
import { isTerminalAssistantMessage, resolveTaskResultStatus } from "../../extensions/task/index.ts";

function makeResult(overrides = {}) {
  return {
    id: "20260323231338-sample-task",
    name: "sample-task",
    task: "Do the thing",
    cwd: "/tmp/project",
    outputPath: "/tmp/project/.pi/tasks/20260323231338-sample-task.md",
    status: "success",
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

test("terminal assistant detection ignores tool-use turns and non-assistant messages", () => {
  assert.equal(isTerminalAssistantMessage({ role: "assistant", stopReason: "toolUse" }), false);
  assert.equal(isTerminalAssistantMessage({ role: "assistant", stopReason: "stop" }), true);
  assert.equal(isTerminalAssistantMessage({ role: "user", stopReason: "stop" }), false);
});

test("resolveTaskResultStatus keeps a completed worker successful even if the child exits non-zero later", () => {
  const status = resolveTaskResultStatus({
    wasAborted: false,
    exitCode: 1,
    stopReason: "stop",
    sawTerminalAssistantMessage: true,
    timedOutBeforeTerminal: false,
  });

  assert.equal(status, "success");
});

test("resolveTaskResultStatus still reports timeout before terminal output as an error", () => {
  const status = resolveTaskResultStatus({
    wasAborted: false,
    exitCode: 1,
    stopReason: "toolUse",
    sawTerminalAssistantMessage: false,
    timedOutBeforeTerminal: true,
  });

  assert.equal(status, "error");
});

test("buildResultText always reports the task output path, including failures", () => {
  const details = {
    results: [
      makeResult({ status: "success" }),
      makeResult({
        id: "20260323231338-error-task",
        name: "error-task",
        outputPath: "/tmp/project/.pi/tasks/20260323231338-error-task.md",
        status: "error",
        errorMessage: "Task timed out after 600s",
      }),
      makeResult({
        id: "20260323231338-aborted-task",
        name: "aborted-task",
        outputPath: "/tmp/project/.pi/tasks/20260323231338-aborted-task.md",
        status: "aborted",
        errorMessage: "Task was aborted.",
      }),
    ],
    summary: {
      total: 3,
      queued: 0,
      running: 0,
      success: 1,
      error: 1,
      aborted: 1,
    },
  };

  const text = buildResultText(details);

  assert.match(text, /TASKS complete: 1 success, 1 error, 1 aborted/);
  assert.match(text, /sample-task · 20260323231338-sample-task - success:\nOutput: \/tmp\/project\/.pi\/tasks\/20260323231338-sample-task\.md/);
  assert.match(text, /error-task · 20260323231338-error-task - error:\nOutput: \/tmp\/project\/.pi\/tasks\/20260323231338-error-task\.md\nError: Task timed out after 600s/);
  assert.match(text, /aborted-task · 20260323231338-aborted-task - aborted:\nOutput: \/tmp\/project\/.pi\/tasks\/20260323231338-aborted-task\.md\nError: Task was aborted\./);
});
