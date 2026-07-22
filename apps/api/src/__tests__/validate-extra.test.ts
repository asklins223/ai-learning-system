/**
 * lib/validate.ts 补充测试
 *
 * 覆盖 parseBody 函数的成功和失败路径。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { parseBody } from "../lib/validate.ts";

// 创建模拟 FastifyInstance
function createMockApp() {
  const badRequest = (msg: string) => {
    const err = new Error(msg) as Error & { statusCode: number };
    err.statusCode = 400;
    return err;
  };
  return {
    httpErrors: { badRequest },
  } as any;
}

const simpleSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
});

test("parseBody 成功解析有效数据", () => {
  const app = createMockApp();
  const data = parseBody(app, simpleSchema, { name: "Alice", age: 25 });
  assert.equal(data.name, "Alice");
  assert.equal(data.age, 25);
});

test("parseBody 应用 schema default 值", () => {
  const schemaWithDefault = z.object({
    name: z.string(),
    role: z.string().default("member"),
  });
  const app = createMockApp();
  const data = parseBody(app, schemaWithDefault, { name: "Bob" });
  assert.equal(data.name, "Bob");
  assert.equal(data.role, "member");
});

test("parseBody 缺少必填字段时抛出 400 错误", () => {
  const app = createMockApp();
  assert.throws(
    () => parseBody(app, simpleSchema, { name: "Alice" }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes("age"));
      return true;
    },
  );
});

test("parseBody 类型不匹配时抛出 400 错误", () => {
  const app = createMockApp();
  assert.throws(
    () => parseBody(app, simpleSchema, { name: "Alice", age: "not a number" }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 传入 null 时抛出 400", () => {
  const app = createMockApp();
  assert.throws(
    () => parseBody(app, simpleSchema, null),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 传入 undefined 时抛出 400", () => {
  const app = createMockApp();
  assert.throws(
    () => parseBody(app, simpleSchema, undefined),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 传入空对象时抛出 400（缺少必填字段）", () => {
  const app = createMockApp();
  assert.throws(
    () => parseBody(app, simpleSchema, {}),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 多个验证错误的 message 用分号连接", () => {
  const app = createMockApp();
  assert.throws(
    () => parseBody(app, simpleSchema, {}),
    (err: Error) => {
      assert.ok(err.message.includes(";"), "多个错误应以分号连接");
      return true;
    },
  );
});

test("parseBody 枚举类型验证", () => {
  const enumSchema = z.object({
    type: z.enum(["mock", "dashscope", "openai_compatible"]),
  });
  const app = createMockApp();

  // 有效
  const valid = parseBody(app, enumSchema, { type: "mock" });
  assert.equal(valid.type, "mock");

  // 无效
  assert.throws(
    () => parseBody(app, enumSchema, { type: "invalid" }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 数组类型验证", () => {
  const arraySchema = z.object({
    items: z.array(z.string()).min(1),
  });
  const app = createMockApp();

  const valid = parseBody(app, arraySchema, { items: ["a", "b"] });
  assert.deepEqual(valid.items, ["a", "b"]);

  assert.throws(
    () => parseBody(app, arraySchema, { items: [] }),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("parseBody 可选字段验证", () => {
  const optionalSchema = z.object({
    required: z.string(),
    optional: z.string().optional(),
  });
  const app = createMockApp();

  const withoutOptional = parseBody(app, optionalSchema, { required: "yes" });
  assert.equal(withoutOptional.required, "yes");
  assert.equal(withoutOptional.optional, undefined);

  const withOptional = parseBody(app, optionalSchema, { required: "yes", optional: "value" });
  assert.equal(withOptional.optional, "value");
});
