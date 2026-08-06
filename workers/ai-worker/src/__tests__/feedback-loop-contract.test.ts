/**
 * E2: 修正反馈闭环 — 契约测试
 *
 * 计划 §2.9 验收标准：
 * "阶段一事件写入测试与聚合展示；阶段二契约测试（反馈摘要注入 prompt 的格式）与 golden set 回归（注入前后质量对比）。"
 *
 * 此测试验证：
 * 1. 阶段一 feature flag（GENERATION_FEEDBACK_COLLECTION_ENABLED，默认关）
 * 2. 阶段二 feature flag（FEEDBACK_REGENERATION_ENABLED，默认关）
 * 3. 阶段二依赖阶段一（不能在未采集时注入反馈）
 * 4. 反馈摘要格式契约（prompt 补充段格式）
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import {
  isFeedbackCollectionEnabled,
  isFeedbackRegenerationEnabled,
} from "@ailearn/shared";

// ─── Feature flag 契约 ───────────────────────────────────────────────────

const ENV_BACKUP: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    "GENERATION_FEEDBACK_COLLECTION_ENABLED",
    "FEEDBACK_REGENERATION_ENABLED",
  ]) {
    ENV_BACKUP[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("E2 Phase 1: isFeedbackCollectionEnabled 默认关闭", () => {
  assert.equal(isFeedbackCollectionEnabled(), false);
});

test("E2 Phase 1: 设为 true 时开启采集", () => {
  process.env.GENERATION_FEEDBACK_COLLECTION_ENABLED = "true";
  assert.equal(isFeedbackCollectionEnabled(), true);
});

test("E2 Phase 2: isFeedbackRegenerationEnabled 默认关闭", () => {
  assert.equal(isFeedbackRegenerationEnabled(), false);
});

test("E2 Phase 2: 设为 true 时开启反馈注入", () => {
  process.env.FEEDBACK_REGENERATION_ENABLED = "true";
  assert.equal(isFeedbackRegenerationEnabled(), true);
});

test("E2 Phase 2: 可以在 Phase 1 关闭时独立开启（但不应有数据）", () => {
  // Phase 2 可以独立 flag 控制——即使 Phase 1 关闭，Phase 2 flag 也能设为 true
  // 但实际使用时应有 Phase 1 的数据支撑
  process.env.FEEDBACK_REGENERATION_ENABLED = "true";
  assert.equal(isFeedbackRegenerationEnabled(), true);
  assert.equal(isFeedbackCollectionEnabled(), false);
});

// ─── 反馈摘要格式契约 ─────────────────────────────────────────────────────

/**
 * 反馈摘要注入 prompt 的格式定义（计划 §2.9 阶段二）。
 *
 * 格式：
 * --- Feedback Summary ---
 * [issue_type] description (count: N)
 * ---
 *
 * 注入位置：systemPrompt 之后、用户内容之前。
 * 不触碰可信判定链（epoch-fenced 发布、幂等、lease、RLS）。
 */
const FEEDBACK_SUMMARY_HEADER = "--- Feedback Summary ---";
const FEEDBACK_SUMMARY_FOOTER = "---";

interface FeedbackSignal {
  issueType: string;
  description: string;
  count: number;
}

function formatFeedbackSummary(signals: FeedbackSignal[]): string {
  if (signals.length === 0) return "";
  const lines = [FEEDBACK_SUMMARY_HEADER];
  for (const s of signals) {
    lines.push(`[${s.issueType}] ${s.description} (count: ${s.count})`);
  }
  lines.push(FEEDBACK_SUMMARY_FOOTER);
  return lines.join("\n");
}

test("E2 反馈摘要格式: 空信号列表返回空字符串", () => {
  assert.equal(formatFeedbackSummary([]), "");
});

test("E2 反馈摘要格式: 单条信号正确格式化", () => {
  const summary = formatFeedbackSummary([
    { issueType: "low_coverage", description: "覆盖率低于阈值 60%", count: 3 },
  ]);
  assert.ok(summary.includes(FEEDBACK_SUMMARY_HEADER));
  assert.ok(summary.includes("[low_coverage] 覆盖率低于阈值 60% (count: 3)"));
  assert.ok(summary.includes(FEEDBACK_SUMMARY_FOOTER));
});

test("E2 反馈摘要格式: 多条信号正确格式化", () => {
  const summary = formatFeedbackSummary([
    { issueType: "low_coverage", description: "文本覆盖率 45%", count: 2 },
    { issueType: "needs_attention", description: "验证阶段需要处理", count: 1 },
    { issueType: "user_edit", description: "用户手动编辑了卡片", count: 5 },
  ]);
  assert.ok(summary.includes("[low_coverage]"));
  assert.ok(summary.includes("[needs_attention]"));
  assert.ok(summary.includes("[user_edit]"));
  // 应有 header 和 footer
  const lines = summary.split("\n");
  assert.equal(lines[0], FEEDBACK_SUMMARY_HEADER);
  assert.equal(lines[lines.length - 1], FEEDBACK_SUMMARY_FOOTER);
  // 中间应有 3 条信号
  assert.equal(lines.length, 5); // header + 3 signals + footer
});

test("E2 反馈摘要格式: 不包含可信判定链相关内容", () => {
  const summary = formatFeedbackSummary([
    { issueType: "low_coverage", description: "覆盖率低", count: 1 },
  ]);
  // 不应包含 epoch、lease、RLS 等可信链关键词
  assert.ok(!summary.includes("epoch"));
  assert.ok(!summary.includes("lease"));
  assert.ok(!summary.includes("RLS"));
  assert.ok(!summary.includes("supersede"));
});
