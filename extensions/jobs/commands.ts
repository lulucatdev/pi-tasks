import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const JOBS_START_GUIDANCE = [
  "Use `job` / `jobs` for the next stretch of work when isolated job workers would help.",
  "",
  "- The root agent stays responsible for planning, orchestration, and synthesis.",
  "- Use `jobs` when work can be split into parallel leaf job workers.",
  "- Use `job` when exactly one isolated job worker is enough.",
  "- Give jobs clear names and acceptance criteria when useful for audit.",
  "- Do not try to create nested jobs from inside a job worker.",
].join("\n");

function buildJobsStartText(description: string): string {
  const trimmed = description.trim();
  return trimmed ? `${JOBS_START_GUIDANCE}\n\nUser request:\n${trimmed}` : JOBS_START_GUIDANCE;
}

export function registerJobsStartCommand(pi: ExtensionAPI): void {
  pi.registerCommand("jobs-start", {
    description: "Insert job-oriented guidance into the editor without starting a turn",
    handler: async (args, ctx) => {
      const text = buildJobsStartText(args);
      const ui = ctx.ui as any;
      if (ctx.hasUI && typeof ui.pasteToEditor === "function") {
        ui.pasteToEditor(text);
        ctx.ui.notify("Job guidance inserted into the editor.", "info");
        return;
      }
      if (ctx.hasUI && typeof ui.setEditorText === "function") {
        ui.setEditorText(text);
        ctx.ui.notify("Job guidance loaded into the editor.", "info");
        return;
      }
      ctx.ui.notify(text, "info");
    },
  });
}
