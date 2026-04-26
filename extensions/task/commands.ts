import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const TASKS_START_GUIDANCE = [
  "Use `task` / `tasks` for the next stretch of work when isolated task agents would help.",
  "",
  "- The root agent stays responsible for planning, orchestration, and synthesis.",
  "- Use `tasks` when work can be split into parallel leaf task agents.",
  "- Use `task` when exactly one isolated task agent is enough.",
  "- Give tasks clear names and acceptance criteria when useful for audit.",
  "- Do not try to create nested tasks from inside a task agent.",
].join("\n");

function buildTasksStartText(description: string): string {
  const trimmed = description.trim();
  return trimmed ? `${TASKS_START_GUIDANCE}\n\nUser request:\n${trimmed}` : TASKS_START_GUIDANCE;
}

export function registerTasksStartCommand(pi: ExtensionAPI): void {
  pi.registerCommand("tasks-start", {
    description: "Insert task-oriented guidance into the editor without starting a turn",
    handler: async (args, ctx) => {
      const text = buildTasksStartText(args);
      const ui = ctx.ui as any;
      if (ctx.hasUI && typeof ui.pasteToEditor === "function") {
        ui.pasteToEditor(text);
        ctx.ui.notify("Task guidance inserted into the editor.", "info");
        return;
      }
      if (ctx.hasUI && typeof ui.setEditorText === "function") {
        ui.setEditorText(text);
        ctx.ui.notify("Task guidance loaded into the editor.", "info");
        return;
      }
      ctx.ui.notify(text, "info");
    },
  });
}
