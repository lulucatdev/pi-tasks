import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TaskReport } from "./types.ts";
import { validateTaskReport } from "./worker-protocol.ts";

export interface SubmitTaskReportInput extends Omit<TaskReport, "schemaVersion"> {
  schemaVersion?: 1;
}

export interface SubmitTaskReportResult {
  reportPath: string;
  ok: boolean;
  errors: string[];
}

export function getTaskReportPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PI_TASK_REPORT_PATH;
}

export async function submitTaskReport(input: SubmitTaskReportInput, env: NodeJS.ProcessEnv = process.env): Promise<SubmitTaskReportResult> {
  const reportPath = getTaskReportPath(env);
  if (!reportPath) return { reportPath: "", ok: false, errors: ["PI_TASK_REPORT_PATH is not set"] };
  const report = { ...input, schemaVersion: 1 } as TaskReport;
  const expectedTaskId = env.PI_TASK_ID ?? report.taskId;
  const expectedAttemptId = env.PI_TASK_ATTEMPT_ID ?? report.attemptId;
  const validation = validateTaskReport(report, { taskId: expectedTaskId, attemptId: expectedAttemptId });
  if (!validation.ok) return { reportPath, ok: false, errors: validation.errors };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return { reportPath, ok: true, errors: [] };
}

export function buildTaskReportToolDefinition() {
  const deliverableSchema = {
    type: "object",
    required: ["path", "kind"],
    properties: {
      path: { type: "string" },
      kind: { type: "string", enum: ["file", "dir", "note", "command"] },
      description: { type: "string" },
    },
  };
  const evidenceSchema = {
    type: "object",
    required: ["kind", "value"],
    properties: {
      kind: { type: "string", enum: ["file", "command", "text"] },
      value: { type: "string" },
    },
  };
  const internalRetrySchema = {
    type: "object",
    required: ["reason", "action", "outcome"],
    properties: {
      reason: { type: "string" },
      action: { type: "string" },
      outcome: { type: "string", enum: ["recovered", "failed"] },
    },
  };
  return {
    name: "task_report",
    label: "Task Report",
    description: "Submit the final structured task report to the parent task supervisor.",
    parameters: {
      type: "object",
      required: ["taskId", "attemptId", "status", "summary", "deliverables", "evidence"],
      properties: {
        taskId: { type: "string" },
        attemptId: { type: "string" },
        status: { type: "string", enum: ["completed", "partial", "blocked", "error"] },
        summary: { type: "string" },
        deliverables: { type: "array", items: deliverableSchema },
        evidence: { type: "array", items: evidenceSchema },
        internalRetries: { type: "array", items: internalRetrySchema },
        userActionRequired: { type: ["string", "null"] },
        error: { type: ["string", "null"] },
      },
    },
  };
}

export function registerTaskReportTool(pi: any): void {
  if (process.env.PI_CHILD_TYPE !== "task-worker" || !process.env.PI_TASK_REPORT_PATH) return;
  const definition = buildTaskReportToolDefinition();
  pi.registerTool({
    ...definition,
    async execute(_toolCallId: string, params: SubmitTaskReportInput) {
      const result = await submitTaskReport(params);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: result.ok ? `Task report submitted: ${result.reportPath}` : `Task report failed: ${result.errors.join("; ")}` }],
        details: result,
      };
    },
  });
}
