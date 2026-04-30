import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readJsonFile, readJsonlTolerant } from "../../extensions/jobs/audit-log.ts";
import { executeSupervisedJobs } from "../../extensions/jobs/supervisor.ts";

const execFileAsync = promisify(execFile);

async function successAttempt(input) {
  await fs.mkdir(input.paths.attemptDir, { recursive: true });
  await fs.writeFile(input.paths.workerLogPath, "Verification passed", "utf-8");
  await fs.writeFile(input.paths.reportPath, JSON.stringify({
    schemaVersion: 1,
    jobId: input.job.id,
    attemptId: input.attemptId,
    status: "completed",
    summary: `Completed ${input.job.name}`,
    deliverables: [{ path: "out.md", kind: "file" }],
    evidence: [{ kind: "text", value: "out.md verified" }],
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
    startedAt: "2026-04-26T00:00:00.000Z",
    finishedAt: "2026-04-26T00:00:01.000Z",
  };
}

async function failingAttempt(input) {
  await fs.mkdir(input.paths.attemptDir, { recursive: true });
  await fs.writeFile(input.paths.workerLogPath, "failed", "utf-8");
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

test("executeSupervisedJobs writes success batch/job/attempt artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-"));
  await fs.writeFile(path.join(root, "out.md"), "Chapter output", "utf-8");
  const result = await executeSupervisedJobs({
    jobs: [{ name: "demo", prompt: "Do it", acceptance: { requiredPaths: ["out.md"], requiredOutputRegex: ["Verification"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, { runAttempt: successAttempt, now: () => "2026-04-26T00:00:02.000Z" });

  assert.equal(result.batch.status, "success");
  assert.equal(result.batch.summary.success, 1);
  assert.match(result.text, /JOBS done · /);
  assert.match(result.text, /\/jobs-ui /);

  const job = await readJsonFile(path.join(result.batch.batchDir, "jobs", "t001.json"));
  assert.equal(job.finalStatus, "success");
  assert.equal(job.workerReport.status, "completed");
  assert.equal(job.acceptance.status, "passed");
  assert.equal(job.attempts.length, 1);

  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "batch_finished"));
});

test("executeSupervisedJobs emits live updates while jobs run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-live-"));
  const updates = [];
  const result = await executeSupervisedJobs({
    jobs: [
      { name: "one", prompt: "Do one" },
      { name: "two", prompt: "Do two" },
    ],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    onUpdate: (snapshot) => updates.push(snapshot),
    runAttempt: async (input) => {
      assert.ok(updates.some((snapshot) => snapshot.text.includes(`◐  ${input.job.id.padEnd(4, " ")}`)));
      await input.onActivity?.({ at: "2026-04-26T00:00:00.500Z", jobId: input.job.id, attemptId: input.attemptId, kind: "thinking", label: `Inspect ${input.job.name}` });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.ok(updates.length >= 4);
  assert.match(updates[0].text, /JOBS running · jobs · 0\/2/);
  assert.ok(updates.some((snapshot) => snapshot.text.includes("/jobs-ui ")));
  assert.ok(updates.some((snapshot) => snapshot.text.includes("◐  t001")));
  assert.ok(updates.some((snapshot) => snapshot.text.includes("Inspect one")));
  assert.ok(updates.some((snapshot) => snapshot.text.includes("✓  t001")));
  const job = await readJsonFile(path.join(result.batch.batchDir, "jobs", "t001.json"));
  assert.equal(job.activity[0].label, "Inspect one");
  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "job_activity" && event.data?.label === "Inspect one"));
});

test("executeSupervisedJobs emits heartbeat updates during quiet workers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-heartbeat-"));
  const updates = [];
  const result = await executeSupervisedJobs({
    jobs: [{ name: "quiet", prompt: "Be quiet" }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    onUpdate: (snapshot) => updates.push(snapshot),
    liveUpdateIntervalMs: 5,
    runAttempt: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.ok(updates.length >= 4);
  assert.ok(updates.some((snapshot) => /JOBS running · jobs · \d+\/1 · \d+s/.test(snapshot.text)));
});

test("executeSupervisedJobs creates batch artifacts before cwd launch failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-invalid-cwd-"));
  const updates = [];
  const result = await executeSupervisedJobs({
    jobs: [{ name: "bad-cwd", prompt: "Run there", cwd: "missing-dir" }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    onUpdate: (snapshot) => updates.push(snapshot),
    runAttempt: async (input) => ({
      attemptId: input.attemptId,
      jobId: input.job.id,
      status: "error",
      exitCode: 1,
      sawTerminalAssistantMessage: false,
      stderrTail: "spawn cwd ENOENT",
      stdoutMalformedLines: 0,
      failureKind: "launch_error",
      error: "spawn cwd ENOENT",
      startedAt: "2026-04-26T00:00:00.000Z",
      finishedAt: "2026-04-26T00:00:01.000Z",
    }),
  });

  assert.equal(result.batch.status, "error");
  assert.match(updates[0].text, /JOBS running · jobs · 0\/1/);
  assert.equal(await fs.stat(path.join(result.batch.batchDir, "batch.json")).then(() => true), true);
  assert.equal(result.jobs[0].failureKind, "launch_error");
});

test("executeSupervisedJobs fails write-boundary acceptance when neither git diff nor worker telemetry is available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-write-audit-"));
  const result = await executeSupervisedJobs({
    jobs: [{ name: "write", prompt: "Write only allowed files", acceptance: { allowedWritePaths: ["allowed/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, { runAttempt: successAttempt });

  assert.equal(result.batch.status, "error");
  assert.equal(result.jobs[0].failureKind, "acceptance_failed");
  assert.ok(result.jobs[0].acceptance.errors.some((error) => error.includes("requires write audit")));
});

test("executeSupervisedJobs accepts write-boundary jobs in non-git cwds when telemetry observed the writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-telemetry-audit-"));
  const result = await executeSupervisedJobs({
    jobs: [{ name: "write", prompt: "Write inside allowed zone", acceptance: { allowedWritePaths: ["allowed/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      const { appendWorkerEvent, buildWorkerEvent, workerEventsPathForAttempt } = await import("../../extensions/jobs/worker-events.ts");
      const eventsPath = workerEventsPathForAttempt(input.paths.attemptDir);
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await appendWorkerEvent(eventsPath, buildWorkerEvent({ type: "tool_call_started", jobId: input.job.id, attemptId: input.attemptId, tool: "edit", args: { path: "allowed/out.md" } }));
      await appendWorkerEvent(eventsPath, buildWorkerEvent({ type: "file_write_observed", jobId: input.job.id, attemptId: input.attemptId, tool: "edit", path: "allowed/out.md", args: { path: "allowed/out.md" } }));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.equal(result.jobs[0].acceptance.status, "passed");
});

test("executeSupervisedJobs accepts read-only write-boundary jobs when telemetry channel was alive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-telemetry-empty-"));
  const result = await executeSupervisedJobs({
    jobs: [{ name: "read-only", prompt: "Read but do not write", acceptance: { allowedWritePaths: ["allowed/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      const { appendWorkerEvent, buildWorkerEvent, workerEventsPathForAttempt } = await import("../../extensions/jobs/worker-events.ts");
      const eventsPath = workerEventsPathForAttempt(input.paths.attemptDir);
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await appendWorkerEvent(eventsPath, buildWorkerEvent({ type: "tool_call_started", jobId: input.job.id, attemptId: input.attemptId, tool: "read", args: { path: "README.md" } }));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.equal(result.jobs[0].acceptance.status, "passed");
});

test("executeSupervisedJobs preserves rerun provenance and emits unique event sequence numbers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-rerun-"));
  const result = await executeSupervisedJobs({
    parentBatchId: "parent-batch",
    rerunOfJobIds: ["old-t001"],
    jobs: [
      { name: "one", prompt: "Do one" },
      { name: "two", prompt: "Do two" },
      { name: "three", prompt: "Do three" },
    ],
    concurrency: 3,
  }, { cwd: root, toolName: "jobs" }, { runAttempt: successAttempt });

  assert.equal(result.batch.parentBatchId, "parent-batch");
  assert.deepEqual(result.batch.rerunOfJobIds, ["old-t001"]);
  const persisted = await readJsonFile(path.join(result.batch.batchDir, "batch.json"));
  assert.equal(persisted.parentBatchId, "parent-batch");
  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
});

test("executeSupervisedJobs marks queued jobs aborted without launching after root abort", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-abort-queued-"));
  const controller = new AbortController();
  let launchedAfterAbort = 0;
  const result = await executeSupervisedJobs({
    jobs: [{ name: "first", prompt: "first" }, { name: "queued", prompt: "queued" }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs", signal: controller.signal }, {
    runAttempt: async (input) => {
      if (input.job.name === "queued") launchedAfterAbort += 1;
      controller.abort();
      return {
        attemptId: input.attemptId,
        jobId: input.job.id,
        status: "aborted",
        exitCode: 1,
        sawTerminalAssistantMessage: false,
        stderrTail: "",
        stdoutMalformedLines: 0,
        failureKind: "aborted",
        error: "aborted",
        startedAt: "start",
        finishedAt: "finish",
      };
    },
  });

  assert.equal(result.batch.status, "aborted");
  assert.equal(launchedAfterAbort, 0);
  assert.equal(result.jobs[1].finalStatus, "aborted");
  assert.equal(result.jobs[1].attempts.length, 0);
});

test("executeSupervisedJobs applies throttle decisions before launching more queued jobs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-throttle-"));
  let active = 0;
  let firstFailureRecorded = false;
  let launchedTooEarly = false;

  const result = await executeSupervisedJobs({
    jobs: ["fail", "slow", "queued"].map((name) => ({ name, prompt: `Do ${name}` })),
    concurrency: 2,
    retry: { maxAttempts: 1 },
    throttle: { enabled: true, minConcurrency: 1, maxConcurrency: 2, transientFailureThreshold: 1, windowSize: 1 },
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      active += 1;
      if (input.job.name === "queued" && firstFailureRecorded && active > 1) launchedTooEarly = true;
      try {
        if (input.job.name === "fail") {
          const failed = await failingAttempt(input);
          firstFailureRecorded = true;
          return failed;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return successAttempt(input);
      } finally {
        active -= 1;
      }
    },
  });

  assert.equal(result.batch.status, "error");
  assert.equal(launchedTooEarly, false);
  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "throttle_decision" && event.data?.nextConcurrency === 1));
});

test("executeSupervisedJobs converts git status paths to job-cwd-relative write paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-git-cwd-"));
  const subdir = path.join(root, "extensions", "jobs");
  await fs.mkdir(subdir, { recursive: true });
  await fs.writeFile(path.join(subdir, "commands.ts"), "old", "utf-8");
  await execFileAsync("git", ["init"], { cwd: root });

  const result = await executeSupervisedJobs({
    jobs: [{ name: "write", prompt: "Write commands", cwd: "extensions/jobs", acceptance: { allowedWritePaths: ["commands.ts"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      await fs.writeFile(path.join(input.job.cwd, "commands.ts"), "new", "utf-8");
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.equal(result.jobs[0].acceptance.status, "passed");
});

test("executeSupervisedJobs runs disjoint write-boundary jobs in parallel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-write-parallel-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const result = await executeSupervisedJobs({
    jobs: [
      { name: "one", prompt: "one", acceptance: { allowedWritePaths: ["chapters/ch01/**"] } },
      { name: "two", prompt: "two", acceptance: { allowedWritePaths: ["chapters/ch02/**"] } },
    ],
    concurrency: 2,
  }, { cwd: root, toolName: "jobs" }, { runAttempt: successAttempt });

  assert.equal(result.batch.effectiveConcurrency, 2);
  assert.equal(result.batch.status, "success");
});

test("executeSupervisedJobs attributes git changes only to the job whose allowed zone matches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-write-attribute-"));
  await fs.mkdir(path.join(root, "chapters", "ch01"), { recursive: true });
  await fs.mkdir(path.join(root, "chapters", "ch02"), { recursive: true });
  await execFileAsync("git", ["init"], { cwd: root });
  let order = 0;
  const order01 = { started: -1, finished: -1 };
  const order02 = { started: -1, finished: -1 };
  const result = await executeSupervisedJobs({
    jobs: [
      { name: "one", prompt: "one", acceptance: { allowedWritePaths: ["chapters/ch01/**"] } },
      { name: "two", prompt: "two", acceptance: { allowedWritePaths: ["chapters/ch02/**"] } },
    ],
    concurrency: 2,
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      const tracker = input.job.id === "t001" ? order01 : order02;
      tracker.started = order++;
      await fs.writeFile(path.join(root, "chapters", input.job.id === "t001" ? "ch01" : "ch02", "out.tex"), "x", "utf-8");
      await new Promise((resolve) => setTimeout(resolve, 400));
      const settled = await successAttempt(input);
      tracker.finished = order++;
      return settled;
    },
  });


  assert.equal(result.batch.status, "success");
  assert.ok(order01.started <= order02.started, "t001 should start before/at the same time as t002");
  // Parallel: t001 should still be running when t002 starts.
  assert.ok(order02.started < order01.finished, "t002 must start before t001 finishes when they run in parallel");
  for (const job of result.jobs) {
    for (const error of job.acceptance.errors) {
      assert.doesNotMatch(error, /outside allowed write paths/, `${job.jobId} mis-attributed cross-job writes`);
    }
  }
});

test("executeSupervisedJobs detects forbidden writes across retry attempts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-retry-write-audit-"));
  await fs.mkdir(path.join(root, "secret"), { recursive: true });
  await execFileAsync("git", ["init"], { cwd: root });
  let attempts = 0;

  const result = await executeSupervisedJobs({
    jobs: [{ name: "retry", prompt: "Retry", acceptance: { forbiddenWritePaths: ["secret/**"] } }],
    retry: { maxAttempts: 2, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      attempts += 1;
      if (attempts === 1) {
        await fs.writeFile(path.join(root, "secret", "leak.txt"), "leak", "utf-8");
        return failingAttempt(input);
      }
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "error");
  assert.equal(result.jobs[0].failureKind, "acceptance_failed");
  assert.ok(result.jobs[0].acceptance.errors.some((error) => error.includes("secret/leak.txt")));
});

test("executeSupervisedJobs detects writes to files that were already dirty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-dirty-write-"));
  await fs.mkdir(path.join(root, "secret"), { recursive: true });
  await fs.writeFile(path.join(root, "secret", "token.txt"), "before", "utf-8");
  await execFileAsync("git", ["init"], { cwd: root });

  const result = await executeSupervisedJobs({
    jobs: [{ name: "dirty", prompt: "Do not write secret", acceptance: { forbiddenWritePaths: ["secret/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(path.join(root, "secret", "token.txt"), "after", "utf-8");
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "error");
  assert.equal(result.jobs[0].failureKind, "acceptance_failed");
  assert.ok(result.jobs[0].acceptance.errors.some((error) => error.includes("secret/token.txt")));
});

test("executeSupervisedJobs final result text shows the per-job table with finished icons", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-final-table-"));
  const result = await executeSupervisedJobs({
    jobs: [
      { id: "ch01", name: "ch01", prompt: "do" },
      { id: "ch02", name: "ch02", prompt: "do" },
      { id: "ch03", name: "ch03", prompt: "do" },
    ],
    concurrency: 3,
    retry: { maxAttempts: 1 },
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: (input) => input.job.id === "ch02" ? failingAttempt(input) : successAttempt(input),
  });

  assert.equal(result.batch.status, "error");
  assert.match(result.text, /^JOBS error · jobs · 2✓ 1✗ \/ 3/);
  assert.match(result.text, /✓\s+ch01/);
  assert.match(result.text, /✗\s+ch02/);
  assert.match(result.text, /✓\s+ch03/);
  assert.match(result.text, /\/jobs-ui /);
  assert.match(result.text, /summary: /);
  assert.match(result.text, /rerun failed: \/jobs-ui rerun failed /);
});

test("executeSupervisedJobs shows 'no job report' when worker exits without writing job-report.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-no-report-"));
  const result = await executeSupervisedJobs({
    jobs: [{ id: "ch09_ch10", name: "Content QA MICRO102 ch09-ch10", prompt: "do" }],
    concurrency: 1,
    retry: { maxAttempts: 1 },
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      // Simulate a worker that ran cleanly but never produced job-report.json or worker.md.
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await fs.writeFile(input.paths.workerLogPath, "", "utf-8");
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
        startedAt: "2026-04-26T00:00:00.000Z",
        finishedAt: "2026-04-26T00:00:01.000Z",
      };
    },
  });

  assert.equal(result.batch.status, "error");
  assert.equal(result.jobs[0].failureKind, "worker_incomplete");
  assert.match(result.jobs[0].workerReport.errors.join("\n"), /No job report submitted/);
  assert.match(result.text, /✗\s+ch09_ch10\s+Content QA MICRO102 ch09-ch10 · no job report/);
  // worker_incomplete is parent-retryable by default; the test pins maxAttempts=1 so it stays at one attempt.
  assert.equal(result.jobs[0].retryability, "retryable");
});

test("executeSupervisedJobs fails exit-0 workers that produce no terminal event or job report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-exit0-no-report-"));
  const result = await executeSupervisedJobs({
    jobs: [{ id: "silent", name: "silent worker", prompt: "do" }],
    concurrency: 1,
    retry: { maxAttempts: 1 },
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await fs.writeFile(input.paths.workerLogPath, "", "utf-8");
      return {
        attemptId: input.attemptId,
        jobId: input.job.id,
        status: "success",
        exitCode: 0,
        sawTerminalAssistantMessage: false,
        stderrTail: "",
        stdoutMalformedLines: 0,
        failureKind: "none",
        error: null,
        startedAt: "2026-04-26T00:00:00.000Z",
        finishedAt: "2026-04-26T00:00:01.000Z",
      };
    },
  });

  assert.equal(result.batch.status, "error");
  assert.equal(result.jobs[0].finalStatus, "error");
  assert.equal(result.jobs[0].failureKind, "worker_incomplete");
  assert.match(result.jobs[0].workerReport.errors.join("\n"), /No job report submitted/);
});

test("executeSupervisedJobs live snapshot shows running icon, not stale ✗, while a retry is in flight", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-retry-snapshot-"));
  let attempts = 0;
  const seenDuringRetry = [];
  const result = await executeSupervisedJobs({
    jobs: [{ id: "ch09_ch10", name: "ch09_ch10", prompt: "do" }],
    concurrency: 1,
    retry: { maxAttempts: 2, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
  }, { cwd: root, toolName: "jobs" }, {
    onUpdate: (snapshot) => {
      // Capture snapshots that show the second attempt active (only meaningful
      // after attempt 1 has already settled with a failure that previously
      // leaked into the live UI).
      if (snapshot.batch.summary.total === 1 && snapshot.jobs[0]?.attempts?.length >= 1 && snapshot.jobs[0].status === "running") {
        seenDuringRetry.push({
          icon: snapshot.text.split("\n").find((line) => /ch09_ch10/.test(line)),
          finalStatus: snapshot.jobs[0].finalStatus,
          failureKind: snapshot.jobs[0].failureKind,
        });
      }
    },
    runAttempt: async (input) => {
      attempts += 1;
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await fs.writeFile(input.paths.workerLogPath, "", "utf-8");
      if (attempts === 1) {
        return {
          attemptId: input.attemptId, jobId: input.job.id, status: "error", exitCode: 0,
          stopReason: "thinking_only_stop", sawTerminalAssistantMessage: false,
          stderrTail: "", stdoutMalformedLines: 0, failureKind: "worker_incomplete",
          error: "thinking-only", startedAt: "2026-04-26T00:00:00.000Z", finishedAt: "2026-04-26T00:00:01.000Z",
        };
      }
      return successAttempt(input);
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.batch.status, "success");
  // While attempt 2 was running we must not have shown the previous attempt's
  // ✗ icon or its 'no job report' / 'thinking-only stop' label.
  assert.ok(seenDuringRetry.length > 0, "should emit at least one snapshot during the retry");
  for (const snapshot of seenDuringRetry) {
    assert.equal(snapshot.finalStatus, null, "finalStatus must reset to null while a retry is in flight");
    assert.equal(snapshot.failureKind, "none", "failureKind must reset while a retry is in flight");
    assert.ok(snapshot.icon && snapshot.icon.startsWith("◐"), `expected running icon, got: ${snapshot.icon}`);
    assert.doesNotMatch(snapshot.icon ?? "", /✗/, "must not show ✗ while running a retry");
    assert.doesNotMatch(snapshot.icon ?? "", /no job report|thinking-only stop|worker incomplete/, "must not echo previous failure reason while running");
  }
});

test("executeSupervisedJobs parent-retries worker_incomplete attempts under default retry policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-incomplete-retry-"));
  let attempts = 0;
  const result = await executeSupervisedJobs({
    jobs: [{ id: "ch09_ch10", name: "ch09_ch10", prompt: "do" }],
    concurrency: 1,
    retry: { maxAttempts: 2, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: async (input) => {
      attempts += 1;
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await fs.writeFile(input.paths.workerLogPath, "", "utf-8");
      if (attempts === 1) {
        // First attempt: thinking-only stop, no report submitted.
        return {
          attemptId: input.attemptId, jobId: input.job.id, status: "error", exitCode: 0,
          stopReason: "thinking_only_stop", sawTerminalAssistantMessage: false,
          stderrTail: "", stdoutMalformedLines: 0, failureKind: "worker_incomplete",
          error: "assistant ended its turn with thinking-only content (no text or tool call)",
          startedAt: "2026-04-26T00:00:00.000Z", finishedAt: "2026-04-26T00:00:01.000Z",
        };
      }
      // Second attempt: clean success.
      return successAttempt(input);
    },
  });

  assert.equal(attempts, 2, "should retry once");
  assert.equal(result.batch.status, "success");
  assert.equal(result.jobs[0].finalStatus, "success");
  assert.equal(result.jobs[0].attempts.length, 2);
});

test("executeSupervisedJobs first-line body shows job summary not live activity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-body-summary-"));
  let runtimeSnapshot = "";
  const result = await executeSupervisedJobs({
    jobs: [
      { id: "ch11-rerun", name: "Rerun MICRO102 ch11 fix from Oracle meta-review", prompt: "do" },
      { id: "ch01", name: "ch01", prompt: "do" },
      { id: "ch02", name: "oracle-chapter-fixes ch02", prompt: "do" },
    ],
    concurrency: 3,
    retry: { maxAttempts: 1 },
  }, { cwd: root, toolName: "jobs" }, {
    onUpdate: (s) => { if (s.text.includes("◐")) runtimeSnapshot = s.text; },
    runAttempt: async (input) => {
      await input.onActivity?.({ at: "2026-04-26T00:00:00.500Z", jobId: input.job.id, attemptId: input.attemptId, kind: "tool", label: "Bash finished" });
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  // First-line body keeps a stable summary (the job name with id-suffix stripped),
  // never the latest activity.
  assert.match(result.text, /✓\s+ch11-rerun\s+Rerun MICRO102 ch11 fix from Oracle meta-review/);
  // ID-only name yields no body
  assert.match(result.text, /^✓\s+ch01\s*$/m);
  // jobs_plan-style auto name "<batchName> <id>" gets the trailing id stripped
  assert.match(result.text, /✓\s+ch02\s+oracle-chapter-fixes/);
  // Body must NOT echo the latest activity ("Bash finished" lives in the tree)
  const ch01Line = result.text.split("\n").find((line) => /✓ {2}ch01/.test(line));
  assert.ok(ch01Line, "ch01 line present");
  assert.doesNotMatch(ch01Line, /Bash finished/);
  // Live snapshot also keeps body == summary, not activity
  if (runtimeSnapshot) {
    const ch11Live = runtimeSnapshot.split("\n").find((line) => /◐ {2}ch11-rerun/.test(line));
    if (ch11Live) assert.doesNotMatch(ch11Live, /Bash finished/);
  }
});

test("executeSupervisedJobs renders per-job model/thinking meta and a thinking tree for failed jobs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-meta-"));
  const result = await executeSupervisedJobs({
    jobs: [
      { id: "ch01", name: "ch01", prompt: "do" },
      { id: "ch02", name: "ch02", prompt: "do" },
    ],
    concurrency: 2,
    retry: { maxAttempts: 1 },
  }, { cwd: root, toolName: "jobs", model: "anthropic/claude-opus-4-7", thinking: "xhigh" }, {
    runAttempt: async (input) => {
      await input.onActivity?.({ at: "2026-04-26T00:00:00.500Z", jobId: input.job.id, attemptId: input.attemptId, kind: "tool", label: `Edit ${input.job.id}.tex` });
      await input.onActivity?.({ at: "2026-04-26T00:00:01.500Z", jobId: input.job.id, attemptId: input.attemptId, kind: "tool", label: `Verify ${input.job.id}` });
      return input.job.id === "ch02" ? failingAttempt(input) : successAttempt(input);
    },
  });

  assert.equal(result.batch.defaultModel, "anthropic/claude-opus-4-7");
  assert.equal(result.batch.defaultThinking, "xhigh");
  assert.match(result.text, /◊ anthropic\/claude-opus-4-7\/xhigh/);
  // Failed job gets a thinking-steps tree
  assert.match(result.text, /┆ Thinking Steps · Summary/);
  assert.match(result.text, /├─ /);
  assert.match(result.text, /└─ /);
  // Successful jobs omit the tree (only a single line)
  const ch01Line = result.text.split("\n").find((line) => /✓ {2}ch01/.test(line));
  assert.ok(ch01Line, "ch01 should have a status line");
});

test("executeSupervisedJobs final result text uses 'done' verb when every job succeeds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-final-done-"));
  const result = await executeSupervisedJobs({
    jobs: [
      { id: "ch01", name: "ch01", prompt: "do" },
      { id: "ch02", name: "ch02", prompt: "do" },
    ],
    concurrency: 2,
  }, { cwd: root, toolName: "jobs" }, { runAttempt: successAttempt });

  assert.equal(result.batch.status, "success");
  assert.match(result.text, /^JOBS done · jobs · 2✓ \/ 2/);
  assert.match(result.text, /✓\s+ch01/);
  assert.match(result.text, /✓\s+ch02/);
  assert.doesNotMatch(result.text, /rerun failed:/);
});

test("executeSupervisedJobs terminalizes every job when one attempt fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-fail-"));
  const result = await executeSupervisedJobs({
    jobs: [
      { name: "ok", prompt: "Do ok" },
      { name: "bad", prompt: "Do bad" },
    ],
    concurrency: 1,
  }, { cwd: root, toolName: "jobs" }, {
    runAttempt: (input) => input.job.name === "bad" ? failingAttempt(input) : successAttempt(input),
  });

  assert.equal(result.batch.status, "error");
  assert.equal(result.jobs.length, 2);
  assert.deepEqual(result.jobs.map((job) => job.finalStatus), ["success", "error"]);
  assert.equal(result.batch.summary.error, 1);
  assert.equal(result.jobs[1].failureKind, "provider_transient");
});
