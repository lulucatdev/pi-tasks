import * as fs from "node:fs/promises";
import { deriveJobView, summarizeJobs } from "./job-view.ts";
import type { BatchArtifact, JobArtifact, JobsToolParams } from "./types.ts";

function statusIcon(status: string | null): string {
  if (status === "success") return "OK";
  if (status === "aborted") return "ABORTED";
  if (status === "error") return "ERROR";
  return "PENDING";
}

export function buildSummaryMarkdown(batch: BatchArtifact, jobs: JobArtifact[], params?: JobsToolParams): string {
  const materializedSummary = summarizeJobs(jobs);
  const lines: string[] = [];
  lines.push(`# Jobs Batch ${batch.batchId}`);
  lines.push("");
  lines.push(`- Status: ${batch.status}`);
  lines.push(`- Audit integrity: ${batch.auditIntegrity}`);
  lines.push(`- Started: ${batch.startedAt}`);
  lines.push(`- Finished: ${batch.finishedAt ?? "-"}`);
  lines.push(`- Artifacts: ${batch.batchDir}`);
  lines.push(`- Inspect: /jobs-ui ${batch.batchId}`);
  if (materializedSummary.error > 0) lines.push(`- Rerun failed: /jobs-ui rerun failed ${batch.batchId}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total: ${materializedSummary.total}`);
  lines.push(`- Success: ${materializedSummary.success}`);
  lines.push(`- Error: ${materializedSummary.error}`);
  lines.push(`- Aborted: ${materializedSummary.aborted}`);
  lines.push(`- Acceptance failed: ${materializedSummary.acceptanceFailed}`);
  lines.push(`- Provider transient failed: ${materializedSummary.providerTransientFailed}`);
  lines.push(`- Protocol failed: ${materializedSummary.protocolFailed}`);
  lines.push(`- Retried: ${materializedSummary.retried}`);
  lines.push("");
  lines.push("## Jobs");
  lines.push("");
  lines.push("| Job | Status | Attempts | Failure | Error |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const job of jobs) {
    const view = deriveJobView(job);
    const error = (job.error ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${job.jobId} ${job.name} | ${statusIcon(view.finalStatus)} | ${view.attempts} | ${view.failureKind} | ${error || "-"} |`);
  }

  const failed = jobs.filter((job) => deriveJobView(job).finalStatus !== "success");
  if (failed.length > 0) {
    lines.push("");
    lines.push("## Failed Jobs");
    for (const job of failed) {
      lines.push("");
      lines.push(`### ${job.jobId} ${job.name}`);
      const view = deriveJobView(job);
      lines.push(`- Failure kind: ${view.failureKind}`);
      lines.push(`- Retryability: ${view.retryability}`);
      if (job.error) lines.push(`- Error: ${job.error}`);
      if (job.acceptance.errors.length) lines.push(`- Acceptance errors: ${job.acceptance.errors.join("; ")}`);
      const last = job.attempts.at(-1);
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
    const { jobs: rerunJobs, ...rest } = params;
    lines.push(JSON.stringify({ ...rest, jobs: rerunJobs.filter((job) => failed.some((failedJob) => failedJob.name === job.name)) }, null, 2));
    lines.push("```");
  }

  lines.push("");
  return lines.join("\n");
}

export async function writeSummaryMarkdown(filePath: string, batch: BatchArtifact, jobs: JobArtifact[], params?: JobsToolParams): Promise<void> {
  await fs.writeFile(filePath, buildSummaryMarkdown(batch, jobs, params), "utf-8");
}
