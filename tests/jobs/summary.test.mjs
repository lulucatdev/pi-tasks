import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildSummaryMarkdown } from "../../extensions/jobs/summary.ts";
import { executeSupervisedJobs } from "../../extensions/jobs/supervisor.ts";

test("buildSummaryMarkdown includes status, job table, failures, and rerun payload", () => {
  const batch = {
    schemaVersion: 1,
    batchId: "batch-1",
    toolName: "jobs",
    rootCwd: "/tmp/project",
    batchDir: "/tmp/project/.pi/jobs/batch-1",
    startedAt: "start",
    finishedAt: "finish",
    status: "error",
    initialized: true,
    auditIntegrity: "ok",
    jobIds: ["t001"],
    requestedConcurrency: 1,
    effectiveConcurrency: 1,
    summary: { total: 1, success: 0, error: 1, aborted: 0, acceptanceFailed: 1, providerTransientFailed: 0, protocolFailed: 0, retried: 0 },
  };
  const job = {
    schemaVersion: 1,
    batchId: "batch-1",
    jobId: "t001",
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
  const markdown = buildSummaryMarkdown(batch, [job], { jobs: [{ name: "bad", prompt: "Do bad" }] });
  assert.match(markdown, /# Jobs Batch batch-1/);
  assert.match(markdown, /Acceptance failed: 1/);
  assert.match(markdown, /Suggested Rerun Payload/);
  assert.match(markdown, /Inspect: \/jobs-ui batch-1/);
  assert.match(markdown, /Rerun failed: \/jobs-ui rerun failed batch-1/);
});

test("supervisor writes summary.md for completed batches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-summary-supervisor-"));
  const result = await executeSupervisedJobs({ jobs: [{ name: "ok", prompt: "Do ok" }] }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
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
    },
  });

  const summary = await fs.readFile(path.join(result.batch.batchDir, "summary.md"), "utf-8");
  assert.match(summary, /# Jobs Batch/);
  assert.match(summary, /OK/);
});
