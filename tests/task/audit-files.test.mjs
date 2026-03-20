import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAuditBatch,
  isDiscoverableBatch,
  readBatchJson,
  readJsonlTolerant,
  readTaskArtifact,
} from "../../extensions/task/audit-log.ts";
import { classifyBatchDir } from "../../extensions/task/task-ui.ts";
import { TASK_AUDIT_EVENT_TYPES, buildBatchRecord, buildQueuedTaskArtifact, previewToolInput } from "../../extensions/task/types.ts";

const NOW = "2026-03-18T14:22:31.120Z";
const LATER = "2026-03-18T14:22:32.120Z";
const LATEST = "2026-03-18T14:22:33.120Z";
const FIXED_BATCH_ID = "2026-03-18T14-22-31Z-482731";

test("shared audit event types expose the Phase 1 events.jsonl contract", () => {
  assert.deepEqual(TASK_AUDIT_EVENT_TYPES, [
    "batch_started",
    "task_queued",
    "task_running",
    "task_finished",
    "batch_finished",
  ]);
});

test("batch and task artifacts use the full default Phase 1 audit contract", () => {
  const startedAt = NOW;
  const batch = buildBatchRecord({
    batchId: FIXED_BATCH_ID,
    toolName: "tasks",
    rootCwd: "/tmp/project",
    startedAt,
  });
  const task = buildQueuedTaskArtifact({
    batchId: batch.batchId,
    id: "042731",
    task: "Inspect auth flow",
    cwd: "/tmp/project",
    queuedAt: startedAt,
  });

  assert.deepEqual(batch, {
    schemaVersion: 1,
    batchId: FIXED_BATCH_ID,
    toolName: "tasks",
    rootCwd: "/tmp/project",
    startedAt,
    finishedAt: null,
    status: "initializing",
    initialized: false,
    taskIds: [],
    summary: {
      total: 0,
      success: 0,
      error: 0,
      aborted: 0,
    },
    auditIntegrity: "pending",
  });

  assert.deepEqual(task, {
    schemaVersion: 1,
    batchId: batch.batchId,
    id: "042731",
    task: "Inspect auth flow",
    cwd: "/tmp/project",
    status: "queued",
    queuedAt: startedAt,
    finishedAt: null,
    finalOutput: null,
    error: null,
    timeline: [{ at: startedAt, state: "queued" }],
    toolCalls: [],
  });
  assert.equal(typeof task.id, "string");
});

test("preview generation redacts structured secrets, preserves exact 200-char previews, truncates at 201+, and hides freeform strings", () => {
  assert.equal(previewToolInput("Authorization: Bearer abc"), "[STRING_INPUT]");
  assert.equal(
    previewToolInput({ token: "abc", nested: { password: "def" }, authorization: "ghi", safe: 1 }),
    '{"authorization":"[REDACTED]","nested":{"password":"[REDACTED]"},"safe":1,"token":"[REDACTED]"}',
  );
  assert.equal(
    previewToolInput({ apiKey: "abc", Cookie: "session", nested: { cookie: "crumb" }, safe: 1 }),
    '{"Cookie":"[REDACTED]","apiKey":"[REDACTED]","nested":{"cookie":"[REDACTED]"},"safe":1}',
  );

  const exactPreview = JSON.stringify({ huge: "x".repeat(189) });
  assert.equal(exactPreview.length, 200);
  assert.equal(previewToolInput({ huge: "x".repeat(189) }), exactPreview);

  const overlongPreview = JSON.stringify({ huge: "x".repeat(190) });
  assert.equal(overlongPreview.length, 201);
  const truncatedPreview = previewToolInput({ huge: "x".repeat(190) });
  assert.equal(truncatedPreview, `${overlongPreview.slice(0, 197)}...`);
  assert.equal(truncatedPreview.length, 200);
  assert.match(truncatedPreview, /\.\.\.$/);

  assert.equal(
    previewToolInput({ bad: { toJSON() { throw new Error("nope"); } } }),
    "[UNSERIALIZABLE_INPUT]",
  );
});

test("preview truncation follows the production boundary contract for grapheme-aware and fallback environments", () => {
  const hasGraphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";

  const combining = "e\u0301";
  assert.equal(
    previewToolInput({ huge: `${"x".repeat(187)}${combining}${"y".repeat(10)}` }),
    `{"huge":"${"x".repeat(187)}${hasGraphemeSegmenter ? combining : "e"}...`,
  );

  const familyEmoji = "👨‍👩‍👧‍👦";
  assert.equal(
    previewToolInput({ huge: `${"x".repeat(187)}${familyEmoji}${"y".repeat(10)}` }),
    `{"huge":"${"x".repeat(187)}${hasGraphemeSegmenter ? familyEmoji : "👨"}...`,
  );
});

test("audit writer rewrites batch and task json atomically and tolerates one partial trailing jsonl line", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-audit-"));
  const batch = await createAuditBatch({
    rootCwd: root,
    toolName: "tasks",
    startedAt: NOW,
    batchId: FIXED_BATCH_ID,
    taskIds: ["042731"],
  });

  const queuedTask = buildQueuedTaskArtifact({
    batchId: batch.batchId,
    id: "042731",
    task: "Inspect auth flow",
    cwd: root,
    queuedAt: NOW,
  });

  await batch.writeBatch({ ...batch.batchRecord, taskIds: ["042731"], status: "running" });
  await batch.writeTaskArtifact(queuedTask);
  await batch.appendEvent({ type: "batch_started", at: NOW, toolName: "tasks", rootCwd: root });
  await fs.promises.appendFile(batch.eventsPath, '{"bad":', "utf8");

  const batchJson = await fs.promises.readFile(batch.batchPath, "utf8");
  const taskJson = await fs.promises.readFile(batch.taskPath("042731"), "utf8");
  const siblingEntries = await fs.promises.readdir(batch.batchDir);
  const events = await readJsonlTolerant(batch.eventsPath);

  assert.equal(batchJson.endsWith("\n"), true);
  assert.equal(taskJson.endsWith("\n"), true);
  assert.equal(siblingEntries.some((entry) => entry.includes(".tmp")), false);
  assert.equal(JSON.parse(batchJson).status, "running");
  assert.equal(JSON.parse(taskJson).id, "042731");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "batch_started");
});

test("running markers, safe tool previews, and terminal task json persist before task_finished", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-audit-"));
  const overrideCwd = path.join(root, "override");
  const batch = await createAuditBatch({
    rootCwd: root,
    toolName: "tasks",
    startedAt: NOW,
    batchId: FIXED_BATCH_ID,
    taskIds: ["042731"],
  });

  await batch.writeTaskArtifact(buildQueuedTaskArtifact({
    batchId: batch.batchId,
    id: "042731",
    task: "Inspect auth flow",
    cwd: overrideCwd,
    queuedAt: NOW,
  }));
  await batch.appendEvent({ type: "batch_started", at: NOW, toolName: "tasks", rootCwd: root });
  await batch.appendEvent({ type: "task_queued", at: NOW, taskId: "042731" });
  await batch.markInitialized(["042731"]);

  await batch.tryMarkRunning("042731", LATER);
  await batch.recordToolCall("042731", {
    at: LATER,
    tool: "read",
    args: { path: "src/index.ts", token: "secret-token" },
    status: "failed",
    error: "boom",
  });

  const runningTask = await readTaskArtifact(batch.batchDir, "042731");
  assert.equal(runningTask?.cwd, overrideCwd);
  assert.equal(runningTask?.status, "running");
  assert.deepEqual(runningTask?.timeline.map((entry) => entry.state), ["queued", "running"]);
  assert.deepEqual(runningTask?.toolCalls, [
    {
      at: LATER,
      tool: "read",
      argsPreview: '{"path":"src/index.ts","token":"[REDACTED]"}',
      status: "failed",
      error: "boom",
    },
  ]);

  const terminalTask = {
    ...runningTask,
    status: "success",
    finishedAt: LATEST,
    finalOutput: "done",
    error: null,
    timeline: [...runningTask.timeline, { at: LATEST, state: "success" }],
  };

  await batch.writeTerminalTask("042731", terminalTask);

  const terminalBeforeEvent = await readTaskArtifact(batch.batchDir, "042731");
  const eventsBeforeFinished = await readJsonlTolerant(batch.eventsPath);

  assert.equal(terminalBeforeEvent?.status, "success");
  assert.equal(eventsBeforeFinished.some((event) => event.type === "task_finished"), false);

  await batch.appendTaskFinished("042731", LATEST, "success", null);

  const events = await readJsonlTolerant(batch.eventsPath);
  assert.deepEqual(
    events.map((event) => event.type),
    ["batch_started", "task_queued", "task_running", "task_finished"],
  );
});

test("readJsonlTolerant rejects a corrupt final line when the file is newline-terminated", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-audit-"));
  const eventsPath = path.join(root, "events.jsonl");

  await fs.promises.writeFile(eventsPath, `${JSON.stringify({ ok: true })}\n{"bad":}\n`, "utf8");

  await assert.rejects(
    readJsonlTolerant(eventsPath),
    /Corrupt JSONL line 2/,
  );
});

test("graceful finalization writes terminal task json, then final batch.json, then batch_finished", async () => {
  const harness = await createFinalizationHarness();

  await harness.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  await harness.finishBatch();

  assert.deepEqual(harness.finalizationOrder, ["task-json", "batch-json", "batch-finished"]);
});

test("gracefully finalized batches keep summary, status, and auditIntegrity in sync across files", async () => {
  const harness = await createFinalizationHarness();

  await harness.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  await harness.finishBatch();

  const batch = await harness.readBatch();
  const events = await harness.readEvents();
  const lastEvent = events.at(-1);

  assert.deepEqual(batch?.summary, { total: 1, success: 1, error: 0, aborted: 0 });
  assert.equal(batch?.status, "success");
  assert.equal(batch?.auditIntegrity, "ok");
  assert.equal(batch?.finishedAt, LATEST);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(lastEvent, {
    schemaVersion: 1,
    type: "batch_finished",
    batchId: FIXED_BATCH_ID,
    seq: 5,
    at: LATEST,
    status: "success",
    auditIntegrity: "ok",
  });
});

test("gracefully finalized batches classify complete", async () => {
  const harness = await createFinalizationHarness();

  await harness.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  await harness.finishBatch();

  assert.deepEqual(await classifyBatchDir(harness.batchDir), { visible: true, classification: "complete" });
});


test("complete classification requires one matching task_finished event for every terminal task artifact", async () => {
  const missingFinishedEvent = await createFinalizationHarness();
  await missingFinishedEvent.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  await missingFinishedEvent.finishBatch();

  const missingEventLines = (await fs.promises.readFile(path.join(missingFinishedEvent.batchDir, "events.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type !== "task_finished");
  await fs.promises.writeFile(
    path.join(missingFinishedEvent.batchDir, "events.jsonl"),
    `${missingEventLines.map((event) => JSON.stringify(event)).join("\n")}
`,
    "utf8",
  );

  assert.deepEqual(await classifyBatchDir(missingFinishedEvent.batchDir), { visible: true, classification: "incomplete" });

  const mismatchedParity = await createFinalizationHarness();
  await mismatchedParity.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  await mismatchedParity.finishBatch();

  const terminalTask = await readTaskArtifact(mismatchedParity.batchDir, "042731");
  await fs.promises.writeFile(
    path.join(mismatchedParity.batchDir, "tasks", "042731.json"),
    `${JSON.stringify({
      ...terminalTask,
      status: "error",
      error: "boom",
      timeline: [...terminalTask.timeline.slice(0, -1), { at: LATEST, state: "error" }],
    }, null, 2)}
`,
    "utf8",
  );

  assert.deepEqual(await classifyBatchDir(mismatchedParity.batchDir), { visible: true, classification: "incomplete" });
});

test("initialized batch missing batch_finished is discoverable and classified incomplete", async () => {
  const fixture = await writeInterruptedBatchFixture();

  assert.equal(await isDiscoverableBatch(fixture.batch.batchDir), true);
  assert.deepEqual(await classifyBatchDir(fixture.batch.batchDir), { visible: true, classification: "incomplete" });
});

test("pre-init leftovers stay hidden from discoverable batch classification", async () => {
  const fixture = await writeHiddenPreInitFixture();

  assert.deepEqual(await classifyBatchDir(fixture.batch.batchDir), { visible: false, classification: "pre-init" });
});

test("discoverable batch requires initialized true, exactly one batch_started, exactly one task_queued per task, and queued task artifacts", async () => {
  const initialized = await writeInitializedFixture();
  assert.equal(await isDiscoverableBatch(initialized.batch.batchDir), true);

  const notInitialized = await writeInitializedFixture();
  await notInitialized.batch.writeBatch({
    ...notInitialized.batch.batchRecord,
    initialized: false,
    status: "initializing",
  });
  assert.equal(await isDiscoverableBatch(notInitialized.batch.batchDir), false);

  const malformedInitialized = await writeInitializedFixture();
  await malformedInitialized.batch.writeBatch({
    ...malformedInitialized.batch.batchRecord,
    initialized: "true",
  });
  assert.equal(await isDiscoverableBatch(malformedInitialized.batch.batchDir), false);

  const duplicateStarted = await writeInitializedFixture();
  await duplicateStarted.batch.appendEvent({ type: "batch_started", at: LATER, toolName: "tasks", rootCwd: duplicateStarted.root });
  assert.equal(await isDiscoverableBatch(duplicateStarted.batch.batchDir), false);

  const duplicateQueued = await writeInitializedFixture();
  await duplicateQueued.batch.appendEvent({ type: "task_queued", at: LATER, taskId: "042731" });
  assert.equal(await isDiscoverableBatch(duplicateQueued.batch.batchDir), false);

  const corruptEvents = await writeInitializedFixture();
  await fs.promises.appendFile(corruptEvents.batch.eventsPath, '{"bad":}\n', "utf8");
  assert.equal(await isDiscoverableBatch(corruptEvents.batch.batchDir), false);

  const missingQueuedArtifact = await writeInitializedFixture();
  await fs.promises.writeFile(
    missingQueuedArtifact.batch.taskPath("042731"),
    JSON.stringify({
      ...buildQueuedTaskArtifact({
        batchId: missingQueuedArtifact.batch.batchId,
        id: "042731",
        task: "Inspect auth flow",
        cwd: missingQueuedArtifact.root,
        queuedAt: NOW,
      }),
      timeline: [{ at: NOW, state: "running" }],
    }, null, 2),
    "utf8",
  );
  assert.equal(await isDiscoverableBatch(missingQueuedArtifact.batch.batchDir), false);
});

test("discoverable batch returns false for malformed task artifacts that still parse as json", async () => {
  const malformedTaskArtifact = await writeInitializedFixture();
  await fs.promises.writeFile(
    malformedTaskArtifact.batch.taskPath("042731"),
    JSON.stringify({
      ...buildQueuedTaskArtifact({
        batchId: malformedTaskArtifact.batch.batchId,
        id: "042731",
        task: "Inspect auth flow",
        cwd: malformedTaskArtifact.root,
        queuedAt: NOW,
      }),
      timeline: [null],
    }, null, 2),
    "utf8",
  );

  assert.equal(await isDiscoverableBatch(malformedTaskArtifact.batch.batchDir), false);
});

test("lifecycle event appends use monotonic seq values and durable newline-terminated records", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-audit-"));
  const batch = await createAuditBatch({
    rootCwd: root,
    toolName: "tasks",
    startedAt: NOW,
    batchId: FIXED_BATCH_ID,
  });

  await batch.appendEvent({ type: "batch_started", at: NOW, toolName: "tasks", rootCwd: root });
  await batch.appendEvent({ type: "task_queued", at: LATER, taskId: "042731" });
  await batch.appendEvent({ type: "task_queued", at: LATEST, taskId: "518204" });

  const rawEvents = await fs.promises.readFile(batch.eventsPath, "utf8");
  const parsedEvents = await readJsonlTolerant(batch.eventsPath);

  assert.equal(rawEvents.endsWith("\n"), true);
  assert.deepEqual(
    rawEvents.trimEnd().split("\n").map((line) => JSON.parse(line).seq),
    [1, 2, 3],
  );
  assert.deepEqual(parsedEvents.map((event) => event.seq), [1, 2, 3]);
});

test("concurrent event appends keep events.jsonl ordered by seq", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-audit-"));
  const batch = await createAuditBatch({
    rootCwd: root,
    toolName: "tasks",
    startedAt: NOW,
    batchId: FIXED_BATCH_ID,
  });

  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      batch.appendEvent({
        type: "task_queued",
        at: `2026-03-18T14:22:${String(index).padStart(2, "0")}.120Z`,
        taskId: String(index).padStart(6, "0"),
      })
    ),
  );

  const parsedEvents = await readJsonlTolerant(batch.eventsPath);

  assert.deepEqual(
    parsedEvents.map((event) => event.seq),
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
});

async function createFinalizationHarness() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-finalize-"));
  const batch = await createAuditBatch({
    rootCwd: root,
    toolName: "tasks",
    startedAt: NOW,
    batchId: FIXED_BATCH_ID,
    taskIds: ["042731"],
  });
  const finalizationOrder = [];

  await batch.writeTaskArtifact(buildQueuedTaskArtifact({
    batchId: batch.batchId,
    id: "042731",
    task: "Inspect auth flow",
    cwd: root,
    queuedAt: NOW,
  }));
  await batch.appendEvent({ type: "batch_started", at: NOW, toolName: "tasks", rootCwd: root });
  await batch.appendEvent({ type: "task_queued", at: NOW, taskId: "042731" });
  await batch.markInitialized(["042731"]);
  await batch.tryMarkRunning("042731", LATER);

  return {
    batchDir: batch.batchDir,
    finalizationOrder,
    async finishTask(taskId, terminal) {
      const task = await readTaskArtifact(batch.batchDir, taskId);
      const terminalTask = {
        ...task,
        status: terminal.status,
        finishedAt: LATEST,
        finalOutput: terminal.finalOutput,
        error: terminal.error,
        timeline: [...task.timeline, { at: LATEST, state: terminal.status }],
      };

      await batch.writeTerminalTask(taskId, terminalTask);
      finalizationOrder.push("task-json");
      await batch.appendTaskFinished(taskId, LATEST, terminal.status, terminal.error);
    },
    async finishBatch() {
      const batchRecord = {
        ...batch.batchRecord,
        finishedAt: LATEST,
        status: "success",
        summary: { total: 1, success: 1, error: 0, aborted: 0 },
        auditIntegrity: "ok",
      };

      await batch.writeFinalBatch(batchRecord);
      finalizationOrder.push("batch-json");
      await batch.appendBatchFinished(LATEST, batchRecord.status, batchRecord.auditIntegrity);
      finalizationOrder.push("batch-finished");
    },
    readBatch() {
      return readBatchJson(batch.batchDir);
    },
    readEvents() {
      return readJsonlTolerant(batch.eventsPath);
    },
  };
}

async function writeInterruptedBatchFixture() {
  const fixture = await writeInitializedFixture(["042731"]);
  const task = await readTaskArtifact(fixture.batch.batchDir, "042731");

  await fixture.batch.writeTerminalTask("042731", {
    ...task,
    status: "success",
    finishedAt: LATER,
    finalOutput: "done",
    error: null,
    timeline: [...task.timeline, { at: LATER, state: "success" }],
  });
  await fixture.batch.appendTaskFinished("042731", LATER, "success", null);
  await fixture.batch.writeFinalBatch({
    ...fixture.batch.batchRecord,
    finishedAt: LATEST,
    status: "success",
    summary: { total: 1, success: 1, error: 0, aborted: 0 },
    auditIntegrity: "failed",
  });

  return fixture;
}

async function writeHiddenPreInitFixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-discoverable-preinit-"));
  const batch = await createAuditBatch({
    rootCwd: root,
    toolName: "tasks",
    startedAt: NOW,
    batchId: FIXED_BATCH_ID,
    taskIds: ["042731"],
  });

  await batch.writeTaskArtifact(buildQueuedTaskArtifact({
    batchId: batch.batchId,
    id: "042731",
    task: "Inspect auth flow",
    cwd: root,
    queuedAt: NOW,
  }));
  await batch.appendEvent({ type: "batch_started", at: NOW, toolName: "tasks", rootCwd: root });
  await batch.appendEvent({ type: "task_queued", at: NOW, taskId: "042731" });
  await batch.writeBatch({
    ...batch.batchRecord,
    status: "initializing",
    initialized: false,
    auditIntegrity: "failed",
  });

  return { root, batch };
}

async function writeInitializedFixture(taskIds = ["042731", "518204"]) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-discoverable-"));
  const batch = await createAuditBatch({
    rootCwd: root,
    toolName: "tasks",
    startedAt: NOW,
    batchId: FIXED_BATCH_ID,
    taskIds,
  });

  await batch.appendEvent({ type: "batch_started", at: NOW, toolName: "tasks", rootCwd: root });
  for (const taskId of taskIds) {
    await batch.writeTaskArtifact(buildQueuedTaskArtifact({
      batchId: batch.batchId,
      id: taskId,
      task: `Inspect task ${taskId}`,
      cwd: root,
      queuedAt: NOW,
    }));
    await batch.appendEvent({ type: "task_queued", at: NOW, taskId });
  }
  await batch.markInitialized(taskIds);

  return { root, batch };
}
