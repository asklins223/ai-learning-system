import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyTextError } from "./TextOrMixedInput";

function apiError(code: string): unknown {
  return Object.assign(new Error("internal detail"), { code, name: "ApiError" });
}

test("friendlyTextError：白名单错误码 → 友好文案", () => {
  assert.equal(friendlyTextError(apiError("FROZEN_PROBE_MISMATCH")), "题目已失效或状态已变化，请刷新后重试。");
  assert.equal(friendlyTextError(apiError("ARTIFACT_LOCKED")), "该回答已锁定，无法重复操作。");
  assert.equal(friendlyTextError(apiError("STALE_REVISION")), "页面已过期，请刷新后重试。");
  assert.equal(friendlyTextError(apiError("INVALID_ARGUMENT")), "提交内容不合法，请检查后重试。");
});

test("friendlyTextError：未知错误 → 通用文案（不透出内部细节）", () => {
  assert.equal(friendlyTextError(apiError("DB_CONN_ERR")), "提交失败，请重试。");
  assert.equal(friendlyTextError(new Error("sensitive detail")), "提交失败，请重试。");
  assert.equal(friendlyTextError("x"), "提交失败，请重试。");
});
