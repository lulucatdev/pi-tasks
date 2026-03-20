# Task Session / Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 1 task-session ergonomics and auditability to `extensions/task` by shipping `/tasks-start`, durable batch/task artifacts under project `.pi/tasks/`, discoverable incomplete-batch handling, and per-task simplified tool traces while keeping the normal outward `task(...)` / `tasks(...)` success/error shape wire-compatible.

**Architecture:** Split the current monolithic `extensions/task/index.ts` into focused modules so command behavior, audit persistence, execution flow, and UI classification can evolve independently. A single root-side audit writer serializes `batch.json`, `events.jsonl`, and `tasks/<task-id>.json` updates; task workers never write audit files directly.

**Tech Stack:** TypeScript extension modules, pi extension APIs, Node.js `fs`/`path`/`os`, Node built-in `node:test`, repo `npm run check`, repo `npm run smoke`, focused `pi --no-extensions -e ./extensions/task/index.ts` smoke commands

---

## File Structure

**Primary implementation files**
- Modify: `extensions/task/index.ts` — keep registration entrypoint only; delegate to extracted modules
- Modify: `extensions/task/README.md` — document `/tasks-start`, `.pi/tasks/`, discoverable/incomplete behavior

**New implementation modules**
- Create: `extensions/task/types.ts` — shared audit/runtime types and small pure helpers
- Create: `extensions/task/audit-log.ts` — path resolution, atomic writes, JSONL append/parse helpers, discoverable-batch predicate, preview generation
- Create: `extensions/task/commands.ts` — `/tasks-start`, `/tasks-ui` registration glue, exact visible output helpers
- Create: `extensions/task/run-tasks.ts` — task validation, batch initialization, worker launch sequencing, terminal aggregation, audit-degradation handling
- Create: `extensions/task/task-ui.ts` — dashboard rendering and batch classification helpers

**New tests / validation**
- Create: `tests/task/audit-files.test.mjs` — file contracts, JSONL durability, discoverable-batch predicate, preview generation, interruption classification
- Create: `tests/task/tasks-start.test.mjs` — `/tasks-start` append behavior, duplicate suppression, fallback rendering, “no batch created” behavior
- Create: `tests/task/run-tasks-flow.test.mjs` — orchestration order, `task(...)` vs `tasks(...)`, synthetic terminal states, running markers, fatal audit degradation branches
- Create: `scripts/task-audit-smoke.sh` — temp-workspace smoke script that asserts audit artifacts from real `pi` extension runs

**Responsibility boundaries**
- `audit-log.ts` owns all on-disk writes and read-side discovery helpers.
- `run-tasks.ts` owns execution sequencing, batch initialization checkpoints, and audit-degraded branch behavior.
- `commands.ts` owns only user command behavior; it must not create hidden session mode.
- `task-ui.ts` consumes discoverable batch state and classifies incomplete batches without mutating artifacts.

---

### Task 1: Lock The Audit Record Contracts And Preview Rules

**Files:**
- Create: `extensions/task/types.ts`
- Create: `tests/task/audit-files.test.mjs`
- Modify: `extensions/task/index.ts`

- [ ] **Step 1: Write the failing contract test for batch/task schema**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildBatchRecord, buildQueuedTaskArtifact } from "../../extensions/task/audit-log.js";

test("batch and task artifacts use schemaVersion 1 and string ids", () => {
  const batch = buildBatchRecord({
    batchId: "2026-03-18T14-22-31Z-482731",
    toolName: "tasks",
    rootCwd: "/tmp/project",
    startedAt: "2026-03-18T14:22:31.120Z",
  });
  const task = buildQueuedTaskArtifact({
    batchId: batch.batchId,
    id: "042731",
    task: "Inspect auth flow",
    cwd: "/tmp/project",
    queuedAt: "2026-03-18T14:22:31.120Z",
  });

  assert.equal(batch.schemaVersion, 1);
  assert.equal(batch.initialized, false);
  assert.equal(batch.auditIntegrity, "pending");
  assert.equal(task.schemaVersion, 1);
  assert.equal(task.batchId, batch.batchId);
  assert.equal(task.id, "042731");
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task.timeline, [{ at: "2026-03-18T14:22:31.120Z", state: "queued" }]);
});
```

- [ ] **Step 2: Add the failing preview-generation test**

```js
test("preview generation redacts structured secrets, sorts keys, truncates, and hides freeform strings", () => {
  assert.equal(previewToolInput("Authorization: Bearer abc"), '"[STRING_INPUT]"');
  assert.equal(
    previewToolInput({ token: "abc", nested: { password: "def" }, authorization: "ghi", safe: 1 }),
    '{"authorization":"[REDACTED]","nested":{"password":"[REDACTED]"},"safe":1,"token":"[REDACTED]"}'
  );
  assert.match(previewToolInput({ huge: "x".repeat(400) }), /\.\.\.$/);
  assert.equal(previewToolInput({ bad: { toJSON() { throw new Error("nope"); } } }), '"[UNSERIALIZABLE_INPUT]"');
});
```

- [ ] **Step 3: Run the tests to confirm missing helper failures**

Run: `node --test tests/task/audit-files.test.mjs`
Expected: FAIL because the audit record helpers and preview generator do not exist.

- [ ] **Step 4: Create the shared type module**

```ts
// extensions/task/types.ts
export type BatchRuntimeStatus = "initializing" | "running" | "success" | "error" | "aborted";
export type TaskArtifactStatus = "queued" | "running" | "success" | "error" | "aborted";

export interface BatchRecord {
  schemaVersion: 1;
  batchId: string;
  toolName: "task" | "tasks";
  rootCwd: string;
  startedAt: string;
  finishedAt: string | null;
  status: BatchRuntimeStatus;
  initialized: boolean;
  taskIds: string[];
  summary: { total: number; success: number; error: number; aborted: number };
  auditIntegrity: "pending" | "ok" | "failed";
}
```

- [ ] **Step 5: Implement helper factories with exact schemaVersion / id serialization**

```ts
export function buildQueuedTaskArtifact(input: {
  batchId: string;
  id: string;
  task: string;
  cwd: string;
  queuedAt: string;
}): TaskArtifact {
  return {
    schemaVersion: 1,
    batchId: input.batchId,
    id: input.id,
    task: input.task,
    cwd: input.cwd,
    status: "queued",
    queuedAt: input.queuedAt,
    finishedAt: null,
    finalOutput: null,
    error: null,
    timeline: [{ at: input.queuedAt, state: "queued" }],
    toolCalls: [],
  };
}
```

- [ ] **Step 6: Implement the canonical preview generator**

```ts
export function previewToolInput(value: unknown): string {
  if (typeof value === "string") return JSON.stringify("[STRING_INPUT]");
  try {
    const normalized = redactStructuredValueWithSortedKeys(value);
    return truncateVisible(JSON.stringify(normalized), 200);
  } catch {
    return JSON.stringify("[UNSERIALIZABLE_INPUT]");
  }
}
```

- [ ] **Step 7: Re-run the contract tests**

Run: `node --test tests/task/audit-files.test.mjs`
Expected: PASS for schemaVersion, string ids, and preview generation.

- [ ] **Step 8: Commit**

```bash
git add extensions/task/types.ts tests/task/audit-files.test.mjs extensions/task/index.ts
git commit -m "refactor(task): define audit contracts"
```

### Task 2: Build Atomic Audit Writers And The Discoverable-Batch Predicate

**Files:**
- Create: `extensions/task/audit-log.ts`
- Modify: `tests/task/audit-files.test.mjs`

- [ ] **Step 1: Add the failing test for atomic JSON and JSONL durability**

```js
test("audit writer uses atomic json files and tolerates one partial trailing jsonl line", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-audit-"));
  const batch = await createAuditBatch({ rootCwd: root, toolName: "tasks", startedAt: NOW, taskIds: ["042731"] });
  await batch.appendEvent({ schemaVersion: 1, type: "batch_started", at: NOW, batchId: batch.batchId, seq: 1, toolName: "tasks", rootCwd: root });
  await fs.promises.appendFile(batch.eventsPath, '{"bad":', "utf8");

  const events = await readJsonlTolerant(batch.eventsPath);
  assert.equal(events.length, 1);
});
```

- [ ] **Step 2: Add the failing discoverable-batch test**

```js
test("discoverable batch requires initialized true, exactly one batch_started, exactly one task_queued per task, and queued task artifacts", async () => {
  const batchDir = await writeInitializedFixture();
  assert.equal(await isDiscoverableBatch(batchDir), true);
  await writeDuplicateQueuedEvent(batchDir);
  assert.equal(await isDiscoverableBatch(batchDir), false);
  await writeEmptyTaskIdsBatch(batchDir);
  assert.equal(await isDiscoverableBatch(batchDir), false);
});
```

- [ ] **Step 3: Run the tests to verify missing writer failures**

Run: `node --test tests/task/audit-files.test.mjs`
Expected: FAIL because `createAuditBatch`, `readJsonlTolerant`, and `isDiscoverableBatch` are not implemented.

- [ ] **Step 4: Implement atomic file helpers**

```ts
export async function writeJsonAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.promises.rename(tempPath, filePath);
}
```

- [ ] **Step 5: Implement tolerant JSONL reading with one-partial-line forgiveness**

```ts
export async function readJsonlTolerant(filePath: string) {
  const lines = (await fs.promises.readFile(filePath, "utf8")).split("\n").filter(Boolean);
  return lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return index === lines.length - 1 ? [] : (() => { throw new Error(`Corrupt JSONL line ${index + 1}`); })();
    }
  });
}
```

- [ ] **Step 6: Implement batch creation and the discoverable-batch predicate**

```ts
export async function isDiscoverableBatch(batchDir: string) {
  const batch = await readBatchJson(batchDir);
  if (!batch?.initialized) return false;
  const events = await readJsonlTolerant(path.join(batchDir, "events.jsonl"));
  const started = events.filter((event) => event.type === "batch_started" && event.batchId === batch.batchId);
  const queuedIds = events.filter((event) => event.type === "task_queued" && event.batchId === batch.batchId).map((event) => event.taskId);
  return batch.taskIds.length > 0 && started.length === 1 && queuedIds.length === batch.taskIds.length && batch.taskIds.every((taskId) => queuedIds.filter((id) => id === taskId).length === 1 && {
    const taskPath = path.join(batchDir, "tasks", `${taskId}.json`);
    if (!fs.existsSync(taskPath) || !queuedIds.includes(taskId)) return false;
    const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    return task.queuedAt && task.timeline?.some((entry: any) => entry.state === "queued");
  });
}
```

- [ ] **Step 7: Re-run the audit-file tests**

Run: `node --test tests/task/audit-files.test.mjs`
Expected: PASS for atomic writes, tolerant JSONL parsing, and discoverable-batch detection.

- [ ] **Step 8: Commit**

```bash
git add extensions/task/audit-log.ts tests/task/audit-files.test.mjs
git commit -m "feat(task): add atomic audit writer"
```

### Task 3: Implement `/tasks-start` Exactly Once, Non-Destructively

**Files:**
- Create: `extensions/task/commands.ts`
- Create: `tests/task/tasks-start.test.mjs`
- Modify: `extensions/task/index.ts`
- Modify: `extensions/task/README.md`

- [ ] **Step 1: Write the failing insert-mode test**

```js
test("tasks-start appends the canonical block after the draft with a blank line", async () => {
  const draft = "Current draft";
  const result = runTasksStartForTest({ draft, insertSupported: true });
  assert.equal(result.mode, "inserted");
  assert.match(result.nextDraft, /Current draft\n\nUse `task` \/ `tasks`/);
});
```

- [ ] **Step 2: Write the failing duplicate-suppression and fallback tests**

```js
test("tasks-start does not append a second copy when the canonical block is already trailing", async () => {
  const draft = `Current draft\n\n${TASKS_START_GUIDANCE}`;
  const result = runTasksStartForTest({ draft, insertSupported: true });
  assert.equal(result.changed, false);
});

test("tasks-start prints the exact canonical block outside the transcript when insert is unavailable or fails", async () => {
  const unavailable = runTasksStartForTest({ draft: "", insertSupported: false });
  assert.equal(unavailable.mode, "printed");
  assert.equal(unavailable.output, TASKS_START_GUIDANCE);

  const failedInsert = runTasksStartForTest({ draft: "draft", insertSupported: true, insertFails: true });
  assert.equal(failedInsert.mode, "printed");
  assert.equal(failedInsert.output, TASKS_START_GUIDANCE);
});
```

- [ ] **Step 3: Run the `/tasks-start` tests to verify failure**

Run: `node --test tests/task/tasks-start.test.mjs`
Expected: FAIL because the helper and command do not exist.

- [ ] **Step 4: Implement the canonical guidance constant and append helper**

```ts
export const TASKS_START_GUIDANCE = [
  "Use `task` / `tasks` for the next stretch of work when isolated workers would help.",
  "",
  "- The root agent stays responsible for planning, orchestration, and synthesis.",
  "- Use `tasks` when work can be split into parallel leaf workers.",
  "- Use `task` when exactly one isolated worker is enough.",
  "- Give tasks clear names when helpful for attribution and audit.",
  "- Do not try to create nested tasks from inside a task worker.",
].join("\n");
```

- [ ] **Step 5: Implement the exact insertion / fallback ladder**

```ts
export function appendTasksStartGuidance(existingDraft: string) {
  const normalized = existingDraft.replace(/\n$/, "");
  if (normalized.endsWith(TASKS_START_GUIDANCE)) return { changed: false, value: normalized };
  return { changed: true, value: normalized ? `${normalized}\n\n${TASKS_START_GUIDANCE}` : TASKS_START_GUIDANCE };
}
```

- [ ] **Step 6: Register `/tasks-start` and render fallback outside the transcript**

```ts
pi.registerCommand("tasks-start", {
  description: "Insert task-oriented guidance into the current composer",
  handler: async (_args, ctx) => {
    const result = await runTasksStartCommand(ctx);
    if (result.mode === "printed") {
      ctx.ui.print?.(TASKS_START_GUIDANCE + "

You can send or reuse this block manually.");
      ctx.ui.notify("Tasks guidance printed for manual use.", "info");
      return;
    }
    ctx.ui.notify(result.changed ? "Tasks guidance inserted." : "Tasks guidance already present.", "info");
  },
});
```

- [ ] **Step 7: Re-run the `/tasks-start` tests**

Run: `node --test tests/task/tasks-start.test.mjs`
Expected: PASS for exact block text, duplicate suppression, and print fallback. Then verify `/tasks-start` alone does not create `.pi/tasks/`.

- [ ] **Step 8: Update README command docs**

```md
- `/tasks-start` — append task-oriented guidance to the current composer, or print it for manual reuse when insertion is unavailable
```

- [ ] **Step 9: Commit**

```bash
git add extensions/task/commands.ts extensions/task/index.ts extensions/task/README.md tests/task/tasks-start.test.mjs
git commit -m "feat(task): add tasks-start command"
```

### Task 4: Extract Runtime Flow And Preserve Current Outward Result Shapes

**Files:**
- Create: `extensions/task/run-tasks.ts`
- Modify: `extensions/task/index.ts`
- Modify: `tests/task/run-tasks-flow.test.mjs`

- [ ] **Step 1: Write the failing test for input validation and order preservation**

```js
test("validation rejects empty arrays and blank prompts before batch creation", async () => {
  await assert.rejects(() => validateTaskParams({ tasks: [] }), /At least one task is required/);
  await assert.rejects(() => validateTaskParams({ tasks: [{ task: "   " }] }), /non-empty task prompt/);
});

test("task ids and queued events preserve caller input order", async () => {
  const run = await createRunnerHarness([
    { name: "one", task: "first" },
    { name: "two", task: "second" },
  ]);
  assert.deepEqual(run.batch.taskIds, run.queuedEvents.map((event) => event.taskId));
});
```

- [ ] **Step 2: Run the flow tests to verify failure**

Run: `node --test tests/task/run-tasks-flow.test.mjs`
Expected: FAIL because the extracted runner harness does not exist.

- [ ] **Step 2a: Add the failing test for failure after `batch_started` but before initialization**

```js
test("failure after batch skeleton creation returns explicit error and leaves hidden pre-init leftovers", async () => {
  const harness = await createRunnerHarness([{ task: "first" }]);
  await harness.failAfterBatchStarted();
  assert.equal(harness.result.isError, true);
  assert.equal(await harness.isDiscoverableBatch(), false);
  const batch = await harness.readBatchJsonIfPresent();
  if (batch) {
    assert.equal(batch.status, "initializing");
    assert.equal(batch.auditIntegrity, "failed");
  }
});
```

- [ ] **Step 3: Extract validation and normalization into `run-tasks.ts`**

```ts
export function validateTaskParams(params: TasksToolParams) {
  if (!params.tasks?.length) throw new Error("At least one task is required.");
  for (const entry of params.tasks) {
    if (!entry.task?.trim()) throw new Error("Each task must include a non-empty task prompt.");
  }
}
```

- [ ] **Step 4: Create the batch skeleton and append `batch_started`**

```ts
await audit.createBatchSkeleton();
```

- [ ] **Step 5: Assign task ids in original input order**

```ts
const normalizedTasks = normalizeTasks(params.tasks, ctx.cwd, existingIds);
```

- [ ] **Step 6: Write queued task artifacts in original input order**

```ts
await audit.writeQueuedArtifacts(normalizedTasks);
```

- [ ] **Step 7: Append one `task_queued` event per task, then mark the batch initialized/running**

```ts
await audit.appendQueuedEvents(normalizedTasks);
await audit.markInitialized(normalizedTasks.map((task) => task.id));
```

- [ ] **Step 8: Preserve the existing outward success/error result shape**

```ts
return {
  content: [{ type: "text", text: buildResultText(details) }],
  details,
  isError: details.summary.error > 0 || details.summary.aborted > 0,
};
```

- [ ] **Step 9: Re-run the runner tests**

Run: `node --test tests/task/run-tasks-flow.test.mjs`
Expected: PASS for validation and queue-order behavior.

- [ ] **Step 10: Commit**

```bash
git add extensions/task/run-tasks.ts extensions/task/index.ts tests/task/run-tasks-flow.test.mjs
git commit -m "refactor(task): extract runtime flow"
```

### Task 5: Persist Running Markers, Terminal Task Records, And Tool Traces

**Files:**
- Modify: `extensions/task/run-tasks.ts`
- Modify: `extensions/task/audit-log.ts`
- Modify: `tests/task/run-tasks-flow.test.mjs`
- Modify: `tests/task/audit-files.test.mjs`

- [ ] **Step 1: Add the failing test for running markers and terminal-settle ordering**

```js
test("terminal task json is written before task_finished is appended", async () => {
  const harness = await createAuditHarness();
  await harness.markRunning("042731");
  await harness.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  assert.equal(harness.taskJsonWrittenBeforeFinishedEvent("042731"), true);
});
```

- [ ] **Step 2: Add the failing test for tool-call tracing with safe previews**

```js
test("observable worker tool calls are stored with safe previews and failed calls are retained", async () => {
  const harness = await createAuditHarness();
  await harness.recordToolCall("042731", {
    at: NOW,
    tool: "read",
    args: { path: "src/index.ts", token: "secret" },
    status: "failed",
    error: "boom",
  });

  const task = await harness.readTask("042731");
  assert.equal(task.toolCalls[0].argsPreview.includes("[REDACTED]"), true);
  assert.equal(task.toolCalls[0].status, "failed");
});

test("task cwd artifacts materialize the effective absolute cwd when overrides are used", async () => {
  const harness = await createAuditHarness({ rootCwd: "/tmp/root" });
  await harness.writeQueued("042731", { cwd: "/tmp/override" });
  const task = await harness.readTask("042731");
  assert.equal(task.cwd, "/tmp/override");
});
```

- [ ] **Step 3: Run the tests to verify missing running / tool-call wiring**

Run: `node --test tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs`
Expected: FAIL because running markers and tool-call persistence are incomplete.

- [ ] **Step 4: Best-effort rewrite running task artifacts and append `task_running`**

```ts
await audit.tryMarkRunning(task.id, now);
```

- [ ] **Step 5: Persist terminal task JSON before appending `task_finished`**

```ts
await audit.writeTerminalTask(task.id, terminalArtifact);
await audit.appendTaskFinished(task.id, terminalArtifact.status, terminalArtifact.error);
```

- [ ] **Step 6: Record only observable worker tool calls**

```ts
await audit.recordToolCall(task.id, {
  at: now,
  tool: call.name,
  argsPreview: previewToolInput(call.arguments),
  status: "completed",
  error: null,
});
```

- [ ] **Step 7: Re-run the tests**

Run: `node --test tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs`
Expected: PASS for running markers, terminal ordering, and safe tool traces.

- [ ] **Step 8: Commit**

```bash
git add extensions/task/run-tasks.ts extensions/task/audit-log.ts tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs
git commit -m "feat(task): persist running markers and tool traces"
```

### Task 6: Implement Graceful Batch Finalization And Cross-File Consistency

**Files:**
- Modify: `extensions/task/audit-log.ts`
- Modify: `extensions/task/run-tasks.ts`
- Modify: `tests/task/audit-files.test.mjs`
- Modify: `tests/task/run-tasks-flow.test.mjs`

- [ ] **Step 1: Add the failing test for graceful finalization ordering**

```js
test("graceful finalization writes terminal task json, then final batch.json, then batch_finished", async () => {
  const harness = await createAuditHarness();
  await harness.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  await harness.finishBatch();
  assert.deepEqual(harness.finalizationOrder, ["task-json", "batch-json", "batch-finished"]);
});
```

- [ ] **Step 2: Add the failing test for cross-file consistency**

```js
test("gracefully finalized batch keeps summary, auditIntegrity, and event status in sync", async () => {
  const harness = await createAuditHarness();
  await harness.finishTask("042731", { status: "success", finalOutput: "done", error: null });
  await harness.finishBatch();
  assert.equal(harness.batch.summary.total, 1);
  assert.equal(harness.batch.auditIntegrity, "ok");
  assert.equal(harness.lastBatchFinished.auditIntegrity, "ok");
});
```

- [ ] **Step 3: Run the tests to confirm missing finalize sequencing**

Run: `node --test tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs`
Expected: FAIL because final ordering and parity checks are not implemented yet.

- [ ] **Step 4: Implement final batch rewrite before `batch_finished`**

```ts
await audit.writeFinalBatch(batchRecord);
await audit.appendBatchFinished(batchRecord.status, batchRecord.auditIntegrity);
```

- [ ] **Step 5: Implement monotonic `seq` and exact final `batch_finished` payloads**

```ts
const event = { schemaVersion: 1, type: "batch_finished", batchId, seq: nextSeq(), at: now, status, auditIntegrity };
await appendJsonl(eventsPath, event);
```

- [ ] **Step 6: Re-run the finalization tests**

Run: `node --test tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs`
Expected: PASS for task-json -> batch-json -> batch-finished ordering and cross-file parity.

- [ ] **Step 9: Commit**

```bash
git add extensions/task/audit-log.ts extensions/task/run-tasks.ts tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs
git commit -m "feat(task): finalize batch audit state consistently"
```

### Task 7: Implement Audit-Degraded Branches And Incomplete-Batch Classification

**Files:**
- Modify: `extensions/task/run-tasks.ts`
- Modify: `extensions/task/audit-log.ts`
- Create: `extensions/task/task-ui.ts`
- Modify: `tests/task/run-tasks-flow.test.mjs`
- Modify: `tests/task/audit-files.test.mjs`

- [ ] **Step 1: Add a failing test for post-init pre-launch synthetic terminal states**

```js
test("post-init pre-launch audit failure returns normal result shape from synthetic task states", async () => {
  const result = await runSyntheticFailureHarness("fatal-audit-before-launch");
  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, "aborted");
});

test("setup failure before launch maps queued tasks to error with non-empty error text", async () => {
  const result = await runSyntheticFailureHarness("setup-before-launch-error");
  assert.equal(result.details.results[0].status, "error");
  assert.match(result.details.results[0].error, /failed/i);
});

test("user abort after launch preserves latest observed finalOutput snapshot", async () => {
  const result = await runSyntheticFailureHarness("abort-after-launch");
  assert.equal(result.details.results[0].status, "aborted");
  assert.equal(result.details.results[0].finalOutput, "partial visible output");
});
```

- [ ] **Step 2: Add a failing test for interrupted discoverable batches**

```js
test("initialized batch missing batch_finished is discoverable and classified incomplete", async () => {
  const batchDir = await writeInterruptedBatchFixture();
  const summary = await classifyBatchDir(batchDir);
  assert.equal(summary.visible, true);
  assert.equal(summary.classification, "incomplete");
});
```

- [ ] **Step 3: Run the tests to confirm the degraded branches are missing**

Run: `node --test tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs`
Expected: FAIL because synthetic terminal branches and incomplete classification are not wired.

- [ ] **Step 4: Implement pre-launch synthetic terminal statuses using the spec mapping**

```ts
await audit.writeTerminalTask(task.id, {
  ...queuedTask,
  status: "aborted",
  finishedAt: now,
  error: "Audit persistence failed before launch.",
  timeline: [...queuedTask.timeline, { at: now, state: "aborted" }],
});
await audit.logWarning("Audit degraded; leaving batch incomplete.");
```

- [ ] **Step 5: Implement the discoverable-batch classification helpers in `task-ui.ts`**

```ts
export async function classifyBatchDir(batchDir: string) {
  if (!(await isDiscoverableBatch(batchDir))) return { visible: false, classification: "pre-init" };
  const batch = await readBatchJson(batchDir);
  if (batch.status === "running" || batch.auditIntegrity !== "ok") return { visible: true, classification: "incomplete" };
  return { visible: true, classification: "complete" };
}
```

- [ ] **Step 6: Surface incomplete classification in the task dashboard**

```ts
const statusLabel = classification === "incomplete"
  ? theme.fg("warning", "INC")
  : record.status === "success"
    ? theme.fg("success", "OK")
    : theme.fg("error", "ERR");
```

- [ ] **Step 7: Re-run the degraded-branch tests**

Run: `node --test tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs`
Expected: PASS for synthetic terminal states and incomplete discoverable-batch behavior.

- [ ] **Step 8: Commit**

```bash
git add extensions/task/run-tasks.ts extensions/task/audit-log.ts extensions/task/task-ui.ts tests/task/audit-files.test.mjs tests/task/run-tasks-flow.test.mjs
git commit -m "feat(task): classify degraded task batches"
```

### Task 8: Validate `task(...)`, `tasks(...)`, And Real Pi Behavior In A Temp Workspace

**Files:**
- Create: `scripts/task-audit-smoke.sh`
- Modify: `extensions/task/README.md`
- Test: repo scripts plus temp workspace smoke

- [ ] **Step 1: Write the temp-workspace smoke script**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$WORK_DIR"

pi --no-extensions -e "$ROOT_DIR/extensions/task/index.ts" -p "Use task to reply with exactly ok." </dev/null
test -f "$WORK_DIR/.pi/tasks"/*/batch.json
```
```

- [ ] **Step 2: Extend the smoke script to inspect artifacts**

```bash
BATCH_DIR="$(find "$WORK_DIR/.pi/tasks" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
node -e 'const fs=require("fs"); const p=process.argv[1]; const batch=JSON.parse(fs.readFileSync(`${p}/batch.json`,"utf8")); if (!batch.initialized) process.exit(1);' "$BATCH_DIR"
find "$BATCH_DIR/tasks" -type f | grep -q '.json$'
```

- [ ] **Step 3: Add explicit `task(...)`, `tasks(...)`, and `/tasks-start` assertions**

Run:
```bash
TASK_PROMPT='Use task to reply with exactly ok.'
TASKS_PROMPT='Use tasks with names alpha and beta; each worker must reply with exactly ok.'
TASKS_START_PROMPT='/tasks-start'
```
Expected: the script runs one single-task invocation, one multi-task invocation, and one `/tasks-start` command in a temp workspace, then asserts:
- `find "$WORK_DIR/.pi/tasks" -mindepth 1 -maxdepth 1 -type d | wc -l` is `2`
- each batch contains `batch.json`, `events.jsonl`, and the expected number of `tasks/*.json`
- `jq '.initialized' "$BATCH_DIR/batch.json"` is `true`
- `/tasks-start` alone does not create a third batch directory

- [ ] **Step 4: Update README examples and notes**

```md
Features:
- `/tasks-start` appends task-oriented guidance to the current composer, or prints it for manual reuse when insertion is unavailable
- Every successfully initialized `task(...)` and `tasks(...)` invocation writes `.pi/tasks/<batch-id>/batch.json`, `events.jsonl`, and `tasks/<task-id>.json`
- `/tasks-ui` shows discoverable incomplete batches as incomplete instead of hiding them
```

- [ ] **Step 5: Run focused extension tests**

Run: `node --test tests/task/audit-files.test.mjs tests/task/tasks-start.test.mjs tests/task/run-tasks-flow.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the focused smoke script**

Run: `bash scripts/task-audit-smoke.sh`
Expected: PASS in a temp workspace with real artifact checks.

- [ ] **Step 7: Run repo validation**

Run: `npm run check`
Expected: `repo check passed`

- [ ] **Step 8: Run full smoke coverage**

Run: `npm run smoke`
Expected: `smoke tests passed`

- [ ] **Step 9: Commit**

```bash
git add extensions/task/README.md scripts/task-audit-smoke.sh tests/task/audit-files.test.mjs tests/task/tasks-start.test.mjs tests/task/run-tasks-flow.test.mjs extensions/task/*.ts
git commit -m "feat(task): ship phase 1 task session audit"
```

### Task 9: Sync Back From Runtime If Implementation Happens In Live Pi Paths

**Files:**
- Modify: live runtime copy first, then repo copy
- Test: repo copy after sync

- [ ] **Step 1: If work was developed in `~/.pi/agent/extensions/task/`, sync it back**

Run: `npm run save-runtime -- extension task`
Expected: repo `extensions/task/` matches the validated runtime implementation

- [ ] **Step 2: Re-run repo validation after sync**

Run: `npm run check && npm run smoke`
Expected: both pass from the repo copy

- [ ] **Step 3: Commit final sync deltas**

```bash
git add extensions/task scripts/task-audit-smoke.sh tests/task
git commit -m "chore(task): sync validated runtime phase 1 task audit work"
```
