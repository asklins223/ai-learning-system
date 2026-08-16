/**
 * 方案 20 C43 — legacy pending Schedule 三路迁移（R35）。
 *
 * 对 workspace 内 `review_schedules.status='pending'` 的 legacy 排程做三路处置：
 * 1. **upgrade**：目标可消费（V1 card active，或 V2 objective 的
 *    learning_cards_v2 active）→ **保留 ID/generation/nextReviewAt**（不重建、
 *    不迁移 mastery/schedule identity），仅计数；
 * 2. **blocked**：目标存在但不可消费（card 非 active / V2 card 非 active）→
 *    保留 pending（列表可见）但 consume 被拒（消费侧由
 *    `reviewScheduleTargetsConsumableCardPredicate` 保证），
 *    `reason_code='migrated_blocked'` 标记；
 * 3. **invalid**：目标引用缺失（subjectType='card' 且卡不存在 /
 *    key_point 目标既无 card_key_points 也无 V2 objective）→
 *    `status='cancelled'` + `reason_code='migrated_invalid:<原因>'` 关闭。
 *
 * 幂等：upgrade/blocked 判定天然幂等；invalid 关闭后不再计入 pending。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import { cardKeyPoints, learningCards } from "../../db/schema/card.ts";
import {
  learningObjectivesV2,
  learningCardsV2,
} from "../../db/schema/card-generation-v2.ts";

export interface LegacyScheduleMigrationResultV2 {
  total: number;
  upgraded: number;
  blocked: number;
  invalid: number;
  invalidReasons: Record<string, number>;
}

export async function migrateLegacyPendingSchedulesV2(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<LegacyScheduleMigrationResultV2> {
  const result: LegacyScheduleMigrationResultV2 = {
    total: 0,
    upgraded: 0,
    blocked: 0,
    invalid: 0,
    invalidReasons: {},
  };
  const now = new Date();

  // 分页处理 pending schedules（避免大 workspace 一次性加载全表），并按类别批量
  // UPDATE（一次 round-trip 一个类别），避免逐行 UPDATE 的 N 次往返。
  const BATCH_SIZE = 500;
  let offset = 0;
  for (;;) {
    const rows = await tx
      .select()
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.status, "pending"),
      ))
      .orderBy(reviewSchedules.id)
      .limit(BATCH_SIZE)
      .offset(offset);
    if (rows.length === 0) break;
    offset += rows.length;
    result.total += rows.length;

    // 批量收集目标引用
    const keyPointTargetIds = new Set<string>();
    const cardTargetIds = new Set<string>();
    for (const s of rows) {
      if (s.subjectType === "key_point") {
        keyPointTargetIds.add(String(s.keyPointId ?? s.subjectId ?? ""));
      } else if (s.subjectType === "card") {
        cardTargetIds.add(String(s.subjectId ?? ""));
      }
    }
    keyPointTargetIds.delete("");

    // V1 key_point → card 映射 + active 卡集合
    const kpRows = keyPointTargetIds.size > 0
      ? await tx.select({ id: cardKeyPoints.id, cardId: cardKeyPoints.cardId })
          .from(cardKeyPoints)
          .where(and(
            eq(cardKeyPoints.workspaceId, workspaceId),
            inArray(cardKeyPoints.id, [...keyPointTargetIds]),
          ))
      : [];
    const kpCardId = new Map(kpRows.map((k) => [String(k.id), String(k.cardId)]));
    // R35 修复：cardStatus 以实际查询到的行为准（候选集含不存在的目标 id，
    // 不能用于"存在性"判定——否则 invalid 被误判为 blocked）。
    const cardIds = new Set([...kpCardId.values(), ...cardTargetIds]);
    const cardStatus = cardIds.size > 0
      ? new Map(
          (await tx.select({ id: learningCards.id, status: learningCards.status })
            .from(learningCards)
            .where(and(
              eq(learningCards.workspaceId, workspaceId),
              inArray(learningCards.id, [...cardIds]),
            ))).map((c) => [String(c.id), String(c.status)]),
        )
      : new Map<string, string>();

    // V2 objective → active card 集合（keyPointId = objectiveId alias）
    const v2ObjRows = [...keyPointTargetIds].length > 0
      ? await tx.select({ objectiveId: learningObjectivesV2.objectiveId })
          .from(learningObjectivesV2)
          .where(and(
            eq(learningObjectivesV2.workspaceId, workspaceId),
            eq(learningObjectivesV2.lifecycle, "active"),
            inArray(learningObjectivesV2.objectiveId, [...keyPointTargetIds]),
          ))
      : [];
    const v2ActiveObjs = new Set(v2ObjRows.map((o) => String(o.objectiveId)));
    const v2ActiveObjWithCard = v2ActiveObjs.size > 0
      ? new Set(
          (await tx.select({ objectiveId: learningCardsV2.objectiveId })
            .from(learningCardsV2)
            .where(and(
              eq(learningCardsV2.workspaceId, workspaceId),
              eq(learningCardsV2.lifecycle, "active"),
              inArray(learningCardsV2.objectiveId, [...v2ActiveObjs]),
            ))).map((c) => String(c.objectiveId)),
        )
      : new Set<string>();

    const blockedIds: string[] = [];
    // invalid 按 reason 分组批量关闭
    const invalidByReason = new Map<string, string[]>();
    const markInvalid = (id: string, reason: string) => {
      result.invalid += 1;
      result.invalidReasons[reason] = (result.invalidReasons[reason] ?? 0) + 1;
      const list = invalidByReason.get(reason);
      if (list) list.push(id);
      else invalidByReason.set(reason, [id]);
    };

    for (const s of rows) {
      if (s.subjectType === "key_point") {
        const targetId = String(s.keyPointId ?? s.subjectId ?? "");
        const v1CardId = kpCardId.get(targetId);
        if (v1CardId !== undefined && cardStatus.get(v1CardId) === "active") {
          result.upgraded += 1; // 保留 ID/generation/dueAt，不重建
          continue;
        }
        if (v2ActiveObjWithCard.has(targetId)) {
          result.upgraded += 1;
          continue;
        }
        if (v1CardId !== undefined || v2ActiveObjs.has(targetId)) {
          // 目标存在但不可消费（卡非 active）
          result.blocked += 1;
          blockedIds.push(s.id);
          continue;
        }
        markInvalid(s.id, "key_point_target_missing");
        continue;
      }
      if (s.subjectType === "card") {
        const targetId = String(s.subjectId ?? "");
        const targetStatus = cardStatus.get(targetId);
        if (targetStatus === "active") {
          result.upgraded += 1;
          continue;
        }
        if (targetStatus !== undefined) {
          result.blocked += 1;
          blockedIds.push(s.id);
          continue;
        }
        markInvalid(s.id, "card_target_missing");
        continue;
      }
      // 未知 subjectType：invalid 关闭（防御）
      markInvalid(s.id, "unknown_subject_type");
    }

    // 批量写回（每类别一次 UPDATE ... WHERE id IN (...)）
    if (blockedIds.length > 0) {
      await tx.update(reviewSchedules)
        .set({ reasonCode: "migrated_blocked", updatedAt: now })
        .where(and(
          eq(reviewSchedules.workspaceId, workspaceId),
          inArray(reviewSchedules.id, blockedIds),
        ));
    }
    for (const [reason, ids] of invalidByReason) {
      await tx.update(reviewSchedules)
        .set({
          status: "cancelled",
          reasonCode: `migrated_invalid:${reason}`,
          updatedAt: now,
        })
        .where(and(
          eq(reviewSchedules.workspaceId, workspaceId),
          inArray(reviewSchedules.id, ids),
        ));
    }
  }

  void sql;
  return result;
}
