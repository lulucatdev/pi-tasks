import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDiscoverableBatch, readJsonFile } from "./audit-log.ts";
import { renderActivityCollapsedLine, renderActivitySummaryLines } from "./thinking-steps.ts";
import { deriveJobView, summarizeJobs } from "./job-view.ts";
import type { BatchArtifact, InternalRetryRecord, JobArtifact, JobAttemptRecord, JobDeliverable, JobEvidence } from "./types.ts";

export interface BatchListItem {
  batchId: string;
  status: string;
  auditIntegrity: string;
  startedAt: string;
  finishedAt: string | null;
  batchDir: string;
  summaryText: string;
}

export interface BatchDetail {
  batch: BatchArtifact;
  jobs: JobArtifact[];
  summaryMarkdown?: string;
}

export function storageRootForCwd(cwd: string): string {
  return path.join(path.resolve(cwd), ".pi", "jobs");
}

export async function discoverBatchDirs(cwd: string): Promise<string[]> {
  const root = storageRootForCwd(cwd);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory() && await isDiscoverableBatch(candidate)) dirs.push(candidate);
  }
  return dirs.sort().reverse();
}

function durationText(startedAt: string, finishedAt: string | null): string {
  const start = Date.parse(startedAt);
  const finish = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(finish)) return finishedAt ? "-" : "running";
  const seconds = Math.max(0, Math.round((finish - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function truncate(text: string | null | undefined, max = 180): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "-";
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function statusLabel(status: string | null | undefined): string {
  return (status ?? "pending").toUpperCase();
}

function lastAttempt(job: JobArtifact): JobAttemptRecord | undefined {
  return job.attempts.at(-1);
}

function jobSortKey(job: JobArtifact): string {
  return `${deriveJobView(job).finalStatus === "success" ? "1" : "0"}:${job.jobId}`;
}

function failureReason(job: JobArtifact): string {
  return truncate(
    job.error
      ?? job.acceptance.errors[0]
      ?? job.workerReport.errors[0]
      ?? job.workerReport.report?.userActionRequired
      ?? lastAttempt(job)?.error
      ?? job.warnings[0],
    220,
  );
}

function summaryPath(batch: BatchArtifact): string {
  return path.join(batch.batchDir, "summary.md");
}

function renderPath(label: string, value: string | undefined): string | undefined {
  return value ? `- ${label}: ${value}` : undefined;
}

function renderDeliverables(deliverables: JobDeliverable[] = []): string[] {
  if (deliverables.length === 0) return ["- Deliverables: -"];
  return ["- Deliverables:", ...deliverables.map((item) => `  - ${item.kind}: ${item.path}${item.description ? ` - ${item.description}` : ""}`)];
}

function renderEvidence(evidence: JobEvidence[] = []): string[] {
  if (evidence.length === 0) return ["- Evidence: -"];
  return ["- Evidence:", ...evidence.map((item) => `  - ${item.kind}: ${truncate(item.value, 220)}`)];
}

function renderInternalRetries(retries: InternalRetryRecord[] = []): string[] {
  if (retries.length === 0) return [];
  return ["- Internal retries:", ...retries.map((item) => `  - ${item.outcome}: ${item.reason} -> ${item.action}`)];
}

export function summarizeBatch(batch: BatchArtifact, jobs?: JobArtifact[]): BatchListItem {
  const materializedSummary = jobs ? summarizeJobs(jobs) : batch.summary;
  const parts = [
    `${materializedSummary.success} ok`,
    `${materializedSummary.error} err`,
    `${materializedSummary.aborted} aborted`,
  ];
  if (materializedSummary.acceptanceFailed) parts.push(`${materializedSummary.acceptanceFailed} acceptance`);
  if (materializedSummary.providerTransientFailed) parts.push(`${materializedSummary.providerTransientFailed} transient`);
  if (materializedSummary.retried) parts.push(`${materializedSummary.retried} retried`);
  return {
    batchId: batch.batchId,
    status: batch.status,
    auditIntegrity: batch.auditIntegrity,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    batchDir: batch.batchDir,
    summaryText: parts.join(", "),
  };
}

export async function listBatches(cwd: string): Promise<BatchListItem[]> {
  const dirs = await discoverBatchDirs(cwd);
  const items: BatchListItem[] = [];
  for (const dir of dirs) {
    const batch = await readJsonFile<BatchArtifact>(path.join(dir, "batch.json"));
    const jobs = await Promise.all(batch.jobIds.map((jobId) => readJsonFile<JobArtifact>(path.join(dir, "jobs", `${jobId}.json`)).catch(() => null)));
    items.push(summarizeBatch(batch, jobs.filter((job): job is JobArtifact => job !== null)));
  }
  return items;
}

export function resolveBatchDir(cwd: string, input: string): string {
  if (path.isAbsolute(input)) return input;
  if (input.includes("/") || input.includes(path.sep)) return path.resolve(cwd, input);
  return path.join(storageRootForCwd(cwd), input);
}

export async function loadBatchDetail(batchDir: string): Promise<BatchDetail> {
  const batch = await readJsonFile<BatchArtifact>(path.join(batchDir, "batch.json"));
  const jobs = await Promise.all(batch.jobIds.map((jobId) => readJsonFile<JobArtifact>(path.join(batchDir, "jobs", `${jobId}.json`))));
  let summaryMarkdown: string | undefined;
  try {
    summaryMarkdown = await fs.readFile(path.join(batchDir, "summary.md"), "utf-8");
  } catch {
    summaryMarkdown = undefined;
  }
  return { batch, jobs, summaryMarkdown };
}

export function renderJobsUiHelpLines(): string[] {
  return [
    "Jobs UI commands:",
    "- /jobs-ui",
    "- /jobs-ui help",
    "- /jobs-ui <batchId|batchDir>",
    "- /jobs-ui <batchId|batchDir> job <jobId>",
    "- /jobs-ui <batchId|batchDir> attempt <jobId> <attemptId|latest>",
    "- /jobs-ui rerun failed <batchId|batchDir>",
    "- /jobs-ui rerun acceptance-failed <batchId|batchDir>",
    "- /jobs-ui rerun provider-transient <batchId|batchDir>",
    "- /jobs-ui rerun selected <batchId|batchDir> <jobId> [jobId...]",
  ];
}

export function renderBatchListLines(items: BatchListItem[]): string[] {
  if (items.length === 0) return ["No job batches found.", "Run `jobs` or `job`, then inspect with `/jobs-ui <batchId>`." ];
  return items.map((item) => {
    const duration = durationText(item.startedAt, item.finishedAt);
    return `${statusLabel(item.status)} ${item.batchId} ${item.summaryText} audit=${item.auditIntegrity} duration=${duration}`;
  });
}

export function renderBatchDetailLines(detail: BatchDetail): string[] {
  const batch = detail.batch;
  const materializedSummary = summarizeJobs(detail.jobs);
  const failed = detail.jobs.filter((job) => deriveJobView(job).finalStatus !== "success").sort((a, b) => jobSortKey(a).localeCompare(jobSortKey(b)));
  const allJobs = [...detail.jobs].sort((a, b) => jobSortKey(a).localeCompare(jobSortKey(b)));
  const lines = [
    `Batch ${batch.batchId}`,
    `Status: ${batch.status} audit=${batch.auditIntegrity}`,
    `Summary: ${materializedSummary.success} ok, ${materializedSummary.error} err, ${materializedSummary.aborted} aborted, ${materializedSummary.acceptanceFailed} acceptance, ${materializedSummary.providerTransientFailed} transient, ${materializedSummary.retried} retried`,
    `Concurrency: requested=${batch.requestedConcurrency} effective=${batch.effectiveConcurrency}`,
    `Duration: ${durationText(batch.startedAt, batch.finishedAt)}`,
    `Artifacts: ${batch.batchDir}`,
    `Summary file: ${summaryPath(batch)}`,
  ];
  if (batch.parentBatchId) lines.push(`Rerun of: ${batch.parentBatchId} jobs=${batch.rerunOfJobIds?.join(",") ?? "-"}`);

  if (failed.length > 0) {
    lines.push("", "Failed jobs:");
    for (const job of failed) {
      const attempt = lastAttempt(job);
      const view = deriveJobView(job);
      lines.push(`- ${job.jobId} ${job.name}: ${statusLabel(view.finalStatus)} ${view.failureKind} retry=${view.retryability} attempts=${view.attempts} reason=${failureReason(job)}`);
      if (job.acceptance.errors.length) lines.push(`  acceptance: ${truncate(job.acceptance.errors.join("; "), 260)}`);
      if (job.workerReport.errors.length) lines.push(`  report: ${truncate(job.workerReport.errors.join("; "), 260)}`);
      if (attempt) lines.push(`  inspect: /jobs-ui ${batch.batchId} attempt ${job.jobId} ${attempt.id}`);
    }
  }

  lines.push("", "Jobs:");
  for (const job of allJobs) {
    const view = deriveJobView(job);
    lines.push(`- ${job.jobId} ${job.name}: ${statusLabel(view.displayStatus)} failure=${view.failureKind} acceptance=${view.acceptanceStatus} attempts=${view.attempts}`);
  }

  lines.push("", "Next commands:");
  lines.push(`- /jobs-ui ${batch.batchId} job <jobId>`);
  lines.push(`- /jobs-ui ${batch.batchId} attempt <jobId> latest`);
  if (failed.length > 0) {
    lines.push(`- /jobs-ui rerun failed ${batch.batchId}`);
    if (materializedSummary.acceptanceFailed) lines.push(`- /jobs-ui rerun acceptance-failed ${batch.batchId}`);
    if (materializedSummary.providerTransientFailed) lines.push(`- /jobs-ui rerun provider-transient ${batch.batchId}`);
  }
  return lines;
}

export function findJob(detail: BatchDetail, jobId: string): JobArtifact {
  const job = detail.jobs.find((item) => item.jobId === jobId || item.name === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

export function findAttempt(job: JobArtifact, attemptRef: string): JobAttemptRecord {
  const attempt = attemptRef === "latest" ? lastAttempt(job) : job.attempts.find((item) => item.id === attemptRef || String(item.index) === attemptRef);
  if (!attempt) throw new Error(`Attempt not found: ${attemptRef}`);
  return attempt;
}

export function renderJobDetailLines(detail: BatchDetail, jobId: string): string[] {
  const job = findJob(detail, jobId);
  const report = job.workerReport.report;
  const attempt = lastAttempt(job);
  const view = deriveJobView(job);
  const lines = [
    `Job ${job.jobId} ${job.name}`,
    `Batch: ${detail.batch.batchId}`,
    `Status: ${view.displayStatus} failure=${view.failureKind} retry=${view.retryability}`,
    `Cwd: ${job.cwd}`,
    `Acceptance: ${view.acceptanceStatus}`,
    `Worker report: ${job.workerReport.status}${job.workerReport.reportPath ? ` (${job.workerReport.reportPath})` : ""}`,
    `Prompt: ${truncate(job.prompt, 500)}`,
  ];

  if (job.error) lines.push(`Error: ${truncate(job.error, 500)}`);
  if (job.warnings.length) lines.push(`Warnings: ${truncate(job.warnings.join("; "), 500)}`);
  if (job.acceptance.errors.length) lines.push(`Acceptance errors: ${truncate(job.acceptance.errors.join("; "), 600)}`);
  if (job.workerReport.errors.length) lines.push(`Report errors: ${truncate(job.workerReport.errors.join("; "), 600)}`);
  if (report?.summary) lines.push(`Report summary: ${truncate(report.summary, 500)}`);
  if (report?.userActionRequired) lines.push(`User action required: ${truncate(report.userActionRequired, 500)}`);

  lines.push("", "Timeline:");
  for (const item of job.timeline) lines.push(`- ${item.at} ${item.state}${item.message ? ` - ${item.message}` : ""}`);

  const activity = job.activity ?? [];
  if (activity.length) {
    lines.push("", ...renderActivitySummaryLines(activity, { maxItems: 20 }));
  }

  if (report) {
    lines.push("", "Report details:");
    lines.push(...renderDeliverables(report.deliverables));
    lines.push(...renderEvidence(report.evidence));
    lines.push(...renderInternalRetries(report.internalRetries));
  }

  lines.push("", "Attempts:");
  for (const item of job.attempts) {
    lines.push(`- ${item.id}: ${item.status} failure=${item.failureKind} retry=${item.retryability} report=${item.workerReport.status}`);
  }

  if (attempt) {
    lines.push("", "Latest attempt artifacts:");
    for (const line of [
      renderPath("worker log", attempt.workerLogPath),
      renderPath("report", attempt.reportPath),
      renderPath("session", attempt.sessionPath),
      renderPath("stderr", attempt.stderrPath),
      renderPath("stdout", attempt.stdoutPath),
      renderPath("attempt", path.join(attempt.attemptDir, "attempt.json")),
    ]) if (line) lines.push(line);
  }

  lines.push("", "Next commands:");
  lines.push(`- /jobs-ui ${detail.batch.batchId} attempt ${job.jobId} latest`);
  if (view.finalStatus !== "success") lines.push(`- /jobs-ui rerun selected ${detail.batch.batchId} ${job.jobId}`);
  return lines;
}

export function renderAttemptDetailLines(detail: BatchDetail, jobId: string, attemptRef: string): string[] {
  const job = findJob(detail, jobId);
  const attempt = findAttempt(job, attemptRef);
  const runtime = attempt.runtime;
  const lines = [
    `Attempt ${attempt.id}`,
    `Job: ${job.jobId} ${job.name}`,
    `Batch: ${detail.batch.batchId}`,
    `Status: ${attempt.status} failure=${attempt.failureKind} retry=${attempt.retryability}`,
    `Runtime: ${runtime.status} exit=${runtime.exitCode ?? "-"} stop=${runtime.stopReason ?? "-"} terminal=${runtime.sawTerminalAssistantMessage ?? false}`,
    `Report: ${attempt.workerReport.status}`,
    `Cwd: ${attempt.cwd}`,
  ];
  if (attempt.error) lines.push(`Error: ${truncate(attempt.error, 600)}`);
  if (attempt.warnings.length) lines.push(`Warnings: ${truncate(attempt.warnings.join("; "), 500)}`);
  if (runtime.stderrTail) lines.push(`Stderr tail: ${truncate(runtime.stderrTail, 800)}`);
  if (runtime.stderrTail === undefined && attempt.error) lines.push(`Error tail: ${truncate(attempt.error, 800)}`);
  const malformed = (runtime as { stdoutMalformedLines?: number }).stdoutMalformedLines;
  lines.push(`Malformed stdout lines: ${malformed ?? 0}`);

  const activity = (job.activity ?? []).filter((item) => item.attemptId === attempt.id);
  if (activity.length) {
    lines.push("", ...renderActivitySummaryLines(activity, { maxItems: 30 }));
  }

  lines.push("", "Artifacts:");
  for (const line of [
    renderPath("attempt dir", attempt.attemptDir),
    renderPath("session", attempt.sessionPath),
    renderPath("worker log", attempt.workerLogPath),
    renderPath("report", attempt.reportPath),
    renderPath("stdout", attempt.stdoutPath),
    renderPath("stderr", attempt.stderrPath),
    renderPath("attempt", path.join(attempt.attemptDir, "attempt.json")),
  ]) if (line) lines.push(line);

  return lines;
}

export interface LiveDashboardState {
  batch: BatchArtifact;
  jobs: JobArtifact[];
  currentConcurrency: number;
  retryBackoffMs?: number;
  latestProgress?: string;
  lastHeartbeatAt?: string;
  abortableJobIds?: string[];
}

export function renderLiveDashboardLines(state: LiveDashboardState): string[] {
  const lines = [
    `Live batch ${state.batch.batchId}`,
    `Status: ${state.batch.status} audit=${state.batch.auditIntegrity}`,
    `Concurrency: ${state.currentConcurrency}`,
  ];
  if (state.lastHeartbeatAt) lines.push(`Last heartbeat: ${state.lastHeartbeatAt}`);
  if (state.retryBackoffMs !== undefined) lines.push(`Retry backoff: ${state.retryBackoffMs}ms`);
  if (state.latestProgress) lines.push(`Progress: ${state.latestProgress}`);
  lines.push("Attempts:");
  for (const job of state.jobs) {
    const last = job.attempts.at(-1);
    lines.push(`- ${job.jobId} ${job.name}: ${job.status} attempts=${job.attempts.length}${last ? ` last=${last.id}` : ""} acceptance=${job.acceptance.status}`);
    const activity = (job.activity ?? []).at(-1);
    if (activity) lines.push(`  ${renderActivityCollapsedLine(activity)}`);
  }
  if (state.abortableJobIds?.length) lines.push(`Abortable: ${state.abortableJobIds.join(", ")}`);
  return lines;
}
