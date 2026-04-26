import test from "node:test";
import assert from "node:assert/strict";

import { buildResultText, normalizeTasksRun, validateTasksFanoutUsage, validateTasksToolParams } from "../../extensions/task/run-tasks.ts";

test("validateTasksToolParams accepts new prompt-based task specs", () => {
  const params = { tasks: [{ name: "inspect", prompt: "Inspect the code", cwd: "." }], concurrency: 4 };
  assert.doesNotThrow(() => validateTasksToolParams(params));
});

test("validateTasksToolParams rejects old task field, empty names, and unsafe task ids", () => {
  assert.throws(() => validateTasksToolParams({ tasks: [{ name: "old", task: "legacy" }] }), /prompt/);
  assert.throws(() => validateTasksToolParams({ tasks: [{ name: "", prompt: "x" }] }), /name/);
  assert.throws(() => validateTasksToolParams({ tasks: [{ id: "../batch", name: "unsafe", prompt: "x" }] }), /path traversal/);
  assert.throws(() => validateTasksToolParams({ tasks: [{ id: "nested/task", name: "unsafe", prompt: "x" }] }), /path traversal/);
});

test("validateTasksFanoutUsage rejects one meta-task when fan-out was intended", () => {
  assert.throws(() => validateTasksFanoutUsage({
    concurrency: 19,
    tasks: [{ name: "fix all chapters", prompt: "发起 19 个并行 agents。每个都会读对应 Oracle 报告并只修本章局部正文问题。" }],
  }), /received 1 task.*19 supervised agents/);
  assert.throws(() => validateTasksFanoutUsage({
    tasks: [{ name: "parallel repair", prompt: "Launch parallel workers, each one reads a corresponding report and writes a receipt." }],
  }), /one item per worker/);
  assert.doesNotThrow(() => validateTasksFanoutUsage({
    concurrency: 1,
    tasks: [{ name: "single repair", prompt: "Fix this one chapter only." }],
  }));
});

test("normalizeTasksRun creates batch-local ids, resolves cwd, merges acceptance defaults, and clamps concurrency", () => {
  const normalized = normalizeTasksRun({
    concurrency: 50,
    acceptanceDefaults: { requiredOutputRegex: ["done"], allowedWritePaths: ["shared/**"] },
    tasks: [
      { name: "one", prompt: "Do one", cwd: "sub", acceptance: { forbiddenOutputRegex: ["TODO"], allowedWritePaths: ["one.md"] } },
      { name: "two", prompt: "Do two" },
    ],
  }, "/tmp/project", 8);

  assert.deepEqual(normalized.tasks.map((task) => task.id), ["t001", "t002"]);
  assert.equal(normalized.tasks[0].cwd, "/tmp/project/sub");
  assert.equal(normalized.requestedConcurrency, 50);
  assert.equal(normalized.effectiveConcurrency, 2);
  assert.deepEqual(normalized.tasks[0].acceptance.requiredOutputRegex, ["done"]);
  assert.deepEqual(normalized.tasks[0].acceptance.forbiddenOutputRegex, ["TODO"]);
  assert.deepEqual(normalized.tasks[0].acceptance.allowedWritePaths, ["shared/**", "one.md"]);
});

test("buildResultText points to batch artifacts", () => {
  const text = buildResultText({
    batchId: "batch-1",
    batchDir: "/tmp/project/.pi/tasks/batch-1",
    status: "error",
    total: 3,
    success: 1,
    error: 1,
    aborted: 1,
    summaryPath: "/tmp/project/.pi/tasks/batch-1/summary.md",
  });

  assert.match(text, /TASKS error: 1 success, 1 error, 1 aborted \/ 3 total/);
  assert.match(text, /Artifacts: \/tmp\/project\/\.pi\/tasks\/batch-1/);
  assert.match(text, /Summary: \/tmp\/project\/\.pi\/tasks\/batch-1\/summary\.md/);
  assert.match(text, /Inspect: \/tasks-ui batch-1/);
  assert.match(text, /Rerun failed: \/tasks-ui rerun failed batch-1/);
});
