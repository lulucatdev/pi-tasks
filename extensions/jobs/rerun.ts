import type { BatchArtifact, JobArtifact, JobsToolParams, JobSpecInput } from "./types.ts";
import { loadBatchDetail, type BatchDetail } from "./job-ui.ts";

export const RERUN_FILTERS = ["failed", "provider-transient", "acceptance-failed", "selected"] as const;
export type RerunFilter = typeof RERUN_FILTERS[number];

export function isRerunFilter(value: string): value is RerunFilter {
  return (RERUN_FILTERS as readonly string[]).includes(value);
}

export interface BuildRerunInput {
  detail: BatchDetail;
  originalParams?: JobsToolParams;
  filter: RerunFilter;
  jobIds?: string[];
  concurrency?: number;
}

function shouldInclude(job: JobArtifact, filter: RerunFilter, selectedIds: Set<string>): boolean {
  if (filter === "selected") return selectedIds.has(job.jobId);
  if (filter === "failed") return job.finalStatus !== "success";
  if (filter === "provider-transient") return job.failureKind === "provider_transient";
  if (filter === "acceptance-failed") return job.failureKind === "acceptance_failed";
  return false;
}

function jobToInput(job: JobArtifact, original?: JobSpecInput): JobSpecInput {
  return {
    id: job.jobId,
    name: job.name,
    prompt: original?.prompt ?? job.prompt,
    cwd: original?.cwd ?? job.cwd,
    acceptance: original?.acceptance ?? job.acceptanceContract,
    metadata: { ...(original?.metadata ?? {}), parentJobId: job.jobId },
  };
}

export function buildRerunParams(input: BuildRerunInput): JobsToolParams & { parentBatchId: string; rerunOfJobIds: string[] } {
  const selectedIds = new Set(input.jobIds ?? []);
  const originalByName = new Map((input.originalParams?.jobs ?? []).map((job) => [job.name, job]));
  const selected = input.detail.jobs.filter((job) => shouldInclude(job, input.filter, selectedIds));
  return {
    jobs: selected.map((job) => jobToInput(job, originalByName.get(job.name))),
    concurrency: input.concurrency ?? Math.max(1, Math.min(input.detail.batch.effectiveConcurrency, selected.length || 1)),
    retry: input.originalParams?.retry,
    throttle: input.originalParams?.throttle,
    acceptanceDefaults: input.originalParams?.acceptanceDefaults,
    parentBatchId: input.detail.batch.batchId,
    rerunOfJobIds: selected.map((job) => job.jobId),
  };
}

export async function buildRerunParamsFromBatchDir(batchDir: string, filter: RerunFilter, jobIds?: string[]): Promise<JobsToolParams & { parentBatchId: string; rerunOfJobIds: string[] }> {
  const detail = await loadBatchDetail(batchDir);
  return buildRerunParams({ detail, filter, jobIds });
}

export function attachRerunMetadata(batch: BatchArtifact, parentBatchId: string, rerunOfJobIds: string[]): BatchArtifact {
  return { ...batch, parentBatchId, rerunOfJobIds };
}
