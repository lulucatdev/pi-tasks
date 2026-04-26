import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { readJsonlTolerant } from "../../extensions/task/audit-log.ts";
import { executeSupervisedTasks } from "../../extensions/task/supervisor.ts";
import { normalizeThrottlePolicy, ThrottleController } from "../../extensions/task/throttle.ts";

test("ThrottleController reduces concurrency when transient failure rate crosses threshold", () => {
  const throttle = new ThrottleController(normalizeThrottlePolicy({ enabled: true, minConcurrency: 1, maxConcurrency: 8, transientFailureThreshold: 0.5, windowSize: 4 }, 8), 8);
  assert.equal(throttle.record("provider_transient"), null);
  assert.equal(throttle.record("none"), null);
  assert.equal(throttle.record("provider_transient"), null);
  const decision = throttle.record("none");
  assert.equal(decision.nextConcurrency, 4);
  assert.equal(decision.previousConcurrency, 8);
});

test("normalizeThrottlePolicy clamps min and max concurrency to the supplied effective cap", () => {
  const policy = normalizeThrottlePolicy({ enabled: true, minConcurrency: 100, maxConcurrency: 100, windowSize: 1 }, 64);
  assert.equal(policy.maxConcurrency, 64);
  assert.equal(policy.minConcurrency, 64);
});

test("ThrottleController recovers concurrency after stable windows", () => {
  const throttle = new ThrottleController(normalizeThrottlePolicy({ enabled: true, minConcurrency: 1, maxConcurrency: 4, transientFailureThreshold: 0.5, windowSize: 2 }, 4), 2);
  throttle.record("none");
  assert.equal(throttle.record("none"), null);
  const decision = throttle.record("none");
  assert.equal(decision.nextConcurrency, 3);
});

test("supervisor records throttle decisions in batch events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-throttle-supervisor-"));
  const result = await executeSupervisedTasks({
    concurrency: 4,
    throttle: { enabled: true, minConcurrency: 1, maxConcurrency: 4, transientFailureThreshold: 0.5, windowSize: 2 },
    tasks: [
      { name: "bad-1", prompt: "x" },
      { name: "bad-2", prompt: "x" },
    ],
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: async (input) => {
      await fs.mkdir(input.paths.attemptDir, { recursive: true });
      return {
        attemptId: input.attemptId,
        taskId: input.task.id,
        status: "error",
        exitCode: 1,
        sawTerminalAssistantMessage: false,
        stderrTail: "terminated",
        stdoutMalformedLines: 0,
        failureKind: "unknown",
        error: "terminated",
        startedAt: "2026-04-26T00:00:00.000Z",
        finishedAt: "2026-04-26T00:00:01.000Z",
      };
    },
    sleep: async () => {},
  });

  const events = await readJsonlTolerant(path.join(result.batch.batchDir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "throttle_decision"));
});
