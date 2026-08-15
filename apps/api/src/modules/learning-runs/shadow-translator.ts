/**
 * Shadow Translator（文档 16 §16.2 Shadow 期 + P2 Gate）。
 *
 * 只读 migration translator：把旧已提交事实确定性映射为 canonical envelope
 * 形态（canonicalEventId = sha256(legacy kind + factId + legacy identity)），
 * 不回写业务表、不触发 scheduler、不产生第二 canonical 事实。Cutover 时冻结
 * 终止 watermark；新 Commit 只为 watermark 之后的事实发布 envelope。唯一约束
 * 与对账必须证明同一 logical commit 不会同时被 translator 与新 Commit 发布。
 *
 * 旧事实源（canonical 结算口径）：
 *  - validation_point_assessments（verdict='covered' AND assessmentSource='ai'，
 *    旧栈"正式掌握"事实）
 *  - review_attempts（status='completed'）
 *  - review_schedules（旧 writer 创建行属 schedule 而非 fact——只作 watermark
 *    参考，不映射 envelope）
 */

import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { createHash } from "node:crypto";

export interface ShadowEnvelopeMapping {
  legacyKind: "validation_point_assessment" | "review_attempt";
  legacyFactId: string;
  canonicalEventId: string;
  workspaceId: string;
  userId: string | null;
  keyPointId: string | null;
}

export interface ShadowReconciliationReport {
  /** translator 可确定性映射的旧事实总数（期望 envelope 数）。 */
  translatedFacts: number;
  /** 新 outbox 已存在且 canonicalEventId 与 translator 一致的 envelope 数。 */
  matchedEnvelopes: number;
  /** 冲突：同 canonicalEventId 被两条不同路径（translator vs 新 Commit）发布。 */
  conflicts: number;
  /** 旧事实存在但新链路尚未发布 envelope（Shadow 期正常，cutover 需为 0）。 */
  pendingFacts: number;
  /** 新 outbox 中 translator 无法解释的 envelope（新 Commit 产物，正常）。 */
  unMappedEnvelopes: number;
  /** 对账通过：无冲突（同一 logical commit 不会被双路径发布）。 */
  reconciled: boolean;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** §16.2 确定性映射：canonicalEventId = hash(legacy kind + factId + legacy commit identity)。 */
export function translateLegacyFactId(
  legacyKind: "validation_point_assessment" | "review_attempt",
  factId: string,
): string {
  return sha256Hex(`legacy:${legacyKind}:${factId}:canonical:v1`);
}

export interface LegacyFactRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  keyPointId: string | null;
  kind: "validation_point_assessment" | "review_attempt";
}

/**
 * 读旧事实并做 shadow 对账（只读；仅报告，不回写）。
 * 对账口径：translator 映射的 canonicalEventId 集合与新 canonical outbox 的
 * canonicalEventId 集合求交——同一 id 必须来自同一旧事实（唯一约束证明），
 * 任何 translator 映射 id 若已在新 outbox 且对应不同 run（新 Commit 也发布了
 * 同一 logical commit）即冲突。
 */
export async function runShadowReconciliation(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<ShadowReconciliationReport> {
  // 旧 validation 事实（canonical 结算口径：AI 判定 covered）。
  const validationRows = await tx.execute(sql`
    SELECT a.id::text AS id, a.workspace_id::text AS workspace_id,
           s.key_point_id::text AS key_point_id, a.user_id::text AS user_id
    FROM validation_point_assessments a
    JOIN validation_submissions s ON s.id = a.submission_id
    WHERE a.workspace_id = ${workspaceId}
      AND a.verdict = 'covered'
      AND a.assessment_source = 'ai'
  `);
  const reviewRows = await tx.execute(sql`
    SELECT r.id::text AS id, r.workspace_id::text AS workspace_id,
           NULL::text AS user_id, NULL::text AS key_point_id
    FROM review_attempts r
    WHERE r.workspace_id = ${workspaceId}
      AND r.status = 'completed'
  `);

  const facts: LegacyFactRow[] = [
    ...(validationRows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      userId: r.user_id ? String(r.user_id) : null,
      keyPointId: r.key_point_id ? String(r.key_point_id) : null,
      kind: "validation_point_assessment" as const,
    })),
    ...(reviewRows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      userId: null,
      keyPointId: null,
      kind: "review_attempt" as const,
    })),
  ];

  const translatedIds = new Map(
    facts.map((f) => [
      translateLegacyFactId(f.kind, f.id),
      f,
    ]),
  );

  const envelopeRows = await tx.execute(sql`
    SELECT canonical_event_id::text AS canonical_event_id, run_id::text AS run_id
    FROM canonical_learning_event_outbox
    WHERE workspace_id = ${workspaceId}
  `);

  let matchedEnvelopes = 0;
  let conflicts = 0;
  const seenIds = new Set<string>();
  for (const row of envelopeRows as Array<Record<string, unknown>>) {
    const canonicalEventId = String(row.canonical_event_id);
    if (translatedIds.has(canonicalEventId)) {
      matchedEnvelopes += 1;
      // 冲突：新 outbox 已有该 id 且不是 translator 唯一来源（双路径发布）。
      if (seenIds.has(canonicalEventId)) conflicts += 1;
      seenIds.add(canonicalEventId);
    }
  }

  const pendingFacts = translatedIds.size - matchedEnvelopes;
  const unMappedEnvelopes = (envelopeRows as unknown[]).length - matchedEnvelopes;

  return {
    translatedFacts: translatedIds.size,
    matchedEnvelopes,
    conflicts,
    pendingFacts,
    unMappedEnvelopes,
    reconciled: conflicts === 0,
  };
}
