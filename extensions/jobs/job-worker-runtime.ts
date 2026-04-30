import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerJobReportTool } from "./job-report-tool.ts";

export default function jobWorkerRuntime(pi: ExtensionAPI): void {
  registerJobReportTool(pi);
}
