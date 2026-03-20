export const TASK_AUDIT_SCHEMA_VERSION = 1 as const;
export const TOOL_INPUT_PREVIEW_LIMIT = 200;
export const TASK_AUDIT_EVENT_TYPES = [
  "batch_started",
  "task_queued",
  "task_running",
  "task_finished",
  "batch_finished",
] as const;

const REDACTED_PREVIEW_VALUE = "[REDACTED]";
const STRING_INPUT_PREVIEW = "[STRING_INPUT]";
const UNSERIALIZABLE_INPUT_PREVIEW = "[UNSERIALIZABLE_INPUT]";
const SENSITIVE_PREVIEW_KEYS = new Set(["authorization", "token", "apikey", "api_key", "password", "secret", "cookie"]);
const PREVIEW_GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export type BatchTerminalStatus = "success" | "error" | "aborted";
export type BatchRuntimeStatus = "initializing" | "running" | BatchTerminalStatus;
export type TaskArtifactStatus = "queued" | "running" | BatchTerminalStatus;
export type TaskToolCallStatus = "completed" | "failed";
export type AuditIntegrity = "pending" | "ok" | "failed";
export type TaskAuditEventType = (typeof TASK_AUDIT_EVENT_TYPES)[number];
export type FinalizedAuditIntegrity = Exclude<AuditIntegrity, "pending">;

export interface BatchSummary {
  total: number;
  success: number;
  error: number;
  aborted: number;
}

export interface TaskAuditBaseEvent {
  schemaVersion: typeof TASK_AUDIT_SCHEMA_VERSION;
  type: TaskAuditEventType;
  batchId: string;
  at: string;
  seq: number;
}

export interface BatchStartedEvent extends TaskAuditBaseEvent {
  type: "batch_started";
  toolName: "task" | "tasks";
  rootCwd: string;
}

export interface TaskQueuedEvent extends TaskAuditBaseEvent {
  type: "task_queued";
  taskId: string;
}

export interface TaskRunningEvent extends TaskAuditBaseEvent {
  type: "task_running";
  taskId: string;
}

export interface TaskFinishedEvent extends TaskAuditBaseEvent {
  type: "task_finished";
  taskId: string;
  status: BatchTerminalStatus;
  error: string | null;
}

export interface BatchFinishedEvent extends TaskAuditBaseEvent {
  type: "batch_finished";
  status: BatchTerminalStatus;
  auditIntegrity: FinalizedAuditIntegrity;
}

export type TaskAuditEvent =
  | BatchStartedEvent
  | TaskQueuedEvent
  | TaskRunningEvent
  | TaskFinishedEvent
  | BatchFinishedEvent;

export interface BatchRecord {
  schemaVersion: typeof TASK_AUDIT_SCHEMA_VERSION;
  batchId: string;
  toolName: "task" | "tasks";
  rootCwd: string;
  startedAt: string;
  finishedAt: string | null;
  status: BatchRuntimeStatus;
  initialized: boolean;
  taskIds: string[];
  summary: BatchSummary;
  auditIntegrity: AuditIntegrity;
}

export interface TaskTimelineEntry {
  at: string;
  state: TaskArtifactStatus;
}

export interface TaskToolCall {
  at: string;
  tool: string;
  argsPreview: string;
  status: TaskToolCallStatus;
  error: string | null;
}

export interface TaskArtifact {
  schemaVersion: typeof TASK_AUDIT_SCHEMA_VERSION;
  batchId: string;
  id: string;
  name?: string;
  task: string;
  cwd: string;
  status: TaskArtifactStatus;
  queuedAt: string;
  finishedAt: string | null;
  finalOutput: string | null;
  error: string | null;
  timeline: TaskTimelineEntry[];
  toolCalls: TaskToolCall[];
}

export interface BuildBatchRecordInput {
  batchId: string;
  toolName: BatchRecord["toolName"];
  rootCwd: string;
  startedAt: string;
}

export interface BuildQueuedTaskArtifactInput {
  batchId: string;
  id: string;
  name?: string;
  task: string;
  cwd: string;
  queuedAt: string;
}

export function buildBatchRecord(input: BuildBatchRecordInput): BatchRecord {
  return {
    schemaVersion: TASK_AUDIT_SCHEMA_VERSION,
    batchId: input.batchId,
    toolName: input.toolName,
    rootCwd: input.rootCwd,
    startedAt: input.startedAt,
    finishedAt: null,
    status: "initializing",
    initialized: false,
    taskIds: [],
    summary: {
      total: 0,
      success: 0,
      error: 0,
      aborted: 0,
    },
    auditIntegrity: "pending",
  };
}

export function buildQueuedTaskArtifact(input: BuildQueuedTaskArtifactInput): TaskArtifact {
  const artifact: TaskArtifact = {
    schemaVersion: TASK_AUDIT_SCHEMA_VERSION,
    batchId: input.batchId,
    id: input.id,
    task: input.task,
    cwd: input.cwd,
    status: "queued",
    queuedAt: input.queuedAt,
    finishedAt: null,
    finalOutput: null,
    error: null,
    timeline: [{ at: input.queuedAt, state: "queued" }],
    toolCalls: [],
  };

  if (input.name !== undefined) {
    artifact.name = input.name;
  }

  return artifact;
}

export function previewToolInput(value: unknown): string {
  if (typeof value === "string") {
    return STRING_INPUT_PREVIEW;
  }

  try {
    const normalized = normalizePreviewValue(value, new WeakSet<object>());
    const serialized = JSON.stringify(normalized);
    if (typeof serialized !== "string") {
      return UNSERIALIZABLE_INPUT_PREVIEW;
    }
    return truncatePreview(serialized, TOOL_INPUT_PREVIEW_LIMIT);
  } catch {
    return UNSERIALIZABLE_INPUT_PREVIEW;
  }
}

function normalizePreviewValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (value instanceof Date) return value.toJSON();

  const valueType = typeof value;
  if (valueType !== "object") {
    return value;
  }

  if (seen.has(value)) {
    throw new TypeError("Circular preview input is not serializable.");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeArrayEntry(entry, seen));
    }

    const serializable = callToJsonIfPresent(value as Record<string, unknown>);
    if (serializable !== value) {
      return normalizePreviewValue(serializable, seen);
    }

    const objectValue = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue).sort()) {
      const entry = objectValue[key];
      if (shouldOmitObjectEntry(entry)) continue;
      normalized[key] = isSensitivePreviewKey(key) ? REDACTED_PREVIEW_VALUE : normalizePreviewValue(entry, seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function callToJsonIfPresent(value: Record<string, unknown>): unknown {
  if (typeof value.toJSON !== "function") {
    return value;
  }
  return value.toJSON();
}

function normalizeArrayEntry(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  return normalizePreviewValue(value, seen);
}

function shouldOmitObjectEntry(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function isSensitivePreviewKey(key: string): boolean {
  return SENSITIVE_PREVIEW_KEYS.has(key.toLowerCase());
}

function truncatePreview(value: string, limit: number): string {
  const graphemes = splitPreviewGraphemes(value);
  if (graphemes.length <= limit) {
    return value;
  }
  return `${graphemes.slice(0, Math.max(0, limit - 3)).join("")}...`;
}

function splitPreviewGraphemes(value: string): string[] {
  if (PREVIEW_GRAPHEME_SEGMENTER === null) {
    return Array.from(value);
  }
  return Array.from(PREVIEW_GRAPHEME_SEGMENTER.segment(value), ({ segment }) => segment);
}
