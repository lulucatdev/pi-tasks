import test from "node:test";
import assert from "node:assert/strict";

import { deriveFinalOutcome } from "../../extensions/task/decision.ts";
import { emptyAcceptance, emptyWorkerReport } from "../../extensions/task/types.ts";

const runtimeSuccess = { status: "success", exitCode: 0, sawTerminalAssistantMessage: true };
const completedReport = { status: "completed", errors: [], warnings: [] };
const passedAcceptance = { status: "passed", checks: [], warnings: [], errors: [] };

test("deriveFinalOutcome returns structured success when all gates pass", () => {
  const outcome = deriveFinalOutcome({
    runtime: runtimeSuccess,
    workerReport: completedReport,
    protocolKind: "none",
    acceptance: passedAcceptance,
  });

  assert.equal(outcome.finalStatus, "success");
  assert.equal(outcome.blockingGate, "none");
  assert.equal(outcome.failureKind, "none");
  assert.equal(outcome.retryDecision.retryability, "not_retryable");
});

test("deriveFinalOutcome preserves runtime failure as the blocking gate", () => {
  const outcome = deriveFinalOutcome({
    runtime: { status: "error", failureKind: "worker_incomplete", stopReason: "thinking_only_stop", sawTerminalAssistantMessage: false },
    workerReport: emptyWorkerReport("invalid"),
    protocolKind: "worker_incomplete",
    acceptance: emptyAcceptance("skipped"),
  });

  assert.equal(outcome.finalStatus, "error");
  assert.equal(outcome.blockingGate, "runtime");
  assert.equal(outcome.failureKind, "worker_incomplete");
  assert.equal(outcome.retryDecision.retryability, "retryable");
});

test("deriveFinalOutcome separates protocol and acceptance gates", () => {
  const protocol = deriveFinalOutcome({
    runtime: runtimeSuccess,
    workerReport: emptyWorkerReport("invalid"),
    protocolKind: "protocol_error",
    acceptance: emptyAcceptance("skipped"),
  });
  assert.equal(protocol.blockingGate, "protocol");
  assert.equal(protocol.failureKind, "protocol_error");

  const acceptance = deriveFinalOutcome({
    runtime: runtimeSuccess,
    workerReport: completedReport,
    protocolKind: "none",
    acceptance: { status: "failed", checks: [], warnings: [], errors: ["bad"] },
  });
  assert.equal(acceptance.blockingGate, "acceptance");
  assert.equal(acceptance.failureKind, "acceptance_failed");
  assert.equal(acceptance.retryDecision.retryability, "not_retryable");
});
