import type { FailureKind, RetryDecision, RuntimeOutcome, RuntimeStatus } from "./types.ts";

const TRANSIENT_PATTERNS = [
  /\b429\b/i,
  /\b5\d\d\b/i,
  /overloaded/i,
  /rate\s*limit/i,
  /internal server error/i,
  /connection reset/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /timeout/i,
  /temporar(?:y|ily)/i,
  /terminated/i,
];

const PERMANENT_PATTERNS = [
  /invalid api key/i,
  /authentication/i,
  /unauthorized/i,
  /permission denied/i,
  /forbidden/i,
  /model not found/i,
  /unsupported/i,
  /invalid request/i,
];

function textOf(input: { stderrTail?: string; error?: string | null; stopReason?: string } | string | undefined): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  return [input.stderrTail, input.error, input.stopReason].filter(Boolean).join("\n");
}

export function isProviderTransient(text: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyRuntimeFailure(input: RuntimeOutcome & { error?: string | null }): FailureKind {
  if (input.status === "aborted") return "aborted";
  if (input.status === "success") return "none";
  if (input.failureKind === "launch_error") return "launch_error";
  if (input.failureKind === "worker_incomplete" || input.stopReason === "thinking_only_stop") return "worker_incomplete";

  const text = textOf(input);
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) return "provider_permanent";
  if (isProviderTransient(text)) return "provider_transient";
  if (input.stopReason === "error") return "provider_permanent";
  return "unknown";
}

export function classifyProtocolFailure(errors: string[]): FailureKind {
  if (!errors.length) return "none";
  // Worker that ran cleanly but never submitted a task report is "incomplete" rather
  // than a hard protocol error: thinking-only stops, hung turns, etc. are typically
  // transient model behavior, so we want the parent to retry once before giving up.
  if (errors.some((message) => /No task report submitted|ENOENT|task-report\.json/i.test(message))) {
    return "worker_incomplete";
  }
  return "protocol_error";
}

export function classifyAcceptanceFailure(failed: boolean): FailureKind {
  return failed ? "acceptance_failed" : "none";
}

export function retryDecisionForFailure(kind: FailureKind, status?: RuntimeStatus): RetryDecision {
  if (
    kind === "launch_error"
    || kind === "provider_transient"
    || kind === "provider_stalled"
    || kind === "worker_stalled"
    || kind === "worker_incomplete"
  ) {
    return { retryability: "retryable", failureKind: kind, reason: `${kind} is parent-retryable` };
  }
  if (kind === "unknown" && status === "error") {
    return { retryability: "not_retryable", failureKind: kind, reason: "Unknown runtime errors are not retried without a transient signal" };
  }
  return { retryability: "not_retryable", failureKind: kind, reason: `${kind} is not parent-retryable` };
}

export function classifyAndDecide(input: RuntimeOutcome & { error?: string | null }): RetryDecision {
  const kind = classifyRuntimeFailure(input);
  return retryDecisionForFailure(kind, input.status);
}
