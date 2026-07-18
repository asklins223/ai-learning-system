/**
 * R-009: 统一 effectiveAlignment 计算逻辑。
 *
 * 所有聚合点（卡片列表、统计、复习、理解状态）必须使用此函数，
 * 确保证据的 userOverride 一致地影响 hard/soft 计数和证据缺口判断。
 *
 * N-005: 新增用户级 override 支持。
 * - effectiveAlignmentForUser: 接受 userId 和用户 override map，实现用户级覆盖。
 * - 旧的 effectiveAlignment 保留向后兼容（使用 evidences.userOverride 字段）。
 */

import { db } from "../db/client.ts";
import { evidenceOverrides } from "../db/schema/evidence.ts";
import { eq, inArray, and } from "drizzle-orm";

export type EvidenceAlignment = "aligned" | "soft" | "unaligned" | "stale_alignment";
export type EvidenceOverride = "confirmed" | "downgraded" | "rejected";

/**
 * 计算证据的有效对齐状态（向后兼容版本，使用 evidences.userOverride 字段）。
 *
 * - userOverride="rejected" → 返回 null，表示该证据应被排除
 * - userOverride="downgraded" → 返回 "soft"
 * - userOverride="confirmed" → 返回 "aligned"
 * - 无 override → 返回原始 alignment
 */
export function effectiveAlignment(
  alignment: string,
  userOverride: string | null,
): EvidenceAlignment | null {
  if (userOverride === "rejected") return null;
  if (userOverride === "downgraded") return "soft";
  if (userOverride === "confirmed") return "aligned";
  return alignment as EvidenceAlignment;
}

/**
 * 判断证据是否为"硬证据"（effective alignment === "aligned"）。
 */
export function isHardEvidence(
  alignment: string,
  userOverride: string | null,
): boolean {
  return effectiveAlignment(alignment, userOverride) === "aligned";
}

/**
 * N-005: 计算证据的有效对齐状态（用户级版本）。
 *
 * 优先使用用户级 override（evidence_overrides 表），
 * 如果用户级 override 不存在则回退到 evidences.userOverride 字段。
 */
export function effectiveAlignmentForUser(
  alignment: string,
  legacyOverride: string | null,
  userOverride: EvidenceOverride | null,
): EvidenceAlignment | null {
  // N-005: 优先使用用户级 override
  const override = userOverride ?? legacyOverride;
  if (override === "rejected") return null;
  if (override === "downgraded") return "soft";
  if (override === "confirmed") return "aligned";
  return alignment as EvidenceAlignment;
}

/**
 * N-005: 判断证据是否为"硬证据"（用户级版本）。
 */
export function isHardEvidenceForUser(
  alignment: string,
  legacyOverride: string | null,
  userOverride: EvidenceOverride | null,
): boolean {
  return effectiveAlignmentForUser(alignment, legacyOverride, userOverride) === "aligned";
}

/**
 * N-005: 批量查询用户级证据 override。
 * 返回 evidenceId → override 的映射。
 */
export async function getUserOverrideMap(
  userId: string,
  evidenceIds: string[],
): Promise<Map<string, EvidenceOverride>> {
  if (evidenceIds.length === 0) return new Map();
  const rows = await db.query.evidenceOverrides.findMany({
    where: and(
      eq(evidenceOverrides.userId, userId),
      inArray(evidenceOverrides.evidenceId, evidenceIds),
    ),
  });
  return new Map(rows.map((r) => [r.evidenceId, r.override as EvidenceOverride]));
}
