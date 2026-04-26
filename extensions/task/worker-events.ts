import * as fs from "node:fs/promises";
import * as path from "node:path";
import { previewToolInput } from "./redaction.ts";
import { readJsonlTolerant } from "./audit-log.ts";

export type WorkerEventType =
  | "heartbeat"
  | "progress"
  | "tool_call_started"
  | "tool_call_finished"
  | "file_write_observed"
  | "task_report_submitted";

export interface WorkerEvent {
  schemaVersion: 1;
  at: string;
  type: WorkerEventType;
  taskId: string;
  attemptId: string;
  message?: string;
  tool?: string;
  argsPreview?: string;
  path?: string;
  status?: "ok" | "error";
  error?: string | null;
  data?: Record<string, unknown>;
}

export function workerEventsPathForAttempt(attemptDir: string): string {
  return path.join(attemptDir, "worker-events.jsonl");
}

export function buildWorkerEvent(input: Omit<WorkerEvent, "schemaVersion" | "at"> & { at?: string; args?: unknown }): WorkerEvent {
  const event: WorkerEvent = {
    schemaVersion: 1,
    at: input.at ?? new Date().toISOString(),
    type: input.type,
    taskId: input.taskId,
    attemptId: input.attemptId,
    message: input.message,
    tool: input.tool,
    path: input.path,
    status: input.status,
    error: input.error,
    data: input.data,
  };
  if ("args" in input) event.argsPreview = previewToolInput(input.args);
  else if (input.argsPreview) event.argsPreview = input.argsPreview;
  return event;
}

export async function appendWorkerEvent(filePath: string, event: WorkerEvent): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
}

export async function readWorkerEvents(filePath: string): Promise<WorkerEvent[]> {
  return readJsonlTolerant<WorkerEvent>(filePath);
}

export function observedWritePaths(events: WorkerEvent[]): string[] {
  return events.filter((event) => event.type === "file_write_observed" && typeof event.path === "string" && event.path.trim()).map((event) => event.path as string);
}

export function detectWorkerStall(events: WorkerEvent[], nowMs: number, thresholdMs: number): "worker_stalled" | "provider_stalled" | "unknown_stall" | null {
  const last = [...events].reverse().find((event) => event.type === "heartbeat" || event.type === "progress" || event.type === "tool_call_started" || event.type === "tool_call_finished");
  if (!last) return events.length === 0 ? "unknown_stall" : null;
  const age = nowMs - Date.parse(last.at);
  if (Number.isNaN(age) || age <= thresholdMs) return null;
  if (last.type === "tool_call_started") return "provider_stalled";
  return "worker_stalled";
}
