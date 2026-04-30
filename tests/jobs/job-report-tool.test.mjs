import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildJobReportToolDefinition, submitJobReport } from "../../extensions/jobs/job-report-tool.ts";

test("submitJobReport writes a validated report to PI_JOB_REPORT_PATH", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-report-tool-"));
  const reportPath = path.join(root, "job-report.json");
  const result = await submitJobReport({
    jobId: "t001",
    attemptId: "t001-a1",
    status: "completed",
    summary: "Done",
    deliverables: [],
    evidence: [],
  }, { PI_JOB_REPORT_PATH: reportPath });

  assert.equal(result.ok, true);
  const report = JSON.parse(await fs.readFile(reportPath, "utf-8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "completed");
});

test("submitJobReport rejects ids that do not match supervisor environment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-report-wrong-id-"));
  const reportPath = path.join(root, "job-report.json");
  const result = await submitJobReport({
    jobId: "wrong",
    attemptId: "wrong-a1",
    status: "completed",
    summary: "Done",
    deliverables: [],
    evidence: [],
  }, { PI_JOB_REPORT_PATH: reportPath, PI_JOB_ID: "t001", PI_JOB_ATTEMPT_ID: "t001-a1" });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("jobId must be t001")));
  await assert.rejects(() => fs.stat(reportPath));
});

test("submitJobReport rejects invalid reports before writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-job-report-bad-"));
  const reportPath = path.join(root, "job-report.json");
  const result = await submitJobReport({
    jobId: "t001",
    attemptId: "t001-a1",
    status: "bad",
    summary: "Done",
    deliverables: [],
    evidence: [],
  }, { PI_JOB_REPORT_PATH: reportPath });

  assert.equal(result.ok, false);
  await assert.rejects(() => fs.stat(reportPath));
});

test("buildJobReportToolDefinition exposes required report fields", () => {
  const definition = buildJobReportToolDefinition();
  assert.equal(definition.name, "job_report");
  assert.ok(definition.parameters.required.includes("jobId"));
  assert.ok(definition.parameters.required.includes("status"));
  assert.equal(definition.parameters.properties.deliverables.items.type, "object");
  assert.equal(definition.parameters.properties.evidence.items.type, "object");
  assert.equal(definition.parameters.properties.internalRetries.items.type, "object");
});
