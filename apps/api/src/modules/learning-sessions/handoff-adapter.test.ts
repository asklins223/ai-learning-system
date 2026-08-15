/**
 * 任务 02-6：Generation → Learning handoff adapter 单元测试。
 *
 * 覆盖（验收，02-w1 任务 02-6）：
 * - required 缺失 fail closed；
 * - forbidden 字段负向（00-3 §6.3）；
 * - contract hash 稳定（00-3 §6.5 Gate 第一项）；
 * - stale 判定：active Card Set 替换 → fingerprint 变化 → 未提交 Episode stale；
 * - 集成 Gate 三检查（hash / 替换-stale / forbidden 负向）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublishedLearningAssetContractV1 } from "@ailearn/shared";
import {
  PublishedLearningAssetContractError,
  publishedLearningAssetContractSchema,
  stableStringifyPublishedAsset,
  validateForbiddenFields,
  parsePublishedLearningAsset,
  hashPublishedLearningAsset,
  FORBIDDEN_PUBLISHED_ASSET_FIELDS,
} from "@ailearn/shared/published-learning-asset-contract";
import {
  buildPublishedLearningAsset,
  computePublishedSourceFingerprint,
  HandoffAdapterError,
  isEpisodeTargetStale,
  runHandoffIntegrationGate,
  type BuildPublishedLearningAssetOptions,
  type PublishedCardInput,
  type PublishedEvidenceInput,
  type PublishedKeyPointInput,
  type SemanticSupportReportRef,
} from "./handoff-adapter.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function cardRow(overrides: Partial<PublishedCardInput> = {}): PublishedCardInput {
  return { id: "card-1", cardSetId: "set-1", ...overrides };
}

function keyPointRow(overrides: Partial<PublishedKeyPointInput> = {}): PublishedKeyPointInput {
  return { id: "kp-1", claim: "The Earth orbits the Sun", ...overrides };
}

function evidenceRows(overrides: Partial<PublishedEvidenceInput> = {}): PublishedEvidenceInput[] {
  return [
    {
      id: "ev-1",
      keyPointId: "kp-1",
      quoteText: "The Earth orbits the Sun in 365 days",
      sourceHash: "sha-1",
      ...overrides,
    },
    {
      id: "ev-2",
      keyPointId: "kp-1",
      quoteText: "One revolution takes one year",
      sourceHash: "sha-2",
      ...overrides,
    },
  ];
}

function semanticSupport(): SemanticSupportReportRef {
  return { id: "report-1", hash: "report-hash-1" };
}

function options(
  overrides: Partial<BuildPublishedLearningAssetOptions> = {},
): BuildPublishedLearningAssetOptions {
  return {
    cardSet: { id: "set-1", status: "active", generationEpoch: 2 },
    ...overrides,
  };
}

function buildActiveAsset(): PublishedLearningAssetContractV1 {
  return buildPublishedLearningAsset(
    cardRow(),
    keyPointRow(),
    evidenceRows(),
    semanticSupport(),
    options(),
  );
}

// ─── required 缺失 fail closed ────────────────────────────────────────────

describe("buildPublishedLearningAsset: required 缺失 fail closed", () => {
  it("claim 为空时抛错", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow(),
          keyPointRow({ claim: "   " }),
          evidenceRows(),
          semanticSupport(),
          options(),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "missing_claim",
    );
  });

  it("exactEvidenceRefs 为空数组时抛错", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow(),
          keyPointRow(),
          [],
          semanticSupport(),
          options(),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "missing_evidence",
    );
  });

  it("semantic support report 缺 hash 时抛错", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow(),
          keyPointRow(),
          evidenceRows(),
          { id: "report-1", hash: "" },
          options(),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "missing_semantic_support",
    );
  });

  it("cardRevision 权威来源缺失（generation_epoch 未提供）时抛错", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow(),
          keyPointRow(),
          evidenceRows(),
          semanticSupport(),
          options({ cardSet: { id: "set-1", status: "active", generationEpoch: null } }),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "missing_card_revision",
    );
  });

  it("Card Set 未 Publish（draft）时抛错（未 Publish 产物 forbidden）", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow(),
          keyPointRow(),
          evidenceRows(),
          semanticSupport(),
          options({ cardSet: { id: "set-1", status: "draft", generationEpoch: 1 } }),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "not_published",
    );
  });

  it("Card Set 未 Publish（partial_ready）时抛错（未 Publish 产物 forbidden）", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow(),
          keyPointRow(),
          evidenceRows(),
          semanticSupport(),
          options({ cardSet: { id: "set-1", status: "partial_ready", generationEpoch: 1 } }),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "not_published",
    );
  });

  it("未知生命周期状态 fail closed（INVALID_CARD_SET_STATUS，不静默放行）", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow(),
          keyPointRow(),
          evidenceRows(),
          semanticSupport(),
          options({
            cardSet: {
              id: "set-1",
              status: "weird-typo" as unknown as "active",
              generationEpoch: 1,
            },
          }),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "invalid_card_set_status",
    );
  });

  it("Card 不属于给定 Card Set 时抛错", () => {
    assert.throws(
      () =>
        buildPublishedLearningAsset(
          cardRow({ cardSetId: "set-other" }),
          keyPointRow(),
          evidenceRows(),
          semanticSupport(),
          options(),
        ),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "card_set_mismatch",
    );
  });
});

// ─── lifecycle / optional hint 映射 ───────────────────────────────────────

describe("buildPublishedLearningAsset: lifecycle 与 optional hint 映射", () => {
  it("active Card Set → lifecycle=active，cardRevision 来自 generation_epoch", () => {
    const asset = buildActiveAsset();
    assert.equal(asset.contractVersion, "published-learning-asset-v1");
    assert.equal(asset.cardId, "card-1");
    assert.equal(asset.cardRevision, 2);
    assert.equal(asset.keyPointId, "kp-1");
    assert.equal(asset.claim, "The Earth orbits the Sun");
    assert.deepEqual(asset.exactEvidenceRefs, ["ev-1", "ev-2"]);
    assert.equal(asset.semanticSupportReportId, "report-1");
    assert.equal(asset.semanticSupportReportHash, "report-hash-1");
    assert.ok(asset.sourceFingerprint.length > 0);
    assert.equal(asset.lifecycle, "active");
  });

  it("superseded/archived Card Set → lifecycle=superseded", () => {
    const superseded = buildPublishedLearningAsset(
      cardRow(),
      keyPointRow(),
      evidenceRows(),
      semanticSupport(),
      options({ cardSet: { id: "set-1", status: "superseded", generationEpoch: 1 } }),
    );
    assert.equal(superseded.lifecycle, "superseded");
    const archived = buildPublishedLearningAsset(
      cardRow(),
      keyPointRow(),
      evidenceRows(),
      semanticSupport(),
      options({ cardSet: { id: "set-1", status: "archived", generationEpoch: 1 } }),
    );
    assert.equal(archived.lifecycle, "superseded");
  });

  it("optional hints 透传，缺失时输出无该字段", () => {
    const withHints = buildPublishedLearningAsset(
      cardRow(),
      keyPointRow(),
      evidenceRows(),
      semanticSupport(),
      options({
        hints: { cognitiveType: "fact", interactionAffordances: ["explain", "example"] },
      }),
    );
    assert.equal(withHints.cognitiveType, "fact");
    assert.deepEqual(withHints.interactionAffordances, ["explain", "example"]);

    const withoutHints = buildActiveAsset();
    assert.equal("cognitiveType" in withoutHints, false);
    assert.equal("interactionAffordances" in withoutHints, false);
  });

  it("输出契约可被 strict schema 反解", () => {
    const asset = buildActiveAsset();
    const reparsed = publishedLearningAssetContractSchema.parse(asset);
    assert.deepEqual(reparsed, asset);
  });
});

// ─── forbidden 字段负向（00-3 §6.3）───────────────────────────────────────

describe("forbidden 字段负向校验", () => {
  it("validateForbiddenFields 拒绝 Candidate Ledger / relation hints / private draft / publishStatus", () => {
    assert.deepEqual(
      validateForbiddenFields({
        candidateLedger: { entries: [] },
        relationHints: [{ type: "prerequisite" }],
        privateDraft: "draft-1",
        publishStatus: "published",
      }),
      ["candidateLedger", "relationHints", "privateDraft", "publishStatus"],
    );
  });

  it("parsePublishedLearningAsset 对含 forbidden 字段的对象抛 FORBIDDEN_FIELDS_PRESENT", () => {
    assert.throws(
      () =>
        parsePublishedLearningAsset({
          ...buildActiveAsset(),
          relationHints: [{ type: "prerequisite", localTargetId: "kp-2" }],
        }),
      (err: unknown) =>
        err instanceof PublishedLearningAssetContractError &&
        err.code === "forbidden_fields_present",
    );
  });

  it("strict schema 拒绝任何 unknown 字段", () => {
    assert.throws(
      () => publishedLearningAssetContractSchema.parse({ ...buildActiveAsset(), extra: 1 }),
      (err: unknown) => err instanceof Error && /Unrecognized key|unrecognized_keys/.test(err.message),
    );
  });

  it("FORBIDDEN_PUBLISHED_ASSET_FIELDS 覆盖契约要求的四类字段", () => {
    for (const f of [
      "candidateLedger",
      "relationHints",
      "privateDraft",
      "publishStatus",
    ]) {
      assert.ok(FORBIDDEN_PUBLISHED_ASSET_FIELDS.includes(f as never), `缺少 ${f}`);
    }
  });
});

// ─── contract hash（集成 Gate 第一项）─────────────────────────────────────

describe("contract hash 稳定性", () => {
  it("同一契约两次 hash 相同", () => {
    const asset = buildActiveAsset();
    assert.equal(
      hashPublishedLearningAsset(asset),
      hashPublishedLearningAsset(asset),
    );
  });

  it("stableStringify 与键序无关", () => {
    const a = { x: 1, y: [1, 2], nested: { b: true, a: "v" } };
    const b = { y: [1, 2], nested: { a: "v", b: true }, x: 1 };
    assert.equal(stableStringifyPublishedAsset(a), stableStringifyPublishedAsset(b));
  });

  it("可选字段缺失与显式 undefined hash 一致（规范化）", () => {
    const base = buildActiveAsset();
    const asUndefined: PublishedLearningAssetContractV1 = { ...base, cognitiveType: undefined };
    assert.equal(
      hashPublishedLearningAsset(asUndefined),
      hashPublishedLearningAsset(base),
    );
  });

  it("内容变化（claim/evidence）必然改变 hash", () => {
    const asset = buildActiveAsset();
    const otherClaim = buildPublishedLearningAsset(
      cardRow(),
      keyPointRow({ claim: "The Earth rotates around its axis" }),
      evidenceRows(),
      semanticSupport(),
      options(),
    );
    assert.notEqual(
      hashPublishedLearningAsset(asset),
      hashPublishedLearningAsset(otherClaim),
    );
  });
});

// ─── stale 判定（00-3 §6.4）───────────────────────────────────────────────

describe("isEpisodeTargetStale: active Card Set 替换 → 未提交 Episode stale", () => {
  it("相同 active asset → 不 stale", () => {
    const asset = buildActiveAsset();
    assert.equal(isEpisodeTargetStale(asset, asset), false);
  });

  it("active Card Set 替换（cardRevision 增加、fingerprint 变化）→ stale", () => {
    const previous = buildActiveAsset(); // revision=2
    const replaced = buildPublishedLearningAsset(
      cardRow({ cardSetId: "set-2" }),
      keyPointRow(),
      evidenceRows(),
      semanticSupport(),
      options({ cardSet: { id: "set-2", status: "active", generationEpoch: 3 } }),
    );
    assert.equal(replaced.cardRevision, 3);
    assert.notEqual(replaced.sourceFingerprint, previous.sourceFingerprint);
    assert.equal(isEpisodeTargetStale(previous, replaced), true);
  });

  it("sourceFingerprint 变化（同一 revision 内容更新）→ stale", () => {
    const previous = buildActiveAsset();
    const contentChanged = buildPublishedLearningAsset(
      cardRow(),
      keyPointRow({ claim: "The Earth orbits the Sun once per year" }),
      evidenceRows(),
      semanticSupport(),
      options(),
    );
    assert.equal(contentChanged.cardRevision, previous.cardRevision);
    assert.notEqual(contentChanged.sourceFingerprint, previous.sourceFingerprint);
    assert.equal(isEpisodeTargetStale(previous, contentChanged), true);
  });
});

// ─── 集成 Gate（00-3 §6.5）────────────────────────────────────────────────

describe("runHandoffIntegrationGate（Generation → Learning）", () => {
  it("替换场景下三检查全部通过", () => {
    const previous = buildActiveAsset(); // revision=2（被替换的旧版本引用）
    const active = buildPublishedLearningAsset(
      cardRow({ cardSetId: "set-2" }),
      keyPointRow(),
      evidenceRows(),
      semanticSupport(),
      options({ cardSet: { id: "set-2", status: "active", generationEpoch: 3 } }),
    );
    const result = runHandoffIntegrationGate({
      previousAsset: previous,
      activeAsset: active,
      forbiddenProbe: { candidateLedger: { entries: [] } },
    });
    assert.equal(result.passed, true);
    const names = result.checks.map((c) => c.name);
    assert.deepEqual(names, [
      "contract-hash-stable",
      "replace-or-fingerprint-change-makes-episode-stale",
      "forbidden-field-negative",
    ]);
    for (const check of result.checks) assert.equal(check.passed, true);
  });

  it("forbidden probe 不含 forbidden 字段时 Gate 抛错（fail closed）", () => {
    const asset = buildActiveAsset();
    assert.throws(
      () =>
        runHandoffIntegrationGate({
          previousAsset: asset,
          activeAsset: asset,
          forbiddenProbe: { harmless: true },
        }),
      (err: unknown) =>
        err instanceof HandoffAdapterError && err.code === "handoff_gate_failed",
    );
  });
});

// ─── sourceFingerprint 确定性 ─────────────────────────────────────────────

describe("computePublishedSourceFingerprint", () => {
  it("含特殊字符（. 与 -）的 evidence id 排序幂等可复现（代码单元比较）", () => {
    // a-1 与 a.1 在 ICU collation 下归类相等（标点可忽略），但代码单元不同；
    // 若改用 localeCompare 排序会不稳定，此用例锁定 compareIds 回归。
    const ev = [
      { id: "a.1", keyPointId: "kp-1", quoteText: "two", sourceHash: "s2" },
      { id: "a-1", keyPointId: "kp-1", quoteText: "one", sourceHash: "s1" },
    ];
    const build = (rows: typeof ev) =>
      buildPublishedLearningAsset(
        cardRow(),
        keyPointRow(),
        rows,
        semanticSupport(),
        options(),
      );
    const forward = build(ev);
    const reversed = build([...ev].reverse());
    assert.deepEqual(forward.exactEvidenceRefs, ["a-1", "a.1"]);
    assert.equal(forward.sourceFingerprint, reversed.sourceFingerprint);
  });

  it("证据顺序无关（幂等）", () => {
    const a = computePublishedSourceFingerprint({
      cardId: "card-1",
      cardRevision: 2,
      keyPointId: "kp-1",
      claim: "The Earth orbits the Sun",
      evidence: evidenceRows().map((e) => ({ id: e.id, quoteText: e.quoteText, sourceHash: e.sourceHash })),
      semanticSupportReportId: "report-1",
    });
    const reversed = computePublishedSourceFingerprint({
      cardId: "card-1",
      cardRevision: 2,
      keyPointId: "kp-1",
      claim: "The Earth orbits the Sun",
      evidence: evidenceRows()
        .reverse()
        .map((e) => ({ id: e.id, quoteText: e.quoteText, sourceHash: e.sourceHash })),
      semanticSupportReportId: "report-1",
    });
    assert.equal(a, reversed);
  });

  it("revision 变化 → fingerprint 变化", () => {
    const base = {
      cardId: "card-1",
      keyPointId: "kp-1",
      claim: "The Earth orbits the Sun",
      evidence: evidenceRows().map((e) => ({ id: e.id, quoteText: e.quoteText, sourceHash: e.sourceHash })),
      semanticSupportReportId: "report-1",
    };
    assert.notEqual(
      computePublishedSourceFingerprint({ ...base, cardRevision: 2 }),
      computePublishedSourceFingerprint({ ...base, cardRevision: 3 }),
    );
  });
});
