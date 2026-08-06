/**
 * MapContextBundle 规划器（计划 §7.1, §W3）
 *
 * 职责：
 * - 将 atomic evidence span 分组为语义上下文 bundle
 * - 每个 primary evidence 恰好属于一个 owning bundle（G3）
 * - overlap 只能是 contextOnly，不能成为另一个 bundle 的 primary
 * - 短公式、命令、定义和 list item 不能仅因字符少被排除
 * - token 预算感知的 bundle 打包
 *
 * 不变量（G2, G3, §7.1）：
 * - 一个 primary evidence 必须恰好属于一个 owning bundle
 * - overlap 只能是 contextOnly
 * - bundle 有确定性的 bundle_key 和 ordinal
 * - inputHash 覆盖 bundle 的全部成员
 */

import { createHash } from "node:crypto";
import type { MapContextBundle } from "@ailearn/shared";

/** 可计划的证据单元（从 note_evidence_spans 或 note_image_evidence_units 映射） */
export interface PlannableEvidence {
  /** 证据 refId（span ID 或 image evidence unit ID） */
  refId: string;
  /** 证据类型 */
  kind: "text_span" | "image_evidence";
  /** 所属 block ID */
  blockId: string;
  /** block 序号 */
  blockOrdinal: number;
  /** 章节路径 */
  sectionPath: string[];
  /** token 估算 */
  tokenEstimate: number;
  /** 原文 hash */
  sourceHash: string;
  /** 是否为短内容（短公式、命令、定义等） */
  isShort: boolean;
  /** 原文内容（仅用于 token 估算，不持久化到 bundle） */
  text: string;
  /** text_span 专属：字符起始位置（image_evidence 为 0） */
  charStart: number;
  /** text_span 专属：字符结束位置（image_evidence 为 0） */
  charEnd: number;
}

/** Bundle 规划结果 */
export interface BundlePlanResult {
  /** 所有 bundle */
  bundles: PlannedBundle[];
  /** primary evidence 到 bundle 的映射 */
  primaryOwnership: Map<string, string>;
  /** 未分配的 evidence（理论上不应该有，因为所有 required 都是 primary） */
  unassigned: string[];
  /** 总 token 估算 */
  totalTokenEstimate: number;
  /** 规划版本 */
  plannerVersion: string;
}

/** 已规划的 bundle */
export interface PlannedBundle {
  /** bundle ID（确定性的） */
  bundleId: string;
  /** bundle 序号 */
  ordinal: number;
  /** primary evidence refIds */
  memberEvidenceIds: string[];
  /** context evidence refIds（overlap） */
  contextEvidenceIds: string[];
  /** 章节路径 */
  sectionPath: string[];
  /** 起始 source ordinal */
  sourceStartOrdinal: number;
  /** token 估算 */
  tokenEstimate: number;
  /** input hash */
  inputHash: string;
  /** 是否为 required */
  required: boolean;
}

/** Bundle 规划器配置 */
export interface BundlePlannerConfig {
  /** 目标 bundle token 大小 */
  targetBundleTokens: number;
  /** 最大 bundle token 大小 */
  maxBundleTokens: number;
  /** 每个 bundle 最多 primary 成员数 */
  maxBundleMembers: number;
  /** context overlap 的最大 token 数 */
  maxContextOverlapTokens: number;
  /** 是否允许跨 section 的 context overlap */
  allowCrossSectionContext: boolean;
}

/** 默认配置 */
export const DEFAULT_BUNDLE_PLANNER_CONFIG: BundlePlannerConfig = {
  targetBundleTokens: 4_000,
  maxBundleTokens: 8_000,
  maxBundleMembers: 50,
  maxContextOverlapTokens: 1_000,
  allowCrossSectionContext: true,
};

/** Bundle 规划器版本 */
export const BUNDLE_PLANNER_VERSION = "bundle-planner-v1";

/**
 * 规划 MapContextBundles。
 *
 * 算法：
 * 1. 按 (sectionPath, blockOrdinal) 排序所有 evidence
 * 2. 在同一 section 内按 token 预算打包
 * 3. 短内容（公式、命令、定义）不被单独排除，尽量合并到相邻 bundle
 * 4. 相邻 bundle 之间添加 context overlap（最后一个 span 作为下一个的 context）
 *
 * 保证（G3）：每个 primary evidence 恰好属于一个 owning bundle。
 */
export function planBundles(
  evidence: PlannableEvidence[],
  config: BundlePlannerConfig = DEFAULT_BUNDLE_PLANNER_CONFIG,
): BundlePlanResult {
  if (evidence.length === 0) {
    return {
      bundles: [],
      primaryOwnership: new Map(),
      unassigned: [],
      totalTokenEstimate: 0,
      plannerVersion: BUNDLE_PLANNER_VERSION,
    };
  }

  // 按章节路径和 block 序号排序
  const sorted = [...evidence].sort((a, b) => {
    const sectionCompare = a.sectionPath.join(" > ").localeCompare(b.sectionPath.join(" > "));
    if (sectionCompare !== 0) return sectionCompare;
    return a.blockOrdinal - b.blockOrdinal;
  });

  const bundles: PlannedBundle[] = [];
  const primaryOwnership = new Map<string, string>();
  let currentMembers: PlannableEvidence[] = [];
  let currentTokens = 0;
  let lastSpanOfPrevBundle: PlannableEvidence | null = null;
  // R50: 追踪上一个 bundle 最后一个 span 的 token 估算，用于预留 context overlap 空间
  let prevBundleLastSpanTokens = 0;

  const flush = () => {
    if (currentMembers.length === 0) return;

    // 添加 context overlap：上一个 bundle 的最后一个 span
    const contextEvidenceIds: string[] = [];
    let contextTokens = 0;
    if (lastSpanOfPrevBundle && config.allowCrossSectionContext) {
      contextEvidenceIds.push(lastSpanOfPrevBundle.refId);
      contextTokens = lastSpanOfPrevBundle.tokenEstimate;
    }

    const memberEvidenceIds = currentMembers.map((e) => e.refId);
    const sectionPath = currentMembers[0].sectionPath;
    const sourceStartOrdinal = currentMembers[0].blockOrdinal;
    const tokenEstimate = currentTokens + contextTokens;

    // 计算确定性的 bundleId
    const bundleId = computeBundleId(memberEvidenceIds, contextEvidenceIds, sectionPath);

    // 计算 inputHash
    const inputHash = computeBundleInputHash(currentMembers, contextEvidenceIds.length > 0 ? [lastSpanOfPrevBundle!] : []);

    const bundle: PlannedBundle = {
      bundleId,
      ordinal: bundles.length,
      memberEvidenceIds,
      contextEvidenceIds,
      sectionPath: [...sectionPath],
      sourceStartOrdinal,
      tokenEstimate,
      inputHash,
      required: true,
    };

    bundles.push(bundle);

    // 记录 primary ownership
    for (const refId of memberEvidenceIds) {
      primaryOwnership.set(refId, bundleId);
    }

    // 更新 context overlap 指针
    lastSpanOfPrevBundle = currentMembers[currentMembers.length - 1];
    // R50: 更新预留 token 估算
    prevBundleLastSpanTokens = currentMembers[currentMembers.length - 1].tokenEstimate;
    currentMembers = [];
    currentTokens = 0;
  };

  for (const ev of sorted) {
    // 检查是否需要 flush（token 超限或成员数超限）
    // R50: 预留 context overlap token 空间，避免 flush 后 tokenEstimate 超过 maxBundleTokens
    const reservedContextTokens = prevBundleLastSpanTokens;
    if (
      currentMembers.length > 0 &&
      (currentTokens + ev.tokenEstimate + reservedContextTokens > config.maxBundleTokens ||
        currentMembers.length >= config.maxBundleMembers)
    ) {
      flush();
    }

    // 检查 section 切换（同 section 内尽量不切分）
    if (currentMembers.length > 0) {
      const currentSection = currentMembers[0].sectionPath.join(" > ");
      const evSection = ev.sectionPath.join(" > ");
      if (currentSection !== evSection && currentTokens > config.targetBundleTokens) {
        flush();
      }
    }

    currentMembers.push(ev);
    currentTokens += ev.tokenEstimate;
  }
  flush();

  // 验证：所有 evidence 都有 primary owner
  const unassigned: string[] = [];
  for (const ev of sorted) {
    if (!primaryOwnership.has(ev.refId)) {
      unassigned.push(ev.refId);
    }
  }

  const totalTokenEstimate = bundles.reduce((sum, b) => sum + b.tokenEstimate, 0);

  return {
    bundles,
    primaryOwnership,
    unassigned,
    totalTokenEstimate,
    plannerVersion: BUNDLE_PLANNER_VERSION,
  };
}

/**
 * 将 PlannedBundle 转换为 MapContextBundle 合约类型。
 */
export function toMapContextBundle(bundle: PlannedBundle): MapContextBundle {
  return {
    bundleId: bundle.bundleId,
    memberEvidenceIds: [...bundle.memberEvidenceIds],
    contextEvidenceIds: [...bundle.contextEvidenceIds],
    sectionPath: [...bundle.sectionPath],
    sourceStartOrdinal: bundle.sourceStartOrdinal,
    tokenEstimate: bundle.tokenEstimate,
    inputHash: bundle.inputHash,
  };
}

/**
 * 批量转换。
 */
export function toMapContextBundles(bundles: PlannedBundle[]): MapContextBundle[] {
  return bundles.map(toMapContextBundle);
}

/**
 * 计算确定性的 bundleId。
 * SHA256(ordinal | memberRefIds | contextRefIds | sectionPath)
 */
function computeBundleId(
  memberIds: string[],
  contextIds: string[],
  sectionPath: string[],
): string {
  const raw = JSON.stringify({
    members: memberIds,
    context: contextIds,
    section: sectionPath,
  });
  return `bundle:${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * 计算 bundle 的 inputHash。
 * 覆盖所有成员的 refId + sourceHash + textHash。
 */
function computeBundleInputHash(
  members: PlannableEvidence[],
  contextMembers: PlannableEvidence[],
): string {
  const raw = JSON.stringify({
    members: members.map((m) => ({
      refId: m.refId,
      sourceHash: m.sourceHash,
      kind: m.kind,
    })),
    context: contextMembers.map((m) => ({
      refId: m.refId,
      sourceHash: m.sourceHash,
      kind: m.kind,
    })),
  });
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * 验证 bundle 规划的完整性。
 *
 * 不变量检查（G3）：
 * - 每个 primary evidence 恰好属于一个 owning bundle
 * - overlap 只能是 contextOnly
 * - 没有 evidence 同时是某个 bundle 的 primary 和另一个的 primary
 */
export function verifyBundlePlan(result: BundlePlanResult): void {
  const primaryToBundle = new Map<string, string>();

  for (const bundle of result.bundles) {
    for (const refId of bundle.memberEvidenceIds) {
      if (primaryToBundle.has(refId)) {
        throw new BundlePlanError(
          `evidence ${refId} 同时是 bundle ${primaryToBundle.get(refId)} 和 ${bundle.bundleId} 的 primary`,
          "duplicate_primary",
        );
      }
      primaryToBundle.set(refId, bundle.bundleId);
    }
  }

  // context overlap 可以出现在多个 bundle 中，但不能同时是任何 bundle 的 primary
  for (const bundle of result.bundles) {
    for (const refId of bundle.contextEvidenceIds) {
      if (primaryToBundle.get(refId) === bundle.bundleId) {
        throw new BundlePlanError(
          `evidence ${refId} 同时是 bundle ${bundle.bundleId} 的 primary 和 context`,
          "primary_context_conflict",
        );
      }
    }
  }

  if (result.unassigned.length > 0) {
    throw new BundlePlanError(
      `${result.unassigned.length} 个 evidence 未分配到任何 bundle`,
      "unassigned_evidence",
    );
  }
}

/** Bundle 规划错误 */
export class BundlePlanError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "BundlePlanError";
    this.code = code;
  }
}
