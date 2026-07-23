import assert from "node:assert/strict";
import { test } from "node:test";
import { loggerOptions } from "./logger.ts";

test("test workers do not start a pretty-print transport thread", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  assert.ok(!("transport" in loggerOptions));
});
