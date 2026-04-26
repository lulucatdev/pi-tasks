import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { executeSupervisedTasks } from "../../extensions/task/supervisor.ts";

const fakePi = path.resolve("tests/task/fixtures/fake-pi.mjs");

function fakePiSpawn(scenario) {
  return (_command, _args, options) => spawn(process.execPath, [fakePi], {
    cwd: options.cwd,
    stdio: options.stdio,
    env: { ...process.env, ...(options.env ?? {}), FAKE_PI_SCENARIO: scenario },
  });
}

async function runScenario(scenario, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pi-int-${scenario}-`));
  return executeSupervisedTasks({
    retry: { maxAttempts: 1, backoffMs: { initial: 0, max: 0, multiplier: 1, jitter: false } },
    tasks: [{ name: scenario, prompt: `Run ${scenario}`, acceptance: extra.acceptance }],
  }, { cwd: root, toolName: "tasks" }, {
    runAttempt: (input) => import("../../extensions/task/worker-runner.ts").then(({ runWorkerAttempt }) => runWorkerAttempt({ ...input, piCommand: "fake-pi", spawnImpl: fakePiSpawn(scenario) })),
    sleep: async () => {},
  });
}

test("fake child completed scenario succeeds", async () => {
  const result = await runScenario("completed");
  assert.equal(result.batch.status, "success");
  assert.equal(result.tasks[0].workerReport.status, "completed");
});

test("fake child blocked and invalid scenarios become protocol/worker errors", async () => {
  const blocked = await runScenario("blocked");
  assert.equal(blocked.batch.status, "error");
  assert.equal(blocked.tasks[0].workerReport.status, "blocked");

  const invalid = await runScenario("invalid-json");
  assert.equal(invalid.batch.status, "error");
  assert.equal(invalid.tasks[0].failureKind, "protocol_error");
});

test("fake child provider transient scenario is classified", async () => {
  const result = await runScenario("provider-500");
  assert.equal(result.batch.status, "error");
  assert.equal(result.tasks[0].failureKind, "provider_transient");
});

test("fake child malformed stdout keeps warning but can succeed", async () => {
  const result = await runScenario("malformed-stdout");
  assert.equal(result.batch.status, "success");
  assert.ok(result.tasks[0].attempts[0].warnings.some((warning) => warning.includes("Malformed")));
});

test("fake child delayed scenario can be aborted", async () => {
  const controller = new AbortController();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-int-delayed-"));
  const promise = executeSupervisedTasks({ tasks: [{ name: "delayed", prompt: "Run delayed" }] }, { cwd: root, toolName: "tasks", signal: controller.signal }, {
    runAttempt: (input) => import("../../extensions/task/worker-runner.ts").then(({ runWorkerAttempt }) => runWorkerAttempt({ ...input, piCommand: "fake-pi", spawnImpl: fakePiSpawn("delayed") })),
  });
  setTimeout(() => controller.abort(), 20);
  const result = await promise;
  assert.equal(result.tasks[0].finalStatus, "aborted");
});
