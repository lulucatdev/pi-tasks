import * as path from "node:path";
import { generateJobIds } from "./audit-log.ts";
import type { AcceptanceContract, NormalizedJobSpec, JobSpecInput, JobsToolParams } from "./types.ts";

export const DEFAULT_MAX_JOBS = 100;
export const DEFAULT_CONCURRENCY = Number.POSITIVE_INFINITY; // normalized to the supplied job count
export const MAX_INLINE_JOBS = 4;
export const MAX_INLINE_PROMPT_BYTES = 8_000;

export interface NormalizedJobsRun {
  jobs: NormalizedJobSpec[];
  requestedConcurrency: number;
  effectiveConcurrency: number;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Jobs params must be an object.");
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
}

function isSafeJobId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && id !== "." && id !== ".." && !id.includes("..");
}

export function mergeAcceptanceContracts(defaults?: AcceptanceContract, job?: AcceptanceContract): AcceptanceContract | undefined {
  if (!defaults && !job) return undefined;
  return {
    ...(defaults ?? {}),
    ...(job ?? {}),
    requiredPaths: [...(defaults?.requiredPaths ?? []), ...(job?.requiredPaths ?? [])],
    forbiddenPaths: [...(defaults?.forbiddenPaths ?? []), ...(job?.forbiddenPaths ?? [])],
    requiredOutputRegex: [...(defaults?.requiredOutputRegex ?? []), ...(job?.requiredOutputRegex ?? [])],
    forbiddenOutputRegex: [...(defaults?.forbiddenOutputRegex ?? []), ...(job?.forbiddenOutputRegex ?? [])],
    requiredReportRegex: [...(defaults?.requiredReportRegex ?? []), ...(job?.requiredReportRegex ?? [])],
    forbiddenReportRegex: [...(defaults?.forbiddenReportRegex ?? []), ...(job?.forbiddenReportRegex ?? [])],
    allowedWritePaths: [...(defaults?.allowedWritePaths ?? []), ...(job?.allowedWritePaths ?? [])],
    forbiddenWritePaths: [...(defaults?.forbiddenWritePaths ?? []), ...(job?.forbiddenWritePaths ?? [])],
  };
}

export function validateJobsToolParams(params: unknown, maxJobs = DEFAULT_MAX_JOBS): asserts params is JobsToolParams {
  assertRecord(params);
  if (!Array.isArray(params.jobs) || params.jobs.length === 0) throw new Error("At least one job is required.");
  if (params.jobs.length > maxJobs) throw new Error(`Too many jobs (${params.jobs.length}). Max is ${maxJobs}.`);
  for (const [index, job] of params.jobs.entries()) {
    assertRecord(job);
    assertString(job.name, `jobs[${index}].name must be a non-empty string.`);
    assertString(job.prompt, `jobs[${index}].prompt must be a non-empty string.`);
    if (job.cwd !== undefined && typeof job.cwd !== "string") throw new Error(`jobs[${index}].cwd must be a string when provided.`);
    if (job.id !== undefined && (typeof job.id !== "string" || !job.id.trim())) throw new Error(`jobs[${index}].id must be a non-empty string when provided.`);
    if (job.id !== undefined && !isSafeJobId(job.id.trim())) throw new Error(`jobs[${index}].id must use only letters, numbers, dot, underscore, or dash and must not contain path traversal.`);
  }
  if (params.concurrency !== undefined) {
    if (!Number.isInteger(params.concurrency) || params.concurrency < 1) throw new Error("concurrency must be a positive integer when provided.");
  }
}

function requestedFanoutCount(text: string): number | undefined {
  const patterns = [
    /(?:launch|start|run|spawn|fan[- ]?out|发起|启动|运行)\D{0,30}(\d{1,3})\D{0,20}(?:agents?|workers?|jobs?|个\s*(?:并行\s*)?(?:agents?|agent|workers?|worker|任务))/i,
    /(\d{1,3})\s*(?:个\s*)?(?:并行\s*)?(?:agents?|agent|workers?|worker|任务|jobs?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const count = Number(match[1]);
    if (Number.isInteger(count) && count > 1) return count;
  }
  return undefined;
}

function looksLikeMetaFanoutJob(job: JobSpecInput): { matched: boolean; requestedCount?: number } {
  const text = `${job.name}\n${job.prompt}`;
  const requestedCount = requestedFanoutCount(text);
  if (requestedCount) return { matched: true, requestedCount };
  const hasAgentTerm = /\b(?:agents?|workers?|subjobs?)\b|并行|分工|分别|每个|每章|各章/i.test(text);
  const hasFanoutTerm = /\b(?:parallel|concurrent|fan[- ]?out|spawn|launch)\b|并行|发起|启动/i.test(text);
  return { matched: hasAgentTerm && hasFanoutTerm };
}

export function validateJobsFanoutUsage(params: JobsToolParams): void {
  validateJobsToolParams(params);
  if (params.jobs.length !== 1) return;
  const job = params.jobs[0]!;
  const meta = looksLikeMetaFanoutJob(job);
  const requestedConcurrency = params.concurrency ?? params.jobs.length;
  if (!meta.matched && requestedConcurrency <= 1) return;
  const expected = meta.requestedCount ?? (requestedConcurrency > 1 ? requestedConcurrency : undefined);
  throw new Error([
    `jobs received 1 job${expected ? ` but the request appears to need ${expected} supervised workers` : " but the request appears to need multiple supervised workers"}.`,
    "Do not create one coordinator/meta-job that launches or describes other agents.",
    "For repeated/templated fan-out, call jobs_plan with a small matrix and a promptTemplate.",
    "Use the single job tool only when exactly one worker should run.",
  ].join(" "));
}

export interface InlineJobsLimits {
  maxJobs: number;
  maxPromptBytes: number;
}

export function inlineJobsByteSize(params: JobsToolParams): number {
  let total = 0;
  for (const job of params.jobs) {
    total += Buffer.byteLength(job.prompt ?? "", "utf-8");
    total += Buffer.byteLength(job.name ?? "", "utf-8");
  }
  return total;
}

export function enforceInlineJobsLimit(params: JobsToolParams, limits: InlineJobsLimits = { maxJobs: MAX_INLINE_JOBS, maxPromptBytes: MAX_INLINE_PROMPT_BYTES }): void {
  const totalBytes = inlineJobsByteSize(params);
  if (params.jobs.length <= limits.maxJobs && totalBytes <= limits.maxPromptBytes) return;
  throw new Error([
    `jobs rejected: ${params.jobs.length} job${params.jobs.length === 1 ? "" : "s"} (limit ${limits.maxJobs}), ${totalBytes} prompt bytes (limit ${limits.maxPromptBytes}).`,
    "Inline jobs() is reserved for tiny ad-hoc batches. For repeated or templated fan-out (every chapter, every report, every file), use jobs_plan with a small matrix + promptTemplate so the model never has to stream a huge tool-call argument.",
    "Example: jobs_plan({ batchName: \"...\", matrix: [{ id, vars }, ...], promptTemplate: \"...\", acceptanceTemplate: { ... } }). Add concurrency only when you intentionally want a local cap.",
  ].join(" "));
}

export function normalizeJobsRun(params: JobsToolParams, defaultCwd: string, maxConcurrency = Number.POSITIVE_INFINITY): NormalizedJobsRun {
  validateJobsToolParams(params);
  const generatedIds = generateJobIds(params.jobs.length);
  const seen = new Set<string>();
  const jobs = params.jobs.map((job: JobSpecInput, index): NormalizedJobSpec => {
    const id = (job.id?.trim() || generatedIds[index]) as string;
    if (seen.has(id)) throw new Error(`Duplicate job id: ${id}`);
    seen.add(id);
    return {
      ...job,
      id,
      name: job.name.trim(),
      prompt: job.prompt,
      cwd: path.resolve(defaultCwd, job.cwd ?? defaultCwd),
      acceptance: mergeAcceptanceContracts(params.acceptanceDefaults, job.acceptance),
      metadata: job.metadata,
    };
  });
  const requestedConcurrency = params.concurrency ?? jobs.length;
  const effectiveConcurrency = Math.max(1, Math.min(requestedConcurrency, maxConcurrency, jobs.length));
  return { jobs, requestedConcurrency, effectiveConcurrency };
}

export interface JobsRunResultSummary {
  batchId: string;
  batchDir: string;
  status: "success" | "error" | "aborted" | "incomplete";
  total: number;
  success: number;
  error: number;
  aborted: number;
  summaryPath?: string;
  elapsed?: string;
}

export function buildResultText(summary: JobsRunResultSummary): string {
  const headingStatus = summary.status === "success" ? "done" : summary.status;
  const counts: string[] = [];
  if (summary.success) counts.push(`${summary.success}✓`);
  if (summary.error) counts.push(`${summary.error}✗`);
  if (summary.aborted) counts.push(`${summary.aborted}⊘`);
  if (counts.length === 0) counts.push("0 jobs");
  const heading = `JOBS ${headingStatus} · ${counts.join(" ")} / ${summary.total}${summary.elapsed ? ` · ${summary.elapsed}` : ""}`;
  return [
    heading,
    `/jobs-ui ${summary.batchId}`,
    summary.summaryPath ? `summary: ${summary.summaryPath}` : undefined,
    summary.error > 0 ? `rerun failed: /jobs-ui rerun failed ${summary.batchId}` : undefined,
  ].filter(Boolean).join("\n");
}
