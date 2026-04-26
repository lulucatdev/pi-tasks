/**
 * tasks_plan: compact local fan-out expansion.
 *
 * The model emits a small `matrix + promptTemplate + acceptanceTemplate`
 * payload. The extension expands it locally into a full
 * `TasksToolParams` and hands it to the existing supervisor. This avoids the
 * "model streams 19 huge prompts as one mega tool-call argument" failure mode
 * that prevents `tasks.execute()` from ever starting.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AcceptanceContract, ParentRetryPolicy, PathCheck, TaskSpecInput, TasksToolParams, ThrottlePolicy } from "./types.ts";

export const MAX_PLAN_ROWS = 100;
export const MAX_PLAN_PROMPT_TEMPLATE_BYTES = 32_000;
export const MAX_PLAN_TOTAL_INPUT_BYTES = 64_000;

export interface TasksPlanRow {
	id: string;
	name?: string;
	cwd?: string;
	vars?: Record<string, string | string[]>;
}

export interface TasksPlanSynthesis {
	mode?: "parent" | "report-only";
	instructions?: string;
}

export interface TasksPlanInput {
	batchName: string;
	concurrency?: number;
	matrix: TasksPlanRow[];
	promptTemplate: string;
	nameTemplate?: string;
	cwdTemplate?: string;
	acceptanceTemplate?: AcceptanceContract;
	metadataTemplate?: Record<string, string>;
	retry?: ParentRetryPolicy;
	throttle?: ThrottlePolicy;
	acceptanceDefaults?: AcceptanceContract;
	synthesis?: TasksPlanSynthesis;
	parentBatchId?: string;
	rerunOfTaskIds?: string[];
}

export interface ExpandedTasksPlan {
	params: TasksToolParams;
	taskNames: string[];
	rowIds: string[];
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TEMPLATE_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const SOLO_TEMPLATE_RE = /^\s*\{\{\s*([A-Za-z0-9_]+)\s*\}\}\s*$/;

type Ctx = Record<string, string | string[]>;

function assertString(v: unknown, message: string): asserts v is string {
	if (typeof v !== "string" || !v.trim()) throw new Error(message);
}

function assertObject(v: unknown, message: string): asserts v is Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(message);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function validateTasksPlanInput(input: unknown): asserts input is TasksPlanInput {
	assertObject(input, "tasks_plan params must be an object.");
	const record = input as Record<string, unknown>;
	assertString(record.batchName, "tasks_plan.batchName must be a non-empty string.");
	assertString(record.promptTemplate, "tasks_plan.promptTemplate must be a non-empty string.");
	if (Buffer.byteLength(record.promptTemplate as string, "utf-8") > MAX_PLAN_PROMPT_TEMPLATE_BYTES) {
		throw new Error(`tasks_plan.promptTemplate exceeds ${MAX_PLAN_PROMPT_TEMPLATE_BYTES} bytes; shrink the template.`);
	}
	const matrix = record.matrix;
	if (!Array.isArray(matrix) || matrix.length === 0) throw new Error("tasks_plan.matrix must be a non-empty array.");
	if (matrix.length > MAX_PLAN_ROWS) throw new Error(`tasks_plan.matrix has ${matrix.length} rows; max is ${MAX_PLAN_ROWS}.`);
	const seen = new Set<string>();
	for (const [i, rowValue] of matrix.entries()) {
		assertObject(rowValue, `tasks_plan.matrix[${i}] must be an object.`);
		const row = rowValue as Record<string, unknown>;
		assertString(row.id, `tasks_plan.matrix[${i}].id must be a non-empty string.`);
		const id = (row.id as string).trim();
		if (!SAFE_ID_RE.test(id)) throw new Error(`tasks_plan.matrix[${i}].id must use only letters, numbers, dot, underscore, or dash.`);
		if (seen.has(id)) throw new Error(`tasks_plan.matrix has duplicate id: ${id}`);
		seen.add(id);
		if (row.name !== undefined && (typeof row.name !== "string" || !(row.name as string).trim())) {
			throw new Error(`tasks_plan.matrix[${i}].name must be a non-empty string when provided.`);
		}
		if (row.cwd !== undefined && typeof row.cwd !== "string") {
			throw new Error(`tasks_plan.matrix[${i}].cwd must be a string when provided.`);
		}
		if (row.vars !== undefined) {
			assertObject(row.vars, `tasks_plan.matrix[${i}].vars must be an object.`);
			for (const [k, v] of Object.entries(row.vars as Record<string, unknown>)) {
				if (typeof v !== "string" && !isStringArray(v)) {
					throw new Error(`tasks_plan.matrix[${i}].vars.${k} must be a string or array of strings.`);
				}
			}
		}
	}
	if (record.concurrency !== undefined) {
		if (!Number.isInteger(record.concurrency) || (record.concurrency as number) < 1) {
			throw new Error("tasks_plan.concurrency must be a positive integer when provided.");
		}
	}
	const totalBytes = Buffer.byteLength(JSON.stringify(input), "utf-8");
	if (totalBytes > MAX_PLAN_TOTAL_INPUT_BYTES) {
		throw new Error(`tasks_plan input is ${totalBytes} bytes (limit ${MAX_PLAN_TOTAL_INPUT_BYTES}). Trim per-row vars or shrink the prompt template.`);
	}
}

function rowContext(row: TasksPlanRow): Ctx {
	const ctx: Ctx = { id: row.id };
	if (row.name !== undefined) ctx.name = row.name;
	if (row.cwd !== undefined) ctx.cwd = row.cwd;
	if (row.vars) {
		for (const [k, v] of Object.entries(row.vars)) ctx[k] = v;
	}
	return ctx;
}

function joinValue(value: string | string[]): string {
	return Array.isArray(value) ? value.join("\n") : value;
}

function substitute(template: string, ctx: Ctx, rowId: string, fieldLabel: string): string {
	return template.replace(TEMPLATE_RE, (_match, key) => {
		if (!(key in ctx)) {
			throw new Error(`tasks_plan.${fieldLabel} references unknown variable {{${key}}} for row ${rowId}.`);
		}
		return joinValue(ctx[key]!);
	});
}

function expandStringArray(arr: string[] | undefined, ctx: Ctx, rowId: string, fieldLabel: string): string[] | undefined {
	if (!arr) return undefined;
	const out: string[] = [];
	for (const entry of arr) {
		const solo = SOLO_TEMPLATE_RE.exec(entry);
		if (solo && solo[1] && Array.isArray(ctx[solo[1]])) {
			out.push(...(ctx[solo[1]] as string[]));
			continue;
		}
		out.push(substitute(entry, ctx, rowId, fieldLabel));
	}
	return out;
}

function expandPathChecks(arr: Array<string | PathCheck> | undefined, ctx: Ctx, rowId: string, fieldLabel: string): Array<string | PathCheck> | undefined {
	if (!arr) return undefined;
	const out: Array<string | PathCheck> = [];
	for (const entry of arr) {
		if (typeof entry === "string") {
			const solo = SOLO_TEMPLATE_RE.exec(entry);
			if (solo && solo[1] && Array.isArray(ctx[solo[1]])) {
				for (const item of ctx[solo[1]] as string[]) out.push(item);
				continue;
			}
			out.push(substitute(entry, ctx, rowId, fieldLabel));
			continue;
		}
		const check: PathCheck = {
			...entry,
			path: substitute(entry.path, ctx, rowId, `${fieldLabel}.path`),
		};
		const requiredRegex = expandStringArray(entry.requiredRegex, ctx, rowId, `${fieldLabel}.requiredRegex`);
		const forbiddenRegex = expandStringArray(entry.forbiddenRegex, ctx, rowId, `${fieldLabel}.forbiddenRegex`);
		if (requiredRegex) check.requiredRegex = requiredRegex;
		if (forbiddenRegex) check.forbiddenRegex = forbiddenRegex;
		out.push(check);
	}
	return out;
}

function expandAcceptance(template: AcceptanceContract | undefined, ctx: Ctx, rowId: string): AcceptanceContract | undefined {
	if (!template) return undefined;
	const out: AcceptanceContract = {};
	if (template.requiredPaths) out.requiredPaths = expandPathChecks(template.requiredPaths, ctx, rowId, "acceptanceTemplate.requiredPaths");
	if (template.forbiddenPaths) out.forbiddenPaths = expandStringArray(template.forbiddenPaths, ctx, rowId, "acceptanceTemplate.forbiddenPaths");
	if (template.requiredOutputRegex) out.requiredOutputRegex = expandStringArray(template.requiredOutputRegex, ctx, rowId, "acceptanceTemplate.requiredOutputRegex");
	if (template.forbiddenOutputRegex) out.forbiddenOutputRegex = expandStringArray(template.forbiddenOutputRegex, ctx, rowId, "acceptanceTemplate.forbiddenOutputRegex");
	if (template.requiredReportRegex) out.requiredReportRegex = expandStringArray(template.requiredReportRegex, ctx, rowId, "acceptanceTemplate.requiredReportRegex");
	if (template.forbiddenReportRegex) out.forbiddenReportRegex = expandStringArray(template.forbiddenReportRegex, ctx, rowId, "acceptanceTemplate.forbiddenReportRegex");
	if (template.allowedWritePaths) out.allowedWritePaths = expandStringArray(template.allowedWritePaths, ctx, rowId, "acceptanceTemplate.allowedWritePaths");
	if (template.forbiddenWritePaths) out.forbiddenWritePaths = expandStringArray(template.forbiddenWritePaths, ctx, rowId, "acceptanceTemplate.forbiddenWritePaths");
	if (template.minWorkerLogBytes !== undefined) out.minWorkerLogBytes = template.minWorkerLogBytes;
	if (template.minReportSummaryChars !== undefined) out.minReportSummaryChars = template.minReportSummaryChars;
	if (template.requireDeliverablesEvidence !== undefined) out.requireDeliverablesEvidence = template.requireDeliverablesEvidence;
	if (template.auditOnly !== undefined) out.auditOnly = template.auditOnly;
	return out;
}

function expandMetadata(input: TasksPlanInput, ctx: Ctx, rowId: string): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	if (input.metadataTemplate) {
		for (const [k, v] of Object.entries(input.metadataTemplate)) {
			out[k] = substitute(v, ctx, rowId, `metadataTemplate.${k}`);
		}
	}
	out["tasks_plan.row_id"] = rowId;
	out["tasks_plan.batch_name"] = input.batchName;
	return out;
}

export function expandTasksPlan(input: TasksPlanInput): ExpandedTasksPlan {
	validateTasksPlanInput(input);
	const tasks: TaskSpecInput[] = [];
	const taskNames: string[] = [];
	const rowIds: string[] = [];
	for (const row of input.matrix) {
		const ctx = rowContext(row);
		const rowId = row.id;
		const prompt = substitute(input.promptTemplate, ctx, rowId, "promptTemplate");
		const name = row.name?.trim()
			|| (input.nameTemplate ? substitute(input.nameTemplate, ctx, rowId, "nameTemplate") : `${input.batchName} ${rowId}`);
		const cwd = row.cwd
			?? (input.cwdTemplate ? substitute(input.cwdTemplate, ctx, rowId, "cwdTemplate") : undefined);
		const acceptance = expandAcceptance(input.acceptanceTemplate, ctx, rowId);
		const metadata = expandMetadata(input, ctx, rowId);
		const task: TaskSpecInput = { id: rowId, name, prompt };
		if (cwd !== undefined) task.cwd = cwd;
		if (acceptance) task.acceptance = acceptance;
		if (metadata) task.metadata = metadata;
		tasks.push(task);
		taskNames.push(name);
		rowIds.push(rowId);
	}
	const params: TasksToolParams = { tasks };
	if (input.concurrency !== undefined) params.concurrency = input.concurrency;
	if (input.retry) params.retry = input.retry;
	if (input.throttle) params.throttle = input.throttle;
	if (input.acceptanceDefaults) params.acceptanceDefaults = input.acceptanceDefaults;
	if (input.parentBatchId) params.parentBatchId = input.parentBatchId;
	if (input.rerunOfTaskIds) params.rerunOfTaskIds = input.rerunOfTaskIds;
	return { params, taskNames, rowIds };
}

export interface PlanArtifactPayload {
	schemaVersion: 1;
	source: "tasks_plan";
	batchId: string;
	batchName: string;
	rowIds: string[];
	taskNames: string[];
	concurrency?: number;
	promptTemplate: string;
	nameTemplate?: string;
	cwdTemplate?: string;
	acceptanceTemplate?: AcceptanceContract;
	metadataTemplate?: Record<string, string>;
	matrix: TasksPlanRow[];
	synthesis?: TasksPlanSynthesis;
}

export async function writePlanArtifact(batchDir: string, batchId: string, input: TasksPlanInput, expansion: ExpandedTasksPlan): Promise<string> {
	const payload: PlanArtifactPayload = {
		schemaVersion: 1,
		source: "tasks_plan",
		batchId,
		batchName: input.batchName,
		rowIds: expansion.rowIds,
		taskNames: expansion.taskNames,
		concurrency: input.concurrency,
		promptTemplate: input.promptTemplate,
		nameTemplate: input.nameTemplate,
		cwdTemplate: input.cwdTemplate,
		acceptanceTemplate: input.acceptanceTemplate,
		metadataTemplate: input.metadataTemplate,
		matrix: input.matrix,
		synthesis: input.synthesis,
	};
	const planPath = path.join(batchDir, "plan.json");
	await fs.writeFile(planPath, JSON.stringify(payload, null, 2), "utf-8");
	return planPath;
}

export function buildPlanStartingText(input: TasksPlanInput, expansion: ExpandedTasksPlan, cwd: string): string {
	const total = expansion.rowIds.length;
	return [
		`TASKS plan starting: ${input.batchName} · preparing ${total} task${total === 1 ? "" : "s"}`,
		`Cwd: ${cwd}`,
		`Rows: ${expansion.rowIds.slice(0, 8).join(", ")}${total > 8 ? `, … (+${total - 8} more)` : ""}`,
		"Next: creating batch artifacts and launching workers",
	].join("\n");
}

export function decoratePlanResultText(baseText: string, planPath: string, input: TasksPlanInput): string {
	const extras: string[] = [];
	extras.push(`Plan: ${planPath}`);
	if (input.synthesis?.instructions) {
		extras.push(`Next: synthesize per plan synthesis instructions (mode=${input.synthesis.mode ?? "parent"}).`);
	}
	return [baseText, ...extras].join("\n");
}
