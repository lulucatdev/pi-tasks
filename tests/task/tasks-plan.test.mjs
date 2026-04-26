import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlanStartingText,
  decoratePlanResultText,
  expandTasksPlan,
  validateTasksPlanInput,
} from "../../extensions/task/tasks-plan.ts";

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
          allowedWritePaths: ["chapters/ch01/**", ".pi/tasks/**"],
        },
      },
      {
        id: "ch02",
        vars: {
          chapter: "02",
          report: "oracle/reports/ch02.md",
          allowedWritePaths: ["chapters/ch02/**", ".pi/tasks/**"],
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

test("validateTasksPlanInput accepts a compact chapter plan", () => {
  assert.doesNotThrow(() => validateTasksPlanInput(chapterPlan()));
});

test("validateTasksPlanInput rejects empty matrix, duplicate ids, and unsafe ids", () => {
  assert.throws(() => validateTasksPlanInput({ batchName: "b", matrix: [], promptTemplate: "p" }), /matrix/);
  assert.throws(() => validateTasksPlanInput({
    batchName: "b",
    matrix: [{ id: "a" }, { id: "a" }],
    promptTemplate: "p",
  }), /duplicate id/);
  assert.throws(() => validateTasksPlanInput({
    batchName: "b",
    matrix: [{ id: "../escape" }],
    promptTemplate: "p",
  }), /letters, numbers/);
  assert.throws(() => validateTasksPlanInput({
    batchName: "b",
    matrix: [{ id: "a", vars: { bad: 5 } }],
    promptTemplate: "p",
  }), /vars\.bad/);
});

test("expandTasksPlan substitutes scalar and array vars and splats list fields", () => {
  const expanded = expandTasksPlan(chapterPlan());
  assert.deepEqual(expanded.rowIds, ["ch01", "ch02"]);
  assert.equal(expanded.taskNames[0], "oracle-chapter-fixes ch01");

  const first = expanded.params.tasks[0];
  assert.equal(first.id, "ch01");
  assert.match(first.prompt, /Edit chapter 01 per oracle\/reports\/ch01\.md\./);
  assert.match(first.prompt, /chapters\/ch01\/\*\*\n\.pi\/tasks\/\*\*/);
  assert.deepEqual(first.acceptance.requiredPaths, ["oracle/reports/ch01.md"]);
  assert.deepEqual(first.acceptance.allowedWritePaths, ["chapters/ch01/**", ".pi/tasks/**"]);
  assert.equal(first.acceptance.requireDeliverablesEvidence, true);
  assert.equal(first.acceptance.minReportSummaryChars, 80);
  assert.equal(first.metadata.chapter, "01");
  assert.equal(first.metadata.report, "oracle/reports/ch01.md");
  assert.equal(first.metadata["tasks_plan.row_id"], "ch01");
  assert.equal(first.metadata["tasks_plan.batch_name"], "oracle-chapter-fixes");

  assert.equal(expanded.params.concurrency, 6);
  assert.equal(expanded.params.tasks.length, 2);
});

test("expandTasksPlan honors row.name and nameTemplate overrides", () => {
  const expanded = expandTasksPlan({
    batchName: "fixes",
    nameTemplate: "Chapter {{chapter}} fix",
    matrix: [
      { id: "ch01", vars: { chapter: "01" } },
      { id: "ch02", name: "Custom Name", vars: { chapter: "02" } },
    ],
    promptTemplate: "Do chapter {{chapter}}.",
  });
  assert.equal(expanded.taskNames[0], "Chapter 01 fix");
  assert.equal(expanded.taskNames[1], "Custom Name");
});

test("expandTasksPlan resolves cwd from row.cwd, then cwdTemplate, then undefined", () => {
  const expanded = expandTasksPlan({
    batchName: "b",
    cwdTemplate: "subprojects/{{id}}",
    matrix: [
      { id: "alpha", cwd: "explicit/path" },
      { id: "beta" },
    ],
    promptTemplate: "Work on {{id}}.",
  });
  assert.equal(expanded.params.tasks[0].cwd, "explicit/path");
  assert.equal(expanded.params.tasks[1].cwd, "subprojects/beta");
});

test("expandTasksPlan rejects templates referencing unknown variables", () => {
  assert.throws(() => expandTasksPlan({
    batchName: "b",
    matrix: [{ id: "row1", vars: { a: "1" } }],
    promptTemplate: "{{a}} and {{missing}}",
  }), /unknown variable \{\{missing\}\}/);
});

test("expandTasksPlan handles PathCheck objects in requiredPaths", () => {
  const expanded = expandTasksPlan({
    batchName: "b",
    matrix: [{ id: "ch01", vars: { chapter: "01", report: "oracle/r/ch01.md" } }],
    promptTemplate: "Edit {{chapter}}.",
    acceptanceTemplate: {
      requiredPaths: [
        { path: "{{report}}", type: "file", minBytes: 100, requiredRegex: ["chapter {{chapter}}"] },
      ],
    },
  });
  const required = expanded.params.tasks[0].acceptance.requiredPaths[0];
  assert.equal(required.path, "oracle/r/ch01.md");
  assert.equal(required.minBytes, 100);
  assert.deepEqual(required.requiredRegex, ["chapter 01"]);
});

test("expandTasksPlan keeps acceptanceDefaults and rerun provenance on the expanded params", () => {
  const expanded = expandTasksPlan({
    batchName: "b",
    matrix: [{ id: "row1" }],
    promptTemplate: "go",
    acceptanceDefaults: { requiredOutputRegex: ["DONE"] },
    parentBatchId: "parent-1",
    rerunOfTaskIds: ["row1"],
  });
  assert.deepEqual(expanded.params.acceptanceDefaults, { requiredOutputRegex: ["DONE"] });
  assert.equal(expanded.params.parentBatchId, "parent-1");
  assert.deepEqual(expanded.params.rerunOfTaskIds, ["row1"]);
});

test("buildPlanStartingText shows compact preview before the supervisor takes over", () => {
  const expanded = expandTasksPlan(chapterPlan());
  const text = buildPlanStartingText(chapterPlan(), expanded, "/repo");
  assert.match(text, /TASKS plan starting · oracle-chapter-fixes · preparing 2 tasks/);
  assert.match(text, /rows: ch01, ch02/);
});

test("decoratePlanResultText appends plan path and synthesis hint", () => {
  const text = decoratePlanResultText(
    "TASKS done · 2✓ / 2",
    "/repo/.pi/tasks/batch-1/plan.json",
    chapterPlan(),
  );
  assert.match(text, /plan: \/repo\/\.pi\/tasks\/batch-1\/plan\.json/);
  assert.match(text, /synthesize per plan instructions/);
});
