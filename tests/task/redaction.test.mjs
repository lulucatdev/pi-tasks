import test from "node:test";
import assert from "node:assert/strict";

import { previewToolInput } from "../../extensions/task/redaction.ts";
import { extractDisplayItems } from "../../extensions/task/task-output.ts";

test("previewToolInput hides freeform string input", () => {
  assert.equal(previewToolInput("Authorization: Bearer abc"), '"[STRING_INPUT]"');
});

test("previewToolInput sorts keys and redacts sensitive structured fields", () => {
  assert.equal(
    previewToolInput({ token: "abc", nested: { password: "def" }, authorization: "ghi", safe: 1 }),
    '{"authorization":"[REDACTED]","nested":{"password":"[REDACTED]"},"safe":1,"token":"[REDACTED]"}',
  );
});

test("previewToolInput redacts compound credential keys", () => {
  assert.equal(
    previewToolInput({ access_token: "abc", githubToken: "def", secret_key: "ghi", sessionCookie: "jkl" }),
    '{"access_token":"[REDACTED]","githubToken":"[REDACTED]","secret_key":"[REDACTED]","sessionCookie":"[REDACTED]"}',
  );
});

test("previewToolInput truncates long previews", () => {
  assert.match(previewToolInput({ huge: "x".repeat(400) }), /\.\.\.$/);
});

test("previewToolInput handles circular values as unserializable", () => {
  const value = {};
  value.self = value;
  assert.equal(previewToolInput(value), '"[UNSERIALIZABLE_INPUT]"');
});

test("extractDisplayItems stores argsPreview instead of raw tool arguments", () => {
  const items = extractDisplayItems([
    {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "toolCall", name: "bash", id: "1", arguments: { command: "echo hi", token: "secret" } },
      ],
    },
  ]);

  assert.deepEqual(items[0], { type: "text", text: "hello" });
  assert.equal(items[1].type, "toolCall");
  assert.equal(items[1].argsPreview, '{"command":"echo hi","token":"[REDACTED]"}');
  assert.equal(Object.hasOwn(items[1], "arguments"), false);
});
