# AGENTS.md

This repository is the source of truth for the pi `task` / `tasks` package.

## Scope

This repo owns:
- `extensions/task/`
- `tests/task/`
- `scripts/task-audit-smoke.sh`
- task-specific docs under `docs/`

## Workflow

- Edit here first.
- Load this repo into pi as a local package.
- Do not use broad runtime sync from `pi-tools` for task maintenance.
- Validate with:
  - `npm run test`
  - `npm run smoke`

## Notes

The runtime should load this package directly from `/Users/lucas/Developer/pi-tasks` via pi package settings.
