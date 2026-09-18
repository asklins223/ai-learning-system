/**
 * 桌宠人格档案（22-real-desktop-pet-memory-context-prd-tdd.md §2.1/§12.2）。
 *
 * pet_profiles 按 user+workspace 一行；preset_id 只存标识，用户修改后转为
 * custom 并保存全量。revision 用于 CAS 乐观锁。
 */

import { and, eq } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { petProfiles } from "@ailearn/shared/db-schema/companion-memory";
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
  /** 客户端 base revision（乐观锁）；缺省表示不做 CAS。 */
  revision?: number;
}

/** revision CAS 失败（并发写入赢得竞争）。route 层映射为 409。 */
export class PetProfileCasConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super("pet profile revision conflict");
    this.name = "PetProfileCasConflictError";
    this.currentRevision = currentRevision;
  }
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
  options?: { forUpdate?: boolean },
): Promise<PetProfile | null> {
  const query = executor
    .select()
    .from(petProfiles)
    .where(and(
      eq(petProfiles.workspaceId, scope.workspaceId),
      eq(petProfiles.userId, scope.userId),
    ))
    .limit(1);
  // 并发修复（2026-09 后端审查）：CAS 需要行锁。此前 route 的 revision 校验
  // 与 UPDATE 之间没有 FOR UPDATE，也没有 `AND revision = expected`，
  // 两个并发 PATCH 会各自读到 revision R 并都写成 R+1（后者静默覆盖前者）。
  const rows = options?.forUpdate ? await query.for("update").execute() : await query;
  return rows[0] ? toContract(rows[0]) : null;
}

export async function upsertPetProfile(
  executor: ApiTransaction,
  scope: PetProfileScope,
  input: PetProfileInput,
  now: Date = new Date(),
): Promise<PetProfile> {
  // 行锁 + revision CAS：并发 PATCH 不再互相覆盖（route 层据此返回 409）。
  const existing = await getPetProfile(executor, scope, { forUpdate: true });
  if (existing) {
    const expectedRevision = input.revision ?? existing.revision;
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
        eq(petProfiles.revision, expectedRevision),
      ))
      .returning();
    if (!updated[0]) {
      throw new PetProfileCasConflictError(existing.revision);
    }
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
