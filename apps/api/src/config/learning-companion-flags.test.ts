import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLearningSessionCanonicalCommitEnabled,
  isLearningSessionV2InternalEnabled,
  learningSessionRolloutDisabledReason,
} from "./learning-companion-flags.ts";

test("learning-session rollout gates default to closed", () => {
  const internal = process.env.LEARNING_SESSION_V2_INTERNAL;
  const canonical = process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED;
  delete process.env.LEARNING_SESSION_V2_INTERNAL;
  delete process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED;
  try {
    assert.equal(isLearningSessionV2InternalEnabled(), false);
    assert.equal(isLearningSessionCanonicalCommitEnabled(), false);
    assert.equal(learningSessionRolloutDisabledReason(), "学习伴星重构路径当前仅供内部验证");
  } finally {
    if (internal === undefined) delete process.env.LEARNING_SESSION_V2_INTERNAL;
    else process.env.LEARNING_SESSION_V2_INTERNAL = internal;
    if (canonical === undefined) delete process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED;
    else process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED = canonical;
  }
});

test("canonical commit remains closed when only internal session is enabled", () => {
  const internal = process.env.LEARNING_SESSION_V2_INTERNAL;
  const canonical = process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED;
  process.env.LEARNING_SESSION_V2_INTERNAL = "true";
  delete process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED;
  try {
    assert.equal(isLearningSessionV2InternalEnabled(), true);
    assert.equal(isLearningSessionCanonicalCommitEnabled(), false);
    assert.equal(learningSessionRolloutDisabledReason(), "正式学习结果尚未开放；当前仅支持诊断练习");
  } finally {
    if (internal === undefined) delete process.env.LEARNING_SESSION_V2_INTERNAL;
    else process.env.LEARNING_SESSION_V2_INTERNAL = internal;
    if (canonical === undefined) delete process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED;
    else process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED = canonical;
  }
});
