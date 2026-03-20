import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TASKS_GUIDANCE = [
  "Use `task` / `tasks` tools to execute this request with isolated workers.",
  "Plan what needs to be done, then use `tasks` for parallel work or `task` for a single worker.",
  "You are responsible for planning, orchestration, and synthesis. Workers handle execution.",
].join("\n");

export function registerTasksStartCommand(pi: ExtensionAPI): void {
  pi.registerCommand("tasks-start", {
    description: "Plan and execute a request using task workers",
    handler: async (args, _ctx) => {
      const description = args.trim();
      if (!description) {
        pi.sendUserMessage(`${TASKS_GUIDANCE}\n\nWhat would you like me to work on using task workers?`);
        return;
      }

      pi.sendUserMessage(`${TASKS_GUIDANCE}\n\n${description}`);
    },
  });
}
