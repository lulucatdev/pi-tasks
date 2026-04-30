import * as fs from "node:fs/promises";
import * as path from "node:path";

const scenario = process.env.FAKE_PI_SCENARIO ?? "completed";
const reportPath = process.env.PI_JOB_REPORT_PATH;
const attemptId = process.env.PI_JOB_ATTEMPT_ID ?? "unknown-attempt";
const jobId = attemptId.split("-a")[0] || "unknown-job";
const attemptDir = reportPath ? path.dirname(reportPath) : process.cwd();
const workerLogPath = path.join(attemptDir, "worker.md");

async function writeReport(status = "completed", overrides = {}) {
  if (!reportPath) return;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(workerLogPath, `${status} worker log`, "utf-8");
  await fs.writeFile(reportPath, JSON.stringify({
    schemaVersion: 1,
    jobId,
    attemptId,
    status,
    summary: `${status} summary`,
    deliverables: [],
    evidence: [],
    internalRetries: [],
    userActionRequired: status === "blocked" ? "User action required" : null,
    error: status === "error" ? "Worker error" : null,
    ...overrides,
  }), "utf-8");
}

function terminal(stopReason = "stop") {
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason } }) + "\n");
}

switch (scenario) {
  case "completed":
    await writeReport("completed");
    terminal("stop");
    process.exit(0);
  case "partial":
    await writeReport("partial");
    terminal("stop");
    process.exit(0);
  case "blocked":
    await writeReport("blocked");
    terminal("stop");
    process.exit(0);
  case "missing-report":
    await fs.writeFile(workerLogPath, "no report", "utf-8");
    terminal("stop");
    process.exit(0);
  case "invalid-json":
    if (reportPath) {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, "{bad", "utf-8");
    }
    terminal("stop");
    process.exit(0);
  case "terminated":
    process.stderr.write("terminated\n");
    process.exit(1);
  case "provider-500":
    process.stderr.write("500 Internal server error\n");
    process.exit(1);
  case "malformed-stdout":
    process.stdout.write("not json\n");
    await writeReport("completed");
    terminal("stop");
    process.exit(0);
  case "delayed":
    await writeReport("completed");
    setTimeout(() => {
      terminal("stop");
      process.exit(0);
    }, 250);
    break;
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(2);
}
