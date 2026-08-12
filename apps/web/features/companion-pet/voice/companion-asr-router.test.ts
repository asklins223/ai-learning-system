/**
 * P6 §13：ASR 路由决策 + 性能探测流程单元测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideAsrRoute,
  probePass,
  shouldDegradeToCloud,
  staticCompatPass,
  type AsrRouterContext,
  type ProbeResult,
  type StaticCompatInput,
} from "./companion-asr-router.ts";

const goodStatic: StaticCompatInput = {
  arch: "arm64",
  logicalCores: 8,
  totalMemoryGB: 16,
  availableMemoryGB: 4,
  freeDiskGB: 10,
  nativeRuntimeLoadable: true,
  modelHashValid: true,
};

const goodProbe: ProbeResult = {
  coldStartMs: 900,
  warmRtf: 0.3,
  peakMemoryDeltaMB: 250,
  modelCrashed: false,
  sustainedSlow: false,
  modelLoadFailed: false,
};

const ctx = (over: Partial<AsrRouterContext> = {}): AsrRouterContext => ({
  staticInput: goodStatic,
  probe: goodProbe,
  siliconFlowAvailable: true,
  userConsentedCloud: true,
  ...over,
});

test("静态兼容：全满足 → pass；任一不足 → fail", () => {
  assert.ok(staticCompatPass(goodStatic));
  assert.ok(!staticCompatPass({ ...goodStatic, arch: "other" }));
  assert.ok(!staticCompatPass({ ...goodStatic, nativeRuntimeLoadable: false }));
  assert.ok(!staticCompatPass({ ...goodStatic, modelHashValid: false }));
  assert.ok(!staticCompatPass({ ...goodStatic, logicalCores: 2 }));
  assert.ok(!staticCompatPass({ ...goodStatic, totalMemoryGB: 6 }));
  assert.ok(!staticCompatPass({ ...goodStatic, availableMemoryGB: 0.8 }));
  assert.ok(!staticCompatPass({ ...goodStatic, freeDiskGB: 1 }));
});

test("性能探测 Gate：RTF/冷启动/内存/崩溃/慢窗口", () => {
  assert.ok(probePass(goodProbe));
  assert.ok(!probePass({ ...goodProbe, warmRtf: 0.6 }));
  assert.ok(!probePass({ ...goodProbe, coldStartMs: 4_000 }));
  assert.ok(!probePass({ ...goodProbe, peakMemoryDeltaMB: 900 }));
  assert.ok(!probePass({ ...goodProbe, modelCrashed: true }));
  assert.ok(!probePass({ ...goodProbe, sustainedSlow: true }));
  assert.ok(!probePass({ ...goodProbe, modelLoadFailed: true }));
});

test("三路由决策：本地通过 → local_streaming；硬件不足 → siliconflow_file；无云端/未同意 → text_only", () => {
  assert.equal(decideAsrRoute(ctx()), "local_streaming");
  assert.equal(
    decideAsrRoute(ctx({ staticInput: { ...goodStatic, logicalCores: 2 } })),
    "siliconflow_file",
  );
  assert.equal(
    decideAsrRoute(ctx({ probe: { ...goodProbe, warmRtf: 0.9 } })),
    "siliconflow_file",
  );
  assert.equal(decideAsrRoute(ctx({ probe: null })), "siliconflow_file");
  // 本地不足 + 无云端 → text_only
  assert.equal(
    decideAsrRoute(ctx({ staticInput: { ...goodStatic, logicalCores: 2 }, siliconFlowAvailable: false })),
    "text_only",
  );
  // 本地不足 + 未告知 → text_only（不静默上传）
  assert.equal(
    decideAsrRoute(ctx({ staticInput: { ...goodStatic, logicalCores: 2 }, userConsentedCloud: false })),
    "text_only",
  );
  // 本地可用时即使云端不可用/未告知仍 local_streaming（本地识别不依赖云端）
  assert.equal(decideAsrRoute(ctx({ siliconFlowAvailable: false })), "local_streaming");
  assert.equal(decideAsrRoute(ctx({ userConsentedCloud: false })), "local_streaming");
});

test("运行中降级：local 且 RTF>0.8 或崩溃 → 切 siliconflow_file", () => {
  assert.ok(shouldDegradeToCloud("local_streaming", { sustainedSlow: true, modelCrashed: false }));
  assert.ok(shouldDegradeToCloud("local_streaming", { sustainedSlow: false, modelCrashed: true }));
  assert.ok(!shouldDegradeToCloud("local_streaming", { sustainedSlow: false, modelCrashed: false }));
  assert.ok(!shouldDegradeToCloud("siliconflow_file", { sustainedSlow: true, modelCrashed: false }));
  assert.ok(!shouldDegradeToCloud("text_only", { sustainedSlow: true, modelCrashed: true }));
});
