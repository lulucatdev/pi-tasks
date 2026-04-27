import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AcceptanceCheckResult, AcceptanceContract, AcceptanceOutcome, PathCheck, TaskReport } from "./types.ts";
import {
  auditableWritePaths,
  isSupervisorArtifactPath,
  mergeWriteEvidence,
  writeEvidenceFromGitDiff,
  writeEvidenceFromTelemetry,
  type WriteEvidence,
} from "./write-evidence.ts";

function toPathCheck(value: string | PathCheck): PathCheck {
  return typeof value === "string" ? { path: value, type: "file" } : value;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function normalizePatternPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function hasGlobMagic(pattern: string): boolean {
  return pattern.includes("*");
}

export function matchesPathPattern(candidate: string, pattern: string): boolean {
  const normalized = normalizePatternPath(candidate);
  const normalizedPattern = normalizePatternPath(pattern);
  // Treat trailing slash patterns as directory prefixes. Users naturally write
  // allowedWritePaths: ["src/"] to mean "anything under src"; requiring
  // "src/**" caused false acceptance failures in real batches.
  if (normalizedPattern.endsWith("/")) return normalized.startsWith(normalizedPattern);
  if (!hasGlobMagic(normalizedPattern)) return normalized === normalizedPattern;
  return globToRegExp(normalizedPattern).test(normalized);
}

function matchesPattern(candidate: string, pattern: string): boolean {
  return matchesPathPattern(candidate, pattern);
}

function resolveCandidate(baseCwd: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
}

function compileAcceptanceRegex(pattern: string): { regex: RegExp } | { error: string } {
  let source = pattern;
  const flags = new Set("m");
  const inlineFlags = source.match(/^\(\?([imsu]+)\)/i);
  if (inlineFlags) {
    for (const flag of inlineFlags[1]!.toLowerCase()) flags.add(flag);
    source = source.slice(inlineFlags[0].length);
  }
  try {
    return { regex: new RegExp(source, [...flags].join("")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(absolute, relative));
    else files.push(relative);
  }
  return files;
}

async function readIfFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

async function checkRequiredPath(baseCwd: string, check: PathCheck): Promise<AcceptanceCheckResult[]> {
  const results: AcceptanceCheckResult[] = [];
  if (check.type === "glob") {
    const matches = (await walkFiles(baseCwd)).filter((file) => matchesPattern(file, check.path));
    if (matches.length === 0) return [{ name: "requiredPaths.glob", status: "failed", path: check.path, message: "Required glob matched no files." }];
    for (const match of matches) {
      const nested = await checkRequiredPath(baseCwd, { ...check, path: match, type: "file" });
      if (nested.every((item) => item.status === "passed")) return [{ name: "requiredPaths.glob", status: "passed", path: check.path, message: `Required glob matched ${match}.` }];
      results.push(...nested.map((item) => ({ ...item, path: match })));
    }
    return results.some((item) => item.status === "passed") ? results : [{ name: "requiredPaths.glob", status: "failed", path: check.path, message: "No glob match satisfied the required checks." }, ...results.filter((item) => item.status === "failed")];
  }
  const filePath = resolveCandidate(baseCwd, check.path);
  try {
    const stat = await fs.stat(filePath);
    if (check.type === "dir" && !stat.isDirectory()) {
      results.push({ name: "requiredPaths", status: "failed", path: check.path, message: "Expected a directory." });
      return results;
    }
    if ((check.type ?? "file") === "file" && !stat.isFile()) {
      results.push({ name: "requiredPaths", status: "failed", path: check.path, message: "Expected a file." });
      return results;
    }
    if (check.minBytes !== undefined && stat.size < check.minBytes) {
      results.push({ name: "requiredPaths.minBytes", status: "failed", path: check.path, message: `Expected at least ${check.minBytes} bytes.`, actual: String(stat.size) });
    }
    if (stat.isFile() && (check.requiredRegex?.length || check.forbiddenRegex?.length)) {
      const text = await readIfFile(filePath);
      for (const pattern of check.requiredRegex ?? []) {
        const compiled = compileAcceptanceRegex(pattern);
        if ("error" in compiled) results.push({ name: "requiredPaths.requiredRegex", status: "failed", path: check.path, message: `Invalid required regex ${pattern}: ${compiled.error}` });
        else if (!compiled.regex.test(text)) results.push({ name: "requiredPaths.requiredRegex", status: "failed", path: check.path, message: `Required regex did not match: ${pattern}` });
      }
      for (const pattern of check.forbiddenRegex ?? []) {
        const compiled = compileAcceptanceRegex(pattern);
        if ("error" in compiled) results.push({ name: "requiredPaths.forbiddenRegex", status: "failed", path: check.path, message: `Invalid forbidden regex ${pattern}: ${compiled.error}` });
        else if (compiled.regex.test(text)) results.push({ name: "requiredPaths.forbiddenRegex", status: "failed", path: check.path, message: `Forbidden regex matched: ${pattern}` });
      }
    }
    if (results.length === 0) results.push({ name: "requiredPaths", status: "passed", path: check.path, message: "Required path exists." });
  } catch {
    results.push({ name: "requiredPaths", status: "failed", path: check.path, message: "Required path is missing." });
  }
  return results;
}

export interface EvaluateAcceptanceInput {
  contract?: AcceptanceContract;
  cwd: string;
  workerLog?: string;
  report?: TaskReport;
  changedFiles?: string[];
  observedWritePaths?: string[];
  writeEvidence?: WriteEvidence[];
  writeAuditAvailable?: boolean;
}

function addRegexChecks(results: AcceptanceCheckResult[], name: string, text: string, required: string[] = [], forbidden: string[] = []): void {
  for (const pattern of required) {
    const compiled = compileAcceptanceRegex(pattern);
    if ("error" in compiled) {
      results.push({ name: `${name}.requiredRegex`, status: "failed", message: `Invalid required regex ${pattern}: ${compiled.error}` });
      continue;
    }
    const ok = compiled.regex.test(text);
    results.push({ name: `${name}.requiredRegex`, status: ok ? "passed" : "failed", message: ok ? `Matched required regex: ${pattern}` : `Required regex did not match: ${pattern}` });
  }
  for (const pattern of forbidden) {
    const compiled = compileAcceptanceRegex(pattern);
    if ("error" in compiled) {
      results.push({ name: `${name}.forbiddenRegex`, status: "failed", message: `Invalid forbidden regex ${pattern}: ${compiled.error}` });
      continue;
    }
    const matched = compiled.regex.test(text);
    results.push({ name: `${name}.forbiddenRegex`, status: matched ? "failed" : "passed", message: matched ? `Forbidden regex matched: ${pattern}` : `Forbidden regex did not match: ${pattern}` });
  }
}

function addChangedFileChecks(results: AcceptanceCheckResult[], contract: AcceptanceContract, changedFiles: string[]): void {
  const auditableFiles = changedFiles.filter((file) => !isSupervisorArtifactPath(file));
  for (const pattern of contract.forbiddenWritePaths ?? contract.forbiddenPaths ?? []) {
    for (const file of auditableFiles) {
      if (matchesPattern(file, pattern)) results.push({ name: "forbiddenWritePaths", status: "failed", path: file, expected: pattern, message: `Changed file matches forbidden pattern: ${pattern}` });
    }
  }

  if (contract.allowedWritePaths?.length) {
    for (const file of auditableFiles) {
      if (!contract.allowedWritePaths.some((pattern) => matchesPattern(file, pattern))) {
        results.push({ name: "allowedWritePaths", status: "failed", path: file, message: "Changed file is outside allowed write paths." });
      }
    }
  }
}

export async function evaluateAcceptance(input: EvaluateAcceptanceInput): Promise<AcceptanceOutcome> {
  const contract = input.contract;
  if (!contract) return { status: "skipped", checks: [], warnings: [], errors: [] };

  const checks: AcceptanceCheckResult[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const workerLog = input.workerLog ?? "";
  const reportText = input.report ? `${input.report.summary}\n${JSON.stringify(input.report.deliverables)}\n${JSON.stringify(input.report.evidence)}` : "";

  for (const requiredPath of contract.requiredPaths ?? []) {
    checks.push(...await checkRequiredPath(input.cwd, toPathCheck(requiredPath)));
  }

  for (const forbiddenPath of contract.forbiddenPaths ?? []) {
    try {
      await fs.stat(resolveCandidate(input.cwd, forbiddenPath));
      checks.push({ name: "forbiddenPaths", status: "failed", path: forbiddenPath, message: "Forbidden path exists." });
    } catch {
      checks.push({ name: "forbiddenPaths", status: "passed", path: forbiddenPath, message: "Forbidden path is absent." });
    }
  }

  if (contract.minWorkerLogBytes !== undefined && Buffer.byteLength(workerLog, "utf-8") < contract.minWorkerLogBytes) {
    checks.push({ name: "minWorkerLogBytes", status: "failed", message: `Worker log is shorter than ${contract.minWorkerLogBytes} bytes.` });
  }

  if (contract.minReportSummaryChars !== undefined && (input.report?.summary.length ?? 0) < contract.minReportSummaryChars) {
    checks.push({ name: "minReportSummaryChars", status: "failed", message: `Report summary is shorter than ${contract.minReportSummaryChars} chars.` });
  }

  addRegexChecks(checks, "workerLog", workerLog, contract.requiredOutputRegex, contract.forbiddenOutputRegex);
  addRegexChecks(checks, "report", reportText, contract.requiredReportRegex, contract.forbiddenReportRegex);

  if (contract.requireDeliverablesEvidence) {
    const deliverables = input.report?.deliverables ?? [];
    const evidenceValues = (input.report?.evidence ?? []).map((item) => item.value).filter((value) => typeof value === "string" && value.trim());
    for (const deliverable of deliverables) {
      const kind = deliverable.kind;
      if (kind === "file" || kind === "dir") {
        const filePath = resolveCandidate(input.cwd, deliverable.path);
        try {
          const stat = await fs.stat(filePath);
          if (kind === "file" && !stat.isFile()) {
            checks.push({ name: "requireDeliverablesEvidence", status: "failed", path: deliverable.path, message: "Declared file deliverable is not a file." });
          } else if (kind === "dir" && !stat.isDirectory()) {
            checks.push({ name: "requireDeliverablesEvidence", status: "failed", path: deliverable.path, message: "Declared dir deliverable is not a directory." });
          } else if (kind === "file" && stat.size === 0) {
            checks.push({ name: "requireDeliverablesEvidence", status: "failed", path: deliverable.path, message: "Declared file deliverable is empty." });
          } else {
            checks.push({ name: "requireDeliverablesEvidence", status: "passed", path: deliverable.path, message: "Deliverable exists." });
          }
        } catch {
          checks.push({ name: "requireDeliverablesEvidence", status: "failed", path: deliverable.path, message: "Declared deliverable is missing on disk." });
        }
      } else if (evidenceValues.length === 0) {
        checks.push({ name: "requireDeliverablesEvidence", status: "failed", path: deliverable.path, message: `Non-file deliverable (${kind}) requires at least one evidence entry.` });
      } else {
        checks.push({ name: "requireDeliverablesEvidence", status: "passed", path: deliverable.path, message: "Non-file deliverable acknowledged with evidence entry." });
      }
    }
  }

  const hasWriteBoundary = Boolean(contract.allowedWritePaths?.length || contract.forbiddenWritePaths?.length);
  if (hasWriteBoundary && input.writeAuditAvailable === false) {
    checks.push({ name: "writeAudit", status: "failed", message: "Write-boundary contract requires write audit, but no git diff or worker telemetry was available." });
  }
  const writeEvidence = mergeWriteEvidence([
    ...(input.writeEvidence ?? []),
    ...writeEvidenceFromGitDiff(input.changedFiles ?? []),
    ...writeEvidenceFromTelemetry(input.observedWritePaths ?? []),
  ]);
  addChangedFileChecks(checks, contract, auditableWritePaths(writeEvidence));

  const failedChecks = checks.filter((check) => check.status === "failed");
  if (failedChecks.length > 0) {
    const messages = failedChecks.map((check) => check.path ? `${check.path}: ${check.message}` : check.message);
    if (contract.auditOnly) {
      warnings.push(...messages);
      return { status: "warning", checks, warnings, errors };
    }
    errors.push(...messages);
    return { status: "failed", checks, warnings, errors };
  }

  return { status: "passed", checks, warnings, errors };
}
