import * as path from "node:path";
import { generateTaskIds } from "./audit-log.ts";
import type { AcceptanceContract, NormalizedTaskSpec, TaskSpecInput, TasksToolParams } from "./types.ts";

export const DEFAULT_MAX_TASKS = 100;
export const DEFAULT_CONCURRENCY = 8;
export const HARD_MAX_CONCURRENCY = 64;

export interface NormalizedTasksRun {
  tasks: NormalizedTaskSpec[];
  requestedConcurrency: number;
  effectiveConcurrency: number;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tasks params must be an object.");
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
}

function isSafeTaskId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && id !== "." && id !== ".." && !id.includes("..");
}

export function mergeAcceptanceContracts(defaults?: AcceptanceContract, task?: AcceptanceContract): AcceptanceContract | undefined {
  if (!defaults && !task) return undefined;
  return {
    ...(defaults ?? {}),
    ...(task ?? {}),
    requiredPaths: [...(defaults?.requiredPaths ?? []), ...(task?.requiredPaths ?? [])],
    forbiddenPaths: [...(defaults?.forbiddenPaths ?? []), ...(task?.forbiddenPaths ?? [])],
    requiredOutputRegex: [...(defaults?.requiredOutputRegex ?? []), ...(task?.requiredOutputRegex ?? [])],
    forbiddenOutputRegex: [...(defaults?.forbiddenOutputRegex ?? []), ...(task?.forbiddenOutputRegex ?? [])],
    requiredReportRegex: [...(defaults?.requiredReportRegex ?? []), ...(task?.requiredReportRegex ?? [])],
    forbiddenReportRegex: [...(defaults?.forbiddenReportRegex ?? []), ...(task?.forbiddenReportRegex ?? [])],
    allowedWritePaths: [...(defaults?.allowedWritePaths ?? []), ...(task?.allowedWritePaths ?? [])],
    forbiddenWritePaths: [...(defaults?.forbiddenWritePaths ?? []), ...(task?.forbiddenWritePaths ?? [])],
  };
}

export function validateTasksToolParams(params: unknown, maxTasks = DEFAULT_MAX_TASKS): asserts params is TasksToolParams {
  assertRecord(params);
  if (!Array.isArray(params.tasks) || params.tasks.length === 0) throw new Error("At least one task is required.");
  if (params.tasks.length > maxTasks) throw new Error(`Too many tasks (${params.tasks.length}). Max is ${maxTasks}.`);
  for (const [index, task] of params.tasks.entries()) {
    assertRecord(task);
    assertString(task.name, `tasks[${index}].name must be a non-empty string.`);
    assertString(task.prompt, `tasks[${index}].prompt must be a non-empty string.`);
    if (task.cwd !== undefined && typeof task.cwd !== "string") throw new Error(`tasks[${index}].cwd must be a string when provided.`);
    if (task.id !== undefined && (typeof task.id !== "string" || !task.id.trim())) throw new Error(`tasks[${index}].id must be a non-empty string when provided.`);
    if (task.id !== undefined && !isSafeTaskId(task.id.trim())) throw new Error(`tasks[${index}].id must use only letters, numbers, dot, underscore, or dash and must not contain path traversal.`);
  }
  if (params.concurrency !== undefined) {
    if (!Number.isInteger(params.concurrency) || params.concurrency < 1) throw new Error("concurrency must be a positive integer when provided.");
  }
}

function requestedFanoutCount(text: string): number | undefined {
  const patterns = [
    /(?:launch|start|run|spawn|fan[- ]?out|发起|启动|运行)\D{0,30}(\d{1,3})\D{0,20}(?:agents?|workers?|tasks?|个\s*(?:并行\s*)?(?:agents?|agent|workers?|worker|任务))/i,
    /(\d{1,3})\s*(?:个\s*)?(?:并行\s*)?(?:agents?|agent|workers?|worker|任务|tasks?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const count = Number(match[1]);
    if (Number.isInteger(count) && count > 1) return count;
  }
  return undefined;
}

function looksLikeMetaFanoutTask(task: TaskSpecInput): { matched: boolean; requestedCount?: number } {
  const text = `${task.name}\n${task.prompt}`;
  const requestedCount = requestedFanoutCount(text);
  if (requestedCount) return { matched: true, requestedCount };
  const hasAgentTerm = /\b(?:agents?|workers?|subtasks?)\b|并行|分工|分别|每个|每章|各章/i.test(text);
  const hasFanoutTerm = /\b(?:parallel|concurrent|fan[- ]?out|spawn|launch)\b|并行|发起|启动/i.test(text);
  return { matched: hasAgentTerm && hasFanoutTerm };
}

export function validateTasksFanoutUsage(params: TasksToolParams): void {
  validateTasksToolParams(params);
  if (params.tasks.length !== 1) return;
  const task = params.tasks[0]!;
  const meta = looksLikeMetaFanoutTask(task);
  const requestedConcurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
  if (!meta.matched && requestedConcurrency <= 1) return;
  const expected = meta.requestedCount ?? (requestedConcurrency > 1 ? requestedConcurrency : undefined);
  throw new Error([
    `tasks received 1 task${expected ? ` but the request appears to need ${expected} supervised agents` : " but the request appears to need multiple supervised agents"}.`,
    "Do not create one coordinator/meta-task that launches or describes other agents.",
    "Call tasks with one item per worker in the tasks array, then set concurrency to the desired parallelism.",
    "Use the single task tool only when exactly one worker should run.",
  ].join(" "));
}

export function normalizeTasksRun(params: TasksToolParams, defaultCwd: string, maxConcurrency = HARD_MAX_CONCURRENCY): NormalizedTasksRun {
  validateTasksToolParams(params);
  const generatedIds = generateTaskIds(params.tasks.length);
  const seen = new Set<string>();
  const tasks = params.tasks.map((task: TaskSpecInput, index): NormalizedTaskSpec => {
    const id = (task.id?.trim() || generatedIds[index]) as string;
    if (seen.has(id)) throw new Error(`Duplicate task id: ${id}`);
    seen.add(id);
    return {
      ...task,
      id,
      name: task.name.trim(),
      prompt: task.prompt,
      cwd: path.resolve(defaultCwd, task.cwd ?? defaultCwd),
      acceptance: mergeAcceptanceContracts(params.acceptanceDefaults, task.acceptance),
      metadata: task.metadata,
    };
  });
  const requestedConcurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
  const effectiveConcurrency = Math.max(1, Math.min(requestedConcurrency, maxConcurrency, tasks.length));
  return { tasks, requestedConcurrency, effectiveConcurrency };
}

export interface TasksRunResultSummary {
  batchId: string;
  batchDir: string;
  status: "success" | "error" | "aborted" | "incomplete";
  total: number;
  success: number;
  error: number;
  aborted: number;
  summaryPath?: string;
}

export function buildResultText(summary: TasksRunResultSummary): string {
  const parts = [`${summary.success} success`, `${summary.error} error`, `${summary.aborted} aborted`];
  return [
    `TASKS ${summary.status}: ${parts.join(", ")} / ${summary.total} total`,
    `Batch: ${summary.batchId}`,
    `Artifacts: ${summary.batchDir}`,
    summary.summaryPath ? `Summary: ${summary.summaryPath}` : undefined,
    `Inspect: /tasks-ui ${summary.batchId}`,
    summary.error > 0 ? `Rerun failed: /tasks-ui rerun failed ${summary.batchId}` : undefined,
  ].filter(Boolean).join("\n");
}
