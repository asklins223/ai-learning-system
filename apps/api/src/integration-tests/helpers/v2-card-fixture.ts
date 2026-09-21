/**
 * V2 Card Fixture 助手——集成测试统一造数工具。
 *
 * 集成测试统一创建纯 V2 数据：
 * - learning_objectives_v2 + learning_objective_revisions_v2
 * - learning_cards_v2 + learning_card_publication_revisions_v2
 * - （可选）evidence_snapshots_v2 + evidence_eligibility_states_v2 +
 *   learning_objective_evidence_bindings_v2
 *
 * 用法：
 *   const seeded = await seedV2Fixture(sql, { /* options *\/ });
 *   // seeded = { workspaceId, userId, noteId, noteVersionId,
 *   //            objectiveId, objectiveRevisionId, cardId, cleanup }
 *   // 之后 createRunV2 可直接使用 objectiveId
 *
 * 设计原则（方案 24 §2.3）：
 * - 幂等（按客观存在的 objectiveId 复用）；
 * - 带 cleanup（DELETE ... WHERE workspace_id = ...）；
 * - 最小合法值（canonicalAnswer/scoringRubric/learningSupport 合法但非空）；
 * - 无 evidence binding 时 freezeTargetSnapshotV2 不会 fail（loadEvidenceClosure
 *   返回空数组）。
 */

import { randomUUID, randomBytes, createHash } from "node:crypto";
import type postgres from "postgres";
import type { ApiTransaction } from "../../db/client.ts";
import type { CreateRunV2Input } from "../../modules/learning-runs/run-service.ts";

/** Create a current V2 run and return the internal snapshot used by DB tests. */
export async function createLearningRunForTest(
  tx: ApiTransaction,
  input: CreateRunV2Input,
) {
  const { createRunV2, getRunPublicView } = await import("../../modules/learning-runs/run-service.ts");
  const result = await createRunV2(tx, input);
  return getRunPublicView(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    runId: result.runId,
  });
}

// ─── Session token 生成（与 identity/service.ts 一致）─────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 生成随机 session token 并插入 sessions 表（哈希存储）。
 * 返回明文 token，供 HTTP Authorization: Bearer 使用。
 */
async function createSessionToken(
  sql: postgres.Sql,
  userId: string,
  workspaceId: string,
): Promise<string> {
  const token = randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO sessions (token, user_id, workspace_id, created_at, expires_at)
      VALUES (${hashToken(token)}, ${userId}, ${workspaceId}, now(), ${expiresAt})`;
  });
  return token;
}

// ─── 类型 ─────────────────────────────────────────────────────────────

export interface V2FixtureOptions {
  /** 可选：指定 objectiveId（默认 randomUUID）。幂等复用。 */
  objectiveId?: string;
  /** 可选：指定 objectiveStatement（默认 "理解复利效应"）。 */
  objectiveStatement?: string;
  /** 可选：指定 publicSummary（默认 "复利效应"）。 */
  publicSummary?: string;
  /** 可选：指定 knowledgeForm（默认 "definition"）。 */
  knowledgeForm?: string;
  /** 可选：指定 strategy（默认 "recall"）。 */
  strategy?: string;
  /** 可可选：指定 cue/prompt 的 front（默认自动生成）。 */
  front?: { cue: string; prompt: string };
  /** 可选：覆盖 objective revision 的 canonicalAnswer JSON（默认 text 单元）。
   *  structured 规划（planV2Run）需要显式结构（mapping/ordered_steps）或
   *  非空 relations 才会产出结构化任务，否则回退 text。 */
  canonicalAnswerJson?: string;
}

export interface V2FixtureSeeded {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  cardId: string;
  /** Bearer token for HTTP inject tests（sessions 表已插入对应行）。 */
  token: string;
  cleanup: () => Promise<void>;
}

// ─── 助手常量 ────────────────────────────────────────────────────────

const SHA256_HEX = "f".repeat(64);
const TARGET_REVISION_HASH = "e".repeat(64);
const PRIVATE_PAYLOAD_HASH = "d".repeat(64);
const PRESENTATION_HASH = "c".repeat(64);
const PUBLIC_PAYLOAD_HASH = "b".repeat(64);
const REVEAL_PAYLOAD_HASH = "a".repeat(64);

const DEFAULT_CANONICAL_ANSWER = JSON.stringify({
  kind: "text",
  unit: { unitId: "u1", text: "复利效应是本金产生利息后加入本金继续生息的现象" },
});
const DEFAULT_LEARNING_SUPPORT = JSON.stringify({ explanation: "利息加入本金继续生息" });
const DEFAULT_SCORING_RUBRIC = JSON.stringify({
  version: 2,
  units: [{
    rubricUnitId: "fixture-rubric-u1",
    facet: "recall",
    criterion: "能准确回忆并说明目标知识点",
    required: true,
    answerUnitIds: ["u1"],
    evidenceRefIds: ["00000000-0000-4000-8000-000000000001"],
  }],
  passingPolicy: {
    requireAllRequiredUnits: true,
    allowContradiction: false,
  },
  rubricHash: "9".repeat(64),
});
// DEFAULT_FRONT removed: front is constructed inline from opts or defaults.

// ─── 主函数 ──────────────────────────────────────────────────────────

/**
 * 创建完整的 V2 Objective + Card fixture（模拟激活完成态）。
 *
 * 创建的数据：
 * 1. user + workspace + workspace_member
 * 2. note + note_version
 * 3. learning_objectives_v2（active）
 * 4. learning_objective_revisions_v2（revision 1）
 * 5. learning_cards_v2（active，objective_id 关联）
 * 6. learning_card_publication_revisions_v2（publication revision 1）
 *
 * 不创建 evidence bindings（freezeTargetSnapshotV2 的 loadEvidenceClosure
 * 在无 binding 时返回空数组，不 fail）。
 * 不创建 card_content_capability_state（readCardContentEpoch 默认返回 1）。
 */
// ─── 公共清理（按 workspace 全量清除；含不可变触发器受控旁路）─────────

/**
 * 按 workspace_id 清除全部相关业务数据（供各集成测试的 cleanup 复用）。
 * 事务级开启迁移 0180 的不可变触发器旁路，可安全删除追加-only 表。
 *
 * 必须同时设置 RLS 会话上下文：这些表对 ailearn_api 全部启用 RLS，缺少
 * app.workspace_id 时 DELETE 会静默删除 0 行（策略表达式为 NULL → 不可见），
 * 于是残留数据在跨套件运行中累积，并在删除父表（note_versions 等）时以
 * 外键冲突的形式爆出来。userId 之前只用于签名、从未使用。
 */
export async function cleanupWorkspaceTables(
  sql: postgres.Sql,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    // 不可变触发器受控旁路（迁移 0180）：仅本清理事务内放行对 V2 追加-only 表的 DELETE。
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM learning_target_snapshots_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_card_publication_revisions_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_card_revisions_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_cards_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objective_evidence_bindings_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM evidence_eligibility_states_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM evidence_snapshots_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_exposures_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM initial_validation_reminders_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM card_domain_events_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM card_exposure_ledger_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_run_events WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_run_action_ledger WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_run_idempotency WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM canonical_learning_event_outbox WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM practice_trail_event_outbox WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_run_processing_outbox WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM understanding_change_sets WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_assessments WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_artifacts WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_task_drafts WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_task_private_solutions WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_task_safety_reports WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_task_disclosure_profiles WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_task_variants WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_tasks WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_run_private_contracts WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_runs WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM card_generation_post_activation_consumptions WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM card_content_capability_state WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM assistant_deliveries WHERE workspace_id = ${workspaceId}`;
    // companion_messages.action_ref ↔ companion_action_proposals.source_message_id
    // 构成循环外键：先解除消息侧引用，再删 proposals → messages。
    await tx`UPDATE companion_messages SET action_ref = NULL WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_stream_events WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_turn_runs WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM onboarding_states WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM search_documents WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await tx`DELETE FROM users WHERE id = ${userId}`;
  });
}

export async function seedV2Fixture(
  sql: postgres.Sql,
  opts: V2FixtureOptions = {},
): Promise<V2FixtureSeeded> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const objectiveId = opts.objectiveId ?? randomUUID();
  const objectiveRevisionId = randomUUID();
  const cardId = randomUUID();

  const objectiveStatement = opts.objectiveStatement ?? "理解复利效应";
  const publicSummary = opts.publicSummary ?? "复利效应";
  const knowledgeForm = opts.knowledgeForm ?? "definition";
  const strategy = opts.strategy ?? "recall";
  const front = opts.front ?? { cue: "复利", prompt: "什么是复利效应？" };
  const canonicalAnswerJson = opts.canonicalAnswerJson ?? DEFAULT_CANONICAL_ANSWER;

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;

    // 1. user + workspace
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`v2fix-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id)
      VALUES (${workspaceId}, ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;

    // 2. note + note_version
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${workspaceId}, 'fixture-note', ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: objectiveStatement }] })},
        'fixture-hash', ${userId})`;

    // 3. learning_objectives_v2
    await tx`INSERT INTO learning_objectives_v2
      (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveId}, 'fixture:class', 'sem-id-v1',
              ${SHA256_HEX}, 'active', 1, ${objectiveRevisionId}, 1)`;

    // 4. learning_objective_revisions_v2
    await tx`INSERT INTO learning_objective_revisions_v2
      (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
       knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
       evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveRevisionId}, ${objectiveId}, 1,
              ${objectiveStatement}, ${publicSummary}, ${knowledgeForm}, ARRAY['recall'],
              ${canonicalAnswerJson}::jsonb,
              ${DEFAULT_LEARNING_SUPPORT}::jsonb,
              ${DEFAULT_SCORING_RUBRIC}::jsonb,
              '[]'::jsonb, '[]'::jsonb, ${SHA256_HEX}, ${TARGET_REVISION_HASH}, ${PRIVATE_PAYLOAD_HASH})`;

    // 5. learning_cards_v2
    await tx`INSERT INTO learning_cards_v2
      (id, workspace_id, card_id, objective_id, note_version_id, card_revision, current_publication_revision, lifecycle,
       front, public_summary, knowledge_form, strategy, presentation_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${cardId}, ${objectiveId}, ${noteVersionId},
              1, 1, 'active',
              ${tx.json(front)},
              ${publicSummary}, ${knowledgeForm}, ${strategy}, ${PRESENTATION_HASH})`;

    // 6. learning_card_publication_revisions_v2
    await tx`INSERT INTO learning_card_publication_revisions_v2
      (id, workspace_id, card_id, publication_revision, card_revision, objective_id, objective_revision,
       lifecycle_at_publication, public_payload_hash, reveal_payload_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${cardId}, 1, 1, ${objectiveId}, 1, 'active',
              ${PUBLIC_PAYLOAD_HASH}, ${REVEAL_PAYLOAD_HASH})`;
  });

  // 7. Session token（供 HTTP Bearer 测试用）
  const token = await createSessionToken(sql, userId, workspaceId);

  const cleanup = () => cleanupWorkspaceTables(sql, workspaceId, userId);

  return {
    workspaceId,
    userId,
    noteId,
    noteVersionId,
    objectiveId,
    objectiveRevisionId,
    cardId,
    token,
    cleanup,
  };
}

// ─── 向现有 workspace 追加 objective+card（用于多卡场景）──────────────

export interface V2AddObjectiveResult {
  objectiveId: string;
  objectiveRevisionId: string;
  cardId: string;
  noteId: string;
  noteVersionId: string;
}

/**
 * 向已有 workspace 追加一个 V2 Objective + Card。
 * 不创建 user/workspace（复用已有）；无独立 cleanup（由主 fixture 的 cleanup 按 workspace_id 清理）。
 */
export async function addV2ObjectiveToWorkspace(
  sql: postgres.Sql,
  workspaceId: string,
  userId: string,
  opts: V2FixtureOptions = {},
): Promise<V2AddObjectiveResult> {
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const objectiveId = opts.objectiveId ?? randomUUID();
  const objectiveRevisionId = randomUUID();
  const cardId = randomUUID();

  const objectiveStatement = opts.objectiveStatement ?? "理解复利效应";
  const publicSummary = opts.publicSummary ?? "复利效应";
  const knowledgeForm = opts.knowledgeForm ?? "definition";
  const strategy = opts.strategy ?? "recall";
  const front = opts.front ?? { cue: "复利", prompt: "什么是复利效应？" };
  const canonicalAnswerJson = opts.canonicalAnswerJson ?? DEFAULT_CANONICAL_ANSWER;

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;

    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${workspaceId}, 'fixture-note', ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: objectiveStatement }] })},
        'fixture-hash', ${userId})`;

    await tx`INSERT INTO learning_objectives_v2
      (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveId}, 'fixture:class', 'sem-id-v1',
              ${SHA256_HEX}, 'active', 1, ${objectiveRevisionId}, 1)`;

    await tx`INSERT INTO learning_objective_revisions_v2
      (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
       knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
       evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveRevisionId}, ${objectiveId}, 1,
              ${objectiveStatement}, ${publicSummary}, ${knowledgeForm}, ARRAY['recall'],
              ${canonicalAnswerJson}::jsonb,
              ${DEFAULT_LEARNING_SUPPORT}::jsonb,
              ${DEFAULT_SCORING_RUBRIC}::jsonb,
              '[]'::jsonb, '[]'::jsonb, ${SHA256_HEX}, ${TARGET_REVISION_HASH}, ${PRIVATE_PAYLOAD_HASH})`;

    await tx`INSERT INTO learning_cards_v2
      (id, workspace_id, card_id, objective_id, note_version_id, card_revision, current_publication_revision, lifecycle,
       front, public_summary, knowledge_form, strategy, presentation_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${cardId}, ${objectiveId}, ${noteVersionId},
              1, 1, 'active',
              ${tx.json(front)},
              ${publicSummary}, ${knowledgeForm}, ${strategy}, ${PRESENTATION_HASH})`;

    await tx`INSERT INTO learning_card_publication_revisions_v2
      (id, workspace_id, card_id, publication_revision, card_revision, objective_id, objective_revision,
       lifecycle_at_publication, public_payload_hash, reveal_payload_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${cardId}, 1, 1, ${objectiveId}, 1, 'active',
              ${PUBLIC_PAYLOAD_HASH}, ${REVEAL_PAYLOAD_HASH})`;
  });

  return {
    objectiveId,
    objectiveRevisionId,
    cardId,
    noteId,
    noteVersionId,
  };
}

// ─── 便捷：只创建 objective（不含 card，用于不需要 card 的场景）────────

export interface V2ObjectiveOnlySeeded {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  cleanup: () => Promise<void>;
}

/**
 * 只创建 V2 Objective（不含 Card），用于不需要 Card 的场景。
 * cleanup 同 seedV2Fixture。
 */
export async function seedV2ObjectiveOnly(
  sql: postgres.Sql,
  opts: V2FixtureOptions = {},
): Promise<V2ObjectiveOnlySeeded> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const objectiveId = opts.objectiveId ?? randomUUID();
  const objectiveRevisionId = randomUUID();

  const objectiveStatement = opts.objectiveStatement ?? "理解复利效应";
  const publicSummary = opts.publicSummary ?? "复利效应";
  const knowledgeForm = opts.knowledgeForm ?? "definition";
  const canonicalAnswerJson = opts.canonicalAnswerJson ?? DEFAULT_CANONICAL_ANSWER;

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;

    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`v2fix-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id)
      VALUES (${workspaceId}, ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;

    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${workspaceId}, 'fixture-note', ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: objectiveStatement }] })},
        'fixture-hash', ${userId})`;

    await tx`INSERT INTO learning_objectives_v2
      (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveId}, 'fixture:class', 'sem-id-v1',
              ${SHA256_HEX}, 'active', 1, ${objectiveRevisionId}, 1)`;

    await tx`INSERT INTO learning_objective_revisions_v2
      (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
       knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
       evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
      VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveRevisionId}, ${objectiveId}, 1,
              ${objectiveStatement}, ${publicSummary}, ${knowledgeForm}, ARRAY['recall'],
              ${canonicalAnswerJson}::jsonb,
              ${DEFAULT_LEARNING_SUPPORT}::jsonb,
              ${DEFAULT_SCORING_RUBRIC}::jsonb,
              '[]'::jsonb, '[]'::jsonb, ${SHA256_HEX}, ${TARGET_REVISION_HASH}, ${PRIVATE_PAYLOAD_HASH})`;
  });

  const cleanup = () => cleanupWorkspaceTables(sql, workspaceId, userId);

  return {
    workspaceId,
    userId,
    noteId,
    noteVersionId,
    objectiveId,
    objectiveRevisionId,
    cleanup,
  };
}
