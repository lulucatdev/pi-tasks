# Tasks Supervisor V3 Specification

Status: implementation spec
Date: 2026-04-26
Scope: `extensions/task`

## Decision

`task` and `tasks` are no longer thin wrappers around worker output files. They are a root-supervised task agent runtime.

The root process is the supervisor. Each task reaches `success` only when all blocking gates pass:

1. runtime outcome is successful;
2. worker submits a valid `task-report.json` or `task_report` payload;
3. worker report status is `completed`;
4. acceptance checks pass or are explicitly skipped/warning-only;
5. batch audit artifacts finalize with `auditIntegrity: "ok"`.

Legacy `TASK_STATUS` markers are only warning signals for old logs. They are not a completion protocol.

## Complexity Boundaries

The implementation is intentionally layered so runtime facts do not get confused with policy or UI:

```text
tools/      task.ts / tasks.ts / tasks-plan.ts input validation and expansion
core/       supervisor.ts scheduling, concurrency, attempt lifecycle, retry loop
runner/     worker-runner.ts child process ownership and stdout/stderr artifacts
protocol/   worker-protocol.ts and task-report-tool.ts structured report contract
audit/      worker-events.ts + write-evidence.ts normalized tool/git write facts
acceptance/ acceptance.ts contract evaluation over report, filesystem, write evidence
decision/   decision.ts deriveFinalOutcome(runtime, report, acceptance, audit)
view/       task-view.ts derived task/batch views for UI and summary
ui/         task-ui.ts artifact reader and rerun payload builder
```

The important invariant is: **facts are gathered once; status, failure kind, retryability, summary counts, and UI icons are derived from those facts.** Existing artifact JSON still stores compatibility fields such as `finalStatus` and `failureKind`, but UI/summary code should use `task-view.ts` materialization rather than trusting those fields blindly.

## Storage Layout

Every run creates one batch directory:

```text
.pi/tasks/<batchId>/
  batch.json
  events.jsonl
  summary.md
  plan.json                  # only present when tasks_plan was used
  tasks/
    <taskId>.json
  attempts/
    <taskId>/
      attempt-1/
        session.jsonl
        system-prompt.md
        worker-prompt.md
        worker.md
        task-report.json
        stdout.jsonl
        stderr.txt
        worker-events.jsonl
        attempt.json
```

`batchId` is sortable timestamp plus random suffix. `taskId` is batch-local and sanitized.

Security note: `.pi/tasks/**` is an audit store, not a sanitized export. It may contain prompts, child `session.jsonl` transcripts, stdout/stderr, absolute paths, report evidence, and other private context. Users should review/redact before sharing the directory.

## Worker Completion Protocol

A worker receives exact paths for:

- `worker.md` — human-readable log;
- `task-report.json` — machine-readable completion report.

The preferred completion path is the child-only `task_report` tool, which writes the same structured report to the supervised report path. The file protocol remains the fallback.

Required report shape:

```ts
type TaskReport = {
  schemaVersion: 1;
  taskId: string;
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

The worker prompt must state clearly that ending without `task_report`/`task-report.json` fails the task, even if file edits succeeded. Thinking-only final turns are `worker_incomplete` and are parent-retryable.

## API

```ts
type TaskSpecInput = {
  id?: string;
  name: string;
  prompt: string;
  cwd?: string;
  acceptance?: AcceptanceContract;
  metadata?: Record<string, string>;
};

type TasksToolParams = {
  tasks: TaskSpecInput[];                  // ≤ MAX_INLINE_TASKS=4 inline tasks
  concurrency?: number;
  retry?: ParentRetryPolicy;
  throttle?: ThrottlePolicy;
  acceptanceDefaults?: AcceptanceContract;
  parentBatchId?: string;
  rerunOfTaskIds?: string[];
};

type TasksPlanRow = {
  id: string;
  name?: string;
  cwd?: string;
  vars?: Record<string, string | string[]>;
};

type TasksPlanInput = {
  batchName: string;
  concurrency?: number;
  matrix: TasksPlanRow[];
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
  rerunOfTaskIds?: string[];
};
```

`task` is a single-task convenience wrapper over `tasks`.

`tasks` is the small-batch escape hatch (≤ `MAX_INLINE_TASKS=4` tasks, ≤ `MAX_INLINE_PROMPT_BYTES=8000` prompt bytes). Oversized inline payloads fail fast with a message pointing to `tasks_plan`.

`tasks_plan` is the primary fan-out transport. The extension validates the input, expands the matrix locally into N full `TaskSpecInput`s, and calls `executeSupervisedTasks` with the same artifact/audit/acceptance/retry/throttle behavior as `tasks`. It additionally writes `plan.json` next to `batch.json`.

Concurrency is caller-controlled. If `concurrency` is omitted, there is no hidden supervisor cap: the scheduler starts all supplied leaf tasks concurrently (`tasks.length` or `matrix.length`). `concurrency: N` is an explicit local cap only. Dynamic throttling is opt-in (`throttle.enabled: true`); without it, the supervisor does not auto-reduce concurrency after failures. Root agents should split large jobs into multiple `tasks_plan` waves when they want phased execution or manual provider load control.

## `tasks_plan`

### Why it exists

Inline `tasks({ tasks: [...] })` requires the model to stream the entire batch as one tool-call argument. With many long per-task prompts, that argument can be tens of KB and the model/provider can be `terminated` mid-stream. When that happens, `execute()` is never called: there is no `TASKS starting`, no `.pi/tasks/<batchId>`, no heartbeat, and no logs. `tasks_plan` keeps the streamed argument tiny (one shared `promptTemplate` + N short `matrix` rows) so the supervisor reaches `execute()` quickly and produces visible artifacts.

### Frozen DSL rules

`tasks_plan` is deliberately frozen as **compact input transport**, not a workflow engine.

- Allowed top-level keys are exactly the `TasksPlanInput` fields above. Unknown keys fail validation.
- Matrix rows are exactly `id`, `name`, `cwd`, and `vars`. Unknown row keys fail validation.
- No conditionals, loops, dependency graphs, nested tasks, or workflow steps are supported.
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
  taskId?: string;
  attemptId?: string;
  confidence: "high" | "medium" | "low";
  ignored?: boolean;
  reason?: string;
};
```

Rules:

- Git diff and worker telemetry are converted to `WriteEvidence[]` before acceptance checks.
- `.pi/tasks/**` supervisor protocol artifacts (`worker.md`, `task-report.json`, `attempt.json`, etc.) are ignored by write-boundary checks.
- `allowedWritePaths` path semantics are explicit: exact path matches exactly, trailing slash means directory prefix, `*`/`**` are globs.
- Each task's git diff is filtered to that task's allowed zone before attribution, so disjoint write-boundary tasks can run in parallel.
- Worker telemetry is attributed to the emitting task and catches out-of-zone writes even when git diff attribution is ambiguous.

**Do not** add `TASK_STATUS: completed` as an acceptance requirement. **Do not** list `task-report.json` or `worker.md` in `requiredPaths`. Prefer `requireDeliverablesEvidence: true` and `minReportSummaryChars` for completion proof.

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
pi --mode json -p --session <attemptDir>/session.jsonl --no-extensions --extension task-worker-runtime.ts @<attemptDir>/worker-prompt.md
```

The child owns its own `AgentSession`, session file, provider retry, and Pi auto-compaction boundary. Root-session compaction does not mutate child context; the parent supervises the child by parsing stdout JSONL events and reading artifacts.

`task-worker-runtime.ts` is intentionally tiny: it registers only the `task_report` tool. It does not register `task`, `tasks`, or `tasks_plan`, so children cannot recursively spawn more supervised workers through this runtime. The parent still passes `PI_TASK_ID`, `PI_TASK_ATTEMPT_ID`, `PI_TASK_REPORT_PATH`, and `PI_TASK_EVENTS_PATH` so the child can submit its structured report and telemetry.

`worker-runner.ts` remains responsible for stdout/stderr artifacts, `worker-events.jsonl` telemetry extraction, terminal-state interpretation, post-exit drain/kill timers, and process aborts. Worker prompts still instruct agents to avoid huge dumps and use targeted reads, grep/search, offsets, and durable artifact notes instead of repeatedly loading huge files into context.

## UI and Rerun

`/tasks-ui` reads batch artifacts, not session-only state. It presents:

- batch list;
- batch detail;
- task detail;
- attempt detail;
- retry and acceptance failure summary.

Supported artifact navigation commands:

```text
/tasks-ui
/tasks-ui help
/tasks-ui <batchId|batchDir>
/tasks-ui <batchId|batchDir> task <taskId>
/tasks-ui <batchId|batchDir> attempt <taskId> <attemptId|latest>
/tasks-ui rerun failed <batchId|batchDir>
/tasks-ui rerun acceptance-failed <batchId|batchDir>
/tasks-ui rerun provider-transient <batchId|batchDir>
/tasks-ui rerun selected <batchId|batchDir> <taskId> [taskId...]
```

Rerun payloads are constructed from artifacts and preserve `parentBatchId` / `rerunOfTaskIds`.

Live tool updates emit compact batch progress plus recent per-task thinking/tool activity derived from worker `stdout.jsonl` events. Summary/UI counts are materialized through `task-view.ts` so stale compatibility fields do not leak into live display during retries.

## Do Not Add More Here Yet

Before adding new features, stabilize these boundaries:

- no more acceptance check types until `WriteEvidence[]` stays quiet in real batches;
- no `tasks_plan` workflow language features;
- no additional completion protocols until `task_report` + file fallback are fully unified as one `ReportOutcome`;
- no richer UI state unless it is derived from artifacts/events, not maintained separately.
