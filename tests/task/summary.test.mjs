import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildSummaryMarkdown } from "../../extensions/task/summary.ts";
import { executeSupervisedTasks } from "../../extensions/task/supervisor.ts";

test("buildSummaryMarkdown includes status, task table, failures, and rerun payload", () => {
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
    taskIds: ["t001"],
    requestedConcurrency: 1,
    effectiveConcurrency: 1,
    summary: { total: 1, success: 0, error: 1, aborted: 0, acceptanceFailed: 1, providerTransientFailed: 0, protocolFailed: 0, retried: 0 },
  };
  const task = {
    schemaVersion: 1,
    batchId: "batch-1",
    taskId: "t001",
    name: "bad",
    prompt: "Do bad",
    cwd: "/tmp/project",
    status: "error",
    finalStatus: "error",
    failureKind: "acceptance_failed",
    retryability: "not_retryable",
    acceptance: { status: "failed", checks: [], warnings: [], errors: ["missing"] },
    workerReport: { status: "completed", errors: [], warnings: [] },
    attempts: [],
    queuedAt: "start",
    startedAt: "start",
    finishedAt: "finish",
    timeline: [],
    warnings: [],
    error: "missing",
  };
  const markdown = buildSummaryMarkdown(batch, [task], { tasks: [{ name: "bad", prompt: "Do bad" }] });
  assert.match(markdown, /# Tasks Batch batch-1/);
  assert.match(markdown, /Acceptance failed: 1/);
  assert.match(markdown, /Suggested Rerun Payload/);
  assert.match(markdown, /Inspect: \/tasks-ui batch-1/);
  assert.match(markdown, /Rerun failed: \/tasks-ui rerun failed batch-1/);
});

test("supervisor writes summary.md for completed batches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-summary-supervisor-"));
  const result = await executeSupervisedTasks({ tasks: [{ name: "ok", prompt: "Do ok" }] }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await fs.writeFile(input.paths.workerLogPath, "done", "utf-8");
      await fs.writeFile(input.paths.reportPath, JSON.stringify({
        schemaVersion: 1,
        taskId: input.task.id,
        attemptId: input.attemptId,
        status: "completed",
        summary: "Done",
        deliverables: [],
        evidence: [],
      }), "utf-8");
      return {
        attemptId: input.attemptId,
        taskId: input.task.id,
        status: "success",
        exitCode: 0,
        sawTerminalAssistantMessage: true,
        stderrTail: "",
        stdoutMalformedLines: 0,
        failureKind: "none",
        error: null,
        startedAt: "start",
        finishedAt: "finish",
      };
    },
  });

  const summary = await fs.readFile(path.join(result.batch.batchDir, "summary.md"), "utf-8");
  assert.match(summary, /# Tasks Batch/);
  assert.match(summary, /OK/);
});
