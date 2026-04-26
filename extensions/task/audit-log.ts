import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  type AuditIntegrity,
  type BatchArtifact,
  type BatchSummary,
  type NormalizedTaskSpec,
  type TaskArtifact,
  type TaskAttemptRecord,
  emptyAcceptance,
  emptyWorkerReport,
} from "./types.ts";

export interface BatchPaths {
  batchId: string;
  rootCwd: string;
  storageRoot: string;
  batchDir: string;
  batchPath: string;
  eventsPath: string;
  summaryPath: string;
  tasksDir: string;
  attemptsDir: string;
}

export interface AttemptPaths {
  attemptDir: string;
  workerLogPath: string;
  reportPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface CreateBatchInput {
  rootCwd: string;
  toolName: "task" | "tasks";
  tasks: NormalizedTaskSpec[];
  requestedConcurrency: number;
  effectiveConcurrency: number;
  batchId?: string;
  now?: string;
  defaultModel?: string;
  defaultThinking?: string;
}

export interface AuditBatchHandle extends BatchPaths {
  artifact: BatchArtifact;
}

export interface BatchEvent {
  schemaVersion: 1;
  seq: number;
  at: string;
  type: string;
  batchId: string;
  taskId?: string;
  attemptId?: string;
  status?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export function formatBatchTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function createBatchId(date = new Date()): string {
  return `${formatBatchTimestamp(date)}-${randomBytes(3).toString("hex")}`;
}

export function generateTaskIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `t${String(index + 1).padStart(3, "0")}`);
}

export function buildBatchPaths(rootCwd: string, batchId: string): BatchPaths {
  const resolvedRoot = path.resolve(rootCwd);
  const storageRoot = path.join(resolvedRoot, ".pi", "tasks");
  const batchDir = path.join(storageRoot, batchId);
  return {
    batchId,
    rootCwd: resolvedRoot,
    storageRoot,
    batchDir,
    batchPath: path.join(batchDir, "batch.json"),
    eventsPath: path.join(batchDir, "events.jsonl"),
    summaryPath: path.join(batchDir, "summary.md"),
    tasksDir: path.join(batchDir, "tasks"),
    attemptsDir: path.join(batchDir, "attempts"),
  };
}

export function buildAttemptPaths(paths: Pick<BatchPaths, "attemptsDir">, taskId: string, attemptIndex: number): AttemptPaths {
  const attemptDir = path.join(paths.attemptsDir, taskId, `attempt-${attemptIndex}`);
  return {
    attemptDir,
    workerLogPath: path.join(attemptDir, "worker.md"),
    reportPath: path.join(attemptDir, "task-report.json"),
    stdoutPath: path.join(attemptDir, "stdout.jsonl"),
    stderrPath: path.join(attemptDir, "stderr.txt"),
  };
}

export function emptyBatchSummary(total = 0): BatchSummary {
  return { total, success: 0, error: 0, aborted: 0, acceptanceFailed: 0, providerTransientFailed: 0, protocolFailed: 0, retried: 0 };
}

export function buildBatchArtifact(input: {
  batchId: string;
  toolName: "task" | "tasks";
  rootCwd: string;
  batchDir: string;
  startedAt: string;
  taskIds: string[];
  requestedConcurrency: number;
  effectiveConcurrency: number;
  initialized?: boolean;
  auditIntegrity?: AuditIntegrity;
  defaultModel?: string;
  defaultThinking?: string;
}): BatchArtifact {
  return {
    schemaVersion: 1,
    batchId: input.batchId,
    toolName: input.toolName,
    rootCwd: path.resolve(input.rootCwd),
    batchDir: input.batchDir,
    startedAt: input.startedAt,
    finishedAt: null,
    status: input.initialized ? "running" : "initializing",
    initialized: input.initialized ?? false,
    auditIntegrity: input.auditIntegrity ?? "pending",
    taskIds: [...input.taskIds],
    requestedConcurrency: input.requestedConcurrency,
    effectiveConcurrency: input.effectiveConcurrency,
    summary: emptyBatchSummary(input.taskIds.length),
    defaultModel: input.defaultModel,
    defaultThinking: input.defaultThinking,
  };
}

export function buildQueuedTaskArtifact(input: {
  batchId: string;
  task: NormalizedTaskSpec;
  queuedAt: string;
}): TaskArtifact {
  return {
    schemaVersion: 1,
    batchId: input.batchId,
    taskId: input.task.id,
    name: input.task.name,
    prompt: input.task.prompt,
    cwd: input.task.cwd,
    status: "queued",
    finalStatus: null,
    failureKind: "none",
    retryability: "not_retryable",
    acceptance: emptyAcceptance("pending"),
    acceptanceContract: input.task.acceptance,
    workerReport: emptyWorkerReport(),
    attempts: [],
    queuedAt: input.queuedAt,
    startedAt: null,
    finishedAt: null,
    timeline: [{ at: input.queuedAt, state: "queued" }],
    activity: [],
    warnings: [],
    error: null,
    metadata: input.task.metadata,
  };
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tempPath, filePath);
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

export async function appendBatchEvent(eventsPath: string, event: BatchEvent): Promise<void> {
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
}

export async function readJsonlTolerant<T = unknown>(filePath: string): Promise<T[]> {
  const text = await fs.readFile(filePath, "utf-8");
  const lines = text.split(/\r?\n/);
  const values: T[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      const remaining = lines.slice(index + 1).some((item) => item.trim());
      if (!remaining && !text.endsWith("\n")) break;
      throw error;
    }
  }
  return values;
}

export function taskArtifactPath(paths: Pick<BatchPaths, "tasksDir">, taskId: string): string {
  return path.join(paths.tasksDir, `${taskId}.json`);
}

export async function writeBatchArtifact(paths: Pick<BatchPaths, "batchPath">, artifact: BatchArtifact): Promise<void> {
  await writeJsonAtomic(paths.batchPath, artifact);
}

export async function writeTaskArtifact(paths: Pick<BatchPaths, "tasksDir">, artifact: TaskArtifact): Promise<void> {
  await writeJsonAtomic(taskArtifactPath(paths, artifact.taskId), artifact);
}

export async function writeAttemptArtifact(paths: AttemptPaths, attempt: TaskAttemptRecord): Promise<void> {
  await fs.mkdir(paths.attemptDir, { recursive: true });
  await writeJsonAtomic(path.join(paths.attemptDir, "attempt.json"), attempt);
}

export async function createBatch(input: CreateBatchInput): Promise<AuditBatchHandle> {
  const batchId = input.batchId ?? createBatchId();
  const paths = buildBatchPaths(input.rootCwd, batchId);
  const now = input.now ?? new Date().toISOString();
  await fs.mkdir(paths.tasksDir, { recursive: true });
  await fs.mkdir(paths.attemptsDir, { recursive: true });

  const taskIds = input.tasks.map((task) => task.id);
  const artifact = buildBatchArtifact({
    batchId,
    toolName: input.toolName,
    rootCwd: input.rootCwd,
    batchDir: paths.batchDir,
    startedAt: now,
    taskIds,
    requestedConcurrency: input.requestedConcurrency,
    effectiveConcurrency: input.effectiveConcurrency,
    defaultModel: input.defaultModel,
    defaultThinking: input.defaultThinking,
  });
  await writeBatchArtifact(paths, artifact);
  await appendBatchEvent(paths.eventsPath, { schemaVersion: 1, seq: 1, at: now, type: "batch_started", batchId });

  let seq = 2;
  for (const task of input.tasks) {
    await writeTaskArtifact(paths, buildQueuedTaskArtifact({ batchId, task, queuedAt: now }));
    await appendBatchEvent(paths.eventsPath, { schemaVersion: 1, seq, at: now, type: "task_queued", batchId, taskId: task.id });
    seq += 1;
  }

  const initialized = { ...artifact, initialized: true, status: "running" as const };
  await writeBatchArtifact(paths, initialized);
  return { ...paths, artifact: initialized };
}

export async function isDiscoverableBatch(batchDir: string): Promise<boolean> {
  try {
    const batchPath = path.join(batchDir, "batch.json");
    const eventsPath = path.join(batchDir, "events.jsonl");
    const tasksDir = path.join(batchDir, "tasks");
    const batch = await readJsonFile<BatchArtifact>(batchPath);
    if (batch.schemaVersion !== 1 || !batch.initialized || !batch.batchId || !batch.toolName || !batch.taskIds?.length) return false;

    const events = await readJsonlTolerant<BatchEvent>(eventsPath);
    const started = events.filter((event) => event.type === "batch_started" && event.batchId === batch.batchId);
    if (started.length !== 1) return false;

    for (const taskId of batch.taskIds) {
      const queued = events.filter((event) => event.type === "task_queued" && event.batchId === batch.batchId && event.taskId === taskId);
      if (queued.length !== 1) return false;
      const task = await readJsonFile<TaskArtifact>(path.join(tasksDir, `${taskId}.json`));
      if (task.schemaVersion !== 1 || task.batchId !== batch.batchId || task.taskId !== taskId || !task.queuedAt) return false;
      if (!task.timeline.some((entry) => entry.state === "queued")) return false;
    }

    return true;
  } catch {
    return false;
  }
}
