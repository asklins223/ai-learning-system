import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./index.ts";

const expectedTables = [
  "ai_artifacts",
  "ai_audit_log",
  "auth_rate_limits",
  "benchmark_labels",
  "benchmark_reports",
  "card_key_points",
  "evidence_overrides",
  "evidences",
  "invite_codes",
  "jobs",
  "learning_cards",
  "note_blocks",
  "note_versions",
  "notes",
  "onboarding_states",
  "review_attempts",
  "review_schedules",
  "search_documents",
  "sessions",
  "source_segments",
  "sources",
  "understanding_events",
  "user_ai_model_configs",
  "users",
  "validation_events",
  "validation_questions",
  "workspace_members",
  "workspaces",
];

describe("database schema package contract", () => {
  it("exports every runtime table exactly once", () => {
    const tableNames = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableName(table as any))
      .sort();

    assert.deepEqual(tableNames, expectedTables);
    assert.equal(new Set(tableNames).size, tableNames.length);
  });

  it("keeps tenant and lifecycle columns on the core persisted entities", () => {
    for (const [table, lifecycleColumn] of [
      [schema.notes, "createdAt"],
      [schema.learningCards, "createdAt"],
      [schema.evidences, "createdAt"],
      [schema.reviewAttempts, "createdAt"],
      [schema.jobs, "scheduledAt"],
    ] as const) {
      const columns = getTableColumns(table) as Record<string, unknown>;
      assert.ok(columns.id, `${getTableName(table)} must have id`);
      assert.ok(columns.workspaceId, `${getTableName(table)} must have workspaceId`);
      assert.ok(columns[lifecycleColumn], `${getTableName(table)} must have ${lifecycleColumn}`);
    }
  });

  it("exports PostgreSQL enum columns with non-empty values", () => {
    const enums = [
      schema.sourceStatusEnum,
      schema.evidenceAlignmentEnum,
      schema.validationOutcomeEnum,
      schema.cardStatusEnum,
      schema.jobStatusEnum,
      schema.artifactStatusEnum,
      schema.artifactTypeEnum,
      schema.reviewStatusEnum,
    ];
    for (const pgEnum of enums) {
      assert.ok(pgEnum.enumValues.length > 0);
      assert.equal(new Set(pgEnum.enumValues).size, pgEnum.enumValues.length);
    }
  });
});
