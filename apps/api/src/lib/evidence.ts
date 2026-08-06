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

import { db, type ApiTransaction } from "../db/client.ts";
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
 *
 * BUG-71 修复：支持可选的 executor 参数，允许在 withWorkspaceTransaction
 * 上下文内复用同一事务连接，确保 DB 级工作区上下文一致。
 */
export async function getUserOverrideMap(
  userId: string,
  evidenceIds: string[],
  executor?: Pick<ApiTransaction, "query">,
): Promise<Map<string, EvidenceOverride>> {
  if (evidenceIds.length === 0) return new Map();
  // BUG-71: 优先使用传入的 executor（事务连接），否则回退到 db（向后兼容）
  const queryTarget = executor ?? db;
  const rows = await queryTarget.query.evidenceOverrides.findMany({
    where: and(
      eq(evidenceOverrides.userId, userId),
      inArray(evidenceOverrides.evidenceId, evidenceIds),
    ),
  });
  return new Map(rows.map((r) => [r.evidenceId, r.override as EvidenceOverride]));
}

/**
 * 证据聚合统计结果。
 */
export interface EvidenceStats {
  hard: number;
  soft: number;
  total: number;
  pendingCount: number;
}

/**
 * QUAL-46 修复：提取共享的证据对齐聚合函数。
 *
 * stats/service.ts 和 understanding/service.ts 都包含几乎相同的逻辑：
 * 查询 evidences → 查询 userOverrideMap → 遍历计算 effectiveAlignment → 聚合 hard/soft 计数。
 * 此函数将这段逻辑提取为共享实现，消除重复代码。
 *
 * @param evRows 证据行数组（包含 id, alignment, userOverride 字段）
 * @param userOverrideMap 用户级 override 映射（从 getUserOverrideMap 获取）
 * @param userId 可选的用户 ID，决定是否使用用户级 override
 * @returns 聚合统计结果（hard、soft、total、pendingCount）
 */
export function aggregateEvidenceStats(
  evRows: Array<{ id: string; alignment: string; userOverride: string | null }>,
  userOverrideMap: Map<string, EvidenceOverride>,
  userId?: string,
): EvidenceStats {
  let hard = 0;
  let soft = 0;
  let total = 0;
  let pendingCount = 0;

  for (const ev of evRows) {
    const userOv = userOverrideMap.get(ev.id) ?? null;
    const ea = userId
      ? effectiveAlignmentForUser(ev.alignment, ev.userOverride, userOv)
      : effectiveAlignment(ev.alignment, ev.userOverride);
    if (ea === null) continue; // rejected 证据不计入统计
    total++;
    if (ea === "aligned") hard++;
    else if (ea === "soft") soft++;
    const hasOverride = userId ? Boolean(userOv ?? ev.userOverride) : Boolean(ev.userOverride);
    if (!hasOverride && ea !== "aligned") pendingCount++;
  }

  return { hard, soft, total, pendingCount };
}
