import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { evaluateAcceptance, matchesPathPattern } from "../../extensions/task/acceptance.ts";

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "t001",
    attemptId: "t001-a1",
    status: "completed",
    summary: "Completed with enough detail.",
    deliverables: [{ path: "out.md", kind: "file" }],
    evidence: [{ kind: "file", value: "out.md" }],
    ...overrides,
  };
}

test("evaluateAcceptance passes required paths, regex, and deliverable evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-"));
  await fs.writeFile(path.join(root, "out.md"), "Chapter 05 delivery\n", "utf-8");

  const result = await evaluateAcceptance({
    cwd: root,
    workerLog: "All done. Verification passed.",
    report: report(),
    changedFiles: ["out.md"],
    contract: {
      requiredPaths: [{ path: "out.md", minBytes: 10, requiredRegex: ["Chapter 05"] }],
      requiredOutputRegex: ["Verification"],
      requiredReportRegex: ["Completed"],
      allowedWritePaths: ["out.md"],
      requireDeliverablesEvidence: true,
    },
  });

  assert.equal(result.status, "passed");
});

test("evaluateAcceptance passes required glob paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-glob-"));
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "app.js"), "console.log('ok')\n", "utf-8");

  const result = await evaluateAcceptance({
    cwd: root,
    workerLog: "done",
    report: report(),
    contract: { requiredPaths: [{ path: "dist/*.js", type: "glob", minBytes: 10, requiredRegex: ["console"] }] },
  });

  assert.equal(result.status, "passed");
});

test("evaluateAcceptance fails missing required files and forbidden output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-fail-"));
  const result = await evaluateAcceptance({
    cwd: root,
    workerLog: "TODO: started only",
    report: report({ summary: "short" }),
    contract: {
      requiredPaths: ["missing.md"],
      forbiddenOutputRegex: ["TODO"],
      minReportSummaryChars: 20,
    },
  });

  assert.equal(result.status, "failed");
  assert.ok(result.errors.some((error) => error.includes("missing.md")));
  assert.ok(result.errors.some((error) => error.includes("Forbidden regex")));
});

test("evaluateAcceptance handles inline case-insensitive regex flags and invalid regexes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-regex-"));
  await fs.writeFile(path.join(root, "out.md"), "No repository modifications were made.\n", "utf-8");

  const ok = await evaluateAcceptance({
    cwd: root,
    workerLog: "No repository modifications were made.",
    report: report(),
    contract: {
      requiredPaths: [{ path: "out.md", requiredRegex: ["(?i)no repository modifications"] }],
      requiredOutputRegex: ["(?i)no repository modifications"],
    },
  });
  assert.equal(ok.status, "passed");

  const invalid = await evaluateAcceptance({
    cwd: root,
    workerLog: "done",
    report: report(),
    contract: { requiredOutputRegex: ["["] },
  });
  assert.equal(invalid.status, "failed");
  assert.ok(invalid.errors.some((error) => error.includes("Invalid required regex")));
});

test("matchesPathPattern supports exact, glob, and trailing-slash directory allowlist patterns", () => {
  assert.equal(matchesPathPattern("allowed/out.md", "allowed/"), true);
  assert.equal(matchesPathPattern("allowed/nested/out.md", "allowed/"), true);
  assert.equal(matchesPathPattern("allowed/out.md", "allowed/**"), true);
  assert.equal(matchesPathPattern("allowed/out.md", "allowed/out.md"), true);
  assert.equal(matchesPathPattern("allowed/out.md", "allowed"), false);
  assert.equal(matchesPathPattern("allowedness/out.md", "allowed/"), false);
});

test("evaluateAcceptance audits changed files against write allowlist and forbidden paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-write-"));
  const result = await evaluateAcceptance({
    cwd: root,
    workerLog: "done",
    report: report(),
    changedFiles: ["allowed/out.md", "secret/token.txt"],
    contract: {
      allowedWritePaths: ["allowed/"],
      forbiddenWritePaths: ["secret/"],
    },
  });

  assert.equal(result.status, "failed");
  assert.ok(result.errors.some((error) => error.includes("secret/token.txt")));
  assert.ok(result.errors.some((error) => error.includes("outside allowed")));
});

test("evaluateAcceptance ignores supervisor protocol artifacts in write-boundary checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-artifacts-"));
  const result = await evaluateAcceptance({
    cwd: root,
    workerLog: "done",
    report: report(),
    changedFiles: ["src/out.md"],
    observedWritePaths: [
      "src/telemetry.md",
      ".pi/tasks/2026-04-27T00-00-00-000Z-test/attempts/t001/attempt-1/worker.md",
      ".pi/tasks/2026-04-27T00-00-00-000Z-test/attempts/t001/attempt-1/task-report.json",
    ],
    contract: { allowedWritePaths: ["src/"] },
  });

  assert.equal(result.status, "passed");
});

test("evaluateAcceptance can downgrade failures to warnings in auditOnly mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-acceptance-warning-"));
  const result = await evaluateAcceptance({
    cwd: root,
    workerLog: "done",
    report: report(),
    contract: { requiredPaths: ["missing.md"], auditOnly: true },
  });

  assert.equal(result.status, "warning");
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.length > 0);
});
