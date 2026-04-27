# pi-tasks

Local pi package for the `task` / `tasks` runtime.

This repository is the source of truth for task-related pi work.
Do not maintain the live runtime copy by syncing from `pi-tools` anymore.

## What lives here

- `extensions/task/` - the task extension and supervisor runtime modules
- `tests/task/` - focused Node tests for status, audit artifacts, supervisor behavior, retry, throttle, UI helpers, and smoke fixtures
- `scripts/task-audit-smoke.sh` - end-to-end temp-workspace smoke validation
- `docs/specs/` - task design specs, including `tasks-supervisor-v3.md`
- `docs/plans/` - implementation plans for task work

## Runtime model

Tasks Supervisor V3 treats each task as a supervised task agent attempt.

- The root process owns planning, scheduling, retry classification, acceptance checks, and synthesis.
- Fan-out is explicit. The primary fan-out tool is `tasks_plan`: a compact `matrix + promptTemplate + acceptanceTemplate` payload that the extension expands locally into N supervised tasks. Inline `tasks` is a small-batch escape hatch (≤4 tasks, ≤8000 prompt bytes) and rejects oversized payloads with a pointer to `tasks_plan`.
- Concurrency is explicit when capped: omitting `concurrency` runs every supplied leaf task concurrently; root agents should split large jobs into waves when they want phased execution. Dynamic throttling is opt-in via `throttle.enabled: true`.
- Each worker is a full child `pi --mode json -p --session <attempt>/session.jsonl` process with its own session/compaction boundary; the parent only supervises stdout JSONL, artifacts, and the structured report protocol.
- Workers handle recoverable work-level errors themselves and submit `task-report.json`.
- Parent retry is reserved for launch/session/provider transient failures that did not produce a valid report.
- `success` requires runtime success, valid worker report, `completed` status, acceptance pass, and finalized audit artifacts.
- Legacy `TASK_STATUS` markers are only warning signals; they are not a completion protocol.

Batch artifacts live under:

```text
.pi/tasks/<batchId>/
  batch.json
  events.jsonl
  summary.md
  plan.json                  # only present when tasks_plan was used
  tasks/<taskId>.json
  attempts/<taskId>/attempt-N/
```

## Artifact UI

Use `/tasks-ui` to navigate persisted artifacts:

```text
/tasks-ui
/tasks-ui help
/tasks-ui <batchId>
/tasks-ui <batchId> task <taskId>
/tasks-ui <batchId> attempt <taskId> <attemptId|latest>
/tasks-ui rerun failed <batchId>
/tasks-ui rerun acceptance-failed <batchId>
/tasks-ui rerun provider-transient <batchId>
/tasks-ui rerun selected <batchId> <taskId> [taskId...]
```

The UI is artifact-first: batch detail groups failures, task detail shows acceptance/report state, attempt detail shows runtime fields, thinking/tool activity, and artifact paths, and rerun preparation preserves parent batch provenance. Live `task` / `tasks` updates also show recent per-task thinking/activity lines while workers run.

## Load it in pi

Add this package as a local package in `~/.pi/agent/settings.json`, or install it directly:

```bash
pi install /Users/lucas/Developer/pi-tasks
```

Pi will load the extension from:

- `extensions/task/index.ts`

## Local validation

```bash
cd /Users/lucas/Developer/pi-tasks
npm run test
npm run smoke
```

## Key docs

- `docs/specs/tasks-supervisor-v3.md` - authoritative V3 design
- `docs/task-failure-audit-2026-04-26.md` - incident audit and V3 replacement notes
- `extensions/task/README.md` - tool usage and artifact overview
