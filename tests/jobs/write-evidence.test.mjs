import test from "node:test";
import assert from "node:assert/strict";

import {
  auditableWritePaths,
  isSupervisorArtifactPath,
  mergeWriteEvidence,
  writeEvidenceFromGitDiff,
  writeEvidenceFromTelemetry,
} from "../../extensions/jobs/write-evidence.ts";

test("write evidence normalizes sources and excludes supervisor artifacts", () => {
  const evidence = mergeWriteEvidence([
    ...writeEvidenceFromGitDiff(["src/out.md", ".pi/jobs/batch/attempts/t001/attempt-1/worker.md"], { jobId: "t001" }),
    ...writeEvidenceFromTelemetry(["src/out.md", ".pi/jobs/batch/attempts/t001/attempt-1/job-report.json"], { jobId: "t001", attemptId: "t001-a1" }),
  ]);

  assert.equal(isSupervisorArtifactPath(".pi/jobs/batch/attempts/t001/attempt-1/worker.md"), true);
  assert.deepEqual(auditableWritePaths(evidence), ["src/out.md"]);
  assert.ok(evidence.some((item) => item.source === "worker_telemetry" && item.confidence === "high"));
  assert.ok(evidence.some((item) => item.ignored && item.reason === "supervisor_artifact"));
});
