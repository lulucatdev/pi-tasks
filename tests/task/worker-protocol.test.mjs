import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerPrompt, buildWorkerSystemPrompt, validateTaskReport } from "../../extensions/task/worker-protocol.ts";

const validReport = {
  schemaVersion: 1,
  taskId: "t001",
  attemptId: "t001-a1",
  status: "completed",
  summary: "Completed the task.",
  deliverables: [{ path: "out.md", kind: "file", description: "Output" }],
  evidence: [{ kind: "text", value: "Verified" }],
  internalRetries: [{ reason: "temporary command failure", action: "reran command", outcome: "recovered" }],
  userActionRequired: null,
  error: null,
};

test("validateTaskReport accepts a valid structured report", () => {
  const result = validateTaskReport(validReport, { taskId: "t001", attemptId: "t001-a1" });
  assert.equal(result.ok, true);
  assert.equal(result.report.status, "completed");
  assert.equal(result.report.deliverables[0].path, "out.md");
});

test("validateTaskReport rejects wrong task id and malformed evidence", () => {
  const result = validateTaskReport({ ...validReport, taskId: "wrong", evidence: [{ kind: "file", value: "" }] }, { taskId: "t001" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /taskId must be t001/);
  assert.match(result.errors.join("\n"), /evidence\[0\]\.value/);
});

test("worker prompts require worker.md and task-report.json", () => {
  const system = buildWorkerSystemPrompt();
  assert.match(system, /task-report\.json|task_report/);
  assert.match(system, /only completion protocol/i);
  // The system prompt must explicitly call out the thinking-only failure mode
  // so the model knows ending with only thinking content fails the task.
  assert.match(system, /thinking-only/i);
  assert.match(system, /no task report/i);

  const prompt = buildWorkerPrompt({
    task: { id: "t001", name: "demo", prompt: "Do it", cwd: "/tmp" },
    attemptId: "t001-a1",
    workerLogPath: "/tmp/worker.md",
    reportPath: "/tmp/task-report.json",
  });
  assert.match(prompt, /Worker log path: \/tmp\/worker\.md/);
  assert.match(prompt, /Task report path: \/tmp\/task-report\.json/);
  assert.match(prompt, /"taskId": "t001"/);
  // Per-task body must mention the submission protocol and the no-thinking-only rule.
  assert.match(prompt, /Submission protocol/);
  assert.match(prompt, /thinking-only/i);
});
