import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeTime } from "../format.ts";

// 第九轮 🟡today-relativeTime：relativeTime 的按天缓存（formatRelativeDate）
// 与分支语义回归测试。
// 说明：相对分支（刚刚/分钟/小时/天）依赖 Date.now()，用相对当前时刻的 iso
// 构造；≥7 天分支走 formatRelativeDate 的按天缓存路径。

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

test("relativeTime 相对分支", () => {
  assert.equal(relativeTime(new Date().toISOString()), "刚刚");
  assert.match(relativeTime(isoDaysAgo(0.01)), /^[0-9]+ 分钟前$/); // ~14.4 分钟
  assert.match(relativeTime(isoDaysAgo(0.3)), /^[0-9]+ 小时前$/); // ~7.2 小时
  assert.equal(relativeTime(isoDaysAgo(1)), "昨天");
  assert.equal(relativeTime(isoDaysAgo(3)), "3 天前");
});

test("relativeTime ≥7 天分支返回日期且同天缓存一致", () => {
  const a = isoDaysAgo(9);
  const b = new Date(new Date(a).getTime() + 60_000).toISOString(); // 同一天稍后
  const outA = relativeTime(a);
  const outB = relativeTime(b);
  // 同本地日 → 同格式化结果（缓存命中）
  assert.equal(outA, outB);
  // 输出为 "M月D日" 形态（zh-CN short month + day）
  assert.match(outA, /^\d{1,2}月\d{1,2}日$/);
});

test("relativeTime 跨天不串缓存", () => {
  const d1 = isoDaysAgo(30);
  const d2 = new Date(new Date(d1).getTime() + 86_400_000).toISOString(); // 次日
  const o1 = relativeTime(d1);
  const o2 = relativeTime(d2);
  // 两天不同 → 结果可不同（若格式化恰好相同（罕见）则跳过强断言，仅验证不抛错且为日期形态）
  assert.match(o1, /^\d{1,2}月\d{1,2}日$/);
  assert.match(o2, /^\d{1,2}月\d{1,2}日$/);
  assert.notEqual(o1, o2);
});

test("relativeTime 非法输入回退返回空串", () => {
  // null/undefined/无效日期 → 空串（不抛错）
  assert.equal(relativeTime(null), "");
  assert.equal(relativeTime(undefined), "");
  assert.equal(relativeTime("not-a-date"), "");
});
