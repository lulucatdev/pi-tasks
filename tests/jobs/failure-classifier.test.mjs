import test from "node:test";
import assert from "node:assert/strict";

import { classifyAndDecide, classifyRuntimeFailure, retryDecisionForFailure } from "../../extensions/jobs/failure-classifier.ts";

test("classifyRuntimeFailure marks launch errors as retryable launch failures", () => {
  const decision = classifyAndDecide({ status: "error", failureKind: "launch_error", stderrTail: "spawn failed" });
  assert.equal(decision.failureKind, "launch_error");
  assert.equal(decision.retryability, "retryable");
});

test("classifyRuntimeFailure detects provider transient text", () => {
  assert.equal(classifyRuntimeFailure({ status: "error", stderrTail: "400 Internal server error: overloaded" }), "provider_transient");
  assert.equal(classifyAndDecide({ status: "error", stderrTail: "terminated" }).retryability, "retryable");
});

test("classifyRuntimeFailure detects permanent provider/auth errors", () => {
  const decision = classifyAndDecide({ status: "error", stderrTail: "Unauthorized: invalid API key" });
  assert.equal(decision.failureKind, "provider_permanent");
  assert.equal(decision.retryability, "not_retryable");
});

test("protocol and acceptance failures are not parent retryable", () => {
  assert.equal(retryDecisionForFailure("protocol_error").retryability, "not_retryable");
  assert.equal(retryDecisionForFailure("acceptance_failed").retryability, "not_retryable");
});
