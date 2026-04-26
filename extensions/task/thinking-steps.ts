import { previewToolInput } from "./redaction.ts";
import type { TaskActivityItem } from "./types.ts";

export interface WorkerActivityState {
  lastThinkingLabel?: string;
  seenToolStarts: Set<string>;
  seenToolEnds: Set<string>;
}

export interface WorkerActivityContext {
  taskId: string;
  attemptId: string;
  now?: () => string;
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|[a-z][.)]\s+)/i;
const SUMMARY_PREFIX_RE = /^(?:i\s+(?:need|should|want)\s+to|need\s+to|i(?:'m| am)\s+going\s+to|i(?:'ll| will)|let\s+me|let'?s|first,?\s+|next,?\s+|then,?\s+|now,?\s+|okay,?\s+)/i;

export function createWorkerActivityState(): WorkerActivityState {
  return { seenToolStarts: new Set(), seenToolEnds: new Set() };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/^(\*\*|__)([\s\S]*?)\1$/g, "$2")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w/.-])\*(?=\S)([\s\S]*?\S)\*(?=[^\w/.-]|$)/g, "$1$2")
    .replace(/(^|[^\w/.-])_(?=\S)([\s\S]*?\S)_(?=[^\w/.-]|$)/g, "$1$2");
}

function stripLeadingMarker(text: string): string {
  return text.replace(HEADING_RE, "").replace(LIST_ITEM_RE, "").trim();
}

function firstMeaningfulLine(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function firstSentence(text: string): string {
  const normalized = collapseWhitespace(text);
  const match = normalized.match(/^(.{1,140}?)(?:[.!?](?:\s|$)|$)/);
  return match?.[1]?.trim() ?? normalized;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function summarizeThinkingStep(text: string): string | null {
  const normalized = collapseWhitespace(text);
  if (!normalized) return null;

  const paragraphs = normalized.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  const firstChunk = paragraphs[0] ?? normalized;
  const candidate = firstMeaningfulLine(firstChunk) || firstSentence(firstChunk);
  const stripped = stripMarkdownEmphasis(stripLeadingMarker(candidate))
    .replace(SUMMARY_PREFIX_RE, "")
    .trim();
  const summary = capitalize(firstSentence(stripped || candidate));
  return summary ? truncate(summary, 96) : null;
}

function contentArray(value: unknown): any[] {
  if (!value || typeof value !== "object") return [];
  const content = (value as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}

function extractThinkingText(record: Record<string, any>, event: Record<string, any>): string {
  const contentIndex = typeof event.contentIndex === "number" ? event.contentIndex : undefined;
  const candidates = [record.message, event.partial];
  for (const candidate of candidates) {
    const content = contentArray(candidate);
    const part = contentIndex !== undefined ? content[contentIndex] : [...content].reverse().find((item) => item?.type === "thinking");
    if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) return part.thinking;
  }
  return typeof event.delta === "string" ? event.delta : "";
}

function activity(input: WorkerActivityContext & { kind: TaskActivityItem["kind"]; label: string; detail?: string }): TaskActivityItem {
  return {
    at: input.now?.() ?? new Date().toISOString(),
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: input.kind,
    label: input.label,
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

export function extractWorkerActivity(record: unknown, state: WorkerActivityState, ctx: WorkerActivityContext): TaskActivityItem | null {
  if (!record || typeof record !== "object") return null;
  const event = record as Record<string, any>;

  if (event.type === "message_update" && event.assistantMessageEvent?.type?.startsWith?.("thinking")) {
    const summary = summarizeThinkingStep(extractThinkingText(event, event.assistantMessageEvent));
    if (!summary || summary === state.lastThinkingLabel) return null;
    state.lastThinkingLabel = summary;
    return activity({ ...ctx, kind: "thinking", label: summary });
  }

  if (event.type === "tool_execution_start") {
    const id = String(event.toolCallId ?? `${event.toolName ?? "tool"}:${JSON.stringify(event.args ?? {})}`);
    if (state.seenToolStarts.has(id)) return null;
    state.seenToolStarts.add(id);
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const argsPreview = previewToolInput(event.args);
    return activity({ ...ctx, kind: "tool", label: `${toolName} started`, detail: argsPreview });
  }

  if (event.type === "tool_execution_end") {
    const id = String(event.toolCallId ?? `${event.toolName ?? "tool"}:end`);
    if (state.seenToolEnds.has(id)) return null;
    state.seenToolEnds.add(id);
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const failed = event.isError === true || event.result?.isError === true;
    return activity({ ...ctx, kind: "tool", label: `${toolName} ${failed ? "failed" : "finished"}` });
  }

  return null;
}

export function renderActivityLine(item: TaskActivityItem): string {
  const detail = item.detail ? ` ${truncate(item.detail, 100)}` : "";
  return `${item.kind}: ${truncate(item.label, 96)}${detail}`;
}
