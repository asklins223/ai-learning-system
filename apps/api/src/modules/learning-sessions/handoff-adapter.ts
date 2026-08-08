/**
 * Generation → Learning handoff adapter（任务 02-6，§0.3）
 *
 * 消费边界（00-3 §3.1/§6.1）：只读已确定性 Publish 的 canonical Card/Key Point/
 * Evidence 的 required 字段；不读取 generation draft、Candidate Ledger、relation
 * hints、private draft 或未 Publish 产物（00-3 §6.3）。本模块是纯转换器，不写
 * 任何学习事实（learning_episodes / 复习 / 理解事件一律不在此写入）。
 *
 * 权威字段确认（Generation 侧实际字段名）：
 * - learning_card_sets.status（draft|active|partial_ready|superseded|archived）
 *   是 active/superseded 生命周期的权威来源；每 note 至多一个 active set
 *   （learning_card_sets_active_note_unique_idx 约束）。
 * - Generation 侧没有显式 card_revision 列；cardRevision 的权威版本代数字段是
 *   card_generation_runs.generation_epoch（note 级递增整数、同 note 唯一），
 *   链路：learning_cards.card_set_id → learning_card_sets.generation_run_id →
 *   card_generation_runs.generation_epoch。本 adapter 不查库，由调用方解析该
 *   epoch 后以 cardSet.generationEpoch 传入；缺省即 required 缺失 → fail closed。
 * - semantic support report 在 Generation 侧没有专门落库字段，由调用方以
 *   SemanticSupportReportRef 传入（未来 semantic support 管线产物或已验证安全
 *   Scene 的 report ref）。
 * - sourceFingerprint：Generation 侧 learning_cards 无该列，用 deterministic
 *   hash of card + keyPoint + evidence content 计算（00-3 §6.1）。
 */

import { createHash } from "node:crypto";
import {
  parsePublishedLearningAsset,
  validateForbiddenFields,
  hashPublishedLearningAsset,
  type PublishedLearningAssetContractV1,
} from "@ailearn/shared";

// ─── 输入类型（真实 published row 的最小只读视图）────────────────────────

export type PublishedCardSetStatus =
  | "draft"
  | "active"
  | "partial_ready"
  | "superseded"
  | "archived";

/** learning_card_sets 行的只读权威视图（lifecycle + revision 来源） */
export interface PublishedCardSetInput {
  id: string;
  /** Card Set 生命周期权威状态（learning_card_sets.status） */
  status: PublishedCardSetStatus;
  /**
   * cardRevision 权威来源：card_generation_runs.generation_epoch。
   * 未关联 run 或缺失时为 null → required 缺失 fail closed。
   */
  generationEpoch: number | null;
}

/** learning_cards 行的只读 canonical 字段 */
export interface PublishedCardInput {
  id: string;
  cardSetId: string | null;
}

/** card_key_points 行的只读 canonical 字段 */
export interface PublishedKeyPointInput {
  id: string;
  claim: string;
}

/** evidences 行的只读 canonical 字段（仅用于 exactEvidenceRefs 与 fingerprint） */
export interface PublishedEvidenceInput {
  id: string;
  keyPointId: string;
  quoteText: string;
  sourceHash: string | null;
}

/** semantic support report 引用（required） */
export interface SemanticSupportReportRef {
  id: string;
  hash: string;
}

/** optional hint 字段（00-3 §6.2：只作提示，缺失进入安全 Scene fallback） */
export interface PublishedAssetHints {
  cognitiveType?: string;
  interactionAffordances?: string[];
}

export interface BuildPublishedLearningAssetOptions {
  cardSet: PublishedCardSetInput;
  hints?: PublishedAssetHints;
}

// ─── 转换器：真实 published row → PublishedLearningAssetContractV1 ─────────

/**
 * 构建 PublishedLearningAssetContractV1。
 *
 * required 缺失一律 fail closed（抛 HandoffAdapterError）：
 * - Card Set 未 Publish（draft/partial_ready）→ 未 Publish 产物 forbidden；
 * - cardRevision 权威来源（generation_epoch）缺失；
 * - claim 空、exact evidence 为空数组、semantic support 缺失。
 *
 * lifecycle 映射：cardSet.status active → "active"；superseded/archived →
 * "superseded"。不读取 Candidate Ledger / relation hints / private draft。
 */
export function buildPublishedLearningAsset(
  cardRow: PublishedCardInput,
  keyPointRow: PublishedKeyPointInput,
  evidenceRows: PublishedEvidenceInput[],
  semanticSupportReport: SemanticSupportReportRef,
  options: BuildPublishedLearningAssetOptions,
): PublishedLearningAssetContractV1 {
  // 未 Publish 产物 forbidden（00-3 §6.3）
  if (
    options.cardSet.status === "draft" ||
    options.cardSet.status === "partial_ready"
  ) {
    throw new HandoffAdapterError(
      `Card Set ${options.cardSet.id} 未发布（status=${options.cardSet.status}），未 Publish 产物 forbidden（00-3 §6.3）`,
      "NOT_PUBLISHED",
    );
  }
  if (cardRow.cardSetId !== options.cardSet.id) {
    throw new HandoffAdapterError(
      `Card ${cardRow.id} 不属于 Card Set ${options.cardSet.id}`,
      "CARD_SET_MISMATCH",
    );
  }
  // cardRevision 权威字段（generation_epoch）缺失 → fail closed
  if (
    typeof options.cardSet.generationEpoch !== "number" ||
    options.cardSet.generationEpoch < 1
  ) {
    throw new HandoffAdapterError(
      "cardRevision 权威来源缺失（card_generation_runs.generation_epoch 未提供或非法）",
      "MISSING_CARD_REVISION",
    );
  }
  if (typeof keyPointRow.claim !== "string" || keyPointRow.claim.trim() === "") {
    throw new HandoffAdapterError("claim 缺失（required 字段 fail closed）", "MISSING_CLAIM");
  }
  if (evidenceRows.length === 0) {
    throw new HandoffAdapterError(
      "exactEvidenceRefs 为空（required 字段 fail closed）",
      "MISSING_EVIDENCE",
    );
  }
  if (!semanticSupportReport.id.trim() || !semanticSupportReport.hash.trim()) {
    throw new HandoffAdapterError(
      "semantic support report 缺失（required 字段 fail closed）",
      "MISSING_SEMANTIC_SUPPORT",
    );
  }

  // 确定性顺序（按 evidence id 做代码单元比较排序），保证 exactEvidenceRefs 与 fingerprint 幂等
  const exactEvidenceRefs = [...evidenceRows]
    .map((e) => e.id)
    .sort(compareIds);
  // lifecycle 权威映射：只枚举已 Publish 状态，未知状态 fail closed（不静默放行）
  const lifecycle =
    options.cardSet.status === "active"
      ? ("active" as const)
      : options.cardSet.status === "superseded" || options.cardSet.status === "archived"
        ? ("superseded" as const)
        : (() => {
            throw new HandoffAdapterError(
              `Card Set ${options.cardSet.id} 生命周期状态非法（status=${options.cardSet.status}）`,
              "INVALID_CARD_SET_STATUS",
            );
          })();
  const sourceFingerprint = computePublishedSourceFingerprint({
    cardId: cardRow.id,
    cardRevision: options.cardSet.generationEpoch,
    keyPointId: keyPointRow.id,
    claim: keyPointRow.claim,
    evidence: evidenceRows.map((e) => ({
      id: e.id,
      quoteText: e.quoteText,
      sourceHash: e.sourceHash,
    })),
    semanticSupportReportId: semanticSupportReport.id,
  });

  const asset: PublishedLearningAssetContractV1 = {
    contractVersion: "published-learning-asset-v1",
    cardId: cardRow.id,
    cardRevision: options.cardSet.generationEpoch,
    keyPointId: keyPointRow.id,
    claim: keyPointRow.claim,
    exactEvidenceRefs,
    semanticSupportReportId: semanticSupportReport.id,
    semanticSupportReportHash: semanticSupportReport.hash,
    sourceFingerprint,
    lifecycle,
  };
  // optional hint（00-3 §6.2）：缺失不阻断，由调用方决定是否注入
  if (options.hints?.cognitiveType !== undefined) {
    asset.cognitiveType = options.hints.cognitiveType;
  }
  if (options.hints?.interactionAffordances !== undefined) {
    asset.interactionAffordances = options.hints.interactionAffordances;
  }

  // 输出契约强制校验（required + forbidden 负向），失败即 fail closed
  return parsePublishedLearningAsset(asset);
}

// ─── source fingerprint（deterministic hash of card+keyPoint+evidence）─────

function normalizeForFingerprint(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** 代码单元比较：避免 localeCompare 的 ICU 归类把不同 id 判为相等，保证排序幂等可复现 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 计算 sourceFingerprint（00-3 §6.1）：deterministic hash of
 * card + keyPoint + evidence content。证据按 id 排序保证幂等；
 * claim/quote 做 trim + 空白折叠规范化。不含任何 forbidden 数据。
 */
export function computePublishedSourceFingerprint(input: {
  cardId: string;
  cardRevision: number;
  keyPointId: string;
  claim: string;
  evidence: Array<{ id: string; quoteText: string; sourceHash: string | null }>;
  semanticSupportReportId: string;
}): string {
  const sortedEvidence = [...input.evidence]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((e) => [
      e.id,
      sha256Hex(normalizeForFingerprint(e.quoteText)),
      e.sourceHash ?? "null",
    ].join("|"))
    .join("\n");
  const parts = [
    `card:${input.cardId}`,
    `revision:${input.cardRevision}`,
    `kp:${input.keyPointId}`,
    `claim:${sha256Hex(normalizeForFingerprint(input.claim))}`,
    `evidence:\n${sortedEvidence}`,
    `semanticSupportReport:${input.semanticSupportReportId}`,
  ];
  return sha256Hex(parts.join("\n"));
}

// ─── stale 判定（00-3 §6.4）───────────────────────────────────────────────

/**
 * 判定一个已提交前的 Episode target 是否 stale：
 * active Card Set 被替换（cardId/cardRevision 变化）或 sourceFingerprint 改变
 * 时，所有未提交 Episode stale；历史结果保留原版本引用（本函数不修改任何数据）。
 */
export function isEpisodeTargetStale(
  episodeAsset: PublishedLearningAssetContractV1,
  currentActiveAsset: PublishedLearningAssetContractV1,
): boolean {
  // fingerprint 已覆盖 cardId/cardRevision/claim/evidence 内容；cardId/cardRevision 的显式
  // 检查用于把「active Card Set 替换」语义单独表达（00-3 §6.4），是冗余但有意的防御。
  if (episodeAsset.sourceFingerprint !== currentActiveAsset.sourceFingerprint) {
    return true;
  }
  if (episodeAsset.cardId !== currentActiveAsset.cardId) {
    return true;
  }
  if (episodeAsset.cardRevision !== currentActiveAsset.cardRevision) {
    return true;
  }
  return false;
}

// ─── 集成 Gate（00-3 §6.5）────────────────────────────────────────────────

export interface HandoffIntegrationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface HandoffIntegrationGateResult {
  passed: boolean;
  checks: HandoffIntegrationCheck[];
}

/**
 * Generation → Learning 集成 Gate（00-3 §6.5）：
 * 1. contract hash：同一契约 hash 稳定可复现；
 * 2. 替换/stale：active Card Set 替换或 sourceFingerprint 改变 → Episode stale；
 * 3. forbidden-field 负向：forbiddenProbe 必须包含 forbidden 字段且被拒绝。
 *
 * 任一 check 失败抛 HandoffAdapterError（fail closed）；全部通过返回结果。
 */
export function runHandoffIntegrationGate(params: {
  previousAsset: PublishedLearningAssetContractV1;
  activeAsset: PublishedLearningAssetContractV1;
  forbiddenProbe: Record<string, unknown>;
}): HandoffIntegrationGateResult {
  const checks: HandoffIntegrationCheck[] = [];

  // 1. contract hash 稳定且可复现
  const hash1 = hashPublishedLearningAsset(params.activeAsset);
  const hash2 = hashPublishedLearningAsset(params.activeAsset);
  checks.push({
    name: "contract-hash-stable",
    passed: hash1 === hash2,
    detail: hash1 === hash2 ? `sha256=${hash1}` : `hash 不稳定: ${hash1} vs ${hash2}`,
  });

  // 2. 替换/stale：active Card Set 替换或 fingerprint 变化 → 未提交 Episode stale
  const replaced =
    params.previousAsset.cardId !== params.activeAsset.cardId ||
    params.previousAsset.cardRevision !== params.activeAsset.cardRevision;
  const stale = isEpisodeTargetStale(params.previousAsset, params.activeAsset);
  checks.push({
    name: "replace-or-fingerprint-change-makes-episode-stale",
    passed: replaced || stale,
    detail: replaced
      ? "active Card Set 被替换（cardId/cardRevision 变化）→ 未提交 Episode stale=true"
      : stale
        ? "sourceFingerprint 改变 → 未提交 Episode stale=true"
        : "无替换且 fingerprint 未变 → Episode 保持 active",
  });

  // 3. forbidden-field 负向：probe 必须命中并拒绝 forbidden 字段
  const forbiddenHits = validateForbiddenFields(params.forbiddenProbe);
  checks.push({
    name: "forbidden-field-negative",
    passed: forbiddenHits.length > 0,
    detail:
      forbiddenHits.length > 0
        ? `拒绝 forbidden 字段（00-3 §6.3）: ${forbiddenHits.join(", ")}`
        : "forbiddenProbe 未命中任何 forbidden 字段（probe 构造无效）",
  });

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    throw new HandoffAdapterError(
      `Generation → Learning 集成 Gate 失败: ${failed.map((c) => c.name).join(", ")}`,
      "HANDOFF_GATE_FAILED",
    );
  }
  return { passed: true, checks };
}

// ─── 错误类型 ─────────────────────────────────────────────────────────────

/** handoff adapter 的 fail-closed 错误 */
export class HandoffAdapterError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "HandoffAdapterError";
    this.code = code;
  }
}
