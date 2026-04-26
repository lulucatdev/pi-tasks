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
