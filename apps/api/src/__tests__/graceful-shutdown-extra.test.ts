/**
 * graceful-shutdown.ts 补充测试
 *
 * 覆盖原有测试未覆盖的分支：
 * - server 和 database 同时失败的 AggregateError 分支
 * - 仅 database 失败的分支
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createGracefulShutdown } from "../lib/graceful-shutdown.ts";

test("graceful-shutdown: server 和 database 同时失败抛 AggregateError", async () => {
  const controller = createGracefulShutdown({
    clearTimer: () => {},
    closeServer: async () => {
      throw new Error("server error");
    },
    closeDatabase: async () => {
      throw new Error("database error");
    },
  });

  await assert.rejects(
    controller.shutdown("SIGTERM"),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const errors = (error as AggregateError).errors;
      assert.equal(errors.length, 2);
      assert.ok(errors.some((e: unknown) => e instanceof Error && e.message.includes("server error")));
      assert.ok(errors.some((e: unknown) => e instanceof Error && e.message.includes("database error")));
      return true;
    },
  );
});

test("graceful-shutdown: 仅 database 失败抛 databaseError", async () => {
  const controller = createGracefulShutdown({
    clearTimer: () => {},
    closeServer: async () => {},
    closeDatabase: async () => {
      throw new Error("database error only");
    },
  });

  await assert.rejects(
    controller.shutdown("SIGTERM"),
    /database error only/,
  );
});

test("graceful-shutdown: 正常关闭无错误", async () => {
  const calls: string[] = [];
  const controller = createGracefulShutdown({
    clearTimer: () => calls.push("clear-timer"),
    closeServer: async () => {
      calls.push("close-server");
    },
    closeDatabase: async () => {
      calls.push("close-database");
    },
  });

  await controller.shutdown("SIGTERM");
  assert.deepEqual(calls, ["clear-timer", "close-server", "close-database"]);
});

test("graceful-shutdown: 多次调用返回同一个 Promise", async () => {
  const controller = createGracefulShutdown({
    clearTimer: () => {},
    closeServer: async () => {},
    closeDatabase: async () => {},
  });

  const p1 = controller.shutdown("SIGTERM");
  const p2 = controller.shutdown("SIGINT");
  const p3 = controller.shutdown("SIGTERM");

  assert.equal(p1, p2);
  assert.equal(p2, p3);

  await p1;
});
