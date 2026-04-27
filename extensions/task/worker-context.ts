import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface WorkerContextGuardOptions {
  contextWindow?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  minRecentMessages?: number;
  maxSummaryChars?: number;
}

export interface WorkerContextGuardResult {
  messages: AgentMessage[];
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  droppedMessages: number;
  summary?: string;
}

const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_MIN_RECENT_MESSAGES = 8;
const DEFAULT_MAX_SUMMARY_CHARS = 4_000;

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
    if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
    if (record.type === "toolCall") return `${String(record.name ?? "tool")} ${JSON.stringify(record.arguments ?? {})}`;
    if (record.type === "image") return "[image]".repeat(1200);
    return "";
  }).join("\n");
}

export function estimateWorkerMessageTokens(message: AgentMessage): number {
  const msg = message as Record<string, unknown>;
  const role = msg.role;
  let chars = String(role ?? "").length;
  if (role === "assistant" || role === "user" || role === "toolResult") {
    chars += textOfContent(msg.content).length;
    if (role === "toolResult") chars += String(msg.toolName ?? "").length;
  } else if (role === "custom") {
    chars += textOfContent(msg.content).length;
  } else if (role === "bashExecution") {
    chars += String(msg.command ?? "").length + String(msg.output ?? "").length;
  } else if (role === "branchSummary" || role === "compactionSummary") {
    chars += String(msg.summary ?? "").length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateWorkerContextTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateWorkerMessageTokens(message), 0);
}

function firstUserIndex(messages: AgentMessage[]): number {
  return messages.findIndex((message) => (message as { role?: string }).role === "user");
}

function chooseSuffixStart(messages: AgentMessage[], keepRecentTokens: number, minRecentMessages: number): number {
  let tokens = 0;
  let index = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += estimateWorkerMessageTokens(messages[i]!);
    index = i;
    const keptCount = messages.length - i;
    if (tokens >= keepRecentTokens && keptCount >= minRecentMessages) break;
  }

  // Do not keep a dangling tool result without its assistant tool-call message.
  while (index > 0 && (messages[index] as { role?: string }).role === "toolResult") index -= 1;
  return index;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n...[truncated ${text.length - maxChars} chars]`;
}

function summarizeDroppedMessages(messages: AgentMessage[], maxSummaryChars: number): string {
  const roleCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const snippets: string[] = [];

  for (const message of messages) {
    const msg = message as Record<string, unknown>;
    const role = String(msg.role ?? "unknown");
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    if (role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block?.type === "toolCall") {
          const name = String(block.name ?? "tool");
          toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        }
      }
    }
    if (role === "toolResult" && typeof msg.toolName === "string") {
      toolCounts.set(msg.toolName, (toolCounts.get(msg.toolName) ?? 0) + 1);
    }
    if (snippets.length < 6) {
      const text = textOfContent(msg.content).replace(/\s+/g, " ").trim();
      if (text) snippets.push(`- ${role}: ${truncate(text, 320)}`);
    }
  }

  const roleLine = [...roleCounts.entries()].map(([role, count]) => `${role}=${count}`).join(", ") || "none";
  const toolLine = [...toolCounts.entries()].map(([tool, count]) => `${tool}=${count}`).join(", ") || "none";
  const body = [
    "[Task worker context compacted before provider call]",
    "Earlier worker messages were summarized deterministically to avoid context-window overflow. The original task prompt and the latest live messages remain in context.",
    `Dropped messages: ${messages.length} (${roleLine}).`,
    `Tools observed in dropped history: ${toolLine}.`,
    "Important instruction: continue from the filesystem and current artifacts, avoid re-reading huge outputs unless needed, and still submit task_report plus worker.md before finishing.",
    snippets.length ? "Representative dropped snippets:" : undefined,
    ...snippets,
  ].filter(Boolean).join("\n");
  return truncate(body, maxSummaryChars);
}

function makeCustomSummaryMessage(summary: string): AgentMessage {
  return {
    role: "custom",
    customType: "task_worker_context_compaction",
    content: summary,
    display: "Task worker context compacted",
    details: undefined,
    timestamp: Date.now(),
  } as AgentMessage;
}

export function guardWorkerContext(messages: AgentMessage[], options: WorkerContextGuardOptions = {}): WorkerContextGuardResult {
  const contextWindow = options.contextWindow ?? 0;
  const tokensBefore = estimateWorkerContextTokens(messages);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { messages, compacted: false, tokensBefore, tokensAfter: tokensBefore, droppedMessages: 0 };
  }

  const reserveTokens = options.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const threshold = Math.max(1, contextWindow - reserveTokens);
  if (tokensBefore <= threshold) {
    return { messages, compacted: false, tokensBefore, tokensAfter: tokensBefore, droppedMessages: 0 };
  }

  const keepRecentTokens = options.keepRecentTokens ?? Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.max(1, Math.floor(contextWindow * 0.35)));
  const minRecentMessages = options.minRecentMessages ?? DEFAULT_MIN_RECENT_MESSAGES;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const firstUser = firstUserIndex(messages);
  const preserveHeadEnd = firstUser >= 0 ? firstUser + 1 : Math.min(1, messages.length);
  const suffixStart = Math.max(preserveHeadEnd, chooseSuffixStart(messages, keepRecentTokens, minRecentMessages));
  const dropped = messages.slice(preserveHeadEnd, suffixStart);
  if (dropped.length === 0) {
    return { messages, compacted: false, tokensBefore, tokensAfter: tokensBefore, droppedMessages: 0 };
  }

  const summary = summarizeDroppedMessages(dropped, maxSummaryChars);
  const compactedMessages = [
    ...messages.slice(0, preserveHeadEnd),
    makeCustomSummaryMessage(summary),
    ...messages.slice(suffixStart),
  ];
  const tokensAfter = estimateWorkerContextTokens(compactedMessages);
  return { messages: compactedMessages, compacted: true, tokensBefore, tokensAfter, droppedMessages: dropped.length, summary };
}
