import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHereAndNow, weekdayLabel, type HereAndNowSnapshot } from "./companion-here-and-now.ts";

function snapshot(overrides: Partial<HereAndNowSnapshot> = {}): HereAndNowSnapshot {
  return {
    localTime: "2026-09-20 18:12",
    weekday: "周六",
    partOfDay: "晚上",
    minutesSinceLastSeen: null,
    pet: null,
    activeRun: null,
    dueReviews: 0,
    today: { studySeconds: 0, runs: 0 },
    recentNotes: [],
    noteCount: 0,
    pendingProposals: 0,
    nextReminder: null,
    currentPage: null,
    ...overrides,
  };
}

test("答应的提醒会出现在她知道的当下（不记得自己许过约，比没答应更伤）", () => {
  const block = renderHereAndNow(snapshot({
    nextReminder: { text: "把消防笔记的疏散路线过一遍", fireAtLocal: "09-21 09:00" },
  }));
  assert.ok(block?.includes("09-21 09:00"));
  assert.ok(block?.includes("消防笔记"));
});

test("DOW → 中文星期：0=周日 … 6=周六（下标写错会天天报错星期）", () => {
  assert.equal(weekdayLabel(0), "周日");
  assert.equal(weekdayLabel(1), "周一");
  assert.equal(weekdayLabel(5), "周五");
  assert.equal(weekdayLabel(6), "周六");
});

test("空状态只有一行时钟时整块不注入", () => {
  assert.equal(renderHereAndNow(snapshot()), null);
});

test("有值行才渲染，空行不进 prompt", () => {
  const block = renderHereAndNow(snapshot({
    dueReviews: 41,
    today: { studySeconds: 1560, runs: 2 },
    activeRun: { topic: "贝叶斯更新", phase: "active", usedSeconds: 240, budgetSeconds: 600, taskPrompt: "解释先验概率" },
  }))!;
  assert.match(block, /^<here_and_now>\n/);
  assert.match(block, /\n<\/here_and_now>$/);
  assert.match(block, /现在：2026-09-20 18:12 周六（晚上）/);
  assert.match(block, /正在学习「贝叶斯更新」，已学 4 分钟 \/ 计划 10 分钟，正在做：解释先验概率/);
  assert.match(block, /今日已学 26 分钟，2 个学习运行，到期待复习 41 项/);
  // 没有笔记、没有待确认动作、没有宠物档案 → 这三行必须整个不出现，而不是写成"无"。
  assert.doesNotMatch(block, /最近笔记/);
  assert.doesNotMatch(block, /还有 .* 个动作/);
  assert.doesNotMatch(block, /你是「/);
  assert.doesNotMatch(block, /无/);
});

test("久未见面才提示间隔，刚聊过不打扰", () => {
  assert.doesNotMatch(renderHereAndNow(snapshot({ minutesSinceLastSeen: 5 })) ?? "", /距上次/);
  assert.match(renderHereAndNow(snapshot({ minutesSinceLastSeen: 20 })) ?? "", /距上次和用户说话：20 分钟前/);
  assert.match(renderHereAndNow(snapshot({ minutesSinceLastSeen: 60 * 26 })) ?? "", /距上次和用户说话：昨天/);
});

test("笔记标题与目标超长被截断，不撑爆每轮 token", () => {
  const block = renderHereAndNow(snapshot({
    activeRun: { topic: "一".repeat(80), phase: "active", usedSeconds: 0, budgetSeconds: null, taskPrompt: null },
    recentNotes: [{ title: "《嵌套》书名号里还有很长的标题一直到需要截断的程度", ageLabel: "刚刚" }],
    noteCount: 828,
  }))!;
  // 标题里带书名号也不能把整行撑爆：按 20 字截断加省略号（不做嵌套解析，那是渲染层的事）。
  const noteLine = block.split("\n").find((line) => line.startsWith("最近笔记"))!;
  assert.match(noteLine, /《.*?…》\(刚刚\)；笔记库共 828 篇$/);
  assert.ok(noteLine.length < 60, `笔记行应被截住，实际 ${noteLine.length}`);
  assert.ok(block.length < 400, `整块应控制在几百字符内，实际 ${block.length}`);
});
