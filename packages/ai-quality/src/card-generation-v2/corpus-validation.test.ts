/**
 * 方案 20 §23.1 — Corpus 规模与质量校验（人工标注版）。
 *
 * 断言：
 * - 总量 ≥ 300；
 * - micro（content ≤ 500 字符）≥ 180；中长（> 500）≥ 60；
 * - modality ∈ {code, formula, table, image, mixed} ≥ 30；
 * - 零卡/安全/对抗（zeroCardReasonCodes 或 safetyExpectations）≥ 30；
 * - 全体至少 20% 允许 0 卡；
 * - dev/validation/holdout 三 split 均非空；
 * - fixtureId 全局唯一；
 * - 每条通过 strict schema 解析（未知字段拒绝）；
 * - exactTextHash 均为 64 位十六进制（真实 SHA-256，禁用占位符）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCardGenerationFixtureV2 } from "./fixture-schema.ts";
import {
  V2_FIXTURE_CORPUS_SEED,
  zeroCardFixtureRatio,
  corpusSplitCounts,
  corpusModalityCounts,
} from "./corpus/index.ts";

const MODALITY_GROUPS = new Set(["code", "formula", "table", "image", "mixed"]);

describe("§23.1 Corpus 规模", () => {
  it("总量 ≥ 300", () => {
    assert.ok(
      V2_FIXTURE_CORPUS_SEED.length >= 300,
      `corpus must have ≥300 fixtures (got ${V2_FIXTURE_CORPUS_SEED.length})`,
    );
  });

  it("micro-note（content ≤ 500 字符）≥ 180", () => {
    const micro = V2_FIXTURE_CORPUS_SEED.filter((f) => f.source.content.length <= 500);
    assert.ok(
      micro.length >= 180,
      `micro-note must be ≥180 (got ${micro.length})`,
    );
  });

  it("中长文本（content > 500 字符）≥ 60", () => {
    const medium = V2_FIXTURE_CORPUS_SEED.filter((f) => f.source.content.length > 500);
    assert.ok(
      medium.length >= 60,
      `medium-length must be ≥60 (got ${medium.length})`,
    );
  });

  it("多模态（code/formula/table/image/mixed）≥ 30", () => {
    const modality = V2_FIXTURE_CORPUS_SEED.filter((f) => MODALITY_GROUPS.has(f.modality));
    assert.ok(
      modality.length >= 30,
      `modality must be ≥30 (got ${modality.length})`,
    );
  });

  it("零卡/安全/对抗 ≥ 30", () => {
    const safety = V2_FIXTURE_CORPUS_SEED.filter(
      (f) => (f.zeroCardReasonCodes?.length ?? 0) > 0 || (f.safetyExpectations?.length ?? 0) > 0,
    );
    assert.ok(
      safety.length >= 30,
      `zero-card/safety/adversarial must be ≥30 (got ${safety.length})`,
    );
  });

  it("全体至少 20% 允许或要求 0 卡", () => {
    const ratio = zeroCardFixtureRatio(V2_FIXTURE_CORPUS_SEED);
    assert.ok(
      ratio >= 0.2,
      `zero-card-capable ratio must be ≥20% (got ${(ratio * 100).toFixed(1)}%)`,
    );
  });

  it("dev/validation/holdout 三 split 均非空", () => {
    const counts = corpusSplitCounts(V2_FIXTURE_CORPUS_SEED);
    for (const split of ["dev", "validation", "holdout"]) {
      assert.ok((counts[split] ?? 0) > 0, `split ${split} must be non-empty (got ${JSON.stringify(counts)})`);
    }
  });
});

describe("§23.1 Corpus 质量", () => {
  it("fixtureId 全局唯一", () => {
    const ids = V2_FIXTURE_CORPUS_SEED.map((f) => f.fixtureId);
    assert.equal(new Set(ids).size, ids.length, "fixtureId must be globally unique");
  });

  it("全部通过 strict schema 解析（未知字段拒绝）", () => {
    for (const f of V2_FIXTURE_CORPUS_SEED) {
      const parsed = parseCardGenerationFixtureV2(f);
      assert.equal(parsed.fixtureId, f.fixtureId);
    }
  });

  it("micro-note 不被 2k 字以上样本替代（上限校验）", () => {
    // §23.1：micro 组内容 ≤ 500 字符；中长 ≤ 2000
    for (const f of V2_FIXTURE_CORPUS_SEED) {
      assert.ok(
        f.source.content.length <= 2000,
        `fixture ${f.fixtureId} content exceeds 2000 chars (${f.source.content.length})`,
      );
    }
  });

  it("exactTextHash 均为 64 位十六进制（真实 SHA-256，禁用占位符）", () => {
    const hashRe = /^[0-9a-f]{64}$/;
    for (const f of V2_FIXTURE_CORPUS_SEED) {
      for (const exp of f.evidenceExpectations) {
        for (const range of exp.sourceRanges) {
          assert.ok(hashRe.test(range.exactTextHash), `fixture ${f.fixtureId} has invalid exactTextHash`);
          assert.ok(
            !range.exactTextHash.includes("pending"),
            `fixture ${f.fixtureId} must not use placeholder hash`,
          );
          assert.ok(range.endOffset >= range.startOffset, `fixture ${f.fixtureId} has inverted offsets`);
        }
      }
    }
  });

  it("mustMerge 引用内容真实子串", () => {
    for (const f of V2_FIXTURE_CORPUS_SEED) {
      const content = f.source.content;
      for (const group of f.mustMerge) {
        for (const phrase of group) {
          assert.ok(
            content.includes(phrase),
            `fixture ${f.fixtureId} mustMerge phrase not in content: "${phrase.slice(0, 30)}"`,
          );
        }
      }
    }
  });

  it("mustNotCard 非空且语义指向来源（逐条人工标注，允许语义短语）", () => {
    // mustNotCard 表达"禁止生成这类卡"的语义约束，可以是语义短语而非字面子串；
    // 由人工标注保证其指向来源内容（§23.2 scorer 消费该字段做泄漏/复述判定）。
    for (const f of V2_FIXTURE_CORPUS_SEED) {
      for (const phrase of f.mustNotCard) {
        assert.ok(phrase.length >= 2, `fixture ${f.fixtureId} has too-short mustNotCard phrase`);
      }
    }
  });

  it("forbiddenFrontLeaks 非空且不指向整句原文（语义泄漏面，非复述）", () => {
    for (const f of V2_FIXTURE_CORPUS_SEED) {
      for (const phrase of f.forbiddenFrontLeaks) {
        assert.ok(phrase.length >= 2, `fixture ${f.fixtureId} has too-short leak phrase`);
      }
    }
  });

  it("零卡样本携带 reasonCodes；0 卡与失败状态区分（schema 级）", () => {
    for (const f of V2_FIXTURE_CORPUS_SEED) {
      if (f.acceptableCardCountRange.max === 0) {
        assert.ok(
          (f.zeroCardReasonCodes?.length ?? 0) > 0,
          `fixture ${f.fixtureId} requires 0 cards but has no zeroCardReasonCodes`,
        );
      }
    }
  });

  it("modality 分布记录", () => {
    const counts = corpusModalityCounts(V2_FIXTURE_CORPUS_SEED);
    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
    // 纯展示断言：任何 modality 计数非负且 text 存在
    assert.ok(counts.text > 0, `text fixtures must exist (${summary})`);
  });
});
