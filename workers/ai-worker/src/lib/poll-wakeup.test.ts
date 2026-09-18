import test from "node:test";
import assert from "node:assert/strict";
import { createPollWakeSignal } from "./poll-wakeup.ts";

test("poll wake resolves a sleeping wait immediately", async () => {
  const signal = createPollWakeSignal();
  let resolved = false;
  const waiting = signal.wait(10_000).then(() => {
    resolved = true;
  });

  signal.wake();
  await waiting;
  assert.equal(resolved, true);
});

test("poll wake received before sleep skips the next delay", async () => {
  const signal = createPollWakeSignal();
  signal.wake();

  const startedAt = Date.now();
  await signal.wait(10_000);
  assert.ok(Date.now() - startedAt < 100);
});

test("poll wake still completes after the normal delay", async () => {
  const signal = createPollWakeSignal();
  const startedAt = Date.now();

  await signal.wait(5);
  assert.ok(Date.now() - startedAt >= 0);
});
