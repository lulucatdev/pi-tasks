import { classifyAndDecide, retryDecisionForFailure } from "./failure-classifier.ts";
import {
  deriveTaskFinalStatus,
  type AcceptanceOutcome,
  type AuditIntegrity,
  type FailureKind,
  type RetryDecision,
  type RuntimeOutcome,
  type TaskFinalStatus,
  type WorkerReportOutcome,
} from "./types.ts";

export type BlockingGate = "none" | "runtime" | "protocol" | "acceptance" | "audit";

export interface FinalOutcome {
  finalStatus: TaskFinalStatus;
  blockingGate: BlockingGate;
  failureKind: FailureKind;
  retryDecision: RetryDecision;
  runtimeDecision: RetryDecision;
  reason: string;
}

export interface DeriveFinalOutcomeInput {
  runtime: RuntimeOutcome & { error?: string | null };
  workerReport: WorkerReportOutcome;
  protocolKind: FailureKind;
  acceptance: AcceptanceOutcome;
  auditIntegrity?: AuditIntegrity;
}

function blockingGateFor(input: DeriveFinalOutcomeInput): BlockingGate {
  if (input.runtime.status === "aborted" || input.runtime.status !== "success") return "runtime";
  if (input.workerReport.status !== "completed") return "protocol";
  if (input.acceptance.status === "failed" || input.acceptance.status === "pending") return "acceptance";
  if (input.auditIntegrity !== undefined && input.auditIntegrity !== "ok") return "audit";
  return "none";
}

function failureKindFor(input: DeriveFinalOutcomeInput, gate: BlockingGate, runtimeDecision: RetryDecision): FailureKind {
  if (gate === "none") return "none";
  if (gate === "runtime") return runtimeDecision.failureKind === "none" ? "unknown" : runtimeDecision.failureKind;
  if (gate === "protocol") return input.protocolKind === "none" ? "worker_incomplete" : input.protocolKind;
  if (gate === "acceptance") return "acceptance_failed";
  if (gate === "audit") return "audit_failed";
  return "unknown";
}

function reasonFor(gate: BlockingGate, failureKind: FailureKind): string {
  if (gate === "none") return "All blocking gates passed.";
  return `${gate} gate blocked final success (${failureKind}).`;
}

/**
 * Collapse attempt facts into a single final outcome. This is intentionally pure:
 * supervisor gathers facts; this module decides the blocking gate, failure kind,
 * and parent-retry decision. UI and summaries can then display the structured
 * reason instead of guessing from partially duplicated artifact fields.
 */
export function deriveFinalOutcome(input: DeriveFinalOutcomeInput): FinalOutcome {
  const runtimeDecision = classifyAndDecide(input.runtime);
  const finalStatus = deriveTaskFinalStatus({
    runtime: input.runtime,
    workerReport: input.workerReport,
    acceptance: input.acceptance,
    auditIntegrity: input.auditIntegrity,
  });
  const gate = finalStatus === "success" ? "none" : blockingGateFor(input);
  const failureKind = failureKindFor(input, gate, runtimeDecision);
  const retryDecision = failureKind === runtimeDecision.failureKind
    ? runtimeDecision
    : retryDecisionForFailure(failureKind, input.runtime.status);
  return {
    finalStatus,
    blockingGate: gate,
    failureKind,
    retryDecision,
    runtimeDecision,
    reason: reasonFor(gate, failureKind),
  };
}
