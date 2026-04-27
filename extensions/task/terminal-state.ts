export interface TerminalAssistantInfo {
  terminal: boolean;
  stopReason?: string;
  errorMessage?: string;
  hasText?: boolean;
  thinkingOnly?: boolean;
}

export interface TerminalRuntimeState {
  sawTerminalAssistantMessage: boolean;
  stopReason?: string;
  errorMessage?: string;
}

export type TerminalRuntimeAction = "none" | "schedule_exit_guard" | "cancel_exit_guard";

export interface TerminalRuntimeTransition {
  state: TerminalRuntimeState;
  action: TerminalRuntimeAction;
}

export function createTerminalRuntimeState(): TerminalRuntimeState {
  return { sawTerminalAssistantMessage: false };
}

function hasVisibleAssistantText(message: any): boolean {
  return Array.isArray(message?.content) && message.content.some((part: any) =>
    part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0
  );
}

function isThinkingOnlyAssistantMessage(message: any): boolean {
  return Array.isArray(message?.content)
    && message.content.length > 0
    && message.content.every((part: any) => part?.type === "thinking");
}

export function inspectTerminalAssistantEvent(event: unknown): TerminalAssistantInfo {
  if (!event || typeof event !== "object") return { terminal: false };
  const record = event as Record<string, any>;
  if (record.type !== "message_end" || !record.message) return { terminal: false };
  const message = record.message;
  if (message.role !== "assistant") return { terminal: false };
  if (!message.stopReason || message.stopReason === "toolUse") return { terminal: false };
  return {
    terminal: true,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    hasText: hasVisibleAssistantText(message),
    thinkingOnly: isThinkingOnlyAssistantMessage(message),
  };
}

const RECOVERY_RESET_TYPES = new Set([
  "auto_retry_start",
  "agent_start",
  "turn_start",
  "tool_execution_start",
  "message_start",
]);

export function isRecoveryStartEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = (event as Record<string, unknown>).type;
  return typeof type === "string" && RECOVERY_RESET_TYPES.has(type);
}

/**
 * Pure state machine for Codex/Pi assistant terminal events. The runner owns
 * process timers; this module only says whether a parsed JSONL record means
 * "schedule guard", "cancel guard", or "leave timers alone".
 */
export function reduceTerminalRuntimeState(state: TerminalRuntimeState, event: unknown): TerminalRuntimeTransition {
  if (isRecoveryStartEvent(event) && (state.stopReason === "error" || state.stopReason === "thinking_only_stop")) {
    return { state: { sawTerminalAssistantMessage: false }, action: "cancel_exit_guard" };
  }

  const terminal = inspectTerminalAssistantEvent(event);
  if (!terminal.terminal) return { state, action: "none" };

  if (terminal.stopReason === "error") {
    return {
      state: {
        sawTerminalAssistantMessage: false,
        stopReason: terminal.stopReason,
        errorMessage: terminal.errorMessage ?? state.errorMessage,
      },
      action: "none",
    };
  }

  if (terminal.thinkingOnly && !terminal.hasText) {
    return {
      state: {
        sawTerminalAssistantMessage: false,
        stopReason: "thinking_only_stop",
        errorMessage: state.errorMessage ?? "assistant ended its turn with thinking-only content (no text or tool call)",
      },
      action: "schedule_exit_guard",
    };
  }

  return {
    state: {
      sawTerminalAssistantMessage: true,
      stopReason: terminal.stopReason,
      errorMessage: terminal.errorMessage ?? state.errorMessage,
    },
    action: "schedule_exit_guard",
  };
}
