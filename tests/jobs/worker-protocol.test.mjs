import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerPrompt, buildWorkerSystemPrompt, validateJobReport } from "../../extensions/jobs/worker-protocol.ts";

const validReport = {
  schemaVersion: 1,
  jobId: "t001",
  attemptId: "t001-a1",
  status: "completed",
  summary: "Completed the job.",
  deliverables: [{ path: "out.md", kind: "file", description: "Output" }],
  evidence: [{ kind: "text", value: "Verified" }],
  internalRetries: [{ reason: "temporary command failure", action: "reran command", outcome: "recovered" }],
  userActionRequired: null,
  error: null,
};

test("validateJobReport accepts a valid structured report", () => {
  const result = validateJobReport(validReport, { jobId: "t001", attemptId: "t001-a1" });
  assert.equal(result.ok, true);
  assert.equal(result.report.status, "completed");
  assert.equal(result.report.deliverables[0].path, "out.md");
});

test("validateJobReport rejects wrong job id and malformed evidence", () => {
  const result = validateJobReport({ ...validReport, jobId: "wrong", evidence: [{ kind: "file", value: "" }] }, { jobId: "t001" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /jobId must be t001/);
  assert.match(result.errors.join("\n"), /evidence\[0\]\.value/);
});

test("worker prompts require worker.md and job-report.json", () => {
  const system = buildWorkerSystemPrompt();
  assert.match(system, /job-report\.json|job_report/);
  assert.match(system, /only completion protocol/i);
  // The system prompt must explicitly call out the thinking-only failure mode
  // so the model knows ending with only thinking content fails the job.
  assert.match(system, /thinking-only/i);
  assert.match(system, /no job report/i);

  const prompt = buildWorkerPrompt({
    job: { id: "t001", name: "demo", prompt: "Do it", cwd: "/tmp" },
    attemptId: "t001-a1",
    workerLogPath: "/tmp/worker.md",
    reportPath: "/tmp/job-report.json",
  });
  assert.match(prompt, /Worker log path: \/tmp\/worker\.md/);
  assert.match(prompt, /Job report path: \/tmp\/job-report\.json/);
  assert.match(prompt, /"jobId": "t001"/);
  // Per-job body must mention the submission protocol and the no-thinking-only rule.
  assert.match(prompt, /Submission protocol/);
  assert.match(prompt, /thinking-only/i);
});
