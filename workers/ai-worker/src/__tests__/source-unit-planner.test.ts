import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateTokens,
  planSourceUnits,
  splitBlockExactly,
  verifyExactCoverage,
} from "../lib/source-unit-planner.ts";

test("planner reconstructs every character of a single 500k paragraph", () => {
  const source = `${"甲".repeat(249_999)}。${"beta ".repeat(50_000)}`;
  assert.equal(source.length, 500_000);
  const blocks = [{ id: "block-xl", ordinal: 0, type: "paragraph", content: source }];
  const plan = planSourceUnits("version-xl", blocks, {
    contextWindowTokens: 16_384,
    targetChunkTokens: 2_000,
    maxSourceUnitTokens: 700,
  });

  assert.ok(plan.spans.length > 100);
  assert.ok(plan.chunks.length > 100);
  assert.equal(plan.spans.map((span) => span.exactText).join(""), source);
  assert.ok(plan.spans.every((span) => span.tokenEstimate <= 700));
  assert.ok(plan.chunks.every((chunk) => chunk.tokenEstimate <= 2_000));
  verifyExactCoverage(blocks, plan.spans);
});

test("planner keeps heading breadcrumbs and deterministic unit keys", () => {
  const blocks = [
    { id: "h1", ordinal: 0, type: "heading", content: "# Database" },
    { id: "p1", ordinal: 1, type: "paragraph", content: "Indexes reduce the search space for selective queries." },
    { id: "h2", ordinal: 2, type: "heading", content: "## B+ Tree" },
    { id: "p2", ordinal: 3, type: "paragraph", content: "Leaf links support ordered range scans without returning to the root." },
  ];
  const first = planSourceUnits("version-1", blocks);
  const second = planSourceUnits("version-1", [...blocks].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(first.spans.find((span) => span.blockId === "p2")?.sectionPath, [
    "Database",
    "B+ Tree",
  ]);
});

test("natural and hard boundaries are both exact and bounded", () => {
  const natural = "First sentence. Second sentence. Third sentence.";
  const naturalSpans = splitBlockExactly(natural, 5);
  assert.equal(naturalSpans.map((span) => span.exactText).join(""), natural);

  const hard = "无边界".repeat(2_000);
  const hardSpans = splitBlockExactly(hard, 100);
  assert.equal(hardSpans.map((span) => span.exactText).join(""), hard);
  assert.ok(hardSpans.every((span) => estimateTokens(span.exactText) <= 100));
});

test("planner never splits UTF-16 surrogate pairs", () => {
  const source = `${"abcd🙂".repeat(200)}终点`;
  const spans = splitBlockExactly(source, 7);

  assert.equal(spans.map((span) => span.exactText).join(""), source);
  assert.ok(spans.every((span) => !/[\uD800-\uDBFF]$/.test(span.exactText)));
  assert.ok(spans.every((span) => !/^[\uDC00-\uDFFF]/.test(span.exactText)));
  assert.ok(spans.every((span) => span.tokenEstimate <= 7));
});

test("images are enumerated separately instead of being treated as alt text", () => {
  const plan = planSourceUnits("version-image", [
    { id: "image-1", ordinal: 0, type: "image", content: "![](https://object.invalid/a.png)" },
    { id: "text-1", ordinal: 1, type: "paragraph", content: "A complete text fact remains present." },
  ]);
  assert.deepEqual(plan.imageBlockIds, ["image-1"]);
  assert.equal(plan.spans.some((span) => span.blockId === "image-1"), false);
  assert.equal(plan.spans.map((span) => span.exactText).join(""), "A complete text fact remains present.");
});

// ─── 回归：map chunk 不得超过 cardMapInputSchema 的 200 单元上限 ─────────

test("chunks never exceed the 200-unit map input schema cap", () => {
  const blocks = Array.from({ length: 300 }, (_, i) => ({
    id: `p-${i}`,
    ordinal: i,
    type: "paragraph",
    content: `要点 ${i}：短句。`,
  }));
  const plan = planSourceUnits("version-many-short", blocks);
  assert.ok(plan.chunks.length >= 2, "300 个短块必须拆成多个 chunk");
  for (const chunk of plan.chunks) {
    assert.ok(
      chunk.unitKeys.length <= 200,
      `chunk ${chunk.ordinal} has ${chunk.unitKeys.length} units (> 200)`,
    );
  }
  // 全覆盖不丢失
  const totalUnits = plan.chunks.reduce((sum, c) => sum + c.unitKeys.length, 0);
  assert.equal(totalUnits, plan.spans.length);
});

// ─── 回归：跳级标题不得在 sectionPath 留下 null 空洞 ────────────────────

test("skipped heading levels produce dense string sectionPath (no null holes)", () => {
  const plan = planSourceUnits("version-skip-heading", [
    { id: "h1", ordinal: 0, type: "heading", content: "# 顶层" },
    { id: "h3", ordinal: 1, type: "heading", content: "### 深层" },
    { id: "p1", ordinal: 2, type: "paragraph", content: "正文内容足够长以形成 span。" },
    { id: "h2-first", ordinal: 3, type: "heading", content: "## 直接从二级开始" },
    { id: "p2", ordinal: 4, type: "paragraph", content: "另一段正文内容。" },
  ]);
  for (const span of plan.spans) {
    for (const segment of span.sectionPath) {
      assert.equal(typeof segment, "string", `sectionPath contains non-string: ${JSON.stringify(span.sectionPath)}`);
    }
    // jsonb round-trip 等价性：JSON.parse(JSON.stringify()) 后仍全是 string
    const roundTrip = JSON.parse(JSON.stringify(span.sectionPath)) as unknown[];
    assert.ok(roundTrip.every((seg) => typeof seg === "string"));
  }
});

// ─── 回归：编辑器 <hN> 标题按真实层级解析且不泄漏标签 ────────────────────

test("editor <hN> headings are parsed with real level and stripped tags", () => {
  const plan = planSourceUnits("version-html-heading", [
    { id: "h2", ordinal: 0, type: "heading", content: "<h2>编辑器标题</h2>" },
    { id: "p1", ordinal: 1, type: "paragraph", content: "编辑器创建的正文内容。" },
  ]);
  const span = plan.spans.find((s) => s.blockId === "p1");
  assert.ok(span, "paragraph span should exist");
  assert.ok(
    span!.sectionPath.every((seg) => !seg.includes("<h2>") && !seg.includes("</h2>")),
    `sectionPath leaks raw tags: ${JSON.stringify(span!.sectionPath)}`,
  );
  assert.ok(span!.sectionPath.includes("编辑器标题"));
});
