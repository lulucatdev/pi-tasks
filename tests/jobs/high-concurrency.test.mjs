import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { readJsonlTolerant } from "../../extensions/jobs/audit-log.ts";
import { executeSupervisedJobs } from "../../extensions/jobs/supervisor.ts";

test("high concurrency simulation terminalizes all jobs and records ordered artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-high-concurrency-"));
  const jobs = Array.from({ length: 50 }, (_, index) => ({ name: `job-${index + 1}`, prompt: `Do job ${index + 1}` }));
  const result = await executeSupervisedJobs({
    concurrency: 10,
    retry: { maxAttempts: 1, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
    throttle: { enabled: true, minConcurrency: 1, maxConcurrency: 10, transientFailureThreshold: 0.2, windowSize: 5 },
    jobs,
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      const numeric = Number(input.job.id.slice(1));
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, numeric % 7));
      if (numeric % 5 === 0) {
        await fs.writeFile(input.paths.workerLogPath, "transient failure", "utf-8");
        return {
          attemptId: input.attemptId,
          jobId: input.job.id,
          status: "error",
          exitCode: 1,
          sawTerminalAssistantMessage: false,
          stderrTail: "429 overloaded",
          stdoutMalformedLines: 0,
          failureKind: "unknown",
          error: "429 overloaded",
          startedAt: "start",
          finishedAt: "finish",
        };
      }
      await fs.writeFile(input.paths.workerLogPath, "done", "utf-8");
      await fs.writeFile(input.paths.reportPath, JSON.stringify({
        schemaVersion: 1,
        jobId: input.job.id,
        attemptId: input.attemptId,
        status: "completed",
        summary: `Done ${input.job.id}`,
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

  assert.equal(result.jobs.length, 50);
  assert.equal(result.jobs.every((job) => job.finalStatus === "success" || job.finalStatus === "error"), true);
  assert.deepEqual(result.jobs.map((job) => job.jobId), Array.from({ length: 50 }, (_, index) => `t${String(index + 1).padStart(3, "0")}`));
  assert.equal(result.batch.summary.success, 40);
  assert.equal(result.batch.summary.error, 10);
  assert.equal(result.batch.summary.providerTransientFailed, 10);

  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  const seqs = events.map((event) => event.seq);
  assert.equal(seqs.every((seq) => Number.isInteger(seq)), true);
  assert.ok(events.some((event) => event.type === "throttle_decision"));
});
