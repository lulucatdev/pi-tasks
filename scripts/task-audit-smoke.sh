#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_PATH="$ROOT_DIR/extensions/task/index.ts"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/task-audit-smoke.XXXXXX")"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  echo "task audit smoke failed: $1" >&2
  exit 1
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$message (expected $expected, got $actual)"
  fi
}

snapshot_batches() {
  local output_path="$1"
  if [ -d "$WORK_DIR/.pi/tasks" ]; then
    find "$WORK_DIR/.pi/tasks" -mindepth 1 -maxdepth 1 -type d | sort >"$output_path"
  else
    : >"$output_path"
  fi
}

batch_count() {
  local snapshot_path="$WORK_DIR/.pi-batches.count"
  snapshot_batches "$snapshot_path"
  wc -l <"$snapshot_path" | tr -d '[:space:]'
}

find_new_batch() {
  local before_path="$1"
  local after_path="$2"
  local label="$3"
  local delta_path="$WORK_DIR/${label}.delta"

  comm -13 "$before_path" "$after_path" | sed '/^$/d' >"$delta_path"
  assert_eq "$(wc -l <"$delta_path" | tr -d '[:space:]')" "1" "expected exactly one new batch after $label"
  sed -n '1p' "$delta_path"
}

assert_no_new_batch() {
  local before_path="$1"
  local after_path="$2"
  local label="$3"
  local delta_path="$WORK_DIR/${label}.delta"

  comm -13 "$before_path" "$after_path" | sed '/^$/d' >"$delta_path"
  assert_eq "$(wc -l <"$delta_path" | tr -d '[:space:]')" "0" "$label should not create a batch"
}

run_pi_prompt() {
  local label="$1"
  local prompt="$2"
  (
    cd "$WORK_DIR"
    pi --no-extensions -e "$EXTENSION_PATH" -p "$prompt" </dev/null >"$WORK_DIR/${label}.out"
  )
}

assert_batch_contract() {
  local batch_dir="$1"
  local expected_tool="$2"
  local expected_task_count="$3"

  node - "$batch_dir" "$expected_tool" "$expected_task_count" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [batchDir, expectedTool, expectedTaskCountText] = process.argv.slice(2);
const expectedTaskCount = Number(expectedTaskCountText);

function fail(message) {
  console.error(`task audit smoke failed: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const batchPath = path.join(batchDir, "batch.json");
const eventsPath = path.join(batchDir, "events.jsonl");
const tasksDir = path.join(batchDir, "tasks");

if (!fs.existsSync(batchPath)) fail(`${batchDir} is missing batch.json`);
if (!fs.existsSync(eventsPath)) fail(`${batchDir} is missing events.jsonl`);
if (!fs.existsSync(tasksDir)) fail(`${batchDir} is missing tasks/`);

const batch = readJson(batchPath);
if (batch.schemaVersion !== 1) fail(`${batchDir} schemaVersion expected 1`);
if (batch.toolName !== expectedTool) fail(`${batchDir} toolName expected ${expectedTool}, got ${batch.toolName}`);
if (batch.initialized !== true) fail(`${batchDir} initialized expected true`);
if (batch.status !== "success") fail(`${batchDir} status expected success, got ${batch.status}`);
if (batch.auditIntegrity !== "ok") fail(`${batchDir} auditIntegrity expected ok, got ${batch.auditIntegrity}`);
if (!Array.isArray(batch.taskIds) || batch.taskIds.length !== expectedTaskCount) {
  fail(`${batchDir} taskIds expected ${expectedTaskCount}, got ${Array.isArray(batch.taskIds) ? batch.taskIds.length : "non-array"}`);
}
if (!batch.summary || batch.summary.total !== expectedTaskCount || batch.summary.success !== expectedTaskCount || batch.summary.error !== 0 || batch.summary.aborted !== 0) {
  fail(`${batchDir} summary does not match a ${expectedTaskCount}-task success run`);
}

const eventLines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
const events = eventLines.map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${batchDir} events.jsonl line ${index + 1} is not valid JSON`);
  }
});

const count = (type) => events.filter((event) => event.type === type).length;
if (count("batch_started") !== 1) fail(`${batchDir} expected exactly one batch_started event`);
if (count("task_queued") !== expectedTaskCount) fail(`${batchDir} expected ${expectedTaskCount} task_queued event(s)`);
if (count("task_running") !== expectedTaskCount) fail(`${batchDir} expected ${expectedTaskCount} task_running event(s)`);
if (count("task_finished") !== expectedTaskCount) fail(`${batchDir} expected ${expectedTaskCount} task_finished event(s)`);
if (count("batch_finished") !== 1) fail(`${batchDir} expected exactly one batch_finished event`);

const taskFiles = fs.readdirSync(tasksDir).filter((name) => name.endsWith(".json")).sort();
if (taskFiles.length !== expectedTaskCount) fail(`${batchDir} expected ${expectedTaskCount} task artifact(s), got ${taskFiles.length}`);

for (const taskId of batch.taskIds) {
  if (!taskFiles.includes(`${taskId}.json`)) fail(`${batchDir} is missing tasks/${taskId}.json`);
}

for (const taskFile of taskFiles) {
  const task = readJson(path.join(tasksDir, taskFile));
  if (task.schemaVersion !== 1) fail(`${batchDir}/${taskFile} schemaVersion expected 1`);
  if (task.batchId !== batch.batchId) fail(`${batchDir}/${taskFile} batchId mismatch`);
  if (task.status !== "success") fail(`${batchDir}/${taskFile} status expected success, got ${task.status}`);
  if (typeof task.cwd !== "string" || !path.isAbsolute(task.cwd)) fail(`${batchDir}/${taskFile} cwd should be absolute`);
  if (String(task.finalOutput || "").trim() !== "ok") {
    fail(`${batchDir}/${taskFile} finalOutput expected exactly ok, got ${JSON.stringify(task.finalOutput)}`);
  }
  if (!Array.isArray(task.timeline) || !task.timeline.some((entry) => entry.state === "queued") || !task.timeline.some((entry) => entry.state === "running") || !task.timeline.some((entry) => entry.state === "success")) {
    fail(`${batchDir}/${taskFile} timeline missing queued/running/success states`);
  }
}
NODE
}

command -v pi >/dev/null 2>&1 || fail "pi is required for task audit smoke tests"
command -v node >/dev/null 2>&1 || fail "node is required for task audit smoke tests"

TASK_PROMPT='Call the `task` tool exactly once with name "solo" and task "Return exactly this lowercase ASCII text and nothing else: ok". Then stop after the tool returns.'
TASKS_PROMPT='Call the `tasks` tool exactly once with two workers: name "alpha" with task "Return exactly this lowercase ASCII text and nothing else: ok", and name "beta" with task "Return exactly this lowercase ASCII text and nothing else: ok". Then stop after the tool returns.'
TASKS_START_PROMPT='/tasks-start'

TASK_BEFORE="$WORK_DIR/task.before"
TASK_AFTER="$WORK_DIR/task.after"
snapshot_batches "$TASK_BEFORE"
run_pi_prompt "task" "$TASK_PROMPT"
snapshot_batches "$TASK_AFTER"
TASK_BATCH_DIR="$(find_new_batch "$TASK_BEFORE" "$TASK_AFTER" "task")"
assert_eq "$(batch_count)" "1" "single task run should create one batch"
assert_batch_contract "$TASK_BATCH_DIR" "task" "1"

TASKS_BEFORE="$WORK_DIR/tasks.before"
TASKS_AFTER="$WORK_DIR/tasks.after"
snapshot_batches "$TASKS_BEFORE"
run_pi_prompt "tasks" "$TASKS_PROMPT"
snapshot_batches "$TASKS_AFTER"
TASKS_BATCH_DIR="$(find_new_batch "$TASKS_BEFORE" "$TASKS_AFTER" "tasks")"
assert_eq "$(batch_count)" "2" "single-task plus multi-task runs should create two batches"
assert_batch_contract "$TASKS_BATCH_DIR" "tasks" "2"

TASKS_START_BEFORE="$WORK_DIR/tasks-start.before"
TASKS_START_AFTER="$WORK_DIR/tasks-start.after"
snapshot_batches "$TASKS_START_BEFORE"
run_pi_prompt "tasks-start" "$TASKS_START_PROMPT"
snapshot_batches "$TASKS_START_AFTER"
assert_no_new_batch "$TASKS_START_BEFORE" "$TASKS_START_AFTER" "/tasks-start"
assert_eq "$(batch_count)" "2" "/tasks-start should not create a third batch"

echo "task audit smoke passed"
