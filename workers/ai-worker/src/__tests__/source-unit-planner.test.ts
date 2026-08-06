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

// ─── 回归：map chunk 留出结构化输出余量，不顶满 200 单元 schema 上限 ─────

test("chunks cap short evidence batches at 50 units", () => {
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
      chunk.unitKeys.length <= 50,
      `chunk ${chunk.ordinal} has ${chunk.unitKeys.length} units (> 50)`,
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

// ─── 回归：────Title──── 样式装饰性章节标记被正确识别 ──────────────────

test("decorative section markers (────Title────) are detected as level-1 headings", () => {
  const plan = planSourceUnits("version-section-marker", [
    { id: "p0", ordinal: 0, type: "paragraph", content: "这是引言部分。" },
    { id: "p1", ordinal: 1, type: "paragraph", content: "────什么是 Graph Engineering？────" },
    { id: "p2", ordinal: 2, type: "paragraph", content: "graph engineering 是在干嘛呢？" },
    { id: "p3", ordinal: 3, type: "paragraph", content: "────Graph Engineering 的工作原理是什么？────" },
    { id: "p4", ordinal: 4, type: "paragraph", content: "一张 graph 拆开就三样东西。" },
  ]);
  const introSpan = plan.spans.find((s) => s.blockId === "p0");
  const section1Span = plan.spans.find((s) => s.blockId === "p2");
  const section2Span = plan.spans.find((s) => s.blockId === "p4");
  assert.ok(introSpan, "intro span should exist");
  assert.ok(section1Span, "section 1 span should exist");
  assert.ok(section2Span, "section 2 span should exist");
  assert.deepEqual(introSpan!.sectionPath, [], "intro should have empty sectionPath");
  assert.deepEqual(
    section1Span!.sectionPath,
    ["什么是 Graph Engineering？"],
    "section 1 should use the marker title",
  );
  assert.deepEqual(
    section2Span!.sectionPath,
    ["Graph Engineering 的工作原理是什么？"],
    "section 2 should use the marker title",
  );
  // The section marker block itself should also be in the new section
  const markerSpan = plan.spans.find((s) => s.blockId === "p1");
  assert.deepEqual(
    markerSpan!.sectionPath,
    ["什么是 Graph Engineering？"],
    "marker block should be in its own section",
  );
});

// ─── 回归：图片块继承周围文本的 sectionPath ──────────────────────────

test("image blocks inherit sectionPath from surrounding text", () => {
  const plan = planSourceUnits("version-image-section", [
    { id: "p0", ordinal: 0, type: "paragraph", content: "引言文字。" },
    { id: "img1", ordinal: 1, type: "image", content: "![图片](url1.png)" },
    { id: "p1", ordinal: 2, type: "paragraph", content: "────什么是 Graph Engineering？────" },
    { id: "p2", ordinal: 3, type: "paragraph", content: "graph 的定义。" },
    { id: "img2", ordinal: 4, type: "image", content: "![图片](url2.png)" },
    { id: "img3", ordinal: 5, type: "image", content: "![图](url3.png)" },
    { id: "p3", ordinal: 6, type: "paragraph", content: "────Graph Engineering 怎么上手实操？────" },
    { id: "p4", ordinal: 7, type: "paragraph", content: "动手之前先泼一盆冷水。" },
    { id: "img4", ordinal: 8, type: "image", content: "![示意图](url4.png)" },
  ]);
  const imgSectionPaths = new Map(plan.imageSectionPaths.map((entry) => [entry.blockId, entry.sectionPath]));
  assert.deepEqual(imgSectionPaths.get("img1"), [], "image before any heading should have empty sectionPath");
  assert.deepEqual(
    imgSectionPaths.get("img2"),
    ["什么是 Graph Engineering？"],
    "image after first section marker should inherit that section",
  );
  assert.deepEqual(
    imgSectionPaths.get("img3"),
    ["什么是 Graph Engineering？"],
    "second image in same section should inherit same sectionPath",
  );
  assert.deepEqual(
    imgSectionPaths.get("img4"),
    ["Graph Engineering 怎么上手实操？"],
    "image after second section marker should inherit new section",
  );
  // imageBlockIds should still be populated
  assert.deepEqual(plan.imageBlockIds, ["img1", "img2", "img3", "img4"]);
});
