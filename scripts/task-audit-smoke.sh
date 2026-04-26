#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeSupervisedTasks } from "./extensions/task/supervisor.ts";
import { readJsonlTolerant } from "./extensions/task/audit-log.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-smoke-"));
await fs.writeFile(path.join(root, "required.md"), "required content", "utf-8");

const scenarios = new Map([
  ["ok", "success"],
  ["acceptance", "success"],
  ["blocked", "blocked"],
  ["transient", "transient"],
  ["invalid", "invalid"],
]);

const result = await executeSupervisedTasks({
  concurrency: 3,
  retry: { maxAttempts: 1, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
  tasks: [...scenarios.keys()].map((name) => ({
    name,
    prompt: `Run ${name}`,
    acceptance: name === "acceptance" ? { requiredPaths: ["required.md"] } : undefined,
  })),
}, { cwd: root, toolName: "tasks" }, {
  runAttempt: async (input) => {
    const scenario = scenarios.get(input.task.name);
    await fs.mkdir(input.paths.attemptDir, { recursive: true });
    await fs.writeFile(input.paths.workerLogPath, `${scenario} log`, "utf-8");
    if (scenario === "transient") {
      return { attemptId: input.attemptId, taskId: input.task.id, status: "error", exitCode: 1, sawTerminalAssistantMessage: false, stderrTail: "500 Internal server error", stdoutMalformedLines: 0, failureKind: "unknown", error: "500 Internal server error", startedAt: "start", finishedAt: "finish" };
    }
    if (scenario === "invalid") {
      await fs.writeFile(input.paths.reportPath, "{bad", "utf-8");
    } else {
      await fs.writeFile(input.paths.reportPath, JSON.stringify({ schemaVersion: 1, taskId: input.task.id, attemptId: input.attemptId, status: scenario === "blocked" ? "blocked" : "completed", summary: `${scenario} summary`, deliverables: [], evidence: [] }), "utf-8");
    }
    return { attemptId: input.attemptId, taskId: input.task.id, status: "success", exitCode: 0, sawTerminalAssistantMessage: true, stderrTail: "", stdoutMalformedLines: 0, failureKind: "none", error: null, startedAt: "start", finishedAt: "finish" };
  },
});

assert.equal(result.tasks.length, 5);
assert.equal(result.batch.summary.success, 2);
assert.equal(result.batch.summary.error, 3);
assert.ok(await fs.stat(path.join(result.batch.batchDir, "batch.json")));
assert.ok(await fs.stat(path.join(result.batch.batchDir, "summary.md")));
assert.ok(await fs.stat(path.join(result.batch.batchDir, "tasks", "t001.json")));
const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
assert.ok(events.some((event) => event.type === "batch_finished"));
console.log(`task audit smoke ok: ${result.batch.batchDir}`);
NODE
