/**
 * P6 顺序 10：soak 采样器单元测试（脱敏 + 快照）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSoakValue, SoakSampler } from "./soak-sampler.ts";

test("脱敏：数字/布尔归一，文本仅白名单枚举", () => {
  assert.equal(sanitizeSoakValue("electron_main_cpu", 12.3456), 12.346);
  assert.equal(sanitizeSoakValue("click_through", true), 1);
  assert.equal(sanitizeSoakValue("window_count", 3), 3);
  assert.equal(sanitizeSoakValue("click_through", "click_through_on"), "click_through_on");
  assert.equal(sanitizeSoakValue("display_fingerprint", "a".repeat(64)), "a".repeat(64));
  assert.equal(sanitizeSoakValue("display_fingerprint", "display-name"), null);
});

test("脱敏：自由文本（消息正文/URL/标题）一律拒绝", () => {
  assert.equal(sanitizeSoakValue("recent_error_count", "用户说：<p>正文</p>"), null);
  assert.equal(sanitizeSoakValue("recent_error_count", "https://example.test/private"), null);
  assert.equal(sanitizeSoakValue("recent_error_count", "我的学习卡片标题"), null);
  assert.equal(sanitizeSoakValue("recent_error_count", { nested: "object" }), null);
  assert.equal(sanitizeSoakValue("recent_error_count", NaN), null);
  assert.equal(sanitizeSoakValue("recent_error_count", Infinity), null);
});

test("采样器：记录 + 快照（version/seq/样本拷贝）", () => {
  const s = new SoakSampler(1_000);
  s.record("window_count", 2);
  s.record("recent_error_count", 0);
  s.record("recent_error_count", "应被脱敏丢弃");
  const snap = s.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.startedAt, 1_000);
  assert.equal(snap.seq, 1);
  assert.equal(snap.samples.length, 2, "脱敏失败的样本被丢弃");
  assert.equal(s.sampleCount, 2);
  snap.samples[0].value = 99; // 快照是拷贝，不污染内部
  assert.equal(s.snapshot().samples[0].value, 2);
});

test("采样器：seq 递增", () => {
  const s = new SoakSampler();
  assert.equal(s.snapshot().seq, 1);
  assert.equal(s.snapshot().seq, 2);
});

test("默认间隔 = 30 分钟（§10.4 最低采样）", () => {
  assert.equal(SoakSampler.DEFAULT_INTERVAL_MS, 30 * 60 * 1000);
});
