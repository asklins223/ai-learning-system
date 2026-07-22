import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatRelativeTime,
  formatScheduleChange,
  getOutcomeMeta,
  getReasonCodeLabel,
  getAnswerTypeLabel,
  OUTCOME_LABELS,
  REASON_CODE_LABELS,
  ANSWER_TYPE_LABELS,
} from "../review-attempt-format";

describe("review attempt formatting", () => {
  describe("formatRelativeTime", () => {
    it("returns empty string for null input", () => {
      assert.equal(formatRelativeTime(null), "");
    });

    it("returns empty string for undefined input", () => {
      assert.equal(formatRelativeTime(undefined as unknown as null), "");
    });

    it("returns empty string for invalid date string", () => {
      assert.equal(formatRelativeTime("not-a-date"), "");
    });

    it("returns 刚刚 for time within the last minute", () => {
      const now = new Date(Date.now() - 30_000).toISOString();
      assert.equal(formatRelativeTime(now), "刚刚");
    });

    it("returns minutes for time within the last hour", () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      assert.equal(formatRelativeTime(fiveMinAgo), "5 分钟前");
    });

    it("returns hours for time within the last day", () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
      assert.equal(formatRelativeTime(threeHoursAgo), "3 小时前");
    });

    it("returns days for time within the last 30 days", () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
      assert.equal(formatRelativeTime(fiveDaysAgo), "5 天前");
    });

    it("returns months for time within the last year", () => {
      const twoMonthsAgo = new Date(Date.now() - 62 * 24 * 60 * 60_000).toISOString();
      assert.equal(formatRelativeTime(twoMonthsAgo), "2 个月前");
    });

    it("returns years for time more than 12 months ago", () => {
      const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60_000).toISOString();
      assert.equal(formatRelativeTime(twoYearsAgo), "2 年前");
    });
  });

  describe("formatScheduleChange", () => {
    it("returns dash when both before and after are null", () => {
      assert.equal(formatScheduleChange(null, null), "—");
    });

    it("returns first schedule format when before is null", () => {
      assert.equal(formatScheduleChange(null, 7), "首次安排 · 7 天后");
    });

    it("returns unscheduled format when after is null", () => {
      assert.equal(formatScheduleChange(7, null), "7 天 → 未安排");
    });

    it("returns maintain format when before equals after", () => {
      assert.equal(formatScheduleChange(7, 7), "维持 7 天");
    });

    it("returns extend format when after is greater than before", () => {
      assert.equal(formatScheduleChange(3, 7), "3 天 → 7 天（延长）");
    });

    it("returns shorten format when after is less than before", () => {
      assert.equal(formatScheduleChange(14, 7), "14 天 → 7 天（缩短）");
    });

    it("handles zero day intervals", () => {
      assert.equal(formatScheduleChange(0, 0), "维持 0 天");
      assert.equal(formatScheduleChange(null, 0), "首次安排 · 0 天后");
    });
  });

  describe("getOutcomeMeta", () => {
    it("returns correct metadata for each known outcome", () => {
      assert.deepEqual(getOutcomeMeta("correct"), { label: "掌握", tone: "success" });
      assert.deepEqual(getOutcomeMeta("partial"), { label: "部分掌握", tone: "warning" });
      assert.deepEqual(getOutcomeMeta("incorrect"), { label: "未掌握", tone: "danger" });
      assert.deepEqual(getOutcomeMeta("unable"), { label: "无法判断", tone: "muted" });
    });

    it("returns null for unknown outcome", () => {
      assert.equal(getOutcomeMeta("unknown"), null);
    });

    it("returns null for null/undefined input", () => {
      assert.equal(getOutcomeMeta(null), null);
      assert.equal(getOutcomeMeta(undefined), null);
    });
  });

  describe("getReasonCodeLabel", () => {
    it("returns label for each known reason code", () => {
      // v0.5 canonical reason codes
      assert.equal(getReasonCodeLabel("correct_advance"), "回答正确，复习间隔已延长");
      assert.equal(getReasonCodeLabel("correct_interval_cap"), "回答正确，已达到最长复习间隔");
      assert.equal(getReasonCodeLabel("partial_advance"), "部分掌握，复习间隔已延长一档");
      assert.equal(getReasonCodeLabel("partial_interval_cap"), "部分掌握，已保持最长复习间隔");
      assert.equal(getReasonCodeLabel("incorrect_reset"), "本轮未掌握，下次从短间隔重新巩固");
      assert.equal(getReasonCodeLabel("unable_reset"), "本轮无法判断，下次从短间隔重新确认");
      assert.equal(getReasonCodeLabel("later_short_deferral"), "已稍后处理，短暂推迟本轮复习");
      assert.equal(getReasonCodeLabel("question_invalid"), "验证问题不可用，本轮暂不提升间隔");
      assert.equal(getReasonCodeLabel("evidence_insufficient"), "关键点证据不足，本轮暂不提升间隔");
      // Compatibility codes for early v0.5 records
      assert.equal(getReasonCodeLabel("correct_full"), "全部正确，间隔延长");
      assert.equal(getReasonCodeLabel("correct_recover"), "纠正后正确，恢复间隔");
      assert.equal(getReasonCodeLabel("partial_shorten"), "部分正确，缩短间隔");
      assert.equal(getReasonCodeLabel("unable_later"), "无法判断，推迟复习");
      assert.equal(getReasonCodeLabel("later_postpone"), "主动推迟");
      assert.equal(getReasonCodeLabel("initial"), "首次安排");
      assert.equal(getReasonCodeLabel("scheduled"), "按计划到期");
    });

    it("returns original code for unknown reason code", () => {
      assert.equal(getReasonCodeLabel("unknown_code"), "unknown_code");
    });

    it("returns null for null/undefined input", () => {
      assert.equal(getReasonCodeLabel(null), null);
      assert.equal(getReasonCodeLabel(undefined), null);
    });
  });

  describe("getAnswerTypeLabel", () => {
    it("returns label for each known answer type", () => {
      assert.equal(getAnswerTypeLabel("recall"), "回忆");
      assert.equal(getAnswerTypeLabel("free_text"), "自由作答");
      assert.equal(getAnswerTypeLabel("self_grade"), "自评");
    });

    it("returns original type for unknown answer type", () => {
      assert.equal(getAnswerTypeLabel("multiple_choice"), "multiple_choice");
    });

    it("returns null for null/undefined input", () => {
      assert.equal(getAnswerTypeLabel(null), null);
      assert.equal(getAnswerTypeLabel(undefined), null);
    });
  });

  describe("label maps completeness", () => {
    it("OUTCOME_LABELS has exactly 4 outcomes", () => {
      assert.equal(Object.keys(OUTCOME_LABELS).length, 4);
    });

    it("REASON_CODE_LABELS has exactly 16 reason codes (9 v0.5 + 7 compat)", () => {
      assert.equal(Object.keys(REASON_CODE_LABELS).length, 16);
    });

    it("ANSWER_TYPE_LABELS has exactly 3 answer types", () => {
      assert.equal(Object.keys(ANSWER_TYPE_LABELS).length, 3);
    });

    it("all outcome labels have non-empty label and valid tone", () => {
      const validTones = ["success", "warning", "danger", "muted"];
      for (const meta of Object.values(OUTCOME_LABELS)) {
        assert.ok(meta.label.length > 0, "label should not be empty");
        assert.ok(validTones.includes(meta.tone), `tone should be valid: ${meta.tone}`);
      }
    });

    it("all reason code labels are non-empty", () => {
      for (const label of Object.values(REASON_CODE_LABELS)) {
        assert.ok(label.length > 0, "label should not be empty");
      }
    });

    it("all answer type labels are non-empty", () => {
      for (const label of Object.values(ANSWER_TYPE_LABELS)) {
        assert.ok(label.length > 0, "label should not be empty");
      }
    });
  });
});
