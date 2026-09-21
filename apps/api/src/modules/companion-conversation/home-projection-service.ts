import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  COMPANION_DECOR_ALLOWED_SLOTS,
  COMPANION_DECOR_IDS,
  COMPANION_EFFECT_IDS,
  COMPANION_ROOM_SLOTS,
  companionHomeProjectionV1Schema,
  companionRoomProfileV1Schema,
  type CompanionDecorIdV1,
  type CompanionEffectIdV1,
  type CompanionEquippedDecorBySlotV1,
  type CompanionHomeProjectionV1,
  type CompanionRoomProfilePatchV1,
  type CompanionRoomProfileV1,
  type CompanionRoomSlotV1,
} from "@ailearn/shared/companion-home-contracts";
import type { ApiTransaction } from "../../db/client.ts";
import {
  assistantDeliveries,
  assistantMemoryItems,
  companionRoomProfiles,
  learningObjectivesV2,
  learningRuns,
  notes,
  petProfiles,
} from "@ailearn/shared/db-schema";

export interface CompanionHomeScope {
  workspaceId: string;
  userId: string;
}

export interface CompanionMilestoneState {
  hasSavedNote: boolean;
  hasActiveGoal: boolean;
  hasCompletedReview: boolean;
  hasConfirmedMemory: boolean;
}

export interface CompanionMilestoneUnlocks {
  decorIds: CompanionDecorIdV1[];
  effectIds: CompanionEffectIdV1[];
}

const EMPTY_EQUIPPED_DECOR: CompanionEquippedDecorBySlotV1 = {
  desk: null,
  shelf: null,
  window: null,
  rest: null,
};

/**
 * Knowledge effects are equipped preferences, not ambient emitters. The renderer
 * may play the selected effect once after a confirmed completion or handoff;
 * stable room frames must not render persistent particles or glitter.
 */
export function deriveMilestoneUnlocks(
  milestones: CompanionMilestoneState,
): CompanionMilestoneUnlocks {
  const decorIds: CompanionDecorIdV1[] = [];
  const effectIds: CompanionEffectIdV1[] = [];

  if (milestones.hasSavedNote) {
    decorIds.push("keepsake.first-note");
    effectIds.push("effect.page-ribbon");
  }
  if (milestones.hasActiveGoal) {
    decorIds.push("keepsake.first-goal");
  }
  if (milestones.hasCompletedReview) {
    decorIds.push("keepsake.first-review");
    effectIds.push("effect.ink-ripple");
  }
  if (milestones.hasConfirmedMemory) {
    decorIds.push("keepsake.first-memory");
  }

  return { decorIds, effectIds };
}

export type RoomEquipmentValidationResult =
  | {
      ok: true;
      equippedDecorBySlot: CompanionEquippedDecorBySlotV1;
      equippedEffectId: CompanionEffectIdV1 | null;
    }
  | {
      ok: false;
      reason: "decor_locked" | "decor_slot_invalid" | "decor_duplicate" | "effect_locked";
      resourceId: string;
      slot?: CompanionRoomSlotV1;
    };

export function validateRoomEquipmentPatch(
  current: CompanionRoomProfileV1,
  patch: CompanionRoomProfilePatchV1,
): RoomEquipmentValidationResult {
  const equippedDecorBySlot: CompanionEquippedDecorBySlotV1 = {
    ...current.equippedDecorBySlot,
    ...(patch.equippedDecorBySlot ?? {}),
  };
  const equippedEffectId = patch.equippedEffectId === undefined
    ? current.equippedEffectId
    : patch.equippedEffectId;
  const seenDecor = new Set<CompanionDecorIdV1>();

  for (const slot of COMPANION_ROOM_SLOTS) {
    const decorId = equippedDecorBySlot[slot];
    if (decorId === null) continue;
    if (!current.unlockedDecorIds.includes(decorId)) {
      return { ok: false, reason: "decor_locked", resourceId: decorId, slot };
    }
    if (!COMPANION_DECOR_ALLOWED_SLOTS[decorId].includes(slot)) {
      return { ok: false, reason: "decor_slot_invalid", resourceId: decorId, slot };
    }
    if (seenDecor.has(decorId)) {
      return { ok: false, reason: "decor_duplicate", resourceId: decorId, slot };
    }
    seenDecor.add(decorId);
  }

  if (equippedEffectId !== null && !current.unlockedEffectIds.includes(equippedEffectId)) {
    return { ok: false, reason: "effect_locked", resourceId: equippedEffectId };
  }

  return { ok: true, equippedDecorBySlot, equippedEffectId };
}

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRoomProfile(
  row: typeof companionRoomProfiles.$inferSelect,
): CompanionRoomProfileV1 {
  return companionRoomProfileV1Schema.parse({
    version: 1,
    revision: row.revision,
    unlockedDecorIds: row.unlockedDecorIds,
    equippedDecorBySlot: row.equippedDecorBySlot,
    unlockedEffectIds: row.unlockedEffectIds,
    equippedEffectId: row.equippedEffectId,
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function readMilestones(
  executor: ApiTransaction,
  scope: CompanionHomeScope,
): Promise<CompanionMilestoneState> {
  const savedNote = await executor
    .select({ id: notes.id })
    .from(notes)
    .where(and(
      eq(notes.workspaceId, scope.workspaceId),
      eq(notes.createdBy, scope.userId),
      isNull(notes.deletedAt),
      isNotNull(notes.currentVersionId),
    ))
    .limit(1);
  const activeGoal = await executor
    .select({ id: learningObjectivesV2.id })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, scope.workspaceId),
      eq(learningObjectivesV2.lifecycle, "active"),
      gt(learningObjectivesV2.currentRevision, 0),
    ))
    .limit(1);
  const completedReview = await executor
    .select({ id: learningRuns.id })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.workspaceId, scope.workspaceId),
      eq(learningRuns.userId, scope.userId),
      eq(learningRuns.phase, "completed"),
      isNotNull(learningRuns.result),
    ))
    .limit(1);
  const confirmedMemory = await executor
    .select({ id: assistantMemoryItems.id })
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      eq(assistantMemoryItems.candidate, false),
      eq(assistantMemoryItems.userConfirmed, true),
      isNull(assistantMemoryItems.archivedAt),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .limit(1);

  return {
    hasSavedNote: savedNote.length > 0,
    hasActiveGoal: activeGoal.length > 0,
    hasCompletedReview: completedReview.length > 0,
    hasConfirmedMemory: confirmedMemory.length > 0,
  };
}

async function readRoomProfileRow(
  executor: ApiTransaction,
  scope: CompanionHomeScope,
) {
  const rows = await executor
    .select()
    .from(companionRoomProfiles)
    .where(and(
      eq(companionRoomProfiles.workspaceId, scope.workspaceId),
      eq(companionRoomProfiles.userId, scope.userId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

function mergedIds<T extends string>(knownOrder: readonly T[], current: readonly T[], added: readonly T[]): T[] {
  const allowed = new Set<T>([...current, ...added]);
  return knownOrder.filter((value) => allowed.has(value));
}

/** Create the row on first read and monotonically persist new server milestones. */
export async function getCompanionRoomProfile(
  executor: ApiTransaction,
  scope: CompanionHomeScope,
  now: Date = new Date(),
): Promise<CompanionRoomProfileV1> {
  const milestoneUnlocks = deriveMilestoneUnlocks(await readMilestones(executor, scope));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readRoomProfileRow(executor, scope);
    if (!existing) {
      const inserted = await executor
        .insert(companionRoomProfiles)
        .values({
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          unlockedDecorIds: milestoneUnlocks.decorIds,
          equippedDecorBySlot: EMPTY_EQUIPPED_DECOR,
          unlockedEffectIds: milestoneUnlocks.effectIds,
          equippedEffectId: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [companionRoomProfiles.workspaceId, companionRoomProfiles.userId],
        })
        .returning();
      if (inserted[0]) return toRoomProfile(inserted[0]);
      continue;
    }

    const unlockedDecorIds = mergedIds(
      COMPANION_DECOR_IDS,
      existing.unlockedDecorIds,
      milestoneUnlocks.decorIds,
    );
    const unlockedEffectIds = mergedIds(
      COMPANION_EFFECT_IDS,
      existing.unlockedEffectIds,
      milestoneUnlocks.effectIds,
    );
    const hasNewUnlock = unlockedDecorIds.length !== existing.unlockedDecorIds.length
      || unlockedEffectIds.length !== existing.unlockedEffectIds.length;
    if (!hasNewUnlock) return toRoomProfile(existing);

    const updated = await executor
      .update(companionRoomProfiles)
      .set({
        unlockedDecorIds,
        unlockedEffectIds,
        revision: existing.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(companionRoomProfiles.id, existing.id),
        eq(companionRoomProfiles.revision, existing.revision),
      ))
      .returning();
    if (updated[0]) return toRoomProfile(updated[0]);
  }

  throw new Error("companion room profile changed repeatedly while reconciling milestones");
}

export type PatchCompanionRoomProfileResult =
  | { ok: true; profile: CompanionRoomProfileV1 }
  | { ok: false; reason: "revision_conflict"; currentRevision: number }
  | {
      ok: false;
      reason: "decor_locked" | "decor_slot_invalid" | "decor_duplicate" | "effect_locked";
      resourceId: string;
      slot?: CompanionRoomSlotV1;
    };

export async function patchCompanionRoomProfile(
  executor: ApiTransaction,
  scope: CompanionHomeScope,
  patch: CompanionRoomProfilePatchV1,
  now: Date = new Date(),
): Promise<PatchCompanionRoomProfileResult> {
  const current = await getCompanionRoomProfile(executor, scope, now);
  if (current.revision !== patch.revision) {
    return { ok: false, reason: "revision_conflict", currentRevision: current.revision };
  }

  const validated = validateRoomEquipmentPatch(current, patch);
  if (!validated.ok) return validated;

  const updated = await executor
    .update(companionRoomProfiles)
    .set({
      equippedDecorBySlot: validated.equippedDecorBySlot,
      equippedEffectId: validated.equippedEffectId,
      revision: current.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(companionRoomProfiles.workspaceId, scope.workspaceId),
      eq(companionRoomProfiles.userId, scope.userId),
      eq(companionRoomProfiles.revision, patch.revision),
    ))
    .returning();
  if (updated[0]) return { ok: true, profile: toRoomProfile(updated[0]) };

  const latest = await readRoomProfileRow(executor, scope);
  return {
    ok: false,
    reason: "revision_conflict",
    currentRevision: latest?.revision ?? current.revision,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

async function readMemorySummary(
  executor: ApiTransaction,
  scope: CompanionHomeScope,
) {
  const rows = await executor
    .select({
      confirmedCount: sql<number>`count(*) FILTER (
        WHERE ${assistantMemoryItems.candidate} = false
          AND ${assistantMemoryItems.userConfirmed} = true
      )::int`,
      candidateCount: sql<number>`count(*) FILTER (
        WHERE ${assistantMemoryItems.candidate} = true
      )::int`,
      updatedAt: sql<Date | string | null>`max(${assistantMemoryItems.updatedAt})`,
    })
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.archivedAt),
      isNull(assistantMemoryItems.deletedAt),
    ));
  const row = rows[0];
  return {
    confirmedCount: Number(row?.confirmedCount ?? 0),
    candidateCount: Number(row?.candidateCount ?? 0),
    updatedAt: normalizeDate(row?.updatedAt),
  };
}

async function readProactiveCue(
  executor: ApiTransaction,
  scope: CompanionHomeScope,
  now: Date,
) {
  const rows = await executor
    .select({
      payloadRef: assistantDeliveries.payloadRef,
      expiresAt: assistantDeliveries.expiresAt,
      inboxSequence: assistantDeliveries.inboxSequence,
    })
    .from(assistantDeliveries)
    .where(and(
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
      // proactive_cue 已删除（无生产者）：主动提示的唯一来源是 system_event。
      eq(assistantDeliveries.kind, "system_event"),
      inArray(assistantDeliveries.state, ["queued", "delivered"]),
      gt(assistantDeliveries.expiresAt, now),
    ))
    .orderBy(desc(assistantDeliveries.inboxSequence))
    .limit(5);

  for (const row of rows) {
    const payload = row.payloadRef;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const text = (payload as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 200) continue;
    // 念头管线切片④：systemEventId 形如 "thought:<uuid>" 时气泡可点击开场。
    const systemEventIdRaw = (payload as Record<string, unknown>).systemEventId;
    const systemEventId = typeof systemEventIdRaw === "string" ? systemEventIdRaw : null;
    const thoughtMatch = systemEventId ? /^thought:([0-9a-fA-F-]{36})$/.exec(systemEventId) : null;
    // 到点提醒（0238）走同一条 system_event 通道，但它是用户明确要过的东西：
    // 前端按 origin 决定气泡停留时长与是否念出口。run.completed 这类系统事件
    // 既不是念头也不是提醒，归 system。
    const origin = thoughtMatch !== null
      ? "thought"
      : (systemEventId !== null && /^reminder:[0-9a-fA-F-]{36}$/.test(systemEventId))
        ? "reminder"
        : "system";
    return {
      text: trimmed,
      expiresAt: row.expiresAt.toISOString(),
      revision: row.inboxSequence,
      origin,
      ...(thoughtMatch ? { thoughtId: thoughtMatch[1] } : {}),
    };
  }
  return null;
}

export async function getCompanionHomeProjection(
  executor: ApiTransaction,
  scope: CompanionHomeScope,
  now: Date = new Date(),
): Promise<CompanionHomeProjectionV1> {
  const roomProfile = await getCompanionRoomProfile(executor, scope, now);
  const profileRows = await executor
    .select()
    .from(petProfiles)
    .where(and(
      eq(petProfiles.workspaceId, scope.workspaceId),
      eq(petProfiles.userId, scope.userId),
    ))
    .limit(1);
  const savedProfile = profileRows[0] ?? null;
  const memorySummary = await readMemorySummary(executor, scope);
  const proactiveCue = await readProactiveCue(executor, scope, now);

  return companionHomeProjectionV1Schema.parse({
    version: 1,
    snapshotAt: now.toISOString(),
    profileSummary: savedProfile
      ? {
          name: savedProfile.name,
          activeness: savedProfile.activeness,
          boundaries: {
            allowPlayful: savedProfile.boundaries.allowPlayful ?? true,
            allowNudgeLearning: savedProfile.boundaries.allowNudgeLearning ?? true,
            allowVoiceTags: savedProfile.boundaries.allowVoiceTags ?? false,
            catchphrase: savedProfile.boundaries.catchphrase ?? null,
          },
          familiarity: clamp01(savedProfile.familiarity),
          interactionCount: Math.max(0, savedProfile.interactionCount),
          source: "saved_profile",
        }
      : {
          name: "学习伴星",
          activeness: "moderate",
          boundaries: {
            allowPlayful: true,
            allowNudgeLearning: true,
            allowVoiceTags: false,
            catchphrase: null,
          },
          familiarity: 0,
          interactionCount: 0,
          source: "system_default",
        },
    memorySummary,
    proactiveCue,
    roomProfile,
  });
}
