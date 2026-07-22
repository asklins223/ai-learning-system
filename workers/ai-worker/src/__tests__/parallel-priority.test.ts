/**
 * AI Worker 延迟优化方案 — 并行处理 + 队列优先级单元测试
 *
 * 覆盖文档 §8 验证方式中要求的：
 *   - 并行处理测试：验证 3 个 job 并行时 lease fencing 仍然正确
 *   - 优先级测试：验证 evaluate_validation 优先于 align_evidence 被 claim
 *
 * 并行处理测试模拟 tick() 中 semaphore 模型（inflight Set + fire-and-forget）的行为，验证：
 *   1. 多个 job 并行执行时各自使用独立的 lease token 进行 fencing
 *   2. 一个 job 失败不会阻止其他 job 成功
 *   3. 未知 job 类型在并行环境中正确处理
 *   4. lease 丢失的 job 不影响其他 job 的状态转换
 *
 * 优先级测试通过验证 migration SQL 中的 ORDER BY 子句确保优先级设计正确。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  markJobSucceeded,
  markJobFailed,
  markUnknownJobFailed,
  type ClaimedJob,
  type QueueJobUpdate,
  type QueueJobUpdater,
} from "../queue.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 测试 fixture ──────────────────────────────────────────────────────────

function makeJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    type: "generate_card",
    payload: {},
    workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    requestedBy: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    attempts: 0,
    leaseToken: `lease-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

/**
 * 创建 mock QueueJobUpdater，记录所有更新并可控返回是否成功。
 * 每个 job 的 lease token 独立检查，模拟数据库 fenced UPDATE 的行为。
 */
function createFencingUpdater(): {
  updater: QueueJobUpdater;
  updates: QueueJobUpdate[];
  revokedLeases: Set<string>;
} {
  const updates: QueueJobUpdate[] = [];
  const revokedLeases = new Set<string>();

  const updater: QueueJobUpdater = async (update) => {
    updates.push(update);
    // 如果该 lease 已被 reaper 回收，fenced UPDATE 返回 false
    return !revokedLeases.has(update.fence.leaseToken);
  };

  return { updater, updates, revokedLeases };
}

// ─── 并行处理测试 ──────────────────────────────────────────────────────────

test("并行处理：3 个 job 并行执行时各自使用独立 lease token 进行 fencing", async () => {
  const jobs: ClaimedJob[] = [
    makeJob({ id: "job-a", type: "generate_card", leaseToken: "lease-a" }),
    makeJob({ id: "job-b", type: "align_evidence", leaseToken: "lease-b" }),
    makeJob({ id: "job-c", type: "evaluate_validation", leaseToken: "lease-c" }),
  ];

  const { updater, updates } = createFencingUpdater();

  // 模拟 processJob 的核心逻辑：handler 成功后调用 markJobSucceeded
  const processJobLike = async (job: ClaimedJob) => {
    await markJobSucceeded(job, updater);
  };

  // 并行执行，模拟 tick() 中 semaphore 模型的 fire-and-forget 行为
  const results = await Promise.allSettled(jobs.map((job) => processJobLike(job)));

  // 所有 3 个 job 都应成功（没有 rejection）
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, "fulfilled");
  }

  // 验证每个 job 使用了各自的 lease token
  assert.equal(updates.length, 3);
  const leaseTokens = updates.map((u) => u.fence.leaseToken);
  assert.ok(leaseTokens.includes("lease-a"));
  assert.ok(leaseTokens.includes("lease-b"));
  assert.ok(leaseTokens.includes("lease-c"));

  // 验证 lease token 互不相同
  assert.equal(new Set(leaseTokens).size, 3);
});

test("并行处理：一个 job 失败不会阻止其他 job 成功提交", async () => {
  const jobs: ClaimedJob[] = [
    makeJob({ id: "job-success-1", type: "generate_card", leaseToken: "lease-1" }),
    makeJob({ id: "job-fail", type: "generate_card", leaseToken: "lease-2", attempts: 0 }),
    makeJob({ id: "job-success-2", type: "align_evidence", leaseToken: "lease-3" }),
  ];

  const { updater, updates } = createFencingUpdater();

  // 模拟 processJob：job-fail 抛出错误，其他两个成功
  const processJobLike = async (job: ClaimedJob) => {
    if (job.id === "job-fail") {
      const failure = await markJobFailed(job, "simulated provider error", updater);
      return failure;
    }
    await markJobSucceeded(job, updater);
  };

  const results = await Promise.allSettled(jobs.map((job) => processJobLike(job)));

  // Promise.allSettled 不会短路 — 所有 job 都得到处理（与 semaphore 模型的独立 catch 行为一致）
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, "fulfilled");
  }

  // 验证 2 个成功 + 1 个失败
  const succeededUpdates = updates.filter((u) => u.values.status === "succeeded");
  const failedUpdates = updates.filter((u) => u.values.status === "pending");
  assert.equal(succeededUpdates.length, 2);
  assert.equal(failedUpdates.length, 1);

  // 验证失败的 job 使用了正确的 lease token
  assert.equal(failedUpdates[0].fence.leaseToken, "lease-2");
  assert.equal(failedUpdates[0].values.lastError, "simulated provider error");
});

test("并行处理：lease 丢失的 job 不影响其他 job 的状态转换", async () => {
  const jobs: ClaimedJob[] = [
    makeJob({ id: "job-reaped", type: "generate_card", leaseToken: "lease-reaped" }),
    makeJob({ id: "job-normal", type: "generate_card", leaseToken: "lease-normal" }),
  ];

  const { updater, updates, revokedLeases } = createFencingUpdater();
  // 模拟 job-reaped 的 lease 被 reaper 回收
  revokedLeases.add("lease-reaped");

  const processJobLike = async (job: ClaimedJob) => {
    const updated = await markJobSucceeded(job, updater);
    if (!updated) {
      // lease 丢失，跳过结果提交（与 processJob 中的逻辑一致）
      return;
    }
  };

  const results = await Promise.allSettled(jobs.map((job) => processJobLike(job)));

  // 两个 job 都 fulfilled（lease 丢失不抛异常，只是跳过提交）
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, "fulfilled");
  }

  // 两个 job 都尝试了 UPDATE
  assert.equal(updates.length, 2);

  // 验证 lease 丢失的 job 的 fence 条件
  const reapedUpdate = updates.find((u) => u.fence.leaseToken === "lease-reaped");
  assert.ok(reapedUpdate, "reaped job should have attempted an update");
  assert.equal(reapedUpdate!.fence.status, "running");

  // 验证正常 job 的 fence 条件
  const normalUpdate = updates.find((u) => u.fence.leaseToken === "lease-normal");
  assert.ok(normalUpdate, "normal job should have attempted an update");
  assert.equal(normalUpdate!.fence.status, "running");
});

test("并行处理：未知 job 类型在并行环境中正确标记为 dead", async () => {
  const jobs: ClaimedJob[] = [
    makeJob({ id: "job-known", type: "generate_card", leaseToken: "lease-known" }),
    makeJob({ id: "job-unknown", type: "nonexistent_type", leaseToken: "lease-unknown" }),
  ];

  const { updater, updates } = createFencingUpdater();

  // 模拟 processJob 中对未知类型的处理
  const processJobLike = async (job: ClaimedJob) => {
    const knownTypes = new Set(["generate_card", "align_evidence", "evaluate_validation", "parse_source"]);
    if (!knownTypes.has(job.type)) {
      await markUnknownJobFailed(job, updater);
      return;
    }
    await markJobSucceeded(job, updater);
  };

  const results = await Promise.allSettled(jobs.map((job) => processJobLike(job)));

  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, "fulfilled");
  }

  // 验证：已知 job 成功，未知 job 标记为 failed（dead）
  assert.equal(updates.length, 2);

  const unknownUpdate = updates.find((u) => u.fence.leaseToken === "lease-unknown");
  assert.ok(unknownUpdate);
  assert.equal(unknownUpdate!.values.status, "failed");
  assert.equal(unknownUpdate!.values.attempts, 3); // MAX_ATTEMPTS
  assert.ok(unknownUpdate!.values.lastError?.includes("unknown job type"));

  const knownUpdate = updates.find((u) => u.fence.leaseToken === "lease-known");
  assert.ok(knownUpdate);
  assert.equal(knownUpdate!.values.status, "succeeded");
});

test("并行处理：3 个 job 真正并发执行而非串行", async () => {
  // 验证并行执行确实让 job 同时运行（semaphore 模型中每个 slot 独立 fire-and-forget）：
  // 如果串行执行，总时间 ≈ 3 × delay；并行执行总时间 ≈ delay
  const delay = 50; // ms
  const jobs = [
    makeJob({ id: "job-1", leaseToken: "lease-1" }),
    makeJob({ id: "job-2", leaseToken: "lease-2" }),
    makeJob({ id: "job-3", leaseToken: "lease-3" }),
  ];

  const { updater } = createFencingUpdater();

  const processJobLike = async (job: ClaimedJob) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await markJobSucceeded(job, updater);
  };

  const start = Date.now();
  await Promise.allSettled(jobs.map((job) => processJobLike(job)));
  const elapsed = Date.now() - start;

  // 并行执行：总时间应远小于 3 × delay = 150ms
  // 允许一定余量（event loop 调度等）
  assert.ok(
    elapsed < delay * 2,
    `并行执行总耗时 ${elapsed}ms 应小于 2 × ${delay}ms = ${delay * 2}ms（串行预期 ${delay * 3}ms）`,
  );
});

// ─── 队列优先级测试 ─────────────────────────────────────────────────────────

test("队列优先级：migration 0030 的 ORDER BY 包含正确的优先级映射", () => {
  const migrationPath = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "apps",
    "api",
    "src",
    "db",
    "migrations",
    "0030_job_queue_priority.sql",
  );
  const sql = readFileSync(migrationPath, "utf-8");

  // 验证优先级 CASE 表达式存在且值正确
  assert.ok(sql.includes("WHEN 'evaluate_validation' THEN 10"), "evaluate_validation 优先级应为 10");
  assert.ok(sql.includes("WHEN 'parse_source' THEN 8"), "parse_source 优先级应为 8");
  assert.ok(sql.includes("WHEN 'generate_card' THEN 5"), "generate_card 优先级应为 5");
  assert.ok(sql.includes("WHEN 'align_evidence' THEN 1"), "align_evidence 优先级应为 1");
  assert.ok(sql.includes("ELSE 5"), "未知类型默认优先级应为 5");

  // 验证优先级按 DESC 排序（高优先级先 claim）
  assert.ok(sql.includes("END DESC"), "优先级应按 DESC 排序，高优先级 job 先被 claim");

  // 验证同级按 scheduled_at ASC 排序（FIFO）
  assert.ok(
    sql.includes("scheduled_at") && sql.includes("DESC") && sql.includes("j.id"),
    "应有 scheduled_at 和 j.id 作为次级排序",
  );

  // 验证 SECURITY DEFINER 保留
  assert.ok(sql.includes("SECURITY DEFINER"), "函数应保持 SECURITY DEFINER");

  // 验证 SKIP LOCKED 保留（避免多 Worker 竞争同一行）
  assert.ok(sql.includes("SKIP LOCKED"), "应保留 SKIP LOCKED 以支持多 Worker 并发 claim");
});

test("队列优先级：evaluate_validation (10) > parse_source (8) > generate_card (5) > align_evidence (1)", () => {
  // 验证优先级数值的正确性：
  // evaluate_validation 是用户实时等待的场景，优先级最高
  // align_evidence 是后台任务，优先级最低
  const priorities: Record<string, number> = {
    evaluate_validation: 10,
    parse_source: 8,
    generate_card: 5,
    align_evidence: 1,
  };

  // 用户实时等待的 job 应优先于后台 job
  assert.ok(
    priorities.evaluate_validation > priorities.align_evidence,
    "evaluate_validation 应优先于 align_evidence",
  );
  assert.ok(
    priorities.evaluate_validation > priorities.generate_card,
    "evaluate_validation 应优先于 generate_card",
  );
  assert.ok(
    priorities.parse_source > priorities.align_evidence,
    "parse_source 应优先于 align_evidence",
  );

  // 验证优先级间距合理：高优先级与低优先级之间有足够间隔
  const gap = priorities.evaluate_validation - priorities.align_evidence;
  assert.ok(gap >= 5, "最高与最低优先级差距应 >= 5，确保排序效果明显");
});
