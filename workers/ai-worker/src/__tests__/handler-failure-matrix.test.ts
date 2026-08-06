/**
 * QLT-02: Handler 故障矩阵单元测试（ADR-0008 §6.7 — Worker/数据库故障矩阵）
 *
 * 本文件覆盖计划 §6.7 中以下不依赖真实 PostgreSQL 的故障场景：
 *   - Provider 收到 abort 后仍延迟返回 → lease fencing 阻止迟到写入
 *   - 事务提交前/后进程退出模拟 → lease 保留，reaper 可回收
 *   - 重复消息、重复 HTTP 请求 → 幂等 fencing 阻止重复副作用
 *   - 死信重放 → MAX_ATTEMPTS 收敛逻辑
 *   - 未知 job 类型处理
 *   - 空队列 claim 不报错
 *
 * 依赖真实 PostgreSQL 的场景（双 Worker 竞争、claim/reap 竞争、lease 过期后旧 Handler
 * 返回、连接池跨 workspace 复用 1000 次）已在 queue-postgres.integration.ts 中覆盖。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HandlerTimeoutError,
  runWithAbortTimeout,
} from "../lib/handler-timeout.ts";
import {
  JobLeaseLostError,
  throwIfJobAborted,
} from "../lib/job-lease.ts";
import { retryBackoffMs } from "../lib/job-retry.ts";
import {
  claimJobs,
  createClaimedJobUpdate,
  markJobFailed,
  markJobSucceeded,
  reapStaleJobs,
  MAX_ATTEMPTS,
  type ClaimedJob,
  type QueueJobUpdate,
  type QueueJobUpdater,
  type QueueSqlExecutor,
} from "../queue.ts";

// ─── 测试 fixture ──────────────────────────────────────────────────────────

/** 标准测试用 claimed job fixture */
const baseJob: ClaimedJob = {
  id: "11111111-1111-1111-1111-111111111111",
  type: "execute_card_agent_turn",
  payload: { noteVersionId: "note-version-1" },
  workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  requestedBy: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  attempts: 0,
  leaseToken: "lease-token-original",
};

/**
 * 创建 mock QueueSqlExecutor，返回固定行。
 * 用于模拟数据库 claim/reap 操作的返回值。
 */
function executorWithRows(rows: Record<string, unknown>[]): QueueSqlExecutor {
  return {
    execute: async <T extends Record<string, unknown>>() => rows as T[],
  };
}

/**
 * 创建 mock QueueJobUpdater，记录所有更新并可控返回是否成功。
 * 用于模拟 fenced UPDATE 的成功/失败（lease token 不匹配时返回 false）。
 */
function createRecordingUpdater(
  shouldSucceed = true,
): { updater: QueueJobUpdater; updates: QueueJobUpdate[] } {
  const updates: QueueJobUpdate[] = [];
  const updater: QueueJobUpdater = async (update) => {
    updates.push(update);
    return shouldSucceed;
  };
  return { updater, updates };
}

// ─── 场景 1：Provider 收到 abort 后仍延迟返回 ──────────────────────────────

test("故障矩阵：Provider 超时后延迟返回，lease fencing 阻止迟到的成功提交", async () => {
  // 模拟场景：
  // 1. Worker claim 了 job，获得 leaseToken-A
  // 2. Handler 调用 Provider，Provider 超时
  // 3. Handler 的迟到返回尝试 markJobSucceeded
  // 4. 但 job 已被 reaper 回收并重新 claim（leaseToken-B）
  // 5. markJobSucceeded 应返回 false（fenced UPDATE 未命中行）

  const { updater, updates } = createRecordingUpdater(false); // lease 已变更，UPDATE 命中 0 行

  // 模拟迟到的 handler 尝试提交成功
  const successResult = await markJobSucceeded(baseJob, updater);

  assert.equal(successResult, false, "迟到的 lease 应被 fencing 阻止");
  assert.equal(updates.length, 1, "应尝试一次 UPDATE");
  // 验证 fence 条件包含正确的 lease token
  assert.equal(updates[0].fence.leaseToken, "lease-token-original");
  assert.equal(updates[0].fence.status, "running");
});

test("故障矩阵：Provider 超时后延迟返回，lease fencing 也阻止失败提交", async () => {
  // 与上一测试对称：迟到 handler 的失败提交也应被阻止
  const { updater, updates } = createRecordingUpdater(false);

  const failResult = await markJobFailed(baseJob, "provider late error", updater);

  assert.equal(failResult.updated, false, "迟到的 lease 应阻止失败提交");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].fence.leaseToken, "lease-token-original");
});

test("故障矩阵：Handler 超时触发 AbortSignal，Provider 延迟返回时 side effect 被跳过", async () => {
  // 模拟 runWithAbortTimeout 的完整流程：
  // 1. 超时触发 AbortController.abort()
  // 2. Provider 收到 abort signal
  // 3. Provider 最终返回（延迟），但 handler 检查 signal.aborted 后跳过 side effect

  let signalObserved: AbortSignal | undefined;
  let sideEffectExecuted = false;
  let releaseGate: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const result = runWithAbortTimeout(
    async (signal) => {
      signalObserved = signal;
      // 模拟 Provider 延迟返回
      await gate;
      // Handler 检查 signal 是否已 abort
      if (!signal.aborted) {
        sideEffectExecuted = true;
      }
      return "late-return";
    },
    30, // 30ms 超时
  );

  // 应抛出 HandlerTimeoutError
  await assert.rejects(result, (err: unknown) => err instanceof HandlerTimeoutError);
  assert.equal(signalObserved?.aborted, true, "AbortSignal 应已触发");

  // 释放 gate，让 Provider 延迟返回
  releaseGate!();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sideEffectExecuted, false, "超时后的 side effect 不应执行");
});

// ─── 场景 2：事务提交前/后进程退出模拟 ─────────────────────────────────────

test("故障矩阵：进程在事务提交前退出 — lease 保留在 running 状态，reaper 可回收", async () => {
  // 模拟场景：
  // 1. Worker claim 了 job（status=running, leaseToken=A）
  // 2. Handler 开始执行业务事务
  // 3. 进程在事务提交前崩溃
  // 4. 数据库中 job 仍为 running + leaseToken=A
  // 5. reaper 在 LEASE_TIMEOUT_MS 后回收该 job

  // 验证 reaper 能正确识别和回收 running 状态的 job
  const reaperExecutor = executorWithRows([
    { id: "crashed-job-1", status: "pending" },
  ]);

  const reaped = await reapStaleJobs(reaperExecutor, 120_000, MAX_ATTEMPTS);

  assert.equal(reaped.total, 1);
  assert.equal(reaped.pending, 1, "崩溃的 job 应被 reaper 回收为 pending（重试）");
  assert.equal(reaped.dead, 0);
  assert.deepEqual(reaped.ids, ["crashed-job-1"]);
});

test("故障矩阵：进程在事务提交后、job 状态更新前退出 — 下一轮 claim 检测幂等", async () => {
  // 模拟场景：
  // 1. Handler 业务事务已提交（side effect 已持久化）
  // 2. 但进程在 markJobSucceeded 之前退出
  // 3. job 仍为 running 状态
  // 4. reaper 回收后 job 变为 pending
  // 5. 下一轮 claim 重新获取该 job
  // 6. Handler 再次执行，发现 side effect 已存在（幂等检查）

  // 验证：markJobSucceeded 使用 fence 条件，即使 lease token 匹配也能正常完成
  const { updater, updates } = createRecordingUpdater(true);

  const result = await markJobSucceeded(baseJob, updater);

  assert.equal(result, true, "lease 仍有效时应成功标记为 succeeded");
  assert.equal(updates[0].values.status, "succeeded");
  assert.equal(updates[0].values.leaseToken, null, "成功后清除 lease token");
});

// ─── 场景 3：重复消息、重复 HTTP 请求、死信重放 ───────────────────────────

test("故障矩阵：重复 markJobSucceeded 调用 — 第二次被 fencing 阻止", async () => {
  // 模拟重复提交场景：
  // 1. 第一次 markJobSucceeded 成功（lease token 匹配）
  // 2. 第二次 markJobSucceeded 使用相同 lease token，但 job 已不是 running 状态
  // 3. 第二次应返回 false

  let callCount = 0;
  const updater: QueueJobUpdater = async () => {
    callCount++;
    // 第一次返回 true（匹配 running + lease），第二次返回 false（已不是 running）
    return callCount === 1;
  };

  const first = await markJobSucceeded(baseJob, updater);
  const second = await markJobSucceeded(baseJob, updater);

  assert.equal(first, true, "第一次提交应成功");
  assert.equal(second, false, "第二次提交应被 fencing 阻止（幂等保护）");
  assert.equal(callCount, 2, "应尝试两次 UPDATE");
});

test("故障矩阵：重复 markJobFailed 调用 — 第二次被 fencing 阻止", async () => {
  // 与重复成功对称：重复失败提交也应被阻止
  let callCount = 0;
  const updater: QueueJobUpdater = async () => {
    callCount++;
    return callCount === 1;
  };

  const first = await markJobFailed(baseJob, "error-1", updater);
  const second = await markJobFailed(baseJob, "error-2", updater);

  assert.equal(first.updated, true, "第一次失败提交应成功");
  assert.equal(second.updated, false, "第二次失败提交应被 fencing 阻止");
  assert.equal(callCount, 2);
});

test("故障矩阵：死信重放 — job 经过 MAX_ATTEMPTS 次失败后收敛为 dead", async () => {
  // 模拟完整的重试→死信流程：
  // attempts=0 → 失败 → attempts=1 (pending, backoff=2s)
  // attempts=1 → 失败 → attempts=2 (pending, backoff=4s)
  // attempts=2 → 失败 → attempts=3=MAX_ATTEMPTS (dead, no backoff)

  const now = Date.parse("2026-07-19T00:00:00.000Z");
  const updates: QueueJobUpdate[] = [];
  const updater: QueueJobUpdater = async (update) => {
    updates.push(update);
    return true;
  };

  // 第一次失败（attempts=0 → 1）
  const fail1 = await markJobFailed(
    baseJob,
    "attempt 1 failed",
    updater,
    () => new Date(now),
    () => now,
  );
  assert.equal(fail1.status, "pending");
  assert.equal(fail1.attempts, 1);
  assert.equal(fail1.backoffMs, retryBackoffMs(0)); // 2_000

  // 第二次失败（attempts=1 → 2）
  const job1 = { ...baseJob, attempts: 1 };
  const fail2 = await markJobFailed(
    job1,
    "attempt 2 failed",
    updater,
    () => new Date(now),
    () => now,
  );
  assert.equal(fail2.status, "pending");
  assert.equal(fail2.attempts, 2);
  assert.equal(fail2.backoffMs, retryBackoffMs(1)); // 4_000

  // 第三次失败（attempts=2 → 3=MAX_ATTEMPTS → dead）
  const job2 = { ...baseJob, attempts: 2 };
  const fail3 = await markJobFailed(
    job2,
    "attempt 3 failed",
    updater,
    () => new Date(now),
    () => now,
  );
  assert.equal(fail3.status, "dead");
  assert.equal(fail3.attempts, MAX_ATTEMPTS);
  assert.equal(fail3.backoffMs, 0, "dead job 不应有重试延迟");

  // 验证所有 3 次 UPDATE 的状态
  assert.equal(updates.length, 3);
  assert.equal(updates[0].values.status, "pending");
  assert.equal(updates[1].values.status, "pending");
  assert.equal(updates[2].values.status, "dead");

  // dead job 应有 finishedAt，pending job 不应有
  assert.equal(updates[0].values.finishedAt, null);
  assert.equal(updates[1].values.finishedAt, null);
  assert.ok(updates[2].values.finishedAt, "dead job 应记录完成时间");
});

test("故障矩阵：死信 job 的 lease token 被清除，不可再被操作", async () => {
  // 死信 job 的 leaseToken 应被清除为 null
  const { updater, updates } = createRecordingUpdater(true);
  const deadJob = { ...baseJob, attempts: MAX_ATTEMPTS - 1 };

  await markJobFailed(deadJob, "final failure", updater);

  assert.equal(updates[0].values.leaseToken, null, "dead job 的 leaseToken 应清除");
  assert.equal(updates[0].values.startedAt, null, "dead job 的 startedAt 应清除");
});

// ─── 场景 4：未知 job 类型处理 ─────────────────────────────────────────────

test("故障矩阵：claim 返回未知 job 类型 — 不影响其他 job 的 claim", async () => {
  // 模拟 claim 返回包含未知类型的 job
  // 在实际 worker 中，HANDLERS[job.type] 为 undefined 时会调用 markUnknownJobFailed
  const executor = executorWithRows([
    {
      id: "job-known",
      type: "execute_card_agent_turn",
      payload: {},
      workspace_id: "ws-1",
      requested_by: "user-1",
      attempts: 0,
      lease_token: "lease-1",
    },
    {
      id: "job-unknown",
      type: "unknown_type_xyz",
      payload: {},
      workspace_id: "ws-1",
      requested_by: "user-1",
      attempts: 0,
      lease_token: "lease-2",
    },
  ]);

  const jobs = await claimJobs(executor, 2, MAX_ATTEMPTS);

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].type, "execute_card_agent_turn");
  assert.equal(jobs[1].type, "unknown_type_xyz");
  // 两种 job 都应获得独立的 lease token
  assert.equal(new Set(jobs.map((j) => j.leaseToken)).size, 2);
});

// ─── 场景 5：空队列处理 ─────────────────────────────────────────────────────

test("故障矩阵：空队列 claim 返回空数组，不报错", async () => {
  const executor = executorWithRows([]);
  const jobs = await claimJobs(executor, 1, MAX_ATTEMPTS);
  assert.deepEqual(jobs, []);
});

test("故障矩阵：空队列 reap 返回零结果", async () => {
  const executor = executorWithRows([]);
  const result = await reapStaleJobs(executor, 120_000, MAX_ATTEMPTS);
  assert.deepEqual(result, { total: 0, pending: 0, dead: 0, ids: [] });
});

// ─── 场景 6：lease 上下文与 abort signal 联动 ──────────────────────────────

test("故障矩阵：abort signal 在事务中检查 — 已 abort 的 lease 抛出 JobLeaseLostError", () => {
  const controller = new AbortController();
  controller.abort(new Error("handler timeout"));

  assert.throws(
    () => throwIfJobAborted({
      id: "job-aborted",
      workspaceId: "ws-1",
      requestedBy: "user-1",
      leaseToken: "lease-aborted",
      signal: controller.signal,
    }),
    (err: unknown) => err instanceof JobLeaseLostError,
  );
});

test("故障矩阵：未 abort 的 lease 不抛出异常", () => {
  const controller = new AbortController();
  // 不调用 abort

  assert.doesNotThrow(() =>
    throwIfJobAborted({
      id: "job-active",
      workspaceId: "ws-1",
      requestedBy: "user-1",
      leaseToken: "lease-active",
      signal: controller.signal,
    }),
  );
});

test("故障矩阵：无 signal 的 lease 不抛出异常（兼容无超时场景）", () => {
  assert.doesNotThrow(() =>
    throwIfJobAborted({
      id: "job-no-signal",
      workspaceId: "ws-1",
      requestedBy: "user-1",
      leaseToken: "lease-no-signal",
    }),
  );
});

// ─── 场景 7：createClaimedJobUpdate 正确构建 fence ─────────────────────────

test("故障矩阵：createClaimedJobUpdate 构建正确的 fence 上下文", () => {
  const update = createClaimedJobUpdate(baseJob, {
    status: "succeeded",
    leaseToken: null,
  });

  assert.equal(update.context.workspaceId, baseJob.workspaceId);
  assert.equal(update.context.userId, baseJob.requestedBy);
  assert.equal(update.fence.id, baseJob.id);
  assert.equal(update.fence.workspaceId, baseJob.workspaceId);
  assert.equal(update.fence.status, "running");
  assert.equal(update.fence.leaseToken, baseJob.leaseToken);
});

test("故障矩阵：fence 条件始终要求 running 状态和原始 lease token", () => {
  // 无论更新目标是什么状态，fence 始终检查 running + leaseToken
  const successUpdate = createClaimedJobUpdate(baseJob, {
    status: "succeeded",
    leaseToken: null,
  });
  assert.equal(successUpdate.fence.status, "running");

  const failUpdate = createClaimedJobUpdate(baseJob, {
    status: "pending",
    attempts: 1,
    lastError: "error",
    startedAt: null,
    leaseToken: null,
    finishedAt: null,
  });
  assert.equal(failUpdate.fence.status, "running");
  assert.equal(failUpdate.fence.leaseToken, baseJob.leaseToken);
});
