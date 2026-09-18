/**
 * 请求上下文（设计 P1-15，2026-09-15 审计：跨进程 trace）。
 *
 * 关键性质：
 * 1. 不在上下文里 → null（后台任务/测试不应拿到别人的 id）
 * 2. 上下文内 → 该 id
 * 3. 跨 await 边界仍然可见（Fastify onRequest 钩子里进入上下文后，handler 里的
 *    深层异步调用必须还能读到——这是该方案成立的前提）
 * 4. 并发请求之间互不串号
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentRequestId,
  hasRequestContext,
  runWithRequestContext,
} from "../lib/request-context.ts";

describe("request context (cross-process trace)", () => {
  it("不在请求上下文时返回 null", () => {
    assert.equal(currentRequestId(), null);
    assert.equal(hasRequestContext(), false);
  });

  it("上下文内可读到 id，且跨 await 边界保持", async () => {
    await runWithRequestContext("req-abc", async () => {
      assert.equal(currentRequestId(), "req-abc");
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(currentRequestId(), "req-abc", "await 之后 id 不丢");
      await Promise.resolve();
      assert.equal(currentRequestId(), "req-abc", "微任务之后 id 不丢");
    });
  });

  it("退出上下文后恢复为 null（不泄漏到后续调用）", () => {
    runWithRequestContext("req-xyz", () => {
      assert.equal(currentRequestId(), "req-xyz");
    });
    assert.equal(currentRequestId(), null);
  });

  it("并发上下文互不串号", async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithRequestContext("req-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(String(currentRequestId()));
      }),
      runWithRequestContext("req-2", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(String(currentRequestId()));
      }),
    ]);
    assert.deepEqual(seen.sort(), ["req-1", "req-2"]);
  });
});
