import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { executeSupervisedTasks } from "../../extensions/task/supervisor.ts";
import { listBatches, loadBatchDetail, renderAttemptDetailLines, renderBatchDetailLines, renderBatchListLines, renderTaskDetailLines, renderTasksUiHelpLines, resolveBatchDir } from "../../extensions/task/task-ui.ts";

async function successAttempt(input) {
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
}

test("task-ui lists and renders artifact-backed batches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-ui-"));
  const result = await executeSupervisedTasks({ tasks: [{ name: "ok", prompt: "Do ok" }] }, { cwd: root, toolName: "tasks" }, { runAttempt: successAttempt });

  const list = await listBatches(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].batchId, result.batch.batchId);
  assert.match(renderBatchListLines(list).join("\n"), /SUCCESS/);

  assert.equal(resolveBatchDir(root, result.batch.batchId), result.batch.batchDir);
  const detail = await loadBatchDetail(resolveBatchDir(root, result.batch.batchId));
  assert.equal(detail.tasks[0].name, "ok");
  const batchText = renderBatchDetailLines(detail).join("\n");
  assert.match(batchText, /t001 ok: SUCCESS/);
  assert.match(batchText, /Next commands/);
  assert.match(batchText, /\/tasks-ui .* task <taskId>/);
  assert.match(detail.summaryMarkdown, /# Tasks Batch/);

  const taskText = renderTaskDetailLines(detail, "t001").join("\n");
  assert.match(taskText, /Task t001 ok/);
  assert.match(taskText, /Report summary: Done/);
  assert.match(taskText, /Latest attempt artifacts/);

  const attemptText = renderAttemptDetailLines(detail, "t001", "latest").join("\n");
  assert.match(attemptText, /Attempt t001-a1/);
  assert.match(attemptText, /Artifacts:/);
});

test("task-ui renders failure triage and help", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-ui-fail-"));
  const result = await executeSupervisedTasks({
    tasks: [{ name: "bad", prompt: "Do bad", acceptance: { requiredPaths: ["missing.md"] } }],
  }, { cwd: root, toolName: "tasks" }, { runAttempt: successAttempt });

  const detail = await loadBatchDetail(result.batch.batchDir);
  const batchText = renderBatchDetailLines(detail).join("\n");
  assert.match(batchText, /Failed tasks/);
  assert.match(batchText, /acceptance/);
  assert.match(batchText, /\/tasks-ui rerun failed/);

  const taskText = renderTaskDetailLines(detail, "bad").join("\n");
  assert.match(taskText, /Acceptance errors/);
  assert.match(taskText, /\/tasks-ui rerun selected/);

  assert.match(renderTasksUiHelpLines().join("\n"), /rerun selected/);
});
