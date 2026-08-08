/**
 * 任务 07-9：反馈文案规则 单测（§11.3 / §11.4，冻结记录 01-9）。
 *
 * 覆盖：
 * - 允许表达集合（§11.3 七种）；
 * - 禁止表达集合（§11.3 禁止清单 + §11.4 文案）：XP/等级/金币/连击/宝箱、
 *   streak/断签宽限/保住火焰、每日清空/自动追加/无限下一题、排行榜/分享成绩/
 *   跨用户比较、失败扣分/掉级羞辱/倒计时、随机奖励/内容锁/体力墙、失望催促；
 * - 具体、可行动、非身份化校验：拒绝「你落后了」「欠了 N 项」「完全掌握 92%」；
 * - 合规文案构造（§11.4 示例式）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_FEEDBACK_EXPRESSIONS,
  FORBIDDEN_FEEDBACK_MECHANICS,
  buildSpecificFeedback,
  isActionableSpecific,
  isAllowedExpression,
  isCompliantFeedbackCopy,
  isForbiddenMechanic,
  validateFeedbackCopy,
} from "./feedback-copy.ts";

// ─── 1. 允许表达集合（§11.3）───────────────────────────────────────────

describe("允许表达集合（§11.3）", () => {
  it("七种允许表达齐全", () => {
    assert.deepEqual([...ALLOWED_FEEDBACK_EXPRESSIONS], [
      "choose_destination_and_route",
      "predict_consequences",
      "visible_operational_change",
      "repair_path",
      "trusted_change_reveal",
      "question_answered",
      "review_understanding_change",
    ]);
  });

  it("isAllowedExpression 判定", () => {
    assert.equal(isAllowedExpression("repair_path"), true);
    assert.equal(isAllowedExpression("xp"), false);
    assert.equal(isAllowedExpression("random_reward"), false);
  });
});

// ─── 2. 禁止表达集合（§11.3 禁止清单 + §11.4 文案）────────────────────

describe("禁止表达集合（§11.3 / §11.4）", () => {
  it("禁止机制清单齐全（21 种）", () => {
    assert.equal(FORBIDDEN_FEEDBACK_MECHANICS.length, 21);
    for (const mechanic of FORBIDDEN_FEEDBACK_MECHANICS) {
      assert.equal(isForbiddenMechanic(mechanic), true);
    }
    assert.equal(isForbiddenMechanic("stars"), false);
  });

  const forbiddenSamples: Array<[string, string]> = [
    ["xp", "你获得了 100 XP"],
    ["levels", "升到 5 级了"],
    ["coins", "获得 50 金币"],
    ["combo", "连击 x3"],
    ["chest", "打开宝箱"],
    ["streak", "连续记录即将中断"],
    ["grace_days", "今天断签有宽限"],
    ["keep_flame", "再来一题保住火焰"],
    ["daily_reset", "每日清空"],
    ["auto_append", "自动追加下一题"],
    ["unlimited_next", "无限下一题"],
    ["leaderboard", "排行榜第 3 名"],
    ["share_score", "分享成绩给朋友"],
    ["cross_user_compare", "你超过了其他同学"],
    ["failure_penalty", "答错扣 2 分"],
    ["level_down_shame", "掉级了"],
    ["countdown", "还有 5 秒倒计时"],
    ["random_reward", "随机奖励已发放"],
    ["content_lock", "解锁下一关需要 3 张卡"],
    ["energy_wall", "体力不足，明天再来"],
    ["disappointment_urging", "你这样做会让我失望"],
  ];

  for (const [mechanic, text] of forbiddenSamples) {
    it(`检测禁止机制 ${mechanic}`, () => {
      const result = validateFeedbackCopy(text);
      assert.equal(result.ok, false, `「${text}」应被判定为不合规`);
      assert.ok(result.forbiddenMechanisms.includes(mechanic as never), `应命中 ${mechanic}`);
    });
  }

  it("合规文案 → ok（允许表达不误伤）", () => {
    const result = validateFeedbackCopy(
      "这次你已经能重建前三个步骤，边界条件还没独立验证。可以试着独立验证一遍。",
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.forbiddenMechanisms, []);
    assert.equal(result.violations.length, 0);
  });

  it("「修复光路」「星重新清晰」等允许表达不触发禁止机制", () => {
    assert.equal(isCompliantFeedbackCopy("我们一起来修复这条光路，让星重新清晰。"), true);
    assert.equal(isCompliantFeedbackCopy("选择目的地后，可以预测每一步的后果。"), true);
    assert.equal(isCompliantFeedbackCopy("你保存的问题已经有了答案。"), true);
  });
});

// ─── 3. 身份化与伪精确（§11.4）─────────────────────────────────────────

describe("具体、可行动、非身份化（§11.4）", () => {
  it("「你落后了」→ 身份化，不合规", () => {
    const result = validateFeedbackCopy("你落后了，快去复习");
    assert.equal(result.ok, false);
    assert.equal(result.identityLabeling, true);
  });

  it("「欠了 5 项」→ 债务化，不合规", () => {
    const result = validateFeedbackCopy("你欠了 5 项复习");
    assert.equal(result.ok, false);
    assert.equal(result.identityLabeling, true);
  });

  it("「你不适合这种学习方式」→ 身份化，不合规", () => {
    const result = validateFeedbackCopy("你不适合这种学习方式");
    assert.equal(result.ok, false);
    assert.equal(result.identityLabeling, true);
  });

  it("「完全掌握 92%」→ 伪精确，不合规", () => {
    const result = validateFeedbackCopy("你已经完全掌握 92%");
    assert.equal(result.ok, false);
    assert.equal(result.pseudoPrecision, true);
  });

  it("「掌握度 87%」→ 伪精确，不合规", () => {
    const result = validateFeedbackCopy("该卡掌握度 87%");
    assert.equal(result.ok, false);
    assert.equal(result.pseudoPrecision, true);
  });

  it("「再来一题保住进度」→ 催促 + 保住，不合规", () => {
    const result = validateFeedbackCopy("再来一题保住进度");
    assert.equal(result.ok, false);
  });

  it("可行动判定：含具体下一步 → 可行动", () => {
    assert.equal(isActionableSpecific("可以先看证据卡，再试着独立验证一遍。"), true);
    assert.equal(isActionableSpecific("可以稍后再来，进度不会有任何变化。"), true);
  });
});

// ─── 4. 合规文案构造（§11.4 示例式）────────────────────────────────────

describe("合规文案构造（§11.4）", () => {
  it("有 done + notYet → 示例式文案且合规", () => {
    const text = buildSpecificFeedback({
      done: ["重建前三个步骤"],
      notYet: ["边界条件"],
    });
    assert.equal(
      text,
      "这次你已经能重建前三个步骤；边界条件 还没独立验证。可以试着独立验证一遍。",
    );
    assert.equal(validateFeedbackCopy(text).ok, true);
    assert.equal(isActionableSpecific(text), true);
  });

  it("无 notYet → 以可行动建议收尾且合规", () => {
    const text = buildSpecificFeedback({ done: ["找到证据卡", "定位到原文"], notYet: [] });
    assert.equal(validateFeedbackCopy(text).ok, true);
    assert.ok(text.includes("独立验证"));
  });

  it("构造输出永不出现禁止表达（批量构造抽样）", () => {
    const samples = [
      buildSpecificFeedback({ done: ["重建前三个步骤"], notYet: ["边界条件"] }),
      buildSpecificFeedback({ done: ["定位原文"], notYet: [] }),
      buildSpecificFeedback({ done: ["把问题保存下来"], notYet: ["对照证据"] }),
    ];
    for (const sample of samples) {
      assert.equal(isCompliantFeedbackCopy(sample), true, sample);
    }
  });

  it("文档示例文案本身合规", () => {
    assert.equal(
      isCompliantFeedbackCopy("这次你已经能重建前三个步骤，边界条件还没独立验证。"),
      true,
    );
  });
});
