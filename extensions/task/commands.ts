import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export const TASKS_START_GUIDANCE = [
  "Use `task` / `tasks` for the next stretch of work when isolated workers would help.",
  "",
  "- The root agent stays responsible for planning, orchestration, and synthesis.",
  "- Use `tasks` when work can be split into parallel leaf workers.",
  "- Use `task` when exactly one isolated worker is enough.",
  "- Give tasks clear names when helpful for attribution and audit.",
  "- Do not try to create nested tasks from inside a task worker.",
].join("\n");

export const TASKS_START_MANUAL_NOTE = "You can send or reuse this block manually.";

export interface TasksStartDriver {
  appendSupported?: boolean;
  pasteSupported?: boolean;
  getDraft: () => string;
  setDraft?: (value: string) => void | Promise<void>;
  pasteDraft?: (value: string) => void | Promise<void>;
  print: (value: string) => void | Promise<void>;
}

export type TasksStartCommandResult =
  | {
      mode: "inserted";
      changed: boolean;
      nextDraft: string;
    }
  | {
      mode: "printed";
      output: string;
    };

export function appendTasksStartGuidance(existingDraft: string): { changed: boolean; value: string } {
  const normalized = existingDraft.endsWith("\n") ? existingDraft.slice(0, -1) : existingDraft;
  if (normalized.endsWith(TASKS_START_GUIDANCE)) {
    return { changed: false, value: existingDraft };
  }

  const separator = normalized ? (normalized === existingDraft ? "\n\n" : "\n") : "";
  return {
    changed: true,
    value: `${existingDraft}${separator}${TASKS_START_GUIDANCE}`,
  };
}

export async function runTasksStartCommand(driver: TasksStartDriver): Promise<TasksStartCommandResult> {
  const appendSupported = (driver.appendSupported ?? driver.pasteSupported) === true && typeof driver.setDraft === "function";
  if (!appendSupported) {
    return printTasksStartFallback(driver);
  }

  try {
    const { changed, value } = appendTasksStartGuidance(driver.getDraft());
    if (changed) {
      await driver.setDraft(value);
    }
    return { mode: "inserted", changed, nextDraft: value };
  } catch {
    return printTasksStartFallback(driver);
  }
}

export function registerTasksStartCommand(pi: ExtensionAPI): void {
  pi.registerCommand("tasks-start", {
    description: "Append task-oriented guidance to the current composer or print it for manual reuse",
    handler: async (_args, ctx) => {
      const result = await runTasksStartCommand(createTasksStartDriver(ctx));
      if (result.mode === "printed") {
        ctx.ui.notify(TASKS_START_MANUAL_NOTE, "info");
        ctx.ui.notify("Tasks guidance printed for manual use.", "info");
        return;
      }

      ctx.ui.notify(result.changed ? "Tasks guidance inserted." : "Tasks guidance already present.", "info");
    },
  });
}

function createTasksStartDriver(ctx: ExtensionCommandContext): TasksStartDriver {
  const ui = ctx.ui as ExtensionCommandContext["ui"] & {
    getEditorText?: () => string;
    setEditorText?: (value: string) => void | Promise<void>;
    print?: (text: string) => void | Promise<void>;
  };

  return {
    appendSupported: ctx.hasUI && typeof ui.getEditorText === "function" && typeof ui.setEditorText === "function",
    getDraft: () => ui.getEditorText!(),
    setDraft: (value) => ui.setEditorText!(value),
    print: (value) => printTasksStartOutput(ctx, value),
  };
}

async function printTasksStartFallback(driver: TasksStartDriver): Promise<TasksStartCommandResult> {
  await driver.print(TASKS_START_GUIDANCE);
  return {
    mode: "printed",
    output: TASKS_START_GUIDANCE,
  };
}

function printTasksStartOutput(ctx: ExtensionCommandContext, value: string): void | Promise<void> {
  const ui = ctx.ui as ExtensionCommandContext["ui"] & { print?: (text: string) => void | Promise<void> };
  if (typeof ui.print === "function") {
    return ui.print(value);
  }

  return ui.notify(value, "info");
}
