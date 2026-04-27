import type { BatchSummary, FailureKind, Retryability, TaskArtifact, TaskFinalStatus, TaskLifecycleStatus } from "./types.ts";

export interface TaskView {
  taskId: string;
  name: string;
  lifecycleStatus: TaskLifecycleStatus;
  finalStatus: TaskFinalStatus | null;
  displayStatus: TaskLifecycleStatus | TaskFinalStatus;
  terminal: boolean;
  icon: "✓" | "✗" | "⊘" | "◐" | "·";
  failureKind: FailureKind;
  retryability: Retryability;
  acceptanceStatus: TaskArtifact["acceptance"]["status"];
  attempts: number;
  retried: boolean;
  error: string | null;
  failureReason: string;
}

function isTerminalLifecycle(status: TaskLifecycleStatus): status is TaskFinalStatus {
  return status === "success" || status === "error" || status === "aborted";
}

function effectiveFinalStatus(task: TaskArtifact): TaskFinalStatus | null {
  // Old/live artifacts may temporarily carry a stale finalStatus while a retry is
  // running. The lifecycle state is the stronger signal for in-flight tasks.
  if (task.status === "queued" || task.status === "running") return null;
  if (task.finalStatus) return task.finalStatus;
  return isTerminalLifecycle(task.status) ? task.status : null;
}

export function failureReasonLabel(kind: FailureKind, task?: TaskArtifact): string {
  switch (kind) {
    case "acceptance_failed": return "acceptance failed";
    case "provider_transient": return "provider error (transient)";
    case "provider_permanent": return "provider error";
    case "launch_error": return "launch failed";
    case "protocol_error": {
      const errors = task?.workerReport?.errors ?? [];
      if (errors.some((message) => /not valid JSON/i.test(message))) return "invalid task report";
      return "protocol error";
    }
    case "worker_incomplete": {
      const errors = task?.workerReport?.errors ?? [];
      if (errors.some((message) => /No task report submitted|ENOENT.*task-report/i.test(message))) return "no task report";
      const lastAttempt = task?.attempts?.[task.attempts.length - 1];
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

function iconForStatus(status: TaskLifecycleStatus | TaskFinalStatus): TaskView["icon"] {
  switch (status) {
    case "success": return "✓";
    case "error": return "✗";
    case "aborted": return "⊘";
    case "running": return "◐";
    default: return "·";
  }
}

export function deriveTaskView(task: TaskArtifact): TaskView {
  const finalStatus = effectiveFinalStatus(task);
  const displayStatus = finalStatus ?? task.status;
  const failureKind: FailureKind = finalStatus === "success" || displayStatus === "running" || displayStatus === "queued" ? "none" : task.failureKind;
  const failureReason = finalStatus === "error" ? failureReasonLabel(failureKind, task) || "error" : "";
  return {
    taskId: task.taskId,
    name: task.name,
    lifecycleStatus: task.status,
    finalStatus,
    displayStatus,
    terminal: finalStatus !== null,
    icon: iconForStatus(displayStatus),
    failureKind,
    retryability: task.retryability,
    acceptanceStatus: task.acceptance.status,
    attempts: task.attempts.length,
    retried: task.attempts.length > 1,
    error: task.error,
    failureReason,
  };
}

export function deriveTaskViews(tasks: TaskArtifact[]): TaskView[] {
  return tasks.map(deriveTaskView);
}

export interface LifecycleCounts extends BatchSummary {
  done: number;
  queued: number;
  running: number;
}

export function summarizeTaskViews(views: TaskView[]): BatchSummary {
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

export function summarizeTasks(tasks: TaskArtifact[]): BatchSummary {
  return summarizeTaskViews(deriveTaskViews(tasks));
}

export function countTaskLifecycle(tasks: TaskArtifact[]): LifecycleCounts {
  const views = deriveTaskViews(tasks);
  const summary = summarizeTaskViews(views);
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
