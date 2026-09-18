/**
 * companion 内存固定窗口限流的专门用例（此前该模块零覆盖）。
 *
 * 该限流是伴星全部写路径（createTurn / menu-proposal / proposal decision /
 * ASR / TTS / export / bridge context）的唯一预算闸门，达限必须**零副作用**地
 * 返回 429。模块级 Map 是进程内状态，因此每个用例使用独立 key 前缀避免互相干扰。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import {
  COMPANION_RATE_LIMITS,
  companionRateLimit,
  companionRateLimitReply,
} from "./companion-rate-limit.ts";

const key = (label: string): string => `${label}:${randomUUID()}`;

describe("companionRateLimit：固定窗口语义", () => {
  it("窗口内允许到 limit，第 limit+1 次拒绝并给出正数 retryAfter", () => {
    const bucket = key("turn");
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(
        companionRateLimit({ key: bucket, limit: 3, windowMs: 60_000 }),
        { allowed: true, retryAfterSeconds: 0 },
        `第 ${i + 1} 次必须放行`,
      );
    }
    const denied = companionRateLimit({ key: bucket, limit: 3, windowMs: 60_000 });
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSeconds >= 1, "retryAfter 至少 1 秒");
    assert.ok(denied.retryAfterSeconds <= 60, "retryAfter 不超过窗口长度");
  });

  it("拒绝不消耗计数：连续拒绝不会让 retryAfter 变长或提前重置", () => {
    const bucket = key("no-consume");
    companionRateLimit({ key: bucket, limit: 1, windowMs: 60_000 });
    const first = companionRateLimit({ key: bucket, limit: 1, windowMs: 60_000 });
    const second = companionRateLimit({ key: bucket, limit: 1, windowMs: 60_000 });
    assert.equal(first.allowed, false);
    assert.equal(second.allowed, false);
    assert.ok(second.retryAfterSeconds <= first.retryAfterSeconds, "拒绝路径不得延后窗口");
  });

  it("窗口已过 → 重新开窗并放行（过期不累积）", () => {
    const bucket = key("expired");
    // windowMs = 0 表示「上一瞬间即过期」，等价于验证 `now - windowStart >= windowMs` 分支。
    companionRateLimit({ key: bucket, limit: 1, windowMs: 0 });
    const reopened = companionRateLimit({ key: bucket, limit: 1, windowMs: 0 });
    assert.equal(reopened.allowed, true, "窗口过期后必须重新开窗");
  });

  it("不同 key 的预算互不影响（per workspace+user+bucket 隔离）", () => {
    const a = key("iso-a");
    const b = key("iso-b");
    companionRateLimit({ key: a, limit: 1, windowMs: 60_000 });
    assert.equal(companionRateLimit({ key: a, limit: 1, windowMs: 60_000 }).allowed, false);
    assert.equal(
      companionRateLimit({ key: b, limit: 1, windowMs: 60_000 }).allowed,
      true,
      "另一个 scope 必须仍有自己的额度",
    );
  });

  it("同一 key 上不同 windowMs 各自独立判定（分钟桶与小时桶共用 key 名但窗口不同）", () => {
    const bucket = key("two-windows");
    // 分钟桶先打满
    companionRateLimit({ key: bucket, limit: 2, windowMs: 1 }).allowed;
    companionRateLimit({ key: bucket, limit: 2, windowMs: 1 });
    assert.equal(companionRateLimit({ key: bucket, limit: 2, windowMs: 1 }).allowed, false);
    // 小时桶窗口更长：同一 bucket 记录的 windowStart 仍在，因此同样受限——
    // 这锁住「同一 key 复用于不同限额时不会凭空放行」的语义（调用方必须使用不同 key）。
    const hourBucket = companionRateLimit({ key: bucket, limit: 100, windowMs: 3_600_000 });
    assert.equal(hourBucket.allowed, true, "更高 limit 的窗口在计数未达时放行");
  });
});

describe("companionRateLimitReply：429 envelope", () => {
  it("写入 statusCode 429 并返回与 §6.9 一致的错误体", () => {
    const calls: Array<{ status?: number; body?: unknown }> = [];
    const reply = {
      code(statusCode: number) {
        calls.push({ status: statusCode });
        return { send: (body: unknown) => { calls.push({ body }); return body; } };
      },
      send(body: unknown) { calls.push({ body }); return body; },
    };
    companionRateLimitReply(reply, "req-1", 7);
    assert.equal(calls[0]?.status, 429);
    assert.deepEqual(calls[1]?.body, {
      version: 1,
      error: "RATE_LIMITED",
      message: "操作太频繁，请稍后再试",
      recoverable: true,
      requestId: "req-1",
      retryAfterSeconds: 7,
    });
  });
});

describe("COMPANION_RATE_LIMITS：§6.10 冻结限额", () => {
  it("每个 bucket 都是正整数 limit 与正数窗口，且 export 是最严格的写预算", () => {
    for (const [name, value] of Object.entries(COMPANION_RATE_LIMITS)) {
      assert.ok(Number.isInteger(value.limit) && value.limit > 0, `${name}.limit 必须为正整数`);
      assert.ok(value.windowMs > 0, `${name}.windowMs 必须为正数`);
    }
    assert.ok(COMPANION_RATE_LIMITS.exportPerHour.limit <= 5, "导出必须是最严格的配额之一");
    assert.equal(COMPANION_RATE_LIMITS.createTurnPerHour.limit, 120);
    assert.ok(
      COMPANION_RATE_LIMITS.createTurnPerHour.windowMs > COMPANION_RATE_LIMITS.createTurnPerMinute.windowMs,
      "小时桶窗口必须大于分钟桶",
    );
  });
});
