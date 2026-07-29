import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HandlerTimeoutError,
  runWithAbortBudget,
} from "../lib/handler-timeout.ts";

test("nested timeout aborts the child without aborting its parent", async () => {
  const parent = new AbortController();
  let childAborted = false;

  await assert.rejects(
    runWithAbortBudget(
      (signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          childAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      parent.signal,
      10,
    ),
    HandlerTimeoutError,
  );

  assert.equal(childAborted, true);
  assert.equal(parent.signal.aborted, false);
});

test("parent cancellation propagates to a nested provider call", async () => {
  const parent = new AbortController();
  const reason = new Error("outer lease expired");
  const running = runWithAbortBudget(
    (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    parent.signal,
    1_000,
  );

  parent.abort(reason);
  await assert.rejects(running, (error) => error === reason);
});

test("successful nested operation clears its deadline", async () => {
  const parent = new AbortController();
  const result = await runWithAbortBudget(
    async (signal) => {
      assert.equal(signal.aborted, false);
      return "ok";
    },
    parent.signal,
    1_000,
  );
  assert.equal(result, "ok");
});
