import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { buildAttemptPaths, buildBatchPaths } from "../../extensions/task/audit-log.ts";
import { runWorkerAttempt } from "../../extensions/task/worker-runner.ts";
import { appendWorkerEvent, buildWorkerEvent, createStdoutTelemetryState, extractStdoutTelemetry, readWorkerEvents, workerEventsPathForAttempt } from "../../extensions/task/worker-events.ts";

test("worker event writer redacts args and reads jsonl", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-events-"));
  const file = path.join(root, "events.jsonl");
  await appendWorkerEvent(file, buildWorkerEvent({
    type: "tool_call_started",
    taskId: "t001",
    attemptId: "t001-a1",
    tool: "bash",
    args: { command: "echo hi", token: "secret" },
  }));
  const events = await readWorkerEvents(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].argsPreview, '{"command":"echo hi","token":"[REDACTED]"}');
});

test("extractStdoutTelemetry emits tool_call and file_write_observed events for write tools", () => {
  const state = createStdoutTelemetryState();
  const ctx = { taskId: "t001", attemptId: "t001-a1", cwd: "/tmp/project" };
  const startEdit = extractStdoutTelemetry({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "edit",
    args: { path: "chapters/ch01/intro.tex", edits: [{ oldText: "a", newText: "b" }] },
  }, state, ctx);
  assert.equal(startEdit.length, 2);
  assert.equal(startEdit[0].type, "tool_call_started");
  assert.equal(startEdit[1].type, "file_write_observed");
  assert.equal(startEdit[1].path, "chapters/ch01/intro.tex");

  const startBash = extractStdoutTelemetry({
    type: "tool_execution_start",
    toolCallId: "call-2",
    toolName: "bash",
    args: { command: "echo hi" },
  }, state, ctx);
  assert.equal(startBash.length, 1);
  assert.equal(startBash[0].type, "tool_call_started");

  const dedupedEdit = extractStdoutTelemetry({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "edit",
    args: { path: "chapters/ch01/intro.tex" },
  }, state, ctx);
  assert.deepEqual(dedupedEdit, []);

  const endEdit = extractStdoutTelemetry({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "edit",
    isError: false,
  }, state, ctx);
  assert.equal(endEdit.length, 1);
  assert.equal(endEdit[0].type, "tool_call_finished");
  assert.equal(endEdit[0].status, "ok");

  const writeAbsolute = extractStdoutTelemetry({
    type: "tool_execution_start",
    toolCallId: "call-3",
    toolName: "write",
    args: { path: "/tmp/project/notes/out.md", content: "hi" },
  }, state, ctx);
  assert.equal(writeAbsolute[1].path, "notes/out.md");
});

test("runWorkerAttempt creates worker event channel path and exposes env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-runner-events-"));
  const paths = buildAttemptPaths(buildBatchPaths(root, "batch"), "t001", 1);
  let seenArgs;
  let seenEnv;
  await runWorkerAttempt({
    task: { id: "t001", name: "demo", prompt: "Do it", cwd: process.cwd() },
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths,
    spawnImpl: (_cmd, args, options) => {
      seenArgs = args;
      seenEnv = options.env;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      setImmediate(() => proc.emit("close", 0));
      return proc;
    },
  });
  assert.ok(seenArgs.includes("--no-extensions"));
  assert.ok(seenArgs.includes("--extension"));
  assert.ok(seenArgs.some((arg) => String(arg).endsWith("extensions/task/index.ts")));
  assert.equal(seenEnv.PI_TASK_EVENTS_PATH, workerEventsPathForAttempt(paths.attemptDir));
  assert.equal(await fs.readFile(workerEventsPathForAttempt(paths.attemptDir), "utf-8"), "");
});
