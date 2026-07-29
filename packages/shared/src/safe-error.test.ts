import assert from "node:assert/strict";
import { test } from "node:test";
import {
  safeErrorMessage,
  safeErrorSerializer,
  sanitizeOperationalError,
} from "./safe-error.ts";

test("operational errors redact SQL, parameters, stacks, and user content", () => {
  const secret = "用户答案：光合作用会产生氧气";
  const error = Object.assign(
    new Error(`Failed query: insert into validation_submissions params: ${secret}`),
    {
      name: "DrizzleQueryError",
      code: "23505",
      cause: new Error(`provider response contained ${secret}`),
    },
  );
  error.stack = `Error: ${secret}\n at secret-handler.ts:10:2`;

  const projected = sanitizeOperationalError(error);
  const persisted = safeErrorMessage(error);
  const logged = JSON.stringify(safeErrorSerializer(error));

  assert.deepEqual(projected, {
    category: "database",
    name: "DrizzleQueryError",
    code: "23505",
  });
  assert.equal(persisted, "operational_error:database:DrizzleQueryError:23505");
  for (const output of [persisted, logged]) {
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("insert into"));
    assert.ok(!output.includes("params"));
    assert.ok(!output.includes("secret-handler"));
  }
});

test("safe error messages are idempotent", () => {
  const message = "operational_error:timeout:HandlerTimeoutError";
  assert.equal(safeErrorMessage(message), message);
  assert.deepEqual(sanitizeOperationalError(message), {
    category: "timeout",
    name: "HandlerTimeoutError",
    code: null,
  });
});

test("unsafe names and codes are bounded instead of copied", () => {
  const error = {
    name: "Error\nsecret payload",
    message: "invalid provider output with private content",
    code: "BAD CODE: private",
  };
  assert.deepEqual(sanitizeOperationalError(error), {
    category: "validation",
    name: "Error",
    code: null,
  });
});
