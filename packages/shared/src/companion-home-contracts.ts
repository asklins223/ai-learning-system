import { z } from "zod";

export const COMPANION_ROOM_SLOTS = ["desk", "shelf", "window", "rest"] as const;
export const companionRoomSlotV1Schema = z.enum(COMPANION_ROOM_SLOTS);
export type CompanionRoomSlotV1 = z.infer<typeof companionRoomSlotV1Schema>;

export const COMPANION_DECOR_IDS = [
  "keepsake.first-note",
  "keepsake.first-goal",
  "keepsake.first-review",
  "keepsake.first-memory",
] as const;
export const companionDecorIdV1Schema = z.enum(COMPANION_DECOR_IDS);
export type CompanionDecorIdV1 = z.infer<typeof companionDecorIdV1Schema>;

export const COMPANION_EFFECT_IDS = [
  "effect.page-ribbon",
  "effect.ink-ripple",
] as const;
export const companionEffectIdV1Schema = z.enum(COMPANION_EFFECT_IDS);
export type CompanionEffectIdV1 = z.infer<typeof companionEffectIdV1Schema>;

export const COMPANION_DECOR_ALLOWED_SLOTS: Readonly<
  Record<CompanionDecorIdV1, readonly CompanionRoomSlotV1[]>
> = {
  "keepsake.first-note": ["desk", "shelf"],
  "keepsake.first-goal": ["desk", "window"],
  "keepsake.first-review": ["desk", "rest"],
  "keepsake.first-memory": ["shelf", "rest"],
};

const isoTimestampSchema = z.string().datetime({ offset: true });

function uniqueEnumArray<T extends z.ZodTypeAny>(schema: T, max: number) {
  return z.array(schema).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "values must be unique",
      });
    }
  });
}

export const companionEquippedDecorBySlotV1Schema = z.strictObject({
  desk: companionDecorIdV1Schema.nullable(),
  shelf: companionDecorIdV1Schema.nullable(),
  window: companionDecorIdV1Schema.nullable(),
  rest: companionDecorIdV1Schema.nullable(),
});
export type CompanionEquippedDecorBySlotV1 = z.infer<
  typeof companionEquippedDecorBySlotV1Schema
>;

export const companionRoomProfileV1Schema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().positive(),
  unlockedDecorIds: uniqueEnumArray(companionDecorIdV1Schema, COMPANION_DECOR_IDS.length),
  equippedDecorBySlot: companionEquippedDecorBySlotV1Schema,
  unlockedEffectIds: uniqueEnumArray(companionEffectIdV1Schema, COMPANION_EFFECT_IDS.length),
  equippedEffectId: companionEffectIdV1Schema.nullable(),
  /**
   * 这个空间里伴星能不能主动开口（0266）。
   *
   * 账号级总开关与静默时段之外的空间级开关：主动触达按 (ws,user) 各自产生，
   * 一个人在两三个空间里就会同时收到几份"她想跟你说话"，而账号级只能全开或全关。
   */
  proactiveMuted: z.boolean(),
  updatedAt: isoTimestampSchema,
}).superRefine((value, context) => {
  const seen = new Set<CompanionDecorIdV1>();
  for (const slot of COMPANION_ROOM_SLOTS) {
    const decorId = value.equippedDecorBySlot[slot];
    if (decorId === null) continue;
    if (!value.unlockedDecorIds.includes(decorId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equippedDecorBySlot", slot],
        message: "equipped decor must be unlocked",
      });
    }
    if (!COMPANION_DECOR_ALLOWED_SLOTS[decorId].includes(slot)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equippedDecorBySlot", slot],
        message: "decor is not allowed in this slot",
      });
    }
    if (seen.has(decorId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equippedDecorBySlot", slot],
        message: "decor may only be equipped once",
      });
    }
    seen.add(decorId);
  }
  if (value.equippedEffectId !== null && !value.unlockedEffectIds.includes(value.equippedEffectId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["equippedEffectId"],
      message: "equipped effect must be unlocked",
    });
  }
});
export type CompanionRoomProfileV1 = z.infer<typeof companionRoomProfileV1Schema>;

export const companionRoomProfilePatchV1Schema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().positive(),
  equippedDecorBySlot: companionEquippedDecorBySlotV1Schema.partial().optional(),
  equippedEffectId: companionEffectIdV1Schema.nullable().optional(),
  /** 静音这个空间 / 取消静音。与装饰同一把 revision 锁。 */
  proactiveMuted: z.boolean().optional(),
}).refine(
  (value) => value.equippedEffectId !== undefined
    || (value.equippedDecorBySlot !== undefined && Object.keys(value.equippedDecorBySlot).length > 0),
  { message: "at least one equipment change is required" },
);
export type CompanionRoomProfilePatchV1 = z.infer<typeof companionRoomProfilePatchV1Schema>;

export const companionHomeProjectionV1Schema = z.strictObject({
  version: z.literal(1),
  snapshotAt: isoTimestampSchema,
  profileSummary: z.strictObject({
    name: z.string().min(1).max(60),
    activeness: z.enum(["quiet", "moderate", "active"]),
    boundaries: z.strictObject({
      allowPlayful: z.boolean(),
      allowNudgeLearning: z.boolean(),
      allowVoiceTags: z.boolean(),
      catchphrase: z.string().max(80).nullable(),
    }),
    familiarity: z.number().min(0).max(1),
    interactionCount: z.number().int().min(0),
    source: z.enum(["saved_profile", "system_default"]),
  }),
  memorySummary: z.strictObject({
    confirmedCount: z.number().int().min(0),
    candidateCount: z.number().int().min(0),
    updatedAt: isoTimestampSchema.nullable(),
  }),
  proactiveCue: z.strictObject({
    text: z.string().min(1).max(200),
    expiresAt: isoTimestampSchema,
    revision: z.number().int().positive(),
    /** 念头管线切片④：cue 源自 assistant_thoughts 时携带，气泡可点开主动开场。 */
    thoughtId: z.string().uuid().optional(),
    /**
     * 这条主动提示是谁：到点的**提醒**必须和随口一提的念头区分开——
     * 用户是明确要求过它的，气泡要停得更久、也要念出口；
     * 两者共用 7.4 秒的普通气泡就等于把闹钟当成便签。
     */
    origin: z.enum(["thought", "reminder", "system"]).default("system"),
  }).nullable(),
  roomProfile: companionRoomProfileV1Schema,
}).superRefine((value, context) => {
  if (
    value.proactiveCue
    && new Date(value.proactiveCue.expiresAt).getTime() <= new Date(value.snapshotAt).getTime()
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proactiveCue", "expiresAt"],
      message: "proactive cue must be live at snapshot time",
    });
  }
});
export type CompanionHomeProjectionV1 = z.infer<typeof companionHomeProjectionV1Schema>;
