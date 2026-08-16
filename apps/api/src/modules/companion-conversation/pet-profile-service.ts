/**
 * 桌宠人格档案（22-real-desktop-pet-memory-context-prd-tdd.md §2.1/§12.2）。
 *
 * pet_profiles 按 user+workspace 一行；preset_id 只存标识，用户修改后转为
 * custom 并保存全量。revision 用于 CAS 乐观锁。
 */

import { and, eq } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { petProfiles, type PetProfileActiveness } from "../../db/schema/companion-memory.ts";

export interface PetProfileBoundaries {
  allowPlayful?: boolean;
  allowNudgeLearning?: boolean;
  allowVoiceTags?: boolean;
  catchphrase?: string | null;
}

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

export interface PetPersonaPreset {
  presetId: string;
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: { text: string }[];
  activeness: PetProfileActiveness;
  boundaries: PetProfileBoundaries;
}

/** 系统默认 5 套人格预设（§2.1.1，实施时固化 seed）。 */
export const PET_PERSONA_PRESETS: PetPersonaPreset[] = [
  {
    presetId: "energetic-cat",
    name: "元气小猫",
    personalityTags: ["活泼", "黏人", "好奇"],
    speakingStyle: "活泼、热情、爱用语气词，喜欢鼓励用户，像一只好奇的小猫。",
    examples: [
      { text: "好呀好呀！我们继续～" },
      { text: "今天也一起加油喵！" },
    ],
    activeness: "active",
    boundaries: { allowPlayful: true, allowNudgeLearning: true, allowVoiceTags: true },
  },
  {
    presetId: "gentle-bookworm",
    name: "温柔书虫",
    personalityTags: ["温柔", "耐心", "细腻"],
    speakingStyle: "温柔、耐心、细腻，放慢节奏陪伴用户，不催促。",
    examples: [
      { text: "慢慢来，我陪你一起看。" },
      { text: "没关系，再读一遍就会更清楚。" },
    ],
    activeness: "quiet",
    boundaries: { allowPlayful: false, allowNudgeLearning: false, allowVoiceTags: false },
  },
  {
    presetId: "calm-scholar",
    name: "冷静学霸",
    personalityTags: ["理性", "简洁", "高效"],
    speakingStyle: "理性、简洁、高效，直接给建议，不绕弯。",
    examples: [
      { text: "建议先做第 3 题，正确率更高。" },
      { text: "这一步可以跳过，直接看结论。" },
    ],
    activeness: "moderate",
    boundaries: { allowPlayful: false, allowNudgeLearning: true, allowVoiceTags: false },
  },
  {
    presetId: "playful-partner",
    name: "调皮伙伴",
    personalityTags: ["幽默", "爱玩", "轻松"],
    speakingStyle: "幽默、爱玩、轻松，喜欢用小玩笑缓解枯燥。",
    examples: [
      { text: "诶嘿，这题我熟，来试试？" },
      { text: "别怕，错了也就一笑而过～" },
    ],
    activeness: "active",
    boundaries: { allowPlayful: true, allowNudgeLearning: true, allowVoiceTags: true },
  },
  {
    presetId: "calm-assistant",
    name: "沉稳助手",
    personalityTags: ["专业", "可靠", "克制"],
    speakingStyle: "专业、可靠、克制，提供稳妥建议，不打扰。",
    examples: [
      { text: "这是目前最稳妥的做法。" },
      { text: "建议先确认目标，再安排复习。" },
    ],
    activeness: "quiet",
    boundaries: { allowPlayful: false, allowNudgeLearning: true, allowVoiceTags: false },
  },
];

export function getPresetById(presetId: string | null | undefined): PetPersonaPreset | null {
  if (!presetId) return null;
  return PET_PERSONA_PRESETS.find((preset) => preset.presetId === presetId) ?? null;
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
