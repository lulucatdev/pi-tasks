import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendBatchEvent,
  buildAttemptPaths,
  createBatch,
  readJsonFile,
  taskArtifactPath,
  writeAttemptArtifact,
  writeBatchArtifact,
  writeTaskArtifact,
  type AuditBatchHandle,
} from "./audit-log.ts";
import { evaluateAcceptance } from "./acceptance.ts";
import { classifyAndDecide, classifyProtocolFailure, retryDecisionForFailure } from "./failure-classifier.ts";
import { computeBackoffMs, normalizeRetryPolicy, shouldRetryAttempt } from "./retry.ts";
import { buildResultText, normalizeTasksRun } from "./run-tasks.ts";
import { writeSummaryMarkdown } from "./summary.ts";
import { renderActivityCollapsedLine } from "./thinking-steps.ts";
import { normalizeThrottlePolicy, ThrottleController } from "./throttle.ts";
import {
  deriveTaskFinalStatus,
  emptyAcceptance,
  type AcceptanceOutcome,
  type BatchArtifact,
  type BatchSummary,
  type FailureKind,
  type NormalizedTaskSpec,
  type RuntimeOutcome,
  type TaskActivityItem,
  type TaskArtifact,
  type TaskAttemptRecord,
  type TasksToolParams,
  type TaskFinalStatus,
} from "./types.ts";
import { buildAttemptRecord, runWorkerAttempt, type AttemptRuntimeResult, type RunWorkerAttemptInput } from "./worker-runner.ts";
import { observedWritePaths, readWorkerEvents, workerEventsPathForAttempt } from "./worker-events.ts";
import { readTaskReport } from "./worker-protocol.ts";

const execFileAsync = promisify(execFile);

export interface SupervisorContext {
  cwd: string;
  toolName: "task" | "tasks";
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
}

export interface SupervisorDependencies {
	runAttempt?: (input: RunWorkerAttemptInput) => Promise<AttemptRuntimeResult>;
	now?: () => string;
	captureChangedFiles?: (task: NormalizedTaskSpec) => Promise<string[]>;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	onUpdate?: (snapshot: SupervisedTasksResult) => void;
	liveUpdateIntervalMs?: number;
}

export interface SupervisedTasksResult {
  batch: BatchArtifact;
  tasks: TaskArtifact[];
  text: string;
}

function terminalBatchStatus(summary: BatchSummary): "success" | "error" | "aborted" {
  if (summary.error > 0) return "error";
  if (summary.aborted > 0) return "aborted";
  return "success";
}

function summarizeTasks(tasks: TaskArtifact[]): BatchSummary {
  const summary: BatchSummary = { total: tasks.length, success: 0, error: 0, aborted: 0, acceptanceFailed: 0, providerTransientFailed: 0, protocolFailed: 0, retried: 0 };
  for (const task of tasks) {
    if (task.finalStatus) summary[task.finalStatus] += 1;
    if (task.failureKind === "acceptance_failed") summary.acceptanceFailed += 1;
    if (task.failureKind === "provider_transient") summary.providerTransientFailed += 1;
    if (task.failureKind === "protocol_error") summary.protocolFailed += 1;
    if (task.attempts.length > 1) summary.retried += 1;
  }
  return summary;
}

function countLifecycle(tasks: TaskArtifact[]): { done: number; queued: number; running: number; success: number; error: number; aborted: number } {
  return {
    done: tasks.filter((task) => task.finalStatus !== null).length,
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    success: tasks.filter((task) => task.finalStatus === "success").length,
    error: tasks.filter((task) => task.finalStatus === "error").length,
    aborted: tasks.filter((task) => task.finalStatus === "aborted").length,
  };
}

function compactTaskLines(task: TaskArtifact): string[] {
  const attempt = task.attempts.at(-1);
  const state = (task.finalStatus ?? task.status).toUpperCase();
  const attemptText = attempt ? ` attempt=${attempt.id}` : "";
  const failureText = task.failureKind !== "none" ? ` failure=${task.failureKind}` : "";
  const lines = [`- ${task.taskId} ${task.name}: ${state}${attemptText} acceptance=${task.acceptance.status}${failureText}`];
  const recentActivity = (task.activity ?? []).slice(-2);
  for (const item of recentActivity) lines.push(`  ${renderActivityCollapsedLine(item)}`);
  return lines;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function buildLiveResultText(batch: BatchArtifact, tasks: TaskArtifact[]): string {
  const counts = countLifecycle(tasks);
  const startedMs = Date.parse(batch.startedAt);
  const elapsed = Number.isNaN(startedMs) ? undefined : formatElapsed(Date.now() - startedMs);
  return [
    `TASKS running: ${counts.done}/${tasks.length} done, ${counts.running} running, ${counts.queued} queued`,
    elapsed ? `Elapsed: ${elapsed}` : undefined,
    `Batch: ${batch.batchId}`,
    `Artifacts: ${batch.batchDir}`,
    `Inspect: /tasks-ui ${batch.batchId}`,
    ...tasks.flatMap(compactTaskLines),
  ].filter(Boolean).join("\n");
}

async function readTaskArtifacts(batch: AuditBatchHandle): Promise<TaskArtifact[]> {
  return Promise.all(batch.artifact.taskIds.map((taskId) => readJsonFile<TaskArtifact>(taskArtifactPath(batch, taskId))));
}

async function emitSupervisorUpdate(batch: AuditBatchHandle, deps: SupervisorDependencies, batchOverride?: BatchArtifact): Promise<void> {
  if (!deps.onUpdate) return;
  try {
    const tasks = await readTaskArtifacts(batch);
    const liveBatch = { ...(batchOverride ?? batch.artifact), summary: summarizeTasks(tasks) };
    deps.onUpdate({ batch: liveBatch, tasks, text: buildLiveResultText(liveBatch, tasks) });
  } catch {
    // Live UI must never interfere with task supervision or artifact writes.
  }
}

function startSupervisorHeartbeat(batch: AuditBatchHandle, deps: SupervisorDependencies): () => void {
  if (!deps.onUpdate) return () => undefined;
  const intervalMs = Math.max(1, deps.liveUpdateIntervalMs ?? 2000);
  const timer = setInterval(() => void emitSupervisorUpdate(batch, deps), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function hasWriteBoundary(task: NormalizedTaskSpec): boolean {
  return Boolean(task.acceptance?.allowedWritePaths?.length || task.acceptance?.forbiddenWritePaths?.length);
}

function normalizeToPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isSupervisorArtifactPath(relativePath: string): boolean {
  const normalized = normalizeToPosix(relativePath);
  return normalized.startsWith(".pi/tasks/") || normalized.includes("/.pi/tasks/");
}

async function gitStatusSnapshot(cwd: string): Promise<Map<string, string> | null> {
  try {
    const { stdout: repoRootOutput } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { maxBuffer: 1024 * 1024 });
    const realCwd = await fs.realpath(cwd);
    const repoRoot = await fs.realpath(repoRootOutput.trim());
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], { maxBuffer: 1024 * 1024 });
    const files = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const raw = line.slice(3).trim();
      const file = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
      const repoRelative = file.replace(/^"|"$/g, "");
      const cwdRelative = normalizeToPosix(path.relative(realCwd, path.resolve(repoRoot, repoRelative))) || ".";
      if (isSupervisorArtifactPath(cwdRelative)) continue;
      const stat = await fs.stat(path.resolve(realCwd, cwdRelative)).catch(() => null);
      files.set(cwdRelative, stat ? `${stat.size}:${stat.mtimeMs}` : "missing");
    }
    return files;
  } catch {
    return null;
  }
}

function diffStatusSnapshots(before: Map<string, string> | null, after: Map<string, string> | null): { available: boolean; files: string[] } {
  if (!before || !after) return { available: false, files: [] };
  const files: string[] = [];
  for (const [file, signature] of after) {
    if (before.get(file) !== signature) files.push(file);
  }
  return { available: true, files };
}

async function readWorkerLog(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function pickFailureKind(runtimeDecision: ReturnType<typeof classifyAndDecide>, protocolKind: FailureKind, acceptance: AcceptanceOutcome, finalStatus: TaskFinalStatus): FailureKind {
  if (finalStatus === "aborted") return "aborted";
  if (runtimeDecision.failureKind !== "none") return runtimeDecision.failureKind;
  if (protocolKind !== "none") return protocolKind;
  if (acceptance.status === "failed") return "acceptance_failed";
  return finalStatus === "success" ? "none" : "worker_incomplete";
}

async function recordTaskActivity(input: {
  batch: AuditBatchHandle;
  activity: TaskActivityItem;
  nextSeq: () => number;
  deps: SupervisorDependencies;
}): Promise<void> {
  const existing = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.activity.taskId));
  const activity = [...(existing.activity ?? []), input.activity].slice(-100);
  await writeTaskArtifact(input.batch, { ...existing, activity });
  await appendBatchEvent(input.batch.eventsPath, {
    schemaVersion: 1,
    seq: input.nextSeq(),
    at: input.activity.at,
    type: "task_activity",
    batchId: input.batch.batchId,
    taskId: input.activity.taskId,
    attemptId: input.activity.attemptId,
    data: { kind: input.activity.kind, label: input.activity.label, detail: input.activity.detail },
  });
  await emitSupervisorUpdate(input.batch, input.deps);
}

async function abortQueuedTask(input: {
  batch: AuditBatchHandle;
  task: NormalizedTaskSpec;
  nextSeq: () => number;
  now?: () => string;
}): Promise<TaskArtifact> {
  const now = input.now?.() ?? new Date().toISOString();
  const existing = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.task.id));
  const aborted: TaskArtifact = {
    ...existing,
    status: "aborted",
    finalStatus: "aborted",
    failureKind: "aborted",
    retryability: "not_retryable",
    finishedAt: now,
    timeline: [...existing.timeline, { at: now, state: "aborted", message: "Task aborted before launch" }],
    error: "Task aborted before launch.",
  };
  await writeTaskArtifact(input.batch, aborted);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: now, type: "task_finished", batchId: input.batch.batchId, taskId: input.task.id, status: "aborted", message: aborted.error ?? undefined });
  return aborted;
}

async function settleTask(input: {
  batch: AuditBatchHandle;
  task: NormalizedTaskSpec;
  attemptIndex: number;
  nextSeq: () => number;
  writeAuditBaseline: Map<string, string> | null;
  writeAuditChangedFiles: Set<string>;
  ctx: SupervisorContext;
  deps: Required<Pick<SupervisorDependencies, "runAttempt">> & SupervisorDependencies;
}): Promise<{ artifact: TaskArtifact }> {
  const taskArtifact = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.task.id));
  const attemptId = `${input.task.id}-a${input.attemptIndex}`;
  const paths = buildAttemptPaths(input.batch, input.task.id, input.attemptIndex);
  const now = input.deps.now?.() ?? new Date().toISOString();
  taskArtifact.status = "running";
  taskArtifact.startedAt ??= now;
  taskArtifact.timeline.push({ at: now, state: "running", message: `Attempt ${input.attemptIndex} started` });
  await writeTaskArtifact(input.batch, taskArtifact);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: now, type: "attempt_started", batchId: input.batch.batchId, taskId: input.task.id, attemptId });
  await emitSupervisorUpdate(input.batch, input.deps);

  let runtime: AttemptRuntimeResult;
  try {
    runtime = await input.deps.runAttempt({
      task: input.task,
      attemptId,
      attemptIndex: input.attemptIndex,
      paths,
      signal: input.ctx.signal,
      fallbackModel: input.ctx.model,
      fallbackThinking: input.ctx.thinking,
      onActivity: (activity) => recordTaskActivity({ batch: input.batch, activity, nextSeq: input.nextSeq, deps: input.deps }),
    });
  } catch (error) {
    const finishedAt = input.deps.now?.() ?? new Date().toISOString();
    runtime = {
      attemptId,
      taskId: input.task.id,
      status: "error",
      sawTerminalAssistantMessage: false,
      stderrTail: "",
      stdoutMalformedLines: 0,
      failureKind: "unknown",
      error: error instanceof Error ? error.message : String(error),
      startedAt: now,
      finishedAt,
    };
  }

  let attempt = buildAttemptRecord({ task: input.task, attemptId, attemptIndex: input.attemptIndex, paths, runtime });
  const reportResult = await readTaskReport(paths.reportPath, { taskId: input.task.id, attemptId });
  const workerLog = await readWorkerLog(paths.workerLogPath);
  const workerEvents = await readWorkerEvents(workerEventsPathForAttempt(paths.attemptDir)).catch(() => []);
  const telemetryWritePaths = observedWritePaths(workerEvents);
  const changedFileAudit = input.deps.captureChangedFiles
    ? await input.deps.captureChangedFiles(input.task).then((files) => ({ available: true, files }), () => ({ available: false, files: [] }))
    : diffStatusSnapshots(input.writeAuditBaseline, hasWriteBoundary(input.task) ? await gitStatusSnapshot(input.task.cwd) : null);
  for (const file of changedFileAudit.files) input.writeAuditChangedFiles.add(file);
  for (const file of telemetryWritePaths) input.writeAuditChangedFiles.add(file);
  const protocolKind = classifyProtocolFailure(reportResult.errors);
  const workerReport = reportResult.ok
    ? { status: reportResult.report!.status, reportPath: paths.reportPath, report: reportResult.report, errors: [], warnings: [] }
    : { status: "invalid" as const, reportPath: paths.reportPath, errors: reportResult.errors, warnings: [] };
  const acceptance = reportResult.ok && reportResult.report!.status === "completed"
    ? await evaluateAcceptance({ contract: input.task.acceptance, cwd: input.task.cwd, workerLog, report: reportResult.report, changedFiles: [...input.writeAuditChangedFiles], writeAuditAvailable: changedFileAudit.available || telemetryWritePaths.length > 0 })
    : emptyAcceptance("skipped");
  const runtimeDecision = classifyAndDecide({ ...(runtime as RuntimeOutcome), error: runtime.error });
  const finalStatus = deriveTaskFinalStatus({ runtime: runtime.status, workerReport, acceptance });
  const failureKind = pickFailureKind(runtimeDecision, protocolKind, acceptance, finalStatus);
  const retryDecision = failureKind === runtimeDecision.failureKind ? runtimeDecision : retryDecisionForFailure(failureKind, runtime.status);

  attempt = {
    ...attempt,
    workerReport,
    failureKind,
    retryability: retryDecision.retryability,
    error: runtime.error ?? workerReport.errors[0] ?? acceptance.errors[0] ?? null,
  } as TaskAttemptRecord;
  await writeAttemptArtifact(paths, attempt);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: runtime.finishedAt, type: "attempt_finished", batchId: input.batch.batchId, taskId: input.task.id, attemptId, status: runtime.status, data: { failureKind, retryability: retryDecision.retryability } });

  const finishedAt = input.deps.now?.() ?? new Date().toISOString();
  const terminalState = finalStatus;
  const latestTaskArtifact = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.task.id));
  const updated: TaskArtifact = {
    ...latestTaskArtifact,
    status: terminalState,
    finalStatus,
    failureKind,
    retryability: retryDecision.retryability,
    acceptance,
    workerReport,
    attempts: [...latestTaskArtifact.attempts, attempt],
    finishedAt,
    timeline: [...latestTaskArtifact.timeline, { at: finishedAt, state: terminalState, message: `Task finished with ${finalStatus}` }],
    warnings: [...latestTaskArtifact.warnings, ...workerReport.warnings, ...acceptance.warnings],
    error: finalStatus === "success" ? null : attempt.error ?? workerReport.errors[0] ?? acceptance.errors[0] ?? "Task failed.",
  };
  await writeTaskArtifact(input.batch, updated);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: finishedAt, type: "task_finished", batchId: input.batch.batchId, taskId: input.task.id, status: finalStatus, data: { failureKind } });
  await emitSupervisorUpdate(input.batch, input.deps);

  return { artifact: updated };
}

async function mapWithDynamicConcurrency<TInput, TOutput>(items: TInput[], getConcurrency: () => number, fn: (item: TInput, index: number) => Promise<TOutput>): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length);
  let next = 0;
  let active = 0;
  let completed = 0;

  return await new Promise<TOutput[]>((resolve, reject) => {
    const launch = () => {
      if (completed === items.length) return resolve(results);
      while (active < Math.max(1, Math.min(getConcurrency(), items.length)) && next < items.length) {
        const index = next++;
        active += 1;
        fn(items[index], index).then((result) => {
          results[index] = result;
        }).then(() => {
          active -= 1;
          completed += 1;
          launch();
        }, reject);
      }
    };
    launch();
  });
}

export async function executeSupervisedTasks(params: TasksToolParams, ctx: SupervisorContext, deps: SupervisorDependencies = {}): Promise<SupervisedTasksResult> {
  const normalized = normalizeTasksRun(params, ctx.cwd);
  const writeAuditRequiresSerial = normalized.tasks.some(hasWriteBoundary) && !deps.captureChangedFiles;
  const schedulingConcurrency = writeAuditRequiresSerial ? 1 : normalized.effectiveConcurrency;
  const batch = await createBatch({
    rootCwd: ctx.cwd,
    toolName: ctx.toolName,
    tasks: normalized.tasks,
    requestedConcurrency: normalized.requestedConcurrency,
    effectiveConcurrency: schedulingConcurrency,
    now: deps.now?.(),
  });
  let seq = normalized.tasks.length + 2;
  const nextSeq = () => seq++;
  const runAttempt = deps.runAttempt ?? runWorkerAttempt;
  const retryPolicy = normalizeRetryPolicy(params.retry);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const throttle = new ThrottleController(normalizeThrottlePolicy(params.throttle, schedulingConcurrency), schedulingConcurrency);
  await emitSupervisorUpdate(batch, deps);
  const stopHeartbeat = startSupervisorHeartbeat(batch, deps);

  let taskResults: TaskArtifact[];
  try {
    taskResults = await mapWithDynamicConcurrency(normalized.tasks, () => throttle.currentConcurrency, async (task) => {
    try {
      if (ctx.signal?.aborted) {
        const aborted = await abortQueuedTask({ batch, task, nextSeq, now: deps.now });
        await emitSupervisorUpdate(batch, deps);
        return aborted;
      }
      let latest: TaskArtifact | undefined;
      const writeAuditBaseline = hasWriteBoundary(task) && !deps.captureChangedFiles ? await gitStatusSnapshot(task.cwd) : null;
      const writeAuditChangedFiles = new Set<string>();
      for (let attemptIndex = 1; attemptIndex <= retryPolicy.maxAttempts; attemptIndex += 1) {
        if (ctx.signal?.aborted && !latest) {
          const aborted = await abortQueuedTask({ batch, task, nextSeq, now: deps.now });
          await emitSupervisorUpdate(batch, deps);
          return aborted;
        }
        if (ctx.signal?.aborted) break;
        const result = await settleTask({ batch, task, attemptIndex, nextSeq, writeAuditBaseline, writeAuditChangedFiles, ctx, deps: { ...deps, runAttempt } });
        latest = result.artifact;
        const lastAttempt = latest.attempts.at(-1);
        if (!lastAttempt) break;
        const shouldRetry = shouldRetryAttempt({
          attemptIndex,
          policy: retryPolicy,
          decision: { retryability: lastAttempt.retryability, failureKind: lastAttempt.failureKind, reason: lastAttempt.error ?? lastAttempt.failureKind },
          validWorkerReport: lastAttempt.workerReport.status !== "not_submitted" && lastAttempt.workerReport.status !== "invalid",
        });
        if (!shouldRetry || latest.finalStatus === "success" || latest.finalStatus === "aborted") break;
        const delayMs = computeBackoffMs(retryPolicy, attemptIndex, deps.random);
        const at = deps.now?.() ?? new Date().toISOString();
        await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at, type: "attempt_retry_scheduled", batchId: batch.batchId, taskId: task.id, attemptId: `${task.id}-a${attemptIndex + 1}`, data: { delayMs, failureKind: lastAttempt.failureKind } });
        await sleep(delayMs);
      }
      if (!latest) throw new Error(`Task ${task.id} did not run any attempts.`);
      const throttleDecision = throttle.record(latest.failureKind);
      if (throttleDecision) {
        const at = deps.now?.() ?? new Date().toISOString();
        await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at, type: "throttle_decision", batchId: batch.batchId, data: throttleDecision as unknown as Record<string, unknown> });
      }
      return latest;
    } catch (error) {
      const now = deps.now?.() ?? new Date().toISOString();
      const existing = await readJsonFile<TaskArtifact>(taskArtifactPath(batch, task.id));
      const failed: TaskArtifact = {
        ...existing,
        status: "error",
        finalStatus: "error",
        failureKind: "unknown",
        retryability: "not_retryable",
        finishedAt: now,
        timeline: [...existing.timeline, { at: now, state: "error", message: "Supervisor settlement failed" }],
        error: error instanceof Error ? error.message : String(error),
      };
      await writeTaskArtifact(batch, failed);
      await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at: now, type: "task_finished", batchId: batch.batchId, taskId: task.id, status: "error", message: failed.error ?? undefined });
      await emitSupervisorUpdate(batch, deps);
      return failed;
    }
    });
  } finally {
    stopHeartbeat();
  }

  const summary = summarizeTasks(taskResults);
  const status = terminalBatchStatus(summary);
  const finishedAt = deps.now?.() ?? new Date().toISOString();
  const finalBatch: BatchArtifact = {
    ...batch.artifact,
    status,
    auditIntegrity: "ok",
    finishedAt,
    summary,
    parentBatchId: params.parentBatchId,
    rerunOfTaskIds: params.rerunOfTaskIds,
  };
  await writeBatchArtifact(batch, finalBatch);
  await writeSummaryMarkdown(batch.summaryPath, finalBatch, taskResults, params);
  await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at: finishedAt, type: "batch_finished", batchId: batch.batchId, status, data: { auditIntegrity: "ok" } });

  return {
    batch: finalBatch,
    tasks: taskResults,
    text: buildResultText({
      batchId: finalBatch.batchId,
      batchDir: finalBatch.batchDir,
      status,
      total: summary.total,
      success: summary.success,
      error: summary.error,
      aborted: summary.aborted,
      summaryPath: `${finalBatch.batchDir}/summary.md`,
    }),
  };
}
