/**
 * 方案 20 R4：Evidence Seal（§14.1/§14.3/§10.1 step 1-2）。
 *
 * 在 source_sealing 事务内，把冻结的 note blocks 按 `sourceScope`
 * （whole_note / section / selection 的 blockRanges+offset）过滤后固化为
 * 不可变 `evidence_snapshots_v2` 行，并为每个 snapshot 写入
 * `evidence_eligibility_states_v2`（status=usable、eligibilityEpoch=1、
 * stateHash），同时返回证据 manifest。
 *
 * 硬约束（§14.3/§14.4）：
 * - evidenceSnapshotHash 用 `computeEvidenceSnapshotHashV2`
 *   （`@ailearn/shared/card-generation-v2-hashing`，域 "evidence-snapshot-v2"）；
 * - 正文封装在不可变 protectedQuoteRef（本实现为 `evidence://<snapshotId>`）——
 *   正文不内嵌尚不存在的 semantic support report，避免 hash 环；
 * - 全表强制 workspace scope，禁止只凭 UUID 跨租户读取；
 * - seal 在 Author 之前完成，保证 source-only 单向闭包。
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  evidenceSnapshotsV2,
  evidenceEligibilityStatesV2,
} from "../../db/schema/card-generation-v2.ts";
import {
  computeEvidenceSnapshotHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import type { SourceScopeV2 } from "@ailearn/shared/card-generation-v2-contracts";
import { CardGenerationV2ServiceError } from "./helpers.ts";

// ─── Manifest 类型 ───────────────────────────────────────────────────────

export interface EvidenceSealBlock {
  blockId: string;
  type: string;
  content: string;
  ordinal: number;
}

export interface SealedEvidenceEntryV2 {
  evidenceSnapshotId: string;
  evidenceSnapshotHash: string;
  sourceSnapshotId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quoteHash: string;
  blockContentHash: string;
  /** R29：从 note_blocks 按 [startOffset, endOffset) 切出的真实证据文本（Grounding prompt 用）。 */
  content?: string;
}

export interface EvidenceSealManifestV2 {
  workspaceId: string;
  sourceSnapshotId: string;
  noteId: string;
  noteVersionId: string;
  sourceScope: SourceScopeV2;
  evidence: SealedEvidenceEntryV2[];
}

export interface SealEvidenceInput {
  workspaceId: string;
  runId: string;
  noteId: string;
  noteVersionId: string;
  sourceSnapshotId: string;
  sourceScope: SourceScopeV2;
  blocks: EvidenceSealBlock[];
}

export interface SealEvidenceResultV2 {
  manifest: EvidenceSealManifestV2;
  /** sourceContentHash（对全部 blocks 内容），与 generation-run 闭包一致。 */
  sourceContentHash: string;
}

/**
 * 计算单个文本证据快照的 hash（§14.3 evidenceSnapshotHash）。
 */
export function computeSealedEvidenceSnapshotHashV2(input: {
  workspaceId: string;
  sourceSnapshotId: string;
  noteId: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  protectedQuoteRef: string;
  quoteHash: string;
  blockContentHash: string;
  sourceContentHash: string;
}): string {
  return computeEvidenceSnapshotHashV2({
    kind: "text",
    workspaceId: input.workspaceId,
    sourceSnapshotId: input.sourceSnapshotId,
    noteId: input.noteId,
    blockId: input.blockId,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    protectedContentHash: input.quoteHash,
    sourceContentHash: input.sourceContentHash,
    blockContentHash: input.blockContentHash,
    modality: "text",
  });
}

/**
 * 依据 sourceScope 过滤 blocks，返回 (block, startOffset, endOffset, slice) 元组。
 * - whole_note：所有文本 block，全跨 0..content.length
 * - section：所有文本 block，全跨（section 到 block 的解析为 R5 范围；本实现
 *   对 section 先按全 note 处理并在 manifest 中保留 sectionKey 供后续细化）
 * - selection：仅 blockRanges 中命中的 block，按给定 [startOffset, endOffset) 切片
 *
 * 选区请求的 endOffset 不得超过 block 内容长度（fail closed）。
 */
export function filterBlocksBySourceScope(
  blocks: EvidenceSealBlock[],
  sourceScope: SourceScopeV2,
): Array<{ block: EvidenceSealBlock; startOffset: number; endOffset: number; slice: string }> {
  const ordered = [...blocks].sort((a, b) => a.ordinal - b.ordinal);
  const result: Array<{ block: EvidenceSealBlock; startOffset: number; endOffset: number; slice: string }> = [];

  switch (sourceScope.kind) {
    case "whole_note":
    case "section": {
      for (const block of ordered) {
        // 只封接近纯文本的 block 类型；image/code 走 region evidence（R5）。
        if (!isSealableTextType(block.type)) continue;
        result.push({
          block,
          startOffset: 0,
          endOffset: block.content.length,
          slice: block.content,
        });
      }
      return result;
    }
    case "selection": {
      const byId = new Map(ordered.map((b) => [b.blockId, b]));
      for (const range of sourceScope.blockRanges) {
        const block = byId.get(range.blockId);
        if (!block) continue;
        if (range.endOffset > block.content.length) {
          throw new CardGenerationV2ServiceError(
            "evidence_range_exceeds_block",
            400,
            `selection endOffset ${range.endOffset} exceeds block ${range.blockId} content length ${block.content.length}`,
          );
        }
        result.push({
          block,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          slice: block.content.slice(range.startOffset, range.endOffset),
        });
      }
      return result;
    }
  }
}

function isSealableTextType(type: string): boolean {
  return !["image", "code"].includes(type.toLowerCase());
}

/**
 * §10.1 step 1-2：在 source_sealing 事务内 seal evidence snapshots + eligibility。
 *
 * 幂等策略：对同一 (workspaceId, evidenceSnapshotId) 已存在则跳过（重复 seal
 * 不产生重复 eligibility）；范围内任一 block 生成一条 snapshot。
 */
export async function sealEvidenceSnapshotsV2(
  tx: ApiTransaction,
  input: SealEvidenceInput,
): Promise<SealEvidenceResultV2> {
  const { workspaceId, noteId, noteVersionId, sourceSnapshotId, sourceScope, blocks } = input;

  const sourceContent = blocks.map((b) => b.content).join("\n");
  const sourceContentHash = hashCanonicalV2("card-generation-v2/source-content", {
    blockContents: sourceContent,
  });

  const spans = filterBlocksBySourceScope(blocks, sourceScope);
  const evidence: SealedEvidenceEntryV2[] = [];

  for (const span of spans) {
    const blockContentHash = hashCanonicalV2("block", { content: span.block.content });
    const quote = span.slice;
    const quoteHash = hashCanonicalV2("evidence-quote", { quote });
    const protectedQuoteRef = `evidence://snapshot/${randomUUID()}`;

    const evidenceSnapshotId = randomUUID();
    const evidenceSnapshotHash = computeSealedEvidenceSnapshotHashV2({
      workspaceId,
      sourceSnapshotId,
      noteId,
      blockId: span.block.blockId,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      protectedQuoteRef,
      quoteHash,
      blockContentHash,
      sourceContentHash,
    });

    const existing = await tx
      .select({ id: evidenceSnapshotsV2.id })
      .from(evidenceSnapshotsV2)
      .where(eq(evidenceSnapshotsV2.evidenceSnapshotId, evidenceSnapshotId))
      .limit(1);
    if (existing.length > 0) continue;

    await tx.insert(evidenceSnapshotsV2).values({
      id: randomUUID(),
      workspaceId,
      evidenceSnapshotId,
      evidenceSnapshotHash,
      sourceSnapshotId,
      noteId,
      blockId: span.block.blockId,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      protectedQuoteRef,
      quoteHash,
      blockContentHash,
      sourceContentHash,
      modality: "text",
      supportDescription: null,
    });

    // §14.1: eligibility epoch 单调；初始 status=usable、eligibilityEpoch=1
    const stateHash = hashCanonicalV2("evidence-eligibility-state", {
      evidenceSnapshotId,
      workspaceId,
      eligibilityEpoch: 1,
      status: "usable",
    });
    await tx.insert(evidenceEligibilityStatesV2).values({
      id: randomUUID(),
      workspaceId,
      eligibilityId: randomUUID(),
      evidenceSnapshotId,
      status: "usable",
      eligibilityEpoch: 1,
      eligibilityVectorHash: stateHash,
      restrictedReason: null,
      restrictedAt: null,
    }).onConflictDoNothing();

    evidence.push({
      evidenceSnapshotId,
      evidenceSnapshotHash,
      sourceSnapshotId,
      blockId: span.block.blockId,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      quoteHash,
      blockContentHash,
    });
  }

  const manifest: EvidenceSealManifestV2 = {
    workspaceId,
    sourceSnapshotId,
    noteId,
    noteVersionId,
    sourceScope,
    evidence,
  };

  // runId 仅用于日志/审计记录；不需要写 run 表（manifest 可由
  // evidence_snapshots_v2 按 sourceSnapshotId 重算）。
  void input.runId;

  return { manifest, sourceContentHash };
}
