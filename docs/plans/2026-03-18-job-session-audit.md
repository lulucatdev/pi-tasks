# Job Session / Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan job-by-job. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 1 job-session ergonomics and auditability to `extensions/jobs` by shipping `/jobs-start`, durable batch/job artifacts under project `.pi/jobs/`, discoverable incomplete-batch handling, and per-job simplified tool traces while keeping the normal outward `job(...)` / `jobs(...)` success/error shape wire-compatible.

**Architecture:** Split the current monolithic `extensions/jobs/index.ts` into focused modules so command behavior, audit persistence, execution flow, and UI classification can evolve independently. A single root-side audit writer serializes `batch.json`, `events.jsonl`, and `jobs/<job-id>.json` updates; job workers never write audit files directly.

**Tech Stack:** TypeScript extension modules, pi extension APIs, Node.js `fs`/`path`/`os`, Node built-in `node:test`, repo `npm run check`, repo `npm run smoke`, focused `pi --no-extensions -e ./extensions/jobs/index.ts` smoke commands

---

## File Structure

**Primary implementation files**
- Modify: `extensions/jobs/index.ts` — keep registration entrypoint only; delegate to extracted modules
- Modify: `extensions/jobs/README.md` — document `/jobs-start`, `.pi/jobs/`, discoverable/incomplete behavior

**New implementation modules**
- Create: `extensions/jobs/types.ts` — shared audit/runtime types and small pure helpers
- Create: `extensions/jobs/audit-log.ts` — path resolution, atomic writes, JSONL append/parse helpers, discoverable-batch predicate, preview generation
- Create: `extensions/jobs/commands.ts` — `/jobs-start`, `/jobs-ui` registration glue, exact visible output helpers
- Create: `extensions/jobs/run-jobs.ts` — job validation, batch initialization, worker launch sequencing, terminal aggregation, audit-degradation handling
- Create: `extensions/jobs/job-ui.ts` — dashboard rendering and batch classification helpers

**New tests / validation**
- Create: `tests/jobs/audit-files.test.mjs` — file contracts, JSONL durability, discoverable-batch predicate, preview generation, interruption classification
- Create: `tests/jobs/jobs-start.test.mjs` — `/jobs-start` append behavior, duplicate suppression, fallback rendering, “no batch created” behavior
- Create: `tests/jobs/run-jobs-flow.test.mjs` — orchestration order, `job(...)` vs `jobs(...)`, synthetic terminal states, running markers, fatal audit degradation branches
- Create: `scripts/jobs-audit-smoke.sh` — temp-workspace smoke script that asserts audit artifacts from real `pi` extension runs

**Responsibility boundaries**
- `audit-log.ts` owns all on-disk writes and read-side discovery helpers.
- `run-jobs.ts` owns execution sequencing, batch initialization checkpoints, and audit-degraded branch behavior.
- `commands.ts` owns only user command behavior; it must not create hidden session mode.
- `job-ui.ts` consumes discoverable batch state and classifies incomplete batches without mutating artifacts.

---

### Job 1: Lock The Audit Record Contracts And Preview Rules

**Files:**
- Create: `extensions/jobs/types.ts`
- Create: `tests/jobs/audit-files.test.mjs`
- Modify: `extensions/jobs/index.ts`

- [ ] **Step 1: Write the failing contract test for batch/job schema**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildBatchRecord, buildQueuedJobArtifact } from "../../extensions/jobs/audit-log.js";

test("batch and job artifacts use schemaVersion 1 and string ids", () => {
  const batch = buildBatchRecord({
    batchId: "2026-03-18T14-22-31Z-482731",
    toolName: "jobs",
    rootCwd: "/tmp/project",
    startedAt: "2026-03-18T14:22:31.120Z",
  });
  const job = buildQueuedJobArtifact({
    batchId: batch.batchId,
    id: "042731",
    job: "Inspect auth flow",
    cwd: "/tmp/project",
    queuedAt: "2026-03-18T14:22:31.120Z",
  });

  assert.equal(batch.schemaVersion, 1);
  assert.equal(batch.initialized, false);
  assert.equal(batch.auditIntegrity, "pending");
  assert.equal(job.schemaVersion, 1);
  assert.equal(job.batchId, batch.batchId);
  assert.equal(job.id, "042731");
  assert.equal(typeof job.id, "string");
  assert.deepEqual(job.timeline, [{ at: "2026-03-18T14:22:31.120Z", state: "queued" }]);
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

Run: `node --test tests/jobs/audit-files.test.mjs`
Expected: FAIL because the audit record helpers and preview generator do not exist.

- [ ] **Step 4: Create the shared type module**

```ts
// extensions/jobs/types.ts
export type BatchRuntimeStatus = "initializing" | "running" | "success" | "error" | "aborted";
export type JobArtifactStatus = "queued" | "running" | "success" | "error" | "aborted";

export interface BatchRecord {
  schemaVersion: 1;
  batchId: string;
  toolName: "job" | "jobs";
  rootCwd: string;
  startedAt: string;
  finishedAt: string | null;
  status: BatchRuntimeStatus;
  initialized: boolean;
  jobIds: string[];
  summary: { total: number; success: number; error: number; aborted: number };
  auditIntegrity: "pending" | "ok" | "failed";
}
```

- [ ] **Step 5: Implement helper factories with exact schemaVersion / id serialization**

```ts
export function buildQueuedJobArtifact(input: {
  batchId: string;
  id: string;
  job: string;
  cwd: string;
  queuedAt: string;
}): JobArtifact {
  return {
    schemaVersion: 1,
    batchId: input.batchId,
    id: input.id,
    job: input.job,
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

Run: `node --test tests/jobs/audit-files.test.mjs`
Expected: PASS for schemaVersion, string ids, and preview generation.

- [ ] **Step 8: Commit**

```bash
git add extensions/jobs/types.ts tests/jobs/audit-files.test.mjs extensions/jobs/index.ts
git commit -m "refactor(job): define audit contracts"
```

### Job 2: Build Atomic Audit Writers And The Discoverable-Batch Predicate

**Files:**
- Create: `extensions/jobs/audit-log.ts`
- Modify: `tests/jobs/audit-files.test.mjs`

- [ ] **Step 1: Add the failing test for atomic JSON and JSONL durability**

```js
test("audit writer uses atomic json files and tolerates one partial trailing jsonl line", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "job-audit-"));
  const batch = await createAuditBatch({ rootCwd: root, toolName: "jobs", startedAt: NOW, jobIds: ["042731"] });
  await batch.appendEvent({ schemaVersion: 1, type: "batch_started", at: NOW, batchId: batch.batchId, seq: 1, toolName: "jobs", rootCwd: root });
  await fs.promises.appendFile(batch.eventsPath, '{"bad":', "utf8");

  const events = await readJsonlTolerant(batch.eventsPath);
  assert.equal(events.length, 1);
});
```

- [ ] **Step 2: Add the failing discoverable-batch test**

```js
test("discoverable batch requires initialized true, exactly one batch_started, exactly one job_queued per job, and queued job artifacts", async () => {
  const batchDir = await writeInitializedFixture();
  assert.equal(await isDiscoverableBatch(batchDir), true);
  await writeDuplicateQueuedEvent(batchDir);
  assert.equal(await isDiscoverableBatch(batchDir), false);
  await writeEmptyJobIdsBatch(batchDir);
  assert.equal(await isDiscoverableBatch(batchDir), false);
});
```

- [ ] **Step 3: Run the tests to verify missing writer failures**

Run: `node --test tests/jobs/audit-files.test.mjs`
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
  const queuedIds = events.filter((event) => event.type === "job_queued" && event.batchId === batch.batchId).map((event) => event.jobId);
  return batch.jobIds.length > 0 && started.length === 1 && queuedIds.length === batch.jobIds.length && batch.jobIds.every((jobId) => queuedIds.filter((id) => id === jobId).length === 1 && {
    const jobPath = path.join(batchDir, "jobs", `${jobId}.json`);
    if (!fs.existsSync(jobPath) || !queuedIds.includes(jobId)) return false;
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    return job.queuedAt && job.timeline?.some((entry: any) => entry.state === "queued");
  });
}
```

- [ ] **Step 7: Re-run the audit-file tests**

Run: `node --test tests/jobs/audit-files.test.mjs`
Expected: PASS for atomic writes, tolerant JSONL parsing, and discoverable-batch detection.

- [ ] **Step 8: Commit**

```bash
git add extensions/jobs/audit-log.ts tests/jobs/audit-files.test.mjs
git commit -m "feat(job): add atomic audit writer"
```

### Job 3: Implement `/jobs-start` Exactly Once, Non-Destructively

**Files:**
- Create: `extensions/jobs/commands.ts`
- Create: `tests/jobs/jobs-start.test.mjs`
- Modify: `extensions/jobs/index.ts`
- Modify: `extensions/jobs/README.md`

- [ ] **Step 1: Write the failing insert-mode test**

```js
test("jobs-start appends the canonical block after the draft with a blank line", async () => {
  const draft = "Current draft";
  const result = runJobsStartForTest({ draft, insertSupported: true });
  assert.equal(result.mode, "inserted");
  assert.match(result.nextDraft, /Current draft\n\nUse `job` \/ `jobs`/);
});
```

- [ ] **Step 2: Write the failing duplicate-suppression and fallback tests**

```js
test("jobs-start does not append a second copy when the canonical block is already trailing", async () => {
  const draft = `Current draft\n\n${JOBS_START_GUIDANCE}`;
  const result = runJobsStartForTest({ draft, insertSupported: true });
  assert.equal(result.changed, false);
});

test("jobs-start prints the exact canonical block outside the transcript when insert is unavailable or fails", async () => {
  const unavailable = runJobsStartForTest({ draft: "", insertSupported: false });
  assert.equal(unavailable.mode, "printed");
  assert.equal(unavailable.output, JOBS_START_GUIDANCE);

  const failedInsert = runJobsStartForTest({ draft: "draft", insertSupported: true, insertFails: true });
  assert.equal(failedInsert.mode, "printed");
  assert.equal(failedInsert.output, JOBS_START_GUIDANCE);
});
```

- [ ] **Step 3: Run the `/jobs-start` tests to verify failure**

Run: `node --test tests/jobs/jobs-start.test.mjs`
Expected: FAIL because the helper and command do not exist.

- [ ] **Step 4: Implement the canonical guidance constant and append helper**

```ts
export const JOBS_START_GUIDANCE = [
  "Use `job` / `jobs` for the next stretch of work when isolated workers would help.",
  "",
  "- The root agent stays responsible for planning, orchestration, and synthesis.",
  "- Use `jobs` when work can be split into parallel leaf workers.",
  "- Use `job` when exactly one isolated worker is enough.",
  "- Give jobs clear names when helpful for attribution and audit.",
  "- Do not try to create nested jobs from inside a job worker.",
].join("\n");
```

- [ ] **Step 5: Implement the exact insertion / fallback ladder**

```ts
export function appendJobsStartGuidance(existingDraft: string) {
  const normalized = existingDraft.replace(/\n$/, "");
  if (normalized.endsWith(JOBS_START_GUIDANCE)) return { changed: false, value: normalized };
  return { changed: true, value: normalized ? `${normalized}\n\n${JOBS_START_GUIDANCE}` : JOBS_START_GUIDANCE };
}
```

- [ ] **Step 6: Register `/jobs-start` and render fallback outside the transcript**

```ts
pi.registerCommand("jobs-start", {
  description: "Insert job-oriented guidance into the current composer",
  handler: async (_args, ctx) => {
    const result = await runJobsStartCommand(ctx);
    if (result.mode === "printed") {
      ctx.ui.print?.(JOBS_START_GUIDANCE + "

You can send or reuse this block manually.");
      ctx.ui.notify("Jobs guidance printed for manual use.", "info");
      return;
    }
    ctx.ui.notify(result.changed ? "Jobs guidance inserted." : "Jobs guidance already present.", "info");
  },
});
```

- [ ] **Step 7: Re-run the `/jobs-start` tests**

Run: `node --test tests/jobs/jobs-start.test.mjs`
Expected: PASS for exact block text, duplicate suppression, and print fallback. Then verify `/jobs-start` alone does not create `.pi/jobs/`.

- [ ] **Step 8: Update README command docs**

```md
- `/jobs-start` — append job-oriented guidance to the current composer, or print it for manual reuse when insertion is unavailable
```

- [ ] **Step 9: Commit**

```bash
git add extensions/jobs/commands.ts extensions/jobs/index.ts extensions/jobs/README.md tests/jobs/jobs-start.test.mjs
git commit -m "feat(job): add jobs-start command"
```

### Job 4: Extract Runtime Flow And Preserve Current Outward Result Shapes

**Files:**
- Create: `extensions/jobs/run-jobs.ts`
- Modify: `extensions/jobs/index.ts`
- Modify: `tests/jobs/run-jobs-flow.test.mjs`

- [ ] **Step 1: Write the failing test for input validation and order preservation**

```js
test("validation rejects empty arrays and blank prompts before batch creation", async () => {
  await assert.rejects(() => validateJobParams({ jobs: [] }), /At least one job is required/);
  await assert.rejects(() => validateJobParams({ jobs: [{ job: "   " }] }), /non-empty job prompt/);
});

test("job ids and queued events preserve caller input order", async () => {
  const run = await createRunnerHarness([
    { name: "one", job: "first" },
    { name: "two", job: "second" },
  ]);
  assert.deepEqual(run.batch.jobIds, run.queuedEvents.map((event) => event.jobId));
});
```

- [ ] **Step 2: Run the flow tests to verify failure**

Run: `node --test tests/jobs/run-jobs-flow.test.mjs`
Expected: FAIL because the extracted runner harness does not exist.

- [ ] **Step 2a: Add the failing test for failure after `batch_started` but before initialization**

```js
test("failure after batch skeleton creation returns explicit error and leaves hidden pre-init leftovers", async () => {
  const harness = await createRunnerHarness([{ job: "first" }]);
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

- [ ] **Step 3: Extract validation and normalization into `run-jobs.ts`**

```ts
export function validateJobParams(params: JobsToolParams) {
  if (!params.jobs?.length) throw new Error("At least one job is required.");
  for (const entry of params.jobs) {
    if (!entry.job?.trim()) throw new Error("Each job must include a non-empty job prompt.");
  }
}
```

- [ ] **Step 4: Create the batch skeleton and append `batch_started`**

```ts
await audit.createBatchSkeleton();
```

- [ ] **Step 5: Assign job ids in original input order**

```ts
const normalizedJobs = normalizeJobs(params.jobs, ctx.cwd, existingIds);
```

- [ ] **Step 6: Write queued job artifacts in original input order**

```ts
await audit.writeQueuedArtifacts(normalizedJobs);
```

- [ ] **Step 7: Append one `job_queued` event per job, then mark the batch initialized/running**

```ts
await audit.appendQueuedEvents(normalizedJobs);
await audit.markInitialized(normalizedJobs.map((job) => job.id));
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

Run: `node --test tests/jobs/run-jobs-flow.test.mjs`
Expected: PASS for validation and queue-order behavior.

- [ ] **Step 10: Commit**

```bash
git add extensions/jobs/run-jobs.ts extensions/jobs/index.ts tests/jobs/run-jobs-flow.test.mjs
git commit -m "refactor(job): extract runtime flow"
```

### Job 5: Persist Running Markers, Terminal Job Records, And Tool Traces

**Files:**
- Modify: `extensions/jobs/run-jobs.ts`
- Modify: `extensions/jobs/audit-log.ts`
- Modify: `tests/jobs/run-jobs-flow.test.mjs`
- Modify: `tests/jobs/audit-files.test.mjs`

- [ ] **Step 1: Add the failing test for running markers and terminal-settle ordering**

```js
test("terminal job json is written before job_finished is appended", async () => {
  const harness = await createAuditHarness();
  await harness.markRunning("042731");
  await harness.finishJob("042731", { status: "success", finalOutput: "done", error: null });
  assert.equal(harness.jobJsonWrittenBeforeFinishedEvent("042731"), true);
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

  const job = await harness.readJob("042731");
  assert.equal(job.toolCalls[0].argsPreview.includes("[REDACTED]"), true);
  assert.equal(job.toolCalls[0].status, "failed");
});

test("job cwd artifacts materialize the effective absolute cwd when overrides are used", async () => {
  const harness = await createAuditHarness({ rootCwd: "/tmp/root" });
  await harness.writeQueued("042731", { cwd: "/tmp/override" });
  const job = await harness.readJob("042731");
  assert.equal(job.cwd, "/tmp/override");
});
```

- [ ] **Step 3: Run the tests to verify missing running / tool-call wiring**

Run: `node --test tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs`
Expected: FAIL because running markers and tool-call persistence are incomplete.

- [ ] **Step 4: Best-effort rewrite running job artifacts and append `job_running`**

```ts
await audit.tryMarkRunning(job.id, now);
```

- [ ] **Step 5: Persist terminal job JSON before appending `job_finished`**

```ts
await audit.writeTerminalJob(job.id, terminalArtifact);
await audit.appendJobFinished(job.id, terminalArtifact.status, terminalArtifact.error);
```

- [ ] **Step 6: Record only observable worker tool calls**

```ts
await audit.recordToolCall(job.id, {
  at: now,
  tool: call.name,
  argsPreview: previewToolInput(call.arguments),
  status: "completed",
  error: null,
});
```

- [ ] **Step 7: Re-run the tests**

Run: `node --test tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs`
Expected: PASS for running markers, terminal ordering, and safe tool traces.

- [ ] **Step 8: Commit**

```bash
git add extensions/jobs/run-jobs.ts extensions/jobs/audit-log.ts tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs
git commit -m "feat(job): persist running markers and tool traces"
```

### Job 6: Implement Graceful Batch Finalization And Cross-File Consistency

**Files:**
- Modify: `extensions/jobs/audit-log.ts`
- Modify: `extensions/jobs/run-jobs.ts`
- Modify: `tests/jobs/audit-files.test.mjs`
- Modify: `tests/jobs/run-jobs-flow.test.mjs`

- [ ] **Step 1: Add the failing test for graceful finalization ordering**

```js
test("graceful finalization writes terminal job json, then final batch.json, then batch_finished", async () => {
  const harness = await createAuditHarness();
  await harness.finishJob("042731", { status: "success", finalOutput: "done", error: null });
  await harness.finishBatch();
  assert.deepEqual(harness.finalizationOrder, ["job-json", "batch-json", "batch-finished"]);
});
```

- [ ] **Step 2: Add the failing test for cross-file consistency**

```js
test("gracefully finalized batch keeps summary, auditIntegrity, and event status in sync", async () => {
  const harness = await createAuditHarness();
  await harness.finishJob("042731", { status: "success", finalOutput: "done", error: null });
  await harness.finishBatch();
  assert.equal(harness.batch.summary.total, 1);
  assert.equal(harness.batch.auditIntegrity, "ok");
  assert.equal(harness.lastBatchFinished.auditIntegrity, "ok");
});
```

- [ ] **Step 3: Run the tests to confirm missing finalize sequencing**

Run: `node --test tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs`
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

Run: `node --test tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs`
Expected: PASS for job-json -> batch-json -> batch-finished ordering and cross-file parity.

- [ ] **Step 9: Commit**

```bash
git add extensions/jobs/audit-log.ts extensions/jobs/run-jobs.ts tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs
git commit -m "feat(job): finalize batch audit state consistently"
```

### Job 7: Implement Audit-Degraded Branches And Incomplete-Batch Classification

**Files:**
- Modify: `extensions/jobs/run-jobs.ts`
- Modify: `extensions/jobs/audit-log.ts`
- Create: `extensions/jobs/job-ui.ts`
- Modify: `tests/jobs/run-jobs-flow.test.mjs`
- Modify: `tests/jobs/audit-files.test.mjs`

- [ ] **Step 1: Add a failing test for post-init pre-launch synthetic terminal states**

```js
test("post-init pre-launch audit failure returns normal result shape from synthetic job states", async () => {
  const result = await runSyntheticFailureHarness("fatal-audit-before-launch");
  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, "aborted");
});

test("setup failure before launch maps queued jobs to error with non-empty error text", async () => {
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

Run: `node --test tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs`
Expected: FAIL because synthetic terminal branches and incomplete classification are not wired.

- [ ] **Step 4: Implement pre-launch synthetic terminal statuses using the spec mapping**

```ts
await audit.writeTerminalJob(job.id, {
  ...queuedJob,
  status: "aborted",
  finishedAt: now,
  error: "Audit persistence failed before launch.",
  timeline: [...queuedJob.timeline, { at: now, state: "aborted" }],
});
await audit.logWarning("Audit degraded; leaving batch incomplete.");
```

- [ ] **Step 5: Implement the discoverable-batch classification helpers in `job-ui.ts`**

```ts
export async function classifyBatchDir(batchDir: string) {
  if (!(await isDiscoverableBatch(batchDir))) return { visible: false, classification: "pre-init" };
  const batch = await readBatchJson(batchDir);
  if (batch.status === "running" || batch.auditIntegrity !== "ok") return { visible: true, classification: "incomplete" };
  return { visible: true, classification: "complete" };
}
```

- [ ] **Step 6: Surface incomplete classification in the job dashboard**

```ts
const statusLabel = classification === "incomplete"
  ? theme.fg("warning", "INC")
  : record.status === "success"
    ? theme.fg("success", "OK")
    : theme.fg("error", "ERR");
```

- [ ] **Step 7: Re-run the degraded-branch tests**

Run: `node --test tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs`
Expected: PASS for synthetic terminal states and incomplete discoverable-batch behavior.

- [ ] **Step 8: Commit**

```bash
git add extensions/jobs/run-jobs.ts extensions/jobs/audit-log.ts extensions/jobs/job-ui.ts tests/jobs/audit-files.test.mjs tests/jobs/run-jobs-flow.test.mjs
git commit -m "feat(job): classify degraded job batches"
```

### Job 8: Validate `job(...)`, `jobs(...)`, And Real Pi Behavior In A Temp Workspace

**Files:**
- Create: `scripts/jobs-audit-smoke.sh`
- Modify: `extensions/jobs/README.md`
- Test: repo scripts plus temp workspace smoke

- [ ] **Step 1: Write the temp-workspace smoke script**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$WORK_DIR"

pi --no-extensions -e "$ROOT_DIR/extensions/jobs/index.ts" -p "Use job to reply with exactly ok." </dev/null
test -f "$WORK_DIR/.pi/jobs"/*/batch.json
```
```

- [ ] **Step 2: Extend the smoke script to inspect artifacts**

```bash
BATCH_DIR="$(find "$WORK_DIR/.pi/jobs" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
node -e 'const fs=require("fs"); const p=process.argv[1]; const batch=JSON.parse(fs.readFileSync(`${p}/batch.json`,"utf8")); if (!batch.initialized) process.exit(1);' "$BATCH_DIR"
find "$BATCH_DIR/jobs" -type f | grep -q '.json$'
```

- [ ] **Step 3: Add explicit `job(...)`, `jobs(...)`, and `/jobs-start` assertions**

Run:
```bash
JOB_PROMPT='Use job to reply with exactly ok.'
JOBS_PROMPT='Use jobs with names alpha and beta; each worker must reply with exactly ok.'
JOBS_START_PROMPT='/jobs-start'
```
Expected: the script runs one single-job invocation, one multi-job invocation, and one `/jobs-start` command in a temp workspace, then asserts:
- `find "$WORK_DIR/.pi/jobs" -mindepth 1 -maxdepth 1 -type d | wc -l` is `2`
- each batch contains `batch.json`, `events.jsonl`, and the expected number of `jobs/*.json`
- `jq '.initialized' "$BATCH_DIR/batch.json"` is `true`
- `/jobs-start` alone does not create a third batch directory

- [ ] **Step 4: Update README examples and notes**

```md
Features:
- `/jobs-start` appends job-oriented guidance to the current composer, or prints it for manual reuse when insertion is unavailable
- Every successfully initialized `job(...)` and `jobs(...)` invocation writes `.pi/jobs/<batch-id>/batch.json`, `events.jsonl`, and `jobs/<job-id>.json`
- `/jobs-ui` shows discoverable incomplete batches as incomplete instead of hiding them
```

- [ ] **Step 5: Run focused extension tests**

Run: `node --test tests/jobs/audit-files.test.mjs tests/jobs/jobs-start.test.mjs tests/jobs/run-jobs-flow.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the focused smoke script**

Run: `bash scripts/jobs-audit-smoke.sh`
Expected: PASS in a temp workspace with real artifact checks.

- [ ] **Step 7: Run repo validation**

Run: `npm run check`
Expected: `repo check passed`

- [ ] **Step 8: Run full smoke coverage**

Run: `npm run smoke`
Expected: `smoke tests passed`

- [ ] **Step 9: Commit**

```bash
git add extensions/jobs/README.md scripts/jobs-audit-smoke.sh tests/jobs/audit-files.test.mjs tests/jobs/jobs-start.test.mjs tests/jobs/run-jobs-flow.test.mjs extensions/jobs/*.ts
git commit -m "feat(job): ship phase 1 job session audit"
```

### Job 9: Sync Back From Runtime If Implementation Happens In Live Pi Paths

**Files:**
- Modify: live runtime copy first, then repo copy
- Test: repo copy after sync

- [ ] **Step 1: If work was developed in `~/.pi/agent/extensions/jobs/`, sync it back**

Run: `npm run save-runtime -- extension job`
Expected: repo `extensions/jobs/` matches the validated runtime implementation

- [ ] **Step 2: Re-run repo validation after sync**

Run: `npm run check && npm run smoke`
Expected: both pass from the repo copy

- [ ] **Step 3: Commit final sync deltas**

```bash
git add extensions/jobs scripts/jobs-audit-smoke.sh tests/jobs
git commit -m "chore(job): sync validated runtime phase 1 job audit work"
```
