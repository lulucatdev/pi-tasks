import test from "node:test";
import assert from "node:assert/strict";

import { registerTasksStartCommand } from "../../extensions/task/commands.ts";

function createHarness() {
  const commands = new Map();
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

  return {
    async run(args = "") {
      await command.handler(args, {});
    },
    sentMessages,
  };
}

test("tasks-start with description sends a user message containing the description", async () => {
  const h = createHarness();
  await h.run("fix the login bug");

  assert.equal(h.sentMessages.length, 1);
  assert.ok(h.sentMessages[0].includes("fix the login bug"));
  assert.ok(h.sentMessages[0].includes("task"));
});

test("tasks-start without description sends a guidance-only message", async () => {
  const h = createHarness();
  await h.run("");

  assert.equal(h.sentMessages.length, 1);
  assert.ok(h.sentMessages[0].includes("task"));
  assert.ok(h.sentMessages[0].includes("What would you like"));
});

test("tasks-start trims whitespace-only args and treats as empty", async () => {
  const h = createHarness();
  await h.run("   ");

  assert.equal(h.sentMessages.length, 1);
  assert.ok(h.sentMessages[0].includes("What would you like"));
});
