# Product Spec: Rename Extension to pi-jobs

Issue: none provided

## Summary

Rename the local pi package, public API, source layout, test layout, scripts, artifacts, and documentation to use job/jobs terminology consistently. This is a breaking rename with no legacy aliases.

## Behavior

1. Current package metadata identifies the package as `pi-jobs`.
2. Current user-facing repository documentation presents the project as `pi-jobs` and gives install/navigation examples using the new package path.
3. The public tools are `job`, `jobs`, and `jobs_plan`.
4. The public slash commands are `/jobs-start` and `/jobs-ui`.
5. Runtime behavior remains equivalent: one `job` launches one supervised worker, `jobs` launches a small inline batch, and `jobs_plan` launches compact matrix fan-out.
6. Source directories, test directories, script names, artifact roots, filenames, and current docs use job/jobs names consistently.
7. No tracked current project file or filename contains legacy terminology after the rename, excluding Git internals.

## Goals / Non-goals

Goal: make the package/extension identity, public API, implementation layout, and documentation consistently read as `pi-jobs`.

Non-goal: preserve backwards-compatible legacy aliases in this breaking rename.
