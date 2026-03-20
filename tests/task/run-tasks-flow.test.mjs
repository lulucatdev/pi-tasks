import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAuditBatch, isDiscoverableBatch, readBatchJson, readJsonlTolerant, readTaskArtifact } from "../../extensions/task/audit-log.ts";
import { classifyBatchDir, readDiscoverableBatchRuns } from "../../extensions/task/task-ui.ts";
import { executeTasksRunFlow, PreLaunchTaskBatchFailure, resolveCompletedRunStatus, validateTaskParams } from "../../extensions/task/run-tasks.ts";
import { mergeTaskRunHistoryPreferAudit } from "../../extensions/task/task-history.ts";
import { buildQueuedTaskArtifact } from "../../extensions/task/types.ts";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAssistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function createAssistantMultipartMessage(parts) {
  return {
    role: "assistant",
    content: parts,
  };
}

function createAssistantToolCallMessage(toolCalls) {
  return {
    role: "assistant",
    content: toolCalls.map((toolCall) => ({ type: "toolCall", ...toolCall })),
    usage: { ...EMPTY_USAGE, totalTokens: 0 },
    model: "test-model",
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function createToolResultMessage(toolCallId, toolName, isError, text) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    isError,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

async function createRunnerHarness(taskInputs, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-tasks-flow-"));
  const generatedIds = [...(options.generatedIds ?? ["042731", "518204", "731551", "886420"])];
  const batchId = options.batchId ?? "2026-03-19T10-00-00Z-482731";
  const operations = [];
  const warnings = [];
  const recordToolCallFailureAttempts = new Set(options.failRecordToolCallAttempts ?? []);
  const failTryMarkRunningTaskIds = new Set(options.failTryMarkRunningTaskIds ?? []);
  let recordToolCallAttempt = 0;
  const recordToolCallFailureMessage = options.failRecordToolCallMessage ?? "synthetic recordToolCall failure";

  let activeRuns = [];
  let recentRuns = [];

  const createAuditBatchImpl = async (input) => {
    operations.push("createAuditBatch");
    const batch = await createAuditBatch({ ...input, batchId });

    return {
      ...batch,
      get batchRecord() {
        return batch.batchRecord;
      },
      async writeBatch(record) {
        operations.push(`writeBatch:${record.status}:${record.auditIntegrity}`);
        if (record.status === "initializing" && record.auditIntegrity === "failed" && options.failMarkFailureWrite) {
          throw new Error(options.failMarkFailureWrite);
        }
        return batch.writeBatch(record);
      },
      async writeTaskArtifact(task) {
        operations.push(`artifact:${task.id}:${task.status}`);
        return batch.writeTaskArtifact(task);
      },
      async appendEvent(event) {
        if (event.type === "task_queued") {
          operations.push(`event:task_queued:${event.taskId}`);
        } else if (event.type === "task_running") {
          operations.push(`event:task_running:${event.taskId}`);
        } else if (event.type === "task_finished") {
          operations.push(`event:task_finished:${event.taskId}:${event.status}`);
        } else if (event.type === "batch_finished") {
          operations.push(`event:batch_finished:${event.status}:${event.auditIntegrity}`);
        } else {
          operations.push(`event:${event.type}`);
        }
        return batch.appendEvent(event);
      },
      async markInitialized(taskIds) {
        operations.push(`markInitialized:${taskIds.join(",")}`);
        if (options.failMarkInitialized) {
          throw new Error(options.failMarkInitialized);
        }
        return batch.markInitialized(taskIds);
      },
      async tryMarkRunning(taskId, at) {
        operations.push(`artifact:${taskId}:running`);
        if (failTryMarkRunningTaskIds.has(taskId)) {
          operations.push(`artifact:${taskId}:running:failed`);
          return false;
        }
        const marked = await batch.tryMarkRunning(taskId, at);
        if (marked) {
          operations.push(`event:task_running:${taskId}`);
        }
        return marked;
      },
      async writeTerminalTask(taskId, task) {
        operations.push(`artifact:${taskId}:${task.status}`);
        return batch.writeTerminalTask(taskId, task);
      },
      async appendTaskFinished(taskId, at, status, error) {
        operations.push(`event:task_finished:${taskId}:${status}`);
        return batch.appendTaskFinished(taskId, at, status, error);
      },
      async writeFinalBatch(record) {
        operations.push(`writeBatch:${record.status}:${record.auditIntegrity}`);
        return batch.writeFinalBatch(record);
      },
      async appendBatchFinished(at, status, auditIntegrity) {
        operations.push(`event:batch_finished:${status}:${auditIntegrity}`);
        if (options.failAppendBatchFinished) {
          throw new Error(options.failAppendBatchFinished);
        }
        return batch.appendBatchFinished(at, status, auditIntegrity);
      },
      async recordToolCall(taskId, input) {
        operations.push(`toolCall:${taskId}:${input.tool}:${input.status}`);
        recordToolCallAttempt += 1;
        if (recordToolCallFailureAttempts.has(recordToolCallAttempt)) {
          throw new Error(recordToolCallFailureMessage);
        }
        return batch.recordToolCall(taskId, input);
      },
      async logWarning(message) {
        warnings.push(message);
        operations.push(`warning:${message}`);
        return batch.logWarning(message);
      },
    };
  };

  const deps = {
    processIsChild: false,
    maxTasks: 100,
    maxConcurrency: options.maxConcurrency ?? 20,
    getThinkingLevel: () => undefined,
    getActiveRuns: () => activeRuns,
    getRecentRuns: () => recentRuns,
    startRun(run) {
      activeRuns = [run, ...activeRuns.filter((entry) => entry.id !== run.id)];
    },
    patchRun(runId, patch) {
      activeRuns = activeRuns.map((entry) => (entry.id === runId ? { ...entry, ...patch } : entry));
    },
    finishRun(runId, details, _ctx, options = {}) {
      const current = activeRuns.find((entry) => entry.id === runId);
      if (!current) return;
      const record = {
        ...current,
        details,
        status: resolveCompletedRunStatus(details.summary),
        finishedAt: Date.now(),
        auditClassification: options.auditClassification ?? "complete",
      };
      recentRuns = [record, ...recentRuns.filter((entry) => entry.id !== runId)];
      activeRuns = activeRuns.filter((entry) => entry.id !== runId);
    },
    failRun(runId, detail) {
      const current = activeRuns.find((entry) => entry.id === runId);
      if (!current) return;
      const record = { ...current, status: "error", detail, finishedAt: Date.now() };
      activeRuns = activeRuns.filter((entry) => entry.id !== runId);
      recentRuns = [record, ...recentRuns.filter((entry) => entry.id !== runId)];
    },
    generateTaskId(existingIds) {
      const nextId = generatedIds.shift();
      if (!nextId) throw new Error("No generated task ids left in the test harness.");
      operations.push(`id:${nextId}`);
      existingIds.add(nextId);
      return nextId;
    },
    async beforeTaskLaunch(task, index) {
      if (options.beforeTaskLaunchImpl) {
        return options.beforeTaskLaunchImpl(task, index);
      }
    },
    runSingleTask: async (...args) => {
      const [task, _signal, onUpdate] = args;
      if (options.runSingleTaskImpl) {
        return options.runSingleTaskImpl(...args);
      }

      const running = {
        ...task,
        status: "running",
        messages: [],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
      onUpdate?.(running);
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage(`done ${task.task}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
    activeTaskControllers: new Map(),
    pendingAbortTaskIds: new Set(),
    createAuditBatch: createAuditBatchImpl,
    async cleanupAuditBatch(audit) {
      operations.push("cleanupAuditBatch");
      if (options.failCleanup) {
        throw new Error(options.failCleanup);
      }
      await fs.rm(audit.batchDir, { recursive: true, force: true });
    },
  };

  const ctx = { cwd: root, model: undefined };

  async function findBatchDir() {
    const auditRoot = path.join(root, ".pi", "tasks");
    try {
      const entries = await fs.readdir(auditRoot, { withFileTypes: true });
      const batchDir = entries.find((entry) => entry.isDirectory());
      return batchDir ? path.join(auditRoot, batchDir.name) : null;
    } catch {
      return null;
    }
  }

  return {
    root,
    operations,
    warnings,
    async run(arg = options.invokingToolName ?? "tasks", signal = undefined) {
      const invokingToolName = typeof arg === "string" ? arg : arg?.invokingToolName ?? options.invokingToolName ?? "tasks";
      const resolvedSignal = typeof arg === "string" ? signal : arg?.signal;
      return executeTasksRunFlow({ tasks: taskInputs }, resolvedSignal, undefined, ctx, deps, invokingToolName);
    },
    getRecentRun() {
      return recentRuns[0] ?? null;
    },
    async readBatchDir() {
      return findBatchDir();
    },
    async readBatchJsonIfPresent() {
      const batchDir = await findBatchDir();
      return batchDir ? readBatchJson(batchDir) : null;
    },
    async readEvents() {
      const batchDir = await findBatchDir();
      if (!batchDir) return [];
      return readJsonlTolerant(path.join(batchDir, "events.jsonl"));
    },
    async readTask(taskId) {
      const batchDir = await findBatchDir();
      return batchDir ? readTaskArtifact(batchDir, taskId) : null;
    },
    async classifyBatch() {
      const batchDir = await findBatchDir();
      return batchDir ? classifyBatchDir(batchDir) : { visible: false, classification: "pre-init" };
    },
    async isDiscoverableBatch() {
      const batchDir = await findBatchDir();
      return batchDir ? isDiscoverableBatch(batchDir) : false;
    },
    async hasBatchDir() {
      return (await findBatchDir()) !== null;
    },
    async listTaskArtifacts() {
      const batchDir = await findBatchDir();
      if (!batchDir) return [];
      return fs.readdir(path.join(batchDir, "tasks"));
    },
  };
}

async function runSyntheticFailureHarness(mode) {
  if (mode === "fatal-audit-before-launch") {
    const harness = await createRunnerHarness([{ task: "first" }], {
      async beforeTaskLaunchImpl() {
        throw new PreLaunchTaskBatchFailure("Audit persistence failed before launch.", {
          syntheticStatus: "aborted",
          auditDegraded: true,
        });
      },
    });
    return { harness, result: await harness.run() };
  }

  if (mode === "setup-before-launch-error") {
    const harness = await createRunnerHarness([{ task: "first" }], {
      async beforeTaskLaunchImpl() {
        throw new PreLaunchTaskBatchFailure("Worker setup failed before launch.", {
          syntheticStatus: "error",
        });
      },
    });
    return { harness, result: await harness.run() };
  }

  if (mode === "abort-after-launch") {
    const controller = new AbortController();
    const harness = await createRunnerHarness([{ task: "first" }], {
      async runSingleTaskImpl(task, _signal, onUpdate) {
        onUpdate?.({
          ...task,
          status: "running",
          messages: [createAssistantMessage("partial visible output")],
          stderr: "",
          usage: { ...EMPTY_USAGE },
        });
        controller.abort();
        const error = new Error("Task was aborted.");
        error.name = "AbortError";
        throw error;
      },
    });
    return { harness, result: await harness.run({ signal: controller.signal }) };
  }

  throw new Error(`Unknown synthetic failure mode: ${mode}`);
}

test("validation rejects empty arrays and blank prompts before batch creation", async () => {
  assert.throws(() => validateTaskParams({ tasks: [] }, 100), /At least one task is required/);
  assert.throws(() => validateTaskParams({ tasks: [{ task: "   " }] }, 100), /non-empty task prompt/);

  const harness = await createRunnerHarness([{ task: "   " }]);
  const result = await harness.run();

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /non-empty task prompt/);
  await assert.rejects(fs.access(path.join(harness.root, ".pi", "tasks")));
});

test("batch initialization writes batch_started before ids, artifacts, and queued events", async () => {
  const harness = await createRunnerHarness([
    { name: "one", task: "first" },
    { name: "two", task: "second" },
  ]);

  const result = await harness.run();
  const batch = await harness.readBatchJsonIfPresent();
  const queuedEvents = (await harness.readEvents()).filter((event) => event.type === "task_queued");

  assert.equal(result.isError, false);
  assert.deepEqual(batch.taskIds, ["042731", "518204"]);
  assert.deepEqual(batch.taskIds, queuedEvents.map((event) => event.taskId));
  assert.deepEqual(result.details.results.map((entry) => entry.id), ["042731", "518204"]);
  assert.deepEqual(harness.operations.slice(0, 9), [
    "createAuditBatch",
    "event:batch_started",
    "id:042731",
    "id:518204",
    "artifact:042731:queued",
    "artifact:518204:queued",
    "event:task_queued:042731",
    "event:task_queued:518204",
    "markInitialized:042731,518204",
  ]);
});

test("single-item tasks batches retain the tasks tool name", async () => {
  const harness = await createRunnerHarness([{ task: "first" }]);

  const result = await harness.run("tasks");
  const batch = await harness.readBatchJsonIfPresent();
  const events = await harness.readEvents();

  assert.equal(result.isError, false);
  assert.equal(batch?.toolName, "tasks");
  assert.equal(events[0]?.type, "batch_started");
  assert.equal(events[0]?.toolName, "tasks");
});

test("running markers settle before terminal task_finished events and preserve cwd overrides", async () => {
  const harness = await createRunnerHarness([
    {
      task: "first",
      cwd: path.join(os.tmpdir(), "task-cwd-override"),
    },
  ]);

  const result = await harness.run();
  const events = await harness.readEvents();
  const task = await harness.readTask("042731");

  assert.equal(result.isError, false);
  assert.equal(task?.cwd, path.join(os.tmpdir(), "task-cwd-override"));
  assert.equal(task?.status, "success");
  assert.deepEqual(task?.timeline.map((entry) => entry.state), ["queued", "running", "success"]);
  assert.equal(
    harness.operations.indexOf("artifact:042731:running") < harness.operations.indexOf("event:task_running:042731"),
    true,
  );
  assert.equal(
    harness.operations.indexOf("artifact:042731:success") < harness.operations.indexOf("event:task_finished:042731:success"),
    true,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["batch_started", "task_queued", "task_running", "task_finished", "batch_finished"],
  );
});

test("successful runs finalize batch.json before batch_finished and keep summary, status, auditIntegrity, and restore correlation in sync", async () => {
  const harness = await createRunnerHarness([{ task: "first" }]);

  const result = await harness.run();
  const batch = await harness.readBatchJsonIfPresent();
  const events = await harness.readEvents();
  const lastEvent = events.at(-1);
  const completedRun = harness.getRecentRun();

  assert.equal(result.isError, false);
  assert.equal(
    harness.operations.indexOf("writeBatch:success:ok") < harness.operations.indexOf("event:batch_finished:success:ok"),
    true,
  );
  assert.deepEqual(batch?.summary, { total: 1, success: 1, error: 0, aborted: 0 });
  assert.equal(batch?.status, "success");
  assert.equal(batch?.auditIntegrity, "ok");
  assert.equal(completedRun?.batchId, batch?.batchId);
  assert.equal(completedRun?.startedAt, Date.parse(batch?.startedAt ?? ""));
  assert.deepEqual(result.details.summary, { total: 1, queued: 0, running: 0, success: 1, error: 0, aborted: 0 });
  assert.deepEqual(lastEvent, {
    schemaVersion: 1,
    type: "batch_finished",
    batchId: "2026-03-19T10-00-00Z-482731",
    seq: 5,
    at: batch?.finishedAt,
    status: batch?.status,
    auditIntegrity: batch?.auditIntegrity,
  });
});

test("mixed success and aborted runs finalize as aborted and keep batch.json aligned with batch_finished", async () => {
  const harness = await createRunnerHarness([
    { task: "first" },
    { task: "second" },
  ], {
    async runSingleTaskImpl(task, _signal, onUpdate) {
      onUpdate?.({
        ...task,
        status: "running",
        messages: [],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });

      if (task.id === "042731") {
        return {
          ...task,
          status: "success",
          messages: [createAssistantMessage("done first")],
          stderr: "",
          usage: { ...EMPTY_USAGE },
        };
      }

      return {
        ...task,
        status: "aborted",
        messages: [],
        stderr: "",
        usage: { ...EMPTY_USAGE },
        errorMessage: "Task was aborted.",
      };
    },
  });

  const result = await harness.run();
  const batch = await harness.readBatchJsonIfPresent();
  const events = await harness.readEvents();
  const lastEvent = events.at(-1);
  const completedRun = harness.getRecentRun();
  const discoverableRuns = await readDiscoverableBatchRuns(harness.root);

  assert.equal(result.isError, true);
  assert.equal(
    harness.operations.indexOf("writeBatch:aborted:ok") < harness.operations.indexOf("event:batch_finished:aborted:ok"),
    true,
  );
  assert.deepEqual(result.details.summary, { total: 2, queued: 0, running: 0, success: 1, error: 0, aborted: 1 });
  assert.equal(completedRun?.status, "aborted");
  assert.equal(discoverableRuns[0]?.status, "aborted");
  assert.deepEqual(batch?.summary, { total: 2, success: 1, error: 0, aborted: 1 });
  assert.equal(batch?.status, "aborted");
  assert.equal(batch?.auditIntegrity, "ok");
  assert.deepEqual(lastEvent, {
    schemaVersion: 1,
    type: "batch_finished",
    batchId: "2026-03-19T10-00-00Z-482731",
    seq: 8,
    at: batch?.finishedAt,
    status: batch?.status,
    auditIntegrity: batch?.auditIntegrity,
  });
});

test("restored history prefers equivalent audit artifacts over stale session snapshots even with timestamp skew", () => {
  const merged = mergeTaskRunHistoryPreferAudit(
    [
      {
        id: "session:stale",
        batchId: "2026-03-19T10-00-00Z-482731",
        startedAt: 1003,
        finishedAt: 2003,
        status: "error",
        tasks: [{ id: "042731" }, { id: "518204" }],
        details: {
          results: [
            { id: "042731", output: "stale first chunk" },
            { id: "518204", output: "stale second chunk" },
          ],
        },
      },
    ],
    [
      {
        id: "audit:2026-03-19T10-00-00Z-482731",
        batchId: "2026-03-19T10-00-00Z-482731",
        startedAt: 1000,
        finishedAt: 2100,
        status: "aborted",
        tasks: [{ id: "042731" }, { id: "518204" }],
        details: {
          results: [
            { id: "042731", output: "first line\nsecond line" },
            { id: "518204", output: "audit output wins" },
          ],
        },
      },
    ],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "audit:2026-03-19T10-00-00Z-482731");
  assert.equal(merged[0].status, "aborted");
  assert.equal(merged[0].details.results[0].output, "first line\nsecond line");
  assert.equal(merged[0].details.results[1].output, "audit output wins");
});

test("restored history keeps runnable params when audit data replaces stale session data", () => {
  const merged = mergeTaskRunHistoryPreferAudit(
    [
      {
        id: "session:stale",
        batchId: "2026-03-19T10-00-00Z-482731",
        startedAt: 1003,
        finishedAt: 2003,
        status: "error",
        tasks: [{ id: "042731" }, { id: "518204" }],
        params: {
          tasks: [
            { name: "first", task: "inspect src/index.ts", cwd: "/tmp/project" },
            { name: "second", task: "inspect src/task.ts", cwd: "/tmp/project" },
          ],
        },
      },
    ],
    [
      {
        id: "audit:2026-03-19T10-00-00Z-482731",
        batchId: "2026-03-19T10-00-00Z-482731",
        startedAt: 1000,
        finishedAt: 2100,
        status: "success",
        tasks: [{ id: "042731" }, { id: "518204" }],
        details: {
          results: [
            { id: "042731", output: "audit first" },
            { id: "518204", output: "audit second" },
          ],
        },
      },
    ],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "audit:2026-03-19T10-00-00Z-482731");
  assert.equal(merged[0].status, "success");
  assert.deepEqual(merged[0].params, {
    tasks: [
      { name: "first", task: "inspect src/index.ts", cwd: "/tmp/project" },
      { name: "second", task: "inspect src/task.ts", cwd: "/tmp/project" },
    ],
  });
});

test("audit-only restored history reconstructs runnable params from stored task specs", () => {
  const merged = mergeTaskRunHistoryPreferAudit(
    [],
    [
      {
        id: "audit:2026-03-19T10-00-00Z-482731",
        batchId: "2026-03-19T10-00-00Z-482731",
        startedAt: 1000,
        finishedAt: 2100,
        status: "success",
        tasks: [
          { id: "042731", name: "first", task: "inspect src/index.ts", cwd: "/tmp/project" },
          { id: "518204", task: "inspect src/task.ts", cwd: "/tmp/project/subdir" },
        ],
      },
    ],
  );

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].params, {
    tasks: [
      { name: "first", task: "inspect src/index.ts", cwd: "/tmp/project" },
      { task: "inspect src/task.ts", cwd: "/tmp/project/subdir" },
    ],
  });
});

test("relative cwd overrides resolve against the root cwd before artifact writes and worker launch", async () => {
  let launchedCwd;
  const harness = await createRunnerHarness([
    {
      task: "first",
      cwd: "nested/task-dir",
    },
  ], {
    async runSingleTaskImpl(task, _signal, onUpdate) {
      launchedCwd = task.cwd;
      onUpdate?.({
        ...task,
        status: "running",
        messages: [],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage("done first")],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const result = await harness.run();
  const task = await harness.readTask("042731");
  const expectedCwd = path.join(harness.root, "nested", "task-dir");

  assert.equal(result.isError, false);
  assert.equal(launchedCwd, expectedCwd);
  assert.equal(task?.cwd, expectedCwd);
});

test("post-init pre-launch audit failure returns normal result shape from synthetic task states", async () => {
  const { result } = await runSyntheticFailureHarness("fatal-audit-before-launch");

  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, "aborted");
  assert.match(result.details.results[0].errorMessage, /Audit persistence failed before launch/i);
});

test("setup failure before launch maps queued tasks to error with non-empty error text", async () => {
  const { result } = await runSyntheticFailureHarness("setup-before-launch-error");

  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, "error");
  assert.match(result.details.results[0].errorMessage, /failed/i);
});

test("concurrent task starts stop launching later workers after a pre-launch failure", async () => {
  let launchCount = 0;
  const harness = await createRunnerHarness([
    { task: "first" },
    { task: "second" },
  ], {
    maxConcurrency: 2,
    async beforeTaskLaunchImpl(task) {
      if (task.id === "042731") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new PreLaunchTaskBatchFailure("Worker setup failed before launch.", {
          syntheticStatus: "error",
        });
      }
    },
    async runSingleTaskImpl(task, _signal, onUpdate) {
      launchCount += 1;
      onUpdate?.({
        ...task,
        status: "running",
        messages: [createAssistantMessage(`running ${task.id}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage(`done ${task.id}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const result = await harness.run();

  assert.equal(result.isError, true);
  assert.equal(launchCount, 0);
  assert.deepEqual(result.details.results.map((entry) => entry.status), ["error", "error"]);
  assert.match(result.details.results[1].errorMessage ?? "", /before launch/i);
});

test("silent worker launch ack persists task_running before output or finish", async () => {
  const releaseWorker = createDeferred();
  const launchObserved = createDeferred();
  const harness = await createRunnerHarness([{ task: "first" }], {
    async runSingleTaskImpl(task, _signal, _onUpdate, _fallbackModel, _fallbackThinking, onLaunch) {
      onLaunch?.();
      launchObserved.resolve();
      await releaseWorker.promise;
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage(`done ${task.id}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const runPromise = harness.run();
  await launchObserved.promise;

  let runningTask = null;
  let runningEvents = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    runningTask = await harness.readTask("042731");
    runningEvents = await harness.readEvents();
    if (runningTask?.status === "running" && runningEvents.some((event) => event.type === "task_running")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  releaseWorker.resolve();
  const result = await runPromise;

  assert.equal(result.isError, false);
  assert.equal(runningTask?.status, "running");
  assert.deepEqual(runningTask?.timeline.map((entry) => entry.state), ["queued", "running"]);
  assert.deepEqual(runningEvents.map((event) => event.type), ["batch_started", "task_queued", "task_running"]);
  assert.equal(runningEvents.at(-1)?.taskId, "042731");
});

test("silent worker launch ack blocks later launches when running persistence fails", async () => {
  const releaseFirstWorker = createDeferred();
  const firstLaunchObserved = createDeferred();
  const launchOrder = [];
  const harness = await createRunnerHarness([
    { task: "first" },
    { task: "second" },
  ], {
    maxConcurrency: 2,
    failTryMarkRunningTaskIds: ["042731"],
    async runSingleTaskImpl(task, _signal, _onUpdate, _fallbackModel, _fallbackThinking, onLaunch) {
      launchOrder.push(task.id);
      onLaunch?.();
      if (task.id === "042731") {
        firstLaunchObserved.resolve();
        await releaseFirstWorker.promise;
      }
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage(`done ${task.id}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const runPromise = harness.run();
  await firstLaunchObserved.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseFirstWorker.resolve();
  const result = await runPromise;

  assert.equal(result.isError, true);
  assert.deepEqual(launchOrder, ["042731"]);
  assert.deepEqual(result.details.results.map((entry) => entry.status), ["success", "aborted"]);
  assert.match(result.details.results[1].errorMessage ?? "", /audit degraded/i);
});

test("launch ack lets silent workers overlap while a later pre-launch spawn failure still blocks queued launches", async () => {
  const launchOrder = [];
  const launchTimes = new Map();
  const finishTimes = new Map();
  const harness = await createRunnerHarness([
    { task: "first" },
    { task: "second" },
    { task: "third" },
  ], {
    maxConcurrency: 3,
    async runSingleTaskImpl(task, _signal, _onUpdate, _fallbackModel, _fallbackThinking, onLaunch) {
      launchOrder.push(task.id);
      launchTimes.set(task.id, Date.now());

      if (task.id === "042731") {
        onLaunch?.();
        await new Promise((resolve) => setTimeout(resolve, 60));
        finishTimes.set(task.id, Date.now());
        return {
          ...task,
          status: "success",
          messages: [createAssistantMessage(`done ${task.id}`)],
          stderr: "",
          usage: { ...EMPTY_USAGE },
        };
      }

      if (task.id === "518204") {
        throw new Error("synthetic launch failure");
      }

      finishTimes.set(task.id, Date.now());
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage(`done ${task.id}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const result = await harness.run();

  assert.equal(result.isError, true);
  assert.deepEqual(launchOrder, ["042731", "518204"]);
  assert.equal(launchTimes.get("518204") < finishTimes.get("042731"), true);
  assert.deepEqual(result.details.results.map((entry) => entry.status), ["success", "error", "error"]);
  assert.match(result.details.results[2].errorMessage ?? "", /synthetic launch failure/);
});

test("user abort after launch preserves latest observed finalOutput snapshot", async () => {
  const { harness, result } = await runSyntheticFailureHarness("abort-after-launch");
  const task = await harness.readTask("042731");

  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, "aborted");
  assert.equal(task?.finalOutput, "partial visible output");
});

test("post-launch audit degradation settles in-flight work, leaves later work unlaunched, logs a warning, and classifies the batch incomplete", async () => {
  let launchCount = 0;
  const harness = await createRunnerHarness([
    { task: "first" },
    { task: "second" },
  ], {
    maxConcurrency: 1,
    failTryMarkRunningTaskIds: ["042731"],
    async runSingleTaskImpl(task, _signal, onUpdate) {
      launchCount += 1;
      onUpdate?.({
        ...task,
        status: "running",
        messages: [createAssistantMessage(`running ${task.id}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage(`done ${task.id}`)],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const result = await harness.run();
  const batch = await harness.readBatchJsonIfPresent();
  const events = await harness.readEvents();
  const classification = await harness.classifyBatch();

  assert.equal(result.isError, true);
  assert.equal(launchCount, 1);
  assert.deepEqual(result.details.results.map((entry) => entry.status), ["success", "aborted"]);
  assert.match(result.details.results[1].errorMessage, /audit degraded/i);
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /Audit degraded; leaving batch incomplete/);
  assert.equal(batch?.auditIntegrity, "failed");
  assert.equal(events.some((event) => event.type === "batch_finished"), false);
  assert.deepEqual(classification, { visible: true, classification: "incomplete" });
  assert.equal(harness.getRecentRun()?.auditClassification, "incomplete");
});

test("spawn failures before launch settle a synthetic terminal error instead of rejecting the batch", async () => {
  const harness = await createRunnerHarness([{ task: "first" }], {
    async runSingleTaskImpl() {
      throw new Error("synthetic launch failure");
    },
  });

  const result = await harness.run();
  const batch = await harness.readBatchJsonIfPresent();
  const events = await harness.readEvents();
  const task = await harness.readTask("042731");

  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, "error");
  assert.match(result.details.results[0].errorMessage ?? "", /synthetic launch failure/);
  assert.equal(harness.operations.includes("artifact:042731:running"), false);
  assert.equal(harness.operations.includes("event:task_running:042731"), false);
  assert.equal(task?.status, "error");
  assert.equal(task?.error, "synthetic launch failure");
  assert.deepEqual(task?.timeline.map((entry) => entry.state), ["queued", "error"]);
  assert.equal(batch?.status, "error");
  assert.equal(batch?.auditIntegrity, "ok");
  assert.deepEqual(events.map((event) => event.type), ["batch_started", "task_queued", "task_finished", "batch_finished"]);
});

test("observable worker tool calls stream into task artifacts once observed and dedupe repeated snapshots", async () => {
  let harness;
  let observedTaskBeforeSettlement;
  harness = await createRunnerHarness([{ task: "inspect tool usage" }], {
    async runSingleTaskImpl(task, _signal, onUpdate) {
      const assistantToolCalls = createAssistantToolCallMessage([
        {
          id: "call-read",
          name: "read",
          arguments: { path: "src/index.ts", token: "secret-token" },
        },
        {
          id: "call-bash",
          name: "bash",
          arguments: { command: "echo hi", password: "secret-password" },
        },
        {
          id: "call-hidden",
          name: "edit",
          arguments: { path: "src/index.ts", oldText: "a", newText: "b" },
        },
      ]);

      onUpdate?.({
        ...task,
        status: "running",
        messages: [assistantToolCalls],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });

      const toolResults = [
        createToolResultMessage("call-read", "read", false, "ok"),
        createToolResultMessage("call-bash", "bash", true, "boom"),
        createToolResultMessage("call-unmatched", "write", false, "ignore me"),
      ];

      onUpdate?.({
        ...task,
        status: "running",
        messages: [assistantToolCalls, ...toolResults],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });

      onUpdate?.({
        ...task,
        status: "running",
        messages: [assistantToolCalls, ...toolResults],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });

      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (harness.operations.filter((entry) => entry.startsWith(`toolCall:${task.id}:`)).length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      observedTaskBeforeSettlement = await harness.readTask(task.id);

      return {
        ...task,
        status: "success",
        messages: [assistantToolCalls, ...toolResults, createAssistantMessage("done inspect tool usage")],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const result = await harness.run();
  const task = await harness.readTask("042731");

  assert.equal(result.isError, false);
  assert.deepEqual(observedTaskBeforeSettlement?.toolCalls, [
    {
      at: observedTaskBeforeSettlement.toolCalls[0].at,
      tool: "read",
      argsPreview: '{"path":"src/index.ts","token":"[REDACTED]"}',
      status: "completed",
      error: null,
    },
  ]);
  assert.deepEqual(task?.toolCalls, [
    {
      at: task.toolCalls[0].at,
      tool: "read",
      argsPreview: '{"path":"src/index.ts","token":"[REDACTED]"}',
      status: "completed",
      error: null,
    },
    {
      at: task.toolCalls[1].at,
      tool: "bash",
      argsPreview: '{"command":"echo hi","password":"[REDACTED]"}',
      status: "failed",
      error: "boom",
    },
  ]);
  assert.equal(task?.toolCalls.length, 2);
  assert.equal(observedTaskBeforeSettlement.toolCalls[0].at < task.finishedAt, true);
});

test("terminal settle retries only the missing tool trace after partial incremental persistence", async () => {
  let harness;
  let taskBeforeSettlement;
  harness = await createRunnerHarness([{ task: "retry tool trace" }], {
    failRecordToolCallAttempts: [2],
    async runSingleTaskImpl(task, _signal, onUpdate) {
      const assistantToolCalls = createAssistantToolCallMessage([
        {
          id: "call-read",
          name: "read",
          arguments: { path: "src/index.ts", token: "secret-token" },
        },
        {
          id: "call-bash",
          name: "bash",
          arguments: { command: "echo hi", password: "secret-password" },
        },
      ]);
      const toolResults = [
        createToolResultMessage("call-read", "read", false, "ok"),
        createToolResultMessage("call-bash", "bash", true, "boom"),
      ];

      onUpdate?.({
        ...task,
        status: "running",
        messages: [assistantToolCalls, ...toolResults],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });

      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (harness.operations.filter((entry) => entry.startsWith(`toolCall:${task.id}:`)).length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      taskBeforeSettlement = await harness.readTask(task.id);

      return {
        ...task,
        status: "success",
        messages: [assistantToolCalls, ...toolResults, createAssistantMessage("done retry tool trace")],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const result = await harness.run();
  const task = await harness.readTask("042731");

  assert.equal(result.isError, false);
  assert.deepEqual(taskBeforeSettlement?.toolCalls, [
    {
      at: taskBeforeSettlement.toolCalls[0].at,
      tool: "read",
      argsPreview: '{"path":"src/index.ts","token":"[REDACTED]"}',
      status: "completed",
      error: null,
    },
  ]);
  assert.equal(harness.operations.filter((entry) => entry === "toolCall:042731:read:completed").length, 1);
  assert.equal(harness.operations.filter((entry) => entry === "toolCall:042731:bash:failed").length, 2);
  assert.deepEqual(task?.toolCalls, [
    {
      at: task.toolCalls[0].at,
      tool: "read",
      argsPreview: '{"path":"src/index.ts","token":"[REDACTED]"}',
      status: "completed",
      error: null,
    },
    {
      at: task.toolCalls[1].at,
      tool: "bash",
      argsPreview: '{"command":"echo hi","password":"[REDACTED]"}',
      status: "failed",
      error: "boom",
    },
  ]);
});

test("terminal output preserves every visible text segment from the final assistant message", async () => {
  const harness = await createRunnerHarness([{ task: "collect final output" }], {
    async runSingleTaskImpl(task, _signal, onUpdate) {
      onUpdate?.({
        ...task,
        status: "running",
        messages: [createAssistantMessage("launching")],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });

      return {
        ...task,
        status: "success",
        messages: [
          createAssistantMessage("ignored earlier"),
          createAssistantMultipartMessage([
            { type: "text", text: "first line" },
            { type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/index.ts" } },
            { type: "text", text: "\nsecond line" },
            { type: "text", text: "\n\nthird line" },
          ]),
        ],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  const result = await harness.run();
  const task = await harness.readTask("042731");
  const expectedOutput = "first line\nsecond line\n\nthird line";

  assert.equal(result.isError, false);
  assert.equal(task?.finalOutput, expectedOutput);
  assert.match(result.content[0].text, /first line\nsecond line\n\nthird line/);
  assert.deepEqual(task?.timeline.map((entry) => entry.state), ["queued", "running", "success"]);
});

test("failure after batch skeleton creation cleans up partial artifacts before returning explicit error", async () => {
  const harness = await createRunnerHarness([{ task: "first" }], { failMarkInitialized: "synthetic initialization failure" });

  const result = await harness.run();

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Task batch initialization failed: synthetic initialization failure/);
  assert.deepEqual(harness.operations.slice(-2), ["markInitialized:042731", "cleanupAuditBatch"]);
  assert.equal(await harness.hasBatchDir(), false);
  assert.equal(await harness.readBatchJsonIfPresent(), null);
  assert.deepEqual(await harness.readEvents(), []);
  assert.deepEqual(await harness.listTaskArtifacts(), []);
});

test("cleanup failure leaves hidden failed pre-init leftovers", async () => {
  const harness = await createRunnerHarness([{ task: "first" }], {
    failMarkInitialized: "synthetic initialization failure",
    failCleanup: "synthetic cleanup failure",
  });

  const result = await harness.run();
  const batch = await harness.readBatchJsonIfPresent();
  const events = await harness.readEvents();

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Task batch initialization failed: synthetic initialization failure/);
  assert.deepEqual(harness.operations.slice(-3), [
    "markInitialized:042731",
    "cleanupAuditBatch",
    "writeBatch:initializing:failed",
  ]);
  assert.equal(await harness.isDiscoverableBatch(), false);
  assert.equal(batch?.status, "initializing");
  assert.equal(batch?.initialized, false);
  assert.equal(batch?.auditIntegrity, "failed");
  assert.deepEqual(events.map((event) => event.type), ["batch_started", "task_queued"]);
  assert.deepEqual(await harness.listTaskArtifacts(), ["042731.json"]);
});

test("cleanup rewrite failures still persist a failed pre-init batch state", async () => {
  const harness = await createRunnerHarness([{ task: "first" }], {
    failMarkInitialized: "synthetic initialization failure",
    failCleanup: "synthetic cleanup failure",
    failMarkFailureWrite: "synthetic rewrite failure",
  });

  const result = await harness.run();

  const batch = await harness.readBatchJsonIfPresent();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Task batch initialization failed: synthetic initialization failure/);
  assert.match(result.content[0].text, /synthetic rewrite failure/);
  assert.deepEqual(harness.operations.slice(-3), [
    "markInitialized:042731",
    "cleanupAuditBatch",
    "writeBatch:initializing:failed",
  ]);
  assert.equal(batch?.status, "initializing");
  assert.equal(batch?.initialized, false);
  assert.equal(batch?.auditIntegrity, "failed");
});


test("discoverable on-disk incomplete batches load into tasks-ui state while pre-init leftovers stay hidden", async () => {
  const harness = await createRunnerHarness([{ task: "first" }], {
    failTryMarkRunningTaskIds: ["042731"],
    async runSingleTaskImpl(task, _signal, onUpdate) {
      onUpdate?.({
        ...task,
        status: "running",
        messages: [createAssistantMessage("partial output")],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      });
      return {
        ...task,
        status: "success",
        messages: [createAssistantMessage("done first")],
        stderr: "",
        usage: { ...EMPTY_USAGE },
      };
    },
  });

  await harness.run();

  const hiddenBatch = await createAuditBatch({
    rootCwd: harness.root,
    toolName: "tasks",
    startedAt: "2026-03-19T11:00:00.000Z",
    batchId: "2026-03-19T11-00-00Z-999999",
    taskIds: ["999999"],
  });
  await hiddenBatch.writeTaskArtifact(buildQueuedTaskArtifact({
    batchId: hiddenBatch.batchId,
    id: "999999",
    task: "hidden leftover",
    cwd: harness.root,
    queuedAt: "2026-03-19T11:00:00.000Z",
  }));
  await hiddenBatch.appendEvent({ type: "batch_started", at: "2026-03-19T11:00:00.000Z", toolName: "tasks", rootCwd: harness.root });
  await hiddenBatch.appendEvent({ type: "task_queued", at: "2026-03-19T11:00:00.000Z", taskId: "999999" });
  await hiddenBatch.writeBatch({
    ...hiddenBatch.batchRecord,
    status: "initializing",
    initialized: false,
    auditIntegrity: "failed",
  });

  const runs = await readDiscoverableBatchRuns(harness.root);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].auditClassification, "incomplete");
  assert.equal(runs[0].tasks[0].id, "042731");
  assert.equal(runs[0].details?.results[0].status, "success");
  assert.match(runs[0].detail, /audit incomplete/);
});
