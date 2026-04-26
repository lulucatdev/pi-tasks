# Tasks Extension

Root-only supervised task agents for pi.

## Tools

- `task` launches one supervised task agent.
- `tasks` launches one or more supervised task agents with configurable concurrency, retry, throttling, audit, and acceptance contracts.
- `/tasks-start` inserts task-oriented guidance into the editor without triggering an LLM turn.
- `/tasks-ui` reads batch artifacts, shows failure triage, opens task/attempt details, and prepares rerun payloads.

## Input model

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

## Completion protocol

A worker must write:

- `worker.md` for human-readable notes;
- `task-report.json` for machine-readable completion.

The supervisor trusts `task-report.json`, not natural language claims or legacy `TASK_STATUS` markers.

## Acceptance contracts

Acceptance can require files, forbid paths, check worker-log/report regexes, validate minimum sizes, and audit changed files against allowed/forbidden write paths.

Example:

```ts
tasks({
  concurrency: 8,
  tasks: [{
    name: "stage9-ch05",
    prompt: "Process chapter 05...",
    acceptance: {
      requiredPaths: [{ path: "Stage9/ch05_delivery.md", minBytes: 200 }],
      forbiddenPaths: ["ch05_delivery.md"],
      forbiddenOutputRegex: ["已开始|待执行|TODO"],
      allowedWritePaths: ["Stage9/**", ".pi/tasks/**"],
      requireDeliverablesEvidence: true
    }
  }]
});
```

## Artifacts

```text
.pi/tasks/<batchId>/
  batch.json
  events.jsonl
  summary.md
  tasks/<taskId>.json
  attempts/<taskId>/attempt-N/
    worker.md
    task-report.json
    stdout.jsonl
    stderr.txt
    attempt.json
```

`summary.md` is the quickest human entry point after a run.

## Artifact UI

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

Batch detail shows failed tasks first with reason, retryability, and artifact inspection commands. Task detail shows prompt/cwd, timeline, acceptance/report state, deliverables, evidence, recent thinking/tool activity, and latest attempt paths. Attempt detail shows runtime status, exit/stop reason, stderr tail, malformed stdout count, thinking/tool activity, and every attempt artifact path. Live `task` / `tasks` updates show the latest per-task thinking/activity lines while workers run.

## Retry boundary

Workers should retry recoverable work errors internally and record them in `internalRetries`.

The parent supervisor retries only launch/session/provider transient failures such as `429`, `5xx`, `overloaded`, `Internal server error`, `terminated`, timeout, and connection reset when no valid worker report was produced.

Acceptance failures, blocked reports, invalid contracts, and user aborts are not parent-retryable by default.
