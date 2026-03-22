# Tasks Extension

Root-only parallel task workers for pi.

Installed resources:
- Extension: `~/.pi/agent/extensions/task/index.ts`

Features:
- `/tasks-start` appends task-oriented guidance to the current composer, or prints it for manual reuse when insertion is unavailable
- `task` tool for launching one isolated task worker
- `tasks` tool for launching one or more isolated task workers in parallel
- Optional per-task `name` for human-readable identity
- Automatic 6-digit numeric `id` for every task run
- No nested task creation inside child workers
- Worker agents write their results to a pre-created `.pi/tasks/<id>.md` output file
- The tool result returns the absolute path so the root agent can read it
- Persistent tasks widget below the editor for active and recent runs
- `/tasks-ui` dashboard for inspecting runs, reopening details, rerunning, copying prompts, pasting prompts, and aborting running tasks

Quick examples:
- `/tasks-start`
- `Use task to inspect the auth flow in isolation`
- `Use tasks to inspect the auth flow, trace the DB schema, and find the tests in parallel`
- `Run tasks with names: find-schemas, trace-controller-flow, tests`
- `/tasks-ui`
- `/tasks-ui 042731`
- `/tasks-ui abort 042731`

`/tasks-ui` keys:
- `Up/Down` or `j/k`: move selection
- `Enter`: open detail view for the selected run
- `r`: rerun the selected task batch
- `c`: copy the selected task prompt set to the clipboard
- `p`: paste the selected task prompt set into the editor
- `a`: abort the first running task in the selected run
- `Esc`: close, or return from detail view

Notes:
- `/tasks-start` only inserts or prints visible guidance; it does not create hidden files or switch the session into a hidden tasks mode.
- Task output files live under `.pi/tasks/`.
- Task workers inherit the current model unless pi resolves a different model at runtime.
- Task workers inherit the current tool environment except `task`, `tasks`, and `subagent*` tools.
- Task results are identified as `name + id` when a name exists, otherwise `task + id`.
