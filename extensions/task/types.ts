export type BatchStatus = "initializing" | "running" | "success" | "error" | "aborted" | "incomplete";
export type TaskLifecycleStatus = "queued" | "running" | "success" | "error" | "aborted";
export type TaskFinalStatus = "success" | "error" | "aborted";
export type RuntimeStatus = "not_started" | "running" | "success" | "error" | "aborted";
export type WorkerReportStatus = "not_submitted" | "completed" | "partial" | "blocked" | "error" | "invalid";
export type AcceptanceStatus = "skipped" | "pending" | "passed" | "warning" | "failed";
export type AuditIntegrity = "pending" | "ok" | "failed" | "degraded";
export type Retryability = "retryable" | "not_retryable";

export type FailureKind =
  | "none"
  | "provider_transient"
  | "provider_permanent"
  | "launch_error"
  | "protocol_error"
  | "acceptance_failed"
  | "audit_failed"
  | "worker_incomplete"
  | "worker_stalled"
  | "provider_stalled"
  | "unknown_stall"
  | "aborted"
  | "unknown";

export type EventSeverity = "info" | "warning" | "error";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface TaskDeliverable {
  path: string;
  kind: "file" | "dir" | "note" | "command";
  description?: string;
}

export interface TaskEvidence {
  kind: "file" | "command" | "text";
  value: string;
}

export interface InternalRetryRecord {
  reason: string;
  action: string;
  outcome: "recovered" | "failed";
}

export interface TaskReport {
  schemaVersion: 1;
  taskId: string;
  attemptId: string;
  status: Exclude<WorkerReportStatus, "not_submitted" | "invalid">;
  summary: string;
  deliverables: TaskDeliverable[];
  evidence: TaskEvidence[];
  internalRetries?: InternalRetryRecord[];
  userActionRequired?: string | null;
  error?: string | null;
}

export interface RuntimeOutcome {
  status: RuntimeStatus;
  exitCode?: number;
  stopReason?: string;
  sawTerminalAssistantMessage?: boolean;
  stderrTail?: string;
  failureKind?: FailureKind;
  retryability?: Retryability;
}

export interface WorkerReportOutcome {
  status: WorkerReportStatus;
  reportPath?: string;
  report?: TaskReport;
  errors: string[];
  warnings: string[];
}

export type AcceptanceCheckStatus = "passed" | "warning" | "failed";

export interface AcceptanceCheckResult {
  name: string;
  status: AcceptanceCheckStatus;
  message: string;
  path?: string;
  expected?: string;
  actual?: string;
}

export interface AcceptanceOutcome {
  status: AcceptanceStatus;
  checks: AcceptanceCheckResult[];
  warnings: string[];
  errors: string[];
}

export interface RetryDecision {
  retryability: Retryability;
  failureKind: FailureKind;
  reason: string;
  delayMs?: number;
}

export interface TaskAttemptRecord {
  id: string;
  index: number;
  taskId: string;
  status: TaskLifecycleStatus;
  startedAt: string;
  finishedAt: string | null;
  cwd: string;
  attemptDir: string;
  workerLogPath: string;
  reportPath: string;
  stdoutPath: string;
  stderrPath: string;
  runtime: RuntimeOutcome;
  workerReport: WorkerReportOutcome;
  failureKind: FailureKind;
  retryability: Retryability;
  error: string | null;
  warnings: string[];
}

export interface PathCheck {
  path: string;
  type?: "file" | "dir" | "glob";
  minBytes?: number;
  requiredRegex?: string[];
  forbiddenRegex?: string[];
}

export interface AcceptanceContract {
  requiredPaths?: Array<string | PathCheck>;
  forbiddenPaths?: string[];
  requiredOutputRegex?: string[];
  forbiddenOutputRegex?: string[];
  requiredReportRegex?: string[];
  forbiddenReportRegex?: string[];
  minWorkerLogBytes?: number;
  minReportSummaryChars?: number;
  allowedWritePaths?: string[];
  forbiddenWritePaths?: string[];
  requireDeliverablesEvidence?: boolean;
  auditOnly?: boolean;
}

export interface ParentRetryPolicy {
  maxAttempts?: number;
  retryOn?: FailureKind[];
  backoffMs?: {
    initial?: number;
    max?: number;
    multiplier?: number;
    jitter?: boolean;
  };
}

export interface ThrottlePolicy {
  enabled?: boolean;
  minConcurrency?: number;
  maxConcurrency?: number;
  transientFailureThreshold?: number;
  windowSize?: number;
}

export interface AuditOptions {
  level?: "basic" | "full";
}

export interface TaskSpecInput {
  id?: string;
  name: string;
  prompt: string;
  cwd?: string;
  acceptance?: AcceptanceContract;
  metadata?: Record<string, string>;
}

export interface TasksToolParams {
  tasks: TaskSpecInput[];
  concurrency?: number;
  retry?: ParentRetryPolicy;
  throttle?: ThrottlePolicy;
  audit?: AuditOptions;
  acceptanceDefaults?: AcceptanceContract;
  parentBatchId?: string;
  rerunOfTaskIds?: string[];
}

export interface NormalizedTaskSpec extends TaskSpecInput {
  id: string;
  cwd: string;
  prompt: string;
  acceptance?: AcceptanceContract;
}

export interface TaskArtifact {
  schemaVersion: 1;
  batchId: string;
  taskId: string;
  name: string;
  prompt: string;
  cwd: string;
  status: TaskLifecycleStatus;
  finalStatus: TaskFinalStatus | null;
  failureKind: FailureKind;
  retryability: Retryability;
  acceptance: AcceptanceOutcome;
  acceptanceContract?: AcceptanceContract;
  workerReport: WorkerReportOutcome;
  attempts: TaskAttemptRecord[];
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeline: Array<{ at: string; state: TaskLifecycleStatus; message?: string }>;
  warnings: string[];
  error: string | null;
  metadata?: Record<string, string>;
}

export interface BatchSummary {
  total: number;
  success: number;
  error: number;
  aborted: number;
  acceptanceFailed: number;
  providerTransientFailed: number;
  protocolFailed: number;
  retried: number;
}

export interface BatchArtifact {
  schemaVersion: 1;
  batchId: string;
  toolName: "task" | "tasks";
  rootCwd: string;
  batchDir: string;
  startedAt: string;
  finishedAt: string | null;
  status: BatchStatus;
  initialized: boolean;
  auditIntegrity: AuditIntegrity;
  taskIds: string[];
  parentBatchId?: string;
  rerunOfTaskIds?: string[];
  requestedConcurrency: number;
  effectiveConcurrency: number;
  summary: BatchSummary;
}

export interface DeriveTaskStatusInput {
  runtime: RuntimeOutcome | RuntimeStatus;
  workerReport: WorkerReportOutcome | WorkerReportStatus;
  acceptance: AcceptanceOutcome | AcceptanceStatus;
  auditIntegrity?: AuditIntegrity;
}

function runtimeStatusOf(value: RuntimeOutcome | RuntimeStatus): RuntimeStatus {
  return typeof value === "string" ? value : value.status;
}

function workerReportStatusOf(value: WorkerReportOutcome | WorkerReportStatus): WorkerReportStatus {
  return typeof value === "string" ? value : value.status;
}

function acceptanceStatusOf(value: AcceptanceOutcome | AcceptanceStatus): AcceptanceStatus {
  return typeof value === "string" ? value : value.status;
}

export function deriveTaskFinalStatus(input: DeriveTaskStatusInput): TaskFinalStatus {
  const runtimeStatus = runtimeStatusOf(input.runtime);
  if (runtimeStatus === "aborted") return "aborted";
  if (runtimeStatus !== "success") return "error";

  const workerStatus = workerReportStatusOf(input.workerReport);
  if (workerStatus !== "completed") return "error";

  const acceptanceStatus = acceptanceStatusOf(input.acceptance);
  if (acceptanceStatus === "failed" || acceptanceStatus === "pending") return "error";

  if (input.auditIntegrity !== undefined && input.auditIntegrity !== "ok") return "error";

  return "success";
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function emptyAcceptance(status: AcceptanceStatus = "skipped"): AcceptanceOutcome {
  return { status, checks: [], warnings: [], errors: [] };
}

export function emptyWorkerReport(status: WorkerReportStatus = "not_submitted"): WorkerReportOutcome {
  return { status, errors: [], warnings: [] };
}
