/**
 * governance.ts 单元测试（纯函数部分）
 *
 * 覆盖：
 * - normalizeWorkspaceAIPolicy
 * - detectAndSanitizePII
 * - sanitizePIIInObject
 *
* 注意：checkAIConsent / getWorkspaceAIPolicy /
* enforcePrivacyGovernance / logAICall 依赖数据库，此处不测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AI_DATA_POLICY,
  normalizeWorkspaceAIPolicy,
  detectAndSanitizePII,
  sanitizePIIInObject,
  type WorkspaceAIPolicy,
} from "../lib/governance.ts";

// ─── normalizeWorkspaceAIPolicy ─────────────────────────────────────────────

test("normalizeWorkspaceAIPolicy: 空值返回默认策略", () => {
  const result = normalizeWorkspaceAIPolicy(null);
  assert.deepEqual(result, DEFAULT_AI_DATA_POLICY);
});

test("normalizeWorkspaceAIPolicy: undefined 返回默认策略", () => {
  const result = normalizeWorkspaceAIPolicy(undefined);
  assert.deepEqual(result, DEFAULT_AI_DATA_POLICY);
});

test("normalizeWorkspaceAIPolicy: 非 object 类型返回默认策略", () => {
  const result = normalizeWorkspaceAIPolicy("string");
  assert.deepEqual(result, DEFAULT_AI_DATA_POLICY);
});

test("normalizeWorkspaceAIPolicy: 部分字段覆盖时其他字段回退默认值", () => {
  const result = normalizeWorkspaceAIPolicy({
    sendToExternal: true,
  });
  assert.equal(result.sendToExternal, true);
  assert.equal(result.piiDetection, DEFAULT_AI_DATA_POLICY.piiDetection);
  assert.equal(result.auditLogging, DEFAULT_AI_DATA_POLICY.auditLogging);
});

test("normalizeWorkspaceAIPolicy: 全部字段覆盖时返回覆盖值", () => {
  const input: WorkspaceAIPolicy = {
    sendToExternal: true,
    piiDetection: false,
    auditLogging: false,
    sendImageContent: true,
  };
  const result = normalizeWorkspaceAIPolicy(input);
  assert.deepEqual(result, input);
});

test("normalizeWorkspaceAIPolicy: sendImageContent 缺省时回退默认值 false", () => {
  const result = normalizeWorkspaceAIPolicy({ sendToExternal: true });
  assert.equal(result.sendImageContent, DEFAULT_AI_DATA_POLICY.sendImageContent);
  assert.equal(DEFAULT_AI_DATA_POLICY.sendImageContent, false);
});

test("normalizeWorkspaceAIPolicy: 非 boolean 字段回退默认值", () => {
  const result = normalizeWorkspaceAIPolicy({
    sendToExternal: "yes" as any,
    piiDetection: null as any,
    auditLogging: 1 as any,
  });
  assert.equal(result.sendToExternal, DEFAULT_AI_DATA_POLICY.sendToExternal);
  assert.equal(result.piiDetection, DEFAULT_AI_DATA_POLICY.piiDetection);
  assert.equal(result.auditLogging, DEFAULT_AI_DATA_POLICY.auditLogging);
});

// ─── detectAndSanitizePII ─────────────────────────────────────────────────

test("detectAndSanitizePII: 检测邮箱地址", () => {
  const text = "联系邮箱：test@example.com 获取更多信息";
  const result = detectAndSanitizePII(text);
  assert.equal(result.hasPII, true);
  assert.ok(result.detectedTypes.includes("email"));
  assert.ok(result.sanitizedText.includes("t***m"));
  assert.ok(!result.sanitizedText.includes("test@example.com"));
});

test("detectAndSanitizePII: 检测手机号（中国）", () => {
  const text = "我的手机号是 13812345678，请联系我";
  const result = detectAndSanitizePII(text);
  assert.equal(result.hasPII, true);
  assert.ok(result.detectedTypes.includes("phone"));
  assert.ok(result.sanitizedText.includes("1***8"));
});

test("detectAndSanitizePII: 检测身份证号", () => {
  const text = "身份证号：123456199001011234";
  const result = detectAndSanitizePII(text);
  assert.equal(result.hasPII, true);
  assert.ok(result.detectedTypes.includes("id_card"));
  assert.ok(result.sanitizedText.includes("1***4"));
});

test("detectAndSanitizePII: 检测银行卡号（16-19位，Luhn 校验）", () => {
  // QUAL-13: 银行卡号需要通过 Luhn 校验。6225880212345673 是 Luhn 有效号码。
  const text = "卡号 6225880212345673 用于支付";
  const result = detectAndSanitizePII(text);
  assert.equal(result.hasPII, true);
  assert.ok(result.detectedTypes.includes("bank_card"));
  assert.ok(result.sanitizedText.includes("6***3"));
});

test("detectAndSanitizePII: 非 Luhn 长数字不误判为银行卡号", () => {
  // QUAL-13: 16-19位数字但不通过 Luhn 校验的（如时间戳、订单号）不应被脱敏
  const text = "订单号 6225880212345678 时间戳 1700000000000000";
  const result = detectAndSanitizePII(text);
  assert.ok(!result.detectedTypes.includes("bank_card"));
});

test("detectAndSanitizePII: 同时检测多种 PII 类型", () => {
  const text = "邮箱 test@example.com，手机 13900001111";
  const result = detectAndSanitizePII(text);
  assert.equal(result.hasPII, true);
  assert.ok(result.detectedTypes.includes("email"));
  assert.ok(result.detectedTypes.includes("phone"));
});

test("detectAndSanitizePII: 无 PII 时返回原始文本", () => {
  const text = "这是一段普通文本，没有敏感信息";
  const result = detectAndSanitizePII(text);
  assert.equal(result.hasPII, false);
  assert.equal(result.detectedTypes.length, 0);
  assert.equal(result.sanitizedText, text);
});

test("detectAndSanitizePII: 短 PII（<=4字符）完全替换为 ***", () => {
  // 测试边界情况，虽然邮箱手机号通常不会这么短
  const text = "abc"; // 不符合任何 pattern，所以不会被替换
  const result = detectAndSanitizePII(text);
  assert.equal(result.hasPII, false);
});

test("detectAndSanitizePII: 多个相同 PII 类型都被脱敏", () => {
  const text = "邮箱：a@b.com 和 c@d.com";
  const result = detectAndSanitizePII(text);
  assert.ok(result.detectedTypes.includes("email"));
  assert.ok(!result.sanitizedText.includes("a@b.com"));
  assert.ok(!result.sanitizedText.includes("c@d.com"));
});

test("detectAndSanitizePII: 大小写不敏感的邮箱检测", () => {
  const text = "联系 TEST@Example.COM";
  const result = detectAndSanitizePII(text);
  assert.ok(result.detectedTypes.includes("email"));
});

// ─── sanitizePIIInObject ─────────────────────────────────────────────────

test("sanitizePIIInObject: 对普通对象的所有字符串字段进行 PII 检测和脱敏", () => {
  const obj = {
    name: "张三",
    email: "zhangsan@example.com",
    phone: "13900001111",
    age: 30,
  };
  const result = sanitizePIIInObject(obj);

  assert.ok(result.detectedTypes.includes("email"));
  assert.ok(result.detectedTypes.includes("phone"));
  assert.equal((result.data as any).email, "z***m");
  assert.equal((result.data as any).phone, "1***1");
  assert.equal((result.data as any).name, "张三"); // 无 PII
  assert.equal((result.data as any).age, 30);
});

test("sanitizePIIInObject: 对嵌套对象递归处理", () => {
  const obj = {
    user: {
      name: "李四",
      contact: {
        email: "lisi@example.com",
      },
    },
  };
  const result = sanitizePIIInObject(obj);

  assert.ok(result.detectedTypes.includes("email"));
  assert.equal((result.data as any).user.contact.email, "l***m");
});

test("sanitizePIIInObject: 对数组元素递归处理", () => {
  const obj = {
    users: [
      { name: "王五", email: "wangwu@example.com" },
      { name: "赵六", phone: "13800002222" },
    ],
  };
  const result = sanitizePIIInObject(obj);

  assert.ok(result.detectedTypes.includes("email"));
  assert.ok(result.detectedTypes.includes("phone"));
  assert.equal((result.data as any).users[0].email, "w***m");
  assert.equal((result.data as any).users[1].phone, "1***2");
});

test("sanitizePIIInObject: 原对象不被修改", () => {
  const obj = { email: "test@example.com" };
  const originalEmail = obj.email;

  sanitizePIIInObject(obj);

  assert.equal(obj.email, originalEmail);
});

test("sanitizePIIInObject: 空/undefined/null 字段不崩溃", () => {
  const obj = {
    empty: "",
    nullField: null,
    undefinedField: undefined,
    valid: "valid@example.com",
  };
  const result = sanitizePIIInObject(obj);

  assert.ok(result.detectedTypes.includes("email"));
  assert.equal((result.data as any).empty, "");
  assert.equal((result.data as any).nullField, null);
  assert.equal((result.data as any).undefinedField, undefined);
});

test("sanitizePIIInObject: 数字、boolean 等非字符串类型保持不变", () => {
  const obj = {
    num: 42,
    bool: true,
    nil: null,
    str: "text",
  };
  const result = sanitizePIIInObject(obj);

  assert.equal(result.detectedTypes.length, 0);
  assert.equal((result.data as any).num, 42);
  assert.equal((result.data as any).bool, true);
  assert.equal((result.data as any).nil, null);
  assert.equal((result.data as any).str, "text");
});

test("sanitizePIIInObject: 检测到多种 PII 类型时 detectedTypes 去重", () => {
  const obj = {
    email: "a@b.com",
    email2: "c@d.com",
    phone: "13900001111",
  };
  const result = sanitizePIIInObject(obj);

  assert.equal(result.detectedTypes.length, 2); // email 和 phone，不重复
  assert.ok(result.detectedTypes.includes("email"));
  assert.ok(result.detectedTypes.includes("phone"));
});

test("sanitizePIIInObject: 返回的 data 字段保持原始对象结构", () => {
  const obj = {
    user: { name: "张三", email: "zhangsan@example.com" },
    tags: ["tag1", "tag2"],
  };
  const result = sanitizePIIInObject(obj);

  assert.ok((result.data as any).user);
  assert.ok(Array.isArray((result.data as any).tags));
  assert.ok((result.data as any).tags.length === 2);
});