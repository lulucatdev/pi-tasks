import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

import jobWorkerRuntime from "../../extensions/jobs/job-worker-runtime.ts";
import { registerJobReportTool } from "../../extensions/jobs/job-report-tool.ts";

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

test("root extension source registers breaking job API names only", async () => {
  const source = await fs.readFile(new URL("../../extensions/jobs/index.ts", import.meta.url), "utf-8");
  assert.match(source, /registerCommand\("jobs-ui"/);
  assert.match(source, /name: "job"/);
  assert.match(source, /name: "jobs"/);
  assert.match(source, /name: "jobs_plan"/);
});

test("root job extension returns before registering tools in child worker mode", async () => {
  const source = await fs.readFile(new URL("../../extensions/jobs/index.ts", import.meta.url), "utf-8");
  const childGuard = source.indexOf("if (process.env.PI_CHILD_TYPE) return;");
  const firstRegisterJobReport = source.indexOf("registerJobReportTool(pi)");
  const firstRegisterJobTool = source.indexOf('name: "job"');
  const firstRegisterJobsTool = source.indexOf('name: "jobs"');
  const firstRegisterJobsPlanTool = source.indexOf('name: "jobs_plan"');

  assert.ok(childGuard !== -1, "index.ts must guard child workers before root registration");
  assert.ok(childGuard < firstRegisterJobReport, "child guard must run before job_report registration in root extension");
  assert.ok(childGuard < firstRegisterJobTool, "child guard must run before job tool registration");
  assert.ok(childGuard < firstRegisterJobsTool, "child guard must run before jobs tool registration");
  assert.ok(childGuard < firstRegisterJobsPlanTool, "child guard must run before jobs_plan tool registration");
});

test("worker runtime registers only job_report when child marker and report path are present", async () => {
  await withEnv({ PI_CHILD_TYPE: "job-worker", PI_JOB_REPORT_PATH: "/tmp/job-report.json" }, () => {
    const h = makePiHarness();
    jobWorkerRuntime(h.pi);

    assert.deepEqual(h.tools.map((tool) => tool.name), ["job_report"]);
    assert.deepEqual(h.commands, []);
  });
});

test("job_report tool does not register from leaked report path without job-worker marker", async () => {
  await withEnv({ PI_CHILD_TYPE: undefined, PI_JOB_REPORT_PATH: "/tmp/job-report.json" }, () => {
    const h = makePiHarness();
    registerJobReportTool(h.pi);

    assert.deepEqual(h.tools, []);
  });
});
