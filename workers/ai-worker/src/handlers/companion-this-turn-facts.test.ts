import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTurnReferences, TURN_REFERENCE_MAX } from "./companion-this-turn-facts.ts";
import type { LivePageView } from "./companion-live-view.ts";

function view(overrides: Partial<LivePageView> = {}): LivePageView {
  return {
    pageKind: "review",
    interactionState: "idle",
    learningRunId: null,
    title: null,
    statusLine: null,
    items: [
      { ordinal: 1, label: "复利效应", state: "到期待复习" },
      { ordinal: 3, label: "索引的选择性", state: "已安排复习" },
      { ordinal: 4, label: "第四张卡的名字", state: null },
    ],
    ...overrides,
  };
}

test("序数指代落在当前这一屏的 items[].ordinal 上，取到的是屏上那个名字", () => {
  const refs = extractTurnReferences("为啥第四张学习卡这么慢", view());
  const ordinal = refs.find((ref) => ref.rule === "ordinal");
  assert.ok(ordinal, "第四张没有解析出指称——这一条正是 P1 的原始事故");
  assert.equal(ordinal.ordinal, 4);
  assert.equal(ordinal.text, "第四张卡的名字", "取的应当是屏上那一项的名字");
  assert.equal(ordinal.resolvable, true);
  // 「第四张」在卡片/复习页上指学习卡；页型认不出来时按卡处理（review → card）。
  assert.equal(ordinal.entity, "card");
});

test("中文序数也认，且屏上没有那一项时**不解析**（给出的是没解析出来的回执）", () => {
  const refs = extractTurnReferences("第三条是什么", view());
  const ordinal = refs.find((ref) => ref.rule === "ordinal");
  assert.ok(ordinal);
  assert.equal(ordinal.resolvable, true);
  assert.equal(ordinal.text, "索引的选择性");

  const missing = extractTurnReferences("第九条是什么", view()).find((ref) => ref.rule === "ordinal");
  assert.ok(missing);
  assert.equal(missing.resolvable, false, "序号在屏上不存在时不能当成解析出来了");
  assert.equal(missing.ordinal, 9);
});

test("代词只在当前视图有 title 时才解析；没有 title 就退化成回执", () => {
  const withTitle = extractTurnReferences("这篇讲了什么", view({ pageKind: "note", title: "数据库索引优化策略" }));
  const ref = withTitle.find((entry) => entry.rule === "pronoun");
  assert.ok(ref);
  assert.equal(ref.resolvable, true);
  assert.equal(ref.text, "数据库索引优化策略");
  assert.equal(ref.entity, "note");

  const noTitle = extractTurnReferences("这篇讲了什么", view({ pageKind: "note", title: null }));
  const degraded = noTitle.find((entry) => entry.rule === "pronoun");
  assert.ok(degraded);
  assert.equal(degraded.resolvable, false, "取不到当前对象时不许猜");
});

test("裸标题只在没有更强指称时才试，且不做「每句话都猜一个标题」", () => {
  const bare = extractTurnReferences("数据库索引优化策略 讲了什么", view());
  assert.equal(bare.length, 1);
  assert.equal(bare[0].rule, "bare");
  assert.equal(bare[0].text, "数据库索引优化策略 讲了什么");

  // 带《》的那句：规则① 由 `noteReference` 承担（`<here_and_now>` 里那几行），这里
  // 只剩兜底的那一条——同一个事实两处渲染就是两份，所以这一条刻意不解析书名号。
  const bracketed = extractTurnReferences("《数据库索引优化策略》讲了什么", view());
  assert.ok(
    bracketed.every((ref) => ref.rule === "bare"),
    `书名号那一支没落在 noteReference 上：${JSON.stringify(bracketed)}`,
  );
});

test("显式 id 认 uuid；一句话里多个指称最多 6 条", () => {
  const idRef = extractTurnReferences("看看 3f1c9a54-1b2e-4c3d-8e9f-0a1b2c3d4e5f 这篇", view({ pageKind: "note", title: null }));
  assert.ok(idRef.some((ref) => ref.rule === "id" && ref.text === "3f1c9a54-1b2e-4c3d-8e9f-0a1b2c3d4e5f"));

  const many = extractTurnReferences("第1张 第2张 第3张 第4张 第5张 第6张 第7张", view());
  assert.ok(many.length <= TURN_REFERENCE_MAX, `指称条数没有上限：${many.length}`);
});

test("没有用户输入就没有指称（主动链不查库的那条前提）", () => {
  assert.deepEqual(extractTurnReferences(undefined, view()), []);
  assert.deepEqual(extractTurnReferences("   ", view()), []);
});
