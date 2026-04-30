import test from "node:test";
import assert from "node:assert/strict";

import { isTerminalAssistantMessage, resolveJobResultStatus } from "../../extensions/jobs/runtime-status.ts";

test("terminal assistant detection ignores tool-use turns and non-assistant messages", () => {
  assert.equal(isTerminalAssistantMessage({ role: "assistant", stopReason: "toolUse" }), false);
  assert.equal(isTerminalAssistantMessage({ role: "assistant", stopReason: "stop" }), true);
  assert.equal(isTerminalAssistantMessage({ role: "user", stopReason: "stop" }), false);
});

test("legacy runtime status helper keeps historical behavior isolated from the new supervisor", () => {
  const status = resolveJobResultStatus({
    wasAborted: false,
    exitCode: 1,
    stopReason: "stop",
    sawTerminalAssistantMessage: true,
  });

  assert.equal(status, "success");
});
