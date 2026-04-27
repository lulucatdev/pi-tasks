import test from "node:test";
import assert from "node:assert/strict";

import { countTaskLifecycle, deriveTaskView, summarizeTasks } from "../../extensions/task/task-view.ts";
import { emptyAcceptance, emptyWorkerReport } from "../../extensions/task/types.ts";

function task(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: "b001",
    taskId: "t001",
    name: "Task t001",
    prompt: "do",
    cwd: "/tmp",
    status: "queued",
    finalStatus: null,
    failureKind: "none",
    retryability: "not_retryable",
    acceptance: emptyAcceptance("pending"),
    workerReport: emptyWorkerReport(),
    attempts: [],
    queuedAt: "2026-04-26T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    timeline: [],
    activity: [],
    warnings: [],
    error: null,
    ...overrides,
  };
}

test("deriveTaskView ignores stale terminal fields while a retry is running", () => {
  const view = deriveTaskView(task({
    status: "running",
    finalStatus: "error",
    failureKind: "worker_incomplete",
    attempts: [{ id: "t001-a1" }],
  }));

  assert.equal(view.finalStatus, null);
  assert.equal(view.displayStatus, "running");
  assert.equal(view.icon, "◐");
  assert.equal(view.failureKind, "none");
});

test("summarizeTasks materializes counts from task views", () => {
  const tasks = [
    task({ taskId: "ok", status: "success", finalStatus: "success", workerReport: emptyWorkerReport("completed"), acceptance: emptyAcceptance("passed") }),
    task({ taskId: "bad", status: "error", finalStatus: "error", failureKind: "acceptance_failed", attempts: [{ id: "bad-a1" }, { id: "bad-a2" }] }),
    task({ taskId: "run", status: "running", finalStatus: "error", failureKind: "worker_incomplete", attempts: [{ id: "run-a1" }] }),
  ];

  assert.deepEqual(summarizeTasks(tasks), {
    total: 3,
    success: 1,
    error: 1,
    aborted: 0,
    acceptanceFailed: 1,
    providerTransientFailed: 0,
    protocolFailed: 0,
    retried: 1,
  });
  assert.equal(countTaskLifecycle(tasks).running, 1);
  assert.equal(countTaskLifecycle(tasks).done, 2);
});
