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
      return [];
    },
  });
  const port = createPgCommitPort(tx);
  await port.setCommitKey({ workspaceId: WS, userId: USER }, EPISODE, "ck-new");
  assert.equal(called, true, "setCommitKey 执行了 UPDATE");
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

test("未实现方法：fail closed（CommitPortNotImplementedError，不假写）", async () => {
  const { tx } = makeTx({});
  const port = createPgCommitPort(tx);
  for (const call of [
    () => port.writeOperationalOnly({ workspaceId: WS, userId: USER } as never),
    () => port.appendCanonicalEvent({ workspaceId: WS, userId: USER } as never),
    () => port.applyScheduleSideEffect({ workspaceId: WS, userId: USER } as never),
    () => port.writePracticeEvent({ workspaceId: WS, userId: USER } as never),
    () => port.writeFacetObservation({ workspaceId: WS, userId: USER } as never),
  ]) {
    await assert.rejects(call, CommitPortNotImplementedError);
  }
});
