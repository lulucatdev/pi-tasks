# pi-tasks

Local pi package for the `task` / `tasks` runtime.

This repository is the source of truth for task-related pi work.
Do not maintain the live runtime copy by syncing from `pi-tools` anymore.

## What lives here

- `extensions/task/` - the task extension and its internal modules
- `tests/task/` - focused Node tests for audit files, task flow, and `/tasks-start`
- `scripts/task-audit-smoke.sh` - end-to-end temp-workspace smoke validation
- `docs/specs/` - task design specs
- `docs/plans/` - implementation plans for task work

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

## Runtime model

- Maintain task-related changes here
- Load it in pi through the local package path
- Avoid full-runtime sync for task work
