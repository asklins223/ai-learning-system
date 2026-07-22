/**
 * pagination.ts 单元测试
 *
 * 覆盖 clampLimit, clampOffset, clampPagination, encodeCursor, decodeCursor,
 * paginationQuerySchema, parseQuery
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  clampLimit,
  clampOffset,
  clampPagination,
  encodeCursor,
  decodeCursor,
  paginationQuerySchema,
  uuidParamSchema,
  cardIdParamSchema,
  parseQuery,
} from "../lib/pagination.ts";

// ─── clampLimit ──────────────────────────────────────────────────────────

test("clampLimit: undefined 返回默认值 100", () => {
  assert.equal(clampLimit(undefined), 100);
});

test("clampLimit: NaN 返回默认值", () => {
  assert.equal(clampLimit(NaN), 100);
});

test("clampLimit: 正常值原样返回（取整）", () => {
  assert.equal(clampLimit(50), 50);
  assert.equal(clampLimit(10.7), 10);
});

test("clampLimit: 超过 100 被限制为 100", () => {
  assert.equal(clampLimit(200), 100);
  assert.equal(clampLimit(9999), 100);
});

test("clampLimit: 小于 1 被限制为 1", () => {
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
});

test("clampLimit: 自定义默认值", () => {
  assert.equal(clampLimit(undefined, 20), 20);
});

test("clampLimit: 1 和 100 边界值通过", () => {
  assert.equal(clampLimit(1), 1);
  assert.equal(clampLimit(100), 100);
});

// ─── clampOffset ─────────────────────────────────────────────────────────

test("clampOffset: undefined 返回默认值 0", () => {
  assert.equal(clampOffset(undefined), 0);
});

test("clampOffset: NaN 返回默认值 0", () => {
  assert.equal(clampOffset(NaN), 0);
});

test("clampOffset: 正常值原样返回（取整）", () => {
  assert.equal(clampOffset(50), 50);
  assert.equal(clampOffset(10.9), 10);
});

test("clampOffset: 负值被限制为 0", () => {
  assert.equal(clampOffset(-1), 0);
  assert.equal(clampOffset(-100), 0);
});

test("clampOffset: 自定义默认值", () => {
  assert.equal(clampOffset(undefined, 10), 10);
});

test("clampOffset: 0 通过", () => {
  assert.equal(clampOffset(0), 0);
});

// ─── clampPagination ─────────────────────────────────────────────────────

test("clampPagination: undefined opts 返回默认值", () => {
  const result = clampPagination(undefined);
  assert.equal(result.limit, 100);
  assert.equal(result.offset, 0);
});

test("clampPagination: 正常值通过", () => {
  const result = clampPagination({ cursor: 20, limit: 50 });
  assert.equal(result.limit, 50);
  assert.equal(result.offset, 20);
});

test("clampPagination: 超限值被 clamp", () => {
  const result = clampPagination({ cursor: -5, limit: 200 });
  assert.equal(result.limit, 100);
  assert.equal(result.offset, 0);
});

test("clampPagination: 自定义默认值", () => {
  const result = clampPagination(undefined, { limit: 30, cursor: 5 });
  assert.equal(result.limit, 30);
  assert.equal(result.offset, 5);
});

// ─── encodeCursor ────────────────────────────────────────────────────────

test("encodeCursor: Date 对象正确编码", () => {
  const date = new Date("2026-01-15T10:30:00.000Z");
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const cursor = encodeCursor(date, id);
  assert.ok(typeof cursor === "string");
  assert.ok(cursor.length > 0);
});

test("encodeCursor: 字符串 timestamp 正确编码", () => {
  const ts = "2026-01-15T10:30:00.000Z";
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const cursor = encodeCursor(ts, id);
  assert.ok(typeof cursor === "string");
});

test("encodeCursor: 编码后可被 decodeCursor 解码", () => {
  const date = new Date("2026-01-15T10:30:00.000Z");
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const cursor = encodeCursor(date, id);
  const decoded = decodeCursor(cursor);
  assert.ok(decoded);
  assert.equal(decoded.id, id);
  assert.equal(decoded.timestamp, date.toISOString());
});

// ─── decodeCursor ────────────────────────────────────────────────────────

test("decodeCursor: undefined 返回 null", () => {
  assert.equal(decodeCursor(undefined), null);
});

test("decodeCursor: null 返回 null", () => {
  assert.equal(decodeCursor(null), null);
});

test("decodeCursor: 空字符串返回 null", () => {
  assert.equal(decodeCursor(""), null);
});

test("decodeCursor: 非 base64 字符串返回 null", () => {
  assert.equal(decodeCursor("not-base64!"), null);
});

test("decodeCursor: base64 但内容格式不对返回 null", () => {
  const badContent = Buffer.from("just-some-text").toString("base64");
  assert.equal(decodeCursor(badContent), null);
});

test("decodeCursor: 无效 UUID 返回 null", () => {
  const badContent = Buffer.from("2026-01-15T10:30:00.000Z:not-a-uuid").toString("base64");
  assert.equal(decodeCursor(badContent), null);
});

test("decodeCursor: 无效 timestamp 返回 null", () => {
  const badContent = Buffer.from("not-a-date:550e8400-e29b-41d4-a716-446655440000").toString("base64");
  assert.equal(decodeCursor(badContent), null);
});

test("decodeCursor: 缺少分隔符返回 null", () => {
  const badContent = Buffer.from("justoneword").toString("base64");
  assert.equal(decodeCursor(badContent), null);
});

test("decodeCursor: 非规范 base64（padding 不对）返回 null", () => {
  assert.equal(decodeCursor("abc"), null);
});

test("decodeCursor: 有效 cursor 正确解码", () => {
  const ts = "2026-01-15T10:30:00.000Z";
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const cursor = encodeCursor(ts, id);
  const decoded = decodeCursor(cursor);
  assert.ok(decoded);
  assert.equal(decoded.timestamp, ts);
  assert.equal(decoded.id, id);
});

// ─── paginationQuerySchema ───────────────────────────────────────────────

test("paginationQuerySchema: 空对象通过", () => {
  const result = paginationQuerySchema.safeParse({});
  assert.ok(result.success);
});

test("paginationQuerySchema: 合法 cursor 和 limit 通过", () => {
  const cursor = encodeCursor(new Date(), "550e8400-e29b-41d4-a716-446655440000");
  const result = paginationQuerySchema.safeParse({ cursor, limit: 50 });
  assert.ok(result.success);
  assert.equal(result.data?.limit, 50);
});

test("paginationQuerySchema: limit 超过 100 失败", () => {
  const result = paginationQuerySchema.safeParse({ limit: 101 });
  assert.ok(!result.success);
});

test("paginationQuerySchema: limit 小于 1 失败", () => {
  const result = paginationQuerySchema.safeParse({ limit: 0 });
  assert.ok(!result.success);
});

test("paginationQuerySchema: 无效 cursor 失败", () => {
  const result = paginationQuerySchema.safeParse({ cursor: "invalid-cursor" });
  assert.ok(!result.success);
});

test("paginationQuerySchema: cursor 超过 200 字符失败", () => {
  const result = paginationQuerySchema.safeParse({ cursor: "a".repeat(201) });
  assert.ok(!result.success);
});

test("paginationQuerySchema: limit 为字符串数字自动转换", () => {
  const result = paginationQuerySchema.safeParse({ limit: "50" });
  assert.ok(result.success);
  assert.equal(result.data?.limit, 50);
});

// ─── uuidParamSchema ─────────────────────────────────────────────────────

test("uuidParamSchema: 有效 UUID 通过", () => {
  const result = uuidParamSchema.safeParse({ id: "550e8400-e29b-41d4-a716-446655440000" });
  assert.ok(result.success);
});

test("uuidParamSchema: 无效 UUID 失败", () => {
  const result = uuidParamSchema.safeParse({ id: "not-a-uuid" });
  assert.ok(!result.success);
});

// ─── cardIdParamSchema ───────────────────────────────────────────────────

test("cardIdParamSchema: 有效 UUID 通过", () => {
  const result = cardIdParamSchema.safeParse({ cardId: "550e8400-e29b-41d4-a716-446655440000" });
  assert.ok(result.success);
});

test("cardIdParamSchema: 无效 UUID 失败", () => {
  const result = cardIdParamSchema.safeParse({ cardId: "not-a-uuid" });
  assert.ok(!result.success);
});

// ─── parseQuery ──────────────────────────────────────────────────────────

function createMockApp() {
  return {
    httpErrors: {
      badRequest: (msg: string) => {
        const err = new Error(msg) as Error & { statusCode?: number };
        err.statusCode = 400;
        return err;
      },
    },
  } as any;
}

test("parseQuery: 合法输入返回解析结果", () => {
  const schema = z.object({ name: z.string() });
  const result = parseQuery(createMockApp(), schema, { name: "test" });
  assert.equal(result.name, "test");
});

test("parseQuery: 非法输入抛 400", () => {
  const schema = z.object({ name: z.string() });
  assert.throws(
    () => parseQuery(createMockApp(), schema, { name: 123 }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});
