/**
 * validate.ts 单元测试
 *
 * 覆盖 parseBody 函数：成功解析、schema 校验失败抛 400。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { parseBody } from "../lib/validate.ts";

/** 创建最小化的 mock FastifyInstance，只提供 httpErrors.badRequest */
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

test("parseBody 成功解析合法输入并返回 schema 输出", () => {
  const schema = z.object({
    title: z.string().min(1),
    count: z.number().int().default(1),
  });
  const result = parseBody(createMockApp(), schema, { title: "hello" });
  assert.deepEqual(result, { title: "hello", count: 1 });
});

test("parseBody 对缺失必填字段抛 400 错误", () => {
  const schema = z.object({
    title: z.string().min(1),
  });
  assert.throws(
    () => parseBody(createMockApp(), schema, {}),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes("title"));
      return true;
    },
  );
});

test("parseBody 对类型不匹配抛 400 并包含字段路径", () => {
  const schema = z.object({
    title: z.string(),
    tags: z.array(z.string()),
  });
  assert.throws(
    () => parseBody(createMockApp(), schema, { title: 123, tags: "not-array" }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes("title") || err.message.includes("tags"));
      return true;
    },
  );
});

test("parseBody 对嵌套对象校验失败包含嵌套路径", () => {
  const schema = z.object({
    nested: z.object({
      inner: z.string().email(),
    }),
  });
  assert.throws(
    () => parseBody(createMockApp(), schema, { nested: { inner: "not-email" } }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes("nested") || err.message.includes("inner"));
      return true;
    },
  );
});

test("parseBody 对空对象 + 必填 schema 抛 400", () => {
  const schema = z.object({ name: z.string() });
  assert.throws(
    () => parseBody(createMockApp(), schema, null),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 对数组 schema 正确解析", () => {
  const schema = z.array(z.number());
  const result = parseBody(createMockApp(), schema, [1, 2, 3]);
  assert.deepEqual(result, [1, 2, 3]);
});

test("parseBody 对枚举 schema 校验失败抛 400", () => {
  const schema = z.object({
    status: z.enum(["pending", "done"]),
  });
  assert.throws(
    () => parseBody(createMockApp(), schema, { status: "invalid" }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 返回值与 schema .default() 生效后的输出类型一致", () => {
  const schema = z.object({
    name: z.string(),
    role: z.string().default("member"),
    tags: z.array(z.string()).default([]),
  });
  const result = parseBody(createMockApp(), schema, { name: "alice" });
  assert.equal(result.role, "member");
  assert.deepEqual(result.tags, []);
});
