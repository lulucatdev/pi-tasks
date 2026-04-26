import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildTaskReportToolDefinition, submitTaskReport } from "../../extensions/task/task-report-tool.ts";

test("submitTaskReport writes a validated report to PI_TASK_REPORT_PATH", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-report-tool-"));
  const reportPath = path.join(root, "task-report.json");
  const result = await submitTaskReport({
    taskId: "t001",
    attemptId: "t001-a1",
    status: "completed",
    summary: "Done",
    deliverables: [],
    evidence: [],
  }, { PI_TASK_REPORT_PATH: reportPath });

  assert.equal(result.ok, true);
  const report = JSON.parse(await fs.readFile(reportPath, "utf-8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "completed");
});

test("submitTaskReport rejects ids that do not match supervisor environment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-report-wrong-id-"));
  const reportPath = path.join(root, "task-report.json");
  const result = await submitTaskReport({
    taskId: "wrong",
    attemptId: "wrong-a1",
    status: "completed",
    summary: "Done",
    deliverables: [],
    evidence: [],
  }, { PI_TASK_REPORT_PATH: reportPath, PI_TASK_ID: "t001", PI_TASK_ATTEMPT_ID: "t001-a1" });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("taskId must be t001")));
  await assert.rejects(() => fs.stat(reportPath));
});

test("submitTaskReport rejects invalid reports before writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-report-bad-"));
  const reportPath = path.join(root, "task-report.json");
  const result = await submitTaskReport({
    taskId: "t001",
    attemptId: "t001-a1",
    status: "bad",
    summary: "Done",
    deliverables: [],
    evidence: [],
  }, { PI_TASK_REPORT_PATH: reportPath });

  assert.equal(result.ok, false);
  await assert.rejects(() => fs.stat(reportPath));
});

test("buildTaskReportToolDefinition exposes required report fields", () => {
  const definition = buildTaskReportToolDefinition();
  assert.equal(definition.name, "task_report");
  assert.ok(definition.parameters.required.includes("taskId"));
  assert.ok(definition.parameters.required.includes("status"));
  assert.equal(definition.parameters.properties.deliverables.items.type, "object");
  assert.equal(definition.parameters.properties.evidence.items.type, "object");
  assert.equal(definition.parameters.properties.internalRetries.items.type, "object");
});
