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

export interface StdoutTelemetryContext {
	taskId: string;
	attemptId: string;
	cwd: string;
}

export interface StdoutTelemetryState {
	seenStarts: Set<string>;
	seenEnds: Set<string>;
}

export function createStdoutTelemetryState(): StdoutTelemetryState {
	return { seenStarts: new Set(), seenEnds: new Set() };
}

const FILE_WRITE_TOOLS = new Set(["edit", "multi_edit", "write"]);

function recordArgs(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pickWritePath(args: Record<string, unknown>): string | undefined {
	const candidate = args.path ?? args.file ?? args.target;
	return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function normalizeWritePath(filePath: string, cwd: string): string {
	const replaced = filePath.replace(/\\/g, "/");
	if (!replaced.startsWith("/") && !/^[a-zA-Z]:\//.test(replaced)) return replaced;
	const cwdNormalized = cwd.replace(/\\/g, "/").replace(/\/$/, "");
	if (cwdNormalized && replaced.startsWith(`${cwdNormalized}/`)) return replaced.slice(cwdNormalized.length + 1);
	return replaced;
}

/**
 * Translate child Pi stdout JSONL `tool_execution_*` events into structured
 * worker telemetry. Returning a `tool_call_started` event for every observed
 * tool call proves the supervisor was actively listening (so the write audit
 * channel is "available" even when no writes happened). For known
 * file-mutating tools we also emit a `file_write_observed` event so acceptance
 * checks can attribute writes back to this worker — independent of any git
 * diff source.
 */
export function extractStdoutTelemetry(record: unknown, state: StdoutTelemetryState, ctx: StdoutTelemetryContext): WorkerEvent[] {
	if (!record || typeof record !== "object") return [];
	const event = record as Record<string, unknown>;
	const type = event.type;
	if (type === "tool_execution_start") {
		const callId = String(event.toolCallId ?? `${event.toolName ?? "tool"}:${JSON.stringify(event.args ?? {})}`);
		if (state.seenStarts.has(callId)) return [];
		state.seenStarts.add(callId);
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const args = recordArgs(event.args);
		const events: WorkerEvent[] = [
			buildWorkerEvent({ type: "tool_call_started", taskId: ctx.taskId, attemptId: ctx.attemptId, tool: toolName, args }),
		];
		if (FILE_WRITE_TOOLS.has(toolName)) {
			const writePath = pickWritePath(args);
			if (writePath) {
				events.push(buildWorkerEvent({
					type: "file_write_observed",
					taskId: ctx.taskId,
					attemptId: ctx.attemptId,
					tool: toolName,
					path: normalizeWritePath(writePath, ctx.cwd),
					args,
				}));
			}
		}
		return events;
	}
	if (type === "tool_execution_end") {
		const callId = String(event.toolCallId ?? `${event.toolName ?? "tool"}:end`);
		if (state.seenEnds.has(callId)) return [];
		state.seenEnds.add(callId);
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const failed = event.isError === true || (event as { result?: { isError?: boolean } }).result?.isError === true;
		return [buildWorkerEvent({
			type: "tool_call_finished",
			taskId: ctx.taskId,
			attemptId: ctx.attemptId,
			tool: toolName,
			status: failed ? "error" : "ok",
		})];
	}
	return [];
}

export function detectWorkerStall(events: WorkerEvent[], nowMs: number, thresholdMs: number): "worker_stalled" | "provider_stalled" | "unknown_stall" | null {
  const last = [...events].reverse().find((event) => event.type === "heartbeat" || event.type === "progress" || event.type === "tool_call_started" || event.type === "tool_call_finished");
  if (!last) return events.length === 0 ? "unknown_stall" : null;
  const age = nowMs - Date.parse(last.at);
  if (Number.isNaN(age) || age <= thresholdMs) return null;
  if (last.type === "tool_call_started") return "provider_stalled";
  return "worker_stalled";
}
