import test from "node:test";
import assert from "node:assert/strict";

import { registerTasksStartCommand, TASKS_START_GUIDANCE } from "../../extensions/task/commands.ts";

function createHarness({ hasUI = true, paste = true } = {}) {
  const commands = new Map();
  const notifications = [];
  const pasted = [];
  const editorTexts = [];
  const sentMessages = [];

  const pi = {
    registerCommand(name, options) {
      commands.set(name, { name, ...options });
    },
    sendUserMessage(content) {
      sentMessages.push(content);
    },
  };

  registerTasksStartCommand(pi);

  const command = commands.get("tasks-start");
  assert.ok(command, "tasks-start command should be registered");

  const ui = {
    notify(message, type) {
      notifications.push({ message, type });
    },
    setEditorText(text) {
      editorTexts.push(text);
    },
  };
  if (paste) ui.pasteToEditor = (text) => pasted.push(text);

  return {
    async run(args = "") {
      await command.handler(args, { hasUI, ui });
    },
    notifications,
    pasted,
    editorTexts,
    sentMessages,
  };
}

test("tasks-start inserts guidance and request into the editor", async () => {
  const h = createHarness();
  await h.run("fix the login bug");

  assert.equal(h.pasted.length, 1);
  assert.ok(h.pasted[0].includes(TASKS_START_GUIDANCE));
  assert.ok(h.pasted[0].includes("fix the login bug"));
  assert.equal(h.sentMessages.length, 0);
});

test("tasks-start falls back to setEditorText when pasteToEditor is unavailable", async () => {
  const h = createHarness({ paste: false });
  await h.run("");

  assert.equal(h.editorTexts.length, 1);
  assert.equal(h.editorTexts[0], TASKS_START_GUIDANCE);
  assert.equal(h.sentMessages.length, 0);
});

test("tasks-start prints guidance through notify without UI", async () => {
  const h = createHarness({ hasUI: false, paste: false });
  await h.run("   ");

  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].message, TASKS_START_GUIDANCE);
  assert.equal(h.sentMessages.length, 0);
});
