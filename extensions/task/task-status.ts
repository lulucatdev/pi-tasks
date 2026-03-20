export interface TaskSummaryLike {
  queued: number;
  running: number;
  error: number;
  aborted: number;
}

export type CompletedRunStatus = "success" | "error" | "aborted";
export type RunStatusWithRunning = CompletedRunStatus | "running";

export function resolveCompletedRunStatus(summary: TaskSummaryLike): CompletedRunStatus {
  if (summary.running > 0 || summary.queued > 0) {
    throw new Error("Cannot resolve a completed run status while tasks are still queued or running.");
  }
  if (summary.error > 0) return "error";
  if (summary.aborted > 0) return "aborted";
  return "success";
}

export function resolveRunStatus(summary: TaskSummaryLike): RunStatusWithRunning {
  if (summary.running > 0 || summary.queued > 0) return "running";
  return resolveCompletedRunStatus(summary);
}
