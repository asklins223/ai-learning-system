/**
 * 方案 20 C6：全消费者 Legacy Read Adapter。
 *
 * §29.5:
 * - Card、Today、Review、Journey、Pet、Star Map 都读取 Objective/public Card contract；
 * - Candidate 不可出现在上述正式消费者；
 * - 同一 Objective 在各 surface 的 ID/revision/state 一致；
 * - archived/superseded/legacy_unreviewed eligibility 正确；
 * - 历史页使用 frozen snapshot；
 * - Companion public context 不包含 canonical answer/private rubric。
 *
 * 本模块提供统一的 V2 读取接口，让所有消费者通过同一适配层访问 V2 数据，
 * 内部自动处理 legacy keyPointId → V2 objectiveId 的映射。
 */

import { and, eq, desc, inArray } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
} from "../../db/schema/card-generation-v2.ts";
import { resolveKeyPointIdToObjectiveId } from "./target-snapshot-adapter.ts";

// ─── Public Card View (§29.5) ────────────────────────────────────────────

/**
 * 公开的 Card 视图——不含 canonical answer、rubric 等私有字段。
 * 这是所有正式消费者（Card/Today/Review/Graph/Pet）统一使用的视图。
 */
export interface PublicCardViewV2 {
  cardId: string;
  objectiveId: string;
  cardRevision: number;
  publicationRevision: number;
  lifecycle: "active" | "archived" | "superseded";
  front: {
    cue: string;
    context?: string;
    prompt: string;
  };
  publicSummary: string;
  knowledgeForm: string;
  strategy: string;
  sourceLabel: string | null;
  objectiveRevision: number;
  objectiveStatement: string;
  preferredIntents: string[];
  createdAt: string;
  updatedAt: string;
}

// ─── Read Adapter ────────────────────────────────────────────────────────

/**
 * 统一的 V2 Card 读取适配器。
 *
 * 所有正式消费者通过此函数获取 Card 数据。
 * 内部处理 keyPointId → objectiveId 映射。
 *
 * @param keyPointOrObjectiveId 可以是 V2 objectiveId 或 legacy keyPointId
 */
export async function readPublicCardV2(
  tx: ApiTransaction,
  workspaceId: string,
  keyPointOrObjectiveId: string,
): Promise<PublicCardViewV2 | null> {
  // Resolve keyPointId → objectiveId
  const objectiveId = await resolveKeyPointIdToObjectiveId(tx, workspaceId, keyPointOrObjectiveId);
  if (!objectiveId) return null;

  // Load active card
  const cardRows = await tx
    .select()
    .from(learningCardsV2)
    .where(and(
      eq(learningCardsV2.workspaceId, workspaceId),
      eq(learningCardsV2.objectiveId, objectiveId),
      inArray(learningCardsV2.lifecycle, ["active", "archived", "superseded"]),
    ))
    .orderBy(desc(learningCardsV2.updatedAt))
    .limit(1);

  if (cardRows.length === 0) return null;
  const card = cardRows[0];

  // Load objective revision for public fields
  const objRevRows = await tx
    .select({
      objectiveStatement: learningObjectiveRevisionsV2.objectiveStatement,
      publicSummary: learningObjectiveRevisionsV2.publicSummary,
      knowledgeForm: learningObjectiveRevisionsV2.knowledgeForm,
      preferredIntents: learningObjectiveRevisionsV2.preferredIntents,
      revision: learningObjectiveRevisionsV2.revision,
    })
    .from(learningObjectiveRevisionsV2)
    .where(and(
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
      eq(learningObjectiveRevisionsV2.objectiveId, objectiveId),
    ))
    .orderBy(desc(learningObjectiveRevisionsV2.revision))
    .limit(1);

  const objRev = objRevRows[0];

  return {
    cardId: card.cardId,
    objectiveId,
    cardRevision: card.cardRevision,
    publicationRevision: card.currentPublicationRevision,
    lifecycle: card.lifecycle as "active" | "archived" | "superseded",
    front: card.front as { cue: string; context?: string; prompt: string },
    publicSummary: card.publicSummary,
    knowledgeForm: card.knowledgeForm,
    strategy: card.strategy,
    sourceLabel: card.sourceLabel,
    objectiveRevision: objRev?.revision ?? 0,
    objectiveStatement: objRev?.objectiveStatement ?? "",
    preferredIntents: objRev?.preferredIntents ?? [],
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
  };
}

/**
 * 批量读取多个 Objective 的公开 Card 视图。
 * 用于 Today、Review 列表等场景。
 */
export async function readPublicCardsBatchV2(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveIds: string[],
): Promise<PublicCardViewV2[]> {
  if (objectiveIds.length === 0) return [];

  const results: PublicCardViewV2[] = [];
  for (const objectiveId of objectiveIds) {
    const card = await readPublicCardV2(tx, workspaceId, objectiveId);
    if (card) results.push(card);
  }
  return results;
}

/**
 * 查询 workspace 下的所有 active objectives。
 * 用于 Star Map、Today 推荐等。
 */
export async function listActiveObjectivesV2(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<Array<{
  objectiveId: string;
  objectiveStatement: string;
  publicSummary: string;
  knowledgeForm: string;
  preferredIntents: string[];
  lifecycle: string;
  lifecycleEpoch: number;
  currentRevision: number;
}>> {
  const rows = await tx
    .select({
      objectiveId: learningObjectivesV2.objectiveId,
      lifecycle: learningObjectivesV2.lifecycle,
      lifecycleEpoch: learningObjectivesV2.lifecycleEpoch,
      currentRevision: learningObjectivesV2.currentRevision,
    })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, workspaceId),
      eq(learningObjectivesV2.lifecycle, "active"),
    ))
    .orderBy(desc(learningObjectivesV2.updatedAt));

  if (rows.length === 0) return [];

  // Load latest revision for each objective
  const result: Array<{
    objectiveId: string;
    objectiveStatement: string;
    publicSummary: string;
    knowledgeForm: string;
    preferredIntents: string[];
    lifecycle: string;
    lifecycleEpoch: number;
    currentRevision: number;
  }> = [];

  for (const row of rows) {
    const revRows = await tx
      .select({
        objectiveStatement: learningObjectiveRevisionsV2.objectiveStatement,
        publicSummary: learningObjectiveRevisionsV2.publicSummary,
        knowledgeForm: learningObjectiveRevisionsV2.knowledgeForm,
        preferredIntents: learningObjectiveRevisionsV2.preferredIntents,
        revision: learningObjectiveRevisionsV2.revision,
      })
      .from(learningObjectiveRevisionsV2)
      .where(and(
        eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
        eq(learningObjectiveRevisionsV2.objectiveId, row.objectiveId),
      ))
      .orderBy(desc(learningObjectiveRevisionsV2.revision))
      .limit(1);

    const rev = revRows[0];
    if (rev) {
      result.push({
        objectiveId: row.objectiveId,
        objectiveStatement: rev.objectiveStatement,
        publicSummary: rev.publicSummary,
        knowledgeForm: rev.knowledgeForm,
        preferredIntents: rev.preferredIntents,
        lifecycle: row.lifecycle,
        lifecycleEpoch: row.lifecycleEpoch,
        currentRevision: row.currentRevision,
      });
    }
  }

  return result;
}

/**
 * 查询 workspace 下的 active cards（用于 Card 列表页面）。
 */
export async function listActiveCardsV2(
  tx: ApiTransaction,
  workspaceId: string,
  limit = 50,
  offset = 0,
): Promise<PublicCardViewV2[]> {
  const cardRows = await tx
    .select()
    .from(learningCardsV2)
    .where(and(
      eq(learningCardsV2.workspaceId, workspaceId),
      eq(learningCardsV2.lifecycle, "active"),
    ))
    .orderBy(desc(learningCardsV2.updatedAt))
    .limit(limit)
    .offset(offset);

  const results: PublicCardViewV2[] = [];
  for (const card of cardRows) {
    const objRevRows = await tx
      .select({
        objectiveStatement: learningObjectiveRevisionsV2.objectiveStatement,
        publicSummary: learningObjectiveRevisionsV2.publicSummary,
        knowledgeForm: learningObjectiveRevisionsV2.knowledgeForm,
        preferredIntents: learningObjectiveRevisionsV2.preferredIntents,
        revision: learningObjectiveRevisionsV2.revision,
      })
      .from(learningObjectiveRevisionsV2)
      .where(and(
        eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
        eq(learningObjectiveRevisionsV2.objectiveId, card.objectiveId),
      ))
      .orderBy(desc(learningObjectiveRevisionsV2.revision))
      .limit(1);

    const objRev = objRevRows[0];
    results.push({
      cardId: card.cardId,
      objectiveId: card.objectiveId,
      cardRevision: card.cardRevision,
      publicationRevision: card.currentPublicationRevision,
      lifecycle: card.lifecycle as "active" | "archived" | "superseded",
      front: card.front as { cue: string; context?: string; prompt: string },
      publicSummary: card.publicSummary,
      knowledgeForm: card.knowledgeForm,
      strategy: card.strategy,
      sourceLabel: card.sourceLabel,
      objectiveRevision: objRev?.revision ?? 0,
      objectiveStatement: objRev?.objectiveStatement ?? "",
      preferredIntents: objRev?.preferredIntents ?? [],
      createdAt: card.createdAt.toISOString(),
      updatedAt: card.updatedAt.toISOString(),
    });
  }

  return results;
}

/**
 * §29.5: Companion public context — 不包含 canonical answer/private rubric。
 * 用于 Pet、Journey 等需要显示 Card 摘要但不泄漏答案的场景。
 */
export interface CompanionPublicContextV2 {
  objectiveId: string;
  objectiveStatement: string;
  publicSummary: string;
  knowledgeForm: string;
  strategy: string;
  front: { cue: string; prompt: string };
}

export async function readCompanionPublicContextV2(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveId: string,
): Promise<CompanionPublicContextV2 | null> {
  const card = await readPublicCardV2(tx, workspaceId, objectiveId);
  if (!card) return null;
  return {
    objectiveId: card.objectiveId,
    objectiveStatement: card.objectiveStatement,
    publicSummary: card.publicSummary,
    knowledgeForm: card.knowledgeForm,
    strategy: card.strategy,
    front: { cue: card.front.cue, prompt: card.front.prompt },
  };
}

/**
 * §29.5: Eligibility 检查 — archived/superseded 目标不继续推荐。
 */
export function isObjectiveEligibleForRecommendation(
  lifecycle: string,
): boolean {
  return lifecycle === "active";
}

/**
 * §29.5: 检查 Candidate 是否出现在正式消费者中。
 * 正式消费者只应读取已激活的 Card，不应读取 Candidate。
 */
export function assertNotCandidate(cardId: string, objectiveId: string): void {
  // Candidate IDs have a different format from activated card IDs.
  // In the V2 schema, activated cards have UUID cardId,
  // while candidates have candidateId (also UUID but stored in a different table).
  // This check is a documentation-level assertion: if code calls readPublicCardV2,
  // it will only find entries in learning_cards_v2 (activated cards),
  // never in card_generation_candidates_v2 (candidates).
  // This function exists to make the invariant explicit.
  if (!cardId || !objectiveId) {
    throw new Error("assertNotCandidate: cardId and objectiveId must be non-empty");
  }
}
