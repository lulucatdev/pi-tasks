export type LegacyMarkerStatus = "completed" | "partial" | "blocked" | "error" | "missing" | "invalid";

export interface LegacyMarkerInspection {
  status: LegacyMarkerStatus;
  outputBytes: number;
  markerCount: number;
  finalMarkerLine: string | null;
  warnings: string[];
  errors: string[];
  stubWarnings: string[];
}

const MARKER_LINE_RE = /^\s*JOB_STATUS:\s*(completed|partial|blocked|error)\s*$/i;
const MARKER_ANYWHERE_RE = /JOB_STATUS:\s*(completed|partial|blocked|error)\b/gi;
const DEFAULT_STUB_PHRASES = ["已开始", "准备阅读", "待执行", "进行中", "TODO", "未完成", "started", "in progress"];

export function inspectLegacyOutputMarker(output: string, options: { minNonMarkerChars?: number; stubPhrases?: string[] } = {}): LegacyMarkerInspection {
  const outputBytes = Buffer.byteLength(output, "utf-8");
  const trimmedEnd = output.trimEnd();
  const lines = trimmedEnd ? trimmedEnd.split(/\r?\n/) : [];
  const markerLines = lines
    .map((line, index) => ({ line, index, match: line.match(MARKER_LINE_RE) }))
    .filter((item): item is { line: string; index: number; match: RegExpMatchArray } => Boolean(item.match));
  const anywhereCount = [...output.matchAll(MARKER_ANYWHERE_RE)].length;
  const finalNonEmptyLine = [...lines].reverse().find((line) => line.trim()) ?? null;
  const warnings: string[] = [];
  const errors: string[] = [];
  const stubWarnings: string[] = [];

  if (!trimmedEnd) {
    return { status: "missing", outputBytes, markerCount: 0, finalMarkerLine: null, warnings, errors: ["Output is empty."], stubWarnings };
  }

  if (anywhereCount !== markerLines.length) {
    warnings.push("JOB_STATUS appears outside a standalone marker line.");
  }

  if (markerLines.length === 0) {
    errors.push("No standalone JOB_STATUS marker line found.");
  } else if (markerLines.length > 1) {
    warnings.push(`Multiple JOB_STATUS marker lines found (${markerLines.length}).`);
  }

  const finalMarker = finalNonEmptyLine?.match(MARKER_LINE_RE) ?? null;
  if (!finalMarker) {
    warnings.push("Final non-empty line is not a JOB_STATUS marker.");
  }

  const nonMarkerText = lines.filter((line) => !MARKER_LINE_RE.test(line)).join("\n").trim();
  const minNonMarkerChars = options.minNonMarkerChars ?? 120;
  const phrases = options.stubPhrases ?? DEFAULT_STUB_PHRASES;
  for (const phrase of phrases) {
    if (nonMarkerText.includes(phrase) && nonMarkerText.length < minNonMarkerChars) {
      stubWarnings.push(`Short output contains stub phrase: ${phrase}`);
    }
  }

  if (markerLines.length === 0) {
    return { status: "missing", outputBytes, markerCount: 0, finalMarkerLine: null, warnings, errors, stubWarnings };
  }

  if (!finalMarker) {
    return { status: "invalid", outputBytes, markerCount: markerLines.length, finalMarkerLine: markerLines.at(-1)?.line ?? null, warnings, errors, stubWarnings };
  }

  return {
    status: finalMarker[1].toLowerCase() as LegacyMarkerStatus,
    outputBytes,
    markerCount: markerLines.length,
    finalMarkerLine: finalNonEmptyLine,
    warnings,
    errors,
    stubWarnings,
  };
}
