import * as fs from "node:fs/promises";
import type { NormalizedTaskSpec, TaskDeliverable, TaskEvidence, TaskReport } from "./types.ts";

const REPORT_STATUSES = new Set(["completed", "partial", "blocked", "error"]);
const DELIVERABLE_KINDS = new Set(["file", "dir", "note", "command"]);
const EVIDENCE_KINDS = new Set(["file", "command", "text"]);

export interface ReportValidationResult {
  ok: boolean;
  report?: TaskReport;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateDeliverables(value: unknown): { ok: boolean; value: TaskDeliverable[]; errors: string[] } {
  if (!Array.isArray(value)) return { ok: false, value: [], errors: ["deliverables must be an array"] };
  const errors: string[] = [];
  const deliverables: TaskDeliverable[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`deliverables[${index}] must be an object`);
      return;
    }
    if (typeof item.path !== "string" || !item.path.trim()) errors.push(`deliverables[${index}].path must be a non-empty string`);
    if (typeof item.kind !== "string" || !DELIVERABLE_KINDS.has(item.kind)) errors.push(`deliverables[${index}].kind is invalid`);
    if (errors.length === 0 || (typeof item.path === "string" && typeof item.kind === "string" && DELIVERABLE_KINDS.has(item.kind))) {
      deliverables.push({ path: String(item.path ?? ""), kind: item.kind as TaskDeliverable["kind"], description: typeof item.description === "string" ? item.description : undefined });
    }
  });
  return { ok: errors.length === 0, value: deliverables, errors };
}

function validateEvidence(value: unknown): { ok: boolean; value: TaskEvidence[]; errors: string[] } {
  if (!Array.isArray(value)) return { ok: false, value: [], errors: ["evidence must be an array"] };
  const errors: string[] = [];
  const evidence: TaskEvidence[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`evidence[${index}] must be an object`);
      return;
    }
    if (typeof item.value !== "string" || !item.value.trim()) errors.push(`evidence[${index}].value must be a non-empty string`);
    if (typeof item.kind !== "string" || !EVIDENCE_KINDS.has(item.kind)) errors.push(`evidence[${index}].kind is invalid`);
    if (typeof item.value === "string" && typeof item.kind === "string" && EVIDENCE_KINDS.has(item.kind)) {
      evidence.push({ kind: item.kind as TaskEvidence["kind"], value: item.value });
    }
  });
  return { ok: errors.length === 0, value: evidence, errors };
}

export function validateTaskReport(value: unknown, expected?: { taskId?: string; attemptId?: string }): ReportValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["report must be an object"] };

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof value.taskId !== "string" || !value.taskId.trim()) errors.push("taskId must be a non-empty string");
  if (typeof value.attemptId !== "string" || !value.attemptId.trim()) errors.push("attemptId must be a non-empty string");
  if (expected?.taskId && value.taskId !== expected.taskId) errors.push(`taskId must be ${expected.taskId}`);
  if (expected?.attemptId && value.attemptId !== expected.attemptId) errors.push(`attemptId must be ${expected.attemptId}`);
  if (typeof value.status !== "string" || !REPORT_STATUSES.has(value.status)) errors.push("status is invalid");
  if (typeof value.summary !== "string" || !value.summary.trim()) errors.push("summary must be a non-empty string");

  const deliverables = validateDeliverables(value.deliverables);
  const evidence = validateEvidence(value.evidence);
  errors.push(...deliverables.errors, ...evidence.errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    report: {
      schemaVersion: 1,
      taskId: value.taskId as string,
      attemptId: value.attemptId as string,
      status: value.status as TaskReport["status"],
      summary: value.summary as string,
      deliverables: deliverables.value,
      evidence: evidence.value,
      internalRetries: Array.isArray(value.internalRetries) ? value.internalRetries as TaskReport["internalRetries"] : undefined,
      userActionRequired: typeof value.userActionRequired === "string" ? value.userActionRequired : null,
      error: typeof value.error === "string" ? value.error : null,
    },
  };
}

export async function readTaskReport(reportPath: string, expected?: { taskId?: string; attemptId?: string }): Promise<ReportValidationResult> {
  try {
    const raw = await fs.readFile(reportPath, "utf-8");
    return validateTaskReport(JSON.parse(raw), expected);
  } catch (error) {
    return { ok: false, errors: [`Could not read task report: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function buildWorkerSystemPrompt(): string {
  return [
    "You are a task agent supervised by the root pi task runtime.",
    "You may read, write, edit, and run commands needed for the assigned work.",
    "Handle recoverable work errors yourself before reporting final status.",
    "Do not spawn nested task/tasks workers.",
    "You must write a human-readable worker.md log and a machine-readable task-report.json file to the exact paths in the prompt.",
    "The task-report.json file is the only completion protocol the supervisor trusts.",
    "If you cannot fully finish, report status blocked, partial, or error with evidence and userActionRequired when relevant.",
  ].join("\n");
}

export function buildWorkerPrompt(input: {
  task: NormalizedTaskSpec;
  attemptId: string;
  workerLogPath: string;
  reportPath: string;
}): string {
  const reportExample = {
    schemaVersion: 1,
    taskId: input.task.id,
    attemptId: input.attemptId,
    status: "completed",
    summary: "Briefly summarize what was completed.",
    deliverables: [{ path: "relative/or/absolute/path", kind: "file", description: "What changed" }],
    evidence: [{ kind: "text", value: "Verification evidence" }],
    internalRetries: [],
    userActionRequired: null,
    error: null,
  };

  return [
    `Task id: ${input.task.id}`,
    `Attempt id: ${input.attemptId}`,
    `Task name: ${input.task.name}`,
    `Worker log path: ${input.workerLogPath}`,
    `Task report path: ${input.reportPath}`,
    "",
    "Task prompt:",
    input.task.prompt,
    "",
    "Write the final task-report.json with this shape:",
    JSON.stringify(reportExample, null, 2),
  ].join("\n");
}
