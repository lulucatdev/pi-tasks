import test from "node:test";
import assert from "node:assert/strict";

import { countJobLifecycle, deriveJobView, summarizeJobs } from "../../extensions/jobs/job-view.ts";
import { emptyAcceptance, emptyWorkerReport } from "../../extensions/jobs/types.ts";

function job(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: "b001",
    jobId: "t001",
    name: "Job t001",
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

test("deriveJobView ignores stale terminal fields while a retry is running", () => {
  const view = deriveJobView(job({
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

test("summarizeJobs materializes counts from job views", () => {
  const jobs = [
    job({ jobId: "ok", status: "success", finalStatus: "success", workerReport: emptyWorkerReport("completed"), acceptance: emptyAcceptance("passed") }),
    job({ jobId: "bad", status: "error", finalStatus: "error", failureKind: "acceptance_failed", attempts: [{ id: "bad-a1" }, { id: "bad-a2" }] }),
    job({ jobId: "run", status: "running", finalStatus: "error", failureKind: "worker_incomplete", attempts: [{ id: "run-a1" }] }),
  ];

  assert.deepEqual(summarizeJobs(jobs), {
    total: 3,
    success: 1,
    error: 1,
    aborted: 0,
    acceptanceFailed: 1,
    providerTransientFailed: 0,
    protocolFailed: 0,
    retried: 1,
  });
  assert.equal(countJobLifecycle(jobs).running, 1);
  assert.equal(countJobLifecycle(jobs).done, 2);
});
