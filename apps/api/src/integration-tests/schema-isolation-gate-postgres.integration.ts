/**
 * 空间隔离 schema 棘轮（ratchet）。
 *
 * 背景：`workspace_id` 目前基本只是一个约定——96 张带该列的表里只有 7 张真的有指向
 * `workspaces` 的外键；19 张表的 RLS 自 `0027_sec01_rls_expansion_failsafe.sql` 起
 * 处于 DISABLE（策略在但不生效）。在这个前提下，任何一处漏写 `WHERE workspace_id`
 * 的查询都没有任何东西会拦住它，而既有的"隔离测试"是源码字符串 grep，也不会拦。
 *
 * 一次性补齐 89 个外键不现实（会锁表、且要先清孤儿数据），所以这里做**棘轮**：
 * 把当前违规集合如实登记为基线，然后要求实际集合与基线**完全相等**。
 *   - 新增一张表漏掉外键或 RLS → 变红，必须当场补上（或显式写进基线并说明理由）；
 *   - 修好一张却没从基线里删 → 也变红，保证基线只减不增、不会烂掉。
 *
 * 真实 Postgres；用受限角色（ailearn_api，NOBYPASSRLS）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——schema 棘轮要求真实 Postgres");
}

const sql = postgres(CONN, { max: 2 });

/** 有 workspace_id 列、但没有指向 workspaces 外键的表。只能缩小，不能增长。 */
const BASELINE_WITHOUT_FK = [
  "ai_artifacts", "ai_audit_log", "assistant_deliveries", "assistant_memory_embeddings",
  "assistant_memory_items", "assistant_page_contexts", "candidate_evidence_binding_plans_v2",
  "canonical_learning_event_outbox", "card_activation_receipts_v2", "card_candidate_feedback_v2",
  "card_candidate_quality_reports_v2", "card_content_capability_state", "card_domain_events_v2",
  "card_exposure_ledger_v2", "card_generation_candidates_v2", "card_generation_events_v2",
  "card_generation_input_snapshots_v2", "card_generation_plans_v2",
  "card_generation_post_activation_consumptions", "card_generation_run_outbox_v2",
  "card_generation_runs_v2", "card_generation_semantic_specs_v2", "companion_action_proposals",
  "companion_agent_steps", "companion_agent_tool_calls", "companion_audit",
  "companion_daily_summaries", "companion_invitation_ledger", "companion_journey_pending_events",
  "companion_journeys", "companion_messages", "companion_proactive_deliveries",
  "companion_room_profiles", "companion_sandbox_namespaces", "companion_stream_events",
  "companion_turn_runs", "companion_voice_artifacts", "conversation_summaries",
  "evidence_eligibility_states_v2", "evidence_redactions_v2", "evidence_snapshots_v2",
  "initial_validation_reminders_v2", "learning_activity_leases", "learning_artifacts",
  "learning_assessments", "learning_card_publication_revisions_v2", "learning_card_revisions_v2",
  "learning_cards_v2", "learning_exposures_v2", "learning_metric_events",
  "learning_objective_equivalence_reports_v2", "learning_objective_evidence_bindings_v2",
  "learning_objective_lineage_v2", "learning_objective_origins_v2",
  "learning_objective_revision_equivalence_v2", "learning_objective_revisions_v2",
  "learning_objectives_v2", "learning_run_action_ledger", "learning_run_events",
  "learning_run_idempotency", "learning_run_private_contracts", "learning_run_processing_outbox",
  "learning_runs", "learning_target_snapshots_v2", "learning_task_disclosure_profiles",
  "learning_task_drafts", "learning_task_presentation_history", "learning_task_private_solutions",
  "learning_task_safety_reports", "learning_task_variants", "learning_tasks", "memory_links",
  "memory_usage_log", "note_blocks", "note_image_assets", "note_versions", "notes",
  "pet_profiles", "practice_trail_event_outbox", "review_schedules", "search_documents",
  "semantic_support_reports_v2", "source_segments", "sources", "understanding_change_sets",
  "understanding_projection_checkpoints", "understanding_route_plans", "user_learning_preferences",
  "validation_assistance_exposures",
];

/**
 * 有 workspace_id 列、但 RLS 未启用的表。
 * 批次 3 已重开 `review_schedules`（迁移 0241），它已从下面这份基线里删掉；
 * 谁再把它关回去，棘轮就会红。剩下的都是还没轮到 RLS 的表。
 */
const BASELINE_WITHOUT_RLS = [
  "ai_artifacts", "ai_audit_log", "invite_codes", "jobs", "note_blocks", "note_versions",
  "notes", "onboarding_states", "search_documents", "sessions",
  "source_segments", "sources", "workspace_members",
];

after(async () => {
  await sql.end({ timeout: 5 }).catch(() => {});
});

/** 带 workspace_id 列的 public 表，附带两个布尔判定列。 */
async function queryWorkspaceTables(): Promise<Array<{ name: string; has_fk: boolean; rls_on: boolean }>> {
  return sql`
    SELECT c.relname AS name,
      EXISTS (
        SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = c.oid AND k.contype = 'f'
          AND k.confrelid = 'workspaces'::regclass
      ) AS has_fk,
      c.relrowsecurity AS rls_on
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    GROUP BY c.relname, c.oid, c.relrowsecurity
    ORDER BY c.relname
  `;
}

function diffSets(baseline: string[], actual: string[]) {
  const base = new Set(baseline);
  const now = new Set(actual);
  return {
    added: actual.filter((name) => !base.has(name)),
    removed: baseline.filter((name) => !now.has(name)),
  };
}

test("带 workspace_id 的表缺外键的集合必须与基线完全相等", async () => {
  const tables = await queryWorkspaceTables();
  const actual = tables.filter((row) => !row.has_fk).map((row) => row.name);
  const { added, removed } = diffSets(BASELINE_WITHOUT_FK, actual);
  assert.deepEqual(
    added,
    [],
    `以下新表带 workspace_id 却没有指向 workspaces 的外键：${added.join(", ")}。` +
      `请补 FK（ON DELETE 语义要显式决定），不要加进基线绕过。`,
  );
  assert.deepEqual(
    removed,
    [],
    `以下表已经补上外键了：${removed.join(", ")}。把基线里的对应条目删掉，棘轮只能缩小。`,
  );
});

test("带 workspace_id 的表 RLS 未启用的集合必须与基线完全相等", async () => {
  const tables = await queryWorkspaceTables();
  const actual = tables.filter((row) => !row.rls_on).map((row) => row.name);
  const { added, removed } = diffSets(BASELINE_WITHOUT_RLS, actual);
  assert.deepEqual(
    added,
    [],
    `以下新表带 workspace_id 却没有启用 RLS：${added.join(", ")}。新表应当直接达标。`,
  );
  assert.deepEqual(
    removed,
    [],
    `以下表已启用 RLS：${removed.join(", ")}。把基线里的对应条目删掉。`,
  );
});

test("任何启用 RLS 的表都必须至少有一条策略（与 roles.sql 的 fail-closed 检查同义）", async () => {
  const rows = await sql`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      )
    ORDER BY c.relname
  `;
  assert.deepEqual(
    rows.map((row) => String(row.name)),
    [],
    "有 RLS 但无策略 = 对非属主角色全表拒绝，会让应用静默查不到数据",
  );
});

test("基线本身不得含重复项（重复会让 diff 失真）", () => {
  for (const [label, list] of [
    ["BASELINE_WITHOUT_FK", BASELINE_WITHOUT_FK],
    ["BASELINE_WITHOUT_RLS", BASELINE_WITHOUT_RLS],
  ] as const) {
    const dupes = list.filter((name, i) => list.indexOf(name) !== i);
    assert.deepEqual([...new Set(dupes)], [], `${label} 有重复条目：${dupes.join(", ")}`);
  }
});
