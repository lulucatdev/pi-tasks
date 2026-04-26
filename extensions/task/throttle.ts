import type { FailureKind, ThrottlePolicy } from "./types.ts";

export interface ThrottleDecision {
  previousConcurrency: number;
  nextConcurrency: number;
  reason: string;
  transientRate: number;
}

export interface NormalizedThrottlePolicy {
  enabled: boolean;
  minConcurrency: number;
  maxConcurrency: number;
  transientFailureThreshold: number;
  windowSize: number;
}

export function normalizeThrottlePolicy(policy: ThrottlePolicy | undefined, requestedConcurrency: number): NormalizedThrottlePolicy {
  const cap = Math.max(1, requestedConcurrency);
  const maxConcurrency = Math.max(1, Math.min(policy?.maxConcurrency ?? cap, cap));
  const minConcurrency = Math.max(1, Math.min(policy?.minConcurrency ?? 1, maxConcurrency));
  return {
    enabled: policy?.enabled ?? true,
    minConcurrency,
    maxConcurrency,
    transientFailureThreshold: policy?.transientFailureThreshold ?? 0.2,
    windowSize: Math.max(1, policy?.windowSize ?? 5),
  };
}

function isTransient(kind: FailureKind): boolean {
  return kind === "provider_transient" || kind === "provider_stalled" || kind === "launch_error";
}

export class ThrottleController {
  readonly policy: NormalizedThrottlePolicy;
  currentConcurrency: number;
  private readonly window: boolean[] = [];
  private stableWindows = 0;

  constructor(policy: NormalizedThrottlePolicy, initialConcurrency: number) {
    this.policy = policy;
    this.currentConcurrency = Math.max(policy.minConcurrency, Math.min(initialConcurrency, policy.maxConcurrency));
  }

  record(kind: FailureKind): ThrottleDecision | null {
    if (!this.policy.enabled) return null;
    this.window.push(isTransient(kind));
    if (this.window.length > this.policy.windowSize) this.window.shift();
    if (this.window.length < this.policy.windowSize) return null;

    const transientRate = this.window.filter(Boolean).length / this.window.length;
    const previous = this.currentConcurrency;
    if (transientRate >= this.policy.transientFailureThreshold && this.currentConcurrency > this.policy.minConcurrency) {
      this.currentConcurrency = Math.max(this.policy.minConcurrency, Math.floor(this.currentConcurrency / 2));
      this.stableWindows = 0;
      return { previousConcurrency: previous, nextConcurrency: this.currentConcurrency, transientRate, reason: "transient failure threshold exceeded" };
    }

    if (transientRate === 0) this.stableWindows += 1;
    else this.stableWindows = 0;
    if (this.stableWindows >= 2 && this.currentConcurrency < this.policy.maxConcurrency) {
      this.currentConcurrency += 1;
      this.stableWindows = 0;
      return { previousConcurrency: previous, nextConcurrency: this.currentConcurrency, transientRate, reason: "stable windows recovered concurrency" };
    }

    return null;
  }
}
