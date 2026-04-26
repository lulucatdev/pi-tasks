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
  audit?: { level?: "basic" | "full" };
  acceptanceDefaults?: AcceptanceContract;
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
  audit?: { level?: "basic" | "full" };
  acceptanceDefaults?: AcceptanceContract;
  synthesis?: { mode?: "parent" | "report-only"; instructions?: string };
};
```

### `tasks_plan` template rules

- `{{key}}` lookups resolve in this order: row.id, row.name, row.cwd, row.vars.
- In a string field, an array value joins with `\n`.
- In an array string field (e.g. `acceptanceTemplate.allowedWritePaths`), an entry that is exactly `{{key}}` and whose row value is an array splats into multiple list entries.
- `requiredPaths` accepts both bare strings and `PathCheck` objects; `path`, `requiredRegex`, and `forbiddenRegex` are all template-substituted.
- Unknown variables raise an error before any worker spawns.

### `tasks_plan` example

```ts
tasks_plan({
  batchName: "oracle-chapter-fixes",
  concurrency: 6,
  matrix: [
    { id: "ch01", vars: { chapter: "01", report: "oracle/reports/ch01.md", allowedWritePaths: ["chapters/ch01/**", ".pi/tasks/**"] } },
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
  synthesis: { mode: "parent", instructions: "Summarize chapter outcomes, failures, and changed files." },
});
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
  plan.json                  # only present when tasks_plan was used
  tasks/<taskId>.json
  attempts/<taskId>/attempt-N/
    worker.md
    task-report.json
    stdout.jsonl
    stderr.txt
    attempt.json
```

`summary.md` is the quickest human entry point after a run. When `tasks_plan` ran the batch, `plan.json` records the matrix, templates, taskNames, and synthesis instructions that produced it.

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
