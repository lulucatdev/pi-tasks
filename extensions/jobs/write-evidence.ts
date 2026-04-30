export type WriteEvidenceSource = "git_diff" | "worker_telemetry";
export type WriteEvidenceConfidence = "high" | "medium" | "low";

export interface WriteEvidence {
  path: string;
  source: WriteEvidenceSource;
  jobId?: string;
  attemptId?: string;
  confidence: WriteEvidenceConfidence;
  ignored?: boolean;
  reason?: string;
}

export interface WriteEvidenceContext {
  jobId?: string;
  attemptId?: string;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isSupervisorArtifactPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized.startsWith(".pi/jobs/") || normalized.includes("/.pi/jobs/");
}

function buildEvidence(path: string, source: WriteEvidenceSource, confidence: WriteEvidenceConfidence, ctx: WriteEvidenceContext = {}): WriteEvidence {
  const normalized = normalizePath(path);
  const ignored = isSupervisorArtifactPath(normalized);
  return {
    path: normalized,
    source,
    jobId: ctx.jobId,
    attemptId: ctx.attemptId,
    confidence,
    ignored,
    reason: ignored ? "supervisor_artifact" : undefined,
  };
}

export function writeEvidenceFromGitDiff(files: string[], ctx: WriteEvidenceContext = {}): WriteEvidence[] {
  return files.map((file) => buildEvidence(file, "git_diff", "medium", ctx));
}

export function writeEvidenceFromTelemetry(paths: string[], ctx: WriteEvidenceContext = {}): WriteEvidence[] {
  return paths.map((file) => buildEvidence(file, "worker_telemetry", "high", ctx));
}

export function mergeWriteEvidence(evidence: WriteEvidence[]): WriteEvidence[] {
  const byKey = new Map<string, WriteEvidence>();
  for (const item of evidence) {
    const key = `${item.source}\0${item.jobId ?? ""}\0${item.attemptId ?? ""}\0${item.path}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

export function auditableWriteEvidence(evidence: WriteEvidence[]): WriteEvidence[] {
  return evidence.filter((item) => item.path.trim() && !item.ignored && !isSupervisorArtifactPath(item.path));
}

export function auditableWritePaths(evidence: WriteEvidence[]): string[] {
  return [...new Set(auditableWriteEvidence(evidence).map((item) => item.path))];
}
