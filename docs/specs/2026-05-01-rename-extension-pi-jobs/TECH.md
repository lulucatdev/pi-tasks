# Tech Spec: Rename Extension to pi-jobs

Product spec: `docs/specs/2026-05-01-rename-extension-pi-jobs/PRODUCT.md`

## Context

- `package.json` owns the local package identity, npm scripts, and pi extension entrypoint list.
- `extensions/jobs/index.ts` registers the public `job`, `jobs`, `jobs_plan`, `/jobs-start`, and `/jobs-ui` surfaces.
- `extensions/jobs/` contains the supervisor runtime modules after the layout rename.
- `tests/jobs/` contains the Node test suite after the layout rename.
- `scripts/jobs-audit-smoke.sh` validates the end-to-end artifact flow.
- `docs/`, `docs/specs/`, and `docs/plans/` hold current and historical design docs that should use job/jobs names in filenames and text.

## Proposed changes

1. Keep `package.json` package name as `pi-jobs`; point `pi.extensions` to `./extensions/jobs`; update scripts to `tests/jobs/*.mjs` and `scripts/jobs-audit-smoke.sh`.
2. Rename implementation files and imports to job/jobs names, including `run-jobs.ts`, `job-ui.ts`, `job-view.ts`, `job-report-tool.ts`, `job-worker-runtime.ts`, and `jobs-plan.ts`.
3. Rename tests and fixture imports to `tests/jobs/` and job/jobs file names.
4. Rename artifact storage from `.pi/jobs/<batchId>/jobs/<jobId>.json` and use `jobId`, `jobIds`, `job-report.json`, `job_report`, and `PI_JOB_*` protocol names throughout the runtime.
5. Rename docs and scripts so all tracked filenames use job/jobs terminology.
6. Preserve runtime behavior while updating public strings, validation messages, UI output, summary Markdown, rerun payloads, and smoke output to job/jobs names.

## Testing and validation

- Search tracked project files and filenames for stale legacy terminology, excluding `.git` internals.
- Run `npm test` to verify the renamed API, protocol, imports, and runtime behavior.
- Run `npm run smoke` to verify the supervisor smoke flow creates `.pi/jobs/...` artifacts successfully.
