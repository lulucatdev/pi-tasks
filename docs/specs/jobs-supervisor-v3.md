# Jobs Supervisor V3 Specification

Status: implementation spec
Date: 2026-04-26
Scope: `extensions/jobs`

## Decision

`job` and `jobs` are no longer thin wrappers around worker output files. They are a root-supervised job agent runtime.

The root process is the supervisor. Each job reaches `success` only when all blocking gates pass:

1. runtime outcome is successful;
2. worker submits a valid `job-report.json` or `job_report` payload;
3. worker report status is `completed`;
4. acceptance checks pass or are explicitly skipped/warning-only;
5. batch audit artifacts finalize with `auditIntegrity: "ok"`.

Legacy `JOB_STATUS` markers are only warning signals for old logs. They are not a completion protocol.

## Complexity Boundaries

The implementation is intentionally layered so runtime facts do not get confused with policy or UI:

```text
tools/      job.ts / jobs.ts / jobs-plan.ts input validation and expansion
core/       supervisor.ts scheduling, concurrency, attempt lifecycle, retry loop
runner/     worker-runner.ts child process ownership and stdout/stderr artifacts
protocol/   worker-protocol.ts and job-report-tool.ts structured report contract
audit/      worker-events.ts + write-evidence.ts normalized tool/git write facts
acceptance/ acceptance.ts contract evaluation over report, filesystem, write evidence
decision/   decision.ts deriveFinalOutcome(runtime, report, acceptance, audit)
view/       job-view.ts derived job/batch views for UI and summary
ui/         job-ui.ts artifact reader and rerun payload builder
```

The important invariant is: **facts are gathered once; status, failure kind, retryability, summary counts, and UI icons are derived from those facts.** Existing artifact JSON still stores compatibility fields such as `finalStatus` and `failureKind`, but UI/summary code should use `job-view.ts` materialization rather than trusting those fields blindly.

## Storage Layout

Every run creates one batch directory:

```text
.pi/jobs/<batchId>/
  batch.json
  events.jsonl
  summary.md
  plan.json                  # only present when jobs_plan was used
  jobs/
    <jobId>.json
  attempts/
    <jobId>/
      attempt-1/
        session.jsonl
        system-prompt.md
        worker-prompt.md
        worker.md
        job-report.json
        stdout.jsonl
        stderr.txt
        worker-events.jsonl
        attempt.json
```

`batchId` is sortable timestamp plus random suffix. `jobId` is batch-local and sanitized.

Security note: `.pi/jobs/**` is an audit store, not a sanitized export. It may contain prompts, child `session.jsonl` transcripts, stdout/stderr, absolute paths, report evidence, and other private context. Users should review/redact before sharing the directory.

## Worker Completion Protocol

A worker receives exact paths for:

- `worker.md` — human-readable log;
- `job-report.json` — machine-readable completion report.

The preferred completion path is the child-only `job_report` tool, which writes the same structured report to the supervised report path. The file protocol remains the fallback.

Required report shape:

```ts
type JobReport = {
  schemaVersion: 1;
  jobId: string;
  attemptId: string;
  status: "completed" | "partial" | "blocked" | "error";
  summary: string;
  deliverables: Array<{ path: string; kind: "file" | "dir" | "note" | "command"; description?: string }>;
  evidence: Array<{ kind: "file" | "command" | "text"; value: string }>;
  internalRetries?: Array<{ reason: string; action: string; outcome: "recovered" | "failed" }>;
  userActionRequired?: string | null;
  error?: string | null;
};
```

The worker prompt must state clearly that ending without `job_report`/`job-report.json` fails the job, even if file edits succeeded. Thinking-only final turns are `worker_incomplete` and are parent-retryable.

## API

```ts
type JobSpecInput = {
  id?: string;
  name: string;
  prompt: string;
  cwd?: string;
  acceptance?: AcceptanceContract;
  metadata?: Record<string, string>;
};

type JobsToolParams = {
  jobs: JobSpecInput[];                  // ≤ MAX_INLINE_JOBS=4 inline jobs
  concurrency?: number;
  retry?: ParentRetryPolicy;
  throttle?: ThrottlePolicy;
  acceptanceDefaults?: AcceptanceContract;
  parentBatchId?: string;
  rerunOfJobIds?: string[];
};

type JobsPlanRow = {
  id: string;
  name?: string;
  cwd?: string;
  vars?: Record<string, string | string[]>;
};

type JobsPlanInput = {
  batchName: string;
  concurrency?: number;
  matrix: JobsPlanRow[];
  promptTemplate: string;
  nameTemplate?: string;
  cwdTemplate?: string;
  acceptanceTemplate?: AcceptanceContract;
  metadataTemplate?: Record<string, string>;
  retry?: ParentRetryPolicy;
  throttle?: ThrottlePolicy;
  acceptanceDefaults?: AcceptanceContract;
  synthesis?: { mode?: "parent" | "report-only"; instructions?: string }; // experimental metadata only
  parentBatchId?: string;
  rerunOfJobIds?: string[];
};
```

`job` is a single-job convenience wrapper over `jobs`.

`jobs` is the small-batch escape hatch (≤ `MAX_INLINE_JOBS=4` jobs, ≤ `MAX_INLINE_PROMPT_BYTES=8000` prompt bytes). Oversized inline payloads fail fast with a message pointing to `jobs_plan`.

`jobs_plan` is the primary fan-out transport. The extension validates the input, expands the matrix locally into N full `JobSpecInput`s, and calls `executeSupervisedJobs` with the same artifact/audit/acceptance/retry/throttle behavior as `jobs`. It additionally writes `plan.json` next to `batch.json`.

Concurrency is caller-controlled. If `concurrency` is omitted, there is no hidden supervisor cap: the scheduler starts all supplied leaf jobs concurrently (`jobs.length` or `matrix.length`). `concurrency: N` is an explicit local cap only. Dynamic throttling is opt-in (`throttle.enabled: true`); without it, the supervisor does not auto-reduce concurrency after failures. Root agents should split large jobs into multiple `jobs_plan` waves when they want phased execution or manual provider load control.

## `jobs_plan`

### Why it exists

Inline `jobs({ jobs: [...] })` requires the model to stream the entire batch as one tool-call argument. With many long per-job prompts, that argument can be tens of KB and the model/provider can be `terminated` mid-stream. When that happens, `execute()` is never called: there is no `JOBS starting`, no `.pi/jobs/<batchId>`, no heartbeat, and no logs. `jobs_plan` keeps the streamed argument tiny (one shared `promptTemplate` + N short `matrix` rows) so the supervisor reaches `execute()` quickly and produces visible artifacts.

### Frozen DSL rules

`jobs_plan` is deliberately frozen as **compact input transport**, not a workflow engine.

- Allowed top-level keys are exactly the `JobsPlanInput` fields above. Unknown keys fail validation.
- Matrix rows are exactly `id`, `name`, `cwd`, and `vars`. Unknown row keys fail validation.
- No conditionals, loops, dependency graphs, nested jobs, or workflow steps are supported.
- `synthesis` is experimental metadata for the parent agent's post-batch summary; it is not executable logic.
- `{{key}}` lookups resolve from row `id`, `name`, `cwd`, and `vars`.
- In a string field, an array value joins with `\n`.
- In an array string field (e.g. `acceptanceTemplate.allowedWritePaths`), an entry that is exactly `{{key}}` and whose row value is an array splats into multiple list entries.
- `requiredPaths` accepts both bare strings and `PathCheck` objects; `path`, `requiredRegex`, and `forbiddenRegex` are all template-substituted.
- Unknown variables raise an error before any worker spawns.
- Hard limits: `MAX_PLAN_ROWS=100`, `MAX_PLAN_PROMPT_TEMPLATE_BYTES=32000`, `MAX_PLAN_TOTAL_INPUT_BYTES=64000`.

## Write Evidence and Acceptance

Acceptance can require files, forbid paths, check worker-log/report regexes, validate minimum sizes, and audit changed files against allowed/forbidden write paths.

Write auditing uses a normalized evidence layer:

```ts
type WriteEvidence = {
  path: string;
  source: "git_diff" | "worker_telemetry";
  jobId?: string;
  attemptId?: string;
  confidence: "high" | "medium" | "low";
  ignored?: boolean;
  reason?: string;
};
```

Rules:

- Git diff and worker telemetry are converted to `WriteEvidence[]` before acceptance checks.
- `.pi/jobs/**` supervisor protocol artifacts (`worker.md`, `job-report.json`, `attempt.json`, etc.) are ignored by write-boundary checks.
- `allowedWritePaths` path semantics are explicit: exact path matches exactly, trailing slash means directory prefix, `*`/`**` are globs.
- Each job's git diff is filtered to that job's allowed zone before attribution, so disjoint write-boundary jobs can run in parallel.
- Worker telemetry is attributed to the emitting job and catches out-of-zone writes even when git diff attribution is ambiguous.

**Do not** add `JOB_STATUS: completed` as an acceptance requirement. **Do not** list `job-report.json` or `worker.md` in `requiredPaths`. Prefer `requireDeliverablesEvidence: true` and `minReportSummaryChars` for completion proof.

Acceptance failure is not parent-retryable by default. It means the worker ran and produced a report, but delivered artifacts did not satisfy the parent-side contract.

## Final Outcome and Retry Boundary

`decision.ts` derives a structured outcome:

```ts
type FinalOutcome = {
  finalStatus: "success" | "error" | "aborted";
  blockingGate: "none" | "runtime" | "protocol" | "acceptance" | "audit";
  failureKind: FailureKind;
  retryDecision: RetryDecision;
};
```

Worker agents should handle recoverable work-level errors themselves and record those in `internalRetries`.

The parent supervisor retries only launch/session/provider/worker-incomplete failures that did not produce a valid worker report:

- `launch_error`
- `provider_transient`
- `provider_stalled`
- `worker_stalled`
- `worker_incomplete`

Examples: spawn failure, `429`, `5xx`, `overloaded`, `Internal server error`, `terminated`, connection reset, timeout, thinking-only stop, missing report.

The parent does not retry by default for:

- `acceptance_failed`
- `protocol_error` after a valid worker turn or malformed report
- `blocked`
- user abort
- permission/auth/model errors

## Runtime Event Handling

`terminal-state.ts` owns assistant terminal/recovery interpretation:

- visible assistant text with non-tool `stopReason` is terminal completion;
- `stopReason="stop"` with thinking-only content is `thinking_only_stop` / `worker_incomplete`;
- `stopReason="error"` does not schedule the normal terminal exit guard, because Codex CLI may internally recover;
- recovery events such as `auto_retry_start`, `agent_start`, `turn_start`, `message_start`, and `tool_execution_start` cancel stale terminal guards and clear stale error state.

`worker-runner.ts` owns process lifecycle, stdout/stderr artifacts, and timer actions. It should not grow more terminal classification rules inline.

## Worker Child Sessions

Each attempt launches a full child Pi process, not an in-process pseudo-worker:

```text
pi --mode json -p --session <attemptDir>/session.jsonl --no-extensions --extension job-worker-runtime.ts @<attemptDir>/worker-prompt.md
```

The child owns its own `AgentSession`, session file, provider retry, and Pi auto-compaction boundary. Root-session compaction does not mutate child context; the parent supervises the child by parsing stdout JSONL events and reading artifacts.

`job-worker-runtime.ts` is intentionally tiny: it registers only the `job_report` tool. It does not register `job`, `jobs`, or `jobs_plan`, so children cannot recursively spawn more supervised workers through this runtime. The parent still passes `PI_JOB_ID`, `PI_JOB_ATTEMPT_ID`, `PI_JOB_REPORT_PATH`, and `PI_JOB_EVENTS_PATH` so the child can submit its structured report and telemetry.

`worker-runner.ts` remains responsible for stdout/stderr artifacts, `worker-events.jsonl` telemetry extraction, terminal-state interpretation, post-exit drain/kill timers, and process aborts. Worker prompts still instruct agents to avoid huge dumps and use targeted reads, grep/search, offsets, and durable artifact notes instead of repeatedly loading huge files into context.

## UI and Rerun

`/jobs-ui` reads batch artifacts, not session-only state. It presents:

- batch list;
- batch detail;
- job detail;
- attempt detail;
- retry and acceptance failure summary.

Supported artifact navigation commands:

```text
/jobs-ui
/jobs-ui help
/jobs-ui <batchId|batchDir>
/jobs-ui <batchId|batchDir> job <jobId>
/jobs-ui <batchId|batchDir> attempt <jobId> <attemptId|latest>
/jobs-ui rerun failed <batchId|batchDir>
/jobs-ui rerun acceptance-failed <batchId|batchDir>
/jobs-ui rerun provider-transient <batchId|batchDir>
/jobs-ui rerun selected <batchId|batchDir> <jobId> [jobId...]
```

Rerun payloads are constructed from artifacts and preserve `parentBatchId` / `rerunOfJobIds`.

Live tool updates emit compact batch progress plus recent per-job thinking/tool activity derived from worker `stdout.jsonl` events. Summary/UI counts are materialized through `job-view.ts` so stale compatibility fields do not leak into live display during retries.

## Do Not Add More Here Yet

Before adding new features, stabilize these boundaries:

- no more acceptance check types until `WriteEvidence[]` stays quiet in real batches;
- no `jobs_plan` workflow language features;
- no additional completion protocols until `job_report` + file fallback are fully unified as one `ReportOutcome`;
- no richer UI state unless it is derived from artifacts/events, not maintained separately.
