import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { executeSupervisedJobs } from "../../extensions/jobs/supervisor.ts";
import { listBatches, loadBatchDetail, renderAttemptDetailLines, renderBatchDetailLines, renderBatchListLines, renderJobDetailLines, renderJobsUiHelpLines, resolveBatchDir } from "../../extensions/jobs/job-ui.ts";

async function successAttempt(input) {
  await fs.mkdir(input.paths.attemptDir, { recursive: true });
  await fs.writeFile(input.paths.workerLogPath, "done", "utf-8");
  await fs.writeFile(input.paths.reportPath, JSON.stringify({
    schemaVersion: 1,
    jobId: input.job.id,
    attemptId: input.attemptId,
    status: "completed",
    summary: "Done",
    deliverables: [],
    evidence: [],
  }), "utf-8");
  return {
    attemptId: input.attemptId,
    jobId: input.job.id,
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

test("job-ui lists and renders artifact-backed batches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-ui-"));
  const result = await executeSupervisedJobs({ jobs: [{ name: "ok", prompt: "Do ok" }] }, { cwd: root, toolName: "jobs" }, { runAttempt: successAttempt });

  const list = await listBatches(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].batchId, result.batch.batchId);
  assert.match(renderBatchListLines(list).join("\n"), /SUCCESS/);

  assert.equal(resolveBatchDir(root, result.batch.batchId), result.batch.batchDir);
  const detail = await loadBatchDetail(resolveBatchDir(root, result.batch.batchId));
  assert.equal(detail.jobs[0].name, "ok");
  const batchText = renderBatchDetailLines(detail).join("\n");
  assert.match(batchText, /t001 ok: SUCCESS/);
  assert.match(batchText, /Next commands/);
  assert.match(batchText, /\/jobs-ui .* job <jobId>/);
  assert.match(detail.summaryMarkdown, /# Jobs Batch/);

  const jobText = renderJobDetailLines(detail, "t001").join("\n");
  assert.match(jobText, /Job t001 ok/);
  assert.match(jobText, /Report summary: Done/);
  assert.match(jobText, /Latest attempt artifacts/);

  const attemptText = renderAttemptDetailLines(detail, "t001", "latest").join("\n");
  assert.match(attemptText, /Attempt t001-a1/);
  assert.match(attemptText, /Artifacts:/);
});

test("job-ui renders failure triage and help", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-ui-fail-"));
  const result = await executeSupervisedJobs({
    jobs: [{ name: "bad", prompt: "Do bad", acceptance: { requiredPaths: ["missing.md"] } }],
  }, { cwd: root, toolName: "jobs" }, { runAttempt: successAttempt });

  const detail = await loadBatchDetail(result.batch.batchDir);
  const batchText = renderBatchDetailLines(detail).join("\n");
  assert.match(batchText, /Failed jobs/);
  assert.match(batchText, /acceptance/);
  assert.match(batchText, /\/jobs-ui rerun failed/);

  const jobText = renderJobDetailLines(detail, "bad").join("\n");
  assert.match(jobText, /Acceptance errors/);
  assert.match(jobText, /\/jobs-ui rerun selected/);

  assert.match(renderJobsUiHelpLines().join("\n"), /rerun selected/);
});
