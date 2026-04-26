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
import { buildResultText } from "./run-tasks.ts";
import { executeSupervisedTasks } from "./supervisor.ts";
import { listBatches, loadBatchDetail, renderAttemptDetailLines, renderBatchDetailLines, renderBatchListLines, renderTaskDetailLines, renderTasksUiHelpLines, resolveBatchDir } from "./task-ui.ts";
import { registerTaskReportTool } from "./task-report-tool.ts";
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
  audit: Type.Optional(Type.Object({ level: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("full")])) })),
  acceptanceDefaults: Type.Optional(AcceptanceSchema),
  parentBatchId: Type.Optional(Type.String()),
  rerunOfTaskIds: Type.Optional(Type.Array(Type.String())),
});

function modelId(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model?.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

async function runTasks(params: TasksToolParams, signal: AbortSignal | undefined, onUpdate: ((partialResult: any) => void) | undefined, ctx: ExtensionContext, toolName: "task" | "tasks") {
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
      const color = text.startsWith("TASKS running") ? "warning" : result.isError ? "error" : "success";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });

  pi.registerTool({
    name: "tasks",
    label: "Tasks",
    description: "Launch supervised task agents in parallel with structured reports, acceptance checks, audit artifacts, retry, and throttling.",
    promptSnippet: "Launch supervised task agents in one audited batch.",
    promptGuidelines: [
      "Use tasks only when the work can be split into independent leaf task agents.",
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
      const color = text.startsWith("TASKS running") ? "warning" : result.isError ? "error" : "success";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });
}
