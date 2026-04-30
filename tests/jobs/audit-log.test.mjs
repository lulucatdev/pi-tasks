import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAttemptPaths,
  buildBatchPaths,
  createBatch,
  generateJobIds,
  appendBatchEvent,
  isDiscoverableBatch,
  readJsonFile,
  readJsonlTolerant,
  writeAttemptArtifact,
  writeBatchArtifact,
} from "../../extensions/jobs/audit-log.ts";

function makeJob(id = "t001") {
  return {
    id,
    name: `job-${id}`,
    prompt: `Do ${id}`,
    cwd: "/tmp/project",
  };
}

test("batch layout uses .pi/jobs/<batchId> with job and attempt subdirectories", () => {
  const paths = buildBatchPaths("/tmp/project", "2026-04-26T00-00-00-000Z-abcdef");
  assert.equal(paths.batchDir, "/tmp/project/.pi/jobs/2026-04-26T00-00-00-000Z-abcdef");
  assert.equal(paths.batchPath, `${paths.batchDir}/batch.json`);
  assert.equal(paths.eventsPath, `${paths.batchDir}/events.jsonl`);
  assert.equal(paths.summaryPath, `${paths.batchDir}/summary.md`);
  assert.equal(paths.jobsDir, `${paths.batchDir}/jobs`);
  assert.equal(paths.attemptsDir, `${paths.batchDir}/attempts`);

  const attempt = buildAttemptPaths(paths, "t001", 2);
  assert.equal(attempt.attemptDir, `${paths.batchDir}/attempts/t001/attempt-2`);
  assert.equal(attempt.workerLogPath, `${attempt.attemptDir}/worker.md`);
  assert.equal(attempt.reportPath, `${attempt.attemptDir}/job-report.json`);
});

test("generateJobIds creates stable batch-local ids", () => {
  assert.deepEqual(generateJobIds(4), ["t001", "t002", "t003", "t004"]);
});

test("createBatch writes initialized batch, queued jobs, and events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-audit-"));
  const jobs = [makeJob("t001"), makeJob("t002")].map((job) => ({ ...job, cwd: root }));
  const batch = await createBatch({
    rootCwd: root,
    toolName: "jobs",
    jobs,
    requestedConcurrency: 8,
    effectiveConcurrency: 8,
    batchId: "2026-04-26T00-00-00-000Z-abcdef",
    now: "2026-04-26T00:00:00.000Z",
  });

  const artifact = await readJsonFile(batch.batchPath);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.initialized, true);
  assert.equal(artifact.status, "running");
  assert.deepEqual(artifact.jobIds, ["t001", "t002"]);

  const events = await readJsonlTolerant(batch.eventsPath);
  assert.deepEqual(events.map((event) => event.type), ["batch_started", "job_queued", "job_queued"]);

  const job = await readJsonFile(path.join(batch.jobsDir, "t001.json"));
  assert.equal(job.schemaVersion, 1);
  assert.equal(job.batchId, artifact.batchId);
  assert.equal(job.jobId, "t001");
  assert.deepEqual(job.timeline, [{ at: "2026-04-26T00:00:00.000Z", state: "queued" }]);

  assert.equal(await isDiscoverableBatch(batch.batchDir), true);
});

test("readJsonlTolerant rejects complete corrupt trailing records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-jsonl-corrupt-"));
  const file = path.join(root, "events.jsonl");
  await fs.writeFile(file, '{"ok":true}\n{"bad":\n', "utf-8");
  await assert.rejects(() => readJsonlTolerant(file));
});

test("readJsonlTolerant ignores one partial trailing line", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-jsonl-"));
  const file = path.join(root, "events.jsonl");
  await fs.writeFile(file, '{"ok":true}\n{"partial":', "utf-8");
  assert.deepEqual(await readJsonlTolerant(file), [{ ok: true }]);
});

test("artifact writers atomically rewrite batch and write attempt records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-writer-"));
  const [job] = [makeJob("t001")].map((item) => ({ ...item, cwd: root }));
  const batch = await createBatch({
    rootCwd: root,
    toolName: "job",
    jobs: [job],
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
    jobId: "t001",
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-discover-"));
  const [job] = [makeJob("t001")].map((item) => ({ ...item, cwd: root }));
  const batch = await createBatch({
    rootCwd: root,
    toolName: "job",
    jobs: [job],
    requestedConcurrency: 1,
    effectiveConcurrency: 1,
    batchId: "2026-04-26T00-00-00-000Z-discover",
    now: "2026-04-26T00:00:00.000Z",
  });

  await appendBatchEvent(batch.eventsPath, {
    schemaVersion: 1,
    seq: 99,
    at: "2026-04-26T00:00:00.000Z",
    type: "job_queued",
    batchId: batch.batchId,
    jobId: "t001",
  });

  assert.equal(await isDiscoverableBatch(batch.batchDir), false);
});
