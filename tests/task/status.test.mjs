import test from "node:test";
import assert from "node:assert/strict";

import { deriveTaskFinalStatus, emptyAcceptance, emptyWorkerReport } from "../../extensions/task/types.ts";

test("deriveTaskFinalStatus requires runtime success, completed report, acceptance, and audit ok", () => {
  assert.equal(
    deriveTaskFinalStatus({
      runtime: "success",
      workerReport: "completed",
      acceptance: "passed",
      auditIntegrity: "ok",
    }),
    "success",
  );
});

test("deriveTaskFinalStatus maps runtime abort to aborted", () => {
  assert.equal(
    deriveTaskFinalStatus({
      runtime: "aborted",
      workerReport: "completed",
      acceptance: "passed",
      auditIntegrity: "ok",
    }),
    "aborted",
  );
});

test("deriveTaskFinalStatus rejects runtime, worker, acceptance, and audit failures", () => {
  assert.equal(deriveTaskFinalStatus({ runtime: "error", workerReport: "completed", acceptance: "passed", auditIntegrity: "ok" }), "error");
  assert.equal(deriveTaskFinalStatus({ runtime: "success", workerReport: "partial", acceptance: "passed", auditIntegrity: "ok" }), "error");
  assert.equal(deriveTaskFinalStatus({ runtime: "success", workerReport: "completed", acceptance: "failed", auditIntegrity: "ok" }), "error");
  assert.equal(deriveTaskFinalStatus({ runtime: "success", workerReport: "completed", acceptance: "passed", auditIntegrity: "failed" }), "error");
});

test("status derivation accepts structured outcome objects", () => {
  assert.equal(
    deriveTaskFinalStatus({
      runtime: { status: "success", exitCode: 0 },
      workerReport: emptyWorkerReport("completed"),
      acceptance: emptyAcceptance("warning"),
      auditIntegrity: "ok",
    }),
    "success",
  );
});
