import type { FailureKind, ParentRetryPolicy, RetryDecision } from "./types.ts";

export interface NormalizedRetryPolicy {
  maxAttempts: number;
  retryOn: FailureKind[];
  backoffMs: {
    initial: number;
    max: number;
    multiplier: number;
    jitter: boolean;
  };
}

export const DEFAULT_PARENT_RETRY_POLICY: NormalizedRetryPolicy = {
  maxAttempts: 2,
  retryOn: ["launch_error", "provider_transient", "provider_stalled", "worker_stalled", "worker_incomplete"],
  backoffMs: { initial: 1500, max: 15000, multiplier: 2, jitter: true },
};

export function normalizeRetryPolicy(policy?: ParentRetryPolicy): NormalizedRetryPolicy {
  return {
    maxAttempts: Math.max(1, policy?.maxAttempts ?? DEFAULT_PARENT_RETRY_POLICY.maxAttempts),
    retryOn: policy?.retryOn?.length ? policy.retryOn : DEFAULT_PARENT_RETRY_POLICY.retryOn,
    backoffMs: {
      initial: policy?.backoffMs?.initial ?? DEFAULT_PARENT_RETRY_POLICY.backoffMs.initial,
      max: policy?.backoffMs?.max ?? DEFAULT_PARENT_RETRY_POLICY.backoffMs.max,
      multiplier: policy?.backoffMs?.multiplier ?? DEFAULT_PARENT_RETRY_POLICY.backoffMs.multiplier,
      jitter: policy?.backoffMs?.jitter ?? DEFAULT_PARENT_RETRY_POLICY.backoffMs.jitter,
    },
  };
}

export function computeBackoffMs(policy: NormalizedRetryPolicy, attemptIndex: number, random = Math.random): number {
  const base = Math.min(policy.backoffMs.max, Math.round(policy.backoffMs.initial * Math.pow(policy.backoffMs.multiplier, Math.max(0, attemptIndex - 1))));
  if (!policy.backoffMs.jitter) return base;
  const jitter = 0.75 + random() * 0.5;
  return Math.min(policy.backoffMs.max, Math.max(0, Math.round(base * jitter)));
}

export function shouldRetryAttempt(input: {
  attemptIndex: number;
  policy: NormalizedRetryPolicy;
  decision: RetryDecision;
  validWorkerReport: boolean;
}): boolean {
  if (input.attemptIndex >= input.policy.maxAttempts) return false;
  if (input.decision.retryability !== "retryable") return false;
  if (!input.policy.retryOn.includes(input.decision.failureKind)) return false;
  if (input.validWorkerReport) return false;
  return true;
}
