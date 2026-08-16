/**
 * Assistant durable delivery 表（文档 16 §14.3 AssistantDeliveryV2）。
 *
 * Orchestrator 生成的全部主动消息与业务结果的唯一交付通道：inbox 以
 * (userId, workspaceId) 分区，inboxSequence 分区内单调；跨设备只允许一个
 * 未过期 display lease；ACK 幂等（deliveryId + leaseToken）。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./identity.ts";

export const assistantDeliveries = pgTable(
  "assistant_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assistantSessionId: uuid("assistant_session_id"),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    inboxSequence: integer("inbox_sequence").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state").notNull().default("queued"),
    kind: text("kind").notNull(), // message | proposal | action_result | proactive_cue | system_event
    payloadRef: jsonb("payload_ref").notNull(),
    displayLease: jsonb("display_lease"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // inbox 分区内序列唯一（Last-Event-ID 断线恢复）。
    inboxSequenceUnique: uniqueIndex("assistant_deliveries_inbox_sequence_unique_idx").on(
      t.workspaceId, t.userId, t.inboxSequence,
    ),
    // dedupe（同一 delivery 只入队一次）。
    dedupeUnique: uniqueIndex("assistant_deliveries_dedupe_unique_idx").on(
      t.workspaceId, t.userId, t.dedupeKey,
    ),
    inboxIdx: index("assistant_deliveries_inbox_idx").on(
      t.workspaceId, t.userId, t.inboxSequence,
    ),
    stateIdx: index("assistant_deliveries_state_idx").on(t.state, t.expiresAt),
  }),
);
