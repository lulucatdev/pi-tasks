import test from "node:test";
import assert from "node:assert/strict";

import { inspectLegacyOutputMarker } from "../../extensions/task/output-marker.ts";

test("legacy marker inspection reports empty and missing markers", () => {
  assert.deepEqual(inspectLegacyOutputMarker("").status, "missing");
  const missing = inspectLegacyOutputMarker("# Work\nstarted only");
  assert.equal(missing.status, "missing");
  assert.match(missing.errors.join("\n"), /No standalone TASK_STATUS/);
});

test("legacy marker inspection requires final standalone marker line", () => {
  const result = inspectLegacyOutputMarker("TASK_STATUS: completed\n\nTODO: continue");
  assert.equal(result.status, "invalid");
  assert.ok(result.warnings.some((warning) => warning.includes("Final non-empty line")));
});

test("legacy marker inspection detects multiple and non-standalone markers", () => {
  const result = inspectLegacyOutputMarker("Mention TASK_STATUS: completed inline\nTASK_STATUS: partial\nTASK_STATUS: completed");
  assert.equal(result.status, "completed");
  assert.equal(result.markerCount, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("outside a standalone")));
  assert.ok(result.warnings.some((warning) => warning.includes("Multiple")));
});

test("legacy marker inspection detects short stub-like completed output", () => {
  const result = inspectLegacyOutputMarker("已开始处理\nTASK_STATUS: completed");
  assert.equal(result.status, "completed");
  assert.ok(result.stubWarnings.length > 0);
});
