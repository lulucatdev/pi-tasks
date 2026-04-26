# Tasks Supervisor V3 Specification

Status: implementation spec
Date: 2026-04-26
Scope: `extensions/task`

## Decision

`task` and `tasks` are no longer a thin wrapper around worker output files. They are a root-supervised task agent runtime.

The root process is the supervisor. Each task is a task agent attempt. A task reaches `success` only when all of these pass:

1. runtime outcome is successful;
2. worker submits a valid `task-report.json` or future `task_report` payload;
3. worker report status is `completed`;
4. acceptance checks pass or are explicitly skipped/warning-only;
5. batch audit artifacts finalize with `auditIntegrity: "ok"`.

Legacy `TASK_STATUS` markers are only warning signals for old logs. They are not a completion protocol.

## Storage Layout

Every run creates one batch directory:

```text
.pi/tasks/<batchId>/
  batch.json
  events.jsonl
  summary.md
  tasks/
    <taskId>.json
  attempts/
    <taskId>/
      attempt-1/
        worker.md
        task-report.json
        stdout.jsonl
        stderr.txt
        attempt.json
```

`batchId` is sortable timestamp plus random suffix. `taskId` is batch-local (`t001`, `t002`, ...).

## Worker File Protocol

A worker receives exact paths for:

- `worker.md` — human-readable log;
- `task-report.json` — machine-readable completion report.

The supervisor trusts only the structured report. Required shape:

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
  audit?: { level?: "basic" | "full" };
  acceptanceDefaults?: AcceptanceContract;
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
  audit?: { level?: "basic" | "full" };
  acceptanceDefaults?: AcceptanceContract;
  synthesis?: { mode?: "parent" | "report-only"; instructions?: string };
};
```

`task` is a single-task convenience wrapper over `tasks`.

`tasks` is the small-batch escape hatch (≤ `MAX_INLINE_TASKS=4` tasks, ≤ `MAX_INLINE_PROMPT_BYTES=8000` prompt bytes). Oversized inline payloads fail fast with a message pointing to `tasks_plan`.

`tasks_plan` is the primary fan-out tool. The extension validates the input, expands the matrix locally into N full `TaskSpecInput`s, and calls `executeSupervisedTasks` with the same artifact/audit/acceptance/retry/throttle behavior as `tasks`. It additionally writes `plan.json` next to `batch.json` recording the matrix, templates, expanded task names, and synthesis instructions.

### Why `tasks_plan` exists

Inline `tasks({ tasks: [...] })` requires the model to stream the entire batch as one tool-call argument. With many long per-task prompts, that argument can be tens of KB and the model/provider can be `terminated` mid-stream. When that happens, `execute()` is never called: there is no `TASKS starting`, no `.pi/tasks/<batchId>`, no heartbeat, and no logs. `tasks_plan` keeps the streamed argument tiny (one shared `promptTemplate` + N short `matrix` rows) so the supervisor reaches `execute()` quickly and produces visible artifacts.

### `tasks_plan` template rules

- `{{key}}` lookups resolve in this order: row.id, row.name, row.cwd, row.vars.
- In a string field, an array value joins with `\n`.
- In an array string field (e.g. `acceptanceTemplate.allowedWritePaths`), an entry that is exactly `{{key}}` and whose row value is an array splats into multiple list entries.
- `requiredPaths` accepts both bare strings and `PathCheck` objects; `path`, `requiredRegex`, and `forbiddenRegex` are all template-substituted.
- Unknown variables raise an error before any worker spawns.
- Hard limits: `MAX_PLAN_ROWS=100`, `MAX_PLAN_PROMPT_TEMPLATE_BYTES=32000`, `MAX_PLAN_TOTAL_INPUT_BYTES=64000`.

### Write-boundary parallelism

Tasks with `acceptance.allowedWritePaths` (or `acceptance.forbiddenWritePaths`) run in parallel like everything else. The supervisor attributes file changes per task this way:

- Each task captures a `git status` baseline right before it starts. After the task finishes, the supervisor diffs the project against that baseline and **filters the diff to files matching this task's `allowedWritePaths` zone**. Concurrent writes by other tasks (which target their own disjoint zones) never appear in this task's audit set.
- Worker-side tool telemetry (`file_write_observed` events from the worker's own tool calls) is merged unfiltered. Out-of-zone writes show up in telemetry, so `acceptance.allowedWritePaths` and `acceptance.forbiddenWritePaths` violations are caught even when several tasks run in parallel.

This gives true parallelism for chapter-style fan-out where each agent owns a disjoint `chapters/chN/**` zone. If two tasks declare overlapping `allowedWritePaths`, attribution becomes ambiguous (the same changed file can match both zones); declare disjoint zones or run those tasks with `concurrency: 1` if strict attribution matters.

## Acceptance Contracts

Supported checks:

- `requiredPaths`
- `forbiddenPaths`
- `requiredOutputRegex`
- `forbiddenOutputRegex`
- `requiredReportRegex`
- `forbiddenReportRegex`
- `minWorkerLogBytes`
- `minReportSummaryChars`
- `allowedWritePaths`
- `forbiddenWritePaths`
- `requireDeliverablesEvidence`
- `auditOnly`

Acceptance failure is not parent-retryable by default. It means the worker ran and produced a report, but the delivered artifacts did not satisfy the parent-side contract.

## Retry Boundary

Worker agents should handle recoverable work-level errors themselves and record those in `internalRetries`.

The parent supervisor retries only launch/session/provider-level failures that did not produce a valid worker report:

- `launch_error`
- `provider_transient`
- `provider_stalled`

Examples: `429`, `5xx`, `overloaded`, `Internal server error`, `terminated`, connection reset, timeout.

The parent does not retry by default for:

- `acceptance_failed`
- `protocol_error` after a valid worker turn
- `blocked`
- user abort
- permission/auth/model errors

## Dynamic Throttling

The supervisor records transient failure windows and emits `throttle_decision` events. It lowers concurrency when transient failure rate exceeds a threshold and gradually recovers after stable windows.

## UI and Rerun

`/tasks-ui` should read batch artifacts, not session-only recent state. It presents:

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

Live tool updates emit compact batch progress plus recent per-task thinking/tool activity derived from worker `stdout.jsonl` events. The same activity is persisted on each `tasks/<taskId>.json` artifact and shown by task/attempt detail views.

## Phase 3 Direction

The file protocol remains the fallback. A future child-only `task_report` tool and worker event channel provide stronger live telemetry:

- `heartbeat`
- `progress`
- `tool_call_started`
- `tool_call_finished`
- `file_write_observed`
- `task_report_submitted`

Heartbeat/stall detection classifies `worker_stalled`, `provider_stalled`, and `unknown_stall`.
