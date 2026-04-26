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

export type ActivityRole = "inspect" | "plan" | "compare" | "verify" | "write" | "search" | "error" | "default";

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

function stripAnsiAndControl(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "")
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

export function summarizeThinkingStep(text: string): string | null {
  const normalized = collapseWhitespace(stripAnsiAndControl(text));
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

function recordArgs(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringArg(args: Record<string, any>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function summarizeCommand(command: string): string {
  return truncate(collapseWhitespace(command), 76);
}

function toolStartLabel(toolName: string, argsValue: unknown): string {
  const args = recordArgs(argsValue);
  const pathValue = stringArg(args, "path") ?? stringArg(args, "file") ?? stringArg(args, "cwd");

  if (toolName === "read" && pathValue) return `Read ${basename(pathValue)}`;
  if (toolName === "write" && pathValue) return `Write ${basename(pathValue)}`;
  if (toolName === "edit" && pathValue) return `Edit ${basename(pathValue)}`;
  if (toolName === "grep") return `Search ${stringArg(args, "pattern") ?? pathValue ?? "workspace"}`;
  if (toolName === "find") return `Find ${stringArg(args, "pattern") ?? pathValue ?? "files"}`;
  if (toolName === "bash") return `Run ${summarizeCommand(stringArg(args, "command") ?? "shell command")}`;
  if (toolName === "task_report") return "Submit task report";
  if (toolName === "mcp") return "Call MCP tool";
  return pathValue ? `${toolName} ${basename(pathValue)}` : `Use ${toolName}`;
}

function prettyToolName(toolName: string): string {
  if (toolName === "task_report") return "Task report";
  return toolName ? toolName.charAt(0).toUpperCase() + toolName.slice(1) : "Tool";
}

function toolEndLabel(toolName: string, failed: boolean): string {
  if (toolName === "task_report") return failed ? "Task report failed" : "Task report submitted";
  return `${prettyToolName(toolName)} ${failed ? "failed" : "finished"}`;
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
    return activity({ ...ctx, kind: "tool", label: toolStartLabel(toolName, event.args), detail: previewToolInput(event.args) });
  }

  if (event.type === "tool_execution_end") {
    const id = String(event.toolCallId ?? `${event.toolName ?? "tool"}:end`);
    if (state.seenToolEnds.has(id)) return null;
    state.seenToolEnds.add(id);
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const failed = event.isError === true || event.result?.isError === true;
    return activity({ ...ctx, kind: "tool", label: toolEndLabel(toolName, failed) });
  }

  return null;
}

function inferActivityRole(item: TaskActivityItem): ActivityRole {
  const haystack = ` ${item.label.toLowerCase()} `;
  if (/\b(error|failed|failure|blocked|cannot|unable)\b/.test(haystack)) return "error";
  if (/\b(finished|submitted|passed|success|verified|verify|check)\b/.test(haystack)) return "verify";
  if (/\b(compare|versus|vs|trade-?off|alternative)\b/.test(haystack)) return "compare";
  if (/\b(search|find|grep|rg|locate|lookup)\b/.test(haystack)) return "search";
  if (/\b(read|inspect|review|reviewing|open|scan|look)\b/.test(haystack)) return "inspect";
  if (/\b(write|edit|patch|update|create|add|remove|submit)\b/.test(haystack)) return "write";
  if (/\b(plan|prepare|organize|decide|strategy|run|use|call)\b/.test(haystack)) return "plan";
  return "default";
}

export function iconForActivity(item: TaskActivityItem): string {
  switch (inferActivityRole(item)) {
    case "inspect": return "◫";
    case "plan": return "◇";
    case "compare": return "↔";
    case "verify": return "✓";
    case "write": return "✎";
    case "search": return "⌕";
    case "error": return "!";
    default: return "·";
  }
}

export function activitySummary(item: TaskActivityItem): string {
  return truncate(stripAnsiAndControl(collapseWhitespace(item.label)), 96);
}

export function activityRole(item: TaskActivityItem): ActivityRole {
  return inferActivityRole(item);
}

export function renderActivityCollapsedLine(item: TaskActivityItem): string {
  return `│ Thinking ${iconForActivity(item)} ${activitySummary(item)} ·`;
}

export function renderActivitySummaryLines(items: TaskActivityItem[], options: { maxItems?: number; header?: boolean; indent?: string } = {}): string[] {
  const maxItems = options.maxItems ?? 8;
  const indent = options.indent ?? "";
  const visible = items.slice(-maxItems);
  if (visible.length === 0) return [];
  const lines = options.header === false ? [] : [`${indent}┆ Thinking Steps · Summary`];
  for (let index = 0; index < visible.length; index += 1) {
    const item = visible[index]!;
    const connector = index === visible.length - 1 ? "└─" : "├─";
    lines.push(`${indent}${connector} ${iconForActivity(item)} ${activitySummary(item)}`);
  }
  return lines;
}

export function renderActivityLine(item: TaskActivityItem): string {
  return `${iconForActivity(item)} ${activitySummary(item)}`;
}
