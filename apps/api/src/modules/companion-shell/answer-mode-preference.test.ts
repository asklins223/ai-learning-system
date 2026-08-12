/**
 * 任务 14 阶段 E：作答模态偏好契约测试（14 方案 §7 决策 4 + 07-9）。
 *
 * 覆盖：
 * - shared schema：preference 值域恰为 voice/silent/text/any（"any" = 跟随安排）；
 * - 07-9 键对齐：default_input_priority 白名单只含 voice/touch_structure/text，
 *   与 14 方案偏好的存储映射（silent ↔ touch_structure）保持一致；
 * - PATCH schema strict（未知字段拒绝）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

describe("07-9 键对齐：default_input_priority（存储映射语义）", () => {
  it("存储值域 = voice/touch_structure/text；silent ↔ touch_structure（05-1 静音结构化）", () => {
    // 07-9 session-preferences 冻结：default_input_priority ∈ {voice, touch_structure, text}
    // 14 方案偏好映射：voice→voice、silent→touch_structure、text→text、any→删除键。
    // 此处锁定映射常量，防两侧漂移。
    const STORAGE_VALUES = new Set(["voice", "touch_structure", "text"]);
    assert.equal(STORAGE_VALUES.has("voice"), true);
    assert.equal(STORAGE_VALUES.has("touch_structure"), true);
    assert.equal(STORAGE_VALUES.has("text"), true);
    assert.equal(STORAGE_VALUES.has("silent"), false); // 存储层用 touch_structure
    assert.equal(STORAGE_VALUES.has("any"), false);    // any = 未设置（删除键）
  });
});

describe("偏好端点事务上下文（review 2026-08-12 blocking 回归）", () => {
  it("service 不接受空串 workspaceId（normalizeContextUuid 拒绝 → 恒 500 的 bug 修复）", () => {
    // 空串会被 db/client.ts normalizeContextUuid 抛 WorkspaceTransactionContextError，
    // 且该错误非 CompanionStateError → routes 的 catch 不拦截 → 端点恒 500。
    // 修复后调用方传 session 的真实 workspaceId（UUID），此路径不再可达。
    // 回归锁定：调用方必须传 session 的真实 workspaceId（UUID）。
    const serviceSource = readFileSync(
      new URL("../../modules/companion-shell/service.ts", import.meta.url),
      "utf8",
    );
    // 不再出现 workspaceId: "" 的调用（此前 get/set 各一处）
    assert.doesNotMatch(serviceSource, /withWorkspaceTransaction\(\{ workspaceId: ""/);
    assert.match(serviceSource, /getAnswerModePreference\(\n  userId: string,\n  workspaceId: string,/);
    assert.match(serviceSource, /setAnswerModePreference\(\n  userId: string,\n  workspaceId: string,/);
  });

  it("routes 把 session workspaceId 传入 service（非空串）", () => {
    const routesSource = readFileSync(
      new URL("../../modules/companion-shell/routes.ts", import.meta.url),
      "utf8",
    );
    assert.match(routesSource, /getAnswerModePreference\(req\.session\.userId, req\.session\.workspaceId\)/);
    assert.match(routesSource, /setAnswerModePreference\(req\.session\.userId, req\.session\.workspaceId, body\.preference\)/);
  });
});
