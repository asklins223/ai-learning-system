/**
 * Journey V2 表（文档 16 §10.1）：账号级邀请 + workspace 级旅程 + 乱序事件 buffer。
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
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

// ─── companion_account_invitations（账号级一次性邀请）─────────────────────

export const companionAccountInvitations = pgTable(
  "companion_account_invitations",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("not_offered"),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    deferredUntil: timestamp("deferred_until", { withTimezone: true }),
    replayRequestedAt: timestamp("replay_requested_at", { withTimezone: true }),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index("companion_account_invitations_status_idx").on(t.status, t.deferredUntil),
  }),
);

// ─── companion_journeys（workspace 级旅程进度，CAS）───────────────────────

export const companionJourneys = pgTable(
  "companion_journeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    assistantSessionId: uuid("assistant_session_id"),
    status: text("status").notNull().default("active"),
    branch: text("branch").notNull().default("own_material"),
    currentStep: text("current_step"),
    stepRevision: integer("step_revision").notNull().default(0),
    dismissedNarrationSteps: jsonb("dismissed_narration_steps").notNull().default([]),
    refs: jsonb("refs").notNull().default({}),
    lastDomainEventId: text("last_domain_event_id"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
    resumeTokenRef: text("resume_token_ref"),
    resumeExpiresAt: timestamp("resume_expires_at", { withTimezone: true }),
    completionKind: text("completion_kind"),
    error: jsonb("error"),
    parentJourneyId: uuid("parent_journey_id"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // §10.1：同一账号最多一个自动活跃的新手旅程（非终态）。
    userActiveUnique: uniqueIndex("companion_journeys_user_active_unique_idx")
      .on(t.userId)
      .where(sql`${t.status} IN ('active', 'paused', 'recoverable_error')`),
    workspaceUserIdx: index("companion_journeys_workspace_user_idx").on(
      t.workspaceId, t.userId, t.updatedAt,
    ),
  }),
);

// ─── companion_journey_pending_events（乱序事件 buffer，幂等）─────────────

export const companionJourneyPendingEvents = pgTable(
  "companion_journey_pending_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journeyId: uuid("journey_id").notNull().references(() => companionJourneys.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    domainEventId: text("domain_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"), // pending | applied | superseded
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // (journeyId, domainEventId) 幂等：重放同一事件不重复推进。
    journeyEventUnique: uniqueIndex("companion_journey_pending_events_unique_idx").on(
      t.journeyId, t.domainEventId,
    ),
    statusIdx: index("companion_journey_pending_events_status_idx").on(t.journeyId, t.status),
  }),
);
