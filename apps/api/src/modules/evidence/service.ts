import { and, eq, inArray } from "drizzle-orm";
import { db, type ApiTransaction } from "../../db/client.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences, evidenceOverrides, understandingEvents } from "../../db/schema/evidence.ts";
import { noteBlocks } from "../../db/schema/note.ts";
import { getUserOverrideMap } from "../../lib/evidence.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";

async function resolveConsumableEvidenceTarget(
  transaction: ApiTransaction,
  evidenceId: string,
  workspaceId: string,
) {
  const evidence = await transaction.query.evidences.findFirst({
    where: and(
      eq(evidences.id, evidenceId),
      eq(evidences.workspaceId, workspaceId),
    ),
  });
  if (!evidence) return null;

  const keyPoint = await transaction.query.cardKeyPoints.findFirst({
    where: and(
      eq(cardKeyPoints.id, evidence.keyPointId),
      eq(cardKeyPoints.workspaceId, workspaceId),
    ),
  });
  if (!keyPoint) return null;

  const card = await transaction.query.learningCards.findFirst({
    where: and(
      eq(learningCards.id, keyPoint.cardId),
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
    columns: { id: true },
  });
  return card ? { evidence, keyPoint } : null;
}

/**
 * Fetch every key point on a card plus its evidences, joined with the
 * referenced note_blocks. Tenant check: the card must belong to workspaceId.
 *
 * N-005: evidence 的 userOverride 改为用户级。
 * 每个用户看到的是自己的 override，不再共享。
 */
export async function getCardEvidence(cardId: string, workspaceId: string, userId?: string) {
  // 跨租户校验：card 必须属于当前 workspace
  const card = await db.query.learningCards.findFirst({
    where: and(eq(learningCards.id, cardId), eq(learningCards.workspaceId, workspaceId)),
  });
  if (!card) return null;

  const kps = await db.query.cardKeyPoints.findMany({
    where: eq(cardKeyPoints.cardId, cardId),
    orderBy: (k, { asc }) => [asc(k.ordinal)],
  });

  // 一次查询取所有 evidences，避免 N+1
  const allEvs = kps.length
    ? await db.query.evidences.findMany({
        where: inArray(
          evidences.keyPointId,
          kps.map((k) => k.id),
        ),
      })
    : [];
  const evsByKp = new Map<string, typeof allEvs>();
  for (const ev of allEvs) {
    const arr = evsByKp.get(ev.keyPointId) ?? [];
    arr.push(ev);
    evsByKp.set(ev.keyPointId, arr);
  }

  const blockIds = Array.from(
    new Set(allEvs.map((e) => e.blockId).filter(Boolean) as string[]),
  );
  const blocks = blockIds.length
    ? await db.query.noteBlocks.findMany({ where: inArray(noteBlocks.id, blockIds) })
    : [];
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  // N-005: 查询用户级 override
  const evidenceIds = allEvs.map((e) => e.id);
  const userOverrideMap = userId
    ? await getUserOverrideMap(userId, evidenceIds)
    : new Map<string, "confirmed" | "downgraded" | "rejected">();

  return kps.map((kp) => ({
    keyPoint: kp,
    evidences: (evsByKp.get(kp.id) ?? []).map((e) => ({
      ...e,
      // N-005: 返回用户级 override（如果有），否则回退到 legacy userOverride
      effectiveOverride: userOverrideMap.get(e.id) ?? e.userOverride ?? null,
      blockContent: e.blockId ? blockById.get(e.blockId)?.content ?? null : null,
      blockType: e.blockId ? blockById.get(e.blockId)?.type ?? null : null,
    })),
  }));
}

/**
 * N-005: 用户级证据覆盖。
 * 写入 evidence_overrides 表（per-user），不再更新共享的 evidences.userOverride 字段。
 * A 用户的 override 不会影响 B 用户的学习状态。
 */
export async function overrideEvidence(
  evidenceId: string,
  workspaceId: string,
  userId: string,
  override: "confirmed" | "downgraded" | "rejected",
) {
  return db.transaction(async (tx) => {
    const target = await resolveConsumableEvidenceTarget(
      tx,
      evidenceId,
      workspaceId,
    );
    if (!target) return null;

    // N-005: 使用 upsert 写入用户级 override 表
    // 唯一键 (evidence_id, user_id) 确保每个用户对同一证据只有一条 override
    await tx
      .insert(evidenceOverrides)
      .values({
        evidenceId,
        userId,
        workspaceId,
        override,
      })
      .onConflictDoUpdate({
        target: [evidenceOverrides.evidenceId, evidenceOverrides.userId],
        set: { override, createdAt: new Date() },
      });

    // Keep the derived understanding event atomic with the effective override.
    await tx.insert(understandingEvents).values({
      workspaceId,
      userId,
      subjectType: "card",
      subjectId: target.keyPoint.cardId,
      eventType: "evidence_overridden",
      payload: { evidenceId, override, keyPointId: target.evidence.keyPointId },
    });

    return { ok: true };
  });
}

/**
 * N-005: 删除用户级证据覆盖（恢复原始 alignment）。
 */
export async function removeEvidenceOverride(
  evidenceId: string,
  workspaceId: string,
  userId: string,
) {
  return db.transaction(async (tx) => {
    const target = await resolveConsumableEvidenceTarget(
      tx,
      evidenceId,
      workspaceId,
    );
    if (!target) return null;

    await tx
      .delete(evidenceOverrides)
      .where(
        and(
          eq(evidenceOverrides.evidenceId, evidenceId),
          eq(evidenceOverrides.userId, userId),
        ),
      );

    return { ok: true };
  });
}
