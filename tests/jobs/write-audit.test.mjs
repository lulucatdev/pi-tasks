import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAcceptance } from "../../extensions/jobs/acceptance.ts";
import { buildWorkerEvent, observedWritePaths } from "../../extensions/jobs/worker-events.ts";

test("observedWritePaths extracts file write telemetry paths without raw args", () => {
  const events = [
    buildWorkerEvent({ type: "file_write_observed", jobId: "t001", attemptId: "t001-a1", path: "allowed/out.md", args: { token: "secret" } }),
    buildWorkerEvent({ type: "progress", jobId: "t001", attemptId: "t001-a1", message: "working" }),
  ];
  assert.deepEqual(observedWritePaths(events), ["allowed/out.md"]);
  assert.equal(events[0].argsPreview, '{"token":"[REDACTED]"}');
});

test("acceptance fails write-boundary contracts when audit is unavailable", async () => {
  const result = await evaluateAcceptance({
    cwd: "/tmp/project",
    writeAuditAvailable: false,
    contract: { allowedWritePaths: ["allowed/**"] },
  });

  assert.equal(result.status, "failed");
  assert.ok(result.errors.some((error) => error.includes("requires write audit")));
});

test("acceptance checks telemetry write paths against allowlist", async () => {
  const result = await evaluateAcceptance({
    cwd: "/tmp/project",
    observedWritePaths: ["allowed/out.md", "outside/secret.md"],
    contract: { allowedWritePaths: ["allowed/**"] },
  });

  assert.equal(result.status, "failed");
  assert.ok(result.errors.some((error) => error.includes("outside allowed")));
});

test("acceptance checks telemetry write paths against forbidden list", async () => {
  const result = await evaluateAcceptance({
    cwd: "/tmp/project",
    observedWritePaths: ["secret/token.txt"],
    contract: { forbiddenWritePaths: ["secret/**"] },
  });

  assert.equal(result.status, "failed");
  assert.ok(result.errors.some((error) => error.includes("forbidden pattern")));
});
