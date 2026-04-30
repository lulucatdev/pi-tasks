import test from "node:test";
import assert from "node:assert/strict";

import { renderLiveDashboardLines } from "../../extensions/jobs/job-ui.ts";

test("renderLiveDashboardLines shows live supervisor state", () => {
  const lines = renderLiveDashboardLines({
    batch: {
      schemaVersion: 1,
      batchId: "batch-live",
      toolName: "jobs",
      rootCwd: "/tmp/project",
      batchDir: "/tmp/project/.pi/jobs/batch-live",
      startedAt: "start",
      finishedAt: null,
      status: "running",
      initialized: true,
      auditIntegrity: "pending",
      jobIds: ["t001"],
      requestedConcurrency: 4,
      effectiveConcurrency: 2,
      summary: { total: 1, success: 0, error: 0, aborted: 0, acceptanceFailed: 0, providerTransientFailed: 0, protocolFailed: 0, retried: 0 },
    },
    jobs: [{
      schemaVersion: 1,
      batchId: "batch-live",
      jobId: "t001",
      name: "live-job",
      prompt: "Do it",
      cwd: "/tmp/project",
      status: "running",
      finalStatus: null,
      failureKind: "none",
      retryability: "not_retryable",
      acceptance: { status: "pending", checks: [], warnings: [], errors: [] },
      workerReport: { status: "not_submitted", errors: [], warnings: [] },
      attempts: [{ id: "t001-a1" }],
      queuedAt: "start",
      startedAt: "start",
      finishedAt: null,
      timeline: [],
      warnings: [],
      error: null,
    }],
    currentConcurrency: 2,
    retryBackoffMs: 1500,
    latestProgress: "reading files",
    lastHeartbeatAt: "2026-04-26T00:00:00.000Z",
    abortableJobIds: ["t001"],
  });

  const text = lines.join("\n");
  assert.match(text, /Concurrency: 2/);
  assert.match(text, /Last heartbeat/);
  assert.match(text, /Retry backoff: 1500ms/);
  assert.match(text, /live-job/);
  assert.match(text, /Abortable: t001/);
});
