import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendBatchEvent,
  buildAttemptPaths,
  createBatch,
  readJsonFile,
  taskArtifactPath,
  writeAttemptArtifact,
  writeBatchArtifact,
  writeTaskArtifact,
  type AuditBatchHandle,
} from "./audit-log.ts";
import { evaluateAcceptance, matchesPathPattern } from "./acceptance.ts";
import { deriveFinalOutcome } from "./decision.ts";
import { classifyProtocolFailure } from "./failure-classifier.ts";
import { computeBackoffMs, normalizeRetryPolicy, shouldRetryAttempt } from "./retry.ts";
import { normalizeTasksRun } from "./run-tasks.ts";
import { writeSummaryMarkdown } from "./summary.ts";
import { activityRole, activitySummary, iconForActivity, renderActivitySummaryLines, type ActivityRole } from "./thinking-steps.ts";
import { countTaskLifecycle, deriveTaskView, failureReasonLabel, summarizeTasks, terminalBatchStatus } from "./task-view.ts";
import { normalizeThrottlePolicy, ThrottleController } from "./throttle.ts";
import {
  emptyAcceptance,
  emptyWorkerReport,
  type BatchArtifact,
  type NormalizedTaskSpec,
  type TaskActivityItem,
  type TaskArtifact,
  type TaskAttemptRecord,
  type TasksToolParams,
} from "./types.ts";
import { buildAttemptRecord, runWorkerAttempt, type AttemptRuntimeResult, type RunWorkerAttemptInput } from "./worker-runner.ts";
import { observedWritePaths, readWorkerEvents, workerEventsPathForAttempt } from "./worker-events.ts";
import { readTaskReport } from "./worker-protocol.ts";
import { auditableWriteEvidence, mergeWriteEvidence, writeEvidenceFromGitDiff, writeEvidenceFromTelemetry } from "./write-evidence.ts";

const execFileAsync = promisify(execFile);

export interface SupervisorContext {
  cwd: string;
  toolName: "task" | "tasks";
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
}

export interface SupervisorDependencies {
	runAttempt?: (input: RunWorkerAttemptInput) => Promise<AttemptRuntimeResult>;
	now?: () => string;
	captureChangedFiles?: (task: NormalizedTaskSpec) => Promise<string[]>;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	onUpdate?: (snapshot: SupervisedTasksResult) => void;
	liveUpdateIntervalMs?: number;
}

export interface SupervisedTasksResult {
  batch: BatchArtifact;
  tasks: TaskArtifact[];
  text: string;
}

function statusIcon(task: TaskArtifact): string {
  return deriveTaskView(task).icon;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function summarizeTaskName(rawName: string | undefined, id: string): string {
  // Show the task name as a stable summary alongside the id. Strip the trailing
  // ` ${id}` suffix that tasks_plan's default nameTemplate ('{{batchName}} {{id}}')
  // appends, and ignore names that are just the id itself.
  const name = rawName?.trim();
  if (!name || name === id) return "";
  const suffix = ` ${id}`;
  if (name.endsWith(suffix)) {
    const prefix = name.slice(0, name.length - suffix.length).trim();
    return prefix;
  }
  return name;
}

function taskBody(task: TaskArtifact): string {
  const view = deriveTaskView(task);
  const summary = truncate(summarizeTaskName(task.name, task.taskId), 60);
  if (view.finalStatus === "error") {
    const reason = view.failureReason || "error";
    return summary ? `${summary} · ${reason}` : reason;
  }
  // While a parent retry is in flight, surface it on the first line so the user
  // can tell 'attempt 2 in progress' apart from 'first attempt running'. The
  // attempts array already contains every settled previous attempt; it grows
  // before the next attempt starts, so the count of past attempts is at least
  // 1 by the time we render the retry hint.
  if (view.displayStatus === "running" && view.attempts >= 1) {
    const retryHint = `retry ${view.attempts + 1}`;
    return summary ? `${summary} · ${retryHint}` : retryHint;
  }
  // For success / aborted / running / queued the body is the static task summary.
  // Live progress lives in the thinking-steps tree below; the first line keeps a
  // stable identity instead of duplicating the latest activity.
  return summary;
}

const TREE_INDENT = "   ";
const TREE_MAX_ITEMS = 5;

function shouldShowTree(task: TaskArtifact): boolean {
  const view = deriveTaskView(task);
  if (view.finalStatus === "success") return false;
  if (view.finalStatus === "error" || view.finalStatus === "aborted") return Boolean(task.activity?.length);
  // Mid-flight: show tree when a running task has any activity yet.
  return view.displayStatus === "running" && Boolean(task.activity?.length);
}

function compactTaskLine(task: TaskArtifact, idWidth: number): string {
  const icon = statusIcon(task);
  const truncated = task.taskId.length > idWidth ? truncate(task.taskId, idWidth) : task.taskId;
  const body = taskBody(task);
  if (!body) return `${icon}  ${truncated}`;
  const padded = truncated.padEnd(idWidth, " ");
  return `${icon}  ${padded}  ${body}`;
}

function taskMetaLine(task: TaskArtifact, batch: BatchArtifact): string | undefined {
  // Per-task model + thinking, separated by '/'. Defaults to whatever the supervisor
  // captured from the parent pi process; we still render every task so audit shows
  // exactly what each agent ran on.
  const taskModel = task.metadata?.model ?? batch.defaultModel;
  const taskThinking = task.metadata?.thinking ?? batch.defaultThinking;
  const parts = [taskModel, taskThinking].filter((value): value is string => Boolean(value && value.trim()));
  if (parts.length === 0) return undefined;
  return `${TREE_INDENT}◊ ${parts.join("/")}`;
}

function compactTaskBlock(task: TaskArtifact, idWidth: number, batch: BatchArtifact): string[] {
  const lines = [compactTaskLine(task, idWidth)];
  const meta = taskMetaLine(task, batch);
  if (meta) lines.push(meta);
  if (shouldShowTree(task)) {
    lines.push(...renderActivitySummaryLines(task.activity ?? [], { maxItems: TREE_MAX_ITEMS, header: true, indent: TREE_INDENT }));
  }
  return lines;
}

function interleaveTaskBlocks(blocks: string[][]): string[] {
  const out: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const previousHadTree = index > 0 && (blocks[index - 1]?.length ?? 0) > 1;
    const currentHasTree = block.length > 1;
    if (out.length && (previousHadTree || currentHasTree)) out.push("");
    out.push(...block);
  }
  return out;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function batchHeading(batch: BatchArtifact): string {
  const meta = batch.toolName === "tasks" || batch.toolName === "task" ? undefined : batch.toolName;
  return meta ?? "tasks";
}

type SnapshotMode = "running" | "done" | "error" | "aborted";

function snapshotElapsed(batch: BatchArtifact, mode: SnapshotMode): string | undefined {
  const startedMs = Date.parse(batch.startedAt);
  if (Number.isNaN(startedMs)) return undefined;
  const finishedMs = mode === "running"
    ? Date.now()
    : (() => {
        const candidate = batch.finishedAt ?? null;
        const parsed = candidate ? Date.parse(candidate) : Number.NaN;
        return Number.isNaN(parsed) ? Date.now() : parsed;
      })();
  return formatElapsed(finishedMs - startedMs);
}

function snapshotHeading(batch: BatchArtifact, tasks: TaskArtifact[], mode: SnapshotMode): string {
  const counts = countTaskLifecycle(tasks);
  const elapsed = snapshotElapsed(batch, mode);
  const total = tasks.length;
  const elapsedSuffix = elapsed ? ` · ${elapsed}` : "";
  if (mode === "running") {
    return `TASKS running · ${batchHeading(batch)} · ${counts.done}/${total}${elapsedSuffix}`;
  }
  const parts: string[] = [];
  if (counts.success) parts.push(`${counts.success}✓`);
  if (counts.error) parts.push(`${counts.error}✗`);
  if (counts.aborted) parts.push(`${counts.aborted}⊘`);
  if (parts.length === 0) parts.push("0");
  return `TASKS ${mode} · ${batchHeading(batch)} · ${parts.join(" ")} / ${total}${elapsedSuffix}`;
}

function buildSnapshotText(batch: BatchArtifact, tasks: TaskArtifact[], mode: SnapshotMode, extras: string[] = []): string {
  const idWidth = tasks.length === 0 ? 4 : Math.max(4, ...tasks.map((task) => Math.min(task.taskId.length, 20)));
  const blocks = tasks.map((task) => compactTaskBlock(task, idWidth, batch));
  const lines: string[] = [snapshotHeading(batch, tasks, mode)];
  if (blocks.length) {
    lines.push("");
    lines.push(...interleaveTaskBlocks(blocks));
  }
  lines.push("");
  lines.push(`/tasks-ui ${batch.batchId}`);
  if (extras.length) lines.push(...extras);
  return lines.join("\n");
}

export interface SnapshotTheme {
  fg: (role: string, text: string) => string;
  bold?: (text: string) => string;
}

function paint(theme: SnapshotTheme, role: string, text: string): string {
  try { return theme.fg(role, text); } catch { return text; }
}

function statusRole(task: TaskArtifact): { icon: string; idRole: string; bodyRole: string } {
  switch (deriveTaskView(task).displayStatus) {
    case "success": return { icon: "success", idRole: "muted", bodyRole: "muted" };
    case "error": return { icon: "error", idRole: "default", bodyRole: "error" };
    case "aborted": return { icon: "warning", idRole: "muted", bodyRole: "muted" };
    case "running": return { icon: "accent", idRole: "default", bodyRole: "muted" };
    default: return { icon: "muted", idRole: "muted", bodyRole: "muted" };
  }
}

function colorTaskLine(theme: SnapshotTheme, task: TaskArtifact, idWidth: number): string {
  const role = statusRole(task);
  const icon = paint(theme, role.icon, statusIcon(task));
  const truncated = task.taskId.length > idWidth ? truncate(task.taskId, idWidth) : task.taskId;
  const body = taskBody(task);
  if (!body) return `${icon}  ${paint(theme, role.idRole, truncated)}`;
  const padding = " ".repeat(Math.max(0, idWidth - truncated.length));
  return `${icon}  ${paint(theme, role.idRole, truncated)}${padding}  ${paint(theme, role.bodyRole, body)}`;
}

function colorActivityRoleColor(role: ActivityRole): string {
  switch (role) {
    case "verify": return "success";
    case "write": return "accent";
    case "plan": return "info";
    case "compare": return "info";
    case "error": return "error";
    case "search": return "muted";
    case "inspect": return "muted";
    default: return "muted";
  }
}

function colorActivityTreeLines(theme: SnapshotTheme, items: TaskActivityItem[]): string[] {
  const visible = items.slice(-TREE_MAX_ITEMS);
  if (visible.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${TREE_INDENT}${paint(theme, "muted", "┆ Thinking Steps · Summary")}`);
  for (let index = 0; index < visible.length; index += 1) {
    const item = visible[index]!;
    const connector = index === visible.length - 1 ? "└─" : "├─";
    const role = activityRole(item);
    const iconRole = colorActivityRoleColor(role);
    const icon = iconForActivity(item);
    const summary = activitySummary(item);
    lines.push(`${TREE_INDENT}${paint(theme, "muted", connector)} ${paint(theme, iconRole, icon)} ${paint(theme, "muted", summary)}`);
  }
  return lines;
}

function colorTaskMetaLine(theme: SnapshotTheme, task: TaskArtifact, batch: BatchArtifact): string | undefined {
  const plain = taskMetaLine(task, batch);
  if (!plain) return undefined;
  return `${TREE_INDENT}${paint(theme, "muted", plain.slice(TREE_INDENT.length))}`;
}

function colorTaskBlock(theme: SnapshotTheme, task: TaskArtifact, idWidth: number, batch: BatchArtifact): string[] {
  const lines = [colorTaskLine(theme, task, idWidth)];
  const meta = colorTaskMetaLine(theme, task, batch);
  if (meta) lines.push(meta);
  if (shouldShowTree(task)) lines.push(...colorActivityTreeLines(theme, task.activity ?? []));
  return lines;
}

function colorHeading(theme: SnapshotTheme, batch: BatchArtifact, tasks: TaskArtifact[], mode: SnapshotMode): string {
  const counts = countTaskLifecycle(tasks);
  const elapsed = snapshotElapsed(batch, mode);
  const total = tasks.length;
  const sep = paint(theme, "muted", "·");
  const tasksLabel = paint(theme, "muted", "TASKS");
  const verbRole = mode === "running" ? "warning" : mode === "done" ? "success" : mode === "error" ? "error" : "warning";
  const verbText = theme.bold ? theme.bold(mode) : mode;
  const verb = paint(theme, verbRole, verbText);
  const heading = paint(theme, "accent", batchHeading(batch));
  const elapsedSuffix = elapsed ? ` ${sep} ${paint(theme, "muted", elapsed)}` : "";
  if (mode === "running") {
    const progress = `${counts.done}/${total}`;
    return `${tasksLabel} ${verb} ${sep} ${heading} ${sep} ${progress}${elapsedSuffix}`;
  }
  const parts: string[] = [];
  if (counts.success) parts.push(paint(theme, "success", `${counts.success}✓`));
  if (counts.error) parts.push(paint(theme, "error", `${counts.error}✗`));
  if (counts.aborted) parts.push(paint(theme, "warning", `${counts.aborted}⊘`));
  if (parts.length === 0) parts.push(paint(theme, "muted", "0"));
  return `${tasksLabel} ${verb} ${sep} ${heading} ${sep} ${parts.join(" ")} ${paint(theme, "muted", `/ ${total}`)}${elapsedSuffix}`;
}

function colorExtra(theme: SnapshotTheme, extra: string): string {
  if (extra.startsWith("rerun failed:")) return paint(theme, "warning", extra);
  if (extra.startsWith("summary:")) return paint(theme, "muted", extra);
  if (extra.startsWith("plan:")) return paint(theme, "muted", extra);
  if (extra.startsWith("next:")) return paint(theme, "info", extra);
  if (extra.startsWith("rows:")) return paint(theme, "muted", extra);
  return extra;
}

export function renderColoredSnapshot(theme: SnapshotTheme, batch: BatchArtifact, tasks: TaskArtifact[], mode: SnapshotMode, extras: string[] = []): string {
  const idWidth = tasks.length === 0 ? 4 : Math.max(4, ...tasks.map((task) => Math.min(task.taskId.length, 20)));
  const blocks = tasks.map((task) => colorTaskBlock(theme, task, idWidth, batch));
  const lines: string[] = [colorHeading(theme, batch, tasks, mode)];
  if (blocks.length) {
    lines.push("");
    lines.push(...interleaveTaskBlocks(blocks));
  }
  lines.push("");
  lines.push(paint(theme, "muted", `/tasks-ui ${batch.batchId}`));
  for (const extra of extras) lines.push(colorExtra(theme, extra));
  return lines.join("\n");
}

export function renderColoredFromText(theme: SnapshotTheme, plainText: string, batch?: BatchArtifact, tasks?: TaskArtifact[]): string {
  if (!batch || !Array.isArray(tasks)) return plainText;
  const status = batch.status;
  const mode: SnapshotMode = status === "running" || status === "initializing" || status === "incomplete" ? "running"
    : status === "success" ? "done"
    : status === "error" ? "error"
    : "aborted";
  // Re-derive extras from the plain text trailing lines so we keep parity with whatever the
  // text builder emitted (summary path, rerun, plan path, synthesis hint, etc.).
  const trailing = plainText.split("\n").reverse();
  const extras: string[] = [];
  for (const line of trailing) {
    const trimmed = line.trim();
    if (!trimmed) break;
    if (trimmed.startsWith("/tasks-ui ")) break;
    if (/^(rerun failed:|summary:|plan:|next:|rows:)/.test(trimmed)) extras.unshift(trimmed);
  }
  return renderColoredSnapshot(theme, batch, tasks, mode, extras);
}

function buildLiveResultText(batch: BatchArtifact, tasks: TaskArtifact[]): string {
  return buildSnapshotText(batch, tasks, "running");
}

function finalSnapshotMode(status: "success" | "error" | "aborted"): SnapshotMode {
  return status === "success" ? "done" : status;
}

function buildFinalResultText(batch: BatchArtifact, tasks: TaskArtifact[], status: "success" | "error" | "aborted", summaryPath?: string): string {
  const counts = countTaskLifecycle(tasks);
  const extras: string[] = [];
  if (summaryPath) extras.push(`summary: ${summaryPath}`);
  if (counts.error > 0) extras.push(`rerun failed: /tasks-ui rerun failed ${batch.batchId}`);
  return buildSnapshotText(batch, tasks, finalSnapshotMode(status), extras);
}

async function readTaskArtifacts(batch: AuditBatchHandle): Promise<TaskArtifact[]> {
  return Promise.all(batch.artifact.taskIds.map((taskId) => readJsonFile<TaskArtifact>(taskArtifactPath(batch, taskId))));
}

async function emitSupervisorUpdate(batch: AuditBatchHandle, deps: SupervisorDependencies, batchOverride?: BatchArtifact): Promise<void> {
  if (!deps.onUpdate) return;
  try {
    const tasks = await readTaskArtifacts(batch);
    const liveBatch = { ...(batchOverride ?? batch.artifact), summary: summarizeTasks(tasks) };
    deps.onUpdate({ batch: liveBatch, tasks, text: buildLiveResultText(liveBatch, tasks) });
  } catch {
    // Live UI must never interfere with task supervision or artifact writes.
  }
}

function startSupervisorHeartbeat(batch: AuditBatchHandle, deps: SupervisorDependencies): () => void {
  if (!deps.onUpdate) return () => undefined;
  const intervalMs = Math.max(1, deps.liveUpdateIntervalMs ?? 2000);
  const timer = setInterval(() => void emitSupervisorUpdate(batch, deps), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function hasWriteBoundary(task: NormalizedTaskSpec): boolean {
  return Boolean(task.acceptance?.allowedWritePaths?.length || task.acceptance?.forbiddenWritePaths?.length);
}

function fileInAllowedZone(filePath: string, allowed: string[]): boolean {
  return allowed.some((pattern) => matchesPathPattern(filePath, pattern));
}

function filterFilesByAllowedZone(files: string[], task: NormalizedTaskSpec): string[] {
  const allowed = task.acceptance?.allowedWritePaths;
  if (!allowed || allowed.length === 0) return files;
  return files.filter((file) => fileInAllowedZone(file, allowed));
}

function normalizeToPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isSupervisorArtifactPath(relativePath: string): boolean {
  const normalized = normalizeToPosix(relativePath);
  return normalized.startsWith(".pi/tasks/") || normalized.includes("/.pi/tasks/");
}

async function gitStatusSnapshot(cwd: string): Promise<Map<string, string> | null> {
  try {
    const { stdout: repoRootOutput } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { maxBuffer: 1024 * 1024 });
    const realCwd = await fs.realpath(cwd);
    const repoRoot = await fs.realpath(repoRootOutput.trim());
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], { maxBuffer: 1024 * 1024 });
    const files = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const raw = line.slice(3).trim();
      const file = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
      const repoRelative = file.replace(/^"|"$/g, "");
      const cwdRelative = normalizeToPosix(path.relative(realCwd, path.resolve(repoRoot, repoRelative))) || ".";
      if (isSupervisorArtifactPath(cwdRelative)) continue;
      const stat = await fs.stat(path.resolve(realCwd, cwdRelative)).catch(() => null);
      files.set(cwdRelative, stat ? `${stat.size}:${stat.mtimeMs}` : "missing");
    }
    return files;
  } catch {
    return null;
  }
}

function diffStatusSnapshots(before: Map<string, string> | null, after: Map<string, string> | null): { available: boolean; files: string[] } {
  if (!before || !after) return { available: false, files: [] };
  const files: string[] = [];
  for (const [file, signature] of after) {
    if (before.get(file) !== signature) files.push(file);
  }
  return { available: true, files };
}

async function readWorkerLog(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function recordTaskActivity(input: {
  batch: AuditBatchHandle;
  activity: TaskActivityItem;
  nextSeq: () => number;
  deps: SupervisorDependencies;
}): Promise<void> {
  const existing = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.activity.taskId));
  const activity = [...(existing.activity ?? []), input.activity].slice(-100);
  await writeTaskArtifact(input.batch, { ...existing, activity });
  await appendBatchEvent(input.batch.eventsPath, {
    schemaVersion: 1,
    seq: input.nextSeq(),
    at: input.activity.at,
    type: "task_activity",
    batchId: input.batch.batchId,
    taskId: input.activity.taskId,
    attemptId: input.activity.attemptId,
    data: { kind: input.activity.kind, label: input.activity.label, detail: input.activity.detail },
  });
  await emitSupervisorUpdate(input.batch, input.deps);
}

async function abortQueuedTask(input: {
  batch: AuditBatchHandle;
  task: NormalizedTaskSpec;
  nextSeq: () => number;
  now?: () => string;
}): Promise<TaskArtifact> {
  const now = input.now?.() ?? new Date().toISOString();
  const existing = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.task.id));
  const aborted: TaskArtifact = {
    ...existing,
    status: "aborted",
    finalStatus: "aborted",
    failureKind: "aborted",
    retryability: "not_retryable",
    finishedAt: now,
    timeline: [...existing.timeline, { at: now, state: "aborted", message: "Task aborted before launch" }],
    error: "Task aborted before launch.",
  };
  await writeTaskArtifact(input.batch, aborted);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: now, type: "task_finished", batchId: input.batch.batchId, taskId: input.task.id, status: "aborted", message: aborted.error ?? undefined });
  return aborted;
}

async function settleTask(input: {
  batch: AuditBatchHandle;
  task: NormalizedTaskSpec;
  attemptIndex: number;
  nextSeq: () => number;
  writeAuditBaseline: Map<string, string> | null;
  writeAuditChangedFiles: Set<string>;
  ctx: SupervisorContext;
  deps: Required<Pick<SupervisorDependencies, "runAttempt">> & SupervisorDependencies;
}): Promise<{ artifact: TaskArtifact }> {
  const taskArtifact = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.task.id));
  const attemptId = `${input.task.id}-a${input.attemptIndex}`;
  const paths = buildAttemptPaths(input.batch, input.task.id, input.attemptIndex);
  const now = input.deps.now?.() ?? new Date().toISOString();
  taskArtifact.status = "running";
  taskArtifact.startedAt ??= now;
  taskArtifact.timeline.push({ at: now, state: "running", message: `Attempt ${input.attemptIndex} started` });
  // When a retry starts, the previous attempt's terminal-state fields linger on
  // the task artifact (finalStatus="error", failureKind="worker_incomplete",
  // acceptance.status="failed", error message, etc.). The snapshot renderer
  // resolves the icon as `task.finalStatus ?? task.status`, so without this
  // reset the live UI keeps drawing ✗ + the previous failure reason while the
  // new attempt is actively running. Reset to a clean running state; the
  // settled outcome of THIS attempt will refill these fields below.
  if (input.attemptIndex > 1) {
    taskArtifact.finalStatus = null;
    taskArtifact.failureKind = "none";
    taskArtifact.retryability = "not_retryable";
    taskArtifact.error = null;
    taskArtifact.acceptance = emptyAcceptance("pending");
    taskArtifact.workerReport = emptyWorkerReport();
    taskArtifact.finishedAt = null;
  }
  await writeTaskArtifact(input.batch, taskArtifact);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: now, type: "attempt_started", batchId: input.batch.batchId, taskId: input.task.id, attemptId });
  await emitSupervisorUpdate(input.batch, input.deps);

  let runtime: AttemptRuntimeResult;
  try {
    runtime = await input.deps.runAttempt({
      task: input.task,
      attemptId,
      attemptIndex: input.attemptIndex,
      paths,
      signal: input.ctx.signal,
      fallbackModel: input.ctx.model,
      fallbackThinking: input.ctx.thinking,
      onActivity: (activity) => recordTaskActivity({ batch: input.batch, activity, nextSeq: input.nextSeq, deps: input.deps }),
    });
  } catch (error) {
    const finishedAt = input.deps.now?.() ?? new Date().toISOString();
    runtime = {
      attemptId,
      taskId: input.task.id,
      status: "error",
      sawTerminalAssistantMessage: false,
      stderrTail: "",
      stdoutMalformedLines: 0,
      failureKind: "unknown",
      error: error instanceof Error ? error.message : String(error),
      startedAt: now,
      finishedAt,
    };
  }

  let attempt = buildAttemptRecord({ task: input.task, attemptId, attemptIndex: input.attemptIndex, paths, runtime });
  const reportResult = await readTaskReport(paths.reportPath, { taskId: input.task.id, attemptId });
  const workerLog = await readWorkerLog(paths.workerLogPath);
  const workerEvents = await readWorkerEvents(workerEventsPathForAttempt(paths.attemptDir)).catch(() => []);
  const telemetryWritePaths = observedWritePaths(workerEvents);
  const rawAudit = input.deps.captureChangedFiles
    ? await input.deps.captureChangedFiles(input.task).then((files) => ({ available: true, files }), () => ({ available: false, files: [] }))
    : diffStatusSnapshots(input.writeAuditBaseline, hasWriteBoundary(input.task) ? await gitStatusSnapshot(input.task.cwd) : null);
  // Filter git-diff files to this task's allowed zone so parallel writes by other tasks
  // (which target their own disjoint zones) don't pollute this task's audit set.
  // Worker-side telemetry below still attributes any out-of-zone writes back to the worker.
  const attributedAudit = { available: rawAudit.available, files: filterFilesByAllowedZone(rawAudit.files, input.task) };
  const changedFileAudit = attributedAudit;
  const writeEvidence = mergeWriteEvidence([
    ...writeEvidenceFromGitDiff(changedFileAudit.files, { taskId: input.task.id, attemptId }),
    ...writeEvidenceFromTelemetry(telemetryWritePaths, { taskId: input.task.id, attemptId }),
  ]);
  for (const item of auditableWriteEvidence(writeEvidence)) input.writeAuditChangedFiles.add(item.path);
  const accumulatedWriteEvidence = mergeWriteEvidence([
    ...writeEvidence,
    ...writeEvidenceFromGitDiff([...input.writeAuditChangedFiles], { taskId: input.task.id }),
  ]);
  const protocolKind = classifyProtocolFailure(reportResult.errors);
  const workerReport = reportResult.ok
    ? { status: reportResult.report!.status, reportPath: paths.reportPath, report: reportResult.report, errors: [], warnings: [] }
    : { status: "invalid" as const, reportPath: paths.reportPath, errors: reportResult.errors, warnings: [] };
  // Audit is "available" when we either captured a git baseline diff or observed at
  // least one worker event from stdout telemetry. The latter proves we listened to the
  // worker's tool calls, so an empty write set really means "no writes happened" rather
  // than "we have no idea what the worker did."
  const auditAvailable = changedFileAudit.available || workerEvents.length > 0 || telemetryWritePaths.length > 0;
  const acceptance = reportResult.ok && reportResult.report!.status === "completed"
    ? await evaluateAcceptance({ contract: input.task.acceptance, cwd: input.task.cwd, workerLog, report: reportResult.report, writeEvidence: accumulatedWriteEvidence, writeAuditAvailable: auditAvailable })
    : emptyAcceptance("skipped");
  const outcome = deriveFinalOutcome({ runtime: { ...runtime, error: runtime.error }, workerReport, protocolKind, acceptance });
  const { finalStatus, failureKind, retryDecision } = outcome;

  attempt = {
    ...attempt,
    workerReport,
    failureKind,
    retryability: retryDecision.retryability,
    error: runtime.error ?? workerReport.errors[0] ?? acceptance.errors[0] ?? null,
  } as TaskAttemptRecord;
  await writeAttemptArtifact(paths, attempt);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: runtime.finishedAt, type: "attempt_finished", batchId: input.batch.batchId, taskId: input.task.id, attemptId, status: runtime.status, data: { failureKind, retryability: retryDecision.retryability } });

  const finishedAt = input.deps.now?.() ?? new Date().toISOString();
  const terminalState = finalStatus;
  const latestTaskArtifact = await readJsonFile<TaskArtifact>(taskArtifactPath(input.batch, input.task.id));
  const updated: TaskArtifact = {
    ...latestTaskArtifact,
    status: terminalState,
    finalStatus,
    failureKind,
    retryability: retryDecision.retryability,
    acceptance,
    workerReport,
    attempts: [...latestTaskArtifact.attempts, attempt],
    finishedAt,
    timeline: [...latestTaskArtifact.timeline, { at: finishedAt, state: terminalState, message: `Task finished with ${finalStatus}` }],
    warnings: [...latestTaskArtifact.warnings, ...workerReport.warnings, ...acceptance.warnings],
    error: finalStatus === "success" ? null : attempt.error ?? workerReport.errors[0] ?? acceptance.errors[0] ?? "Task failed.",
  };
  await writeTaskArtifact(input.batch, updated);
  await appendBatchEvent(input.batch.eventsPath, { schemaVersion: 1, seq: input.nextSeq(), at: finishedAt, type: "task_finished", batchId: input.batch.batchId, taskId: input.task.id, status: finalStatus, data: { failureKind } });
  await emitSupervisorUpdate(input.batch, input.deps);

  return { artifact: updated };
}

async function mapWithDynamicConcurrency<TInput, TOutput>(items: TInput[], getConcurrency: () => number, fn: (item: TInput, index: number) => Promise<TOutput>): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length);
  let next = 0;
  let active = 0;
  let completed = 0;

  return await new Promise<TOutput[]>((resolve, reject) => {
    const launch = () => {
      if (completed === items.length) return resolve(results);
      while (active < Math.max(1, Math.min(getConcurrency(), items.length)) && next < items.length) {
        const index = next++;
        active += 1;
        fn(items[index], index).then((result) => {
          results[index] = result;
        }).then(() => {
          active -= 1;
          completed += 1;
          launch();
        }, reject);
      }
    };
    launch();
  });
}

export async function executeSupervisedTasks(params: TasksToolParams, ctx: SupervisorContext, deps: SupervisorDependencies = {}): Promise<SupervisedTasksResult> {
  const normalized = normalizeTasksRun(params, ctx.cwd);
  // Tasks with write-boundary contracts run in parallel like everything else. Each task's
  // git-status diff is filtered to that task's allowedWritePaths zone, so concurrent writes
  // by other tasks targeting their own disjoint zones never appear in this task's audit set.
  // Worker-side tool telemetry catches out-of-zone writes regardless of parallel state.
  const schedulingConcurrency = normalized.effectiveConcurrency;
  const batch = await createBatch({
    rootCwd: ctx.cwd,
    toolName: ctx.toolName,
    tasks: normalized.tasks,
    requestedConcurrency: normalized.requestedConcurrency,
    effectiveConcurrency: schedulingConcurrency,
    now: deps.now?.(),
    defaultModel: ctx.model,
    defaultThinking: ctx.thinking,
  });
  let seq = normalized.tasks.length + 2;
  const nextSeq = () => seq++;
  const runAttempt = deps.runAttempt ?? runWorkerAttempt;
  const retryPolicy = normalizeRetryPolicy(params.retry);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const throttle = new ThrottleController(normalizeThrottlePolicy(params.throttle, schedulingConcurrency), schedulingConcurrency);
  await emitSupervisorUpdate(batch, deps);
  const stopHeartbeat = startSupervisorHeartbeat(batch, deps);

  let taskResults: TaskArtifact[];
  try {
    taskResults = await mapWithDynamicConcurrency(normalized.tasks, () => throttle.currentConcurrency, async (task) => {
    try {
      if (ctx.signal?.aborted) {
        const aborted = await abortQueuedTask({ batch, task, nextSeq, now: deps.now });
        await emitSupervisorUpdate(batch, deps);
        return aborted;
      }
      let latest: TaskArtifact | undefined;
      const writeAuditBaseline = hasWriteBoundary(task) && !deps.captureChangedFiles ? await gitStatusSnapshot(task.cwd) : null;
      const writeAuditChangedFiles = new Set<string>();
      for (let attemptIndex = 1; attemptIndex <= retryPolicy.maxAttempts; attemptIndex += 1) {
        if (ctx.signal?.aborted && !latest) {
          const aborted = await abortQueuedTask({ batch, task, nextSeq, now: deps.now });
          await emitSupervisorUpdate(batch, deps);
          return aborted;
        }
        if (ctx.signal?.aborted) break;
        const result = await settleTask({ batch, task, attemptIndex, nextSeq, writeAuditBaseline, writeAuditChangedFiles, ctx, deps: { ...deps, runAttempt } });
        latest = result.artifact;
        const lastAttempt = latest.attempts.at(-1);
        if (!lastAttempt) break;
        const shouldRetry = shouldRetryAttempt({
          attemptIndex,
          policy: retryPolicy,
          decision: { retryability: lastAttempt.retryability, failureKind: lastAttempt.failureKind, reason: lastAttempt.error ?? lastAttempt.failureKind },
          validWorkerReport: lastAttempt.workerReport.status !== "not_submitted" && lastAttempt.workerReport.status !== "invalid",
        });
        if (!shouldRetry || latest.finalStatus === "success" || latest.finalStatus === "aborted") break;
        const delayMs = computeBackoffMs(retryPolicy, attemptIndex, deps.random);
        const at = deps.now?.() ?? new Date().toISOString();
        await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at, type: "attempt_retry_scheduled", batchId: batch.batchId, taskId: task.id, attemptId: `${task.id}-a${attemptIndex + 1}`, data: { delayMs, failureKind: lastAttempt.failureKind } });
        await sleep(delayMs);
      }
      if (!latest) throw new Error(`Task ${task.id} did not run any attempts.`);
      const throttleDecision = throttle.record(latest.failureKind);
      if (throttleDecision) {
        const at = deps.now?.() ?? new Date().toISOString();
        await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at, type: "throttle_decision", batchId: batch.batchId, data: throttleDecision as unknown as Record<string, unknown> });
      }
      return latest;
    } catch (error) {
      const now = deps.now?.() ?? new Date().toISOString();
      const existing = await readJsonFile<TaskArtifact>(taskArtifactPath(batch, task.id));
      const failed: TaskArtifact = {
        ...existing,
        status: "error",
        finalStatus: "error",
        failureKind: "unknown",
        retryability: "not_retryable",
        finishedAt: now,
        timeline: [...existing.timeline, { at: now, state: "error", message: "Supervisor settlement failed" }],
        error: error instanceof Error ? error.message : String(error),
      };
      await writeTaskArtifact(batch, failed);
      await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at: now, type: "task_finished", batchId: batch.batchId, taskId: task.id, status: "error", message: failed.error ?? undefined });
      await emitSupervisorUpdate(batch, deps);
      return failed;
    }
    });
  } finally {
    stopHeartbeat();
  }

  const summary = summarizeTasks(taskResults);
  const status = terminalBatchStatus(summary);
  const finishedAt = deps.now?.() ?? new Date().toISOString();
  const finalBatch: BatchArtifact = {
    ...batch.artifact,
    status,
    auditIntegrity: "ok",
    finishedAt,
    summary,
    parentBatchId: params.parentBatchId,
    rerunOfTaskIds: params.rerunOfTaskIds,
  };
  await writeBatchArtifact(batch, finalBatch);
  await writeSummaryMarkdown(batch.summaryPath, finalBatch, taskResults, params);
  await appendBatchEvent(batch.eventsPath, { schemaVersion: 1, seq: nextSeq(), at: finishedAt, type: "batch_finished", batchId: batch.batchId, status, data: { auditIntegrity: "ok" } });

  return {
    batch: finalBatch,
    tasks: taskResults,
    text: buildFinalResultText(finalBatch, taskResults, status, `${finalBatch.batchDir}/summary.md`),
  };
}
