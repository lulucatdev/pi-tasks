# Job Session / Audit Design

Status: Approved design, ready for planning
Owner: pi-tools
Date: 2026-03-18
Scope: `extensions/jobs`

## 1. Decision

This document defines the approved design for the first upgrade phase of the `job` / `jobs` extension.

Phase 1 SHALL focus on job session ergonomics and auditability.

Phase 1 SHALL include:
- a `/jobs-start` command that inserts job-oriented guidance for the current conversation
- batch-scoped audit artifacts for every `job(...)` and `jobs(...)` execution
- per-job machine-readable records that capture prompt, final output, lifecycle state changes, and simplified process traces

Phase 1 SHALL NOT include:
- mnemonic batch or job ids
- changes to the current numeric job id system
- explicit DAG or dependency graph execution
- hidden session mode toggles behind `/jobs-start`
- plan-mode or subagent workflow changes outside the `extensions/jobs` boundary

## 2. Problem Statement

The current `extensions/jobs` implementation already provides the core execution primitive the project wants:
- root-only job orchestration
- isolated leaf workers
- root-level `job` and `jobs` tools
- generated numeric job ids
- a job dashboard via `/jobs-ui`

However, the current experience still has two important gaps.

First, there is no lightweight user-facing command that explicitly nudges the root agent into a job-oriented workflow before a work session begins.

Second, job execution is not yet durable enough for auditing and later inspection. A user can see live job output in the UI, but there is no guaranteed project-local artifact set that answers all of the following after the run finishes:
- what prompt each job received
- what each job ultimately returned
- what tools each job used at a high level
- when each job moved through queued, running, and terminal states

This design closes those two gaps without changing the current execution model.

## 3. Goals

The implementation MUST satisfy all of the following goals:
- provide a user command that explicitly reminds the root agent to use `job` / `jobs` for the next stretch of work
- keep `/jobs-start` transparent and lightweight rather than introducing hidden runtime mode
- treat every successfully initialized `job(...)` and `jobs(...)` execution as one auditable batch
- persist machine-readable audit artifacts under the project `.pi` directory
- preserve the current numeric job ids and existing execution semantics with auditing treated as an internal side effect rather than a new outward result shape
- record enough job history to support audit, debugging, and later replay-oriented tooling
- avoid storing verbose intermediate prose when concise process traces are sufficient
- keep the design compatible with a future second phase for sequential or dependency-oriented orchestration

## 4. Non-Goals

This phase SHALL NOT include:
- replacing numeric job ids with mnemonic ids
- adding batch-level mnemonic ids
- introducing a persistent jobs mode flag in session state
- changing the meaning of `job` or `jobs`
- introducing worker-to-worker communication
- introducing dependency edges or explicit `job1 -> job2` graph declarations
- redesigning the `jobs-ui` interaction model beyond any small changes required to expose audit-aware metadata
- changing plan-mode, subagents, or prompt orchestration outside of what is required to keep `extensions/jobs` internally coherent

## 5. Architecture Overview

Phase 1 splits the job extension into three conceptual layers.

### 5.1 Prompt Entry Layer

The prompt entry layer owns `/jobs-start`.

This layer is responsible only for inserting a strong, explicit reminder that the root agent should prefer the job tools when the next piece of work benefits from fan-out / fan-in execution.

This layer does not execute jobs, create batches, modify job defaults, or write audit artifacts.

### 5.2 Execution Layer

The execution layer keeps the existing semantics of `job` and `jobs`:
- root-only orchestration
- isolated leaf workers
- no nested job creation
- current numeric job ids
- current partial update and result flow

Phase 1 deliberately avoids changing outward job execution semantics so the upgrade remains focused and low-risk.

### 5.3 Audit Layer

The audit layer is the main new subsystem.

Every successfully initialized `job(...)` or `jobs(...)` execution SHALL be normalized into one batch. A single-job invocation is simply a batch with one job.

The audit layer SHALL create project-local artifacts for each batch and each job. These artifacts SHALL capture:
- batch metadata and summary
- job prompt and final output
- job lifecycle transitions
- simplified tool activity

This layer is intentionally independent from `/jobs-start`. Audit artifacts exist because work actually ran, not because the user remembered to issue a setup command first.

## 6. `/jobs-start` Command Design

### 6.1 Purpose

`/jobs-start` is a user command that inserts a concise, high-signal reminder for the current conversation.

Its purpose is behavioral, not infrastructural. It helps the root agent switch into a job-oriented style of reasoning before implementation or exploration begins.

The command is a visible prompt-insertion command only.

### 6.2 Required Behavior

`/jobs-start` SHALL:
- produce an explicit confirmation that job-oriented guidance was either inserted or printed for manual use
- insert visible guidance rather than an invisible mode toggle
- encourage the root agent to use `jobs` for parallelizable work and `job` for exactly one isolated worker
- remind the root agent that only the root agent plans and fan-ins results
- encourage naming work items when useful for attribution and audit

`/jobs-start` SHALL NOT:
- create a batch
- execute any worker
- change tool permissions
- mutate hidden session state that later commands depend on
- write any audit files by itself

### 6.3 Transparency

The `/jobs-start` UX contract SHALL be concrete:
- insertion path: only when a composer-insert API exists and returns success, append the guidance block after the existing draft with a blank-line separator, without deleting existing draft text
- duplicate suppression: if the composer already ends with the exact canonical block after trimming at most one trailing newline, do not insert it again; only confirm
- fallback path: when no composer-insert API exists or the insertion attempt returns failure, print the exact guidance block so the user can manually send or reuse it
- the command SHALL NOT auto-send the inserted text on the user's behalf
- the command SHALL NOT mutate hidden session state

The canonical guidance block for Phase 1 SHALL be:

```text
Use `job` / `jobs` for the next stretch of work when isolated workers would help.

- The root agent stays responsible for planning, orchestration, and synthesis.
- Use `jobs` when work can be split into parallel leaf workers.
- Use `job` when exactly one isolated worker is enough.
- Give jobs clear names when helpful for attribution and audit.
- Do not try to create nested jobs from inside a job worker.
```

In insertion-supported mode, the command SHALL insert the canonical block into the composer and return only a short confirmation message.
If the insert API is unavailable or returns an error, the command SHALL fall back to printing the canonical block verbatim and return a fallback confirmation.

In fallback mode, the command SHALL render the canonical block verbatim in UI-local command output outside the model transcript, followed by a short note that the user can send or reuse it manually.

The command should behave like an explicit steering aid, not like a hidden mode switch.

## 7. Batch Audit Storage Model

### 7.1 Base Location

All audit artifacts SHALL live under project-local job storage resolved from the orchestrator root cwd for the batch.

For Phase 1, the storage root rule is:
- start from the root agent's cwd at the moment `job(...)` or `jobs(...)` is invoked
- resolve the audit root as `<rootCwd>/.pi/jobs/`
- do not relocate audit artifacts to per-job cwd overrides

```text
<rootCwd>/.pi/jobs/
```

### 7.2 Batch Directory Model

Each successfully initialized `job(...)` or `jobs(...)` execution SHALL create one unique batch directory.

The directory name SHOULD use a sortable timestamp plus a stable batch identifier, for example:

```text
.pi/jobs/2026-03-18T14-22-31Z-482731/
```

The exact batch identifier scheme does not need to match job ids, but the directory naming must remain stable, filesystem-safe, chronologically sortable, and unique within `<rootCwd>/.pi/jobs/`.

### 7.3 Required Files

Each batch directory SHALL contain at minimum:
- `batch.json`
- `events.jsonl`
- `jobs/<job-id>.json` for every job in the batch

These files have distinct responsibilities and are intentionally not merged into one large JSON document.

A directory is a discoverable batch only when all of the following are true:
- `batch.json` parses successfully and contains at least `schemaVersion`, `batchId`, `toolName`, and populated `jobIds`
- `events.jsonl` parses far enough to contain exactly one `batch_started` row for that `batchId`
- there is one `job_queued` row per `jobId`
- there is one `jobs/<job-id>.json` artifact per `jobId`, and each such artifact contains `queuedAt` plus a `queued` timeline entry

Directories that do not satisfy that predicate are pre-initialization leftovers and are ignored by default discovery and UI flows.

## 8. `batch.json` Contract

`batch.json` is the batch-level summary artifact.

It SHOULD be created immediately when a batch starts, then updated with terminal information when the batch finishes.

The file SHALL contain enough information to answer:
- when the batch started and finished
- whether it came from `job` or `jobs`
- which job ids were part of the batch
- what root cwd the orchestrator ran in
- what the final summary counts were
- whether the batch ended in `success`, `error`, or `aborted`

The contract for `batch.json` is normative for Phase 1.

```ts
type BatchTerminalStatus = "success" | "error" | "aborted";
type BatchRuntimeStatus = "initializing" | "running" | BatchTerminalStatus;

type BatchSummary = {
  total: number;
  success: number;
  error: number;
  aborted: number;
};

type BatchRecord = {
  schemaVersion: 1;
  batchId: string;
  toolName: "job" | "jobs";
  rootCwd: string;
  startedAt: string;
  finishedAt: string | null;
  status: BatchRuntimeStatus;
  initialized: boolean;
  jobIds: string[];
  summary: BatchSummary;
  auditIntegrity: "pending" | "ok" | "failed";
};
```

During `initializing`, `jobIds` MAY be an empty array. It SHALL be populated immediately after job id assignment and before any worker launches.

The canonical batch status mapping SHALL be:
- `success` when all jobs finish with `success`
- `error` when any job finishes with `error`
- `aborted` when no jobs finish with `error` and at least one job finishes with `aborted`

`status` is the canonical terminal batch status only for gracefully finalized batches.

For interrupted or incomplete batches, consumers SHALL treat the batch as non-terminal and use missing terminal records as evidence of interruption rather than trusting stale `batch.json.status`.

`auditIntegrity` is the source of truth for whether the required audit contract completed successfully. It is independent from job outcome status. Before graceful finalization completes, the field MAY remain `pending`.

A representative shape is:

```json
{
  "schemaVersion": 1,
  "batchId": "2026-03-18T14-22-31Z-482731",
  "toolName": "jobs",
  "rootCwd": "/Users/lucas/Developer/pi-tools",
  "startedAt": "2026-03-18T14:22:31.120Z",
  "finishedAt": "2026-03-18T14:22:52.884Z",
  "status": "error",
  "initialized": true,
  "jobIds": ["042731", "518204", "091553"],
  "summary": {
    "total": 3,
    "success": 2,
    "error": 1,
    "aborted": 0
  },
  "auditIntegrity": "ok"
}
```

`rootCwd` represents the orchestrator's cwd for the batch. Per-job `cwd` in each job artifact remains the authoritative execution cwd for that job.

The only strict guarantee for `summary` is the terminal one: when a batch is gracefully finalized and `auditIntegrity == "ok"`, `summary` is authoritative. Before that point, any live summary values are best-effort and non-authoritative.

## 9. `events.jsonl` Contract

`events.jsonl` is the append-only event stream for the batch.

It exists to preserve the execution timeline incrementally and to retain useful state even if the process terminates before all final summary files are cleanly rewritten.

### 9.1 Required Event Types

Phase 1 MUST support the following event schemas:
- `batch_started`
- `job_queued`
- `job_running`
- `job_finished`
- `batch_finished`

For every successfully initialized batch, the minimum durability guarantee is:
- exactly one `batch_started`
- one `job_queued` per job

For every gracefully finalized successfully initialized batch, the terminal event guarantee is:
- one `job_finished` per job
- exactly one `batch_finished`

`job_running` is emitted only for jobs whose worker actually launches.

### 9.2 Event Schema and Ordering

Each event row SHALL be one JSON object that conforms to one of the following shapes. Event rows inherit `schemaVersion: 1` from the enclosing batch directory:

```ts
type BaseEvent = {
  schemaVersion: 1;
  type: string;
  at: string;
  batchId: string;
  seq: number;
};

type BatchStartedEvent = BaseEvent & {
  type: "batch_started";
  toolName: "job" | "jobs";
  rootCwd: string;
};

type JobQueuedEvent = BaseEvent & {
  type: "job_queued";
  jobId: string;
};

type JobRunningEvent = BaseEvent & {
  type: "job_running";
  jobId: string;
};

type JobFinishedEvent = BaseEvent & {
  type: "job_finished";
  jobId: string;
  status: "success" | "error" | "aborted";
  error: string | null;
};

type BatchFinishedEvent = BaseEvent & {
  type: "batch_finished";
  status: "success" | "error" | "aborted";
  auditIntegrity: "ok" | "failed";
};
```

`seq` SHALL be a monotonically increasing integer within the batch.

Append order in `events.jsonl` is the source of truth for timeline reconstruction.

For a normal initialized batch, the minimum emitted lifecycle SHALL include:
- exactly one `batch_started` event before any job events
- one `job_queued` event for every job id in the batch
- one `job_finished` event for every job id in the batch
- exactly one `batch_finished` event after all job terminal events

### 9.3 Event Purpose

This file is optimized for machine scanning, not for human readability.

Its primary uses are:
- reconstructing the rough lifecycle timeline of a run
- debugging partial failures
- supporting later tooling that queries or replays job history

## 10. Per-Job JSON Contract

Each job SHALL write one machine-readable artifact to:

```text
.pi/jobs/<batch>/jobs/<job-id>.json
```

This is the authoritative job-level artifact.

### 10.1 Normative Schema

The contract for each job artifact is normative for Phase 1. Job artifacts inherit `schemaVersion: 1` from the enclosing batch directory.

```ts
type JobArtifactStatus = "queued" | "running" | "success" | "error" | "aborted";

type JobTimelineEntry = {
  at: string;
  state: JobArtifactStatus;
};

type JobToolCall = {
  at: string;
  tool: string;
  argsPreview: string;
  status: "completed" | "failed";
  error: string | null;
};

type JobArtifact = {
  schemaVersion: 1;
  batchId: string;
  id: string;
  name?: string;
  job: string;
  cwd: string;
  status: JobArtifactStatus;
  queuedAt: string;
  finishedAt: string | null;
  finalOutput: string | null;
  error: string | null;
  timeline: JobTimelineEntry[];
  toolCalls: JobToolCall[];
};
```

`job` stores the exact validated raw `job` argument provided to `job(...)` or `jobs(...)`. It does not include any worker wrapper text, appended system prompts, or runtime-generated prompt scaffolding.

In Phase 1, both `job` and `finalOutput` are persisted as local-sensitive unredacted text. They are not subject to the `argsPreview` redaction rules.

`cwd` stores the effective absolute working directory used for the worker after validation and resolution. When the caller omits a job-level override, `cwd` materializes as the batch `rootCwd`.

`queuedAt` is the time the job was first accepted into the batch queue. It is not the same as worker launch time. Actual worker launch is represented by the `running` entry in `timeline` when present.

Per-status rules are mandatory:
- when `status` is `queued` or `running`, `finishedAt` SHALL be `null`
- when `status` is `success`, `error` SHALL be `null`
- when `status` is `error`, `error` SHALL be a non-empty string
- when `status` is `aborted`, `error` MAY be `null` or a short abort reason
- when `status` is `success`, `error`, or `aborted`, `finishedAt` SHALL be non-null
- `finalOutput` MAY be `null` for non-success statuses
- when `status` is `success`, `finalOutput` SHALL contain the final user-visible worker text if any such text exists; otherwise `null` is allowed only for a true no-output success
- `timeline` SHALL contain at least one `queued` entry
- `timeline` SHALL contain exactly one terminal entry whose state matches the final job `status`
- `timeline` SHALL contain a `running` entry whenever the worker actually launched
- a post-initialization failure that occurs before worker launch MAY therefore produce `queued -> error` or `queued -> aborted` with no `running` entry
- `finalOutput` stores the exact final text returned by the worker before any root-agent synthesis; if the platform truncates that text, the stored value SHALL preserve the truncated text verbatim rather than re-summarizing it
- `toolCalls` MAY be empty when no worker tool calls were completed or failed before termination

### 10.2 Example Shape

```json
{
  "schemaVersion": 1,
  "batchId": "2026-03-18T14-22-31Z-482731",
  "id": "042731",
  "name": "find-schemas",
  "job": "Locate all schema files related to interview coach",
  "cwd": "/Users/lucas/Developer/pi-tools",
  "status": "success",
  "queuedAt": "2026-03-18T14:22:31.120Z",
  "finishedAt": "2026-03-18T14:22:52.884Z",
  "finalOutput": "Found 4 schema files ...",
  "error": null,
  "timeline": [
    { "at": "2026-03-18T14:22:31.120Z", "state": "queued" },
    { "at": "2026-03-18T14:22:31.482Z", "state": "running" },
    { "at": "2026-03-18T14:22:52.884Z", "state": "success" }
  ],
  "toolCalls": [
    {
      "at": "2026-03-18T14:22:34.010Z",
      "tool": "glob",
      "argsPreview": "{\"path\":\"/Users/lucas/Developer/pi-tools\",\"pattern\":\"**/*.ts\"}",
      "status": "completed",
      "error": null
    },
    {
      "at": "2026-03-18T14:22:36.221Z",
      "tool": "read",
      "argsPreview": "{\"limit\":200,\"offset\":1,\"path\":\"src/schema.ts\"}",
      "status": "completed",
      "error": null
    }
  ]
}
```

### 10.3 Optional Extension Metadata

The runtime MAY attach additional non-normative metadata when it is already available, for example:
- token or cost usage
- model identifier
- stop reason

These fields are explicitly outside the required Phase 1 contract.

## 11. Simplified Process Trace Rules

The simplified process trace is intentionally narrow.

The design goal is to answer “what did this job do?” without storing the full transcript or intermediate narrative text.

### 11.1 Timeline Rules

`timeline` SHALL record lifecycle transitions only.

At minimum, the implementation SHOULD record:
- queued time
- running time when the worker launches
- terminal state time

### 11.2 Tool Call Rules

`toolCalls` SHALL record simplified tool activity inside each per-job artifact.

Phase 1 tool-call capture applies only to tool calls made by spawned job workers. It SHALL NOT include internal root-orchestrator bookkeeping such as batch creation, audit file writes, or dashboard updates.

Each worker tool call surfaced through the current worker progress callback/telemetry path with an observed completion or observed failure SHALL produce one `toolCalls` entry. Retries therefore produce multiple entries when multiple tool calls actually occur. Tool calls that are not observable through that existing telemetry path, or in-flight invocations that are interrupted before an observed completion or failure callback, are omitted in Phase 1 rather than synthesized as terminal tool-call records. Omitted unobservable tool calls do not constitute audit failure.

Each entry SHALL include:
- timestamp
- tool name
- argument preview
- completion status
- error when the tool call failed

`argsPreview` SHALL follow this Phase 1 canonical algorithm:
- start from the original tool input value
- if the input is a freeform scalar string, do not persist it verbatim; instead emit the placeholder string `"[STRING_INPUT]"`
- otherwise serialize it deterministically as one single-line JSON value, using stable object-key sorting when objects are present
- recursively redact sensitive fields anywhere in the structured input value tree before persistence, including at least `authorization`, `token`, `apiKey`, `api_key`, `password`, `secret`, and `cookie` in any casing, preserving the key and replacing the value with the literal string `"[REDACTED]"`
- if serialization fails, fall back to the placeholder string `"[UNSERIALIZABLE_INPUT]"`
- if the preview exceeds 200 visible characters, truncate it to 197 visible characters and append `...`

The same preview generation SHALL be used for all per-job `toolCalls` entries.

### 11.3 Explicit Exclusions

Phase 1 SHALL NOT persist:
- full assistant intermediate prose
- full tool result bodies
- hidden reasoning traces
- full message transcripts unless a future phase explicitly introduces them

## 12. Execution and Audit Interaction

The execution layer and audit layer must cooperate without changing the normal success-path behavior of `job` and `jobs`.

All audit file writes SHALL be serialized by a single root-side audit writer or an equivalent locking mechanism controlled by the root orchestrator. Job workers SHALL NOT write audit files directly.

Durability rules for Phase 1 are:
- `batch.json` and `jobs/<job-id>.json` rewrites SHALL use atomic replace semantics such as temp-file-plus-rename
- `events.jsonl` writes SHALL append newline-terminated records and flush them before the corresponding state transition is considered durable
- readers MAY ignore at most one partial trailing JSONL line after an ungraceful interruption

### 12.1 Batch Lifecycle

When `job` or `jobs` is invoked, the runtime SHALL:
1. validate the entire input atomically
2. create the batch directory
3. write `batch.json` with `status: "initializing"` and `auditIntegrity: "pending"`
4. append the first `batch_started` row to `events.jsonl`
5. assign job ids using the existing numeric id mechanism, preserving original input order
6. create or update each `jobs/<job-id>.json` artifact with its queued state, preserving original input order
7. append one `job_queued` event per job, preserving original input order
8. rewrite `batch.json` with `initialized: true` and `status: "running"`
9. start job workers using the existing execution model
10. best-effort rewrite `jobs/<job-id>.json` to `status: "running"` with one matching `running` timeline entry immediately after each successful worker start
11. best-effort append one `job_running` event for that same launch
12. update per-job `toolCalls` inside `jobs/<job-id>.json` as worker tool calls are observed
13. durably rewrite terminal `jobs/<job-id>.json` first, then append `job_finished` for that job
14. gracefully finalize `batch.json`

This section uses two checkpoints:
- `batch skeleton created`: steps 2 through 4 have completed
- `successfully initialized batch`: steps 2 through 7 have completed, and the next `batch.json` rewrite sets `initialized: true`

The full Phase 1 audit guarantees apply to successfully initialized batches.

Immediately after successful batch initialization and before the first worker launch, the runtime SHALL rewrite `batch.json.status` from `initializing` to `running`.
If that rewrite fails, no worker launches and the runtime treats the situation as a fatal audit failure before execution starts.

A job is considered launched when worker start succeeds. The `running` job-artifact rewrite and `job_running` event are expected best-effort launch markers rather than hard launch gates. If their persistence fails, the worker may continue and the batch is classified as audit-degraded/incomplete; already-scheduled launches may proceed unchanged, but the orchestrator does not attempt any launches that have not yet been scheduled.

A job is considered durably settled only after the terminal `jobs/<job-id>.json` rewrite and the matching `job_finished` event both succeed. If only one of those writes succeeds, readers SHALL trust the job JSON file first and treat the batch as interrupted/incomplete.

Validation is all-or-nothing in Phase 1. Invalid input includes an empty job array, an empty or whitespace-only job prompt, or any other job item that fails tool validation. If any job item is invalid, the entire call is rejected before batch skeleton creation and no batch directory is created.

If failure occurs after batch skeleton creation but before successful batch initialization, the runtime SHALL attempt best-effort cleanup of any partial batch artifacts and return an explicit error.
If that cleanup itself fails and partial artifacts remain, those leftovers are treated as pre-initialization incomplete artifacts rather than valid batch records. When `batch.json` exists in that case, it SHALL remain at `status: "initializing"` and `auditIntegrity: "failed"`.

If failure occurs after successful batch initialization but before any worker launches, the runtime SHALL create terminal job records for the affected queued jobs using the Phase 1 status mapping rules, then derive the final batch status from those job terminal states. The outward tool result in that branch uses the normal `job(...)` / `jobs(...)` result shape derived from those synthetic terminal job statuses rather than a special audit-only payload.

### 12.2 Single Job Normalization

A single `job(...)` invocation SHALL still create one batch directory.

This keeps the storage model uniform and avoids special cases.

## 13. Failure and Abort Semantics

The audit system MUST preserve truthful terminal states.

### 13.1 Error Truthfulness

A failed job MUST remain a failed job in the audit artifacts.

The system MUST NOT collapse a failure into an empty output placeholder.

If a job ends with `status: "error"`, the job artifact MUST include a concrete `error` string.

The Phase 1 status mapping rules are:
- user cancellation before worker launch -> affected queued jobs `aborted`, batch `aborted` unless another job already reached `error`
- fatal audit failure before worker launch -> affected queued jobs `aborted`, batch `aborted`
- orchestrator or setup failure before worker launch after successful initialization -> affected queued jobs `error`, batch `error`
- user cancellation after worker launch, when no successful terminal worker result is observed -> affected running jobs `aborted`
- worker bootstrap or spawn failure -> affected job `error`, batch `error`
- worker runtime crash or explicit worker failure after launch -> affected job `error`, batch `error`
- never-started job after fatal audit failure -> `aborted`
- observed normal worker completion -> `success`

If any worker text has already been observed for a job before it reaches `error` or `aborted`, `finalOutput` SHALL preserve the latest fully assembled user-visible worker response snapshot accumulated by the orchestrator, verbatim. It SHALL never store raw streaming deltas. If no worker text was observed, `finalOutput` SHALL be `null`.

### 13.2 Abort Handling

If the user aborts an in-flight run:
- completed job artifacts SHOULD remain intact
- incomplete jobs SHALL terminate as `aborted`
- `events.jsonl` SHALL record terminal aborted events where possible
- `batch.json.status` SHALL follow the canonical precedence rules from Section 8

This means a user-aborted run with any job error still finalizes the batch as `error`, while a user-aborted run with no job errors finalizes as `aborted`.

### 13.3 Audit Degradation

If audit writing partially fails, the implementation SHOULD preserve as much execution work as possible but MUST surface that audit completeness degraded.

Loss of required audit artifacts defined in Section 7.3 is a fatal audit failure. The runtime SHALL surface that condition explicitly rather than silently downgrading it into a warning.

If a fatal audit failure occurs after successful batch initialization, the Phase 1 policy is:
- do not attempt launches that have not yet started
- best-effort settle whatever is already in flight
- finalize never-started jobs as `aborted`
- preserve existing artifacts
- keep the normal outward `job(...)` / `jobs(...)` success-or-failure contract derived from worker outcomes rather than introducing a new payload shape
- rewrite final `batch.json` before attempting `batch_finished`
- append `batch_finished` as the last durable finalize marker only when the preceding finalize steps succeed
- otherwise leave the batch interrupted/incomplete and treat `events.jsonl` as the fallback timeline truth

Post-initialization audit degradation is therefore visible through on-disk artifacts, `/jobs-ui` classification, and a logged warning string, not through a new outward result schema. Only pre-execution audit initialization failure returns an immediate explicit tool error.

A complete inability to initialize required audit storage SHOULD fail the job batch early and explicitly rather than silently disabling auditing.

If initialization fails before the batch skeleton can be created, the runtime may return a direct error with no audit artifacts. Phase 1 does not require rejected or pre-initialization failures to create synthetic batch records.

A successfully initialized batch is gracefully finalized only when this sequence completes in order:
1. terminal job records are written
2. the final `batch.json` rewrite succeeds
3. `batch_finished` is appended as the last durable finalize marker

If the last step fails after the final `batch.json` rewrite, the batch is still treated as interrupted/incomplete because the final durable marker is missing. In that state, `batch.json.status` SHALL remain at the terminal value derived from job outcomes and `batch.json.auditIntegrity` SHALL be `failed`.

If the process dies ungracefully after successful initialization, Phase 1 leaves the batch as interrupted rather than recovering it automatically. Consumers SHALL treat missing terminal events, a missing `batch_finished`, or a lingering `batch.json.status: "running"` as evidence of an incomplete interrupted batch.

### 13.4 Outward Result Compatibility

Phase 1 preserves the current outward result schema of `job(...)` and `jobs(...)`.

Synthetic terminal outcomes introduced by audit-related branches MUST map into that existing outward schema exactly the same way as ordinary job terminal states:
- `success` stays `success`
- `error` stays `error`
- `aborted` stays `aborted`

Batch auditing does not introduce a new outward result shape.

## 14. Implementation Notes

This section is non-normative guidance rather than part of the behavioral contract.

The current `extensions/jobs/index.ts` file is already large.

Phase 1 would likely be easier to implement and maintain if the new concerns are separated into focused internal modules.

A recommended structure is:
- `commands.ts` for `/jobs-start` and `/jobs-ui`
- `run-jobs.ts` for orchestration and worker execution
- `audit-log.ts` for batch and job artifact persistence
- `job-ui.ts` for dashboard rendering and interaction

The exact filenames are flexible, but the responsibility split is useful. Audit persistence should not remain tangled with UI rendering and worker execution.

## 15. Testing Strategy

Phase 1 should emphasize behavior and artifact correctness rather than cosmetic UI checks.

At minimum, the implementation SHOULD verify:
- `job(...)` creates one batch directory with all required files
- `jobs(...)` creates one batch directory containing one per-job artifact for each input job
- job artifacts preserve job prompt, final output, status, and simplified process traces
- errors remain explicit in job artifacts
- abort behavior produces truthful `aborted` terminal records
- `/jobs-start` inserts guidance but does not create batch artifacts or hidden execution state

Where end-to-end worker execution is difficult to test deterministically, the audit-writing layer SHOULD also be tested in isolation as a pure file-output subsystem.

## 16. Future Compatibility

This design intentionally prepares for a second phase that may introduce ordered or dependency-aware job orchestration.

The key compatibility decision is that Phase 1 already introduces the batch as a first-class storage boundary.

A future ordered execution model can build on top of:
- batch metadata
- per-job artifacts
- event streams

without requiring a redesign of the Phase 1 audit format.

## 17. Acceptance Criteria

The design is satisfied when all of the following are true:
- `/jobs-start` exists as a user command and only inserts visible job-oriented guidance
- `/jobs-start` uses the canonical guidance block from Section 6, either by inserting it into the current composer/input box or by printing the exact block for manual use, and never auto-sends it
- insertion mode is non-destructive: it visibly inserts into the active composer/input box without deleting existing draft text
- `/jobs-start` explicitly confirms whether guidance was inserted or printed for manual use
- `/jobs-start` fallback output is rendered outside the model transcript
- repeated `/jobs-start` does not append a second copy when the composer already ends with the exact canonical block
- `/jobs-start` does not change tool permissions or hidden session state beyond the visible inserted or printed guidance
- if composer insertion is unavailable or fails, `/jobs-start` falls back to printing the canonical guidance block verbatim
- the audit root resolves to `<rootCwd>/.pi/jobs/`, where `rootCwd` is the root agent cwd at invocation time
- every successfully initialized `job(...)` call creates one unique batch directory under the resolved audit root
- every successfully initialized `jobs(...)` call creates one unique batch directory under the resolved audit root
- a successfully initialized batch is defined as one that has completed batch directory creation, initial `batch.json`, job id assignment, queued job artifact creation, one `job_queued` event per job, and a `batch.json` rewrite that sets `initialized: true`
- once a batch is successfully initialized, `batch.json`, `events.jsonl`, and one `jobs/<job-id>.json` file per job already exist before any worker launches
- `batch.json` includes `schemaVersion: 1` and `initialized`, each event row includes `schemaVersion: 1`, and each job artifact includes both `schemaVersion: 1` and `batchId`
- job id assignment, `batch.json.jobIds`, queued job artifact creation, and `job_queued` emission all preserve original input order
- after successful batch initialization and before the first worker launch, `batch.json.status` transitions to `running`
- `batch.json.auditIntegrity` is `pending` until graceful finalization succeeds or a fatal audit failure is observed
- job ids and batch ids are serialized as strings exactly as issued by the runtime, preserving existing zero-padding for numeric job ids
- `batch.json.summary` is authoritative only for gracefully finalized batches with `auditIntegrity == "ok"`; any pre-final live values are best-effort only
- validation is atomic across the full input array, and any invalid job item including an empty job array or empty/whitespace-only job prompt rejects the entire call before batch skeleton creation
- audit-storage initialization failure returns an explicit error rather than silently disabling auditing
- any failure after batch skeleton creation but before successful batch initialization attempts best-effort cleanup, returns an explicit error, and leaves any cleanup leftovers clearly marked as pre-initialization incomplete artifacts rather than valid batch records
- discovery/UI treats only directories whose `batch.json` parses and sets `initialized: true` as valid batches by default
- fatal audit failure before worker launch maps affected queued jobs to `aborted`
- post-initialization audit failure before any worker launch still returns the normal outward result shape, derived from those synthetic terminal job statuses
- orchestrator or setup failure before worker launch after successful initialization maps affected queued jobs to `error`
- any fatal audit failure after successful batch initialization does not attempt launches that have not yet started, best-effort settles in-flight work, finalizes never-started jobs as `aborted`, and remains visible through on-disk artifacts, `/jobs-ui` classification, and a logged warning string without introducing a new outward result shape
- every job in a successfully initialized batch writes one machine-readable job artifact and that artifact is finalized as soon as the job reaches a terminal state
- each job artifact stores the raw validated job prompt, effective absolute worker `cwd`, final output, lifecycle timeline, and simplified tool-call trace
- raw `job` and `finalOutput` are persisted as local-sensitive unredacted text in Phase 1
- when a job ends as `success`, `finalOutput` is present whenever any user-visible worker text exists; `success` + `null` is reserved for true no-output success
- when a job ends as `error` or `aborted`, any already-observed worker text is preserved in `finalOutput` as the latest fully assembled user-visible worker response snapshot rather than as raw stream deltas
- `queuedAt` records queue acceptance time, while actual launch remains visible through `timeline`
- every finalized job artifact contains exactly one terminal `timeline` entry whose state matches the final job `status`
- a job that never launches may still finalize from `queued` directly to `error` or `aborted`
- batch-level files provide summary and append-only event history with a defined event schema
- `batch.json` and `jobs/<job-id>.json` use atomic replace semantics
- `events.jsonl` uses monotonically increasing `seq` values within the batch
- `events.jsonl` is append-only, newline-terminated per durable record, and readers may ignore one partial trailing line after interruption
- `argsPreview` uses the same canonical single-line preview generation in per-job `toolCalls`, with `"[STRING_INPUT]"` placeholders for freeform strings and recursive `"[REDACTED]"` replacement for sensitive structured fields
- only tool calls observable through existing worker telemetry are recorded; unobservable calls may be omitted without constituting audit failure
- every successfully initialized batch emits `batch_started` and one `job_queued` per job
- every successfully started job attempts to record `status: "running"`, one matching `running` timeline entry, and one `job_running` event; if that persistence fails, the worker may continue but the batch is classified as audit-degraded/incomplete and no further workers are launched
- every gracefully finalized successfully initialized batch rewrites terminal `jobs/<job-id>.json` first, then appends one `job_finished` per job, then appends `batch_finished`; interrupted batches may be missing some terminal records
- when terminal job JSON and `job_finished` disagree after interruption, readers trust the job JSON file first and classify the batch as incomplete
- when `batch.json.auditIntegrity == "ok"`, `batch.json.summary.total == batch.json.jobIds.length == number of terminal job artifacts`
- when `batch.json.auditIntegrity == "ok"`, `batch.json` summary counts match the terminal states recorded in both `events.jsonl` and `jobs/<job-id>.json`
- gracefully finalized batches write terminal job records first, then final `batch.json`, then `batch_finished` as the last durable marker
- `batch.json.status` matches the terminal batch status recorded by `batch_finished` whenever the batch is gracefully finalized
- `batch.json.auditIntegrity` matches the audit-integrity value recorded by `batch_finished` whenever the batch is gracefully finalized
- if the process dies ungracefully after successful initialization, missing terminal events, a missing `batch_finished`, or a lingering `batch.json.status: "running"` mark the batch as interrupted/incomplete rather than silently repaired
- batch discovery/UI shows only successfully initialized batches by default, classifies missing-finalization batches as `incomplete`, and hides pre-initialization leftovers
- if final `batch.json` is written but `batch_finished` is missing, consumers classify the batch as interrupted/incomplete, with `batch.json.status` left at the derived terminal state and `batch.json.auditIntegrity` set to `failed`
- pre-initialization incomplete artifact directories are ignored by default batch discovery and UI flows
- batch status is derived deterministically as `success`, `error`, or `aborted`
- normal outward `job(...)` and `jobs(...)` success/error payloads remain wire-compatible with current behavior
- root-only orchestration semantics remain unchanged in Phase 1
- job workers still cannot create nested `job(...)` or `jobs(...)` runs in Phase 1
- job failures remain explicit and are not represented as empty output
- aborts are represented as `aborted`
- numeric job ids remain unchanged in Phase 1
- no dependency graph or hidden jobs mode is introduced in Phase 1

## 18. Deferred to Phase 2

The following ideas are explicitly deferred:
- mnemonic word-based ids for batches or jobs
- explicit sequential or dependency-aware orchestration
- graph-shaped job planning or execution
- deeper plan-mode integration
- richer transcript capture beyond simplified traces
- job replay tooling built on top of the new artifacts

These may be explored later, but they are not required to deliver the approved Phase 1 design.
