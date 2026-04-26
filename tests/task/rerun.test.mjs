import test from "node:test";
import assert from "node:assert/strict";

import { attachRerunMetadata, buildRerunParams, isRerunFilter } from "../../extensions/task/rerun.ts";

function task(taskId, name, finalStatus, failureKind = "none", acceptanceContract = undefined) {
  return {
    schemaVersion: 1,
    batchId: "batch-1",
    taskId,
    name,
    prompt: `Prompt ${name}`,
    cwd: "/tmp/project",
    status: finalStatus,
    finalStatus,
    failureKind,
    retryability: "not_retryable",
    acceptance: { status: "skipped", checks: [], warnings: [], errors: [] },
    acceptanceContract,
    workerReport: { status: "completed", errors: [], warnings: [] },
    attempts: [],
    queuedAt: "start",
    startedAt: "start",
    finishedAt: "finish",
    timeline: [],
    warnings: [],
    error: finalStatus === "success" ? null : "failed",
  };
}

const batch = {
  schemaVersion: 1,
  batchId: "batch-1",
  toolName: "tasks",
  rootCwd: "/tmp/project",
  batchDir: "/tmp/project/.pi/tasks/batch-1",
  startedAt: "start",
  finishedAt: "finish",
  status: "error",
  initialized: true,
  auditIntegrity: "ok",
  taskIds: ["t001", "t002", "t003"],
  requestedConcurrency: 4,
  effectiveConcurrency: 3,
  summary: { total: 3, success: 1, error: 2, aborted: 0, acceptanceFailed: 1, providerTransientFailed: 1, protocolFailed: 0, retried: 0 },
};

test("isRerunFilter validates supported rerun filters", () => {
  assert.equal(isRerunFilter("failed"), true);
  assert.equal(isRerunFilter("acceptance-failed"), true);
  assert.equal(isRerunFilter("bogus"), false);
});

test("buildRerunParams selects failed tasks and carries parent metadata", () => {
  const params = buildRerunParams({
    detail: { batch, tasks: [task("t001", "ok", "success"), task("t002", "bad", "error", "acceptance_failed"), task("t003", "flaky", "error", "provider_transient")] },
    filter: "failed",
    originalParams: { tasks: [{ name: "bad", prompt: "Original bad", acceptance: { requiredPaths: ["bad.md"] } }] },
  });
  assert.equal(params.parentBatchId, "batch-1");
  assert.deepEqual(params.rerunOfTaskIds, ["t002", "t003"]);
  assert.equal(params.tasks[0].prompt, "Original bad");
  assert.deepEqual(params.tasks[0].acceptance.requiredPaths, ["bad.md"]);
});

test("buildRerunParams preserves persisted acceptance contracts when original params are unavailable", () => {
  const params = buildRerunParams({
    detail: { batch, tasks: [task("t002", "bad", "error", "acceptance_failed", { requiredPaths: ["bad.md"], allowedWritePaths: ["bad/**"] })] },
    filter: "failed",
  });

  assert.deepEqual(params.tasks[0].acceptance.requiredPaths, ["bad.md"]);
  assert.deepEqual(params.tasks[0].acceptance.allowedWritePaths, ["bad/**"]);
});

test("buildRerunParams supports focused filters", () => {
  const detail = { batch, tasks: [task("t002", "bad", "error", "acceptance_failed"), task("t003", "flaky", "error", "provider_transient")] };
  assert.deepEqual(buildRerunParams({ detail, filter: "acceptance-failed" }).rerunOfTaskIds, ["t002"]);
  assert.deepEqual(buildRerunParams({ detail, filter: "provider-transient" }).rerunOfTaskIds, ["t003"]);
  assert.deepEqual(buildRerunParams({ detail, filter: "selected", taskIds: ["t003"] }).rerunOfTaskIds, ["t003"]);
});

test("attachRerunMetadata annotates new batch artifacts", () => {
  const next = attachRerunMetadata(batch, "parent", ["t001"]);
  assert.equal(next.parentBatchId, "parent");
  assert.deepEqual(next.rerunOfTaskIds, ["t001"]);
});
