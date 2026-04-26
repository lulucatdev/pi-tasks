import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readJsonFile, readJsonlTolerant } from "../../extensions/task/audit-log.ts";
import { executeSupervisedTasks } from "../../extensions/task/supervisor.ts";

const execFileAsync = promisify(execFile);

async function successAttempt(input) {
  await fs.mkdir(input.paths.attemptDir, { recursive: true });
  await fs.writeFile(input.paths.workerLogPath, "Verification passed", "utf-8");
  await fs.writeFile(input.paths.reportPath, JSON.stringify({
    schemaVersion: 1,
    taskId: input.task.id,
    attemptId: input.attemptId,
    status: "completed",
    summary: `Completed ${input.task.name}`,
    deliverables: [{ path: "out.md", kind: "file" }],
    evidence: [{ kind: "text", value: "out.md verified" }],
    internalRetries: [],
    userActionRequired: null,
    error: null,
  }), "utf-8");
  return {
    attemptId: input.attemptId,
    taskId: input.task.id,
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
    taskId: input.task.id,
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

test("executeSupervisedTasks writes success batch/task/attempt artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-"));
  await fs.writeFile(path.join(root, "out.md"), "Chapter output", "utf-8");
  const result = await executeSupervisedTasks({
    tasks: [{ name: "demo", prompt: "Do it", acceptance: { requiredPaths: ["out.md"], requiredOutputRegex: ["Verification"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, { runAttempt: successAttempt, now: () => "2026-04-26T00:00:02.000Z" });

  assert.equal(result.batch.status, "success");
  assert.equal(result.batch.summary.success, 1);
  assert.match(result.text, /Artifacts:/);

  const task = await readJsonFile(path.join(result.batch.batchDir, "tasks", "t001.json"));
  assert.equal(task.finalStatus, "success");
  assert.equal(task.workerReport.status, "completed");
  assert.equal(task.acceptance.status, "passed");
  assert.equal(task.attempts.length, 1);

  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "batch_finished"));
});

test("executeSupervisedTasks emits live updates while tasks run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-live-"));
  const updates = [];
  const result = await executeSupervisedTasks({
    tasks: [
      { name: "one", prompt: "Do one" },
      { name: "two", prompt: "Do two" },
    ],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    onUpdate: (snapshot) => updates.push(snapshot),
    runAttempt: async (input) => {
      assert.ok(updates.some((snapshot) => snapshot.text.includes(`${input.task.id} ${input.task.name}: RUNNING`)));
      await input.onActivity?.({ at: "2026-04-26T00:00:00.500Z", taskId: input.task.id, attemptId: input.attemptId, kind: "thinking", label: `Inspect ${input.task.name}` });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.ok(updates.length >= 4);
  assert.match(updates[0].text, /TASKS running: 0\/2 done, 0 running, 2 queued/);
  assert.ok(updates.some((snapshot) => snapshot.text.includes("Inspect: /tasks-ui")));
  assert.ok(updates.some((snapshot) => snapshot.text.includes("t001 one: RUNNING")));
  assert.ok(updates.some((snapshot) => snapshot.text.includes("│ Thinking ◫ Inspect one ·")));
  assert.ok(updates.some((snapshot) => snapshot.text.includes("t001 one: SUCCESS")));
  const task = await readJsonFile(path.join(result.batch.batchDir, "tasks", "t001.json"));
  assert.equal(task.activity[0].label, "Inspect one");
  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "task_activity" && event.data?.label === "Inspect one"));
});

test("executeSupervisedTasks emits heartbeat updates during quiet workers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-heartbeat-"));
  const updates = [];
  const result = await executeSupervisedTasks({
    tasks: [{ name: "quiet", prompt: "Be quiet" }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    onUpdate: (snapshot) => updates.push(snapshot),
    liveUpdateIntervalMs: 5,
    runAttempt: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.ok(updates.length >= 4);
  assert.ok(updates.some((snapshot) => snapshot.text.includes("Elapsed:")));
});

test("executeSupervisedTasks creates batch artifacts before cwd launch failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-invalid-cwd-"));
  const updates = [];
  const result = await executeSupervisedTasks({
    tasks: [{ name: "bad-cwd", prompt: "Run there", cwd: "missing-dir" }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    onUpdate: (snapshot) => updates.push(snapshot),
    runAttempt: async (input) => ({
      attemptId: input.attemptId,
      taskId: input.task.id,
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
  assert.match(updates[0].text, /TASKS running: 0\/1 done, 0 running, 1 queued/);
  assert.equal(await fs.stat(path.join(result.batch.batchDir, "batch.json")).then(() => true), true);
  assert.equal(result.tasks[0].failureKind, "launch_error");
});

test("executeSupervisedTasks fails write-boundary acceptance when neither git diff nor worker telemetry is available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-write-audit-"));
  const result = await executeSupervisedTasks({
    tasks: [{ name: "write", prompt: "Write only allowed files", acceptance: { allowedWritePaths: ["allowed/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, { runAttempt: successAttempt });

  assert.equal(result.batch.status, "error");
  assert.equal(result.tasks[0].failureKind, "acceptance_failed");
  assert.ok(result.tasks[0].acceptance.errors.some((error) => error.includes("requires write audit")));
});

test("executeSupervisedTasks accepts write-boundary tasks in non-git cwds when telemetry observed the writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-telemetry-audit-"));
  const result = await executeSupervisedTasks({
    tasks: [{ name: "write", prompt: "Write inside allowed zone", acceptance: { allowedWritePaths: ["allowed/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      const { appendWorkerEvent, buildWorkerEvent, workerEventsPathForAttempt } = await import("../../extensions/task/worker-events.ts");
      const eventsPath = workerEventsPathForAttempt(input.paths.attemptDir);
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await appendWorkerEvent(eventsPath, buildWorkerEvent({ type: "tool_call_started", taskId: input.task.id, attemptId: input.attemptId, tool: "edit", args: { path: "allowed/out.md" } }));
      await appendWorkerEvent(eventsPath, buildWorkerEvent({ type: "file_write_observed", taskId: input.task.id, attemptId: input.attemptId, tool: "edit", path: "allowed/out.md", args: { path: "allowed/out.md" } }));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.equal(result.tasks[0].acceptance.status, "passed");
});

test("executeSupervisedTasks accepts read-only write-boundary tasks when telemetry channel was alive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-telemetry-empty-"));
  const result = await executeSupervisedTasks({
    tasks: [{ name: "read-only", prompt: "Read but do not write", acceptance: { allowedWritePaths: ["allowed/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      const { appendWorkerEvent, buildWorkerEvent, workerEventsPathForAttempt } = await import("../../extensions/task/worker-events.ts");
      const eventsPath = workerEventsPathForAttempt(input.paths.attemptDir);
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      await appendWorkerEvent(eventsPath, buildWorkerEvent({ type: "tool_call_started", taskId: input.task.id, attemptId: input.attemptId, tool: "read", args: { path: "README.md" } }));
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.equal(result.tasks[0].acceptance.status, "passed");
});

test("executeSupervisedTasks preserves rerun provenance and emits unique event sequence numbers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-rerun-"));
  const result = await executeSupervisedTasks({
    parentBatchId: "parent-batch",
    rerunOfTaskIds: ["old-t001"],
    tasks: [
      { name: "one", prompt: "Do one" },
      { name: "two", prompt: "Do two" },
      { name: "three", prompt: "Do three" },
    ],
    concurrency: 3,
  }, { cwd: root, toolName: "tasks" }, { runAttempt: successAttempt });

  assert.equal(result.batch.parentBatchId, "parent-batch");
  assert.deepEqual(result.batch.rerunOfTaskIds, ["old-t001"]);
  const persisted = await readJsonFile(path.join(result.batch.batchDir, "batch.json"));
  assert.equal(persisted.parentBatchId, "parent-batch");
  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
});

test("executeSupervisedTasks marks queued tasks aborted without launching after root abort", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-abort-queued-"));
  const controller = new AbortController();
  let launchedAfterAbort = 0;
  const result = await executeSupervisedTasks({
    tasks: [{ name: "first", prompt: "first" }, { name: "queued", prompt: "queued" }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks", signal: controller.signal }, {
    runAttempt: async (input) => {
      if (input.task.name === "queued") launchedAfterAbort += 1;
      controller.abort();
      return {
        attemptId: input.attemptId,
        taskId: input.task.id,
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
  assert.equal(result.tasks[1].finalStatus, "aborted");
  assert.equal(result.tasks[1].attempts.length, 0);
});

test("executeSupervisedTasks applies throttle decisions before launching more queued tasks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-throttle-"));
  let active = 0;
  let firstFailureRecorded = false;
  let launchedTooEarly = false;

  const result = await executeSupervisedTasks({
    tasks: ["fail", "slow", "queued"].map((name) => ({ name, prompt: `Do ${name}` })),
    concurrency: 2,
    retry: { maxAttempts: 1 },
    throttle: { enabled: true, minConcurrency: 1, maxConcurrency: 2, transientFailureThreshold: 1, windowSize: 1 },
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      active += 1;
      if (input.task.name === "queued" && firstFailureRecorded && active > 1) launchedTooEarly = true;
      try {
        if (input.task.name === "fail") {
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

test("executeSupervisedTasks converts git status paths to task-cwd-relative write paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-git-cwd-"));
  const subdir = path.join(root, "extensions", "task");
  await fs.mkdir(subdir, { recursive: true });
  await fs.writeFile(path.join(subdir, "commands.ts"), "old", "utf-8");
  await execFileAsync("git", ["init"], { cwd: root });

  const result = await executeSupervisedTasks({
    tasks: [{ name: "write", prompt: "Write commands", cwd: "extensions/task", acceptance: { allowedWritePaths: ["commands.ts"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      await fs.writeFile(path.join(input.task.cwd, "commands.ts"), "new", "utf-8");
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "success");
  assert.equal(result.tasks[0].acceptance.status, "passed");
});

test("executeSupervisedTasks runs disjoint write-boundary tasks in parallel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-write-parallel-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const result = await executeSupervisedTasks({
    tasks: [
      { name: "one", prompt: "one", acceptance: { allowedWritePaths: ["chapters/ch01/**"] } },
      { name: "two", prompt: "two", acceptance: { allowedWritePaths: ["chapters/ch02/**"] } },
    ],
    concurrency: 2,
  }, { cwd: root, toolName: "tasks" }, { runAttempt: successAttempt });

  assert.equal(result.batch.effectiveConcurrency, 2);
  assert.equal(result.batch.status, "success");
});

test("executeSupervisedTasks attributes git changes only to the task whose allowed zone matches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-write-attribute-"));
  await fs.mkdir(path.join(root, "chapters", "ch01"), { recursive: true });
  await fs.mkdir(path.join(root, "chapters", "ch02"), { recursive: true });
  await execFileAsync("git", ["init"], { cwd: root });
  let order = 0;
  const order01 = { started: -1, finished: -1 };
  const order02 = { started: -1, finished: -1 };
  const result = await executeSupervisedTasks({
    tasks: [
      { name: "one", prompt: "one", acceptance: { allowedWritePaths: ["chapters/ch01/**"] } },
      { name: "two", prompt: "two", acceptance: { allowedWritePaths: ["chapters/ch02/**"] } },
    ],
    concurrency: 2,
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      const tracker = input.task.id === "t001" ? order01 : order02;
      tracker.started = order++;
      await fs.writeFile(path.join(root, "chapters", input.task.id === "t001" ? "ch01" : "ch02", "out.tex"), "x", "utf-8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settled = await successAttempt(input);
      tracker.finished = order++;
      return settled;
    },
  });


  assert.equal(result.batch.status, "success");
  assert.ok(order01.started <= order02.started, "t001 should start before/at the same time as t002");
  // Parallel: t001 should still be running when t002 starts.
  assert.ok(order02.started < order01.finished, "t002 must start before t001 finishes when they run in parallel");
  for (const task of result.tasks) {
    for (const error of task.acceptance.errors) {
      assert.doesNotMatch(error, /outside allowed write paths/, `${task.taskId} mis-attributed cross-task writes`);
    }
  }
});

test("executeSupervisedTasks detects forbidden writes across retry attempts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-retry-write-audit-"));
  await fs.mkdir(path.join(root, "secret"), { recursive: true });
  await execFileAsync("git", ["init"], { cwd: root });
  let attempts = 0;

  const result = await executeSupervisedTasks({
    tasks: [{ name: "retry", prompt: "Retry", acceptance: { forbiddenWritePaths: ["secret/**"] } }],
    retry: { maxAttempts: 2, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
  }, { cwd: root, toolName: "tasks" }, {
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
  assert.equal(result.tasks[0].failureKind, "acceptance_failed");
  assert.ok(result.tasks[0].acceptance.errors.some((error) => error.includes("secret/leak.txt")));
});

test("executeSupervisedTasks detects writes to files that were already dirty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-dirty-write-"));
  await fs.mkdir(path.join(root, "secret"), { recursive: true });
  await fs.writeFile(path.join(root, "secret", "token.txt"), "before", "utf-8");
  await execFileAsync("git", ["init"], { cwd: root });

  const result = await executeSupervisedTasks({
    tasks: [{ name: "dirty", prompt: "Do not write secret", acceptance: { forbiddenWritePaths: ["secret/**"] } }],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(path.join(root, "secret", "token.txt"), "after", "utf-8");
      return successAttempt(input);
    },
  });

  assert.equal(result.batch.status, "error");
  assert.equal(result.tasks[0].failureKind, "acceptance_failed");
  assert.ok(result.tasks[0].acceptance.errors.some((error) => error.includes("secret/token.txt")));
});

test("executeSupervisedTasks terminalizes every task when one attempt fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-fail-"));
  const result = await executeSupervisedTasks({
    tasks: [
      { name: "ok", prompt: "Do ok" },
      { name: "bad", prompt: "Do bad" },
    ],
    concurrency: 1,
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: (input) => input.task.name === "bad" ? failingAttempt(input) : successAttempt(input),
  });

  assert.equal(result.batch.status, "error");
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map((task) => task.finalStatus), ["success", "error"]);
  assert.equal(result.batch.summary.error, 1);
  assert.equal(result.tasks[1].failureKind, "provider_transient");
});
