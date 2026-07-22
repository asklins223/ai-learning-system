/**
 * identity/ai-model-config.ts 纯函数补充测试
 *
 * 覆盖 normalizePersonalAIModel、normalizePersonalAIBaseUrl、
 * hasSamePersonalAIEndpointOrigin 和 AIModelConfigError 的各种分支。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIModelConfigError,
  normalizePersonalAIModel,
  normalizePersonalAIBaseUrl,
  hasSamePersonalAIEndpointOrigin,
  PERSONAL_AI_PROVIDERS,
} from "../modules/identity/ai-model-config.ts";

// ─── AIModelConfigError ────────────────────────────────────────────────

describe("ai-model-config: AIModelConfigError", () => {
  it("默认 statusCode 为 400", () => {
    const err = new AIModelConfigError("bad request");
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, "bad request");
    assert.equal(err.name, "AIModelConfigError");
    assert.ok(err instanceof Error);
  });

  it("可指定 statusCode 为 503", () => {
    const err = new AIModelConfigError("service unavailable", 503);
    assert.equal(err.statusCode, 503);
  });

  it("是 Error 的实例", () => {
    const err = new AIModelConfigError("test");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof AIModelConfigError);
  });
});

// ─── PERSONAL_AI_PROVIDERS ─────────────────────────────────────────────

describe("ai-model-config: PERSONAL_AI_PROVIDERS", () => {
  it("包含 mock、dashscope、openai_compatible", () => {
    assert.deepEqual([...PERSONAL_AI_PROVIDERS], ["mock", "dashscope", "openai_compatible"]);
  });

  it("每个 provider 都是非空字符串", () => {
    for (const p of PERSONAL_AI_PROVIDERS) {
      assert.equal(typeof p, "string");
      assert.ok(p.length > 0);
    }
  });
});

// ─── normalizePersonalAIModel ──────────────────────────────────────────

describe("ai-model-config: normalizePersonalAIModel", () => {
  it("正常模型名称返回 trim 后的值", () => {
    assert.equal(normalizePersonalAIModel("  gpt-4  "), "gpt-4");
    assert.equal(normalizePersonalAIModel("qwen-max"), "qwen-max");
  });

  it("null 抛出错误", () => {
    assert.throws(() => normalizePersonalAIModel(null), AIModelConfigError);
  });

  it("undefined 抛出错误", () => {
    assert.throws(() => normalizePersonalAIModel(undefined), AIModelConfigError);
  });

  it("空字符串抛出错误", () => {
    assert.throws(() => normalizePersonalAIModel(""), AIModelConfigError);
    assert.throws(() => normalizePersonalAIModel("   "), AIModelConfigError);
  });

  it("超过 200 字符抛出错误", () => {
    const long = "a".repeat(201);
    assert.throws(() => normalizePersonalAIModel(long), AIModelConfigError);
  });

  it("恰好 200 字符通过", () => {
    const exact = "a".repeat(200);
    assert.equal(normalizePersonalAIModel(exact), exact);
  });

  it("包含控制字符抛出错误", () => {
    assert.throws(() => normalizePersonalAIModel("model\u0000name"), AIModelConfigError);
    assert.throws(() => normalizePersonalAIModel("model\u0001"), AIModelConfigError);
    assert.throws(() => normalizePersonalAIModel("model\u007f"), AIModelConfigError);
  });

  it("包含换行符抛出错误", () => {
    assert.throws(() => normalizePersonalAIModel("model\nname"), AIModelConfigError);
    assert.throws(() => normalizePersonalAIModel("model\tname"), AIModelConfigError);
  });
});

// ─── normalizePersonalAIBaseUrl ────────────────────────────────────────

describe("ai-model-config: normalizePersonalAIBaseUrl", () => {
  it("正常 HTTPS URL 返回规范化后的值", () => {
    const result = normalizePersonalAIBaseUrl("openai_compatible", "https://api.example.com/v1");
    assert.ok(result.startsWith("https://"));
    assert.ok(result.includes("api.example.com"));
  });

  it("去除尾部斜杠", () => {
    const result = normalizePersonalAIBaseUrl("openai_compatible", "https://api.example.com/v1/");
    assert.ok(!result.endsWith("//"));
    assert.ok(result.endsWith("/v1") || result.endsWith("/v1/"));
  });

  it("null 抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", null),
      AIModelConfigError,
    );
  });

  it("undefined 抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", undefined),
      AIModelConfigError,
    );
  });

  it("非 URL 字符串抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "not-a-url"),
      AIModelConfigError,
    );
  });

  it("HTTP 协议抛出错误（必须 HTTPS）", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "http://api.example.com"),
      AIModelConfigError,
    );
  });

  it("包含用户名密码的 URL 抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://user:pass@api.example.com"),
      AIModelConfigError,
    );
  });

  it("包含 query 参数的 URL 抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://api.example.com?key=value"),
      AIModelConfigError,
    );
  });

  it("包含 hash 的 URL 抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://api.example.com#section"),
      AIModelConfigError,
    );
  });

  it("localhost 抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://localhost:3000"),
      AIModelConfigError,
    );
  });

  it(".local 域名抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://my-service.local"),
      AIModelConfigError,
    );
  });

  it(".internal 域名抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://my-service.internal"),
      AIModelConfigError,
    );
  });

  it("IP 地址抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://192.168.1.1"),
      AIModelConfigError,
    );
    assert.throws(
      () => normalizePersonalAIBaseUrl("openai_compatible", "https://10.0.0.1"),
      AIModelConfigError,
    );
  });

  it("DashScope provider 使用非 aliyuncs.com 域名抛出错误", () => {
    assert.throws(
      () => normalizePersonalAIBaseUrl("dashscope", "https://api.example.com"),
      AIModelConfigError,
    );
  });

  it("DashScope provider 使用 dashscope.aliyuncs.com 通过", () => {
    const result = normalizePersonalAIBaseUrl("dashscope", "https://dashscope.aliyuncs.com");
    assert.ok(result.includes("dashscope.aliyuncs.com"));
  });

  it("DashScope provider 使用 dashscope-intl.aliyuncs.com 通过", () => {
    const result = normalizePersonalAIBaseUrl("dashscope", "https://dashscope-intl.aliyuncs.com");
    assert.ok(result.includes("dashscope-intl.aliyuncs.com"));
  });

  it("hostname 转小写", () => {
    const result = normalizePersonalAIBaseUrl("openai_compatible", "https://API.Example.COM/v1");
    assert.ok(result.includes("api.example.com"));
  });

  it("尾部点号被去除", () => {
    const result = normalizePersonalAIBaseUrl("openai_compatible", "https://api.example.com./v1");
    assert.ok(result.includes("api.example.com"));
    assert.ok(!result.includes("example.com."));
  });

  it("多个尾部斜杠被压缩", () => {
    const result = normalizePersonalAIBaseUrl("openai_compatible", "https://api.example.com////");
    assert.ok(!result.endsWith("////"));
  });
});

// ─── hasSamePersonalAIEndpointOrigin ──────────────────────────────────

describe("ai-model-config: hasSamePersonalAIEndpointOrigin", () => {
  it("相同 origin 返回 true", () => {
    assert.equal(
      hasSamePersonalAIEndpointOrigin("https://api.example.com/v1", "https://api.example.com/v2"),
      true,
    );
  });

  it("不同 origin 返回 false", () => {
    assert.equal(
      hasSamePersonalAIEndpointOrigin("https://api.example.com", "https://api.other.com"),
      false,
    );
  });

  it("previousBaseUrl 为 null 返回 false", () => {
    assert.equal(hasSamePersonalAIEndpointOrigin(null, "https://api.example.com"), false);
  });

  it("previousBaseUrl 为 undefined 返回 false", () => {
    assert.equal(hasSamePersonalAIEndpointOrigin(undefined, "https://api.example.com"), false);
  });

  it("previousBaseUrl 为空字符串返回 false", () => {
    assert.equal(hasSamePersonalAIEndpointOrigin("", "https://api.example.com"), false);
  });

  it("previousBaseUrl 为无效 URL 返回 false", () => {
    assert.equal(hasSamePersonalAIEndpointOrigin("not-a-url", "https://api.example.com"), false);
  });

  it("nextBaseUrl 为无效 URL 返回 false", () => {
    assert.equal(hasSamePersonalAIEndpointOrigin("https://api.example.com", "not-a-url"), false);
  });

  it("同 origin 不同 port 返回 false", () => {
    assert.equal(
      hasSamePersonalAIEndpointOrigin("https://api.example.com:3000", "https://api.example.com:4000"),
      false,
    );
  });

  it("同 origin 同 port 返回 true", () => {
    assert.equal(
      hasSamePersonalAIEndpointOrigin("https://api.example.com:3000/v1", "https://api.example.com:3000/v2"),
      true,
    );
  });

  it("HTTP 和 HTTPS 不同 origin", () => {
    assert.equal(
      hasSamePersonalAIEndpointOrigin("http://api.example.com", "https://api.example.com"),
      false,
    );
  });
});
