import type { BatchSummary, FailureKind, Retryability, JobArtifact, JobFinalStatus, JobLifecycleStatus } from "./types.ts";

export interface JobView {
  jobId: string;
  name: string;
  lifecycleStatus: JobLifecycleStatus;
  finalStatus: JobFinalStatus | null;
  displayStatus: JobLifecycleStatus | JobFinalStatus;
  terminal: boolean;
  icon: "✓" | "✗" | "⊘" | "◐" | "·";
  failureKind: FailureKind;
  retryability: Retryability;
  acceptanceStatus: JobArtifact["acceptance"]["status"];
  attempts: number;
  retried: boolean;
  error: string | null;
  failureReason: string;
}

function isTerminalLifecycle(status: JobLifecycleStatus): status is JobFinalStatus {
  return status === "success" || status === "error" || status === "aborted";
}

function effectiveFinalStatus(job: JobArtifact): JobFinalStatus | null {
  // Old/live artifacts may temporarily carry a stale finalStatus while a retry is
  // running. The lifecycle state is the stronger signal for in-flight jobs.
  if (job.status === "queued" || job.status === "running") return null;
  if (job.finalStatus) return job.finalStatus;
  return isTerminalLifecycle(job.status) ? job.status : null;
}

export function failureReasonLabel(kind: FailureKind, job?: JobArtifact): string {
  switch (kind) {
    case "acceptance_failed": return "acceptance failed";
    case "provider_transient": return "provider error (transient)";
    case "provider_permanent": return "provider error";
    case "launch_error": return "launch failed";
    case "protocol_error": {
      const errors = job?.workerReport?.errors ?? [];
      if (errors.some((message) => /not valid JSON/i.test(message))) return "invalid job report";
      return "protocol error";
    }
    case "worker_incomplete": {
      const errors = job?.workerReport?.errors ?? [];
      if (errors.some((message) => /No job report submitted|ENOENT.*job-report/i.test(message))) return "no job report";
      const lastAttempt = job?.attempts?.[job.attempts.length - 1];
      if (lastAttempt?.runtime?.stopReason === "thinking_only_stop") return "thinking-only stop";
      return "worker incomplete";
    }
    case "worker_stalled": return "worker stalled";
    case "provider_stalled": return "provider stalled";
    case "unknown_stall": return "stalled";
    case "audit_failed": return "audit failed";
    case "aborted": return "aborted";
    case "unknown": return "error";
    default: return "";
  }
}

function iconForStatus(status: JobLifecycleStatus | JobFinalStatus): JobView["icon"] {
  switch (status) {
    case "success": return "✓";
    case "error": return "✗";
    case "aborted": return "⊘";
    case "running": return "◐";
    default: return "·";
  }
}

export function deriveJobView(job: JobArtifact): JobView {
  const finalStatus = effectiveFinalStatus(job);
  const displayStatus = finalStatus ?? job.status;
  const failureKind: FailureKind = finalStatus === "success" || displayStatus === "running" || displayStatus === "queued" ? "none" : job.failureKind;
  const failureReason = finalStatus === "error" ? failureReasonLabel(failureKind, job) || "error" : "";
  return {
    jobId: job.jobId,
    name: job.name,
    lifecycleStatus: job.status,
    finalStatus,
    displayStatus,
    terminal: finalStatus !== null,
    icon: iconForStatus(displayStatus),
    failureKind,
    retryability: job.retryability,
    acceptanceStatus: job.acceptance.status,
    attempts: job.attempts.length,
    retried: job.attempts.length > 1,
    error: job.error,
    failureReason,
  };
}

export function deriveJobViews(jobs: JobArtifact[]): JobView[] {
  return jobs.map(deriveJobView);
}

export interface LifecycleCounts extends BatchSummary {
  done: number;
  queued: number;
  running: number;
}

export function summarizeJobViews(views: JobView[]): BatchSummary {
  const summary: BatchSummary = {
    total: views.length,
    success: 0,
    error: 0,
    aborted: 0,
    acceptanceFailed: 0,
    providerTransientFailed: 0,
    protocolFailed: 0,
    retried: 0,
  };
  for (const view of views) {
    if (view.finalStatus) summary[view.finalStatus] += 1;
    if (view.failureKind === "acceptance_failed") summary.acceptanceFailed += 1;
    if (view.failureKind === "provider_transient") summary.providerTransientFailed += 1;
    if (view.failureKind === "protocol_error") summary.protocolFailed += 1;
    if (view.retried) summary.retried += 1;
  }
  return summary;
}

export function summarizeJobs(jobs: JobArtifact[]): BatchSummary {
  return summarizeJobViews(deriveJobViews(jobs));
}

export function countJobLifecycle(jobs: JobArtifact[]): LifecycleCounts {
  const views = deriveJobViews(jobs);
  const summary = summarizeJobViews(views);
  return {
    ...summary,
    done: views.filter((view) => view.terminal).length,
    queued: views.filter((view) => view.displayStatus === "queued").length,
    running: views.filter((view) => view.displayStatus === "running").length,
  };
}

export function terminalBatchStatus(summary: BatchSummary): "success" | "error" | "aborted" {
  if (summary.error > 0) return "error";
  if (summary.aborted > 0) return "aborted";
  return "success";
}
