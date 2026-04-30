import * as fs from "node:fs/promises";
import type { NormalizedJobSpec, JobDeliverable, JobEvidence, JobReport } from "./types.ts";

const REPORT_STATUSES = new Set(["completed", "partial", "blocked", "error"]);
const DELIVERABLE_KINDS = new Set(["file", "dir", "note", "command"]);
const EVIDENCE_KINDS = new Set(["file", "command", "text"]);

export interface ReportValidationResult {
  ok: boolean;
  report?: JobReport;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateDeliverables(value: unknown): { ok: boolean; value: JobDeliverable[]; errors: string[] } {
  if (!Array.isArray(value)) return { ok: false, value: [], errors: ["deliverables must be an array"] };
  const errors: string[] = [];
  const deliverables: JobDeliverable[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`deliverables[${index}] must be an object`);
      return;
    }
    if (typeof item.path !== "string" || !item.path.trim()) errors.push(`deliverables[${index}].path must be a non-empty string`);
    if (typeof item.kind !== "string" || !DELIVERABLE_KINDS.has(item.kind)) errors.push(`deliverables[${index}].kind is invalid`);
    if (errors.length === 0 || (typeof item.path === "string" && typeof item.kind === "string" && DELIVERABLE_KINDS.has(item.kind))) {
      deliverables.push({ path: String(item.path ?? ""), kind: item.kind as JobDeliverable["kind"], description: typeof item.description === "string" ? item.description : undefined });
    }
  });
  return { ok: errors.length === 0, value: deliverables, errors };
}

function validateEvidence(value: unknown): { ok: boolean; value: JobEvidence[]; errors: string[] } {
  if (!Array.isArray(value)) return { ok: false, value: [], errors: ["evidence must be an array"] };
  const errors: string[] = [];
  const evidence: JobEvidence[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`evidence[${index}] must be an object`);
      return;
    }
    if (typeof item.value !== "string" || !item.value.trim()) errors.push(`evidence[${index}].value must be a non-empty string`);
    if (typeof item.kind !== "string" || !EVIDENCE_KINDS.has(item.kind)) errors.push(`evidence[${index}].kind is invalid`);
    if (typeof item.value === "string" && typeof item.kind === "string" && EVIDENCE_KINDS.has(item.kind)) {
      evidence.push({ kind: item.kind as JobEvidence["kind"], value: item.value });
    }
  });
  return { ok: errors.length === 0, value: evidence, errors };
}

export function validateJobReport(value: unknown, expected?: { jobId?: string; attemptId?: string }): ReportValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["report must be an object"] };

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof value.jobId !== "string" || !value.jobId.trim()) errors.push("jobId must be a non-empty string");
  if (typeof value.attemptId !== "string" || !value.attemptId.trim()) errors.push("attemptId must be a non-empty string");
  if (expected?.jobId && value.jobId !== expected.jobId) errors.push(`jobId must be ${expected.jobId}`);
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
      jobId: value.jobId as string,
      attemptId: value.attemptId as string,
      status: value.status as JobReport["status"],
      summary: value.summary as string,
      deliverables: deliverables.value,
      evidence: evidence.value,
      internalRetries: Array.isArray(value.internalRetries) ? value.internalRetries as JobReport["internalRetries"] : undefined,
      userActionRequired: typeof value.userActionRequired === "string" ? value.userActionRequired : null,
      error: typeof value.error === "string" ? value.error : null,
    },
  };
}

export async function readJobReport(reportPath: string, expected?: { jobId?: string; attemptId?: string }): Promise<ReportValidationResult> {
  try {
    const raw = await fs.readFile(reportPath, "utf-8");
    return validateJobReport(JSON.parse(raw), expected);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/ENOENT|no such file/i.test(reason)) {
      return { ok: false, errors: ["No job report submitted: the worker ended its turn without calling job_report or writing job-report.json"] };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, errors: [`Job report is not valid JSON: ${reason}`] };
    }
    return { ok: false, errors: [`Could not read job report: ${reason}`] };
  }
}

export function buildWorkerSystemPrompt(): string {
  return [
    "You are a job agent supervised by the root pi job runtime.",
    "",
    "## Submission contract (read this first; non-negotiable)",
    "",
    "Your job is NOT done when you finish thinking or when you finish writing files. Your job is done only when both of these have happened in the SAME final assistant turn:",
    "",
    "1. You called the `job_report` tool (preferred) with a structured report. If `job_report` is unavailable in this session, use the `write` tool to put the same JSON at the exact `Job report path:` given in the user prompt below.",
    "2. You used the `write` tool to put a short human-readable summary at the exact `Worker log path:` given in the user prompt below. The supervisor treats an empty worker log as 'worker did not finish'.",
    "",
    "If you end your final assistant turn without doing both of the above, the supervisor classifies the run as `no job report` and the entire job fails — even if every file you actually edited is correct. There is no partial credit.",
    "",
    "Failure modes the supervisor watches for and that you must avoid:",
    "- Ending the assistant turn with ONLY a thinking block and no text and no tool call. This is detected as `thinking-only stop` and the job fails. Always finalize with a real text answer or, better, a final `job_report` tool call.",
    "- Stopping mid-investigation when you realize you do not have enough information. In that case still submit `job_report` with status `partial`, `blocked`, or `error`, with `summary`, `userActionRequired`, and any partial `deliverables` and `evidence`. Always submit something.",
    "- Calling `job_report` once and then continuing to think and stop with thinking-only afterwards. The LAST assistant message of the turn must contain visible text or be the `job_report` tool call itself.",
    "",
    "## Final-turn checklist before you let the turn end",
    "",
    "- [ ] Called `job_report` (or wrote the JSON to the job report path).",
    "- [ ] Wrote a non-empty worker.md to the worker log path.",
    "- [ ] Every required output artifact named in the user prompt actually exists on disk.",
    "- [ ] The very last assistant message has visible text content or is the `job_report` call. No thinking-only stops.",
    "",
    "## Working rules",
    "",
    "- You may read, write, edit, and run commands needed for the assigned work.",
    "- Avoid filling your context with huge file dumps or command output. Prefer targeted `read` ranges, `grep`, summaries, and writing durable notes to files. If earlier tool history is compacted, continue from the filesystem and artifacts rather than re-reading everything.",
    "- Handle recoverable work errors yourself before reporting final status; record what you retried in `internalRetries`.",
    "- Do not spawn nested `job` / `jobs` / `jobs_plan` workers.",
    "- The structured `job_report` (or `job-report.json` file) is the ONLY completion protocol the supervisor trusts. Status text in chat does not count.",
  ].join("\n");
}

export function buildWorkerPrompt(input: {
  job: NormalizedJobSpec;
  attemptId: string;
  workerLogPath: string;
  reportPath: string;
}): string {
  const reportExample = {
    schemaVersion: 1,
    jobId: input.job.id,
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
    `Job id: ${input.job.id}`,
    `Attempt id: ${input.attemptId}`,
    `Job name: ${input.job.name}`,
    `Worker log path: ${input.workerLogPath}`,
    `Job report path: ${input.reportPath}`,
    "",
    "## Job prompt",
    "",
    input.job.prompt,
    "",
    "## Submission protocol (mandatory)",
    "",
    "Before your final assistant turn ends you MUST do all of the following. Without these the supervisor records `no job report` and the job fails even if your edits are perfect:",
    "",
    `1. Call the \`job_report\` tool with the JSON shape below. If \`job_report\` is unavailable, use \`write\` to save the same JSON to: ${input.reportPath}`,
    `2. Use \`write\` to put a short human-readable summary at: ${input.workerLogPath} . Do not leave it empty.`,
    "3. Make sure every required output artifact named in the job prompt above actually exists on disk.",
    "4. The very last assistant message must have visible text content or be the `job_report` tool call. Do NOT end with a thinking-only message — that is detected as `thinking-only stop` and fails the job.",
    "",
    "If you cannot finish the work, still submit `job_report` with status `partial` / `blocked` / `error` plus `summary`, `userActionRequired`, and any partial deliverables and evidence. Always submit something.",
    "",
    "job-report.json shape:",
    JSON.stringify(reportExample, null, 2),
  ].join("\n");
}
