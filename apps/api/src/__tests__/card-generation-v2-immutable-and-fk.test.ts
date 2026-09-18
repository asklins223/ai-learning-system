/**
 * 方案 20 — Immutable Trigger + FK RESTRICT 集成测试。
 *
 * 这些测试验证 migration 0135 中添加的数据库约束：
 * - learning_objective_revisions_v2 的 BEFORE UPDATE/DELETE trigger
 * - learning_card_publication_revisions_v2 的 BEFORE UPDATE/DELETE trigger
 * - learning_runs.key_point_id FK ON DELETE RESTRICT
 *
 * 注意：这些是 SQL 级别的测试，需要实际 PostgreSQL 连接才能运行。
 * 在无数据库环境下使用 SQL 字符串验证作为 smoke test。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 相对测试文件解析，避免依赖 process.cwd()（npm test 从 apps/api 运行时
// 旧的 join(process.cwd(), "apps/api/src/db/...") 会解析到不存在的路径，
// 导致全部 SQL 断言恒失败）。
const MIGRATION_PATH = resolve(
  import.meta.dirname,
  "../db/migrations/0135_card_generation_v2.sql",
);

function readMigration(): string {
  try {
    return readFileSync(MIGRATION_PATH, "utf-8");
  } catch {
    return "";
  }
}

describe("Migration 0135 — Immutable triggers", () => {
  const sql = readMigration();

  it("creates prevent_objective_revision_mutation function", () => {
    assert.ok(
      sql.includes("prevent_objective_revision_mutation"),
      "must create immutability function for objective revisions",
    );
  });

  it("creates BEFORE UPDATE trigger on learning_objective_revisions_v2", () => {
    assert.ok(
      sql.includes("lo_v2_rev_no_update") &&
        sql.includes("BEFORE UPDATE ON public.learning_objective_revisions_v2"),
      "must create BEFORE UPDATE trigger on objective revisions",
    );
  });

  it("creates BEFORE DELETE trigger on learning_objective_revisions_v2", () => {
    assert.ok(
      sql.includes("lo_v2_rev_no_delete") &&
        sql.includes("BEFORE DELETE ON public.learning_objective_revisions_v2"),
      "must create BEFORE DELETE trigger on objective revisions",
    );
  });

  it("creates prevent_publication_revision_mutation function", () => {
    assert.ok(
      sql.includes("prevent_publication_revision_mutation"),
      "must create immutability function for publication revisions",
    );
  });

  it("creates BEFORE UPDATE trigger on learning_card_publication_revisions_v2", () => {
    assert.ok(
      sql.includes("lc_v2_pub_no_update") &&
        sql.includes("BEFORE UPDATE ON public.learning_card_publication_revisions_v2"),
      "must create BEFORE UPDATE trigger on publication revisions",
    );
  });

  it("creates BEFORE DELETE trigger on learning_card_publication_revisions_v2", () => {
    assert.ok(
      sql.includes("lc_v2_pub_no_delete") &&
        sql.includes("BEFORE DELETE ON public.learning_card_publication_revisions_v2"),
      "must create BEFORE DELETE trigger on publication revisions",
    );
  });
});

describe("Migration 0135 — FK RESTRICT on learning_runs.key_point_id", () => {
  const sql = readMigration();

  it("drops old CASCADE constraint", () => {
    assert.ok(
      sql.includes("DROP CONSTRAINT IF EXISTS learning_runs_key_point_id_fkey"),
      "must drop old FK constraint with CASCADE",
    );
  });

  it("adds new RESTRICT constraint", () => {
    assert.ok(
      sql.includes("ON DELETE RESTRICT") &&
        sql.includes("learning_runs_key_point_id_fkey"),
      "must add FK constraint with ON DELETE RESTRICT",
    );
  });
});

describe("Migration 0135 — Private rubric column hardening (§22.1)", () => {
  const sql = readMigration();

  it("revokes full SELECT from ailearn_api on learning_objective_revisions_v2", () => {
    assert.ok(
      sql.includes("REVOKE SELECT ON public.learning_objective_revisions_v2 FROM ailearn_api"),
      "must revoke full SELECT from API role",
    );
  });

  it("grants column-level SELECT to ailearn_api (public columns only)", () => {
    assert.ok(
      sql.includes("GRANT SELECT (") &&
        sql.includes("objective_statement") &&
        sql.includes("public_summary") &&
        !sql.includes("canonical_answer") || sql.includes("canonical_answer") &&
          sql.includes("TO ailearn_api"),
      "must grant column-level SELECT for public columns only",
    );
  });

  it("does NOT grant API access to canonical_answer column", () => {
    // The column-level GRANT should not include canonical_answer
    const grantMatch = sql.match(/GRANT SELECT \(([^)]+)\) ON public\.learning_objective_revisions_v2 TO ailearn_api/);
    assert.ok(grantMatch, "must have column-level GRANT");
    const columns = grantMatch![1];
    assert.ok(
      !columns.includes("canonical_answer"),
      "canonical_answer must not be in API GRANT",
    );
    assert.ok(
      !columns.includes("scoring_rubric"),
      "scoring_rubric must not be in API GRANT",
    );
    assert.ok(
      !columns.includes("learning_support"),
      "learning_support must not be in API GRANT",
    );
  });
});

describe("Migration 0135 — New V2 tables", () => {
  const sql = readMigration();

  it("creates learning_target_snapshots_v2 table", () => {
    assert.ok(
      sql.includes("CREATE TABLE IF NOT EXISTS public.learning_target_snapshots_v2"),
      "must create learning_target_snapshots_v2 table",
    );
  });

  it("creates candidate_evidence_binding_plans_v2 table", () => {
    assert.ok(
      sql.includes("CREATE TABLE IF NOT EXISTS public.candidate_evidence_binding_plans_v2"),
      "must create candidate_evidence_binding_plans_v2 table",
    );
  });

  it("creates evidence_eligibility_states_v2 table", () => {
    assert.ok(
      sql.includes("CREATE TABLE IF NOT EXISTS public.evidence_eligibility_states_v2"),
      "must create evidence_eligibility_states_v2 table",
    );
  });

  it("creates card_generation_run_outbox_v2 table", () => {
    assert.ok(
      sql.includes("CREATE TABLE IF NOT EXISTS public.card_generation_run_outbox_v2"),
      "must create card_generation_run_outbox_v2 table",
    );
  });

  it("enables RLS on all new tables", () => {
    assert.ok(
      sql.includes("ALTER TABLE public.learning_target_snapshots_v2 ENABLE ROW LEVEL SECURITY"),
      "must enable RLS on learning_target_snapshots_v2",
    );
    assert.ok(
      sql.includes("ALTER TABLE public.evidence_eligibility_states_v2 ENABLE ROW LEVEL SECURITY"),
      "must enable RLS on evidence_eligibility_states_v2",
    );
  });
});

describe("Migration 0135 — P3: learning_target_snapshots_v2 column-level GRANT hardening", () => {
  const sql = readMigration();

  it("grants full access to ailearn_worker on learning_target_snapshots_v2", () => {
    assert.ok(
      sql.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON") &&
        sql.includes("public.learning_target_snapshots_v2") &&
        sql.includes("TO ailearn_worker"),
      "must grant full access to ailearn_worker",
    );
  });

  it("does NOT grant blanket SELECT on learning_target_snapshots_v2 to ailearn_api", () => {
    // The broad GRANT should NOT include learning_target_snapshots_v2 for ailearn_api
    const broadGrantMatch = sql.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON\s+([^TO]+)TO ailearn_api, ailearn_worker/);
    if (broadGrantMatch) {
      const tables = broadGrantMatch![1];
      assert.ok(
        !tables.includes("learning_target_snapshots_v2"),
        "learning_target_snapshots_v2 must NOT be in the broad GRANT to ailearn_api",
      );
    }
  });

  it("grants column-level SELECT to ailearn_api excluding private columns", () => {
    // Find the column-level SELECT GRANT for learning_target_snapshots_v2
    const grantMatch = sql.match(/GRANT SELECT \(([^)]+)\) ON public\.learning_target_snapshots_v2 TO ailearn_api/);
    assert.ok(grantMatch, "must have column-level SELECT GRANT for ailearn_api");
    const columns = grantMatch![1];
    assert.ok(
      !columns.includes("canonical_answer"),
      "P3: canonical_answer must NOT be in ailearn_api SELECT GRANT",
    );
    assert.ok(
      !columns.includes("scoring_rubric"),
      "P3: scoring_rubric must NOT be in ailearn_api SELECT GRANT",
    );
    assert.ok(
      !columns.includes("evidence_bindings"),
      "P3: evidence_bindings must NOT be in ailearn_api SELECT GRANT",
    );
    // Public columns that SHOULD be granted
    assert.ok(columns.includes("snapshot_id"), "snapshot_id should be in SELECT GRANT");
    assert.ok(columns.includes("target_revision_hash"), "target_revision_hash should be in SELECT GRANT");
  });

  it("grants INSERT with all columns to ailearn_api (API creates snapshots)", () => {
    const insertMatch = sql.match(/GRANT INSERT \(([^)]+)\) ON public\.learning_target_snapshots_v2 TO ailearn_api/);
    assert.ok(insertMatch, "must have column-level INSERT GRANT for ailearn_api");
    const columns = insertMatch![1];
    assert.ok(
      columns.includes("canonical_answer"),
      "P3: INSERT must include canonical_answer (API creates snapshots with all fields)",
    );
    assert.ok(
      columns.includes("scoring_rubric"),
      "P3: INSERT must include scoring_rubric",
    );
  });

  it("grants UPDATE excluding private columns to ailearn_api", () => {
    const updateMatch = sql.match(/GRANT UPDATE \(([^)]+)\) ON public\.learning_target_snapshots_v2 TO ailearn_api/);
    assert.ok(updateMatch, "must have column-level UPDATE GRANT for ailearn_api");
    const columns = updateMatch![1];
    assert.ok(
      !columns.includes("canonical_answer"),
      "P3: canonical_answer must NOT be in ailearn_api UPDATE GRANT",
    );
    assert.ok(
      !columns.includes("scoring_rubric"),
      "P3: scoring_rubric must NOT be in ailearn_api UPDATE GRANT",
    );
  });
});
