/**
 * AIQ-01 realAlignEvidence 单元测试
 *
 * 验证真实对齐函数与 mockAlignEvidence 在 Mock 输出上行为一致，
 * 且能正确处理真实模型输出中的轻微措辞差异。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realAlignEvidence } from "./real-align.ts";
import { generateMockOutput, mockAlignEvidence } from "./pr-runner.ts";
import { GOLDEN_DATASET } from "./dataset.ts";
import type { ModelCardOutput } from "./types.ts";

describe("realAlignEvidence", () => {
  it("对 Mock 输出（quote 取自原文）返回 aligned", () => {
    for (const sample of GOLDEN_DATASET) {
      const output = generateMockOutput(sample.file);
      const alignments = realAlignEvidence(sample.file, output);
      for (const align of alignments) {
        assert.equal(align.alignment, "aligned", `样本 ${sample.file} ordinal ${align.ordinal} 应为 aligned`);
        assert.ok(align.blockOrdinal !== null, `样本 ${sample.file} ordinal ${align.ordinal} blockOrdinal 不应为 null`);
        assert.equal(align.alignmentMethod, "exact", `样本 ${sample.file} ordinal ${align.ordinal} 应为 exact 方法`);
      }
    }
  });

  it("与 mockAlignEvidence 在 Mock 输出上结果一致", () => {
    for (const sample of GOLDEN_DATASET) {
      const output = generateMockOutput(sample.file);
      const real = realAlignEvidence(sample.file, output);
      const mock = mockAlignEvidence(sample.file, output);
      assert.equal(real.length, mock.length);
      for (let i = 0; i < real.length; i++) {
        assert.equal(real[i].ordinal, mock[i].ordinal);
        assert.equal(real[i].alignment, mock[i].alignment);
        assert.equal(real[i].blockOrdinal, mock[i].blockOrdinal);
      }
    }
  });

  it("空 quote 返回 unaligned", () => {
    const sample = GOLDEN_DATASET[0];
    const output: ModelCardOutput = {
      title: "test",
      summary: "test",
      key_points: [{ ordinal: 0, claim: "test", quote_text: "" }],
    };
    const alignments = realAlignEvidence(sample.file, output);
    assert.equal(alignments[0].alignment, "unaligned");
    assert.equal(alignments[0].blockOrdinal, null);
  });

  it("不存在的 quote 返回 unaligned", () => {
    const sample = GOLDEN_DATASET[0];
    const output: ModelCardOutput = {
      title: "test",
      summary: "test",
      key_points: [{ ordinal: 0, claim: "test", quote_text: "这段文字完全不存在于原文中abcdefghijk" }],
    };
    const alignments = realAlignEvidence(sample.file, output);
    assert.equal(alignments[0].alignment, "unaligned");
    assert.equal(alignments[0].blockOrdinal, null);
  });

  it("轻微措辞差异的 quote 仍能命中（fuzzy）", () => {
    const sample = GOLDEN_DATASET[0];
    // 取第一个块的前 60 字符作为基础，做轻微修改模拟模型输出差异
    const originalText = sample.blocks[0].content.slice(0, 60);
    const modifiedQuote = originalText.slice(0, 30) + " " + originalText.slice(30);

    const output: ModelCardOutput = {
      title: "test",
      summary: "test",
      key_points: [{ ordinal: 0, claim: "test", quote_text: modifiedQuote }],
    };
    const alignments = realAlignEvidence(sample.file, output);
    // 空格差异在 normalize 后会消除，所以应该是 exact
    assert.equal(alignments[0].alignment, "aligned");
    assert.equal(alignments[0].blockOrdinal, 0);
  });

  it("不存在的 noteFile 抛出错误", () => {
    const output: ModelCardOutput = {
      title: "test",
      summary: "test",
      key_points: [],
    };
    assert.throws(
      () => realAlignEvidence("nonexistent-file", output),
      /不存在于数据集中/,
    );
  });

  it("多个 key_points 各自独立对齐", () => {
    const sample = GOLDEN_DATASET[0];
    // 构造两个 key_point，一个取自 block 0，一个取自 block 1（如果存在）
    const blocks = sample.blocks;
    const kp0 = blocks[0]?.content.slice(0, 40) ?? "";
    const kp1 = blocks[1]?.content.slice(0, 40) ?? blocks[0]?.content.slice(40, 80) ?? "";

    const output: ModelCardOutput = {
      title: "test",
      summary: "test",
      key_points: [
        { ordinal: 0, claim: "claim0", quote_text: kp0 },
        { ordinal: 1, claim: "claim1", quote_text: kp1 },
      ],
    };
    const alignments = realAlignEvidence(sample.file, output);
    assert.equal(alignments.length, 2);
    assert.equal(alignments[0].alignment, "aligned");
    assert.equal(alignments[1].alignment, "aligned");
  });
});
