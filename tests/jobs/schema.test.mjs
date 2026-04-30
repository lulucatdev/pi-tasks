import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResultText,
  enforceInlineJobsLimit,
  inlineJobsByteSize,
  MAX_INLINE_PROMPT_BYTES,
  MAX_INLINE_JOBS,
  normalizeJobsRun,
  validateJobsFanoutUsage,
  validateJobsToolParams,
} from "../../extensions/jobs/run-jobs.ts";

test("validateJobsToolParams accepts new prompt-based job specs", () => {
  const params = { jobs: [{ name: "inspect", prompt: "Inspect the code", cwd: "." }], concurrency: 4 };
  assert.doesNotThrow(() => validateJobsToolParams(params));
});

test("validateJobsToolParams rejects old job field, empty names, and unsafe job ids", () => {
  assert.throws(() => validateJobsToolParams({ jobs: [{ name: "old", job: "legacy" }] }), /prompt/);
  assert.throws(() => validateJobsToolParams({ jobs: [{ name: "", prompt: "x" }] }), /name/);
  assert.throws(() => validateJobsToolParams({ jobs: [{ id: "../batch", name: "unsafe", prompt: "x" }] }), /path traversal/);
  assert.throws(() => validateJobsToolParams({ jobs: [{ id: "nested/job", name: "unsafe", prompt: "x" }] }), /path traversal/);
});

test("validateJobsFanoutUsage rejects one meta-job when fan-out was intended and points to jobs_plan", () => {
  assert.throws(() => validateJobsFanoutUsage({
    concurrency: 19,
    jobs: [{ name: "fix all chapters", prompt: "发起 19 个并行 agents。每个都会读对应 Oracle 报告并只修本章局部正文问题。" }],
  }), /received 1 job.*19 supervised workers/);
  assert.throws(() => validateJobsFanoutUsage({
    jobs: [{ name: "parallel repair", prompt: "Launch parallel workers, each one reads a corresponding report and writes a receipt." }],
  }), /jobs_plan/);
  assert.doesNotThrow(() => validateJobsFanoutUsage({
    concurrency: 1,
    jobs: [{ name: "single repair", prompt: "Fix this one chapter only." }],
  }));
  assert.doesNotThrow(() => validateJobsFanoutUsage({
    jobs: [{ name: "single repair", prompt: "Fix this one chapter only." }],
  }));
});

test("normalizeJobsRun defaults concurrency to all supplied jobs", () => {
  const normalized = normalizeJobsRun({
    jobs: Array.from({ length: 12 }, (_value, index) => ({ name: `job-${index}`, prompt: "Do it" })),
  }, "/tmp/project");

  assert.equal(normalized.requestedConcurrency, 12);
  assert.equal(normalized.effectiveConcurrency, 12);
});

test("normalizeJobsRun creates batch-local ids, resolves cwd, merges acceptance defaults, and clamps concurrency", () => {
  const normalized = normalizeJobsRun({
    concurrency: 50,
    acceptanceDefaults: { requiredOutputRegex: ["done"], allowedWritePaths: ["shared/**"] },
    jobs: [
      { name: "one", prompt: "Do one", cwd: "sub", acceptance: { forbiddenOutputRegex: ["TODO"], allowedWritePaths: ["one.md"] } },
      { name: "two", prompt: "Do two" },
    ],
  }, "/tmp/project", 8);

  assert.deepEqual(normalized.jobs.map((job) => job.id), ["t001", "t002"]);
  assert.equal(normalized.jobs[0].cwd, "/tmp/project/sub");
  assert.equal(normalized.requestedConcurrency, 50);
  assert.equal(normalized.effectiveConcurrency, 2);
  assert.deepEqual(normalized.jobs[0].acceptance.requiredOutputRegex, ["done"]);
  assert.deepEqual(normalized.jobs[0].acceptance.forbiddenOutputRegex, ["TODO"]);
  assert.deepEqual(normalized.jobs[0].acceptance.allowedWritePaths, ["shared/**", "one.md"]);
});

test("enforceInlineJobsLimit allows small batches", () => {
  assert.doesNotThrow(() => enforceInlineJobsLimit({
    jobs: [
      { name: "a", prompt: "do a" },
      { name: "b", prompt: "do b" },
    ],
  }));
});

test("enforceInlineJobsLimit rejects more than MAX_INLINE_JOBS items and points to jobs_plan", () => {
  const jobs = Array.from({ length: MAX_INLINE_JOBS + 1 }, (_v, i) => ({ name: `t${i}`, prompt: "do it" }));
  assert.throws(() => enforceInlineJobsLimit({ jobs }), /jobs_plan/);
  assert.throws(() => enforceInlineJobsLimit({ jobs }), /limit \d+/);
});

test("enforceInlineJobsLimit rejects oversized prompt payloads and points to jobs_plan", () => {
  const big = "x".repeat(MAX_INLINE_PROMPT_BYTES + 100);
  assert.throws(() => enforceInlineJobsLimit({ jobs: [{ name: "huge", prompt: big }] }), /jobs_plan/);
});

test("inlineJobsByteSize counts job name and prompt utf-8 bytes", () => {
  const size = inlineJobsByteSize({ jobs: [{ name: "α", prompt: "β" }] });
  assert.equal(size, Buffer.byteLength("α", "utf-8") + Buffer.byteLength("β", "utf-8"));
});

test("buildResultText points to batch artifacts", () => {
  const text = buildResultText({
    batchId: "batch-1",
    batchDir: "/tmp/project/.pi/jobs/batch-1",
    status: "error",
    total: 3,
    success: 1,
    error: 1,
    aborted: 1,
    summaryPath: "/tmp/project/.pi/jobs/batch-1/summary.md",
  });

  assert.match(text, /JOBS error · 1✓ 1✗ 1⊘ \/ 3/);
  assert.match(text, /\/jobs-ui batch-1/);
  assert.match(text, /summary: \/tmp\/project\/\.pi\/jobs\/batch-1\/summary\.md/);
  assert.match(text, /rerun failed: \/jobs-ui rerun failed batch-1/);
});
