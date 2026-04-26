import test from "node:test";
import assert from "node:assert/strict";

import { retryDecisionForFailure } from "../../extensions/task/failure-classifier.ts";
import { buildWorkerEvent, detectWorkerStall } from "../../extensions/task/worker-events.ts";

const now = Date.parse("2026-04-26T00:10:00.000Z");

test("detectWorkerStall returns unknown when no events exist", () => {
  assert.equal(detectWorkerStall([], now, 1000), "unknown_stall");
});

test("detectWorkerStall classifies stale heartbeats as worker stalled", () => {
  const events = [buildWorkerEvent({ type: "heartbeat", taskId: "t001", attemptId: "t001-a1", at: "2026-04-26T00:00:00.000Z" })];
  assert.equal(detectWorkerStall(events, now, 1000), "worker_stalled");
});

test("detectWorkerStall classifies stale in-flight tool calls as provider stalled", () => {
  const events = [buildWorkerEvent({ type: "tool_call_started", taskId: "t001", attemptId: "t001-a1", tool: "bash", at: "2026-04-26T00:00:00.000Z" })];
  assert.equal(detectWorkerStall(events, now, 1000), "provider_stalled");
});

test("stall retry policy is strict", () => {
  assert.equal(retryDecisionForFailure("provider_stalled").retryability, "retryable");
  assert.equal(retryDecisionForFailure("worker_stalled").retryability, "retryable");
  assert.equal(retryDecisionForFailure("unknown_stall").retryability, "not_retryable");
});
