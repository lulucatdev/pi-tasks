import type { Message } from "@mariozechner/pi-ai";
import { previewToolInput } from "./redaction.ts";

export type JobDisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; argsPreview: string };

export function getAssistantVisibleText(message: Pick<Message, "content">): string {
  return message.content
    .filter((part): part is Extract<Message["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function extractFinalOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = getAssistantVisibleText(message);
    if (text) return text;
  }
  return "";
}

export function extractDisplayItems(messages: Message[]): JobDisplayItem[] {
  const items: JobDisplayItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") items.push({ type: "text", text: part.text });
      else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, argsPreview: previewToolInput(part.arguments) });
    }
  }
  return items;
}
