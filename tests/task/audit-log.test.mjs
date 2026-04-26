import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAttemptPaths,
  buildBatchPaths,
  createBatch,
  generateTaskIds,
  appendBatchEvent,
  isDiscoverableBatch,
  readJsonFile,
  readJsonlTolerant,
  writeAttemptArtifact,
  writeBatchArtifact,
} from "../../extensions/task/audit-log.ts";

function makeTask(id = "t001") {
  return {
    id,
    name: `task-${id}`,
    prompt: `Do ${id}`,
    cwd: "/tmp/project",
  };
}

test("batch layout uses .pi/tasks/<batchId> with task and attempt subdirectories", () => {
  const paths = buildBatchPaths("/tmp/project", "2026-04-26T00-00-00-000Z-abcdef");
  assert.equal(paths.batchDir, "/tmp/project/.pi/tasks/2026-04-26T00-00-00-000Z-abcdef");
  assert.equal(paths.batchPath, `${paths.batchDir}/batch.json`);
  assert.equal(paths.eventsPath, `${paths.batchDir}/events.jsonl`);
  assert.equal(paths.summaryPath, `${paths.batchDir}/summary.md`);
  assert.equal(paths.tasksDir, `${paths.batchDir}/tasks`);
  assert.equal(paths.attemptsDir, `${paths.batchDir}/attempts`);

  const attempt = buildAttemptPaths(paths, "t001", 2);
  assert.equal(attempt.attemptDir, `${paths.batchDir}/attempts/t001/attempt-2`);
  assert.equal(attempt.workerLogPath, `${attempt.attemptDir}/worker.md`);
  assert.equal(attempt.reportPath, `${attempt.attemptDir}/task-report.json`);
});

test("generateTaskIds creates stable batch-local ids", () => {
  assert.deepEqual(generateTaskIds(4), ["t001", "t002", "t003", "t004"]);
});

test("createBatch writes initialized batch, queued tasks, and events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-audit-"));
  const tasks = [makeTask("t001"), makeTask("t002")].map((task) => ({ ...task, cwd: root }));
  const batch = await createBatch({
    rootCwd: root,
    toolName: "tasks",
    tasks,
    requestedConcurrency: 8,
    effectiveConcurrency: 8,
    batchId: "2026-04-26T00-00-00-000Z-abcdef",
    now: "2026-04-26T00:00:00.000Z",
  });

  const artifact = await readJsonFile(batch.batchPath);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.initialized, true);
  assert.equal(artifact.status, "running");
  assert.deepEqual(artifact.taskIds, ["t001", "t002"]);

  const events = await readJsonlTolerant(batch.eventsPath);
  assert.deepEqual(events.map((event) => event.type), ["batch_started", "task_queued", "task_queued"]);

  const task = await readJsonFile(path.join(batch.tasksDir, "t001.json"));
  assert.equal(task.schemaVersion, 1);
  assert.equal(task.batchId, artifact.batchId);
  assert.equal(task.taskId, "t001");
  assert.deepEqual(task.timeline, [{ at: "2026-04-26T00:00:00.000Z", state: "queued" }]);

  assert.equal(await isDiscoverableBatch(batch.batchDir), true);
});

test("readJsonlTolerant rejects complete corrupt trailing records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-jsonl-corrupt-"));
  const file = path.join(root, "events.jsonl");
  await fs.writeFile(file, '{"ok":true}\n{"bad":\n', "utf-8");
  await assert.rejects(() => readJsonlTolerant(file));
});

test("readJsonlTolerant ignores one partial trailing line", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-jsonl-"));
  const file = path.join(root, "events.jsonl");
  await fs.writeFile(file, '{"ok":true}\n{"partial":', "utf-8");
  assert.deepEqual(await readJsonlTolerant(file), [{ ok: true }]);
});

test("artifact writers atomically rewrite batch and write attempt records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-writer-"));
  const [task] = [makeTask("t001")].map((item) => ({ ...item, cwd: root }));
  const batch = await createBatch({
    rootCwd: root,
    toolName: "task",
    tasks: [task],
    requestedConcurrency: 1,
    effectiveConcurrency: 1,
    batchId: "2026-04-26T00-00-00-000Z-writer",
    now: "2026-04-26T00:00:00.000Z",
  });

  const nextArtifact = { ...batch.artifact, auditIntegrity: "ok" };
  await writeBatchArtifact(batch, nextArtifact);
  assert.equal((await readJsonFile(batch.batchPath)).auditIntegrity, "ok");

  const attemptPaths = buildAttemptPaths(batch, "t001", 1);
  await writeAttemptArtifact(attemptPaths, {
    id: "t001-a1",
    index: 1,
    taskId: "t001",
    status: "success",
    startedAt: "2026-04-26T00:00:01.000Z",
    finishedAt: "2026-04-26T00:00:02.000Z",
    cwd: root,
    attemptDir: attemptPaths.attemptDir,
    workerLogPath: attemptPaths.workerLogPath,
    reportPath: attemptPaths.reportPath,
    stdoutPath: attemptPaths.stdoutPath,
    stderrPath: attemptPaths.stderrPath,
    runtime: { status: "success" },
    workerReport: { status: "completed", errors: [], warnings: [] },
    failureKind: "none",
    retryability: "not_retryable",
    error: null,
    warnings: [],
  });
  assert.equal((await readJsonFile(path.join(attemptPaths.attemptDir, "attempt.json"))).id, "t001-a1");
});

test("isDiscoverableBatch rejects duplicate queued events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-discover-"));
  const [task] = [makeTask("t001")].map((item) => ({ ...item, cwd: root }));
  const batch = await createBatch({
    rootCwd: root,
    toolName: "task",
    tasks: [task],
    requestedConcurrency: 1,
    effectiveConcurrency: 1,
    batchId: "2026-04-26T00-00-00-000Z-discover",
    now: "2026-04-26T00:00:00.000Z",
  });

  await appendBatchEvent(batch.eventsPath, {
    schemaVersion: 1,
    seq: 99,
    at: "2026-04-26T00:00:00.000Z",
    type: "task_queued",
    batchId: batch.batchId,
    taskId: "t001",
  });

  assert.equal(await isDiscoverableBatch(batch.batchDir), false);
});
