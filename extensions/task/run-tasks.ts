import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { createAuditBatch as createAuditBatchImpl, type AuditBatchHandle, readTaskArtifact, writeBatchJson } from "./audit-log.ts";
import { extractDisplayItems, extractFinalOutput, type TaskDisplayItem } from "./task-output.ts";
import { resolveCompletedRunStatus as resolveCompletedRunStatusImpl } from "./task-status.ts";
import { buildQueuedTaskArtifact, type BatchRecord, type TaskArtifact } from "./types.ts";

export type TaskStatus = "queued" | "running" | "success" | "error" | "aborted";
export type RunStatus = "running" | "success" | "error" | "aborted";

export type DisplayItem = TaskDisplayItem;
export type OnUpdateCallback = (partial: AgentToolResult<TasksDetails>) => void;

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface TaskSpecInput {
  name?: string;
  task: string;
  cwd?: string;
}

export interface NormalizedTaskSpec {
  id: string;
  name?: string;
  task: string;
  cwd: string;
}

export interface LiveTaskResult extends NormalizedTaskSpec {
  status: TaskStatus;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  exitCode?: number;
}

export interface PersistedTaskResult extends NormalizedTaskSpec {
  status: TaskStatus;
  output: string;
  error?: string;
  usage: UsageStats;
  model?: string;
  displayItems: DisplayItem[];
}

export interface TasksSummary {
  total: number;
  queued: number;
  running: number;
  success: number;
  error: number;
  aborted: number;
}

export interface TasksDetails {
  results: LiveTaskResult[];
  summary: TasksSummary;
}

export interface PersistedTasksDetails {
  results: PersistedTaskResult[];
  summary: TasksSummary;
}

export interface TaskRunSummary {
  id: string;
  batchId?: string;
  status: RunStatus;
  title: string;
  cwd: string;
  toolName: "task" | "tasks";
  startedAt: number;
  finishedAt?: number;
  detail: string;
  tasks: NormalizedTaskSpec[];
  auditClassification?: "complete" | "incomplete";
}

export interface TaskRunRecord extends TaskRunSummary {
  params?: TasksToolParams;
  details?: PersistedTasksDetails;
}

export interface TasksToolParams {
  tasks: TaskSpecInput[];
}

export interface RunTasksContext {
  cwd: string;
  model?: {
    provider?: string;
    id?: string;
  };
}

export interface RunTasksDependencies {
  processIsChild?: boolean;
  maxTasks: number;
  maxConcurrency: number;
  getThinkingLevel: () => string | undefined;
  getActiveRuns: () => TaskRunRecord[];
  getRecentRuns: () => TaskRunRecord[];
  startRun: (run: TaskRunRecord, ctx: RunTasksContext) => void;
  patchRun: (runId: string, patch: Partial<TaskRunRecord>, ctx: RunTasksContext) => void;
  finishRun: (
    runId: string,
    details: TasksDetails,
    ctx: RunTasksContext,
    options?: { auditClassification?: "complete" | "incomplete" },
  ) => void;
  failRun: (runId: string, detail: string, ctx: RunTasksContext) => void;
  runSingleTask: (
    task: NormalizedTaskSpec,
    signal: AbortSignal | undefined,
    onUpdate: ((result: LiveTaskResult) => void) | undefined,
    fallbackModel: string | undefined,
    fallbackThinking: string | undefined,
    onLaunch: (() => void) | undefined,
  ) => Promise<LiveTaskResult>;
  activeTaskControllers: Map<string, AbortController>;
  pendingAbortTaskIds: Set<string>;
  createAuditBatch?: typeof createAuditBatchImpl;
  cleanupAuditBatch?: (audit: AuditBatchHandle) => Promise<void>;
  generateTaskId?: (existingIds: Set<string>) => string;
  beforeTaskLaunch?: (task: NormalizedTaskSpec, index: number) => Promise<void> | void;
}

export class PreLaunchTaskBatchFailure extends Error {
  readonly syntheticStatus: "error" | "aborted";
  readonly auditDegraded: boolean;

  constructor(message: string, options: { syntheticStatus: "error" | "aborted"; auditDegraded?: boolean }) {
    super(message);
    this.name = "PreLaunchTaskBatchFailure";
    this.syntheticStatus = options.syntheticStatus;
    this.auditDegraded = options.auditDegraded ?? false;
  }
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function shortenText(text: string, max = 72): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`;
}

function formatDuration(startedAt: number, finishedAt?: number): string {
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function buildSummary(results: Array<{ status: TaskStatus }>): TasksSummary {
  const summary: TasksSummary = { total: results.length, queued: 0, running: 0, success: 0, error: 0, aborted: 0 };
  for (const result of results) {
    summary[result.status] += 1;
  }
  return summary;
}

function buildDetails(results: LiveTaskResult[]): TasksDetails {
  return { results, summary: buildSummary(results) };
}

function getResultError(result: LiveTaskResult): string | undefined {
  if (result.status === "aborted") return result.errorMessage || "Task was aborted.";
  if (result.status !== "error") return undefined;
  return result.errorMessage || result.stderr.trim() || extractFinalOutput(result.messages) || "Task failed before producing output.";
}

function getMessageTextContent(message: Pick<Message, "content">): string {
  return message.content
    .filter((part): part is Extract<Message["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function getToolResultError(message: Message): string | null {
  if (message.role !== "toolResult" || message.isError !== true) return null;
  return getMessageTextContent(message) || `Tool ${message.toolName} failed.`;
}

interface ObservableToolCall {
  toolCallId: string;
  tool: string;
  args: unknown;
  status: "completed" | "failed";
  error: string | null;
}

interface ObservableToolCallState {
  persistedToolCallIds: Set<string>;
}

function createObservableToolCallState(): ObservableToolCallState {
  return { persistedToolCallIds: new Set<string>() };
}

function collectObservableToolCalls(messages: Message[]): ObservableToolCall[] {
  const toolCallMap = new Map<string, { tool: string; args: unknown }>();
  const observedResults: ObservableToolCall[] = [];
  const observedToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        toolCallMap.set(part.id, { tool: part.name, args: part.arguments });
      }
      continue;
    }

    if (message.role !== "toolResult" || observedToolCallIds.has(message.toolCallId)) continue;
    const toolCall = toolCallMap.get(message.toolCallId);
    if (!toolCall) continue;

    observedToolCallIds.add(message.toolCallId);
    observedResults.push({
      toolCallId: message.toolCallId,
      tool: toolCall.tool,
      args: toolCall.args,
      status: message.isError ? "failed" : "completed",
      error: getToolResultError(message),
    });
  }

  return observedResults;
}

async function persistObservableToolCalls(
  audit: AuditBatchHandle,
  taskId: string,
  messages: Message[],
  observedAt: string,
  state: ObservableToolCallState,
): Promise<void> {
  const observedCalls = collectObservableToolCalls(messages);
  for (const call of observedCalls) {
    if (state.persistedToolCallIds.has(call.toolCallId)) continue;
    await audit.recordToolCall(taskId, {
      at: observedAt,
      tool: call.tool,
      args: call.args,
      status: call.status,
      error: call.error,
    });
    state.persistedToolCallIds.add(call.toolCallId);
  }
}

async function buildTerminalTaskArtifact(audit: AuditBatchHandle, result: LiveTaskResult, finishedAt: string): Promise<TaskArtifact> {
  const currentTask = await readTaskArtifact(audit.batchDir, result.id);
  if (currentTask === null) {
    throw new Error(`Missing task artifact for ${result.id}.`);
  }

  const finalOutput = extractFinalOutput(result.messages);
  const error = getResultError(result) ?? null;
  const lastTimelineEntry = currentTask.timeline[currentTask.timeline.length - 1];
  const timeline = lastTimelineEntry?.state === result.status
    ? [...currentTask.timeline]
    : [...currentTask.timeline, { at: finishedAt, state: result.status }];

  return {
    ...currentTask,
    status: result.status,
    finishedAt,
    finalOutput: finalOutput || null,
    error,
    timeline,
  };
}

async function settleTaskAudit(audit: AuditBatchHandle, result: LiveTaskResult, toolCallState: ObservableToolCallState): Promise<void> {
  await persistObservableToolCalls(audit, result.id, result.messages, new Date().toISOString(), toolCallState);
  const finishedAt = new Date().toISOString();
  const terminalTask = await buildTerminalTaskArtifact(audit, result, finishedAt);
  const terminalStatus = result.status === "success" || result.status === "error" || result.status === "aborted"
    ? result.status
    : "error";
  await audit.writeTerminalTask(result.id, terminalTask);
  await audit.appendTaskFinished(result.id, finishedAt, terminalStatus, terminalTask.error);
}

function toPersistedTaskResult(result: LiveTaskResult): PersistedTaskResult {
  return {
    id: result.id,
    name: result.name,
    task: result.task,
    cwd: result.cwd,
    status: result.status,
    output: extractFinalOutput(result.messages),
    error: getResultError(result),
    usage: { ...result.usage },
    model: result.model,
    displayItems: extractDisplayItems(result.messages),
  };
}

function toPersistedDetails(details: TasksDetails): PersistedTasksDetails {
  return {
    results: details.results.map((result) => toPersistedTaskResult(result)),
    summary: { ...details.summary },
  };
}

export function resolveCompletedRunStatus(summary: TasksSummary): Exclude<RunStatus, "running"> {
  return resolveCompletedRunStatusImpl(summary);
}

function buildFinalBatchRecord(
  audit: AuditBatchHandle,
  details: TasksDetails,
  finishedAt: string,
  auditIntegrity: "ok" | "failed",
): BatchRecord & { status: Exclude<RunStatus, "running">; auditIntegrity: "ok" | "failed" } {
  const status = resolveCompletedRunStatus(details.summary);

  return {
    ...audit.batchRecord,
    finishedAt,
    status,
    summary: {
      total: details.summary.total,
      success: details.summary.success,
      error: details.summary.error,
      aborted: details.summary.aborted,
    },
    auditIntegrity,
  };
}

async function finalizeTaskBatch(audit: AuditBatchHandle, details: TasksDetails): Promise<BatchRecord> {
  const finishedAt = new Date().toISOString();
  const finalBatch = buildFinalBatchRecord(audit, details, finishedAt, "ok");
  const { status } = finalBatch;
  await audit.writeFinalBatch(finalBatch);
  await audit.appendBatchFinished(finishedAt, status, "ok");
  return finalBatch;
}

async function finalizeDegradedTaskBatch(audit: AuditBatchHandle, details: TasksDetails): Promise<BatchRecord> {
  const finishedAt = new Date().toISOString();
  const finalBatch = buildFinalBatchRecord(audit, details, finishedAt, "failed");
  try {
    await audit.writeFinalBatch(finalBatch);
  } catch {
    // Best effort only; incomplete batches may still be missing the final batch rewrite.
  }
  return finalBatch;
}

function buildRunDetail(summary: TasksSummary, startedAt: number, finishedAt?: number): string {
  if (summary.running > 0 || summary.queued > 0) {
    const done = summary.success + summary.error + summary.aborted;
    return `${done}/${summary.total} done, ${summary.running} running${summary.queued > 0 ? `, ${summary.queued} queued` : ""}`;
  }

  const duration = formatDuration(startedAt, finishedAt);
  const parts: string[] = [];
  if (summary.success) parts.push(`${summary.success} success`);
  if (summary.error) parts.push(`${summary.error} error`);
  if (summary.aborted) parts.push(`${summary.aborted} aborted`);
  if (parts.length === 0) parts.push("0 finished");
  return `${parts.join(", ")} in ${duration}`;
}

function buildRunTitle(tasks: NormalizedTaskSpec[]): string {
  if (tasks.length === 1) {
    const [task] = tasks;
    return task.name ?? shortenText(task.task, 56);
  }
  return `${tasks.length} tasks`;
}

function cloneTaskParams(params: TasksToolParams): TasksToolParams {
  return JSON.parse(JSON.stringify(params)) as TasksToolParams;
}

function buildTaskRunRecord(
  params: TasksToolParams,
  tasks: NormalizedTaskSpec[],
  cwd: string,
  toolName: "task" | "tasks",
  batchId: string,
  auditStartedAt: string,
): TaskRunRecord {
  const startedAt = Date.parse(auditStartedAt);
  const normalizedStartedAt = Number.isFinite(startedAt) ? startedAt : Date.now();
  return {
    id: `${normalizedStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
    batchId,
    status: "running",
    title: buildRunTitle(tasks),
    cwd,
    toolName,
    startedAt: normalizedStartedAt,
    detail: buildRunDetail(
      { total: tasks.length, queued: tasks.length, running: 0, success: 0, error: 0, aborted: 0 },
      normalizedStartedAt,
    ),
    tasks,
    params: cloneTaskParams(params),
  };
}

function createQueuedResult(task: NormalizedTaskSpec): LiveTaskResult {
  return {
    ...task,
    status: "queued",
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
}

function createSyntheticTerminalResult(
  task: NormalizedTaskSpec | LiveTaskResult,
  status: "error" | "aborted",
  errorMessage: string,
): LiveTaskResult {
  return {
    ...task,
    status,
    messages: "messages" in task ? [...task.messages] : [],
    stderr: "stderr" in task ? task.stderr : "",
    usage: "usage" in task ? { ...task.usage } : emptyUsage(),
    model: "model" in task ? task.model : undefined,
    stopReason: "stopReason" in task ? task.stopReason : undefined,
    errorMessage,
    exitCode: "exitCode" in task ? task.exitCode : undefined,
  };
}

function createAbortedResult(task: NormalizedTaskSpec | LiveTaskResult, errorMessage = "Task was aborted."): LiveTaskResult {
  return createSyntheticTerminalResult(task, "aborted", errorMessage);
}

function createErrorResult(task: NormalizedTaskSpec | LiveTaskResult, errorMessage = "Task failed before launch."): LiveTaskResult {
  return createSyntheticTerminalResult(task, "error", errorMessage);
}

function clonePreLaunchFailureResult(
  task: NormalizedTaskSpec | LiveTaskResult,
  failure: { result: LiveTaskResult },
): LiveTaskResult {
  return failure.result.status === "error"
    ? createErrorResult(task, failure.result.errorMessage || "Task failed before launch.")
    : createAbortedResult(task, failure.result.errorMessage || "Task was aborted.");
}

export function collectTaskIds(runs: TaskRunRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    for (const task of run.tasks) ids.add(task.id);
  }
  return ids;
}

export function generateTaskId(existingIds: Set<string>): string {
  while (true) {
    const id = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
}

export function validateTaskParams(params: TasksToolParams, maxTasks: number): void {
  if (!params.tasks?.length) {
    throw new Error("At least one task is required.");
  }
  if (params.tasks.length > maxTasks) {
    throw new Error(`Too many tasks (${params.tasks.length}). Max is ${maxTasks}.`);
  }
  for (const task of params.tasks) {
    if (!task.task?.trim()) {
      throw new Error("Each task must include a non-empty task prompt.");
    }
    if (task.name !== undefined && !task.name.trim()) {
      throw new Error("Task names must be non-empty when provided.");
    }
  }
}

function normalizeTaskCwd(taskCwd: string | undefined, defaultCwd: string): string {
  const normalizedDefaultCwd = path.resolve(defaultCwd);
  return path.resolve(normalizedDefaultCwd, taskCwd ?? normalizedDefaultCwd);
}

export function normalizeTasks(
  tasks: TaskSpecInput[],
  defaultCwd: string,
  existingIds: Set<string>,
  createTaskId: (existingIds: Set<string>) => string = generateTaskId,
): NormalizedTaskSpec[] {
  return tasks.map((task) => ({
    id: createTaskId(existingIds),
    name: task.name?.trim() || undefined,
    task: task.task,
    cwd: normalizeTaskCwd(task.cwd, defaultCwd),
  }));
}

async function mapWithConcurrencyLimit<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  fn: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function createAsyncGate(): () => Promise<() => void> {
  let tail = Promise.resolve();

  return async () => {
    const previous = tail;
    let releaseCurrent!: () => void;
    tail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await previous;
    return releaseCurrent;
  };
}

function buildResultText(details: TasksDetails): string {
  const lines: string[] = [];
  const { summary } = details;
  const summaryParts: string[] = [];
  if (summary.success) summaryParts.push(`${summary.success} success`);
  if (summary.error) summaryParts.push(`${summary.error} error`);
  if (summary.aborted) summaryParts.push(`${summary.aborted} aborted`);
  if (summaryParts.length === 0) summaryParts.push("0 finished");
  lines.push(`TASKS complete: ${summaryParts.join(", ")}`);
  for (const result of details.results) {
    const identity = result.name ? `${result.name} · ${result.id}` : `task · ${result.id}`;
    const output = result.status === "error" || result.status === "aborted"
      ? getResultError(result) || "Task failed."
      : extractFinalOutput(result.messages) || "(no output)";
    lines.push(`\n${identity} - ${result.status}:\n${output}`);
  }
  return lines.join("\n");
}

function buildLiveStatusText(details: TasksDetails): string {
  const { summary } = details;
  return `TASKS running: ${summary.success + summary.error + summary.aborted}/${summary.total} done, ${summary.running} running${summary.queued ? `, ${summary.queued} queued` : ""}`;
}

function buildErrorResult(text: string, details: TasksDetails): AgentToolResult<TasksDetails> {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function buildAuditDegradedWarning(reason?: string): string {
  return reason ? `Audit degraded; leaving batch incomplete. ${reason}` : "Audit degraded; leaving batch incomplete.";
}

function resolvePreLaunchTerminalResult(
  task: NormalizedTaskSpec | LiveTaskResult,
  error: unknown,
  signal: AbortSignal | undefined,
): { result: LiveTaskResult; auditDegraded: boolean } {
  if (error instanceof PreLaunchTaskBatchFailure) {
    const result = error.syntheticStatus === "error"
      ? createErrorResult(task, error.message)
      : createAbortedResult(task, error.message);
    return { result, auditDegraded: error.auditDegraded };
  }

  if (signal?.aborted || isAbortError(error)) {
    return { result: createAbortedResult(task, getErrorMessage(error) || "Task was aborted."), auditDegraded: false };
  }

  return { result: createErrorResult(task, getErrorMessage(error) || "Task failed before launch."), auditDegraded: false };
}

async function appendBatchStartedEvent(
  audit: AuditBatchHandle,
  ctx: RunTasksContext,
  toolName: "task" | "tasks",
  startedAt: string,
) {
  await audit.appendEvent({ type: "batch_started", at: startedAt, toolName, rootCwd: ctx.cwd });
}

async function initializeTaskBatch(
  audit: AuditBatchHandle,
  normalizedTasks: NormalizedTaskSpec[],
  startedAt: string,
) {
  for (const task of normalizedTasks) {
    await audit.writeTaskArtifact(
      buildQueuedTaskArtifact({
        batchId: audit.batchId,
        id: task.id,
        name: task.name,
        task: task.task,
        cwd: task.cwd,
        queuedAt: startedAt,
      }),
    );
  }
  for (const task of normalizedTasks) {
    await audit.appendEvent({ type: "task_queued", at: startedAt, taskId: task.id });
  }
  await audit.markInitialized(normalizedTasks.map((task) => task.id));
}

async function markInitializationFailure(audit: AuditBatchHandle): Promise<string | null> {
  try {
    await fs.access(audit.batchPath);
  } catch {
    return null;
  }

  const failedBatch = {
    ...audit.batchRecord,
    status: "initializing" as const,
    auditIntegrity: "failed" as const,
  };

  try {
    await audit.writeBatch(failedBatch);
    return null;
  } catch (error) {
    const writeBatchError = getErrorMessage(error);

    try {
      await writeBatchJson(audit.batchDir, failedBatch);
      return `Recovered retained pre-init batch state after writeBatch failed: ${writeBatchError}`;
    } catch (rewriteError) {
      const rewriteMessage = getErrorMessage(rewriteError);

      try {
        await fs.rm(audit.batchPath, { force: true });
        return `Removed stale batch.json after writeBatch failed: ${writeBatchError}. Direct batch.json rewrite also failed: ${rewriteMessage}`;
      } catch (removeError) {
        throw new Error(
          [
            `Failed to persist failed pre-init task batch state: ${writeBatchError}`,
            `Direct batch.json rewrite also failed: ${rewriteMessage}`,
            `Removing stale batch.json also failed: ${getErrorMessage(removeError)}`,
          ].join(". "),
          { cause: removeError },
        );
      }
    }
  }
}

async function cleanupFailedInitialization(
  audit: AuditBatchHandle,
  cleanupAuditBatch: (audit: AuditBatchHandle) => Promise<void>,
): Promise<string | null> {
  try {
    await cleanupAuditBatch(audit);
    return null;
  } catch (cleanupError) {
    try {
      const retentionNote = await markInitializationFailure(audit);
      return [
        `Cleanup also failed: ${getErrorMessage(cleanupError)}`,
        retentionNote,
      ]
        .filter((part): part is string => Boolean(part))
        .join(". ");
    } catch (markError) {
      return [
        `Cleanup also failed: ${getErrorMessage(cleanupError)}`,
        `Failed to persist the retained pre-init state: ${getErrorMessage(markError)}`,
      ].join(". ");
    }
  }
}

export async function executeTasksRunFlow(
  params: TasksToolParams,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  ctx: RunTasksContext,
  deps: RunTasksDependencies,
  invokingToolName: "task" | "tasks",
): Promise<AgentToolResult<TasksDetails>> {
  if (deps.processIsChild) {
    return buildErrorResult("Nested task invocation is not allowed", buildDetails([]));
  }

  try {
    validateTaskParams(params, deps.maxTasks);
  } catch (error) {
    return buildErrorResult(getErrorMessage(error), buildDetails([]));
  }

  const fallbackModel = ctx.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model?.id;
  const fallbackThinking = deps.getThinkingLevel();
  const existingIds = collectTaskIds([...deps.getActiveRuns(), ...deps.getRecentRuns()]);
  const createAuditBatch = deps.createAuditBatch ?? createAuditBatchImpl;
  const cleanupAuditBatch = deps.cleanupAuditBatch ?? ((audit: AuditBatchHandle) => fs.rm(audit.batchDir, { recursive: true, force: true }));
  const toolName = invokingToolName;
  const auditStartedAt = new Date().toISOString();

  let audit: AuditBatchHandle | null = null;
  let normalizedTasks: NormalizedTaskSpec[] = [];
  let liveResults: LiveTaskResult[] = [];
  let run: TaskRunRecord | null = null;
  let auditError: string | null = null;
  let cleanupError: string | null = null;
  let auditClassification: "complete" | "incomplete" = "complete";
  let emitPartialUpdate = () => undefined;

  const acquirePreLaunchGate = createAsyncGate();
  let preLaunchFailure: { result: LiveTaskResult; auditDegraded: boolean } | null = null;

  const cancelAll = () => {
    for (const task of normalizedTasks) {
      deps.pendingAbortTaskIds.add(task.id);
      deps.activeTaskControllers.get(task.id)?.abort();
    }
  };

  const noteAuditDegradation = async (message: string) => {
    if (auditClassification === "incomplete") return;
    auditClassification = "incomplete";
    try {
      await audit?.logWarning(message);
    } catch {
      // Ignore warning transport failures after the batch is already degraded.
    }
    emitPartialUpdate();
  };

  const bestEffortSettleTaskAudit = async (result: LiveTaskResult, toolCallState: ObservableToolCallState) => {
    try {
      await settleTaskAudit(audit!, result, toolCallState);
    } catch (error) {
      await noteAuditDegradation(buildAuditDegradedWarning(`Could not settle task ${result.id}: ${getErrorMessage(error)}`));
    }
  };

  try {
    audit = await createAuditBatch({
      rootCwd: ctx.cwd,
      toolName,
      startedAt: auditStartedAt,
    });
    await appendBatchStartedEvent(audit, ctx, toolName, auditStartedAt);

    normalizedTasks = normalizeTasks(params.tasks, ctx.cwd, existingIds, deps.generateTaskId ?? generateTaskId);
    run = buildTaskRunRecord(params, normalizedTasks, ctx.cwd, toolName, audit.batchId, auditStartedAt);
    deps.startRun(run, ctx);

    liveResults = normalizedTasks.map((task) => createQueuedResult(task));
    emitPartialUpdate = () => {
      const details = buildDetails([...liveResults]);
      deps.patchRun(
        run!.id,
        {
          detail: buildRunDetail(details.summary, run!.startedAt),
          details: toPersistedDetails(details),
          auditClassification,
        },
        ctx,
      );
      onUpdate?.({ content: [{ type: "text", text: buildLiveStatusText(details) }], details });
    };

    if (signal) {
      if (signal.aborted) cancelAll();
      else signal.addEventListener("abort", cancelAll, { once: true });
    }

    emitPartialUpdate();
    await initializeTaskBatch(audit, normalizedTasks, auditStartedAt);
  } catch (error) {
    auditError = getErrorMessage(error);
    if (audit) {
      cleanupError = await cleanupFailedInitialization(audit, cleanupAuditBatch);
    }
  }

  if (auditError !== null) {
    cancelAll();
    const details = buildDetails([...liveResults]);
    const message = cleanupError
      ? `Task batch initialization failed: ${auditError}. ${cleanupError}`
      : `Task batch initialization failed: ${auditError}`;
    if (run) deps.failRun(run.id, message, ctx);
    return buildErrorResult(message, details);
  }

  if (run === null) {
    throw new Error("Task batch run was not initialized.");
  }

  try {
    const results = await mapWithConcurrencyLimit(normalizedTasks, deps.maxConcurrency, async (task, index) => {
      const toolCallState = createObservableToolCallState();
      const currentSnapshot = () => liveResults[index] ?? createQueuedResult(task);
      let controller: AbortController | null = null;
      let runningMarkerPromise: Promise<void> | null = null;
      let toolTraceSyncPromise = Promise.resolve();
      let observedLaunch = false;
      let releasePreLaunchGate: (() => void) | null = null;

      const releaseLaunchGateIfHeld = () => {
        if (!releasePreLaunchGate) return;
        const release = releasePreLaunchGate;
        releasePreLaunchGate = null;
        release();
      };

      const settleTerminalResult = async (result: LiveTaskResult) => {
        await bestEffortSettleTaskAudit(result, toolCallState);
        liveResults[index] = result;
        emitPartialUpdate();
        return result;
      };

      const markRunning = () => {
        if (runningMarkerPromise) return runningMarkerPromise;
        runningMarkerPromise = (async () => {
          let marked = false;
          try {
            marked = await audit!.tryMarkRunning(task.id, new Date().toISOString());
          } catch (error) {
            await noteAuditDegradation(buildAuditDegradedWarning(`Could not persist running audit for task ${task.id}: ${getErrorMessage(error)}`));
          }
          if (!marked) {
            await noteAuditDegradation(buildAuditDegradedWarning(`Could not persist running audit for task ${task.id}.`));
          }
          if (liveResults[index].status === "queued") {
            liveResults[index] = { ...liveResults[index], status: "running" };
            emitPartialUpdate();
          }
        })();
        return runningMarkerPromise;
      };

      const acknowledgeLaunch = () => {
        if (observedLaunch) return runningMarkerPromise ?? Promise.resolve();
        observedLaunch = true;
        const runningMarker = markRunning();
        void runningMarker.finally(() => {
          releaseLaunchGateIfHeld();
        });
        return runningMarker;
      };

      const queueObservableToolTraceSync = (messages: Message[]) => {
        const observedAt = new Date().toISOString();
        const runningMarker = runningMarkerPromise ?? Promise.resolve();
        toolTraceSyncPromise = toolTraceSyncPromise.then(async () => {
          await runningMarker;
          try {
            // Incremental tool-trace writes are best-effort; terminal settle retries only missed traces.
            await persistObservableToolCalls(audit!, task.id, messages, observedAt, toolCallState);
          } catch {
            // Ignore incremental tool-trace persistence failures and recover during terminal settle.
          }
        });
        void toolTraceSyncPromise.catch(() => undefined);
        return toolTraceSyncPromise;
      };

      try {
        releasePreLaunchGate = await acquirePreLaunchGate();

        const blockedResult = preLaunchFailure
          ? clonePreLaunchFailureResult(currentSnapshot(), preLaunchFailure)
          : auditClassification === "incomplete"
            ? createAbortedResult(currentSnapshot(), "Task was not launched because task batch audit degraded.")
            : deps.pendingAbortTaskIds.has(task.id) || signal?.aborted
              ? createAbortedResult(currentSnapshot())
              : null;

        if (blockedResult) {
          return settleTerminalResult(blockedResult);
        }

        try {
          await deps.beforeTaskLaunch?.(task, index);
        } catch (error) {
          const resolved = resolvePreLaunchTerminalResult(currentSnapshot(), error, signal);
          if (resolved.auditDegraded) {
            await noteAuditDegradation(buildAuditDegradedWarning(getErrorMessage(error)));
          }
          preLaunchFailure ??= resolved;
          return settleTerminalResult(resolved.result);
        }

        controller = new AbortController();
        deps.activeTaskControllers.set(task.id, controller);

        const result = await deps.runSingleTask(
          task,
          controller.signal,
          (partial) => {
            void acknowledgeLaunch();
            liveResults[index] = partial;
            emitPartialUpdate();
            void queueObservableToolTraceSync(partial.messages);
          },
          fallbackModel,
          fallbackThinking,
          acknowledgeLaunch,
        );
        await toolTraceSyncPromise.catch(() => undefined);
        if (observedLaunch) {
          await (runningMarkerPromise ?? Promise.resolve());
        } else {
          await markRunning();
        }
        return settleTerminalResult(result);
      } catch (error) {
        await toolTraceSyncPromise.catch(() => undefined);
        const snapshot = currentSnapshot();
        const didLaunch = observedLaunch || snapshot.status === "running" || snapshot.messages.length > 0;
        if (!didLaunch) {
          const resolved = resolvePreLaunchTerminalResult(snapshot, error, signal);
          if (resolved.auditDegraded) {
            await noteAuditDegradation(buildAuditDegradedWarning(getErrorMessage(error)));
          }
          preLaunchFailure ??= resolved;
          return settleTerminalResult(resolved.result);
        }

        const shouldSynthesizeAbort = signal?.aborted || isAbortError(error);
        if (shouldSynthesizeAbort) {
          const aborted = createAbortedResult(snapshot, getErrorMessage(error) || "Task was aborted.");
          return settleTerminalResult(aborted);
        }
        throw error;
      } finally {
        releaseLaunchGateIfHeld();
        deps.activeTaskControllers.delete(task.id);
        deps.pendingAbortTaskIds.delete(task.id);
      }
    });

    const details = buildDetails(results);
    if (auditClassification === "incomplete") {
      await finalizeDegradedTaskBatch(audit!, details);
    } else {
      try {
        await finalizeTaskBatch(audit!, details);
      } catch (error) {
        await noteAuditDegradation(buildAuditDegradedWarning(`Could not finalize batch ${audit!.batchId}: ${getErrorMessage(error)}`));
        await finalizeDegradedTaskBatch(audit!, details);
      }
    }
    deps.finishRun(run.id, details, ctx, { auditClassification });
    return {
      content: [{ type: "text", text: buildResultText(details) }],
      details,
      isError: details.summary.error > 0 || details.summary.aborted > 0,
    };
  } catch (error) {
    cancelAll();
    deps.failRun(run.id, getErrorMessage(error), ctx);
    throw error;
  } finally {
    for (const task of normalizedTasks) {
      deps.activeTaskControllers.delete(task.id);
      deps.pendingAbortTaskIds.delete(task.id);
    }
  }
}
