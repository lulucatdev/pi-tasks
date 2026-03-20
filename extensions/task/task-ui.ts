import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { isDiscoverableBatch, readBatchJson, readJsonlTolerant, readTaskArtifact, resolveAuditRoot } from "./audit-log.ts";
import { resolveRunStatus as resolveRunStatusImpl } from "./task-status.ts";
import type { TaskArtifact, TaskFinishedEvent } from "./types.ts";

export type BatchClassification = "complete" | "incomplete" | "pre-init";
export type DashboardRunStatus = "running" | "success" | "error" | "aborted";

export interface BatchClassificationSummary {
  visible: boolean;
  classification: BatchClassification;
}

export interface DiscoverableUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface DiscoverableTaskSpec {
  id: string;
  name?: string;
  task: string;
  cwd: string;
}

export interface DiscoverableTaskResult extends DiscoverableTaskSpec {
  status: TaskArtifact["status"];
  output: string;
  error?: string;
  usage: DiscoverableUsageStats;
  model?: string;
  displayItems: Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> }>;
}

export interface DiscoverableTasksSummary {
  total: number;
  queued: number;
  running: number;
  success: number;
  error: number;
  aborted: number;
}

export interface DiscoverableBatchRun {
  id: string;
  batchId: string;
  title: string;
  cwd: string;
  toolName: "task" | "tasks";
  startedAt: number;
  finishedAt?: number;
  detail: string;
  tasks: DiscoverableTaskSpec[];
  details: {
    results: DiscoverableTaskResult[];
    summary: DiscoverableTasksSummary;
  };
  auditClassification: Exclude<BatchClassification, "pre-init">;
  status: DashboardRunStatus;
}

const TERMINAL_TASK_STATUSES = new Set(["success", "error", "aborted"]);
const EMPTY_USAGE: DiscoverableUsageStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

export async function classifyBatchDir(batchDir: string): Promise<BatchClassificationSummary> {
  if (!(await isDiscoverableBatch(batchDir))) {
    return { visible: false, classification: "pre-init" };
  }

  const batch = await readBatchJson(batchDir);
  if (!batch) {
    return { visible: false, classification: "pre-init" };
  }

  let events;
  try {
    events = await readJsonlTolerant(pathForBatchEvents(batchDir));
  } catch {
    return { visible: true, classification: "incomplete" };
  }

  const batchEvents = events.filter((event) => event.batchId === batch.batchId);
  const batchFinishedEvents = batchEvents.filter((event) => event.type === "batch_finished");
  if (batchFinishedEvents.length !== 1) {
    return { visible: true, classification: "incomplete" };
  }

  if (batch.status === "running" || batch.auditIntegrity !== "ok") {
    return { visible: true, classification: "incomplete" };
  }

  const taskFinishedEventsById = new Map<string, TaskFinishedEvent[]>();
  for (const event of batchEvents) {
    if (event.type !== "task_finished") continue;
    const current = taskFinishedEventsById.get(event.taskId) ?? [];
    current.push(event);
    taskFinishedEventsById.set(event.taskId, current);
  }

  for (const taskId of batch.taskIds) {
    const task = await readTaskArtifact(batchDir, taskId);
    const taskFinishedEvents = taskFinishedEventsById.get(taskId) ?? [];
    if (!task || !TERMINAL_TASK_STATUSES.has(task.status) || !task.finishedAt) {
      return { visible: true, classification: "incomplete" };
    }
    if (taskFinishedEvents.length !== 1 || !hasTerminalParity(task, taskFinishedEvents[0])) {
      return { visible: true, classification: "incomplete" };
    }
  }

  return { visible: true, classification: "complete" };
}

export async function readDiscoverableBatchRuns(rootCwd: string): Promise<DiscoverableBatchRun[]> {
  const auditRoot = resolveAuditRoot(rootCwd);

  let entries;
  try {
    entries = await fs.readdir(auditRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await readDiscoverableBatchRun(path.join(auditRoot, entry.name));
        } catch {
          return null;
        }
      }),
  );

  return runs
    .filter((run): run is DiscoverableBatchRun => run !== null)
    .sort((left, right) => (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt));
}

export function renderRunStatusLabel(
  theme: Theme,
  status: DashboardRunStatus,
  classification: BatchClassification | undefined = "complete",
): string {
  if (classification === "incomplete") return theme.fg("warning", "INC");
  if (status === "running") return theme.fg("warning", "RUN");
  if (status === "success") return theme.fg("success", "OK");
  if (status === "aborted") return theme.fg("warning", "ABT");
  return theme.fg("error", "ERR");
}

async function readDiscoverableBatchRun(batchDir: string): Promise<DiscoverableBatchRun | null> {
  const classificationSummary = await classifyBatchDir(batchDir);
  if (!classificationSummary.visible) return null;

  const batch = await readBatchJson(batchDir);
  if (!batch) return null;

  const taskArtifacts = await Promise.all(batch.taskIds.map((taskId) => readTaskArtifact(batchDir, taskId)));
  if (taskArtifacts.some((task) => task === null)) return null;

  const tasks = taskArtifacts.map((task) => ({
    id: task.id,
    name: task.name,
    task: task.task,
    cwd: task.cwd,
  }));
  const results = taskArtifacts.map((task) => toDiscoverableTaskResult(task));
  const summary = buildSummary(results);
  const startedAt = parseTimestamp(batch.startedAt) ?? 0;
  const finishedAt = parseTimestamp(batch.finishedAt);
  const auditClassification = classificationSummary.classification === "complete" ? "complete" : "incomplete";
  const detail = buildRunDetail(summary, startedAt, finishedAt, auditClassification);

  return {
    id: `audit:${batch.batchId}`,
    batchId: batch.batchId,
    title: buildRunTitle(tasks),
    cwd: batch.rootCwd,
    toolName: batch.toolName,
    startedAt,
    finishedAt,
    detail,
    tasks,
    details: { results, summary },
    auditClassification,
    status: resolveRunStatus(summary),
  };
}

function toDiscoverableTaskResult(task: TaskArtifact): DiscoverableTaskResult {
  return {
    id: task.id,
    name: task.name,
    task: task.task,
    cwd: task.cwd,
    status: task.status,
    output: task.finalOutput ?? "",
    error: getTaskError(task),
    usage: { ...EMPTY_USAGE },
    displayItems: [],
  };
}

function getTaskError(task: TaskArtifact): string | undefined {
  if (task.status === "aborted") return task.error ?? "Task was aborted.";
  if (task.status === "error") return task.error ?? "Task failed before producing output.";
  return undefined;
}

function hasTerminalParity(task: TaskArtifact, event: TaskFinishedEvent): boolean {
  return task.status === event.status && task.finishedAt === event.at && (task.error ?? null) === event.error;
}

function buildSummary(results: Array<{ status: TaskArtifact["status"] }>): DiscoverableTasksSummary {
  const summary: DiscoverableTasksSummary = { total: results.length, queued: 0, running: 0, success: 0, error: 0, aborted: 0 };
  for (const result of results) {
    summary[result.status] += 1;
  }
  return summary;
}

function resolveRunStatus(summary: DiscoverableTasksSummary): DashboardRunStatus {
  return resolveRunStatusImpl(summary);
}

function buildRunTitle(tasks: DiscoverableTaskSpec[]): string {
  if (tasks.length === 1) {
    return tasks[0].name ?? shortenText(tasks[0].task, 56);
  }
  return `${tasks.length} tasks`;
}

function buildRunDetail(
  summary: DiscoverableTasksSummary,
  startedAt: number,
  finishedAt: number | undefined,
  auditClassification: Exclude<BatchClassification, "pre-init">,
): string {
  const baseDetail = summary.running > 0 || summary.queued > 0
    ? `${summary.success + summary.error + summary.aborted}/${summary.total} done, ${summary.running} running${summary.queued > 0 ? `, ${summary.queued} queued` : ""}`
    : `${buildCompletedSummary(summary)} in ${formatDuration(startedAt, finishedAt)}`;

  return auditClassification === "incomplete" ? `${baseDetail} · audit incomplete` : baseDetail;
}

function buildCompletedSummary(summary: DiscoverableTasksSummary): string {
  const parts: string[] = [];
  if (summary.success) parts.push(`${summary.success} success`);
  if (summary.error) parts.push(`${summary.error} error`);
  if (summary.aborted) parts.push(`${summary.aborted} aborted`);
  if (parts.length === 0) parts.push("0 finished");
  return parts.join(", ");
}

function formatDuration(startedAt: number, finishedAt?: number): string {
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function shortenText(text: string, max = 72): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`;
}

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pathForBatchEvents(batchDir: string): string {
  return `${batchDir}/events.jsonl`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
