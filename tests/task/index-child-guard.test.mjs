import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

import taskWorkerRuntime from "../../extensions/task/task-worker-runtime.ts";
import { registerTaskReportTool } from "../../extensions/task/task-report-tool.ts";

function makePiHarness() {
  const tools = [];
  const commands = [];
  const handlers = [];
  return {
    tools,
    commands,
    handlers,
    pi: {
      registerTool(tool) { tools.push(tool); },
      registerCommand(name, options) { commands.push({ name, options }); },
      on(event, handler) { handlers.push({ event, handler }); },
      getThinkingLevel() { return "off"; },
    },
  };
}

async function withEnv(values, fn) {
  const keys = Object.keys(values);
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of keys) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("root task extension returns before registering tools in child worker mode", async () => {
  const source = await fs.readFile(new URL("../../extensions/task/index.ts", import.meta.url), "utf-8");
  const childGuard = source.indexOf("if (process.env.PI_CHILD_TYPE) return;");
  const firstRegisterTaskReport = source.indexOf("registerTaskReportTool(pi)");
  const firstRegisterTaskTool = source.indexOf('name: "task"');
  const firstRegisterTasksTool = source.indexOf('name: "tasks"');
  const firstRegisterTasksPlanTool = source.indexOf('name: "tasks_plan"');

  assert.ok(childGuard !== -1, "index.ts must guard child workers before root registration");
  assert.ok(childGuard < firstRegisterTaskReport, "child guard must run before task_report registration in root extension");
  assert.ok(childGuard < firstRegisterTaskTool, "child guard must run before task tool registration");
  assert.ok(childGuard < firstRegisterTasksTool, "child guard must run before tasks tool registration");
  assert.ok(childGuard < firstRegisterTasksPlanTool, "child guard must run before tasks_plan tool registration");
});

test("worker runtime registers only task_report when child marker and report path are present", async () => {
  await withEnv({ PI_CHILD_TYPE: "task-worker", PI_TASK_REPORT_PATH: "/tmp/task-report.json" }, () => {
    const h = makePiHarness();
    taskWorkerRuntime(h.pi);

    assert.deepEqual(h.tools.map((tool) => tool.name), ["task_report"]);
    assert.deepEqual(h.commands, []);
  });
});

test("task_report tool does not register from leaked report path without task-worker marker", async () => {
  await withEnv({ PI_CHILD_TYPE: undefined, PI_TASK_REPORT_PATH: "/tmp/task-report.json" }, () => {
    const h = makePiHarness();
    registerTaskReportTool(h.pi);

    assert.deepEqual(h.tools, []);
  });
});
