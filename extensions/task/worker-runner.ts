import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";
import type { AttemptPaths } from "./audit-log.ts";
import { createWorkerActivityState, extractWorkerActivity } from "./thinking-steps.ts";
import type { FailureKind, NormalizedTaskSpec, RuntimeOutcome, RuntimeStatus, TaskActivityItem, TaskAttemptRecord } from "./types.ts";
import { appendWorkerEvent, createStdoutTelemetryState, extractStdoutTelemetry, workerEventsPathForAttempt } from "./worker-events.ts";
import { buildWorkerPrompt, buildWorkerSystemPrompt } from "./worker-protocol.ts";

const TASK_EXTENSION_ENTRYPOINT = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

export interface AttemptRuntimeResult {
  attemptId: string;
  taskId: string;
  status: RuntimeStatus;
  exitCode?: number;
  stopReason?: string;
  sawTerminalAssistantMessage: boolean;
  stderrTail: string;
  stdoutMalformedLines: number;
  failureKind: FailureKind;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export type SpawnedProcessLike = Pick<ChildProcessWithoutNullStreams, "kill" | "on"> & {
  stdout: Pick<EventEmitter, "on"> & { destroy?: () => void };
  stderr: Pick<EventEmitter, "on"> & { destroy?: () => void };
};

export type SpawnImpl = (command: string, args: string[], options: Record<string, unknown>) => SpawnedProcessLike;

export interface RunWorkerAttemptInput {
  task: NormalizedTaskSpec;
  attemptId: string;
  attemptIndex: number;
  paths: AttemptPaths;
  signal?: AbortSignal;
  piCommand?: string;
  fallbackModel?: string;
  fallbackThinking?: string;
  spawnImpl?: SpawnImpl;
  env?: NodeJS.ProcessEnv;
  abortKillDelayMs?: number;
  terminalExitGraceMs?: number;
  postExitGraceMs?: number;
  onActivity?: (activity: TaskActivityItem) => void | Promise<void>;
}

function isTerminalAssistantEvent(event: unknown): { terminal: boolean; stopReason?: string; errorMessage?: string } {
  if (!event || typeof event !== "object") return { terminal: false };
  const record = event as Record<string, any>;
  if (record.type !== "message_end" || !record.message) return { terminal: false };
  const message = record.message;
  if (message.role !== "assistant") return { terminal: false };
  if (!message.stopReason || message.stopReason === "toolUse") return { terminal: false };
  return { terminal: true, stopReason: message.stopReason, errorMessage: message.errorMessage };
}

function tail(text: string, max = 4000): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function destroyUnendedStdio(proc: SpawnedProcessLike): void {
  try { proc.stdout.destroy?.(); } catch {}
  try { proc.stderr.destroy?.(); } catch {}
}

export async function runWorkerAttempt(input: RunWorkerAttemptInput): Promise<AttemptRuntimeResult> {
  const startedAt = new Date().toISOString();
  const spawnImpl = input.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
  const piCommand = input.piCommand ?? "pi";
  let sawTerminalAssistantMessage = false;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let stderr = "";
  let stdoutBuffer = "";
  let stdoutMalformedLines = 0;
  let wasAborted = false;
  let spawnError: string | undefined;
  let scheduleTerminalExitGuard = () => {};
  let stdoutWriteQueue = Promise.resolve();
  let stderrWriteQueue = Promise.resolve();
  let activityQueue = Promise.resolve();
  let telemetryQueue = Promise.resolve();
  const activityState = createWorkerActivityState();
  const telemetryState = createStdoutTelemetryState();
  const workerEventsPath = workerEventsPathForAttempt(input.paths.attemptDir);

  const queueAppend = (filePath: string, text: string, stream: "stdout" | "stderr") => {
    const append = () => fs.appendFile(filePath, text, "utf-8").catch((error) => {
      stderr += `\nArtifact write failed (${stream}): ${error instanceof Error ? error.message : String(error)}`;
    });
    if (stream === "stdout") stdoutWriteQueue = stdoutWriteQueue.then(append, append);
    else stderrWriteQueue = stderrWriteQueue.then(append, append);
  };

  const queueActivity = (activity: TaskActivityItem) => {
    if (!input.onActivity) return;
    const emit = () => Promise.resolve(input.onActivity?.(activity)).catch(() => undefined);
    activityQueue = activityQueue.then(emit, emit);
  };

  const queueTelemetryEvents = (events: ReturnType<typeof extractStdoutTelemetry>) => {
    if (!events.length) return;
    const emit = async () => {
      for (const event of events) {
        try {
          await appendWorkerEvent(workerEventsPath, event);
        } catch {
          // Telemetry must not block worker execution; ignore artifact write errors.
        }
      }
    };
    telemetryQueue = telemetryQueue.then(emit, emit);
  };

  await fs.mkdir(input.paths.attemptDir, { recursive: true });
  const systemPromptPath = path.join(input.paths.attemptDir, "system-prompt.md");
  await fs.writeFile(systemPromptPath, buildWorkerSystemPrompt(), "utf-8");
  await fs.writeFile(input.paths.workerLogPath, "", "utf-8");
  await fs.writeFile(input.paths.stderrPath, "", "utf-8");
  await fs.writeFile(input.paths.stdoutPath, "", "utf-8");
  await fs.writeFile(workerEventsPath, "", "utf-8");

  const args = ["--no-extensions", "--extension", TASK_EXTENSION_ENTRYPOINT, "--mode", "json", "-p", "--no-session"];
  if (input.fallbackModel) args.push("--model", input.fallbackModel);
  if (input.fallbackThinking) args.push("--thinking", input.fallbackThinking);
  args.push("--append-system-prompt", systemPromptPath, buildWorkerPrompt({
    task: input.task,
    attemptId: input.attemptId,
    workerLogPath: input.paths.workerLogPath,
    reportPath: input.paths.reportPath,
  }));

  let proc: SpawnedProcessLike;
  try {
    proc = spawnImpl(piCommand, args, {
      cwd: input.task.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(input.env ?? process.env), PI_CHILD_TYPE: "task", PI_TASK_ID: input.task.id, PI_TASK_ATTEMPT_ID: input.attemptId, PI_TASK_REPORT_PATH: input.paths.reportPath, PI_TASK_EVENTS_PATH: workerEventsPath },
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    return {
      attemptId: input.attemptId,
      taskId: input.task.id,
      status: "error",
      sawTerminalAssistantMessage: false,
      stderrTail: "",
      stdoutMalformedLines: 0,
      failureKind: "launch_error",
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt,
    };
  }

  const parseLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const workerActivity = extractWorkerActivity(event, activityState, { taskId: input.task.id, attemptId: input.attemptId });
      if (workerActivity) queueActivity(workerActivity);
      const telemetryEvents = extractStdoutTelemetry(event, telemetryState, { taskId: input.task.id, attemptId: input.attemptId, cwd: input.task.cwd });
      if (telemetryEvents.length) queueTelemetryEvents(telemetryEvents);
      const terminal = isTerminalAssistantEvent(event);
      if (terminal.terminal) {
        sawTerminalAssistantMessage = true;
        stopReason = terminal.stopReason;
        if (terminal.errorMessage) errorMessage = terminal.errorMessage;
        scheduleTerminalExitGuard();
      }
    } catch {
      stdoutMalformedLines += 1;
    }
  };

  const exitCode = await new Promise<number>((resolve) => {
    let settled = false;
    let abortTimer: NodeJS.Timeout | undefined;
    let terminalTimer: NodeJS.Timeout | undefined;
    let postExitTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (abortTimer) clearTimeout(abortTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      if (postExitTimer) clearTimeout(postExitTimer);
      if (input.signal && abortHandler) input.signal.removeEventListener("abort", abortHandler);
      resolve(code);
    };

    scheduleTerminalExitGuard = () => {
      if (terminalTimer || settled) return;
      terminalTimer = setTimeout(() => {
        proc.kill("SIGTERM");
        const forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
        forceKillTimer.unref?.();
        finish(0);
      }, input.terminalExitGraceMs ?? 30000);
      terminalTimer.unref?.();
    };

    const kill = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
      abortTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        finish(1);
      }, input.abortKillDelayMs ?? 5000);
      abortTimer.unref?.();
    };

    if (input.signal) {
      if (input.signal.aborted) kill();
      else {
        abortHandler = kill;
        input.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    proc.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      queueAppend(input.paths.stdoutPath, text, "stdout");
      stdoutBuffer += text;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
    });

    proc.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      queueAppend(input.paths.stderrPath, text, "stderr");
    });

    proc.on("error", (error: Error) => {
      spawnError = error.message;
      stderr += error.message;
      queueAppend(input.paths.stderrPath, error.message, "stderr");
      finish(1);
    });

    proc.on("exit", (code: number | null) => {
      if (settled) return;
      const exitCode = code ?? 0;
      postExitTimer = setTimeout(() => {
        if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
        destroyUnendedStdio(proc);
        finish(exitCode);
      }, input.postExitGraceMs ?? 8000);
      postExitTimer.unref?.();
    });

    proc.on("close", (code: number | null) => {
      if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
      finish(code ?? 1);
    });
  });

  await Promise.all([stdoutWriteQueue, stderrWriteQueue, activityQueue, telemetryQueue]);

  const finishedAt = new Date().toISOString();
  const status: RuntimeStatus = wasAborted || stopReason === "aborted" ? "aborted" : stopReason === "error" || errorMessage ? "error" : sawTerminalAssistantMessage && exitCode === 0 ? "success" : exitCode === 0 ? "success" : "error";
  const failureKind: FailureKind = status === "aborted" ? "aborted" : status === "success" ? "none" : spawnError ? "launch_error" : "unknown";

  return {
    attemptId: input.attemptId,
    taskId: input.task.id,
    status,
    exitCode,
    stopReason,
    sawTerminalAssistantMessage,
    stderrTail: tail(stderr),
    stdoutMalformedLines,
    failureKind,
    error: errorMessage ?? spawnError ?? (status === "error" ? tail(stderr).trim() || (stopReason === "error" ? "Worker stopped with stopReason=error" : `Worker exited with code ${exitCode}`) : null),
    startedAt,
    finishedAt,
  };
}

export function buildAttemptRecord(input: {
  task: NormalizedTaskSpec;
  attemptId: string;
  attemptIndex: number;
  paths: AttemptPaths;
  runtime: AttemptRuntimeResult;
}): TaskAttemptRecord {
  return {
    id: input.attemptId,
    index: input.attemptIndex,
    taskId: input.task.id,
    status: input.runtime.status === "success" ? "success" : input.runtime.status === "aborted" ? "aborted" : "error",
    startedAt: input.runtime.startedAt,
    finishedAt: input.runtime.finishedAt,
    cwd: input.task.cwd,
    attemptDir: input.paths.attemptDir,
    workerLogPath: input.paths.workerLogPath,
    reportPath: input.paths.reportPath,
    stdoutPath: input.paths.stdoutPath,
    stderrPath: input.paths.stderrPath,
    runtime: input.runtime as RuntimeOutcome,
    workerReport: { status: "not_submitted", errors: [], warnings: [] },
    failureKind: input.runtime.failureKind,
    retryability: "not_retryable",
    error: input.runtime.error,
    warnings: input.runtime.stdoutMalformedLines > 0 ? [`Malformed stdout JSON lines: ${input.runtime.stdoutMalformedLines}`] : [],
  };
}
