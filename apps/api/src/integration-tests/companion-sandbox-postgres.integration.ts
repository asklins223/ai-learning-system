/**
 * P6 sandbox 纵切集成测试（真实 postgres，文档 16 §16.4 / E02 断言）。
 *
 * 覆盖：journey sandbox 分支创建 namespace（24h TTL）→ onboarding sandbox
 * 创建 Run（namespace 校验 + no_effect(sandbox) 授权 + run 行带 namespace）
 * → declared_unable 提交 → commit 防火墙：sandbox trail（scope=sandbox +
 * TTL）、0 canonical envelope、0 official schedule → 负向：无 namespace /
 * 过期 namespace / 他人 namespace 创建 sandbox Run 均拒绝。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/companion-sandbox-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRun, submitArtifact } = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick, closeStructuredSolutionSql } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);
const {
  applyInvitationAction,
  bootstrapJourney,
} = await import("../modules/companion-journey/journey-service.ts");

after(async () => {
  await sql.end({ timeout: 2 });
  await closeStructuredSolutionSql();
  await closeDatabase();
});

async function seed() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`sb-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'sb-ws', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch)
             VALUES (${noteId}, ${workspaceId}, 'note', ${userId}, now(), now(), 'placeholder', 0)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at)
             VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, '{}', ${userId}, now(), 'nh-1', now())`;
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at)
             VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', '{"version":1}', now(), now())`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
             VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, '遗忘曲线表明复习间隔决定长期记忆', '间隔重复能显著降低遗忘率。')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM practice_trail_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM canonical_learning_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_sandbox_namespaces WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_journey_pending_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_journeys WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_account_invitations WHERE user_id = ${userId}`;
      await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_processing_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_assessments WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_artifacts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_private_solutions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_safety_reports WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_disclosure_profiles WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_variants WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_tasks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_private_contracts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_action_ledger WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_run_idempotency WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_runs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, cardId, keyPointId, cleanup };
}

async function startSandboxJourney(scope: { workspaceId: string; userId: string }): Promise<string> {
  const now = new Date();
  const boot0 = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
  await sql`UPDATE companion_account_invitations SET status='offered', offered_at=now(), revision=${boot0.invitation.revision + 1} WHERE user_id=${scope.userId}`;
  await withWorkspaceTransaction(scope, (tx) =>
    applyInvitationAction(tx, scope, {
      expectedRevision: boot0.invitation.revision + 1,
      action: { kind: "start_journey", workspaceId: scope.workspaceId, branch: "sandbox_sample" },
      idempotencyKey: "sb-start-1",
    }, now),
  );
  const boot = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
  const namespaceId = boot.journey?.refs.sandboxNamespaceId;
  assert.ok(namespaceId, "sandbox journey 绑定 namespace");
  return namespaceId!;
}

test("P6 sandbox 纵切（E02 核心断言）：sandbox Run → sandbox trail、0 canonical、0 official schedule", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const namespaceId = await startSandboxJourney(scope);

    // onboarding sandbox 创建 Run：namespace 校验通过 + no_effect(sandbox) 授权。
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: {
            kind: "onboarding",
            sampleMode: "sandbox",
            keyPointId: seeded.keyPointId,
            sandboxNamespaceId: namespaceId,
          },
          goal: "stabilize",
          clientRequestId: "sb-run-1",
          idempotencyKey: "sb-run-create-1",
        },
      }),
    );
    assert.equal(run.schedulePolicySummary.kind, "no_schedule_effect");
    assert.equal(
      (run.schedulePolicySummary as { reasonCode?: string }).reasonCode,
      "sandbox",
    );

    // declared_unable 提交 → tick → sandbox 结算。
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
          idempotencyKey: "sb-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`sb-worker:${randomUUID()}`, 10);
    }

    // E02：0 canonical envelope、0 official schedule、sandbox trail + TTL。
    const envelopeCount = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(envelopeCount[0].n, 0);
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0);
    const trailRows = await sql`
      SELECT scope, event FROM practice_trail_event_outbox WHERE run_id = ${run.runId}
    `;
    assert.equal(trailRows.length, 1);
    assert.equal(trailRows[0].scope, "sandbox");
    const event = trailRows[0].event as { expiresAt?: string | null; reasons?: string[] };
    assert.ok(event.expiresAt, "sandbox trail 带 TTL");
    assert.deepEqual(event.reasons, ["sandbox"]);
    const runRow = await sql`
      SELECT phase, result, sandbox_namespace_id FROM learning_runs WHERE id = ${run.runId}
    `;
    assert.equal(runRow[0].phase, "completed");
    assert.equal(runRow[0].sandbox_namespace_id, namespaceId);
    const result = runRow[0].result as { outcome?: string; scheduleImpact?: { reasonCode?: string } };
    assert.equal(result.outcome, "practice_completed");
    assert.equal(result.scheduleImpact?.reasonCode, "sandbox");
  } finally {
    await seeded.cleanup();
  }
});

test("P6 sandbox 负向：无 namespace / 他人 namespace / 过期 namespace 创建 sandbox Run 均拒绝", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const namespaceId = await startSandboxJourney(scope);

    // 无 namespace → 拒绝。
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) =>
        createRun(tx, {
          ...scope,
          request: {
            version: 1,
            origin: { kind: "onboarding", sampleMode: "sandbox", keyPointId: seeded.keyPointId },
            goal: "stabilize",
            clientRequestId: "sb-neg-1",
            idempotencyKey: "sb-neg-create-1",
          },
        }),
      ),
      (err: unknown) => (err as { code?: string }).code === "context_stale",
    );

    // 他人 namespace（随机 uuid）→ 拒绝。
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) =>
        createRun(tx, {
          ...scope,
          request: {
            version: 1,
            origin: { kind: "onboarding", sampleMode: "sandbox", keyPointId: seeded.keyPointId, sandboxNamespaceId: randomUUID() },
            goal: "stabilize",
            clientRequestId: "sb-neg-2",
            idempotencyKey: "sb-neg-create-2",
          },
        }),
      ),
      (err: unknown) => (err as { code?: string }).code === "context_stale",
    );

    // 过期 namespace → 拒绝。
    await sql`UPDATE companion_sandbox_namespaces SET expires_at = now() - interval '1 hour' WHERE id = ${namespaceId}`;
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) =>
        createRun(tx, {
          ...scope,
          request: {
            version: 1,
            origin: { kind: "onboarding", sampleMode: "sandbox", keyPointId: seeded.keyPointId, sandboxNamespaceId: namespaceId },
            goal: "stabilize",
            clientRequestId: "sb-neg-3",
            idempotencyKey: "sb-neg-create-3",
          },
        }),
      ),
      (err: unknown) => (err as { code?: string }).code === "context_stale",
    );

    // 退出（exited）namespace → 拒绝（journey skip 联动后）。
    await sql`UPDATE companion_sandbox_namespaces SET status='exited', exited_at=now() WHERE id = ${namespaceId}`;
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) =>
        createRun(tx, {
          ...scope,
          request: {
            version: 1,
            origin: { kind: "onboarding", sampleMode: "sandbox", keyPointId: seeded.keyPointId, sandboxNamespaceId: namespaceId },
            goal: "stabilize",
            clientRequestId: "sb-neg-4",
            idempotencyKey: "sb-neg-create-4",
          },
        }),
      ),
      (err: unknown) => (err as { code?: string }).code === "context_stale",
    );
  } finally {
    await seeded.cleanup();
  }
});
