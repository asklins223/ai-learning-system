/**
 * Tests for markJobDead — forces a job to dead state for non-retryable errors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markJobDead,
  MAX_ATTEMPTS,
  type ClaimedJob,
  type QueueJobUpdate,
  type QueueJobUpdater,
} from "../queue.ts";

const baseJob: ClaimedJob = {
  id: "22222222-2222-2222-2222-222222222222",
  type: "generate_card",
  payload: { noteVersionId: "nv-1" },
  workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  requestedBy: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  attempts: 0,
  leaseToken: "lease-dead-test",
};

function createRecordingUpdater(shouldSucceed = true): {
  updater: QueueJobUpdater;
  updates: QueueJobUpdate[];
} {
  const updates: QueueJobUpdate[] = [];
  const updater: QueueJobUpdater = async (update) => {
    updates.push(update);
    return shouldSucceed;
  };
  return { updater, updates };
}

test("markJobDead forces dead state on first attempt (attempts=0)", async () => {
  const { updater, updates } = createRecordingUpdater(true);
  const now = new Date("2026-07-20T05:14:22.000Z");

  const transition = await markJobDead(baseJob, "overdue-payment", updater, () => now);

  assert.equal(transition.updated, true);
  assert.equal(transition.status, "dead");
  assert.equal(transition.attempts, MAX_ATTEMPTS);
  assert.equal(transition.backoffMs, 0);

  assert.equal(updates.length, 1);
  const update = updates[0];
  assert.equal(update.values.status, "failed"); // triggers max_attempts=1 in SQL function
  assert.equal(update.values.attempts, MAX_ATTEMPTS);
  assert.equal(update.values.lastError, "operational_error:billing:Error");
  assert.equal(update.values.leaseToken, null);
  assert.equal(update.values.startedAt, null);
  assert.deepEqual(update.values.finishedAt, now);
  // fence conditions preserved
  assert.equal(update.fence.leaseToken, "lease-dead-test");
  assert.equal(update.fence.status, "running");
});

test("markJobDead on a job that already exhausted attempts", async () => {
  const { updater, updates } = createRecordingUpdater(true);
  const exhaustedJob = { ...baseJob, attempts: MAX_ATTEMPTS - 1 };

  const transition = await markJobDead(exhaustedJob, "auth error", updater);

  assert.equal(transition.status, "dead");
  assert.equal(transition.attempts, MAX_ATTEMPTS);
  assert.equal(updates[0].values.attempts, MAX_ATTEMPTS);
});

test("markJobDead returns updated=false when lease was already reaped", async () => {
  const { updater } = createRecordingUpdater(false);

  const transition = await markJobDead(baseJob, "overdue-payment", updater);

  assert.equal(transition.updated, false);
  assert.equal(transition.status, "dead"); // application-layer expectation
});

test("markJobDead clears leaseToken and startedAt", async () => {
  const { updater, updates } = createRecordingUpdater(true);

  await markJobDead(baseJob, "unauthorized", updater);

  assert.equal(updates[0].values.leaseToken, null);
  assert.equal(updates[0].values.startedAt, null);
});
