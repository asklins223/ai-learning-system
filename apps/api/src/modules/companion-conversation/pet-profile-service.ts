/**
 * 桌宠人格档案（22-real-desktop-pet-memory-context-prd-tdd.md §2.1/§12.2）。
 *
 * pet_profiles 按 user+workspace 一行；preset_id 只存标识，用户修改后转为
 * custom 并保存全量。revision 用于 CAS 乐观锁。
 */

import { and, eq } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { petProfiles } from "../../db/schema/companion-memory.ts";
// §11.9：预设 seed 固化在 shared 包，api/worker 共享同一来源。
export {
  PET_PERSONA_PRESETS,
  getPresetById,
  PET_PERSONA_PRESET_VERSION,
  type PetProfileActiveness,
  type PetPersonaPreset,
  type PetPersonaPresetBoundaries,
} from "@ailearn/shared/pet-persona-presets";
import type {
  PetProfileActiveness,
  PetPersonaPresetBoundaries,
} from "@ailearn/shared/pet-persona-presets";

export type PetProfileBoundaries = PetPersonaPresetBoundaries;

export interface PetProfileInput {
  presetId?: string | null;
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: { text: string }[];
  activeness: PetProfileActiveness;
  boundaries: PetProfileBoundaries;
}

export interface PetProfile extends PetProfileInput {
  id: string;
  workspaceId: string;
  userId: string;
  revision: number;
  familiarity: number;
  interactionCount: number;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PetProfileScope {
  workspaceId: string;
  userId: string;
}

function toContract(row: typeof petProfiles.$inferSelect): PetProfile {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    presetId: row.presetId,
    name: row.name,
    personalityTags: Array.isArray(row.personalityTags) ? row.personalityTags : [],
    speakingStyle: row.speakingStyle,
    examples: Array.isArray(row.examples) ? row.examples as { text: string }[] : [],
    activeness: row.activeness as PetProfileActiveness,
    boundaries: (row.boundaries ?? {}) as PetProfileBoundaries,
    revision: row.revision,
    familiarity: row.familiarity,
    interactionCount: row.interactionCount,
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getPetProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
): Promise<PetProfile | null> {
  const rows = await executor
    .select()
    .from(petProfiles)
    .where(and(
      eq(petProfiles.workspaceId, scope.workspaceId),
      eq(petProfiles.userId, scope.userId),
    ))
    .limit(1);
  return rows[0] ? toContract(rows[0]) : null;
}

export async function upsertPetProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
  input: PetProfileInput,
  now: Date = new Date(),
): Promise<PetProfile> {
  const existing = await getPetProfile(executor, scope);
  if (existing) {
    const updated = await executor.update(petProfiles)
      .set({
        presetId: input.presetId ?? null,
        name: input.name,
        personalityTags: input.personalityTags,
        speakingStyle: input.speakingStyle,
        examples: input.examples,
        activeness: input.activeness,
        boundaries: input.boundaries,
        revision: existing.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(petProfiles.workspaceId, scope.workspaceId),
        eq(petProfiles.userId, scope.userId),
      ))
      .returning();
    return toContract(updated[0]);
  }
  const inserted = await executor.insert(petProfiles).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    presetId: input.presetId ?? null,
    name: input.name,
    personalityTags: input.personalityTags,
    speakingStyle: input.speakingStyle,
    examples: input.examples,
    activeness: input.activeness,
    boundaries: input.boundaries,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return toContract(inserted[0]);
}

/** 重置为系统默认：删除当前 profile 行（后续读取时回退预设）。 */
export async function resetPetProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
): Promise<boolean> {
  const deleted = await executor.delete(petProfiles)
    .where(and(
      eq(petProfiles.workspaceId, scope.workspaceId),
      eq(petProfiles.userId, scope.userId),
    ))
    .returning({ id: petProfiles.id });
  return deleted.length > 0;
}
