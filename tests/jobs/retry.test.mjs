import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { computeBackoffMs, normalizeRetryPolicy, shouldRetryAttempt } from "../../extensions/jobs/retry.ts";
import { executeSupervisedJobs } from "../../extensions/jobs/supervisor.ts";

test("retry policy retries only retryable decisions without a valid worker report", () => {
  const policy = normalizeRetryPolicy({ maxAttempts: 3, backoffMs: { initial: 100, max: 1000, multiplier: 2, jitter: false } });
  assert.equal(shouldRetryAttempt({ attemptIndex: 1, policy, decision: { retryability: "retryable", failureKind: "provider_transient", reason: "429" }, validWorkerReport: false }), true);
  assert.equal(shouldRetryAttempt({ attemptIndex: 3, policy, decision: { retryability: "retryable", failureKind: "provider_transient", reason: "429" }, validWorkerReport: false }), false);
  assert.equal(shouldRetryAttempt({ attemptIndex: 1, policy, decision: { retryability: "not_retryable", failureKind: "acceptance_failed", reason: "bad" }, validWorkerReport: false }), false);
  assert.equal(shouldRetryAttempt({ attemptIndex: 1, policy, decision: { retryability: "retryable", failureKind: "provider_transient", reason: "429" }, validWorkerReport: true }), false);
});

test("computeBackoffMs applies multiplier and max without jitter", () => {
  const policy = normalizeRetryPolicy({ maxAttempts: 3, backoffMs: { initial: 100, max: 250, multiplier: 2, jitter: false } });
  assert.equal(computeBackoffMs(policy, 1), 100);
  assert.equal(computeBackoffMs(policy, 2), 200);
  assert.equal(computeBackoffMs(policy, 3), 250);
});

test("supervisor retries provider transient attempts and keeps attempt evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-retry-"));
  let calls = 0;
  const result = await executeSupervisedJobs({
    retry: { maxAttempts: 2, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
    jobs: [{ name: "retry-me", prompt: "Do it" }],
  }, { cwd: root, toolName: "jobs" }, {
    sleep: async () => {},
    runAttempt: async (input) => {
      calls += 1;
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      if (calls === 1) {
        await fs.writeFile(input.paths.workerLogPath, "", "utf-8");
        return {
          attemptId: input.attemptId,
          jobId: input.job.id,
          status: "error",
          exitCode: 1,
          sawTerminalAssistantMessage: false,
          stderrTail: "terminated",
          stdoutMalformedLines: 0,
          failureKind: "unknown",
          error: "terminated",
          startedAt: "2026-04-26T00:00:00.000Z",
          finishedAt: "2026-04-26T00:00:01.000Z",
        };
      }
      await fs.writeFile(input.paths.workerLogPath, "done", "utf-8");
      await fs.writeFile(input.paths.reportPath, JSON.stringify({
        schemaVersion: 1,
        jobId: input.job.id,
        attemptId: input.attemptId,
        status: "completed",
        summary: "Recovered and completed.",
        deliverables: [],
        evidence: [],
        internalRetries: [],
        userActionRequired: null,
        error: null,
      }), "utf-8");
      return {
        attemptId: input.attemptId,
        jobId: input.job.id,
        status: "success",
        exitCode: 0,
        stopReason: "stop",
        sawTerminalAssistantMessage: true,
        stderrTail: "",
        stdoutMalformedLines: 0,
        failureKind: "none",
        error: null,
        startedAt: "2026-04-26T00:00:02.000Z",
        finishedAt: "2026-04-26T00:00:03.000Z",
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.batch.status, "success");
  assert.equal(result.jobs[0].attempts.length, 2);
  assert.equal(result.jobs[0].finalStatus, "success");
});
