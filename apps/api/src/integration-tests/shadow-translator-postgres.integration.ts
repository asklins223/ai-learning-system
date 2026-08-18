/**
 * Shadow Translator 对账（§16.2 P2 Gate：shadow projection 对账 100%）。
 *
 * 真实 DB 集成：造旧事实（validation_point_assessments correct / review_attempts
 * completed）→ translator 确定性映射 → 与 canonical outbox 对账（无冲突；
 * 未迁移事实 pending 计数；已由新 Commit 发布时 matched）。
 *
 * V2 rebase：使用 seedV2Fixture 创建 learning_objectives_v2 + learning_cards_v2，
 * 旧 V1 表（learning_cards / card_key_points）不再使用。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { runShadowReconciliation, translateLegacyFactId } = await import(
  "../modules/learning-runs/shadow-translator.ts"
);

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

test("shadow translator：确定性映射 + 对账（旧事实 pending；新 Commit 匹配；无冲突）", async () => {
  const fixture = await seedV2Fixture(sql);
  const { workspaceId, userId } = fixture;
  const runId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    // 旧事实：1 条 covered AI 评估 + 1 条非 covered（不映射）。
    const sub1 = randomUUID();
    const sub2 = randomUUID();
    const questionId = randomUUID();
    const rubricId = randomUUID();
    await tx`INSERT INTO validation_questions (id, workspace_id, question_type, question, created_by)
             VALUES (${questionId}, ${workspaceId}, 'open', 'q', ${userId})`;
    await tx`INSERT INTO validation_submissions (id, workspace_id, user_id, question_id, context, start_idempotency_key, status)
             VALUES (${sub1}, ${workspaceId}, ${userId}, ${questionId}, 'ctx', ${`idem-${sub1}`}, 'completed'),
                    (${sub2}, ${workspaceId}, ${userId}, ${questionId}, 'ctx', ${`idem-${sub2}`}, 'completed')`;
    await tx`INSERT INTO validation_question_rubric_items (id, workspace_id, question_id, ordinal, criterion, expected_concept)
             VALUES (${rubricId}, ${workspaceId}, ${questionId}, 1, 'criterion', 'concept')`;
    await tx`INSERT INTO validation_point_assessments (id, workspace_id, user_id, submission_id, rubric_item_id, verdict, assessment_source, confidence)
             VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${sub1}, ${rubricId}, 'covered', 'ai', 90),
                    (${randomUUID()}, ${workspaceId}, ${userId}, ${sub2}, ${rubricId}, 'missing', 'ai', 10)`;
    // 最小 legacy Run 行（canonical outbox 的 FK 目标）。
    await tx`INSERT INTO learning_runs
             (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase, time_budget_seconds, planned_active_seconds, created_at, updated_at)
             VALUES (${runId}, ${workspaceId}, ${userId}, '{}'::jsonb, '{}'::jsonb, 'legacy-fp', 'stabilize', 'completed', 180, 180, now(), now())`;
  });

  try {
    const scope = { workspaceId, userId };
    // 确定性：同一 factId 恒得同一 canonicalEventId。
    const factId = randomUUID();
    assert.equal(
      translateLegacyFactId("validation_point_assessment", factId),
      translateLegacyFactId("validation_point_assessment", factId),
    );
    assert.notEqual(
      translateLegacyFactId("validation_point_assessment", factId),
      translateLegacyFactId("review_attempt", factId),
    );

    const report = await withWorkspaceTransaction(scope, (tx) =>
      runShadowReconciliation(tx, workspaceId),
    );
    // 仅 1 条 correct 事实映射（incorrect 不映射）；无 envelope → pending。
    assert.equal(report.translatedFacts, 1);
    assert.equal(report.matchedEnvelopes, 0);
    assert.equal(report.pendingFacts, 1);
    assert.equal(report.conflicts, 0);
    assert.equal(report.reconciled, true);

    // 模拟 cutover：新 Commit 发布 translator 同 id 的 envelope → matched 且
    // 无冲突（唯一约束证明同一 logical commit 单一路径）。
    const canonicalEventId = translateLegacyFactId(
      "validation_point_assessment",
      String(
        (await sql`SELECT id::text FROM validation_point_assessments WHERE workspace_id = ${workspaceId} AND verdict = 'covered' LIMIT 1`)[0].id,
      ),
    );
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO canonical_learning_event_outbox
               (commit_id, canonical_event_id, workspace_id, user_id, run_id, envelope, status)
               VALUES (${randomUUID()}, ${canonicalEventId}, ${workspaceId}, ${userId}, ${runId}, '{}'::jsonb, 'pending')`;
    });
    const report2 = await withWorkspaceTransaction(scope, (tx) =>
      runShadowReconciliation(tx, workspaceId),
    );
    assert.equal(report2.matchedEnvelopes, 1);
    assert.equal(report2.pendingFacts, 0);
    assert.equal(report2.conflicts, 0);
    assert.equal(report2.reconciled, true, "同一 logical commit 未双路径发布");
  } finally {
    await fixture.cleanup();
  }
});
