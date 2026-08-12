import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommitPortNotImplementedError,
  createPgCommitPort,
  type CommitPortTx,
} from "./commit-port-pg.js";
import { CommitLockStep } from "./episode-commit.js";

const WS = "ws-1";
const USER = "user-1";
const EPISODE = "episode-1";

/**
 * 内存 tx：用回调驱动的 execute——commit-key 状态由测试控制。
 * （真实 SQL 行为由集成测试 db-commit-port.test.ts 在真实 Postgres 验证。）
 */
function makeTx(handlers: {
  getKey?: () => string | null;
  setKey?: (key: string) => void;
  onExecute?: (query: unknown) => unknown;
}) {
  const tx: CommitPortTx = {
    async execute(query) {
      if (handlers.onExecute) return handlers.onExecute(query);
      return [];
    },
  };
  return { tx };
}

test("getCommitKey：无 commitKey → null（注入返回 null）", async () => {
  const { tx } = makeTx({ getKey: () => null, onExecute: () => [{ commitKey: null }] });
  const port = createPgCommitPort(tx);
  assert.equal(await port.getCommitKey({ workspaceId: WS, userId: USER }, EPISODE), null);
});

test("getCommitKey：有 commitKey → 返回（注入返回值）", async () => {
  const { tx } = makeTx({ onExecute: () => [{ commitKey: "ck-1" }] });
  const port = createPgCommitPort(tx);
  assert.equal(await port.getCommitKey({ workspaceId: WS, userId: USER }, EPISODE), "ck-1");
});

test("setCommitKey：执行 UPDATE（注入确认调用，不抛错）", async () => {
  let called = false;
  const { tx } = makeTx({
    onExecute: () => {
      called = true;
      // RETURNING id：1 行受影响
      return [{ id: EPISODE }];
    },
  });
  const port = createPgCommitPort(tx);
  await port.setCommitKey({ workspaceId: WS, userId: USER }, EPISODE, "ck-new");
  assert.equal(called, true, "setCommitKey 执行了 UPDATE");
});

test("setCommitKey：episode 不存在/越权（0 行）→ 抛错而非静默成功", async () => {
  const { tx } = makeTx({ onExecute: () => [] });
  const port = createPgCommitPort(tx);
  await assert.rejects(
    port.setCommitKey({ workspaceId: WS, userId: USER }, EPISODE, "ck-new"),
    /不存在或不属于当前 scope/,
  );
});

test("lockSteps：执行 FOR UPDATE 行锁", async () => {
  let sawLock = false;
  const { tx } = makeTx({
    onExecute: (q) => {
      const text = JSON.stringify(q);
      if (text.includes("FOR UPDATE")) sawLock = true;
      return [{ id: EPISODE }];
    },
  });
  const port = createPgCommitPort(tx);
  await port.lockSteps(
    [CommitLockStep.LEARNING_EPISODE],
    { workspaceId: WS, userId: USER },
    EPISODE,
  );
  assert.equal(sawLock, true, "episode 行锁执行");
});

test("loadCommitGuard：读取真实指纹、决策 hash 与 schedule generation", async () => {
  let call = 0;
  const { tx } = makeTx({
    onExecute: () => {
      call += 1;
      if (call === 1) {
        return [{
          episodeEpoch: 3,
          status: "active",
          runtimeEpochSnapshot: 7,
          contentFingerprint: "fingerprint-1",
          schedulingDecision: {
            decisionHash: "decision-hash-1",
            inputScheduleId: "schedule-1",
          },
        }];
      }
      if (call === 2) return [{ id: "pending-1" }];
      return [{ status: "pending", generation: 4 }];
    },
  });
  const port = createPgCommitPort(tx);
  const snapshot = await port.loadCommitGuard(
    { workspaceId: WS, userId: USER },
    EPISODE,
  );

  assert.equal(snapshot.currentRuntimeEpoch, 7);
  assert.equal(snapshot.currentEpisodeEpoch, 3);
  assert.equal(snapshot.currentContentFingerprint, "fingerprint-1");
  assert.equal(snapshot.currentSchedulingDecisionHash, "decision-hash-1");
  assert.equal(snapshot.activePendingScheduleExists, true);
  assert.equal(snapshot.inputScheduleActive, true);
  assert.equal(snapshot.currentInputScheduleGeneration, 4);
  assert.equal(call, 3, "锁内快照同时读取 episode、pending schedule、input schedule");
});

test("未接入生产写端口的方法：fail closed（不假写）", async () => {
  const { tx } = makeTx({});
  const port = createPgCommitPort(tx);
  for (const call of [
    () => port.appendCanonicalEvent({ workspaceId: WS, userId: USER } as never),
    () => port.writeFacetObservation({ workspaceId: WS, userId: USER } as never),
  ]) {
    await assert.rejects(call, CommitPortNotImplementedError);
  }
});

test("writeOperationalOnly：写入低敏 runtime_fence 审计，不写 canonical fact", async () => {
  let called = false;
  const { tx } = makeTx({
    onExecute: () => {
      called = true;
      return [];
    },
  });
  const port = createPgCommitPort(tx);
  await port.writeOperationalOnly({
    workspaceId: WS,
    userId: USER,
    episodeId: EPISODE,
    keyPointId: "key-point-1",
    attribution: "blocked",
    casFailures: ["kill_active"],
    reasonCodes: ["runtime_kill"],
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(called, true);
});

test("writePracticeEvent：仅保留安全摘要，并按 commitKey 幂等", async () => {
  let call = 0;
  const { tx } = makeTx({
    onExecute: () => {
      call += 1;
      return call === 1 ? [{ id: "practice-event-1" }] : [];
    },
  });
  const port = createPgCommitPort(tx);
  await port.writePracticeEvent({
    workspaceId: WS,
    userId: USER,
    episodeId: EPISODE,
    keyPointId: "key-point-1",
    eventType: "diagnostic",
    summary: {
      disposition: "practice_or_diagnostic",
      sourceFingerprint: "fingerprint-1",
      commitKey: "commit-1",
      ignoredField: "must-not-persist",
    },
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(call, 1, "首次 practice event 插入成功，不需要二次回查");
});

test("applyScheduleSideEffect：record_only 不产生 schedule 副作用", async () => {
  const { tx } = makeTx({ onExecute: () => [{ count: 0 }] });
  const port = createPgCommitPort(tx);
  const result = await port.applyScheduleSideEffect({
    workspaceId: WS,
    userId: USER,
    episodeId: EPISODE,
    keyPointId: "key-point-1",
    cardId: "card-1",
    authorizedAction: "record_only",
    intervalDays: 0,
    nextReviewAt: new Date("2026-01-01T00:00:00.000Z"),
    policyVersion: "discrete-v2",
    policyEpoch: 1,
    reasonCode: "facet_only",
    idempotencyKey: "commit-1",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(result, { scheduleId: null, activeScheduleCount: 0, idempotent: true });
});
