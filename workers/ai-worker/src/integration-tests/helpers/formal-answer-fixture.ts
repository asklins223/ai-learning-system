/**
 * 「这个人此刻正在正式作答某一题」的夹具（worker 侧两支集测共用）。
 *
 * 为什么抽出来：伴星的静音判据、实体解析的回填、暴露记账三处都读同一条形状
 * （run → active_task_id → variant(purpose='formal') → 冻结快照）。各造一份就会出现
 * "那一支撑得起、这一支撑不起"的假绿。目标/卡/修订这三张表也一起给：快照的
 * objective_id 与 card_id 都有外键，只造一半会当场报错。
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";

export interface FormalAnswerFixture {
  workspaceId: string;
  userId: string;
  otherUserId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  cardId: string;
  runId: string;
  taskId: string;
  taskPrompt: string;
  canonicalAnswer: string;
  publicSummary: string;
  cleanup: () => Promise<void>;
}

export async function seedFormalAnswerRun(
  sql: postgres.Sql,
  overrides: { taskPrompt?: string; canonicalAnswer?: string; publicSummary?: string } = {},
): Promise<FormalAnswerFixture> {
  const tag = randomUUID().slice(0, 8);
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const objectiveId = randomUUID();
  const objectiveRevisionId = randomUUID();
  const cardId = randomUUID();
  const runId = randomUUID();
  const taskId = randomUUID();
  const taskPrompt = overrides.taskPrompt
    ?? "某表有一百万行，status 列只有 3 个不同取值，created_at 几乎每行都不同：给哪一列建索引";
  const canonicalAnswer = overrides.canonicalAnswer ?? "给 created_at 建索引，因为它的选择性高";
  const publicSummary = overrides.publicSummary ?? "索引的选择性";

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES
      (${userId}, ${`fa-owner-${tag}@x.test`}, 'h', 'owner'),
      (${otherUserId}, ${`fa-other-${tag}@x.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES
      (${workspaceId}, ${`fa-${tag}`}, ${userId}, 'collaborative')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      (${workspaceId}, ${userId}, 'owner'),
      (${workspaceId}, ${otherUserId}, 'member')`;

    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, ${`索引笔记-${tag}`}, ${userId})`;
    const noteVersionId = randomUUID();
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${noteVersionId}, (SELECT id FROM notes WHERE workspace_id = ${workspaceId} LIMIT 1),
              ${workspaceId}, 1, '{}'::jsonb, ${`h-${tag}`}, ${userId})`;

    await tx`INSERT INTO learning_objectives_v2
      (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveId}, 'fa:class', 'sem-id-v1',
              ${"f".repeat(64)}, 'active', 1, ${objectiveRevisionId}, 1)`;
    await tx`INSERT INTO learning_objective_revisions_v2
      (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
       knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
       evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveRevisionId}, ${objectiveId}, 1,
              ${publicSummary}, ${publicSummary}, 'definition', ARRAY['recall'],
              ${tx.json({ kind: "text", unit: { unitId: "u1", text: canonicalAnswer } })},
              ${tx.json({ explanation: "选择性 = 不同值数 / 总行数" })},
              ${tx.json({ version: 2, units: [] })}, '[]'::jsonb, '[]'::jsonb,
              ${"f".repeat(64)}, ${"e".repeat(64)}, ${"d".repeat(64)})`;
    await tx`INSERT INTO learning_cards_v2
      (id, workspace_id, card_id, objective_id, note_version_id, card_revision, current_publication_revision,
       lifecycle, front, public_summary, knowledge_form, strategy, presentation_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${cardId}, ${objectiveId}, ${noteVersionId}, 1, 1, 'active',
              ${tx.json({ cue: publicSummary, prompt: taskPrompt })},
              ${publicSummary}, 'definition', 'recall', ${"c".repeat(64)})`;

    await tx`INSERT INTO learning_runs
      (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase, active_task_id)
      VALUES (${runId}, ${workspaceId}, ${userId},
              ${tx.json({ kind: "card", cardId, objectiveId })},
              ${tx.json({ kind: "card", cardId, objectiveId })},
              ${"a".repeat(64)}, 'stabilize', 'active', ${taskId})`;
    await tx`INSERT INTO learning_tasks
      (id, run_id, workspace_id, user_id, sequence, intent, prompt, target_summary, hint_levels, status, revision)
      VALUES (${taskId}, ${runId}, ${workspaceId}, ${userId}, 1, 'recall', ${taskPrompt},
              ${publicSummary}, 3, 'active', 1)`;
    await tx`INSERT INTO learning_task_variants
      (id, task_id, workspace_id, user_id, purpose, template_trust_ceiling, estimated_active_seconds,
       interaction, public_payload_hash, input_schema_hash, disclosure_profile_hash, alternatives,
       revision, status, private_solution_hash, safety_report_hash, rubric_target_ids)
      VALUES (${randomUUID()}, ${taskId}, ${workspaceId}, ${userId}, 'formal', 'formal', 60,
              ${tx.json({ type: "text" })}, ${"b".repeat(64)}, ${"9".repeat(64)}, ${"8".repeat(64)},
              '[]'::jsonb, 1, 'active', ${"7".repeat(64)}, ${"6".repeat(64)}, '[]'::jsonb)`;
    await tx`INSERT INTO learning_target_snapshots_v2
      (workspace_id, snapshot_id, run_id, objective_id, objective_revision_id, objective_revision,
       semantic_target_fingerprint, target_revision_hash, semantic_identity_class_id,
       semantic_identity_policy_version, objective_lifecycle_epoch, card_content_epoch,
       canonical_answer, scoring_rubric, preferred_intents, snapshot_hash, target, card_id, card_revision)
      VALUES (${workspaceId}, ${randomUUID()}, ${runId}, ${objectiveId}, ${objectiveRevisionId}, 1,
              ${"f".repeat(64)}, ${"e".repeat(64)}, 'fa:class', 'sem-id-v1', 1, 1,
              ${tx.json({ kind: "text", unit: { unitId: "u1", text: canonicalAnswer } })},
              ${tx.json({ version: 2, units: [] })}, ARRAY['recall'], ${"b".repeat(64)},
              ${tx.json({ objectiveId, cardId, objectiveRevision: 1, publicSummary })},
              ${cardId}, 1)`;
  });

  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      // 追加-only 表（迁移 0180 的触发器）在清理事务内受控放行。
      await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
      await tx`DELETE FROM learning_exposures_v2 WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_target_snapshots_v2 WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_variants WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_tasks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_runs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_cards_v2 WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_stream_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_turn_runs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id IN (${userId}, ${otherUserId})`;
    });
  };

  return {
    workspaceId, userId, otherUserId, objectiveId, objectiveRevisionId, cardId, runId, taskId,
    taskPrompt, canonicalAnswer, publicSummary, cleanup,
  };
}
