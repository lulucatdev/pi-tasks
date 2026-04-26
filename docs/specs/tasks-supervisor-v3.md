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
  tasks: TaskSpecInput[];
  concurrency?: number;
  retry?: ParentRetryPolicy;
  throttle?: ThrottlePolicy;
  audit?: { level?: "basic" | "full" };
  acceptanceDefaults?: AcceptanceContract;
};
```

`task` is a single-task convenience wrapper over `tasks`.

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
