import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { extractDisplayItems, extractFinalOutput, type TaskDisplayItem } from "./task-output.ts";

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
  outputPath: string;
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
  status: RunStatus;
  title: string;
  cwd: string;
  toolName: "task" | "tasks";
  startedAt: number;
  finishedAt?: number;
  detail: string;
  tasks: NormalizedTaskSpec[];
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
  finishRun: (runId: string, details: TasksDetails, ctx: RunTasksContext) => void;
  failRun: (runId: string, detail: string, ctx: RunTasksContext) => void;
  runSingleTask: (
    task: NormalizedTaskSpec,
    signal: AbortSignal | undefined,
    onUpdate: ((result: LiveTaskResult) => void) | undefined,
    fallbackModel: string | undefined,
    fallbackThinking: string | undefined,
  ) => Promise<LiveTaskResult>;
  activeTaskControllers: Map<string, AbortController>;
  pendingAbortTaskIds: Set<string>;
  generateTaskId?: (existingIds: Set<string>) => string;
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

export function resolveCompletedRunStatus(summary: TasksSummary): Exclude<RunStatus, "running"> {
  if (summary.error > 0) return "error";
  if (summary.aborted > 0) return "aborted";
  return "success";
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
): TaskRunRecord {
  const startedAt = Date.now();
  return {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    title: buildRunTitle(tasks),
    cwd,
    toolName,
    startedAt,
    detail: buildRunDetail(
      { total: tasks.length, queued: tasks.length, running: 0, success: 0, error: 0, aborted: 0 },
      startedAt,
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

function createAbortedResult(task: NormalizedTaskSpec | LiveTaskResult, errorMessage = "Task was aborted."): LiveTaskResult {
  return {
    ...task,
    status: "aborted",
    messages: "messages" in task ? [...task.messages] : [],
    stderr: "stderr" in task ? task.stderr : "",
    usage: "usage" in task ? { ...task.usage } : emptyUsage(),
    model: "model" in task ? task.model : undefined,
    stopReason: "stopReason" in task ? task.stopReason : undefined,
    errorMessage,
    exitCode: "exitCode" in task ? task.exitCode : undefined,
  };
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
  const rootCwd = path.resolve(defaultCwd);
  return tasks.map((task) => {
    const id = createTaskId(existingIds);
    return {
      id,
      name: task.name?.trim() || undefined,
      task: task.task,
      cwd: normalizeTaskCwd(task.cwd, defaultCwd),
      outputPath: path.join(rootCwd, ".pi", "tasks", `${id}.md`),
    };
  });
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

export function toPersistedTaskResult(result: LiveTaskResult): PersistedTaskResult {
  return {
    id: result.id,
    name: result.name,
    task: result.task,
    cwd: result.cwd,
    outputPath: result.outputPath,
    status: result.status,
    output: extractFinalOutput(result.messages),
    error: getResultError(result),
    usage: { ...result.usage },
    model: result.model,
    displayItems: extractDisplayItems(result.messages),
  };
}

export function toPersistedDetails(details: TasksDetails): PersistedTasksDetails {
  return {
    results: details.results.map((result) => toPersistedTaskResult(result)),
    summary: { ...details.summary },
  };
}

export async function ensureOutputFile(outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, "", "utf-8");
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
    if (result.status === "error" || result.status === "aborted") {
      const error = getResultError(result) || "Task failed.";
      lines.push(`\n${identity} - ${result.status}:\n${error}`);
    } else {
      lines.push(`\n${identity} - ${result.status}:\nOutput: ${result.outputPath}`);
    }
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
  const toolName = invokingToolName;

  const normalizedTasks = normalizeTasks(params.tasks, ctx.cwd, existingIds, deps.generateTaskId ?? generateTaskId);

  // Pre-create empty output files so workers can write to them
  for (const task of normalizedTasks) {
    await ensureOutputFile(task.outputPath);
  }

  const run = buildTaskRunRecord(params, normalizedTasks, ctx.cwd, toolName);
  deps.startRun(run, ctx);

  let liveResults: LiveTaskResult[] = normalizedTasks.map((task) => createQueuedResult(task));

  const emitPartialUpdate = () => {
    const details = buildDetails([...liveResults]);
    deps.patchRun(
      run.id,
      {
        detail: buildRunDetail(details.summary, run.startedAt),
        details: toPersistedDetails(details),
      },
      ctx,
    );
    onUpdate?.({ content: [{ type: "text", text: buildLiveStatusText(details) }], details });
  };

  const cancelAll = () => {
    for (const task of normalizedTasks) {
      deps.pendingAbortTaskIds.add(task.id);
      deps.activeTaskControllers.get(task.id)?.abort();
    }
  };

  if (signal) {
    if (signal.aborted) cancelAll();
    else signal.addEventListener("abort", cancelAll, { once: true });
  }

  emitPartialUpdate();

  try {
    const results = await mapWithConcurrencyLimit(normalizedTasks, deps.maxConcurrency, async (task, index) => {
      let controller: AbortController | null = null;

      try {
        if (deps.pendingAbortTaskIds.has(task.id) || signal?.aborted) {
          const aborted = createAbortedResult(task);
          liveResults[index] = aborted;
          emitPartialUpdate();
          return aborted;
        }

        controller = new AbortController();
        deps.activeTaskControllers.set(task.id, controller);

        liveResults[index] = { ...liveResults[index], status: "running" };
        emitPartialUpdate();

        const result = await deps.runSingleTask(
          task,
          controller.signal,
          (partial) => {
            liveResults[index] = partial;
            emitPartialUpdate();
          },
          fallbackModel,
          fallbackThinking,
        );

        liveResults[index] = result;
        emitPartialUpdate();
        return result;
      } finally {
        deps.activeTaskControllers.delete(task.id);
        deps.pendingAbortTaskIds.delete(task.id);
      }
    });

    const details = buildDetails(results);
    deps.finishRun(run.id, details, ctx);
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
