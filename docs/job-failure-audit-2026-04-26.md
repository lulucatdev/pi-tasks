# Job/Jobs Failure Audit — 2026-04-26

## Background

This audit reviews the MICRO102 Stage 9 batch run that launched one job worker per chapter. The run intentionally used high parallelism. The observed failures were not all the same kind: some were hard provider/runtime errors, while others were false-positive successes where the worker stopped after creating only a stub work log.

## Observed Symptoms

### 1. Hard worker errors

Examples:

- `20260426023541-stage9-ch05.md`: empty output file, tool returned `terminated`.
- `20260426023541-stage9-ch15.md`: empty output file, tool returned `400 Internal server error`.
- `20260426023541-stage9-ch18.md`: partial stub output, tool returned `400 Internal server error`.
- `20260426030523-stage9-retry-ch05.md`: worker wrote only diagnostics, then terminated.
- `20260426030523-stage9-retry-ch08.md`: empty output file, terminated.

Likely cause: transient provider/session failures under high concurrency and long worker prompts. These are genuine job failures; the root agent correctly had to retry them.

### 2. False-positive successes

Several jobs were reported as `success` even though their output file was empty or contained only a start marker:

- `20260426023541-stage9-ch03.md`: `0B`, reported success.
- `20260426023541-stage9-ch08.md`: only “已开始/准备阅读”, reported success.
- `20260426023541-stage9-ch12.md`: only “已开始处理”, reported success.
- `20260426023541-stage9-ch13.md`: only “已开始处理”, reported success.
- `20260426023541-stage9-ch17.md`: only “状态：已开始”, reported success.
- `20260426023541-stage9-ch19.md`: only “已开始处理”, reported success.

Root cause in `extensions/jobs/index.ts`:

```ts
if (args.sawTerminalAssistantMessage) return args.stopReason === "error" ? "error" : "success";
if (args.exitCode === 0 && args.stopReason !== "error") return "success";
```

The status resolver trusted the child process exit/assistant stop reason. It did not validate whether the worker output file contained a finished record. A worker could exit cleanly after writing only a stub, and the parent would call it success.

### 3. Wrong output location / incomplete delivery records

Some workers completed chapter edits but wrote `chNN_recap_plan.md` or `chNN_delivery.md` to a wrong relative location such as `LaTeX.MICRO.102.精要版/` or repository root instead of the requested Stage 9 folders.

Likely cause: model noncompliance plus no tool-level required-file validation. The job prompt listed allowed files, but the job runtime did not enforce a write allowlist or verify required paths after completion.

### 4. Job output file was not a reliable completion signal

A few workers edited real chapter files but did not update their `.pi/jobs/*.md` work log after the first “已开始” entry. The root agent therefore had to inspect filesystem side effects, not just job summaries.

## Fix Implemented

Patched `extensions/jobs/index.ts` in both:

- `/Users/lucas/Developer/pi-jobs/`
- `/Users/lucas/.pi/agent/git/github.com/lulucatdev/pi-jobs/`

Changes:

1. The worker system prompt now requires a final status marker in the output file:

```text
JOB_STATUS: completed
```

If the worker cannot fully finish, it must write one of:

```text
JOB_STATUS: partial
JOB_STATUS: blocked
JOB_STATUS: error
```

2. Added output-file validation:

- Empty output file => job becomes `error`.
- Missing `JOB_STATUS: completed` marker => job becomes `error`.
- `JOB_STATUS: partial/blocked/error` => job becomes `error` with the reported marker.

3. Added tests in `tests/jobs/job-results.test.mjs` for marker validation.

4. Verified tests in the active package clone:

```bash
cd /Users/lucas/.pi/agent/git/github.com/lulucatdev/pi-jobs
npm test
```

Result: 7 tests passed.

## Remaining Tool Gaps

The marker fix prevents the most damaging false-positive successes, but it does not solve every class of issue.

Recommended future improvements:

1. Add transient retry logic for provider/session errors such as `terminated`, `overloaded`, `429`, `500`, and `400 Internal server error` when stderr/error text matches known transient patterns.
2. Add optional per-job acceptance contracts: required output paths, forbidden output paths, required regex matches, and forbidden regex matches.
3. Add write allowlist enforcement or post-run audit warnings when a worker edits outside declared paths.
4. Add a parent-side batch audit summary that includes output-file byte count, `JOB_STATUS`, required-file existence, and suspicious stub phrases like “已开始”, “待执行”, or “进行中”.
5. Consider dynamic throttling: start with high concurrency, but reduce concurrency or retry with backoff when multiple provider errors appear.

## Operational Lessons

For future high-concurrency chapter batches:

- Do not trust `success` alone; verify required files exist.
- Require each worker to write a completion marker.
- Keep one root-side status table with: `zero_file`, chapter input, recap plan, delivery report, ordinary example count, compile result.
- After any `terminated` or `400` result, inspect the job file: if no required files were written, retry with a narrower prompt.
- Prefer smaller, scoped cleanup passes after the first broad batch; this worked well for ch05/ch08/ch12 and ch01/ch02 example conversion.

## Supervisor V3 Replacement

The marker fix is now treated as an interim legacy guard, not the final completion protocol. The replacement design is documented in `docs/specs/jobs-supervisor-v3.md` and implemented as a root-supervised job agent runtime.

Key changes:

- Worker completion is reported through `job-report.json` and later `job_report`, not `JOB_STATUS` strings.
- Every run creates `.pi/jobs/<batchId>/batch.json`, `events.jsonl`, `summary.md`, per-job JSON, and per-attempt artifacts.
- `success` is derived from runtime success, valid worker report, `completed` status, acceptance checks, and audit integrity.
- Parent retry is limited to launch/session/provider transient failures without a valid worker report.
- Acceptance contracts validate required paths, forbidden paths, regexes, write boundaries, deliverables, and evidence.
