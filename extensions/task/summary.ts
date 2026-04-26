import * as fs from "node:fs/promises";
import type { BatchArtifact, TaskArtifact, TasksToolParams } from "./types.ts";

function statusIcon(status: string | null): string {
  if (status === "success") return "OK";
  if (status === "aborted") return "ABORTED";
  if (status === "error") return "ERROR";
  return "PENDING";
}

export function buildSummaryMarkdown(batch: BatchArtifact, tasks: TaskArtifact[], params?: TasksToolParams): string {
  const lines: string[] = [];
  lines.push(`# Tasks Batch ${batch.batchId}`);
  lines.push("");
  lines.push(`- Status: ${batch.status}`);
  lines.push(`- Audit integrity: ${batch.auditIntegrity}`);
  lines.push(`- Started: ${batch.startedAt}`);
  lines.push(`- Finished: ${batch.finishedAt ?? "-"}`);
  lines.push(`- Artifacts: ${batch.batchDir}`);
  lines.push(`- Inspect: /tasks-ui ${batch.batchId}`);
  if (batch.summary.error > 0) lines.push(`- Rerun failed: /tasks-ui rerun failed ${batch.batchId}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total: ${batch.summary.total}`);
  lines.push(`- Success: ${batch.summary.success}`);
  lines.push(`- Error: ${batch.summary.error}`);
  lines.push(`- Aborted: ${batch.summary.aborted}`);
  lines.push(`- Acceptance failed: ${batch.summary.acceptanceFailed}`);
  lines.push(`- Provider transient failed: ${batch.summary.providerTransientFailed}`);
  lines.push(`- Protocol failed: ${batch.summary.protocolFailed}`);
  lines.push(`- Retried: ${batch.summary.retried}`);
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  lines.push("| Task | Status | Attempts | Failure | Error |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const task of tasks) {
    const error = (task.error ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${task.taskId} ${task.name} | ${statusIcon(task.finalStatus)} | ${task.attempts.length} | ${task.failureKind} | ${error || "-"} |`);
  }

  const failed = tasks.filter((task) => task.finalStatus !== "success");
  if (failed.length > 0) {
    lines.push("");
    lines.push("## Failed Tasks");
    for (const task of failed) {
      lines.push("");
      lines.push(`### ${task.taskId} ${task.name}`);
      lines.push(`- Failure kind: ${task.failureKind}`);
      lines.push(`- Retryability: ${task.retryability}`);
      if (task.error) lines.push(`- Error: ${task.error}`);
      if (task.acceptance.errors.length) lines.push(`- Acceptance errors: ${task.acceptance.errors.join("; ")}`);
      const last = task.attempts.at(-1);
      if (last) {
        lines.push(`- Last worker log: ${last.workerLogPath}`);
        lines.push(`- Last stderr: ${last.stderrPath}`);
        lines.push(`- Last report: ${last.reportPath}`);
      }
    }
  }

  if (params && failed.length > 0) {
    lines.push("");
    lines.push("## Suggested Rerun Payload");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify({ ...params, tasks: params.tasks.filter((task) => failed.some((failedTask) => failedTask.name === task.name)) }, null, 2));
    lines.push("```");
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeSummaryMarkdown(filePath: string, batch: BatchArtifact, tasks: TaskArtifact[], params?: TasksToolParams): Promise<void> {
  await fs.writeFile(filePath, buildSummaryMarkdown(batch, tasks, params), "utf-8");
}
