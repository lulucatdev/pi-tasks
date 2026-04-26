import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDiscoverableBatch, readJsonFile } from "./audit-log.ts";
import { renderActivityCollapsedLine, renderActivitySummaryLines } from "./thinking-steps.ts";
import type { BatchArtifact, InternalRetryRecord, TaskArtifact, TaskAttemptRecord, TaskDeliverable, TaskEvidence } from "./types.ts";

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
  tasks: TaskArtifact[];
  summaryMarkdown?: string;
}

export function storageRootForCwd(cwd: string): string {
  return path.join(path.resolve(cwd), ".pi", "tasks");
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

function lastAttempt(task: TaskArtifact): TaskAttemptRecord | undefined {
  return task.attempts.at(-1);
}

function taskSortKey(task: TaskArtifact): string {
  return `${task.finalStatus === "success" ? "1" : "0"}:${task.taskId}`;
}

function failureReason(task: TaskArtifact): string {
  return truncate(
    task.error
      ?? task.acceptance.errors[0]
      ?? task.workerReport.errors[0]
      ?? task.workerReport.report?.userActionRequired
      ?? lastAttempt(task)?.error
      ?? task.warnings[0],
    220,
  );
}

function summaryPath(batch: BatchArtifact): string {
  return path.join(batch.batchDir, "summary.md");
}

function renderPath(label: string, value: string | undefined): string | undefined {
  return value ? `- ${label}: ${value}` : undefined;
}

function renderDeliverables(deliverables: TaskDeliverable[] = []): string[] {
  if (deliverables.length === 0) return ["- Deliverables: -"];
  return ["- Deliverables:", ...deliverables.map((item) => `  - ${item.kind}: ${item.path}${item.description ? ` - ${item.description}` : ""}`)];
}

function renderEvidence(evidence: TaskEvidence[] = []): string[] {
  if (evidence.length === 0) return ["- Evidence: -"];
  return ["- Evidence:", ...evidence.map((item) => `  - ${item.kind}: ${truncate(item.value, 220)}`)];
}

function renderInternalRetries(retries: InternalRetryRecord[] = []): string[] {
  if (retries.length === 0) return [];
  return ["- Internal retries:", ...retries.map((item) => `  - ${item.outcome}: ${item.reason} -> ${item.action}`)];
}

export function summarizeBatch(batch: BatchArtifact): BatchListItem {
  const parts = [
    `${batch.summary.success} ok`,
    `${batch.summary.error} err`,
    `${batch.summary.aborted} aborted`,
  ];
  if (batch.summary.acceptanceFailed) parts.push(`${batch.summary.acceptanceFailed} acceptance`);
  if (batch.summary.providerTransientFailed) parts.push(`${batch.summary.providerTransientFailed} transient`);
  if (batch.summary.retried) parts.push(`${batch.summary.retried} retried`);
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
    items.push(summarizeBatch(batch));
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
  const tasks = await Promise.all(batch.taskIds.map((taskId) => readJsonFile<TaskArtifact>(path.join(batchDir, "tasks", `${taskId}.json`))));
  let summaryMarkdown: string | undefined;
  try {
    summaryMarkdown = await fs.readFile(path.join(batchDir, "summary.md"), "utf-8");
  } catch {
    summaryMarkdown = undefined;
  }
  return { batch, tasks, summaryMarkdown };
}

export function renderTasksUiHelpLines(): string[] {
  return [
    "Tasks UI commands:",
    "- /tasks-ui",
    "- /tasks-ui help",
    "- /tasks-ui <batchId|batchDir>",
    "- /tasks-ui <batchId|batchDir> task <taskId>",
    "- /tasks-ui <batchId|batchDir> attempt <taskId> <attemptId|latest>",
    "- /tasks-ui rerun failed <batchId|batchDir>",
    "- /tasks-ui rerun acceptance-failed <batchId|batchDir>",
    "- /tasks-ui rerun provider-transient <batchId|batchDir>",
    "- /tasks-ui rerun selected <batchId|batchDir> <taskId> [taskId...]",
  ];
}

export function renderBatchListLines(items: BatchListItem[]): string[] {
  if (items.length === 0) return ["No task batches found.", "Run `tasks` or `task`, then inspect with `/tasks-ui <batchId>`." ];
  return items.map((item) => {
    const duration = durationText(item.startedAt, item.finishedAt);
    return `${statusLabel(item.status)} ${item.batchId} ${item.summaryText} audit=${item.auditIntegrity} duration=${duration}`;
  });
}

export function renderBatchDetailLines(detail: BatchDetail): string[] {
  const batch = detail.batch;
  const failed = detail.tasks.filter((task) => task.finalStatus !== "success").sort((a, b) => taskSortKey(a).localeCompare(taskSortKey(b)));
  const allTasks = [...detail.tasks].sort((a, b) => taskSortKey(a).localeCompare(taskSortKey(b)));
  const lines = [
    `Batch ${batch.batchId}`,
    `Status: ${batch.status} audit=${batch.auditIntegrity}`,
    `Summary: ${batch.summary.success} ok, ${batch.summary.error} err, ${batch.summary.aborted} aborted, ${batch.summary.acceptanceFailed} acceptance, ${batch.summary.providerTransientFailed} transient, ${batch.summary.retried} retried`,
    `Concurrency: requested=${batch.requestedConcurrency} effective=${batch.effectiveConcurrency}`,
    `Duration: ${durationText(batch.startedAt, batch.finishedAt)}`,
    `Artifacts: ${batch.batchDir}`,
    `Summary file: ${summaryPath(batch)}`,
  ];
  if (batch.parentBatchId) lines.push(`Rerun of: ${batch.parentBatchId} tasks=${batch.rerunOfTaskIds?.join(",") ?? "-"}`);

  if (failed.length > 0) {
    lines.push("", "Failed tasks:");
    for (const task of failed) {
      const attempt = lastAttempt(task);
      lines.push(`- ${task.taskId} ${task.name}: ${statusLabel(task.finalStatus)} ${task.failureKind} retry=${task.retryability} attempts=${task.attempts.length} reason=${failureReason(task)}`);
      if (task.acceptance.errors.length) lines.push(`  acceptance: ${truncate(task.acceptance.errors.join("; "), 260)}`);
      if (task.workerReport.errors.length) lines.push(`  report: ${truncate(task.workerReport.errors.join("; "), 260)}`);
      if (attempt) lines.push(`  inspect: /tasks-ui ${batch.batchId} attempt ${task.taskId} ${attempt.id}`);
    }
  }

  lines.push("", "Tasks:");
  for (const task of allTasks) {
    lines.push(`- ${task.taskId} ${task.name}: ${statusLabel(task.finalStatus ?? task.status)} failure=${task.failureKind} acceptance=${task.acceptance.status} attempts=${task.attempts.length}`);
  }

  lines.push("", "Next commands:");
  lines.push(`- /tasks-ui ${batch.batchId} task <taskId>`);
  lines.push(`- /tasks-ui ${batch.batchId} attempt <taskId> latest`);
  if (failed.length > 0) {
    lines.push(`- /tasks-ui rerun failed ${batch.batchId}`);
    if (batch.summary.acceptanceFailed) lines.push(`- /tasks-ui rerun acceptance-failed ${batch.batchId}`);
    if (batch.summary.providerTransientFailed) lines.push(`- /tasks-ui rerun provider-transient ${batch.batchId}`);
  }
  return lines;
}

export function findTask(detail: BatchDetail, taskId: string): TaskArtifact {
  const task = detail.tasks.find((item) => item.taskId === taskId || item.name === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

export function findAttempt(task: TaskArtifact, attemptRef: string): TaskAttemptRecord {
  const attempt = attemptRef === "latest" ? lastAttempt(task) : task.attempts.find((item) => item.id === attemptRef || String(item.index) === attemptRef);
  if (!attempt) throw new Error(`Attempt not found: ${attemptRef}`);
  return attempt;
}

export function renderTaskDetailLines(detail: BatchDetail, taskId: string): string[] {
  const task = findTask(detail, taskId);
  const report = task.workerReport.report;
  const attempt = lastAttempt(task);
  const lines = [
    `Task ${task.taskId} ${task.name}`,
    `Batch: ${detail.batch.batchId}`,
    `Status: ${task.finalStatus ?? task.status} failure=${task.failureKind} retry=${task.retryability}`,
    `Cwd: ${task.cwd}`,
    `Acceptance: ${task.acceptance.status}`,
    `Worker report: ${task.workerReport.status}${task.workerReport.reportPath ? ` (${task.workerReport.reportPath})` : ""}`,
    `Prompt: ${truncate(task.prompt, 500)}`,
  ];

  if (task.error) lines.push(`Error: ${truncate(task.error, 500)}`);
  if (task.warnings.length) lines.push(`Warnings: ${truncate(task.warnings.join("; "), 500)}`);
  if (task.acceptance.errors.length) lines.push(`Acceptance errors: ${truncate(task.acceptance.errors.join("; "), 600)}`);
  if (task.workerReport.errors.length) lines.push(`Report errors: ${truncate(task.workerReport.errors.join("; "), 600)}`);
  if (report?.summary) lines.push(`Report summary: ${truncate(report.summary, 500)}`);
  if (report?.userActionRequired) lines.push(`User action required: ${truncate(report.userActionRequired, 500)}`);

  lines.push("", "Timeline:");
  for (const item of task.timeline) lines.push(`- ${item.at} ${item.state}${item.message ? ` - ${item.message}` : ""}`);

  const activity = task.activity ?? [];
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
  for (const item of task.attempts) {
    lines.push(`- ${item.id}: ${item.status} failure=${item.failureKind} retry=${item.retryability} report=${item.workerReport.status}`);
  }

  if (attempt) {
    lines.push("", "Latest attempt artifacts:");
    for (const line of [
      renderPath("worker log", attempt.workerLogPath),
      renderPath("report", attempt.reportPath),
      renderPath("stderr", attempt.stderrPath),
      renderPath("stdout", attempt.stdoutPath),
      renderPath("attempt", path.join(attempt.attemptDir, "attempt.json")),
    ]) if (line) lines.push(line);
  }

  lines.push("", "Next commands:");
  lines.push(`- /tasks-ui ${detail.batch.batchId} attempt ${task.taskId} latest`);
  if (task.finalStatus !== "success") lines.push(`- /tasks-ui rerun selected ${detail.batch.batchId} ${task.taskId}`);
  return lines;
}

export function renderAttemptDetailLines(detail: BatchDetail, taskId: string, attemptRef: string): string[] {
  const task = findTask(detail, taskId);
  const attempt = findAttempt(task, attemptRef);
  const runtime = attempt.runtime;
  const lines = [
    `Attempt ${attempt.id}`,
    `Task: ${task.taskId} ${task.name}`,
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

  const activity = (task.activity ?? []).filter((item) => item.attemptId === attempt.id);
  if (activity.length) {
    lines.push("", ...renderActivitySummaryLines(activity, { maxItems: 30 }));
  }

  lines.push("", "Artifacts:");
  for (const line of [
    renderPath("attempt dir", attempt.attemptDir),
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
  tasks: TaskArtifact[];
  currentConcurrency: number;
  retryBackoffMs?: number;
  latestProgress?: string;
  lastHeartbeatAt?: string;
  abortableTaskIds?: string[];
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
  for (const task of state.tasks) {
    const last = task.attempts.at(-1);
    lines.push(`- ${task.taskId} ${task.name}: ${task.status} attempts=${task.attempts.length}${last ? ` last=${last.id}` : ""} acceptance=${task.acceptance.status}`);
    const activity = (task.activity ?? []).at(-1);
    if (activity) lines.push(`  ${renderActivityCollapsedLine(activity)}`);
  }
  if (state.abortableTaskIds?.length) lines.push(`Abortable: ${state.abortableTaskIds.join(", ")}`);
  return lines;
}
