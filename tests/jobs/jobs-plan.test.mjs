import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlanStartingText,
  decoratePlanResultText,
  expandJobsPlan,
  validateJobsPlanInput,
} from "../../extensions/jobs/jobs-plan.ts";

function chapterPlan() {
  return {
    batchName: "oracle-chapter-fixes",
    concurrency: 6,
    matrix: [
      {
        id: "ch01",
        vars: {
          chapter: "01",
          report: "oracle/reports/ch01.md",
          allowedWritePaths: ["chapters/ch01/**", ".pi/jobs/**"],
        },
      },
      {
        id: "ch02",
        vars: {
          chapter: "02",
          report: "oracle/reports/ch02.md",
          allowedWritePaths: ["chapters/ch02/**", ".pi/jobs/**"],
        },
      },
    ],
    promptTemplate: "Edit chapter {{chapter}} per {{report}}.\nAllowed write roots:\n{{allowedWritePaths}}",
    acceptanceTemplate: {
      requiredPaths: ["{{report}}"],
      allowedWritePaths: ["{{allowedWritePaths}}"],
      requireDeliverablesEvidence: true,
      minReportSummaryChars: 80,
    },
    metadataTemplate: { chapter: "{{chapter}}", report: "{{report}}" },
    synthesis: { mode: "parent", instructions: "Summarize per-chapter outcomes." },
  };
}

test("validateJobsPlanInput accepts a compact chapter plan", () => {
  assert.doesNotThrow(() => validateJobsPlanInput(chapterPlan()));
});

test("validateJobsPlanInput rejects unknown fields so jobs_plan stays a compact transport DSL", () => {
  assert.throws(() => validateJobsPlanInput({
    batchName: "b",
    matrix: [{ id: "a" }],
    promptTemplate: "p",
    conditionals: [{ if: "x" }],
  }), /not supported.*frozen/);
  assert.throws(() => validateJobsPlanInput({
    batchName: "b",
    matrix: [{ id: "a", dependsOn: ["other"] }],
    promptTemplate: "p",
  }), /matrix\[0\]\.dependsOn is not supported/);
  assert.throws(() => validateJobsPlanInput({
    batchName: "b",
    matrix: [{ id: "a" }],
    promptTemplate: "p",
    synthesis: { mode: "parent", steps: ["do more"] },
  }), /synthesis\.steps is not supported/);
});

test("validateJobsPlanInput rejects empty matrix, duplicate ids, and unsafe ids", () => {
  assert.throws(() => validateJobsPlanInput({ batchName: "b", matrix: [], promptTemplate: "p" }), /matrix/);
  assert.throws(() => validateJobsPlanInput({
    batchName: "b",
    matrix: [{ id: "a" }, { id: "a" }],
    promptTemplate: "p",
  }), /duplicate id/);
  assert.throws(() => validateJobsPlanInput({
    batchName: "b",
    matrix: [{ id: "../escape" }],
    promptTemplate: "p",
  }), /letters, numbers/);
  assert.throws(() => validateJobsPlanInput({
    batchName: "b",
    matrix: [{ id: "a", vars: { bad: 5 } }],
    promptTemplate: "p",
  }), /vars\.bad/);
});

test("expandJobsPlan substitutes scalar and array vars and splats list fields", () => {
  const expanded = expandJobsPlan(chapterPlan());
  assert.deepEqual(expanded.rowIds, ["ch01", "ch02"]);
  assert.equal(expanded.jobNames[0], "oracle-chapter-fixes ch01");

  const first = expanded.params.jobs[0];
  assert.equal(first.id, "ch01");
  assert.match(first.prompt, /Edit chapter 01 per oracle\/reports\/ch01\.md\./);
  assert.match(first.prompt, /chapters\/ch01\/\*\*\n\.pi\/jobs\/\*\*/);
  assert.deepEqual(first.acceptance.requiredPaths, ["oracle/reports/ch01.md"]);
  assert.deepEqual(first.acceptance.allowedWritePaths, ["chapters/ch01/**", ".pi/jobs/**"]);
  assert.equal(first.acceptance.requireDeliverablesEvidence, true);
  assert.equal(first.acceptance.minReportSummaryChars, 80);
  assert.equal(first.metadata.chapter, "01");
  assert.equal(first.metadata.report, "oracle/reports/ch01.md");
  assert.equal(first.metadata["jobs_plan.row_id"], "ch01");
  assert.equal(first.metadata["jobs_plan.batch_name"], "oracle-chapter-fixes");

  assert.equal(expanded.params.concurrency, 6);
  assert.equal(expanded.params.jobs.length, 2);
});

test("expandJobsPlan honors row.name and nameTemplate overrides", () => {
  const expanded = expandJobsPlan({
    batchName: "fixes",
    nameTemplate: "Chapter {{chapter}} fix",
    matrix: [
      { id: "ch01", vars: { chapter: "01" } },
      { id: "ch02", name: "Custom Name", vars: { chapter: "02" } },
    ],
    promptTemplate: "Do chapter {{chapter}}.",
  });
  assert.equal(expanded.jobNames[0], "Chapter 01 fix");
  assert.equal(expanded.jobNames[1], "Custom Name");
});

test("expandJobsPlan resolves cwd from row.cwd, then cwdTemplate, then undefined", () => {
  const expanded = expandJobsPlan({
    batchName: "b",
    cwdTemplate: "subprojects/{{id}}",
    matrix: [
      { id: "alpha", cwd: "explicit/path" },
      { id: "beta" },
    ],
    promptTemplate: "Work on {{id}}.",
  });
  assert.equal(expanded.params.jobs[0].cwd, "explicit/path");
  assert.equal(expanded.params.jobs[1].cwd, "subprojects/beta");
});

test("expandJobsPlan rejects templates referencing unknown variables", () => {
  assert.throws(() => expandJobsPlan({
    batchName: "b",
    matrix: [{ id: "row1", vars: { a: "1" } }],
    promptTemplate: "{{a}} and {{missing}}",
  }), /unknown variable \{\{missing\}\}/);
});

test("expandJobsPlan handles PathCheck objects in requiredPaths", () => {
  const expanded = expandJobsPlan({
    batchName: "b",
    matrix: [{ id: "ch01", vars: { chapter: "01", report: "oracle/r/ch01.md" } }],
    promptTemplate: "Edit {{chapter}}.",
    acceptanceTemplate: {
      requiredPaths: [
        { path: "{{report}}", type: "file", minBytes: 100, requiredRegex: ["chapter {{chapter}}"] },
      ],
    },
  });
  const required = expanded.params.jobs[0].acceptance.requiredPaths[0];
  assert.equal(required.path, "oracle/r/ch01.md");
  assert.equal(required.minBytes, 100);
  assert.deepEqual(required.requiredRegex, ["chapter 01"]);
});

test("expandJobsPlan keeps acceptanceDefaults and rerun provenance on the expanded params", () => {
  const expanded = expandJobsPlan({
    batchName: "b",
    matrix: [{ id: "row1" }],
    promptTemplate: "go",
    acceptanceDefaults: { requiredOutputRegex: ["DONE"] },
    parentBatchId: "parent-1",
    rerunOfJobIds: ["row1"],
  });
  assert.deepEqual(expanded.params.acceptanceDefaults, { requiredOutputRegex: ["DONE"] });
  assert.equal(expanded.params.parentBatchId, "parent-1");
  assert.deepEqual(expanded.params.rerunOfJobIds, ["row1"]);
});

test("buildPlanStartingText shows compact preview before the supervisor takes over", () => {
  const expanded = expandJobsPlan(chapterPlan());
  const text = buildPlanStartingText(chapterPlan(), expanded, "/repo");
  assert.match(text, /JOBS plan starting · oracle-chapter-fixes · preparing 2 jobs/);
  assert.match(text, /rows: ch01, ch02/);
});

test("decoratePlanResultText appends plan path and synthesis hint", () => {
  const text = decoratePlanResultText(
    "JOBS done · 2✓ / 2",
    "/repo/.pi/jobs/batch-1/plan.json",
    chapterPlan(),
  );
  assert.match(text, /plan: \/repo\/\.pi\/jobs\/batch-1\/plan\.json/);
  assert.match(text, /synthesize per plan instructions/);
});
