export type LegacyTaskStatus = "queued" | "running" | "success" | "error" | "aborted";

export function isTerminalAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && Boolean(message.stopReason) && message.stopReason !== "toolUse";
}

export function resolveTaskResultStatus(args: {
  wasAborted: boolean;
  exitCode: number;
  stopReason?: string;
  sawTerminalAssistantMessage: boolean;
}): LegacyTaskStatus {
  if (args.wasAborted || args.stopReason === "aborted") return "aborted";
  if (args.sawTerminalAssistantMessage) return args.stopReason === "error" ? "error" : "success";
  if (args.exitCode === 0 && args.stopReason !== "error") return "success";
  return "error";
}
