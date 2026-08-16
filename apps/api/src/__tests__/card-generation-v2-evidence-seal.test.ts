/**
 * 方案 20 R4 — evidence-seal-service 单测。
 *
 * 覆盖：
 * - whole_note：全 block 封证据，offset 全跨
 * - selection：仅 blockRanges 命中，按 offset 切片
 * - selection endOffset 超长 → 抛错
 * - image/code block 不封文本证据
 * - evidenceSnapshotHash 稳定（同输入同 hash）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sealEvidenceSnapshotsV2,
  filterBlocksBySourceScope,
  computeSealedEvidenceSnapshotHashV2,
} from "../modules/card-generation-v2/evidence-seal-service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const NOTE_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_VERSION_ID = "00000000-0000-4000-8000-000000000004";
const BLOCK_A = "00000000-0000-4000-8000-00000000000a";
const BLOCK_B = "00000000-0000-4000-8000-00000000000b";

const BLOCKS = [
  { blockId: BLOCK_A, type: "paragraph", content: "分布式共识是指多个节点对某个值达成一致。", ordinal: 1 },
  { blockId: BLOCK_B, type: "paragraph", content: "共识算法保证故障容忍。", ordinal: 2 },
];

function makeSelectMock(existingSnapshotIds: string[] = []) {
  return () => ({
    from: () => ({
      where: () => ({
        limit: async () => existingSnapshotIds.map((id) => ({ id })),
      }),
    }),
  });
}

function makeTxMock(existingSnapshotIds: string[] = []) {
  const inserts: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    id: "mock-tx",
    select: makeSelectMock(existingSnapshotIds),
    insert: (table: unknown) => ({
      values: (vals: unknown) => {
        inserts.push({ table, vals });
        return { onConflictDoNothing: () => {} };
      },
    }),
  };
  return { tx, inserts };
}

describe("filterBlocksBySourceScope", () => {
  it("whole_note includes all text blocks with full span", () => {
    const spans = filterBlocksBySourceScope(BLOCKS, { kind: "whole_note" });
    assert.equal(spans.length, 2);
    assert.equal(spans[0].startOffset, 0);
    assert.equal(spans[0].endOffset, BLOCKS[0].content.length);
    assert.equal(spans[0].slice, BLOCKS[0].content);
  });

  it("selection filters to matching blockRanges with offset slice", () => {
    const spans = filterBlocksBySourceScope(BLOCKS, {
      kind: "selection",
      blockRanges: [{ blockId: BLOCK_B, startOffset: 3, endOffset: 6 }],
    });
    assert.equal(spans.length, 1);
    assert.equal(spans[0].block.blockId, BLOCK_B);
    assert.equal(spans[0].slice, "法保证");
  });

  it("selection endOffset exceeding block length throws", () => {
    assert.throws(
      () => filterBlocksBySourceScope(BLOCKS, {
        kind: "selection",
        blockRanges: [{ blockId: BLOCK_A, startOffset: 0, endOffset: 9999 }],
      }),
      /exceeds block/,
    );
  });

  it("skips image/code blocks for text evidence", () => {
    const withImage = [
      ...BLOCKS,
      { blockId: "00000000-0000-4000-8000-00000000000c", type: "image", content: "img", ordinal: 3 },
    ] as typeof BLOCKS;
    const spans = filterBlocksBySourceScope(withImage, { kind: "whole_note" });
    assert.equal(spans.length, 2);
  });
});

describe("sealEvidenceSnapshotsV2", () => {
  it("seals one snapshot per scoped text block with usable eligibility", async () => {
    const { tx, inserts } = makeTxMock();
    const result = await sealEvidenceSnapshotsV2(tx, {
      workspaceId: WORKSPACE_ID,
      runId: "00000000-0000-4000-8000-000000000005",
      noteId: NOTE_ID,
      noteVersionId: NOTE_VERSION_ID,
      sourceSnapshotId: SOURCE_SNAPSHOT_ID,
      sourceScope: { kind: "whole_note" },
      blocks: BLOCKS.map((b) => ({ blockId: b.blockId, type: b.type, content: b.content, ordinal: b.ordinal })),
    });

    assert.equal(result.manifest.evidence.length, 2);
    for (const e of result.manifest.evidence) {
      assert.equal(e.evidenceSnapshotHash.length, 64);
      assert.equal(e.sourceSnapshotId, SOURCE_SNAPSHOT_ID);
    }
    // eligibility state row inserted per snapshot（status=usable）
    // 批量实现可能一次插入多行；这里统计所有插入行中 status=usable 的行数。
    const eligRows = inserts.flatMap((i) => {
      const vals = (i as { vals?: unknown }).vals;
      if (Array.isArray(vals)) return vals as Array<{ status?: string }>;
      return vals ? [vals as { status?: string }] : [];
    });
    const eligUsableRows = eligRows.filter((v) => v.status === "usable");
    assert.equal(eligUsableRows.length, 2);
    // manifest 携带每个 snapshot 的 targetUnit 引用所需字段
    const first = result.manifest.evidence[0];
    assert.ok(first.blockId);
    assert.equal(typeof first.startOffset, "number");
    assert.equal(typeof first.endOffset, "number");
  });

  it("selection scope seals only the selected block slice", async () => {
    const { tx } = makeTxMock();
    const result = await sealEvidenceSnapshotsV2(tx, {
      workspaceId: WORKSPACE_ID,
      runId: "00000000-0000-4000-8000-000000000005",
      noteId: NOTE_ID,
      noteVersionId: NOTE_VERSION_ID,
      sourceSnapshotId: SOURCE_SNAPSHOT_ID,
      sourceScope: { kind: "selection", blockRanges: [{ blockId: BLOCK_B, startOffset: 3, endOffset: 6 }] },
      blocks: BLOCKS.map((b) => ({ blockId: b.blockId, type: b.type, content: b.content, ordinal: b.ordinal })),
    });
    assert.equal(result.manifest.evidence.length, 1);
    assert.equal(result.manifest.evidence[0].blockId, BLOCK_B);
    assert.equal(result.manifest.evidence[0].startOffset, 3);
    assert.equal(result.manifest.evidence[0].endOffset, 6);
  });

  it("evidenceSnapshotHash is stable for identical inputs", () => {
    const h1 = computeSealedEvidenceSnapshotHashV2({
      workspaceId: WORKSPACE_ID, sourceSnapshotId: SOURCE_SNAPSHOT_ID, noteId: NOTE_ID,
      blockId: BLOCK_A, startOffset: 0, endOffset: 5,
      protectedQuoteRef: "evidence://ref/1", quoteHash: "a".repeat(64),
      blockContentHash: "b".repeat(64), sourceContentHash: "c".repeat(64),
    });
    const h2 = computeSealedEvidenceSnapshotHashV2({
      workspaceId: WORKSPACE_ID, sourceSnapshotId: SOURCE_SNAPSHOT_ID, noteId: NOTE_ID,
      blockId: BLOCK_A, startOffset: 0, endOffset: 5,
      protectedQuoteRef: "evidence://ref/1", quoteHash: "a".repeat(64),
      blockContentHash: "b".repeat(64), sourceContentHash: "c".repeat(64),
    });
    assert.equal(h1, h2);
    // 不同 block → 不同 hash
    const h3 = computeSealedEvidenceSnapshotHashV2({
      workspaceId: WORKSPACE_ID, sourceSnapshotId: SOURCE_SNAPSHOT_ID, noteId: NOTE_ID,
      blockId: BLOCK_B, startOffset: 0, endOffset: 5,
      protectedQuoteRef: "evidence://ref/1", quoteHash: "a".repeat(64),
      blockContentHash: "b".repeat(64), sourceContentHash: "c".repeat(64),
    });
    assert.notEqual(h1, h3);
  });
});
