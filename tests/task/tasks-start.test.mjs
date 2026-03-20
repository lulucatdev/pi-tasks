import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TASKS_START_GUIDANCE,
  TASKS_START_MANUAL_NOTE,
  registerTasksStartCommand,
  runTasksStartCommand,
} from "../../extensions/task/commands.ts";

function createTasksStartHarness({
  root,
  draft = "",
  hasUI = true,
  setFails = false,
  withSet = true,
  withPaste = true,
  withPrint = true,
  pasteCursor = "append",
} = {}) {
  const commands = new Map();
  let editorText = draft;
  let getEditorTextCalls = 0;
  let setAttempts = 0;
  let pasteAttempts = 0;
  const notifications = [];
  const prints = [];
  const sets = [];
  const pastes = [];

  registerTasksStartCommand({
    registerCommand(name, options) {
      commands.set(name, { name, ...options });
    },
  });

  const command = commands.get("tasks-start");
  assert.ok(command, "tasks-start command should be registered");

  const ui = {
    notify(message, type = "info") {
      notifications.push({ message, type });
    },
    getEditorText() {
      getEditorTextCalls += 1;
      return editorText;
    },
    ...(withSet
      ? {
          setEditorText(value) {
            setAttempts += 1;
            if (setFails) throw new Error("set failed");
            sets.push(value);
            editorText = value;
          },
        }
      : {}),
    ...(withPaste
      ? {
          pasteToEditor(value) {
            pasteAttempts += 1;
            pastes.push(value);
            editorText = pasteCursor === "start" ? `${value}${editorText}` : `${editorText}${value}`;
          },
        }
      : {}),
    ...(withPrint
      ? {
          print(value) {
            prints.push(value);
          },
        }
      : {}),
  };

  const ctx = {
    hasUI,
    cwd: root,
    ui,
  };

  return {
    async run() {
      await command.handler("", ctx);
    },
    getEditorText() {
      return editorText;
    },
    getEditorTextCalls() {
      return getEditorTextCalls;
    },
    setAttempts() {
      return setAttempts;
    },
    pasteAttempts() {
      return pasteAttempts;
    },
    notifications,
    prints,
    sets,
    pastes,
  };
}

test("tasks-start sets the full next draft with a blank line via the registered command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-start-"));
  const harness = createTasksStartHarness({ root, draft: "Current draft", hasUI: true, pasteCursor: "start" });

  await harness.run();

  assert.equal(harness.getEditorText(), `Current draft\n\n${TASKS_START_GUIDANCE}`);
  assert.equal(harness.getEditorTextCalls(), 1);
  assert.equal(harness.setAttempts(), 1);
  assert.equal(harness.pasteAttempts(), 0);
  assert.deepEqual(harness.sets, [`Current draft\n\n${TASKS_START_GUIDANCE}`]);
  assert.deepEqual(harness.pastes, []);
  assert.deepEqual(harness.notifications, [{ message: "Tasks guidance inserted.", type: "info" }]);
  assert.deepEqual(harness.prints, []);
});

test("tasks-start does not append a second copy when the canonical block is already trailing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-start-"));
  const harness = createTasksStartHarness({
    root,
    draft: `Current draft\n\n${TASKS_START_GUIDANCE}`,
    hasUI: true,
    pasteCursor: "start",
  });

  await harness.run();

  assert.equal(harness.getEditorText(), `Current draft\n\n${TASKS_START_GUIDANCE}`);
  assert.equal(harness.getEditorTextCalls(), 1);
  assert.equal(harness.setAttempts(), 0);
  assert.equal(harness.pasteAttempts(), 0);
  assert.deepEqual(harness.sets, []);
  assert.deepEqual(harness.pastes, []);
  assert.deepEqual(harness.notifications, [{ message: "Tasks guidance already present.", type: "info" }]);
  assert.deepEqual(harness.prints, []);
});

test("runTasksStartCommand fallback returns exactly the canonical guidance block", async () => {
  const prints = [];

  const result = await runTasksStartCommand({
    pasteSupported: false,
    getDraft: () => "Current draft",
    pasteDraft: () => {
      throw new Error("paste should not run");
    },
    print: (value) => {
      prints.push(value);
    },
  });

  assert.deepEqual(result, { mode: "printed", output: TASKS_START_GUIDANCE });
  assert.deepEqual(prints, [TASKS_START_GUIDANCE]);
});

test("tasks-start prints the canonical block and renders the manual-use note separately when append semantics are unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-start-"));
  const harness = createTasksStartHarness({ root, draft: "Current draft", hasUI: true, withSet: false, withPaste: true, withPrint: true });

  await harness.run();

  assert.equal(harness.getEditorText(), "Current draft");
  assert.equal(harness.getEditorTextCalls(), 0);
  assert.equal(harness.setAttempts(), 0);
  assert.equal(harness.pasteAttempts(), 0);
  assert.deepEqual(harness.prints, [TASKS_START_GUIDANCE]);
  assert.deepEqual(harness.notifications, [
    { message: TASKS_START_MANUAL_NOTE, type: "info" },
    { message: "Tasks guidance printed for manual use.", type: "info" },
  ]);
});

test("tasks-start prints the canonical block and renders the manual-use note separately when setting the draft fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-start-"));
  const harness = createTasksStartHarness({ root, draft: "Current draft", hasUI: true, setFails: true, withPrint: true });

  await harness.run();

  assert.equal(harness.getEditorText(), "Current draft");
  assert.equal(harness.getEditorTextCalls(), 1);
  assert.equal(harness.setAttempts(), 1);
  assert.equal(harness.pasteAttempts(), 0);
  assert.deepEqual(harness.prints, [TASKS_START_GUIDANCE]);
  assert.deepEqual(harness.notifications, [
    { message: TASKS_START_MANUAL_NOTE, type: "info" },
    { message: "Tasks guidance printed for manual use.", type: "info" },
  ]);
});

test("running /tasks-start still leaves <root>/.pi/tasks absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tasks-start-"));
  const harness = createTasksStartHarness({ root, draft: "Current draft", hasUI: true });

  await harness.run();

  await assert.rejects(fs.access(path.join(root, ".pi", "tasks")));
});
