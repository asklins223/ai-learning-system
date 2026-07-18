import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { users } from "./identity.ts";

export const benchmarkReports = pgTable(
  "benchmark_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sampleCount: integer("sample_count").notNull(),
    keyPointCount: integer("key_point_count").notNull(),
    metricsJson: jsonb("metrics_json").$type<Record<string, unknown>>().notNull(),
    reportJson: jsonb("report_json").$type<Record<string, unknown>>().notNull(),
    hasLabels: boolean("has_labels").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceCreatedIdx: index("benchmark_reports_workspace_created_idx").on(t.workspaceId, t.createdAt),
  }),
);

export const benchmarkLabels = pgTable(
  "benchmark_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    noteFile: text("note_file").notNull(),
    keyPointOrdinal: integer("key_point_ordinal").notNull(),
    isCorrectlyAligned: boolean("is_correctly_aligned").notNull(),
    expectedBlockOrdinal: integer("expected_block_ordinal"),
    updatedBy: uuid("updated_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceNoteIdx: index("benchmark_labels_workspace_note_idx").on(t.workspaceId, t.noteFile),
    uniqueLabel: uniqueIndex("benchmark_labels_unique_idx").on(t.workspaceId, t.noteFile, t.keyPointOrdinal),
  }),
);
