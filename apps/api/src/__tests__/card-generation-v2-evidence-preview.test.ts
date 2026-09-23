/**
 * doc 34 L21 §2 —— 证据预览的落点状态。
 *
 * 这一组用例的**正控制**是第一条：夹具由真的密封计划
 * （`planEvidenceSnapshotsV2`，与写库那一份同一函数）产出，再交给读端的分类函数。
 * 两边算出的哈希必须对上——如果对不上，后面所有"漂移"断言都是在测我自己写错的哈希域。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { planEvidenceSnapshotsV2 } from "@ailearn/shared/card-generation-v2-pipeline";
import {
  classifyEvidencePreviewV2,
  EVIDENCE_PREVIEW_SOURCE_STATES_V2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { loadEvidencePreviewItems } from "../modules/card-generation-v2/evidence-preview.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const NOTE_ID = "00000000-0000-4000-8000-000000000003";
const NOTE_VERSION_ID = "00000000-0000-4000-8000-000000000004";
const BLOCK_A = "00000000-0000-4000-8000-00000000000a";

const ORIGINAL = "分布式共识是指多个节点对某个值达成一致。";

function sealPlan(blocks = [{ blockId: BLOCK_A, type: "paragraph", content: ORIGINAL, ordinal: 1 }]) {
  return planEvidenceSnapshotsV2({
    workspaceId: WORKSPACE_ID,
    runId: "00000000-0000-4000-8000-000000000009",
    noteId: NOTE_ID,
    noteVersionId: NOTE_VERSION_ID,
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    sourceScope: { kind: "whole_note" },
    blocks,
  });
}

function classify(blockContent: string | null, row: {
  blockContentHash: string | null;
  quoteHash: string | null;
  startOffset: number;
  endOffset: number;
}) {
  return classifyEvidencePreviewV2({
    blockContent,
    blockContentHash: row.blockContentHash,
    quoteHash: row.quoteHash,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
  });
}

describe("classifyEvidencePreviewV2", () => {
  it("密封侧写下的行在读侧判为 located，切片与当初封进去的一致", () => {
    const plan = sealPlan();
    assert.ok(plan.snapshotRows.length > 0, "密封计划必须真的产出证据行");
    for (const row of plan.snapshotRows) {
      const result = classify(ORIGINAL, row);
      assert.equal(result.state, "located");
      assert.equal(result.quote, ORIGINAL.slice(row.startOffset, row.endOffset));
    }
  });

  it("块内容被就地改写 → drifted（并且给出的仍是现在的文字）", () => {
    const [row] = sealPlan().snapshotRows;
    const edited = `${ORIGINAL}后来又补了一句。`;
    const result = classify(edited, row);
    assert.equal(result.state, "drifted");
    assert.equal(result.quote, edited.slice(row.startOffset, row.endOffset));
  });

  it("块变短到切片下标越界 → drifted", () => {
    const [row] = sealPlan().snapshotRows;
    assert.equal(classify("共识", row).state, "drifted");
  });

  it("块行已经不在了 → missing，且不给出任何假装是原文的文字", () => {
    const [row] = sealPlan().snapshotRows;
    const result = classify(null, row);
    assert.equal(result.state, "missing");
    assert.equal(result.quote, "");
  });

  it("内容哈希缺失（手写行）也判 drifted，不能因为少一个字段就放行", () => {
    const [row] = sealPlan().snapshotRows;
    assert.equal(
      classifyEvidencePreviewV2({
        blockContent: ORIGINAL,
        blockContentHash: null,
        quoteHash: row.quoteHash,
        startOffset: row.startOffset,
        endOffset: row.endOffset,
      }).state,
      "drifted",
    );
  });

  it("三态词汇表就是合同里那三个，没有第四种", () => {
    assert.deepEqual([...EVIDENCE_PREVIEW_SOURCE_STATES_V2], ["located", "drifted", "missing"]);
  });
});

// ─── 读点：两次 select 的顺序就是实现里的顺序（先 snapshot 再 block） ───
// 链尾同时支持 `.limit()` 与直接 await：实现里第一条查询带 limit、第二条不带，
// 替身如果只认其中一种，测的就是替身的形状而不是实现的形状。

function fakeTx(
  snapshots: Record<string, unknown>[],
  blocks: { id: string; content: string }[],
  copies: { evidenceSnapshotId: string; quoteText: string }[] = [],
) {
  // 三次查询：snapshot -> note_blocks -> 冻结副本（0275）。
  const queues: unknown[][] = [snapshots, blocks, copies];
  const terminal = () => {
    const rows = queues.shift() ?? [];
    return {
      limit: async () => rows,
      then: (
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    select: () => ({ from: () => ({ where: () => terminal() }) }),
  };
  return { tx, queriesLeft: () => queues.length };
}

describe("loadEvidencePreviewItems", () => {
  it("指不到原文的证据不再被静默丢掉，而是带着 missing 状态回到界面上", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx, queriesLeft } = fakeTx([row], []);
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(queriesLeft(), 0, "两次查询都发生了（否则测的是替身自己）");
    assert.equal(items.length, 1, "旧实现会在这里 continue，把这条证据整个吞掉");
    assert.equal(items[0].sourceState, "missing");
    assert.equal(items[0].preview, "");
  });

  it("内容改过的证据标 drifted，并把现在的文字一起给出去", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx([row], [{ id: BLOCK_A, content: `${ORIGINAL}补了一句。` }]);
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].sourceState, "drifted");
    assert.ok(items[0].preview.startsWith(ORIGINAL));
  });

  it("没变过的证据是 located，且不会凭空多出标记", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx([row], [{ id: BLOCK_A, content: ORIGINAL }]);
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.deepEqual(items.map((i) => i.sourceState), ["located"]);
    assert.equal(items[0].preview, ORIGINAL);
  });

  it("refIds 为空时一条查询都不发", async () => {
    const { tx, queriesLeft } = fakeTx([], []);
    assert.deepEqual(await loadEvidencePreviewItems(tx, WORKSPACE_ID, []), []);
    assert.equal(queriesLeft(), 3, "空列表不该消耗任何一次查询");
  });
});


describe("冻结的原文副本（0275 / L21 §1）", () => {
  it("密封计划同时产出副本行，ref 里那个号就是这条证据自己的 id", () => {
    const plan = sealPlan();
    assert.equal(plan.quoteCopyRows.length, plan.snapshotRows.length, "副本行数与证据行数不等");
    for (const [index, row] of plan.snapshotRows.entries()) {
      const copy = plan.quoteCopyRows[index];
      assert.equal(copy.evidenceSnapshotId, row.evidenceSnapshotId);
      assert.equal(copy.quoteHash, row.quoteHash);
      assert.equal(copy.quoteText, ORIGINAL.slice(row.startOffset, row.endOffset));
      assert.equal(
        row.protectedQuoteRef,
        `evidence://snapshot/${row.evidenceSnapshotId}`,
        "ref 又指向一个不存在的对象了（L21 §1 的原症状）",
      );
    }
  });

  it("落点变了且冻过副本 → originalPreview 给出当初那段", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx(
      [row],
      [{ id: BLOCK_A, content: `${ORIGINAL}补了一句。` }],
      [{ evidenceSnapshotId: row.evidenceSnapshotId, quoteText: ORIGINAL }],
    );
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].sourceState, "drifted");
    assert.equal(items[0].originalPreview, ORIGINAL);
    assert.equal(items[0].preview, ORIGINAL.slice(0, items[0].preview.length), "预览给的是现在的切片");
  });

  it("存量证据没有副本 → null，界面据此说「这段没被冻住」而不是「没有原文」", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx([row], [{ id: BLOCK_A, content: `${ORIGINAL}补了一句。` }], []);
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].originalPreview, null);
  });

  it("落点还在时不给副本（那时「当初那段」就是现在这段，标出来只会误导）", async () => {
    const [row] = sealPlan().snapshotRows;
    const { tx } = fakeTx(
      [row],
      [{ id: BLOCK_A, content: ORIGINAL }],
      [{ evidenceSnapshotId: row.evidenceSnapshotId, quoteText: ORIGINAL }],
    );
    const items = await loadEvidencePreviewItems(tx, WORKSPACE_ID, [row.evidenceSnapshotId]);
    assert.equal(items[0].sourceState, "located");
    assert.equal(items[0].originalPreview, null);
  });

  it("ref 解析器只认自己写的那种格式", async () => {
    const { parseProtectedQuoteRefV2 } = await import("@ailearn/shared/card-generation-v2-pipeline");
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(parseProtectedQuoteRefV2(`evidence://snapshot/${id}`), id);
    assert.equal(parseProtectedQuoteRefV2(null), null);
    assert.equal(parseProtectedQuoteRefV2("evidence://snapshot/不是uuid"), null);
    assert.equal(parseProtectedQuoteRefV2(`https://example.com/${id}`), null);
  });
});

describe("证据预览只剩一个读点", () => {
  const files = [
    "../modules/card-generation-v2/reveal-service.ts",
    "../modules/card-generation-v2/card-service.ts",
  ];
  for (const rel of files) {
    it(`${rel.split("/").pop()} 不再自己切 note_blocks 原文`, () => {
      const source = readFileSync(new URL(rel, import.meta.url), "utf8");
      assert.ok(source.length > 500, "读到了文件内容（否则这条断言是空的）");
      assert.match(source, /loadEvidencePreviewItems/, "必须走那个唯一读点");
      assert.doesNotMatch(source, /noteBlocks/, "不许再直接读块正文");
    });
  }
});
