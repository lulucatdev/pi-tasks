import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTaskReportTool } from "./task-report-tool.ts";

export default function taskWorkerRuntime(pi: ExtensionAPI): void {
  registerTaskReportTool(pi);
}
