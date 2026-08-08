import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyVoiceError } from "@/components/learning-companion/VoiceInputPanel";

/** ApiError 形状（真实链路：错误码在 err.code，name 恒为 ApiError）。 */
function apiError(code: string): unknown {
  return Object.assign(new Error("internal detail"), { code, name: "ApiError" });
}

test("friendlyVoiceError：白名单错误码 → 友好文案（不走 err.message）", () => {
  assert.equal(friendlyVoiceError(apiError("FROZEN_PROBE_MISMATCH")), "题目已失效或状态已变化，请刷新后重试。");
  assert.equal(friendlyVoiceError(apiError("ARTIFACT_LOCKED")), "该回答已锁定，无法重复操作。");
  assert.equal(friendlyVoiceError(apiError("STALE_REVISION")), "页面已过期，请刷新后重试。");
  assert.equal(friendlyVoiceError(apiError("VOICE_CONFIRM_MISMATCH")), "确认文本与转写不一致，请重录或改用文字回答。");
});

test("friendlyVoiceError：未知错误码/未知 Error → 通用文案（不透出内部细节）", () => {
  assert.equal(friendlyVoiceError(apiError("INTERNAL_SECRET_ERR")), "操作失败，请重试或改用文字回答。");
  assert.equal(friendlyVoiceError(new Error("sensitive detail")), "操作失败，请重试或改用文字回答。");
  assert.equal(friendlyVoiceError("plain string"), "操作失败，请重试或改用文字回答。");
  assert.equal(friendlyVoiceError(null), "操作失败，请重试或改用文字回答。");
  assert.equal(friendlyVoiceError(undefined), "操作失败，请重试或改用文字回答。");
});

test("friendlyVoiceError：白名单原文绝不进入输出（含 message 含码值的场景）", () => {
  const out = friendlyVoiceError(
    Object.assign(new Error("FROZEN_PROBE_MISMATCH 内部细节"), { code: "UNKNOWN" }),
  );
  assert.equal(out.includes("内部细节"), false);
});
