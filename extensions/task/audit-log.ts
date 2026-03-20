import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  TASK_AUDIT_SCHEMA_VERSION,
  buildBatchRecord,
  previewToolInput,
  type BatchFinishedEvent,
  type BatchRecord,
  type BatchStartedEvent,
  type BatchTerminalStatus,
  type FinalizedAuditIntegrity,
  type TaskArtifact,
  type TaskAuditEvent,
  type TaskFinishedEvent,
  type TaskQueuedEvent,
  type TaskRunningEvent,
  type TaskToolCall,
  type TaskToolCallStatus,
} from "./types.ts";

const TASK_AUDIT_DIRNAME = path.join(".pi", "tasks");

export interface AuditBatchPaths {
  auditRoot: string;
  batchDir: string;
  batchPath: string;
  eventsPath: string;
  tasksDir: string;
}

export interface CreateAuditBatchInput {
  rootCwd: string;
  toolName: BatchRecord["toolName"];
  startedAt: string;
  batchId?: string;
  taskIds?: string[];
}

export interface RecordToolCallInput {
  at: string;
  tool: string;
  args: unknown;
  status: TaskToolCallStatus;
  error: string | null;
}

export interface AuditBatchHandle extends AuditBatchPaths {
  batchId: string;
  readonly batchRecord: BatchRecord;
  taskPath(taskId: string): string;
  writeBatch(record: BatchRecord): Promise<void>;
  writeTaskArtifact(task: TaskArtifact): Promise<void>;
  appendEvent(event: AuditEventInput): Promise<TaskAuditEvent>;
  markInitialized(taskIds: string[]): Promise<BatchRecord>;
  tryMarkRunning(taskId: string, at: string): Promise<boolean>;
  writeTerminalTask(taskId: string, task: TaskArtifact): Promise<void>;
  appendTaskFinished(taskId: string, at: string, status: BatchTerminalStatus, error: string | null): Promise<TaskFinishedEvent>;
  writeFinalBatch(record: BatchRecord): Promise<void>;
  appendBatchFinished(at: string, status: BatchTerminalStatus, auditIntegrity: FinalizedAuditIntegrity): Promise<BatchFinishedEvent>;
  recordToolCall(taskId: string, input: RecordToolCallInput): Promise<TaskArtifact>;
  logWarning(message: string): Promise<void>;
}

type AuditEventInput =
  | Omit<BatchStartedEvent, "schemaVersion" | "seq" | "batchId">
  | Omit<TaskQueuedEvent, "schemaVersion" | "seq" | "batchId">
  | Omit<TaskRunningEvent, "schemaVersion" | "seq" | "batchId">
  | Omit<TaskFinishedEvent, "schemaVersion" | "seq" | "batchId">
  | Omit<BatchFinishedEvent, "schemaVersion" | "seq" | "batchId">;

export async function createAuditBatch(input: CreateAuditBatchInput): Promise<AuditBatchHandle> {
  const batchId = input.batchId ?? buildBatchId(input.startedAt);
  const paths = resolveAuditBatchPaths(input.rootCwd, batchId);
  await fs.mkdir(paths.tasksDir, { recursive: true });

  let batchRecord: BatchRecord = buildBatchRecord({
    batchId,
    toolName: input.toolName,
    rootCwd: input.rootCwd,
    startedAt: input.startedAt,
  });

  if (Array.isArray(input.taskIds) && input.taskIds.length > 0) {
    batchRecord = { ...batchRecord, taskIds: [...input.taskIds] };
  }

  await writeJsonAtomic(paths.batchPath, batchRecord);

  let nextSeq = 1;
  let pendingWrite = Promise.resolve();

  const queueWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const operation = pendingWrite.then(write, write);
    pendingWrite = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return {
    ...paths,
    batchId,
    get batchRecord() {
      return batchRecord;
    },
    taskPath(taskId: string) {
      return getTaskArtifactPath(paths.batchDir, taskId);
    },
    async writeBatch(record: BatchRecord) {
      return queueWrite(async () => {
        batchRecord = { ...record, taskIds: [...record.taskIds] };
        await writeJsonAtomic(paths.batchPath, batchRecord);
      });
    },
    async writeTaskArtifact(task: TaskArtifact) {
      return queueWrite(async () => {
        await writeTaskArtifactAtomic(paths.batchDir, task);
      });
    },
    async appendEvent(event: AuditEventInput) {
      return queueWrite(async () => {
        const normalized = materializeEvent(batchId, nextSeq, event);
        nextSeq += 1;
        await appendJsonlRecord(paths.eventsPath, normalized);
        return normalized;
      });
    },
    async markInitialized(taskIds: string[]) {
      return queueWrite(async () => {
        batchRecord = {
          ...batchRecord,
          initialized: true,
          status: "running",
          taskIds: [...taskIds],
        };
        await writeJsonAtomic(paths.batchPath, batchRecord);
        return batchRecord;
      });
    },
    async tryMarkRunning(taskId: string, at: string) {
      return queueWrite(async () => {
        try {
          const updated = await rewriteTaskArtifact(paths.batchDir, taskId, (task) => {
            if (task.status !== "queued") {
              return task;
            }
            return {
              ...task,
              status: "running",
              timeline: appendTimelineState(task.timeline, at, "running"),
            };
          });
          if (updated.status !== "running") {
            return true;
          }
          const normalized = materializeEvent(batchId, nextSeq, { type: "task_running", at, taskId });
          nextSeq += 1;
          await appendJsonlRecord(paths.eventsPath, normalized);
          return true;
        } catch {
          return false;
        }
      });
    },
    async writeTerminalTask(taskId: string, task: TaskArtifact) {
      return queueWrite(async () => {
        if (task.id !== taskId) {
          throw new Error(`Terminal task artifact id mismatch for ${taskId}.`);
        }
        await writeTaskArtifactAtomic(paths.batchDir, task);
      });
    },
    async appendTaskFinished(taskId: string, at: string, status: BatchTerminalStatus, error: string | null) {
      return queueWrite(async () => {
        const normalized = materializeEvent(batchId, nextSeq, { type: "task_finished", at, taskId, status, error });
        nextSeq += 1;
        await appendJsonlRecord(paths.eventsPath, normalized);
        return normalized;
      });
    },
    async writeFinalBatch(record: BatchRecord) {
      return queueWrite(async () => {
        batchRecord = { ...record, taskIds: [...record.taskIds] };
        await writeJsonAtomic(paths.batchPath, batchRecord);
      });
    },
    async appendBatchFinished(at: string, status: BatchTerminalStatus, auditIntegrity: FinalizedAuditIntegrity) {
      return queueWrite(async () => {
        const normalized = materializeEvent(batchId, nextSeq, { type: "batch_finished", at, status, auditIntegrity });
        nextSeq += 1;
        await appendJsonlRecord(paths.eventsPath, normalized);
        return normalized;
      });
    },
    async recordToolCall(taskId: string, input: RecordToolCallInput) {
      return queueWrite(async () => rewriteTaskArtifact(paths.batchDir, taskId, (task) => ({
        ...task,
        toolCalls: [...task.toolCalls, buildTaskToolCall(input)],
      })));
    },
    async logWarning(message: string) {
      console.warn(`[task audit] ${message}`);
    },
  };
}

export function resolveAuditRoot(rootCwd: string): string {
  return path.join(rootCwd, TASK_AUDIT_DIRNAME);
}

export function resolveAuditBatchPaths(rootCwd: string, batchId: string): AuditBatchPaths {
  const auditRoot = resolveAuditRoot(rootCwd);
  const batchDir = path.join(auditRoot, batchId);
  return {
    auditRoot,
    batchDir,
    batchPath: path.join(batchDir, "batch.json"),
    eventsPath: path.join(batchDir, "events.jsonl"),
    tasksDir: path.join(batchDir, "tasks"),
  };
}

export function getTaskArtifactPath(batchDir: string, taskId: string): string {
  return path.join(batchDir, "tasks", `${taskId}.json`);
}

export async function writeBatchJson(batchDir: string, record: BatchRecord): Promise<void> {
  await writeJsonAtomic(path.join(batchDir, "batch.json"), record);
}

export async function writeTaskArtifactAtomic(batchDir: string, task: TaskArtifact): Promise<void> {
  await writeJsonAtomic(getTaskArtifactPath(batchDir, task.id), task);
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(tempPath, "w");
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function appendJsonlRecord(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(value)}\n`;
  const handle = await fs.open(filePath, "a");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readBatchJson(batchDir: string): Promise<BatchRecord | null> {
  return readJsonFile<BatchRecord>(path.join(batchDir, "batch.json"));
}

export async function readTaskArtifact(batchDir: string, taskId: string): Promise<TaskArtifact | null> {
  return readJsonFile<TaskArtifact>(getTaskArtifactPath(batchDir, taskId));
}

export async function readJsonlTolerant<T = TaskAuditEvent>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  const records: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      const isPartialTrailingLine = !hasTrailingNewline && index === lines.length - 1;
      if (isPartialTrailingLine) {
        return records;
      }
      throw new Error(`Corrupt JSONL line ${index + 1} in ${filePath}`, { cause: error });
    }
  }

  return records;
}

export async function isDiscoverableBatch(batchDir: string): Promise<boolean> {
  const batch = await readBatchJson(batchDir);
  if (!isDiscoverableBatchRecord(batch)) return false;
  if (batch.initialized !== true || batch.taskIds.length === 0) return false;

  const uniqueTaskIds = new Set(batch.taskIds);
  if (uniqueTaskIds.size !== batch.taskIds.length) return false;

  let events: TaskAuditEvent[];
  try {
    events = await readJsonlTolerant<TaskAuditEvent>(path.join(batchDir, "events.jsonl"));
  } catch (error) {
    if (isCorruptJsonlError(error)) return false;
    throw error;
  }

  const batchEvents = events.filter((event) => event.batchId === batch.batchId);
  const batchStartedEvents = batchEvents.filter((event) => event.type === "batch_started");
  if (batchStartedEvents.length !== 1) return false;

  const queuedEvents = batchEvents.filter((event): event is TaskQueuedEvent => event.type === "task_queued");
  if (queuedEvents.length !== batch.taskIds.length) return false;

  const queuedCounts = new Map<string, number>();
  for (const event of queuedEvents) {
    if (typeof event.taskId !== "string") return false;
    queuedCounts.set(event.taskId, (queuedCounts.get(event.taskId) ?? 0) + 1);
  }

  for (const taskId of batch.taskIds) {
    if (queuedCounts.get(taskId) !== 1) return false;
    const task = await readTaskArtifact(batchDir, taskId);
    if (!hasQueuedTaskArtifact(task, batch.batchId, taskId)) return false;
  }

  return true;
}

export function buildBatchId(startedAt: string, randomDigits = randomSixDigitSuffix()): string {
  const sortableTimestamp = startedAt.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `${sortableTimestamp}-${randomDigits}`;
}

function materializeEvent(batchId: string, seq: number, event: AuditEventInput): TaskAuditEvent {
  return {
    ...event,
    schemaVersion: TASK_AUDIT_SCHEMA_VERSION,
    batchId,
    seq,
  } as TaskAuditEvent;
}

function buildTaskToolCall(input: RecordToolCallInput): TaskToolCall {
  return {
    at: input.at,
    tool: input.tool,
    argsPreview: previewToolInput(input.args),
    status: input.status,
    error: input.error,
  };
}

async function rewriteTaskArtifact(
  batchDir: string,
  taskId: string,
  update: (task: TaskArtifact) => TaskArtifact,
): Promise<TaskArtifact> {
  const current = await readTaskArtifact(batchDir, taskId);
  if (current === null) {
    throw new Error(`Missing task artifact for ${taskId}.`);
  }
  const next = update(current);
  await writeTaskArtifactAtomic(batchDir, next);
  return next;
}

function appendTimelineState(
  timeline: TaskArtifact["timeline"],
  at: string,
  state: TaskArtifact["status"],
): TaskArtifact["timeline"] {
  const last = timeline[timeline.length - 1];
  if (last?.state === state) {
    return [...timeline];
  }
  return [...timeline, { at, state }];
}

function hasQueuedTaskArtifact(task: TaskArtifact | null, batchId: string, taskId: string): boolean {
  if (task === null) return false;
  if (task.schemaVersion !== TASK_AUDIT_SCHEMA_VERSION) return false;
  if (task.batchId !== batchId || task.id !== taskId) return false;
  if (typeof task.queuedAt !== "string" || task.queuedAt.length === 0) return false;
  if (!Array.isArray(task.timeline)) return false;
  return task.timeline.some((entry) => hasQueuedTimelineEntry(entry));
}

function hasQueuedTimelineEntry(entry: unknown): boolean {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      "at" in entry &&
      typeof entry.at === "string" &&
      entry.at.length > 0 &&
      "state" in entry &&
      entry.state === "queued",
  );
}

function isDiscoverableBatchRecord(batch: BatchRecord | null): batch is BatchRecord {
  return Boolean(
    batch &&
      batch.schemaVersion === TASK_AUDIT_SCHEMA_VERSION &&
      typeof batch.batchId === "string" &&
      batch.batchId.length > 0 &&
      (batch.toolName === "task" || batch.toolName === "tasks") &&
      typeof batch.initialized === "boolean" &&
      Array.isArray(batch.taskIds),
  );
}

function randomSixDigitSuffix(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

function isCorruptJsonlError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("Corrupt JSONL line ");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
