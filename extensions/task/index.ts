/**
 * Tasks Supervisor V3 extension entrypoint.
 *
 * This file intentionally contains registration/wiring only. Runtime logic lives
 * in focused modules such as supervisor.ts, worker-runner.ts, and audit-log.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { registerTasksStartCommand } from "./commands.ts";
import { buildRerunParamsFromBatchDir, isRerunFilter, RERUN_FILTERS } from "./rerun.ts";
import { buildResultText, enforceInlineTasksLimit, validateTasksFanoutUsage } from "./run-tasks.ts";
import { executeSupervisedTasks, type SupervisedTasksResult } from "./supervisor.ts";
import { listBatches, loadBatchDetail, renderAttemptDetailLines, renderBatchDetailLines, renderBatchListLines, renderTaskDetailLines, renderTasksUiHelpLines, resolveBatchDir } from "./task-ui.ts";
import { registerTaskReportTool } from "./task-report-tool.ts";
import { buildPlanStartingText, decoratePlanResultText, expandTasksPlan, validateTasksPlanInput, writePlanArtifact, type TasksPlanInput } from "./tasks-plan.ts";
import type { TasksToolParams } from "./types.ts";

const MAX_TASKS = 100;

const PathCheckSchema = Type.Union([
  Type.String(),
  Type.Object({
    path: Type.String(),
    type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("glob")])),
    minBytes: Type.Optional(Type.Number()),
    requiredRegex: Type.Optional(Type.Array(Type.String())),
    forbiddenRegex: Type.Optional(Type.Array(Type.String())),
  }),
]);

const AcceptanceSchema = Type.Object({
  requiredPaths: Type.Optional(Type.Array(PathCheckSchema)),
  forbiddenPaths: Type.Optional(Type.Array(Type.String())),
  requiredOutputRegex: Type.Optional(Type.Array(Type.String())),
  forbiddenOutputRegex: Type.Optional(Type.Array(Type.String())),
  requiredReportRegex: Type.Optional(Type.Array(Type.String())),
  forbiddenReportRegex: Type.Optional(Type.Array(Type.String())),
  minWorkerLogBytes: Type.Optional(Type.Number()),
  minReportSummaryChars: Type.Optional(Type.Number()),
  allowedWritePaths: Type.Optional(Type.Array(Type.String())),
  forbiddenWritePaths: Type.Optional(Type.Array(Type.String())),
  requireDeliverablesEvidence: Type.Optional(Type.Boolean()),
  auditOnly: Type.Optional(Type.Boolean()),
});

const RetrySchema = Type.Object({
  maxAttempts: Type.Optional(Type.Number()),
  retryOn: Type.Optional(Type.Array(Type.String())),
  backoffMs: Type.Optional(Type.Object({
    initial: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    multiplier: Type.Optional(Type.Number()),
    jitter: Type.Optional(Type.Boolean()),
  })),
});

const ThrottleSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  minConcurrency: Type.Optional(Type.Number()),
  maxConcurrency: Type.Optional(Type.Number()),
  transientFailureThreshold: Type.Optional(Type.Number()),
  windowSize: Type.Optional(Type.Number()),
});

const MetadataSchema = Type.Record(Type.String(), Type.String());

const TaskItemSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Optional stable task id inside the batch" })),
  name: Type.String({ description: "Human-readable task name" }),
  prompt: Type.String({ description: "Task prompt for this supervised task agent" }),
  cwd: Type.Optional(Type.String({ description: "Optional working directory override" })),
  acceptance: Type.Optional(AcceptanceSchema),
  metadata: Type.Optional(MetadataSchema),
});

const TaskParams = Type.Object({
  name: Type.String({ description: "Human-readable task name" }),
  prompt: Type.String({ description: "Task prompt for this supervised task agent" }),
  cwd: Type.Optional(Type.String({ description: "Optional working directory override" })),
  acceptance: Type.Optional(AcceptanceSchema),
  metadata: Type.Optional(MetadataSchema),
  concurrency: Type.Optional(Type.Number({ description: "Requested concurrency for this single-task batch" })),
  retry: Type.Optional(RetrySchema),
  throttle: Type.Optional(ThrottleSchema),
});

const TasksParams = Type.Object({
  tasks: Type.Array(TaskItemSchema, { description: "Task specs to launch under one supervised batch.", minItems: 1, maxItems: MAX_TASKS }),
  concurrency: Type.Optional(Type.Number({ description: "Requested batch concurrency" })),
  retry: Type.Optional(RetrySchema),
  throttle: Type.Optional(ThrottleSchema),
  acceptanceDefaults: Type.Optional(AcceptanceSchema),
  parentBatchId: Type.Optional(Type.String()),
  rerunOfTaskIds: Type.Optional(Type.Array(Type.String())),
});

const PlanRowVarSchema = Type.Union([Type.String(), Type.Array(Type.String())]);

const TasksPlanRowSchema = Type.Object({
  id: Type.String({ description: "Stable, unique row id within the batch (matches the supervised task id). Use [A-Za-z0-9._-]." }),
  name: Type.Optional(Type.String({ description: "Optional task name override (default: '{{batchName}} {{id}}' or nameTemplate)." })),
  cwd: Type.Optional(Type.String({ description: "Optional cwd override for this row (default: cwdTemplate or context cwd)." })),
  vars: Type.Optional(Type.Record(Type.String(), PlanRowVarSchema, { description: "Per-row template variables. Strings substitute directly; arrays join with newlines in string fields and splat when the entry is exactly {{key}} in array fields." })),
});

const TasksPlanParams = Type.Object({
  batchName: Type.String({ description: "Short batch label, used in default task names and stored in plan.json." }),
  concurrency: Type.Optional(Type.Number({ description: "Requested batch concurrency. Tasks with disjoint allowedWritePaths run truly in parallel; declare overlapping zones only when you intentionally want one task at a time." })),
  matrix: Type.Array(TasksPlanRowSchema, { minItems: 1, maxItems: MAX_TASKS, description: "One row per leaf task. Keep rows compact: id + per-row vars only." }),
  promptTemplate: Type.String({ description: "Prompt template with {{key}} placeholders. Substituted per row using row.id, row.name, row.cwd, and row.vars." }),
  nameTemplate: Type.Optional(Type.String({ description: "Optional task name template (default: '{{batchName}} {{id}}')." })),
  cwdTemplate: Type.Optional(Type.String({ description: "Optional cwd template (default: row.cwd or supervisor cwd)." })),
  acceptanceTemplate: Type.Optional(AcceptanceSchema),
  metadataTemplate: Type.Optional(MetadataSchema),
  retry: Type.Optional(RetrySchema),
  throttle: Type.Optional(ThrottleSchema),
  acceptanceDefaults: Type.Optional(AcceptanceSchema),
  synthesis: Type.Optional(Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("parent"), Type.Literal("report-only")], { description: "Who synthesizes after the batch finishes. Default: parent." })),
    instructions: Type.Optional(Type.String({ description: "Instructions for the root agent's post-batch synthesis." })),
  })),
  parentBatchId: Type.Optional(Type.String()),
  rerunOfTaskIds: Type.Optional(Type.Array(Type.String())),
});

function modelId(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model?.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function buildStartingText(params: TasksToolParams, _ctx: ExtensionContext): string {
  const total = Array.isArray(params.tasks) ? params.tasks.length : 0;
  return `TASKS starting · preparing ${total} task${total === 1 ? "" : "s"}`;
}

async function runTasks(params: TasksToolParams, signal: AbortSignal | undefined, onUpdate: ((partialResult: any) => void) | undefined, ctx: ExtensionContext, toolName: "task" | "tasks") {
  if (toolName === "tasks") {
    validateTasksFanoutUsage(params);
    enforceInlineTasksLimit(params);
  }
  onUpdate?.({
    content: [{ type: "text", text: buildStartingText(params, ctx) }],
    details: { status: "starting", total: Array.isArray(params.tasks) ? params.tasks.length : 0, cwd: ctx.cwd },
    isError: false,
  });
  const result = await executeSupervisedTasks(params, {
    cwd: ctx.cwd,
    toolName,
    signal,
    model: modelId(ctx),
  }, {
    onUpdate: (snapshot) => onUpdate?.({
      content: [{ type: "text", text: snapshot.text }],
      details: snapshot,
      isError: false,
    }),
  });
  return {
    content: [{ type: "text", text: result.text }],
    details: result,
    isError: result.batch.status !== "success",
  };
}

async function runTasksPlan(params: TasksPlanInput, signal: AbortSignal | undefined, onUpdate: ((partialResult: any) => void) | undefined, ctx: ExtensionContext) {
  validateTasksPlanInput(params);
  const expansion = expandTasksPlan(params);
  onUpdate?.({
    content: [{ type: "text", text: buildPlanStartingText(params, expansion, ctx.cwd) }],
    details: { status: "plan_starting", batchName: params.batchName, total: expansion.rowIds.length, rowIds: expansion.rowIds, cwd: ctx.cwd },
    isError: false,
  });
  const supervised: SupervisedTasksResult = await executeSupervisedTasks(expansion.params, {
    cwd: ctx.cwd,
    toolName: "tasks",
    signal,
    model: modelId(ctx),
  }, {
    onUpdate: (snapshot) => onUpdate?.({
      content: [{ type: "text", text: snapshot.text }],
      details: snapshot,
      isError: false,
    }),
  });
  let planPath: string | undefined;
  try {
    planPath = await writePlanArtifact(supervised.batch.batchDir, supervised.batch.batchId, params, expansion);
  } catch {
    // Plan artifact write must not block returning a real supervisor result.
  }
  const finalText = planPath ? decoratePlanResultText(supervised.text, planPath, params) : supervised.text;
  return {
    content: [{ type: "text", text: finalText }],
    details: { ...supervised, plan: { batchName: params.batchName, rowIds: expansion.rowIds, taskNames: expansion.taskNames, synthesis: params.synthesis }, planPath },
    isError: supervised.batch.status !== "success",
  };
}

async function showTasksUi(args: string, ctx: ExtensionContext): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "help" || trimmed === "--help") {
    if (!trimmed) {
      const items = await listBatches(ctx.cwd);
      ctx.ui.notify(renderBatchListLines(items).join("\n"), "info");
      return;
    }
    ctx.ui.notify(renderTasksUiHelpLines().join("\n"), "info");
    return;
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] === "rerun") {
    const [, filter, batchDir, ...ids] = tokens;
    if (!filter || !isRerunFilter(filter) || !batchDir) {
      ctx.ui.notify([`Invalid rerun command. Filters: ${RERUN_FILTERS.join(", ")}`, ...renderTasksUiHelpLines()].join("\n"), "warning");
      return;
    }
    const payload = await buildRerunParamsFromBatchDir(resolveBatchDir(ctx.cwd, batchDir), filter, ids.length ? ids : undefined);
    if (payload.rerunOfTaskIds.length === 0) {
      ctx.ui.notify(`No tasks matched rerun filter '${filter}'. Use /tasks-ui ${batchDir} to inspect the batch.`, "warning");
      return;
    }
    const text = JSON.stringify(payload, null, 2);
    if (ctx.hasUI) ctx.ui.pasteToEditor(text);
    ctx.ui.notify(`Prepared rerun payload for ${payload.rerunOfTaskIds.length} task(s): ${payload.rerunOfTaskIds.join(", ")}`, "info");
    return;
  }

  const [batchInput, subcommand, taskId, attemptRef] = tokens;
  const detail = await loadBatchDetail(resolveBatchDir(ctx.cwd, batchInput));
  if (!subcommand) {
    ctx.ui.notify(renderBatchDetailLines(detail).join("\n"), detail.batch.status === "error" ? "warning" : "info");
    return;
  }
  if (subcommand === "task" && taskId) {
    ctx.ui.notify(renderTaskDetailLines(detail, taskId).join("\n"), "info");
    return;
  }
  if (subcommand === "attempt" && taskId) {
    ctx.ui.notify(renderAttemptDetailLines(detail, taskId, attemptRef ?? "latest").join("\n"), "info");
    return;
  }
  ctx.ui.notify([`Unknown tasks-ui subcommand: ${subcommand}`, ...renderTasksUiHelpLines()].join("\n"), "warning");
}

export default function taskExtension(pi: ExtensionAPI) {
  registerTaskReportTool(pi);
  if (process.env.PI_CHILD_TYPE) return;

  registerTasksStartCommand(pi);

  pi.registerCommand("tasks-ui", {
    description: "Show supervised task batch artifacts or prepare rerun payloads",
    handler: async (args, ctx) => {
      try {
        await showTasksUi(args, ctx);
      } catch (error) {
        ctx.ui.notify(`tasks-ui failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "task",
    label: "Task",
    description: "Launch one supervised task agent with structured report, acceptance checks, audit artifacts, and strict parent retry boundaries.",
    promptSnippet: "Launch one supervised task agent with a prompt, name, and optional acceptance contract.",
    promptGuidelines: [
      "Use task when exactly one isolated supervised task agent is useful.",
      "Do not use task to fan out multiple agents; for repeated/templated fan-out call tasks_plan with a matrix and a promptTemplate.",
      "Provide a clear name, concrete prompt, expected deliverables, and acceptance criteria when possible.",
      "The worker must submit a structured task report; natural-language completion claims are not enough.",
    ],
    parameters: TaskParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { name, prompt, cwd, acceptance, metadata, concurrency, retry, throttle } = params as any;
      return runTasks({ tasks: [{ name, prompt, cwd, acceptance, metadata }], concurrency, retry, throttle }, signal, onUpdate, ctx, "task");
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("task "))}${theme.fg("accent", String((args as any).name ?? "task"))}`, 0, 0);
    },
    renderResult(result, _opts, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : buildResultText({ batchId: "unknown", batchDir: "unknown", status: "incomplete", total: 0, success: 0, error: 0, aborted: 0 });
      const color = text.startsWith("TASKS running") || text.startsWith("TASKS starting") ? "warning" : result.isError ? "error" : "success";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });

  pi.registerTool({
    name: "tasks",
    label: "Tasks",
    description: "Launch a small inline batch of supervised task agents (escape hatch for ≤4 ad-hoc tasks). For repeated/templated fan-out across many items, use tasks_plan instead.",
    promptSnippet: "Inline tasks() is a small-batch escape hatch (≤4 tasks). Use tasks_plan for fan-out.",
    promptGuidelines: [
      "Prefer tasks_plan over tasks for any repeated/templated fan-out (every chapter, every report, every file).",
      "tasks accepts at most 4 inline tasks and rejects payloads larger than 8000 prompt bytes; oversized inline calls fail fast and point you to tasks_plan.",
      "For N>4 agents, never inline N full prompts as JSON. Use tasks_plan with a matrix + promptTemplate so the model never has to stream a giant tool-call argument.",
      "Give every task a clear name and prompt; use acceptance contracts for required files, regexes, and write boundaries.",
      "The root agent remains responsible for synthesis and for reading batch artifacts when needed.",
    ],
    parameters: TasksParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runTasks(params as TasksToolParams, signal, onUpdate, ctx, "tasks");
    },
    renderCall(args, theme) {
      const taskCount = Array.isArray((args as any).tasks) ? (args as any).tasks.length : 0;
      return new Text(`${theme.fg("toolTitle", theme.bold("tasks "))}${theme.fg("accent", `${taskCount} task${taskCount === 1 ? "" : "s"}`)}`, 0, 0);
    },
    renderResult(result, _opts, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no task result)";
      const color = text.startsWith("TASKS running") || text.startsWith("TASKS starting") ? "warning" : result.isError ? "error" : "success";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });

  pi.registerTool({
    name: "tasks_plan",
    label: "Tasks Plan",
    description: "Launch a fan-out batch of supervised task agents from a compact matrix + promptTemplate. The extension expands the matrix locally into per-row prompts, acceptance contracts, write boundaries, and metadata, then runs them under the same audited supervisor as tasks. Use this for repeated/templated fan-out (every chapter, every report, every file).",
    promptSnippet: "Fan-out tasks via a small matrix + promptTemplate; the extension expands rows locally.",
    promptGuidelines: [
      "Use tasks_plan whenever the same prompt shape repeats across many items (chapters, reports, files, modules, tickets).",
      "Keep matrix rows tiny: id + per-row vars only. Put long shared instructions in promptTemplate, not per row.",
      "Reference row vars with {{key}} in promptTemplate, nameTemplate, cwdTemplate, acceptanceTemplate, and metadataTemplate.",
      "An array-valued var splats into list fields when the entry is exactly {{key}} (e.g. allowedWritePaths: [\"{{allowedWritePaths}}\"]); inside a string template it joins with newlines.",
      "Set acceptanceTemplate.allowedWritePaths to keep each agent on its own files; rows with disjoint paths can run in parallel.",
      "Do NOT add `TASK_STATUS: completed` (or similar log-marker regexes) to acceptanceTemplate.requiredRegex / requiredReportRegex / requiredPaths.requiredRegex. Completion is determined by the structured task-report.json the worker submits, not by log markers; requiring such a marker only produces false negatives.",
      "Do NOT list `task-report.json` or `worker.md` in acceptanceTemplate.requiredPaths — the supervisor writes those itself in the batch artifact directory, and they are not under the task's cwd.",
      "Prefer `requireDeliverablesEvidence: true` and `minReportSummaryChars` in acceptanceTemplate to enforce real completion proof; pair them with `allowedWritePaths` to scope writes per row.",
      "Set synthesis.instructions when the root agent should summarize after the batch finishes.",
    ],
    parameters: TasksPlanParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runTasksPlan(params as unknown as TasksPlanInput, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      const matrix = Array.isArray((args as any).matrix) ? (args as any).matrix : [];
      const batchName = String((args as any).batchName ?? "plan");
      return new Text(`${theme.fg("toolTitle", theme.bold("tasks_plan "))}${theme.fg("accent", `${batchName} · ${matrix.length} task${matrix.length === 1 ? "" : "s"}`)}`, 0, 0);
    },
    renderResult(result, _opts, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no plan result)";
      const color = text.startsWith("TASKS running") || text.startsWith("TASKS starting") || text.startsWith("TASKS plan starting") ? "warning" : result.isError ? "error" : "success";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });
}
