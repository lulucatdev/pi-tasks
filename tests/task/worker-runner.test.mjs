import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { buildAttemptPaths, buildBatchPaths } from "../../extensions/task/audit-log.ts";
import { buildAttemptRecord, runWorkerAttempt } from "../../extensions/task/worker-runner.ts";

function makeTask() {
  return { id: "t001", name: "demo", prompt: "Do it", cwd: process.cwd() };
}

function makePaths(root) {
  return buildAttemptPaths(buildBatchPaths(root, "batch"), "t001", 1);
}

function fakeSpawn({ stdout = [], stderr = [], code = 0, onSpawn } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {
      proc.killed = true;
      setImmediate(() => proc.emit("close", null));
      return true;
    };
    onSpawn?.(proc);
    setImmediate(() => {
      for (const chunk of stdout) proc.stdout.emit("data", chunk);
      for (const chunk of stderr) proc.stderr.emit("data", chunk);
      proc.emit("close", code);
    });
    return proc;
  };
}

test("runWorkerAttempt captures terminal assistant events and stdout/stderr artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-runner-"));
  const paths = makePaths(root);
  const terminal = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + "\n";

  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths,
    spawnImpl: fakeSpawn({ stdout: [terminal], stderr: ["warn"], code: 0 }),
  });

  assert.equal(result.status, "success");
  assert.equal(result.sawTerminalAssistantMessage, true);
  assert.match(await fs.readFile(paths.stdoutPath, "utf-8"), /message_end/);
  assert.equal(await fs.readFile(paths.stderrPath, "utf-8"), "warn");
});

test("runWorkerAttempt resolves when process exits before stdio close", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-post-exit-guard-"));
  const terminal = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + "\n";
  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    postExitGraceMs: 1,
    spawnImpl: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      setImmediate(() => {
        proc.stdout.emit("data", terminal);
        proc.emit("exit", 0);
      });
      return proc;
    },
  });

  assert.equal(result.status, "success");
});

test("runWorkerAttempt stops workers that stay open after terminal output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-terminal-guard-"));
  const terminal = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + "\n";
  let killed = false;
  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    terminalExitGraceMs: 1,
    spawnImpl: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {
        killed = true;
        return true;
      };
      setImmediate(() => proc.stdout.emit("data", terminal));
      return proc;
    },
  });

  assert.equal(result.status, "success");
  assert.equal(killed, true);
});

test("runWorkerAttempt hard-stops aborted workers that ignore SIGTERM", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-abort-hard-stop-"));
  const controller = new AbortController();
  controller.abort();
  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    signal: controller.signal,
    abortKillDelayMs: 1,
    spawnImpl: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      return proc;
    },
  });

  assert.equal(result.status, "aborted");
  assert.equal(result.failureKind, "aborted");
});

test("runWorkerAttempt classifies thinking-only stop as worker_incomplete, not success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-thinking-only-"));
  const terminal = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "..." }] },
  }) + "\n";

  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    terminalExitGraceMs: 1,
    spawnImpl: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      setImmediate(() => proc.stdout.emit("data", terminal));
      return proc;
    },
  });

  assert.equal(result.status, "error");
  assert.equal(result.failureKind, "worker_incomplete");
  assert.equal(result.stopReason, "thinking_only_stop");
  assert.equal(result.sawTerminalAssistantMessage, false);
  assert.match(result.error, /thinking-only content/);
});

test("runWorkerAttempt cancels terminal exit guard when CLI emits auto_retry_start after error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-auto-retry-"));
  const errorTerminal = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [{ type: "thinking", thinking: "..." }] },
  }) + "\n";
  const autoRetry = JSON.stringify({ type: "auto_retry_start" }) + "\n";
  const recovered = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
  }) + "\n";
  let killed = false;

  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    // Tight grace; if the runner failed to cancel after auto_retry, the test
    // would observe killed=true even though the CLI was recovering.
    terminalExitGraceMs: 50,
    spawnImpl: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => { killed = true; return true; };
      setImmediate(async () => {
        proc.stdout.emit("data", errorTerminal);
        await new Promise((resolve) => setTimeout(resolve, 5));
        proc.stdout.emit("data", autoRetry);
        await new Promise((resolve) => setTimeout(resolve, 200));
        proc.stdout.emit("data", recovered);
        proc.emit("close", 0);
      });
      return proc;
    },
  });

  assert.equal(killed, false, "parent must not SIGTERM the worker while CLI is auto-retrying");
  assert.equal(result.status, "success");
  assert.equal(result.sawTerminalAssistantMessage, true);
  assert.notEqual(result.stopReason, "error");
  assert.equal(result.failureKind, "none");
});

test("runWorkerAttempt does not schedule terminal exit guard on bare stopReason=error (CLI may still close)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-error-no-guard-"));
  const errorTerminal = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [{ type: "thinking", thinking: "..." }] },
  }) + "\n";
  let killed = false;

  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    terminalExitGraceMs: 30,
    spawnImpl: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => { killed = true; return true; };
      setImmediate(async () => {
        proc.stdout.emit("data", errorTerminal);
        // Wait longer than the terminal grace window. The runner must NOT kill.
        await new Promise((resolve) => setTimeout(resolve, 100));
        proc.emit("close", 1);
      });
      return proc;
    },
  });

  assert.equal(killed, false, "no SIGTERM after a bare error terminal; rely on natural process close");
  assert.equal(result.status, "error");
  assert.equal(result.stopReason, "error");
});

test("runWorkerAttempt treats terminal stopReason error as runtime failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-stop-error-"));
  const terminal = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error" } }) + "\n";
  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    spawnImpl: fakeSpawn({ stdout: [terminal], code: 0 }),
  });

  assert.equal(result.status, "error");
  assert.match(result.error, /stopReason=error/);
});

test("runWorkerAttempt awaits ordered stdout and stderr artifact writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-runner-writes-"));
  const paths = makePaths(root);
  const terminal = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) + "\n";

  await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths,
    spawnImpl: fakeSpawn({ stdout: ["first\n", terminal, "last\n"], stderr: ["a", "b", "c"], code: 0 }),
  });

  assert.equal(await fs.readFile(paths.stderrPath, "utf-8"), "abc");
  assert.match(await fs.readFile(paths.stdoutPath, "utf-8"), /first\n.*message_end.*last/s);
});

test("runWorkerAttempt reports launch errors as runtime facts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-launch-"));
  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    spawnImpl: () => {
      throw new Error("spawn failed");
    },
  });

  assert.equal(result.status, "error");
  assert.equal(result.failureKind, "launch_error");
  assert.match(result.error, /spawn failed/);
});

test("runWorkerAttempt reports async child process errors as launch errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-async-launch-"));
  const result = await runWorkerAttempt({
    task: makeTask(),
    attemptId: "t001-a1",
    attemptIndex: 1,
    paths: makePaths(root),
    spawnImpl: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      setImmediate(() => proc.emit("error", new Error("ENOENT pi")));
      return proc;
    },
  });

  assert.equal(result.status, "error");
  assert.equal(result.failureKind, "launch_error");
  assert.match(result.error, /ENOENT/);
});

test("buildAttemptRecord preserves runtime evidence and artifact paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-record-"));
  const paths = makePaths(root);
  const runtime = {
    attemptId: "t001-a1",
    taskId: "t001",
    status: "error",
    exitCode: 1,
    sawTerminalAssistantMessage: false,
    stderrTail: "bad",
    stdoutMalformedLines: 1,
    failureKind: "unknown",
    error: "bad",
    startedAt: "2026-04-26T00:00:00.000Z",
    finishedAt: "2026-04-26T00:00:01.000Z",
  };

  const record = buildAttemptRecord({ task: makeTask(), attemptId: "t001-a1", attemptIndex: 1, paths, runtime });
  assert.equal(record.status, "error");
  assert.equal(record.stderrPath, paths.stderrPath);
  assert.deepEqual(record.warnings, ["Malformed stdout JSON lines: 1"]);
});
