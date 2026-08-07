/**
 * P2-9：Fast 路径灰度机制单元测试(feature flag 分桶)。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isFastPathEnabled,
  getFastPathRolloutPercent,
  isRunInFastBucket,
} from "@ailearn/shared";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("默认关闭(只统计不切换):FAST_PATH_ENABLED 未设 → false", () => {
  withEnv({ FAST_PATH_ENABLED: undefined, FAST_PATH_ROLLOUT_PERCENT: undefined }, () => {
    assert.equal(isFastPathEnabled(), false);
    assert.equal(getFastPathRolloutPercent(), 0);
    assert.equal(isRunInFastBucket("any-run"), false, "fail-closed");
  });
});

test("启用但百分比 0 → 不进入 Fast 桶(fail-closed)", () => {
  withEnv({ FAST_PATH_ENABLED: "true", FAST_PATH_ROLLOUT_PERCENT: "0" }, () => {
    assert.equal(isFastPathEnabled(), true);
    assert.equal(isRunInFastBucket("run-1"), false);
  });
});

test("启用 + 百分比 100 → 全部进入 Fast 桶", () => {
  withEnv({ FAST_PATH_ENABLED: "true", FAST_PATH_ROLLOUT_PERCENT: "100" }, () => {
    assert.equal(isRunInFastBucket("run-1"), true);
    assert.equal(isRunInFastBucket("run-2"), true);
  });
});

test("分桶稳定:同一 runId 多次判定一致(重试不换桶)", () => {
  withEnv({ FAST_PATH_ENABLED: "true", FAST_PATH_ROLLOUT_PERCENT: "50" }, () => {
    const runId = "50000000-0000-4000-8000-000000000031";
    const first = isRunInFastBucket(runId);
    for (let i = 0; i < 5; i++) {
      assert.equal(isRunInFastBucket(runId), first, "同 runId 必须稳定");
    }
  });
});

test("非法百分比收敛到 0(fail-closed)", () => {
  withEnv({ FAST_PATH_ENABLED: "true", FAST_PATH_ROLLOUT_PERCENT: "abc" }, () => {
    assert.equal(getFastPathRolloutPercent(), 0);
    assert.equal(isRunInFastBucket("run-1"), false);
  });
});

test("精确值才启用:'TRUE'/'1' 不算", () => {
  withEnv({ FAST_PATH_ENABLED: "TRUE" }, () => {
    assert.equal(isFastPathEnabled(), false);
  });
});
