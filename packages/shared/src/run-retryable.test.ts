/**
 * Tests for run 可重试性判定（isRunErrorRetryable）。
 *
 * needs_attention run 的 errorCode 决定 `/retry` 是否值得展示：
 * - 预算耗尽 / 确定性门禁（VERIFY/PUBLISH）/ 快照漂移 → 不可重试
 * - 瞬时故障（provider 5xx / 超时 / 协议 / agent_*）→ 可重试
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRunErrorRetryable } from "./card-agent-contracts.ts";

describe("isRunErrorRetryable", () => {
  it("预算耗尽不可重试", () => {
    assert.equal(isRunErrorRetryable("budget_exhausted"), false);
    assert.equal(isRunErrorRetryable("budget_exhausted_during_pagination"), false);
  });

  it("历史中文预算耗尽消息不可重试", () => {
    assert.equal(
      isRunErrorRetryable("预算耗尽：text_extractor 的 maxTurns 已达上限 (3/3)"),
      false,
    );
  });

  it("快照漂移不可重试", () => {
    assert.equal(isRunErrorRetryable("provider_fingerprint_mismatch"), false);
  });

  it("确定性门禁（VERIFY）不可重试", () => {
    assert.equal(isRunErrorRetryable("coverage_insufficient"), false);
    assert.equal(isRunErrorRetryable("critic_check_failed"), false);
    assert.equal(isRunErrorRetryable("no_draft_for_verify"), false);
    assert.equal(isRunErrorRetryable("no_quality_report"), false);
    // verify 兜底拼接 code
    assert.equal(isRunErrorRetryable("verify_failed:candidate 文本包含……"), false);
  });

  it("确定性门禁（PUBLISH）不可重试", () => {
    assert.equal(isRunErrorRetryable("publish_failed"), false);
    assert.equal(isRunErrorRetryable("stale_epoch"), false);
    assert.equal(isRunErrorRetryable("draft_hash_mismatch"), false);
    // publish 兜底拼接 code
    assert.equal(isRunErrorRetryable("publish_failed:epoch fence 校验失败"), false);
  });

  it("配置/产品阻止不可重试", () => {
    assert.equal(isRunErrorRetryable("mock_provider_blocked_in_production"), false);
    assert.equal(isRunErrorRetryable("prepare_failed"), false);
    assert.equal(isRunErrorRetryable("superseded_by_manual_kill"), false);
  });

  it("瞬时故障可重试", () => {
    assert.equal(isRunErrorRetryable("openai_compatible request failed with HTTP 502"), true);
    assert.equal(isRunErrorRetryable("provider_unavailable"), true);
    assert.equal(isRunErrorRetryable("agent_timeout"), true);
    assert.equal(isRunErrorRetryable("agent_network"), true);
    assert.equal(isRunErrorRetryable("protocol_error"), true);
    assert.equal(isRunErrorRetryable("supervisor_needs_attention"), true);
  });

  it("null/undefined/未知 code 默认可重试", () => {
    assert.equal(isRunErrorRetryable(null), true);
    assert.equal(isRunErrorRetryable(undefined), true);
    assert.equal(isRunErrorRetryable("some_unclassified_error"), true);
  });
});
