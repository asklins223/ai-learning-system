/**
 * 方案 20 R4：Evidence Seal 纯逻辑层（§14.1/§14.3/§10.1 step 1-2）。
 *
 * 2026-08-24（AI 设计审查 §4.4 第二批）：自 apps/api evidence-seal-service.ts
 * 拆出——类型、sourceScope 过滤、hash 计算、seal 计划构建均为纯逻辑，
 * 下沉至 packages/shared 供 worker 与 api 平级消费；DB 写入（snapshots +
 * eligibility 落库）留在 api 的 IO 壳（evidence-seal-service.ts）。
 *
 * 硬约束（§14.3/§14.4）不变：
 * - evidenceSnapshotHash 用 `computeEvidenceSnapshotHashV2`
 *   （域 "evidence-snapshot-v2"）；
 * - 正文封装在不可变 protectedQuoteRef（`evidence://<snapshotId>`）——
 *   正文不内嵌尚不存在的 semantic support report，避免 hash 环；
 * - 全表强制 workspace scope；
 * - seal 在 Author 之前完成，保证 source-only 单向闭包。
 */

import { randomUUID } from "node:crypto";
import {
  computeEvidenceSnapshotHashV2,
} from "../card-generation-v2-hashing.ts";
import { hashCanonicalV2 } from "../hash-canonical-v2.ts";
import type { SourceScopeV2 } from "../card-generation-v2-contracts.ts";
import { DomainError } from "../domain-error.ts";

// ─── 类型 ───────────────────────────────────────────────────────────────

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

/** seal 计划：待写库的 snapshot/eligibility 行 + manifest + 内容 hash。 */
export interface EvidenceSealPlanV2 {
  sourceContent: string;
  sourceContentHash: string;
  snapshotRows: Array<{
    id: string;
    workspaceId: string;
    evidenceSnapshotId: string;
    evidenceSnapshotHash: string;
    sourceSnapshotId: string;
    noteId: string;
    blockId: string;
    startOffset: number;
    endOffset: number;
    protectedQuoteRef: string;
    quoteHash: string;
    blockContentHash: string;
    sourceContentHash: string;
    modality: "text";
    supportDescription: null;
  }>;
  /** 0275：密封时冻结的原文副本，与 snapshotRows 一一对应（同一个 evidenceSnapshotId）。 */
  quoteCopyRows: Array<{
    workspaceId: string;
    evidenceSnapshotId: string;
    quoteText: string;
    quoteHash: string;
  }>;
  eligibilityRows: Array<{
    id: string;
    workspaceId: string;
    eligibilityId: string;
    evidenceSnapshotId: string;
    status: "usable";
    eligibilityEpoch: 1;
    eligibilityVectorHash: string;
    restrictedReason: null;
    restrictedAt: null;
  }>;
  manifestEvidence: SealedEvidenceEntryV2[];
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
          throw new CardGenerationPipelineErrorV2(
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
 * §10.1 step 1-2 的确定性部分：计算 seal 计划（不触 DB）。
 *
 * 幂等语义由 IO 壳的 onConflictDoNothing 保证；本函数只负责
 * 「给定 blocks 与 scope，要写哪些行、hash 各是什么」。
 */
export function planEvidenceSnapshotsV2(input: SealEvidenceInput): EvidenceSealPlanV2 {
  const { workspaceId, noteId, sourceSnapshotId, sourceScope, blocks } = input;

  const sourceContent = blocks.map((b) => b.content).join("\n");
  const sourceContentHash = hashCanonicalV2("card-generation-v2/source-content", {
    blockContents: sourceContent,
  });

  const spans = filterBlocksBySourceScope(blocks, sourceScope);
  const evidence: SealedEvidenceEntryV2[] = [];
  const snapshotRows: EvidenceSealPlanV2["snapshotRows"] = [];
  const eligibilityRows: EvidenceSealPlanV2["eligibilityRows"] = [];
  const quoteCopyRows: EvidenceSealPlanV2["quoteCopyRows"] = [];

  for (const span of spans) {
    const blockContentHash = hashCanonicalV2("block", { content: span.block.content });
    const quote = span.slice;
    const quoteHash = hashCanonicalV2("evidence-quote", { quote });
    const evidenceSnapshotId = randomUUID();
    // ref 里那个 uuid 必须是**库里真的存在的 evidence_snapshot_id**。以前它是另抽的一个
    // 随机号（doc 34 L21 §1：指向一个不存在的对象、也没有解析器），
    // 于是所有"按 ref 取回原文"的设想都只能失败关闭。解析器见 parseProtectedQuoteRefV2。
    const protectedQuoteRef = `evidence://snapshot/${evidenceSnapshotId}`;
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

    snapshotRows.push({
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
    quoteCopyRows.push({
      workspaceId,
      evidenceSnapshotId,
      quoteText: quote,
      quoteHash,
    });

    eligibilityRows.push({
      id: randomUUID(),
      workspaceId,
      eligibilityId: randomUUID(),
      evidenceSnapshotId,
      status: "usable",
      eligibilityEpoch: 1,
      eligibilityVectorHash: stateHash,
      restrictedReason: null,
      restrictedAt: null,
    });

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

  return {
    quoteCopyRows,
    sourceContent,
    sourceContentHash,
    snapshotRows,
    eligibilityRows,
    manifestEvidence: evidence,
  };
}

// ─── 领域错误（API service error 继承本类） ───────────────────────────────

/**
 * V2 卡生成纯逻辑层的领域错误。api 的 `CardGenerationV2ServiceError`
 * 继承本类（helpers.ts）；本类实例的 name 字段同为
 * "CardGenerationV2ServiceError"（按 name 分类日志/监控的行为不变）。
 * 注意：api 的错误边界（routes.ts sendServiceError 等）必须检查**本基类**，
 * 而非子类——shared 纯逻辑直接抛父类实例，instanceof 子类会漏接。
 */
export class CardGenerationPipelineErrorV2 extends DomainError {
  constructor(code: string, statusCode: number, message: string) {
    super({ name: "CardGenerationV2ServiceError", code, message, statusCode });
  }
}


/** `protectedQuoteRef` 的唯一格式（0275 / doc 34 L21 §1）。写侧与读侧都从这里走。 */
export const PROTECTED_QUOTE_REF_PREFIX = "evidence://snapshot/";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 解析 protected ref → `evidence_snapshot_id`；格式不对就返回 null，不猜。
 *
 * 这条函数是 L21 §1 缺的那一半：合同里"经 protected ref 访问"此前没有实现，
 * 而 ref 里装的还是一个凭空抽的随机号（不是任何存在的 id）。
 * 注意：**解得开不等于取不到**——0275 之前的存量行 ref 格式正确却指向不存在的对象，
 * 所以副本一律按 `evidence_snapshot_id` 查，不按 ref 里那个号查。
 */
export function parseProtectedQuoteRefV2(ref: string | null | undefined): string | null {
  if (typeof ref !== "string" || !ref.startsWith(PROTECTED_QUOTE_REF_PREFIX)) return null;
  const rest = ref.slice(PROTECTED_QUOTE_REF_PREFIX.length);
  return UUID_TEXT.test(rest) ? rest : null;
}
