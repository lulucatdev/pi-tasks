import type { BatchArtifact, TaskArtifact, TasksToolParams, TaskSpecInput } from "./types.ts";
import { loadBatchDetail, type BatchDetail } from "./task-ui.ts";

export const RERUN_FILTERS = ["failed", "provider-transient", "acceptance-failed", "selected"] as const;
export type RerunFilter = typeof RERUN_FILTERS[number];

export function isRerunFilter(value: string): value is RerunFilter {
  return (RERUN_FILTERS as readonly string[]).includes(value);
}

export interface BuildRerunInput {
  detail: BatchDetail;
  originalParams?: TasksToolParams;
  filter: RerunFilter;
  taskIds?: string[];
  concurrency?: number;
}

function shouldInclude(task: TaskArtifact, filter: RerunFilter, selectedIds: Set<string>): boolean {
  if (filter === "selected") return selectedIds.has(task.taskId);
  if (filter === "failed") return task.finalStatus !== "success";
  if (filter === "provider-transient") return task.failureKind === "provider_transient";
  if (filter === "acceptance-failed") return task.failureKind === "acceptance_failed";
  return false;
}

function taskToInput(task: TaskArtifact, original?: TaskSpecInput): TaskSpecInput {
  return {
    id: task.taskId,
    name: task.name,
    prompt: original?.prompt ?? task.prompt,
    cwd: original?.cwd ?? task.cwd,
    acceptance: original?.acceptance ?? task.acceptanceContract,
    metadata: { ...(original?.metadata ?? {}), parentTaskId: task.taskId },
  };
}

export function buildRerunParams(input: BuildRerunInput): TasksToolParams & { parentBatchId: string; rerunOfTaskIds: string[] } {
  const selectedIds = new Set(input.taskIds ?? []);
  const originalByName = new Map((input.originalParams?.tasks ?? []).map((task) => [task.name, task]));
  const selected = input.detail.tasks.filter((task) => shouldInclude(task, input.filter, selectedIds));
  return {
    tasks: selected.map((task) => taskToInput(task, originalByName.get(task.name))),
    concurrency: input.concurrency ?? Math.max(1, Math.min(input.detail.batch.effectiveConcurrency, selected.length || 1)),
    retry: input.originalParams?.retry,
    throttle: input.originalParams?.throttle,
    audit: input.originalParams?.audit,
    acceptanceDefaults: input.originalParams?.acceptanceDefaults,
    parentBatchId: input.detail.batch.batchId,
    rerunOfTaskIds: selected.map((task) => task.taskId),
  };
}

export async function buildRerunParamsFromBatchDir(batchDir: string, filter: RerunFilter, taskIds?: string[]): Promise<TasksToolParams & { parentBatchId: string; rerunOfTaskIds: string[] }> {
  const detail = await loadBatchDetail(batchDir);
  return buildRerunParams({ detail, filter, taskIds });
}

export function attachRerunMetadata(batch: BatchArtifact, parentBatchId: string, rerunOfTaskIds: string[]): BatchArtifact {
  return { ...batch, parentBatchId, rerunOfTaskIds };
}
