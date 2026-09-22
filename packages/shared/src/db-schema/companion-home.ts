import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CompanionDecorIdV1,
  CompanionEffectIdV1,
  CompanionEquippedDecorBySlotV1,
} from "../companion-home-contracts.ts";
import { users } from "./identity.ts";

export const companionRoomProfiles = pgTable(
  "companion_room_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    unlockedDecorIds: text("unlocked_decor_ids")
      .array()
      .$type<CompanionDecorIdV1[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    equippedDecorBySlot: jsonb("equipped_decor_by_slot")
      .$type<CompanionEquippedDecorBySlotV1>()
      .notNull()
      .default(sql`'{"desk":null,"shelf":null,"window":null,"rest":null}'::jsonb`),
    unlockedEffectIds: text("unlocked_effect_ids")
      .array()
      .$type<CompanionEffectIdV1[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    equippedEffectId: text("equipped_effect_id").$type<CompanionEffectIdV1 | null>(),
    /**
     * 这个空间里伴星能不能主动开口（0266）。
     *
     * 账号级 `global_enabled` / quiet hours 之外的空间级开关：一个人白天在班级空间、
     * 晚上在个人空间，主动触达按 (ws,user) 各自产生，没有这一层就只能"全开或全关"。
     * 默认 false（不静音）——既有行为不变，静音必须是用户显式动作。
     */
    proactiveMuted: boolean("proactive_muted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    workspaceUserUnique: uniqueIndex("companion_room_profiles_workspace_user_unique").on(
      table.workspaceId,
      table.userId,
    ),
    revisionCheck: check("companion_room_profiles_revision_check", sql`${table.revision} >= 1`),
    decorIdsCheck: check(
      "companion_room_profiles_decor_ids_check",
      sql`array_position(${table.unlockedDecorIds}, NULL) IS NULL
        AND ${table.unlockedDecorIds} <@ ARRAY['keepsake.first-note','keepsake.first-goal','keepsake.first-review','keepsake.first-memory']::text[]`,
    ),
    decorIdsUniqueCheck: check(
      "companion_room_profiles_decor_ids_unique_check",
      sql`cardinality(array_positions(${table.unlockedDecorIds}, 'keepsake.first-note')) <= 1
        AND cardinality(array_positions(${table.unlockedDecorIds}, 'keepsake.first-goal')) <= 1
        AND cardinality(array_positions(${table.unlockedDecorIds}, 'keepsake.first-review')) <= 1
        AND cardinality(array_positions(${table.unlockedDecorIds}, 'keepsake.first-memory')) <= 1`,
    ),
    effectIdsCheck: check(
      "companion_room_profiles_effect_ids_check",
      sql`array_position(${table.unlockedEffectIds}, NULL) IS NULL
        AND ${table.unlockedEffectIds} <@ ARRAY['effect.page-ribbon','effect.ink-ripple']::text[]`,
    ),
    effectIdsUniqueCheck: check(
      "companion_room_profiles_effect_ids_unique_check",
      sql`cardinality(array_positions(${table.unlockedEffectIds}, 'effect.page-ribbon')) <= 1
        AND cardinality(array_positions(${table.unlockedEffectIds}, 'effect.ink-ripple')) <= 1`,
    ),
    equippedEffectCheck: check(
      "companion_room_profiles_equipped_effect_check",
      sql`${table.equippedEffectId} IS NULL OR ${table.equippedEffectId} IN ('effect.page-ribbon','effect.ink-ripple')`,
    ),
    equippedEffectUnlockedCheck: check(
      "companion_room_profiles_equipped_effect_unlocked_check",
      sql`${table.equippedEffectId} IS NULL OR ${table.equippedEffectId} = ANY(${table.unlockedEffectIds})`,
    ),
    slotShapeCheck: check(
      "companion_room_profiles_slot_shape_check",
      sql`jsonb_typeof(${table.equippedDecorBySlot}) = 'object'
        AND ${table.equippedDecorBySlot} ?& ARRAY['desk', 'shelf', 'window', 'rest']
        AND ${table.equippedDecorBySlot} - ARRAY['desk', 'shelf', 'window', 'rest'] = '{}'::jsonb`,
    ),
    slotValuesCheck: check(
      "companion_room_profiles_slot_values_check",
      sql`(${table.equippedDecorBySlot}->>'desk' IS NULL OR ${table.equippedDecorBySlot}->>'desk' IN ('keepsake.first-note','keepsake.first-goal','keepsake.first-review'))
        AND (${table.equippedDecorBySlot}->>'shelf' IS NULL OR ${table.equippedDecorBySlot}->>'shelf' IN ('keepsake.first-note','keepsake.first-memory'))
        AND (${table.equippedDecorBySlot}->>'window' IS NULL OR ${table.equippedDecorBySlot}->>'window' = 'keepsake.first-goal')
        AND (${table.equippedDecorBySlot}->>'rest' IS NULL OR ${table.equippedDecorBySlot}->>'rest' IN ('keepsake.first-review','keepsake.first-memory'))`,
    ),
    equippedDecorUnlockedCheck: check(
      "companion_room_profiles_equipped_decor_unlocked_check",
      sql`(${table.equippedDecorBySlot}->>'desk' IS NULL OR ${table.equippedDecorBySlot}->>'desk' = ANY(${table.unlockedDecorIds}))
        AND (${table.equippedDecorBySlot}->>'shelf' IS NULL OR ${table.equippedDecorBySlot}->>'shelf' = ANY(${table.unlockedDecorIds}))
        AND (${table.equippedDecorBySlot}->>'window' IS NULL OR ${table.equippedDecorBySlot}->>'window' = ANY(${table.unlockedDecorIds}))
        AND (${table.equippedDecorBySlot}->>'rest' IS NULL OR ${table.equippedDecorBySlot}->>'rest' = ANY(${table.unlockedDecorIds}))`,
    ),
    equippedDecorUniqueCheck: check(
      "companion_room_profiles_equipped_decor_unique_check",
      sql`(${table.equippedDecorBySlot}->>'desk' IS NULL OR ${table.equippedDecorBySlot}->>'shelf' IS NULL OR ${table.equippedDecorBySlot}->>'desk' <> ${table.equippedDecorBySlot}->>'shelf')
        AND (${table.equippedDecorBySlot}->>'desk' IS NULL OR ${table.equippedDecorBySlot}->>'window' IS NULL OR ${table.equippedDecorBySlot}->>'desk' <> ${table.equippedDecorBySlot}->>'window')
        AND (${table.equippedDecorBySlot}->>'desk' IS NULL OR ${table.equippedDecorBySlot}->>'rest' IS NULL OR ${table.equippedDecorBySlot}->>'desk' <> ${table.equippedDecorBySlot}->>'rest')
        AND (${table.equippedDecorBySlot}->>'shelf' IS NULL OR ${table.equippedDecorBySlot}->>'window' IS NULL OR ${table.equippedDecorBySlot}->>'shelf' <> ${table.equippedDecorBySlot}->>'window')
        AND (${table.equippedDecorBySlot}->>'shelf' IS NULL OR ${table.equippedDecorBySlot}->>'rest' IS NULL OR ${table.equippedDecorBySlot}->>'shelf' <> ${table.equippedDecorBySlot}->>'rest')
        AND (${table.equippedDecorBySlot}->>'window' IS NULL OR ${table.equippedDecorBySlot}->>'rest' IS NULL OR ${table.equippedDecorBySlot}->>'window' <> ${table.equippedDecorBySlot}->>'rest')`,
    ),
  }),
);
