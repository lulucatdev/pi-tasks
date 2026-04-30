import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JobReport } from "./types.ts";
import { validateJobReport } from "./worker-protocol.ts";

export interface SubmitJobReportInput extends Omit<JobReport, "schemaVersion"> {
  schemaVersion?: 1;
}

export interface SubmitJobReportResult {
  reportPath: string;
  ok: boolean;
  errors: string[];
}

export function getJobReportPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PI_JOB_REPORT_PATH;
}

export async function submitJobReport(input: SubmitJobReportInput, env: NodeJS.ProcessEnv = process.env): Promise<SubmitJobReportResult> {
  const reportPath = getJobReportPath(env);
  if (!reportPath) return { reportPath: "", ok: false, errors: ["PI_JOB_REPORT_PATH is not set"] };
  const report = { ...input, schemaVersion: 1 } as JobReport;
  const expectedJobId = env.PI_JOB_ID ?? report.jobId;
  const expectedAttemptId = env.PI_JOB_ATTEMPT_ID ?? report.attemptId;
  const validation = validateJobReport(report, { jobId: expectedJobId, attemptId: expectedAttemptId });
  if (!validation.ok) return { reportPath, ok: false, errors: validation.errors };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return { reportPath, ok: true, errors: [] };
}

export function buildJobReportToolDefinition() {
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
    name: "job_report",
    label: "Job Report",
    description: "Submit the final structured job report to the parent job supervisor.",
    parameters: {
      type: "object",
      required: ["jobId", "attemptId", "status", "summary", "deliverables", "evidence"],
      properties: {
        jobId: { type: "string" },
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

export function registerJobReportTool(pi: any): void {
  if (process.env.PI_CHILD_TYPE !== "job-worker" || !process.env.PI_JOB_REPORT_PATH) return;
  const definition = buildJobReportToolDefinition();
  pi.registerTool({
    ...definition,
    async execute(_toolCallId: string, params: SubmitJobReportInput) {
      const result = await submitJobReport(params);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: result.ok ? `Job report submitted: ${result.reportPath}` : `Job report failed: ${result.errors.join("; ")}` }],
        details: result,
      };
    },
  });
}
