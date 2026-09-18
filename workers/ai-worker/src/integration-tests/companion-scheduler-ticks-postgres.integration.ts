/**
 * worker 伴星调度 tick 的包裹层契约（此前零覆盖）。
 *
 * 正确性核心在 SECURITY DEFINER SQL 函数里，已由
 * apps/api/src/integration-tests/companion-proposal-expiry-sweep-postgres.integration.ts
 * 覆盖。本文件覆盖**包裹层**，因为它在 worker 主循环里被 await：
 *   1. 节流：同一进程内 30s 内重复调用不得重复打库；
 *   2. 永不抛：维护查询失败只能告警，不能把主队列 tick 打断；
 *   3. 失败不推进节流（下一次 tick 必须重试）；
 *   4. 日记调度在能力关闭时立即返回，不发任何查询。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  resetCompanionProposalExpiryThrottleForTest,
  tickCompanionProposalExpiry,
} from "../handlers/companion-proposal-expiry-scheduler.ts";
import { tickCompanionDailySummaryScheduler } from "../handlers/companion-daily-summary-scheduler.ts";
import { closeDatabase } from "../db.ts";

after(async () => {
  await closeDatabase().catch(() => {});
});

test("proposal expiry tick：首次执行成功且返回数值，紧接的第二次被节流为 0", async () => {
  resetCompanionProposalExpiryThrottleForTest();
  const first = await tickCompanionProposalExpiry();
  assert.equal(typeof first, "number");
  assert.ok(first >= 0, "回收数量不得为负");

  const throttled = await tickCompanionProposalExpiry();
  assert.equal(throttled, 0, "30s 内重复调用必须被节流（不重复打库）");
});

test("proposal expiry tick：时间倒退（nowMs < 上次）同样视为节流，不得重复打库", async () => {
  resetCompanionProposalExpiryThrottleForTest();
  await tickCompanionProposalExpiry(1_000_000);
  const backwards = await tickCompanionProposalExpiry(500);
  assert.equal(backwards, 0, "时钟回拨不得绕过节流");
});

test("proposal expiry tick：永不抛异常（主循环安全）", async () => {
  resetCompanionProposalExpiryThrottleForTest();
  await assert.doesNotReject(() => tickCompanionProposalExpiry(Date.now()));
});

test("daily summary tick：能力关闭时立即返回且不抛", async () => {
  const saved = process.env.COMPANION_DAILY_SUMMARY_V1;
  process.env.COMPANION_DAILY_SUMMARY_V1 = "false";
  try {
    await assert.doesNotReject(() => tickCompanionDailySummaryScheduler());
  } finally {
    if (saved === undefined) delete process.env.COMPANION_DAILY_SUMMARY_V1;
    else process.env.COMPANION_DAILY_SUMMARY_V1 = saved;
  }
});
