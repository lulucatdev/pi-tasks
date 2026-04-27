# Tasks Extension

Root-only supervised task agents for pi.

## Tools

- `tasks_plan` launches a fan-out batch of supervised task agents from a compact `matrix + promptTemplate + acceptanceTemplate` payload. The extension expands rows locally into per-row prompts/acceptance/metadata, then runs them under the same audited supervisor as `tasks`. Use this for any repeated/templated fan-out (every chapter, every report, every file). This is the primary tool for fan-out and the only safe way to launch many agents.
- `tasks` launches a small **inline** batch of supervised task agents (escape hatch for ≤4 ad-hoc tasks). It rejects payloads larger than `MAX_INLINE_TASKS=4` tasks or `MAX_INLINE_PROMPT_BYTES=8000` prompt bytes and tells the caller to use `tasks_plan` instead. It also rejects one-task meta-fanout payloads where the prompt asks for multiple agents.
- `task` launches one supervised task agent.
- `/tasks-start` inserts task-oriented guidance into the editor without triggering an LLM turn.
- `/tasks-ui` reads batch artifacts, shows failure triage, opens task/attempt details, and prepares rerun payloads.

## Why `tasks_plan` exists

Inline `tasks({ tasks: [...] })` requires the model to stream the entire batch as one tool-call argument. With many long per-task prompts, that argument can be tens of KB and the model/provider can be `terminated` mid-stream. When that happens, `execute()` is never called: there is no `TASKS starting`, no `.pi/tasks/<batchId>`, no heartbeat, no logs. `tasks_plan` keeps the streamed argument tiny (one shared template + N short rows) so the supervisor reaches `execute()` quickly and produces visible artifacts.

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
  tasks: TaskSpecInput[];                  // ≤ 4 inline tasks
  concurrency?: number;
  retry?: ParentRetryPolicy;
  throttle?: ThrottlePolicy;
  acceptanceDefaults?: AcceptanceContract;
  parentBatchId?: string;
  rerunOfTaskIds?: string[];
};

type TasksPlanRow = {
  id: string;                              // unique within batch, [A-Za-z0-9._-]
  name?: string;                           // overrides nameTemplate
  cwd?: string;                            // overrides cwdTemplate
  vars?: Record<string, string | string[]>;
};

type TasksPlanInput = {
  batchName: string;
  concurrency?: number;
  matrix: TasksPlanRow[];
  promptTemplate: string;                  // {{key}} substitutions per row
  nameTemplate?: string;                   // default: '{{batchName}} {{id}}'
  cwdTemplate?: string;
  acceptanceTemplate?: AcceptanceContract; // strings + arrays substituted per row
  metadataTemplate?: Record<string, string>;
  retry?: ParentRetryPolicy;
  throttle?: ThrottlePolicy;
  acceptanceDefaults?: AcceptanceContract;
  synthesis?: { mode?: "parent" | "report-only"; instructions?: string }; // experimental metadata only
  parentBatchId?: string;
  rerunOfTaskIds?: string[];
};
```

## Concurrency semantics

- There is no hidden default concurrency cap. If `concurrency` is omitted, the supervisor starts all supplied leaf tasks concurrently (`tasks.length` or `matrix.length`).
- Set `concurrency: N` only when you want an explicit local cap for that batch.
- Dynamic throttling is opt-in: set `throttle: { enabled: true, ... }` to let the supervisor reduce/recover concurrency after transient provider/session failures. When `throttle` is omitted, the supervisor does not auto-throttle.
- Agent-driven waves are preferred: split a large job into multiple `tasks_plan` calls when you want phases, dependency boundaries, or manual provider load control.

### `tasks_plan` template rules

- `{{key}}` lookups resolve in this order: row.id, row.name, row.cwd, row.vars.
- In a string field, an array value joins with `\n`.
- In an array string field (e.g. `acceptanceTemplate.allowedWritePaths`), an entry that is exactly `{{key}}` and whose row value is an array splats into multiple list entries.
- `requiredPaths` accepts both bare strings and `PathCheck` objects; `path`, `requiredRegex`, and `forbiddenRegex` are all template-substituted.
- Unknown variables raise an error before any worker spawns.
- `tasks_plan` is frozen as compact input transport, not a workflow engine: unknown top-level keys, unknown row keys, conditionals, loops, dependency graphs, and nested workflow steps are rejected.
- `synthesis` is experimental metadata for parent post-batch summary; it is not executable workflow logic.

### `tasks_plan` example

```ts
tasks_plan({
  batchName: "oracle-chapter-fixes",
  concurrency: 6,
  matrix: [
    { id: "ch01", vars: { chapter: "01", report: "oracle/reports/ch01.md", allowedWritePaths: ["chapters/ch01/"] } },
    // ... ch02 through ch19
  ],
  promptTemplate: `
You are the chapter {{chapter}} worker.
Read: {{report}}
Edit only files matching:
{{allowedWritePaths}}
Submit a structured task report with changed files, evidence, and blockers.
`,
  acceptanceTemplate: {
    requiredPaths: ["{{report}}"],
    allowedWritePaths: ["{{allowedWritePaths}}"],
    requireDeliverablesEvidence: true,
    minReportSummaryChars: 80,
  },
  metadataTemplate: { chapter: "{{chapter}}", report: "{{report}}" },
});
```

## Completion protocol

A worker must submit:

- a non-empty `worker.md` for human-readable notes;
- a structured report via the child-only `task_report` tool, or fallback `task-report.json`.

The supervisor trusts the structured report, not natural language claims or legacy `TASK_STATUS` markers. Thinking-only final turns and missing reports are `worker_incomplete` and parent-retryable when no valid report was produced.

## Worker child sessions

Each worker attempt launches a full child Pi process: `pi --mode json -p --session <attemptDir>/session.jsonl --no-extensions --extension task-worker-runtime.ts`. The child owns its own session and Pi auto-compaction boundary; the parent does not mutate child context. The parent supervises stdout JSONL events, write telemetry, process lifecycle, and artifacts, while the small worker runtime extension only exposes `task_report`. Worker prompts still tell agents to avoid huge dumps and prefer targeted reads/greps plus durable notes to files.

## Acceptance contracts

Acceptance can require files, forbid paths, check worker-log/report regexes, validate minimum sizes, and audit changed files against allowed/forbidden write paths. Git diff files and worker telemetry first become normalized `WriteEvidence[]`; `.pi/tasks/**` supervisor artifacts are ignored, exact paths match exactly, trailing slash patterns mean directory prefixes, and `*`/`**` keep glob behavior.

**Do not** add `TASK_STATUS: completed` (or similar log-marker regexes) as an acceptance requirement: V3 derives completion from the structured `task-report.json` the worker submits, and a missing log marker only produces false negatives. **Do not** list `task-report.json` or `worker.md` in `requiredPaths`: the supervisor writes those itself in the batch artifact directory, not under the task's cwd. Prefer `requireDeliverablesEvidence: true` and `minReportSummaryChars` to enforce real completion proof.

Example:

```ts
tasks({
  concurrency: 4,
  tasks: [{
    name: "stage9-ch05",
    prompt: "Process chapter 05...",
    acceptance: {
      requiredPaths: [{ path: "Stage9/ch05_delivery.md", minBytes: 200 }],
      forbiddenPaths: ["ch05_delivery.md"],
      forbiddenOutputRegex: ["已开始|待执行|TODO"],
      allowedWritePaths: ["Stage9/**"],
      requireDeliverablesEvidence: true,
      minReportSummaryChars: 80,
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
  plan.json                  # only present when tasks_plan was used
  tasks/<taskId>.json
  attempts/<taskId>/attempt-N/
    session.jsonl
    system-prompt.md
    worker-prompt.md
    worker.md
    task-report.json
    worker-events.jsonl
    stdout.jsonl
    stderr.txt
    attempt.json
```

`summary.md` is the quickest human entry point after a run. When `tasks_plan` ran the batch, `plan.json` records the matrix, templates, taskNames, and optional experimental synthesis metadata that produced it.

Treat `.pi/tasks/**` as a sensitive local audit directory. It can contain full worker prompts, system prompt fragments, child `session.jsonl` transcripts, stdout/stderr, file paths, and structured reports. Do not publish or attach it wholesale without reviewing/redacting it first.

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

The parent supervisor retries only launch/session/provider/worker-incomplete failures when no valid worker report was produced: `launch_error`, `provider_transient`, `provider_stalled`, `worker_stalled`, and `worker_incomplete` (for example `429`, `5xx`, `overloaded`, `Internal server error`, `terminated`, timeout, connection reset, thinking-only stop, or no task report).

Acceptance failures, malformed reports, invalid contracts, and user aborts are not parent-retryable by default.
