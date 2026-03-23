/**
 * Tasks extension.
 *
 * Root-only parallel task workers with optional task names and generated timestamped ids.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { copyToClipboard, getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { registerTasksStartCommand } from "./commands.ts";
import { extractDisplayItems, extractFinalOutput } from "./task-output.ts";
import {
	executeTasksRunFlow,
	resolveCompletedRunStatus,
	toPersistedDetails,
	type DisplayItem,
	type LiveTaskResult,
	type NormalizedTaskSpec,
	type OnUpdateCallback,
	type PersistedTaskResult,
	type RunStatus,
	type TaskRunRecord,
	type TasksDetails,
	type TasksSummary,
	type TasksToolParams,
	type TaskStatus,
	type UsageStats,
} from "./run-tasks.ts";

const MAX_TASKS = 100;
const MAX_CONCURRENCY = 20;
const COLLAPSED_ITEM_COUNT = 8;
const TASK_RUN_RECORD_TYPE = "tasks-run-record";
const MAX_RECENT_RUNS = 12;
const TASK_UI_LIST_WINDOW = 10;
const WORKER_SYSTEM_PROMPT = [
	"You are an isolated task worker spawned by the current root agent.",
	"Complete the assigned task directly — you may read, write, edit, and run commands as needed.",
	"Do not attempt to delegate work to other agents or tasks.",
	"",
	"IMPORTANT — Output file:",
	"An output file has been pre-created for you (path given in the task prompt).",
	"Use the write tool to save your findings, results, and any valuable information to this file.",
	"You may write to it at any point during your work — not just at the end.",
	"Write whenever you have meaningful results to persist. Overwrite or append as you see fit.",
	"When you are done, ensure the output file contains a complete, well-structured record of your work.",
].join("\n");
const pendingAbortTaskIds = new Set<string>();


function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function shortenText(text: string, max = 72): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= max) return singleLine;
	return `${singleLine.slice(0, Math.max(0, max - 3))}...`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatTimestamp(timestamp: number | undefined): string {
	if (!timestamp) return "-";
	return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(startedAt: number, finishedAt?: number): string {
	const end = finishedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function canonicalTaskLabel(task: Pick<NormalizedTaskSpec, "id" | "name">): string {
	return task.name ? `${task.name} · ${task.id}` : `task · ${task.id}`;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: string, text: string) => string,
): string {
	const shortenPath = (value: string) => {
		const home = os.homedir();
		return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		default: {
			const argsJson = JSON.stringify(args);
			const preview = argsJson.length > 50 ? `${argsJson.slice(0, 50)}...` : argsJson;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}


function getResultError(result: LiveTaskResult): string | undefined {
	if (result.status === "aborted") return "Task was aborted.";
	if (result.status !== "error") return undefined;
	return result.errorMessage || result.stderr.trim() || extractFinalOutput(result.messages) || "Task failed before producing output.";
}

function getResultPreview(result: PersistedTaskResult): string {
	if (result.status === "running") return "(running...)";
	if (result.status === "queued") return "(queued)";
	if (result.status === "aborted") return result.error || "Task was aborted.";
	if (result.status === "error") return result.error || "Task failed.";
	return result.output || "(no output)";
}

function getRunStatus(summary: TasksSummary): RunStatus {
	if (summary.running > 0 || summary.queued > 0) return "running";
	return resolveCompletedRunStatus(summary);
}

function buildRunDetail(summary: TasksSummary, startedAt: number, finishedAt?: number): string {
	if (summary.running > 0 || summary.queued > 0) {
		const done = summary.success + summary.error + summary.aborted;
		return `${done}/${summary.total} done, ${summary.running} running${summary.queued > 0 ? `, ${summary.queued} queued` : ""}`;
	}

	const duration = formatDuration(startedAt, finishedAt);
	const parts: string[] = [];
	if (summary.success) parts.push(`${summary.success} success`);
	if (summary.error) parts.push(`${summary.error} error`);
	if (summary.aborted) parts.push(`${summary.aborted} aborted`);
	if (parts.length === 0) parts.push("0 finished");
	return `${parts.join(", ")} in ${duration}`;
}

function aggregateUsage(results: Array<{ usage: UsageStats }>): UsageStats {
	const total = emptyUsage();
	for (const entry of results) {
		total.input += entry.usage.input;
		total.output += entry.usage.output;
		total.cacheRead += entry.usage.cacheRead;
		total.cacheWrite += entry.usage.cacheWrite;
		total.cost += entry.usage.cost;
		total.contextTokens += entry.usage.contextTokens;
		total.turns += entry.usage.turns;
	}
	return total;
}




function buildPromptText(record: TaskRunRecord): string {
	if (!record.params?.tasks?.length) return "No runnable task payload stored for this run.";
	const lines: string[] = [];
	lines.push(`tasks: ${record.params.tasks.length}`);
	lines.push(`cwd: ${record.cwd}`);
	lines.push("");
	for (let index = 0; index < record.params.tasks.length; index++) {
		const task = record.params.tasks[index];
		const identity = record.tasks[index];
		lines.push(`task ${index + 1}: ${task.name ?? "(unnamed)"}`);
		if (identity?.id) lines.push(`id: ${identity.id}`);
		if (task.cwd) lines.push(`cwd: ${task.cwd}`);
		lines.push("prompt:");
		lines.push(task.task);
		if (index < record.params.tasks.length - 1) lines.push("");
	}
	return lines.join("\n");
}



function summarizeCompletedRun(
	run: TaskRunRecord,
	details: TasksDetails,
): TaskRunRecord {
	const finishedAt = Date.now();
	const detail = buildRunDetail(details.summary, run.startedAt, finishedAt);
	return {
		...run,
		status: getRunStatus(details.summary),
		finishedAt,
		detail,
		details: toPersistedDetails(details),
	};
}

function buildWorkerPrompt(task: NormalizedTaskSpec): string {
	const lines: string[] = [];
	lines.push(`Output file: ${task.outputPath}`);
	if (task.name) lines.push(`Task name: ${task.name}`);
	lines.push("Task:");
	lines.push(task.task);
	return lines.join("\n\n");
}

function writePromptToTempFile(prefix: string, prompt: string): { dir: string; filePath: string } {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-tasks-${prefix}-`));
	const safePrefix = prefix.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tempDir, `${safePrefix}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tempDir, filePath };
}


async function runSingleTask(
	task: NormalizedTaskSpec,
	signal: AbortSignal | undefined,
	onUpdate: ((result: LiveTaskResult) => void) | undefined,
	fallbackModel: string | undefined,
	fallbackThinking: string | undefined,
): Promise<LiveTaskResult> {
	const workerSystem = writePromptToTempFile(`system-${task.id}`, WORKER_SYSTEM_PROMPT);
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (fallbackModel) args.push("--model", fallbackModel);
	if (fallbackThinking) args.push("--thinking", fallbackThinking);
	args.push("--append-system-prompt", workerSystem.filePath, buildWorkerPrompt(task));

	const currentResult: LiveTaskResult = {
		...task,
		status: "running",
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: fallbackModel,
	};
	let wasAborted = false;

	const emitUpdate = () => {
		onUpdate?.({
			...currentResult,
			messages: [...currentResult.messages],
			usage: { ...currentResult.usage },
		});
	};

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: task.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_CHILD_TYPE: "task" },
			});
			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					currentResult.messages.push(message);

					if (message.role === "assistant") {
						currentResult.usage.turns++;
						const usage = message.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && message.model) currentResult.model = message.model;
						if (message.stopReason) currentResult.stopReason = message.stopReason;
						if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			let procExited = false;

			proc.on("close", (code) => {
				procExited = true;
				if (buffer.trim()) processLine(buffer);
				// code is null when killed by signal — treat as error exit
				// wasAborted is only set by our killProc, not by external signals
				resolve(code ?? 1);
			});

			proc.on("error", (error) => {
				currentResult.stderr += error.message;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						// proc.killed only means "signal was sent", not "process exited"
						if (!procExited) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted || currentResult.stopReason === "aborted") {
			currentResult.status = "aborted";
		} else if (exitCode === 0 && currentResult.stopReason !== "error") {
			currentResult.status = "success";
		} else {
			currentResult.status = "error";
		}
		emitUpdate();
		return currentResult;
	} finally {
		try {
			fs.rmSync(workerSystem.dir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup failures.
		}
	}
}


function parseTasksUICommandArgs(rawArgs: unknown): { mode: "dashboard" | "show" | "abort"; id?: string } {
	const trimmed = String(rawArgs ?? "").trim();
	if (!trimmed) return { mode: "dashboard" };
	const abortMatch = trimmed.match(/^abort\s+(\d{14}-.+)$/i);
	if (abortMatch) return { mode: "abort", id: abortMatch[1] };
	const showMatch = trimmed.match(/^(\d{14}-.+)$/);
	if (showMatch) return { mode: "show", id: showMatch[1] };
	return { mode: "dashboard" };
}

function makeResultSnippet(result: PersistedTaskResult): string {
	return shortenText(getResultPreview(result), 120);
}

class TaskDashboardComponent {
	private readonly getRuns: () => { activeRuns: TaskRunRecord[]; recentRuns: TaskRunRecord[] };
	private readonly getViewportRows: () => number;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private readonly onRerun: (record: TaskRunRecord) => void;
	private readonly onCopyPrompt: (record: TaskRunRecord) => void;
	private readonly onPastePrompt: (record: TaskRunRecord) => void;
	private readonly onAbortTask: (taskId: string) => void;
	private selectedIndex: number;
	private mode: "dashboard" | "detail" = "dashboard";
	private detailScroll = 0;

	constructor(
		getRuns: () => { activeRuns: TaskRunRecord[]; recentRuns: TaskRunRecord[] },
		getViewportRows: () => number,
		theme: Theme,
		actions: {
			onClose: () => void;
			onRerun: (record: TaskRunRecord) => void;
			onCopyPrompt: (record: TaskRunRecord) => void;
			onPastePrompt: (record: TaskRunRecord) => void;
			onAbortTask: (taskId: string) => void;
			initialTaskId?: string;
		},
	) {
		this.getRuns = getRuns;
		this.getViewportRows = getViewportRows;
		this.theme = theme;
		this.onClose = actions.onClose;
		this.onRerun = actions.onRerun;
		this.onCopyPrompt = actions.onCopyPrompt;
		this.onPastePrompt = actions.onPastePrompt;
		this.onAbortTask = actions.onAbortTask;
		this.selectedIndex = this.findInitialSelection(actions.initialTaskId);
		if (actions.initialTaskId) this.mode = "detail";
	}

	private findInitialSelection(taskId: string | undefined): number {
		if (!taskId) return 0;
		const items = this.getItems();
		const index = items.findIndex((item) => item.record.tasks.some((task) => task.id === taskId));
		return index >= 0 ? index : 0;
	}

	private getItems(): Array<{ kind: "active" | "recent"; record: TaskRunRecord }> {
		const { activeRuns, recentRuns } = this.getRuns();
		const items = [
			...activeRuns.map((record) => ({ kind: "active" as const, record })),
			...recentRuns.map((record) => ({ kind: "recent" as const, record })),
		];
		if (items.length === 0) this.selectedIndex = 0;
		else if (this.selectedIndex >= items.length) this.selectedIndex = items.length - 1;
		else if (this.selectedIndex < 0) this.selectedIndex = 0;
		return items;
	}

	private getSelectedRecord(): TaskRunRecord | undefined {
		return this.getItems()[this.selectedIndex]?.record;
	}

	private moveSelection(delta: number): void {
		const items = this.getItems();
		if (items.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex + delta));
		this.detailScroll = 0;
		this.invalidate();
	}

	private renderRunStatus(status: RunStatus): string {
		if (status === "running") return this.theme.fg("warning", "RUN");
		if (status === "success") return this.theme.fg("success", "OK");
		if (status === "aborted") return this.theme.fg("warning", "ABT");
		return this.theme.fg("error", "ERR");
	}

	private renderTaskStatus(status: TaskStatus): string {
		if (status === "queued") return this.theme.fg("dim", "QUE");
		if (status === "running") return this.theme.fg("warning", "RUN");
		if (status === "success") return this.theme.fg("success", "OK");
		if (status === "aborted") return this.theme.fg("warning", "ABT");
		return this.theme.fg("error", "ERR");
	}

	private renderColumns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
		const divider = this.theme.fg("border", " | ");
		const lineCount = Math.max(left.length, right.length);
		const lines: string[] = [];
		for (let index = 0; index < lineCount; index++) {
			const leftLine = truncateToWidth(left[index] ?? "", leftWidth, "...", true);
			const rightLine = truncateToWidth(right[index] ?? "", rightWidth);
			lines.push(leftLine + divider + rightLine);
		}
		return lines;
	}

	private appendWrapped(lines: string[], text: string, width: number, indent = ""): void {
		for (const line of wrapTextWithAnsi(text, Math.max(10, width - visibleWidth(indent)))) {
			lines.push(indent + line);
		}
	}

	private buildListLines(items: Array<{ kind: "active" | "recent"; record: TaskRunRecord }>, width: number): string[] {
		const rows = Math.max(18, this.getViewportRows());
		const lines: string[] = [];
		const visibleItems = Math.max(4, Math.min(items.length || 1, Math.floor((rows - 8) / 2), TASK_UI_LIST_WINDOW));
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visibleItems / 2), Math.max(0, items.length - visibleItems)));
		const end = Math.min(items.length, start + visibleItems);

		lines.push(this.theme.fg("accent", this.theme.bold(" Tasks ")));
		lines.push(this.theme.fg("muted", `${items.filter((item) => item.kind === "active").length} active | ${items.filter((item) => item.kind === "recent").length} recent`));
		lines.push("");

		if (items.length === 0) {
			lines.push(this.theme.fg("dim", "No task runs yet in this branch."));
			lines.push(this.theme.fg("dim", "Run the tasks tool, then reopen /tasks."));
			lines.push("");
			lines.push(this.theme.fg("muted", "Keys: Esc close"));
			return lines.map((line) => truncateToWidth(line, width));
		}

		for (let index = start; index < end; index++) {
			const item = items[index];
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", ">") : this.theme.fg("dim", " ");
			const kind = item.kind === "active" ? this.theme.fg("warning", "now") : this.theme.fg("muted", "last");
			const header = `${prefix} ${this.renderRunStatus(item.record.status)} ${kind} ${this.theme.fg("text", item.record.title)}`;
			const meta = `  ${formatTimestamp(item.record.finishedAt ?? item.record.startedAt)} | ${item.record.detail}`;
			lines.push(truncateToWidth(header, width));
			lines.push(truncateToWidth(this.theme.fg(selected ? "text" : "muted", meta), width));
		}

		if (start > 0) lines.splice(3, 0, truncateToWidth(this.theme.fg("dim", `... ${start} earlier`), width));
		if (end < items.length) lines.push(truncateToWidth(this.theme.fg("dim", `... ${items.length - end} more`), width));
		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("dim", "Up/Down select | Enter open | r rerun | c copy | p paste"), width));
		lines.push(truncateToWidth(this.theme.fg("dim", "a abort first running task | Esc close | In detail: Up/Down scroll"), width));
		return lines;
	}

	private buildPreviewLines(record: TaskRunRecord | undefined, width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold(" Preview ")));
		if (!record) {
			lines.push(this.theme.fg("dim", "Select a task run to preview it."));
			return lines.map((line) => truncateToWidth(line, width));
		}

		lines.push(`${this.renderRunStatus(record.status)} ${this.theme.fg("text", record.title)}`);
		lines.push(this.theme.fg("muted", `${record.cwd}`));
		lines.push(this.theme.fg("muted", `${record.detail} | started ${formatTimestamp(record.startedAt)}`));
		lines.push("");
		lines.push(this.theme.fg("accent", "Tasks"));
		const results = record.details?.results;
		for (let index = 0; index < record.tasks.slice(0, 4).length; index++) {
			const task = record.tasks[index];
			const result = results?.find((item) => item.id === task.id);
			lines.push(`${this.renderTaskStatus(result?.status ?? "queued")} ${this.theme.fg("accent", canonicalTaskLabel(task))}`);
			this.appendWrapped(lines, this.theme.fg("muted", `  ${shortenText(result ? getResultPreview(result) : task.task, 100)}`), width);
		}
		if (record.tasks.length > 4) lines.push(this.theme.fg("dim", `  ... ${record.tasks.length - 4} more task(s)`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private buildDetailLines(record: TaskRunRecord, width: number): string[] {
		const rows = Math.max(18, this.getViewportRows());
		const headerLines = [
			`${this.renderRunStatus(record.status)} ${this.theme.fg("accent", this.theme.bold(record.title))}`,
			this.theme.fg("muted", `${record.cwd}`),
			this.theme.fg("dim", `Started ${formatTimestamp(record.startedAt)}${record.finishedAt ? ` | Finished ${formatTimestamp(record.finishedAt)}` : ""} | ${record.detail}`),
			"",
		];
		const body: string[] = [];
		body.push(this.theme.fg("accent", "Prompt"));
		this.appendWrapped(body, buildPromptText(record), width, "  ");
		body.push("");
		body.push(this.theme.fg("accent", "Result Details"));
		if (!record.details || record.details.results.length === 0) {
			body.push(this.theme.fg("dim", "  No result details captured yet."));
		} else {
			for (const result of record.details.results) {
				body.push(`${this.renderTaskStatus(result.status)} ${this.theme.fg("accent", canonicalTaskLabel(result))}`);
				body.push(this.theme.fg("muted", `  task: ${shortenText(result.task, 120)}`));
				for (const item of result.displayItems.slice(-COLLAPSED_ITEM_COUNT)) {
					if (item.type === "toolCall") this.appendWrapped(body, this.theme.fg("muted", `  > ${formatToolCall(item.name, item.args, this.theme.fg.bind(this.theme))}`), width);
				}
				this.appendWrapped(body, this.theme.fg("text", getResultPreview(result)), width, "  ");
				const usage = formatUsageStats(result.usage, result.model);
				if (usage) body.push(this.theme.fg("dim", `  ${usage}`));
				body.push("");
			}
			const usage = formatUsageStats(aggregateUsage(record.details.results));
			if (usage) body.push(this.theme.fg("dim", `Total: ${usage}`));
		}

		const footer = ["", this.theme.fg("dim", "Up/Down/PageUp/PageDown scroll | Left/Esc back | r rerun | c copy | p paste | a abort")];
		const bodyHeight = Math.max(8, rows - headerLines.length - footer.length - 2);
		const maxScroll = Math.max(0, body.length - bodyHeight);
		if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;
		const visibleBody = body.slice(this.detailScroll, this.detailScroll + bodyHeight);
		const scrollInfo = maxScroll > 0 ? this.theme.fg("muted", `Scroll ${this.detailScroll + 1}-${Math.min(body.length, this.detailScroll + bodyHeight)} / ${body.length}`) : this.theme.fg("muted", `Lines ${body.length}`);
		return [...headerLines, scrollInfo, ...visibleBody, ...footer].map((line) => truncateToWidth(line, width));
	}

	private abortFirstRunningTask(record: TaskRunRecord | undefined): void {
		if (!record?.details?.results) return;
		const target = record.details.results.find((result) => result.status === "running" || result.status === "queued");
		if (target) this.onAbortTask(target.id);
	}

	handleInput(data: string): void {
		const selected = this.getSelectedRecord();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.mode === "detail") {
				this.mode = "dashboard";
				this.detailScroll = 0;
				this.invalidate();
				return;
			}
			this.onClose();
			return;
		}
		if ((matchesKey(data, "left") || matchesKey(data, "backspace") || data === "h") && this.mode === "detail") {
			this.mode = "dashboard";
			this.detailScroll = 0;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "right") || data === "o" || data === "l") {
			if (selected) {
				this.mode = "detail";
				this.detailScroll = 0;
				this.invalidate();
			}
			return;
		}
		if (data === "r") {
			if (selected) this.onRerun(selected);
			return;
		}
		if (data === "c") {
			if (selected) this.onCopyPrompt(selected);
			return;
		}
		if (data === "p") {
			if (selected) this.onPastePrompt(selected);
			return;
		}
		if (data === "a") {
			this.abortFirstRunningTask(selected);
			return;
		}

		if (this.mode === "detail") {
			if (matchesKey(data, "up") || data === "k") this.detailScroll = Math.max(0, this.detailScroll - 1);
			else if (matchesKey(data, "down") || data === "j") this.detailScroll += 1;
			else if (matchesKey(data, "pageup")) this.detailScroll = Math.max(0, this.detailScroll - 8);
			else if (matchesKey(data, "pagedown")) this.detailScroll += 8;
			else if (matchesKey(data, "home")) this.detailScroll = 0;
			else if (matchesKey(data, "end")) this.detailScroll = Number.MAX_SAFE_INTEGER;
			this.invalidate();
			return;
		}

		if (matchesKey(data, "up") || data === "k") this.moveSelection(-1);
		else if (matchesKey(data, "down") || data === "j") this.moveSelection(1);
		else if (matchesKey(data, "pageup")) this.moveSelection(-5);
		else if (matchesKey(data, "pagedown")) this.moveSelection(5);
		else if (matchesKey(data, "home")) {
			this.selectedIndex = 0;
			this.invalidate();
		} else if (matchesKey(data, "end")) {
			this.selectedIndex = Math.max(0, this.getItems().length - 1);
			this.invalidate();
		}
	}

	render(width: number): string[] {
		const items = this.getItems();
		const selected = items[this.selectedIndex]?.record;
		if (this.mode === "detail" && selected) {
			return this.buildDetailLines(selected, width);
		}
		if (width >= 110) {
			const leftWidth = Math.max(34, Math.floor(width * 0.42));
			const rightWidth = Math.max(24, width - leftWidth - 3);
			return this.renderColumns(this.buildListLines(items, leftWidth), this.buildPreviewLines(selected, rightWidth), leftWidth, rightWidth);
		}
		return [...this.buildListLines(items, width), "", ...this.buildPreviewLines(selected, width)];
	}

	invalidate(): void {
		// No-op. The dashboard renders from live state each frame to avoid stale panels.
	}
}

const TaskItemSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Optional human-readable name for the task" })),
	task: Type.String({ description: "Task prompt for this worker" }),
	cwd: Type.Optional(Type.String({ description: "Optional working directory override for this task" })),
});

const TaskParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Optional human-readable name for the task" })),
	task: Type.String({ description: "Task prompt for this worker" }),
	cwd: Type.Optional(Type.String({ description: "Optional working directory override for this task" })),
});

const TasksParams = Type.Object({
	tasks: Type.Array(TaskItemSchema, {
		description: "Array of task specs to launch in parallel.",
		minItems: 1,
		maxItems: MAX_TASKS,
	}),
});

export default function taskExtension(pi: ExtensionAPI) {
	if (process.env.PI_CHILD_TYPE) return;

	registerTasksStartCommand(pi);

	let activeRuns: TaskRunRecord[] = [];
	let recentRuns: TaskRunRecord[] = [];
	const dashboardRenderers = new Set<() => void>();
	const activeTaskControllers = new Map<string, AbortController>();

	const notifyDashboards = () => {
		for (const render of dashboardRenderers) render();
	};

	const updateTaskUI = (ctx: ExtensionContext) => {
		const visibleRecentRuns = [...recentRuns]
			.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
			.slice(0, 5);

		if (activeRuns.length === 0 && visibleRecentRuns.length === 0) {
			ctx.ui.setStatus("tasks-ui", undefined);
			ctx.ui.setWidget("tasks-ui", undefined);
			notifyDashboards();
			return;
		}

		if (activeRuns.length > 0) {
			const runningTasks = activeRuns.reduce((sum, run) => sum + (run.details?.summary.running ?? run.tasks.length), 0);
			ctx.ui.setStatus("tasks-ui", ctx.ui.theme.fg("warning", `tasks ${runningTasks} running`));
		} else if (visibleRecentRuns[0]?.status === "error") {
			ctx.ui.setStatus("tasks-ui", ctx.ui.theme.fg("error", "tasks last err"));
		} else if (visibleRecentRuns[0]?.status === "aborted") {
			ctx.ui.setStatus("tasks-ui", ctx.ui.theme.fg("warning", "tasks last abt"));
		} else {
			ctx.ui.setStatus("tasks-ui", ctx.ui.theme.fg("success", `tasks ${visibleRecentRuns.length} recent`));
		}

		ctx.ui.setWidget("tasks-ui", undefined);
		notifyDashboards();
	};

	const restoreTaskHistory = async (ctx: ExtensionContext) => {
		// Preserve currently active runs so in-flight tasks can still finalize
		const currentlyActive = new Set(activeRuns.map((r) => r.id));

		const restored: TaskRunRecord[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== TASK_RUN_RECORD_TYPE) continue;
			const data = entry.data as TaskRunRecord | undefined;
			if (!data?.id) continue;
			// Don't restore records for runs that are still active
			if (!currentlyActive.has(data.id)) restored.push(data);
		}

		recentRuns = restored
			.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
			.slice(0, MAX_RECENT_RUNS);
		updateTaskUI(ctx);
	};

	const startRun = (run: TaskRunRecord, ctx: ExtensionContext) => {
		activeRuns = [run, ...activeRuns.filter((item) => item.id !== run.id)];
		updateTaskUI(ctx);
	};

	const patchRun = (runId: string, patch: Partial<TaskRunRecord>, ctx: ExtensionContext) => {
		activeRuns = activeRuns.map((item) => (item.id === runId ? { ...item, ...patch } : item));
		updateTaskUI(ctx);
	};

	const finishRun = (
		runId: string,
		details: TasksDetails,
		ctx: ExtensionContext,
	) => {
		const current = activeRuns.find((item) => item.id === runId);
		if (!current) return;
		const record = summarizeCompletedRun(current, details);
		activeRuns = activeRuns.filter((item) => item.id !== runId);
		recentRuns = [record, ...recentRuns.filter((item) => item.id !== runId)].slice(0, MAX_RECENT_RUNS);
		pi.appendEntry(TASK_RUN_RECORD_TYPE, record);
		updateTaskUI(ctx);
	};

	const failRun = (runId: string, detail: string, ctx: ExtensionContext) => {
		const current = activeRuns.find((item) => item.id === runId);
		if (!current) return;
		const record: TaskRunRecord = {
			...current,
			status: "error",
			finishedAt: Date.now(),
			detail: shortenText(detail, 80),
		};
		activeRuns = activeRuns.filter((item) => item.id !== runId);
		recentRuns = [record, ...recentRuns.filter((item) => item.id !== runId)].slice(0, MAX_RECENT_RUNS);
		pi.appendEntry(TASK_RUN_RECORD_TYPE, record);
		updateTaskUI(ctx);
	};

	const findRunForTaskId = (taskId: string): TaskRunRecord | undefined =>
		[...activeRuns, ...recentRuns].find((record) => record.tasks.some((task) => task.id === taskId));

	const abortTaskById = (taskId: string, ctx: ExtensionContext): boolean => {
		const record = activeRuns.find((run) => run.tasks.some((task) => task.id === taskId));
		if (!record) return false;
		const result = record.details?.results.find((item) => item.id === taskId);
		if (result && result.status !== "queued" && result.status !== "running") return false;
		pendingAbortTaskIds.add(taskId);
		const controller = activeTaskControllers.get(taskId);
		if (controller) controller.abort();
		ctx.ui.notify(`Aborting ${taskId}...`, "info");
		return true;
	};

	const openDashboard = async (ctx: ExtensionContext, initialTaskId?: string) => {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Active runs: ${activeRuns.length}, recent runs: ${recentRuns.length}`, "info");
			return;
		}

		const rerunRecord = async (record: TaskRunRecord) => {
			if (!record.params?.tasks?.length) {
				ctx.ui.notify("This task run does not have runnable params saved.", "warning");
				return;
			}
			ctx.ui.notify(`Re-running ${record.title}...`, "info");
			try {
				const result = await executeTasksRun(record.params, undefined, undefined, ctx, record.toolName ?? "tasks");
				const text = result.content.find((item) => item.type === "text");
				ctx.ui.notify(text?.type === "text" ? shortenText(text.text, 120) : `Completed ${record.title}`, result.isError ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(`Failed to rerun tasks: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		};

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const requestRender = () => tui.requestRender();
			dashboardRenderers.add(requestRender);
			const close = () => {
				dashboardRenderers.delete(requestRender);
				done();
			};
			return new TaskDashboardComponent(
				() => ({ activeRuns, recentRuns }),
				() => tui.terminal.rows,
				theme,
				{
					onClose: close,
					onRerun: (record) => {
						close();
						void rerunRecord(record);
					},
					onCopyPrompt: (record) => {
						try {
							copyToClipboard(buildPromptText(record));
							ctx.ui.notify(`Copied prompt for ${record.title}`, "info");
						} catch (error) {
							ctx.ui.notify(`Could not copy prompt: ${error instanceof Error ? error.message : String(error)}`, "error");
						}
					},
					onPastePrompt: (record) => {
						ctx.ui.pasteToEditor(buildPromptText(record));
						ctx.ui.notify(`Pasted prompt for ${record.title} into the editor`, "info");
					},
					onAbortTask: (taskId) => {
						if (!abortTaskById(taskId, ctx)) ctx.ui.notify(`Task ${taskId} is not running.`, "warning");
					},
					initialTaskId,
				},
			);
		});
	};

	const executeTasksRun = async (
		params: TasksToolParams,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		ctx: ExtensionContext,
		toolName: "task" | "tasks",
	) =>
		executeTasksRunFlow(params, signal, onUpdate, ctx, {
			processIsChild: Boolean(process.env.PI_CHILD_TYPE),
			maxTasks: MAX_TASKS,
			maxConcurrency: MAX_CONCURRENCY,
			getThinkingLevel: () => pi.getThinkingLevel(),
			getActiveRuns: () => activeRuns,
			getRecentRuns: () => recentRuns,
			startRun,
			patchRun,
			finishRun,
			failRun,
			runSingleTask,
			activeTaskControllers,
			pendingAbortTaskIds,
		}, toolName);

	pi.on("session_start", async (_event, ctx) => restoreTaskHistory(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreTaskHistory(ctx));
	pi.on("session_fork", async (_event, ctx) => restoreTaskHistory(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreTaskHistory(ctx));

	pi.registerCommand("tasks-ui", {
		description: "Show recent task runs, inspect a task id, or abort a running task",
		handler: async (args, ctx) => {
			const parsed = parseTasksUICommandArgs(args);
			if (parsed.mode === "dashboard") {
				await openDashboard(ctx);
				return;
			}

			if (!parsed.id) {
				await openDashboard(ctx);
				return;
			}

			const record = findRunForTaskId(parsed.id);
			if (!record) {
				ctx.ui.notify(`Task ${parsed.id} was not found in recent history.`, "warning");
				return;
			}

			if (parsed.mode === "abort") {
				if (!abortTaskById(parsed.id, ctx)) ctx.ui.notify(`Task ${parsed.id} is not running.`, "warning");
				return;
			}

			if (!ctx.hasUI) {
				const result = record.details?.results.find((item) => item.id === parsed.id);
				ctx.ui.notify(result ? makeResultSnippet(result) : `Opened ${parsed.id}`, "info");
				return;
			}

			await openDashboard(ctx, parsed.id);
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Launch a single isolated leaf worker using the current root agent configuration.",
			"The task may include an optional human-readable name.",
			"The task run receives a generated timestamped id.",
			"Task workers inherit the current environment except they cannot call task or tasks again.",
		].join(" "),
		promptSnippet: "Launch one isolated task worker and track it by optional name plus timestamped id.",
		promptGuidelines: [
			"Reason about the task first, then call task only if one isolated worker is actually useful.",
			"Use task when you want exactly one isolated worker.",
			"Provide a concrete task prompt with clear goals, files, and success criteria.",
			"Use the optional name when it helps identify the returned result.",
			"Do not expect the worker to create task or tasks calls; nested task invocation is forbidden.",
		],
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeTasksRun({ tasks: [{ name: params.name, task: params.task, cwd: params.cwd }] }, signal, onUpdate, ctx, "task");
		},

		renderCall(args, theme) {
			const label = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "task";
			const preview = typeof args.task === "string" ? shortenText(args.task, 60) : "...";
			let text = theme.fg("toolTitle", theme.bold("task ")) + theme.fg("accent", label);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TasksDetails | undefined;
			const entry = details?.results[0];
			if (!entry) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const displayItems = extractDisplayItems(entry.messages);
			const finalOutput = extractFinalOutput(entry.messages);
			const statusIcon =
				entry.status === "queued"
					? theme.fg("dim", "QUE")
					: entry.status === "running"
						? theme.fg("warning", "RUN")
						: entry.status === "success"
							? theme.fg("success", "OK")
							: entry.status === "aborted"
								? theme.fg("warning", "ABT")
								: theme.fg("error", "ERR");

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(`${statusIcon} ${theme.fg("accent", canonicalTaskLabel(entry))}`, 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
				for (const item of displayItems) {
					if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
				}
				if (entry.status === "error" || entry.status === "aborted") {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg(entry.status === "error" ? "error" : "warning", getResultError(entry) || "Task failed."), 0, 0));
				} else if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				} else {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", entry.status === "running" ? "(running...)" : "(no output)"), 0, 0));
				}
				const usage = formatUsageStats(entry.usage, entry.model);
				if (usage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usage), 0, 0));
				}
				return container;
			}

			let text = `${statusIcon} ${theme.fg("accent", canonicalTaskLabel(entry))}`;
			if (entry.status === "error" || entry.status === "aborted") text += `\n${theme.fg(entry.status === "error" ? "error" : "warning", getResultError(entry) || "Task failed.")}`;
			else if (displayItems.length === 0) text += `\n${theme.fg("muted", entry.status === "running" ? "(running...)" : "(no output)")}`;
			else {
				for (const item of displayItems.slice(-COLLAPSED_ITEM_COUNT)) {
					if (item.type === "text") text += `\n${theme.fg("toolOutput", expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n"))}`;
					else text += `\n${theme.fg("muted", "> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
				}
			}
			const usage = formatUsageStats(entry.usage, entry.model);
			if (usage) text += `\n${theme.fg("dim", usage)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		description: [
			"Launch isolated leaf workers in parallel using the current root agent configuration.",
			"Each task may include an optional human-readable name.",
			"Each task run receives a generated timestamped id.",
			"Task workers inherit the current environment except they cannot call task or tasks again.",
		].join(" "),
		promptSnippet: "Launch one or more isolated task workers in parallel and track them by name plus timestamped id.",
		promptGuidelines: [
			"Reason about the problem first, then call tasks only when independent work items really exist.",
			"Use tasks when you want the root agent to fan out independent work in parallel.",
			"Provide concrete task prompts with clear goals, files, and success criteria.",
			"Use optional names to make the returned results easier to attribute and summarize.",
			"Do not expect task workers to create task or tasks calls; nested task invocation is forbidden.",
		],
		parameters: TasksParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeTasksRun(params, signal, onUpdate, ctx, "tasks");
		},

		renderCall(args, theme) {
			const taskCount = Array.isArray(args.tasks) ? args.tasks.length : 0;
			let text = theme.fg("toolTitle", theme.bold("tasks ")) + theme.fg("accent", `${taskCount} task${taskCount === 1 ? "" : "s"}`);
			for (const task of (args.tasks || []).slice(0, 3)) {
				const label = typeof task.name === "string" && task.name.trim() ? task.name.trim() : "task";
				const preview = typeof task.task === "string" ? shortenText(task.task, 44) : "...";
				text += `\n  ${theme.fg("accent", label)}${theme.fg("dim", ` ${preview}`)}`;
			}
			if (taskCount > 3) text += `\n  ${theme.fg("muted", `... +${taskCount - 3} more`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TasksDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const statusIcon = (status: TaskStatus) => {
				if (status === "queued") return theme.fg("dim", "QUE");
				if (status === "running") return theme.fg("warning", "RUN");
				if (status === "success") return theme.fg("success", "OK");
				if (status === "aborted") return theme.fg("warning", "ABT");
				return theme.fg("error", "ERR");
			};
			const summaryText = `TASKS ${details.summary.running > 0 || details.summary.queued > 0 ? "running" : "complete"}: ${details.summary.success} success, ${details.summary.error} error, ${details.summary.aborted} aborted`;

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const shown = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of shown) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(theme.fg("toolTitle", theme.bold(summaryText)), 0, 0));
				for (const entry of details.results) {
					const displayItems = extractDisplayItems(entry.messages);
					const finalOutput = extractFinalOutput(entry.messages);
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${statusIcon(entry.status)} ${theme.fg("accent", canonicalTaskLabel(entry))}`, 0, 0));
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
					for (const item of displayItems) {
						if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
					}
					if (entry.status === "error" || entry.status === "aborted") {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg(entry.status === "error" ? "error" : "warning", getResultError(entry) || "Task failed."), 0, 0));
					} else if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", entry.status === "running" ? "(running...)" : "(no output)"), 0, 0));
					}
					const usage = formatUsageStats(entry.usage, entry.model);
					if (usage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usage), 0, 0));
					}
				}
				const usage = formatUsageStats(aggregateUsage(details.results));
				if (usage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
				}
				return container;
			}

			let text = theme.fg("toolTitle", theme.bold(summaryText));
			for (const entry of details.results) {
				const displayItems = extractDisplayItems(entry.messages);
				text += `\n\n${statusIcon(entry.status)} ${theme.fg("accent", canonicalTaskLabel(entry))}`;
				if (entry.status === "error" || entry.status === "aborted") {
					text += `\n${theme.fg(entry.status === "error" ? "error" : "warning", getResultError(entry) || "Task failed.")}`;
				} else if (displayItems.length === 0) {
					text += `\n${theme.fg("muted", entry.status === "running" ? "(running...)" : "(no output)")}`;
				} else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
			}
			const usage = formatUsageStats(aggregateUsage(details.results));
			if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
			return new Text(text, 0, 0);
		},
	});
}
