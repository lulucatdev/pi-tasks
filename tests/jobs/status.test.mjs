import test from "node:test";
import assert from "node:assert/strict";

import { deriveJobFinalStatus, emptyAcceptance, emptyWorkerReport } from "../../extensions/jobs/types.ts";

test("deriveJobFinalStatus requires runtime success, completed report, acceptance, and audit ok", () => {
  assert.equal(
    deriveJobFinalStatus({
      runtime: "success",
      workerReport: "completed",
      acceptance: "passed",
      auditIntegrity: "ok",
    }),
    "success",
  );
});

test("deriveJobFinalStatus maps runtime abort to aborted", () => {
  assert.equal(
    deriveJobFinalStatus({
      runtime: "aborted",
      workerReport: "completed",
      acceptance: "passed",
      auditIntegrity: "ok",
    }),
    "aborted",
  );
});

test("deriveJobFinalStatus rejects runtime, worker, acceptance, and audit failures", () => {
  assert.equal(deriveJobFinalStatus({ runtime: "error", workerReport: "completed", acceptance: "passed", auditIntegrity: "ok" }), "error");
  assert.equal(deriveJobFinalStatus({ runtime: "success", workerReport: "partial", acceptance: "passed", auditIntegrity: "ok" }), "error");
  assert.equal(deriveJobFinalStatus({ runtime: "success", workerReport: "completed", acceptance: "failed", auditIntegrity: "ok" }), "error");
  assert.equal(deriveJobFinalStatus({ runtime: "success", workerReport: "completed", acceptance: "passed", auditIntegrity: "failed" }), "error");
});

test("status derivation accepts structured outcome objects", () => {
  assert.equal(
    deriveJobFinalStatus({
      runtime: { status: "success", exitCode: 0 },
      workerReport: emptyWorkerReport("completed"),
      acceptance: emptyAcceptance("warning"),
      auditIntegrity: "ok",
    }),
    "success",
  );
});
