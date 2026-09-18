/**
 * 任务 14 阶段 E：作答模态偏好契约测试（14 方案 §7 决策 4 + 07-9）。
 *
 * 只覆盖 shared schema 本身（值域 / 默认值 / strict）。
 * 存储映射（silent ↔ touch_structure）与端点行为由真实 Postgres 集成测试覆盖，
 * 不在本文件用源码正则断言冒充。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answerModePreferenceV1Schema,
  companionAnswerModePreferencePatchV1Schema,
  companionAnswerModePreferenceV1Schema,
} from "@ailearn/shared/companion-shell-contracts";

describe("answerModePreferenceV1Schema（任务 14 §7 决策 4）", () => {
  it("值域恰为 voice/silent/text/any", () => {
    for (const value of ["voice", "silent", "text", "any"]) {
      assert.equal(answerModePreferenceV1Schema.safeParse(value).success, true, value);
    }
    for (const bad of ["gesture", "touch_structure", "ANY", "voice ", "minigame"]) {
      assert.equal(answerModePreferenceV1Schema.safeParse(bad).success, false, bad);
    }
  });

  it("默认值 = any（跟随安排，Supervisor 默认编排）", () => {
    assert.equal(answerModePreferenceV1Schema.parse(undefined), "any");
  });

  it("非法值拒绝（fail closed）", () => {
    for (const bad of ["gesture", "ANY", "", "voice "]) {
      assert.equal(answerModePreferenceV1Schema.safeParse(bad).success, false, bad);
    }
  });
});

describe("companionAnswerModePreferenceV1Schema", () => {
  it("version=1 + preference + updatedAt 完整响应可解析", () => {
    const parsed = companionAnswerModePreferenceV1Schema.safeParse({
      version: 1,
      preference: "silent",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(parsed.success, true);
  });

  it("updatedAt 可空（未设置过）", () => {
    const parsed = companionAnswerModePreferenceV1Schema.safeParse({
      version: 1,
      preference: "any",
      updatedAt: null,
    });
    assert.equal(parsed.success, true);
  });
});

describe("companionAnswerModePreferencePatchV1Schema（写请求）", () => {
  it("version=1 + preference 可解析", () => {
    const parsed = companionAnswerModePreferencePatchV1Schema.safeParse({
      version: 1,
      preference: "voice",
    });
    assert.equal(parsed.success, true);
  });

  it("strict：未知字段拒绝（不静默吞掉拼写错误）", () => {
    const parsed = companionAnswerModePreferencePatchV1Schema.safeParse({
      version: 1,
      preference: "text",
      typoField: true,
    });
    assert.equal(parsed.success, false);
  });
});

// 端到端行为（account 级行、跨 workspace 一致、空 workspaceId 拒绝）由真实
// Postgres 集成测试覆盖：
//   apps/api/src/integration-tests/companion-answer-mode-preference-postgres.integration.ts
// 此前这里用 readFileSync + 正则断言 service/routes 的源码形状——那既不能证明
// 行为（改个格式就失效），也会在重构后给出虚假的「已覆盖」信号。
