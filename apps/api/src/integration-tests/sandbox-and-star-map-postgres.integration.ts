/**
 * P6 sandbox 隔离纵切（文档 16 §16.4 Gate：sandbox 0 canonical/schedule/star-map
 * 副作用）+ P7 star_map 入口真实接入（基线 checkpoint 校验）。
 *
 * 真实 DB 集成。sandbox Run：onboarding(sampleMode=sandbox) + 有效 namespace →
 * 结算 0 canonical envelope / 0 review_schedules；namespace 过期/缺失 → 409
 * fail closed；star_map origin 有效基线可创建（stale 基线 409）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRun, submitArtifact } = await import("../modules/learning-runs/run-service.ts");
const { runLearningRunProcessingTick } = await import("../modules/learning-runs/run-processing-tick.ts");
const { issueCheckpointToken } = await import("../modules/understanding/projection-checkpoint.ts");

// 基线 checkpoint 需服务端密钥；测试进程无密钥时 issue 返回 null → star_map
// 分支会 409。dev 默认无 PROJECTION_CHECKPOINT_SECRET——测试内设置。
process.env.PROJECTION_CHECKPOINT_SECRET ??= "test-projection-secret-min-16-chars";

after(async () => {
  await sql.end({ timeout: 2 });
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
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`sb-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'sb-ws', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch) VALUES (${noteId}, ${workspaceId}, 'note', ${userId}, now(), now(), 'placeholder', 0)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at) VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, '{}', ${userId}, now(), 'nh', now())`;
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at) VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', '{"version":1}', now(), now())`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text) VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, '遗忘曲线', '间隔重复。')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM learning_run_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_artifacts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_assessments WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_private_solutions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_task_variants WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_tasks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM canonical_learning_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM practice_trail_event_outbox WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_runs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_sandbox_namespaces WHERE workspace_id = ${workspaceId}`;
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

test("P6 Gate：sandbox Run 结算 0 canonical/0 schedule；过期 namespace 409 fail closed", async () => {
  const seeded = await seed();
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  try {
    // 有效 sandbox namespace（active + 未过期）。
    const namespaceId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`INSERT INTO companion_sandbox_namespaces (id, workspace_id, user_id, status, expires_at, created_at, updated_at)
               VALUES (${namespaceId}, ${seeded.workspaceId}, ${seeded.userId}, 'active', now() + interval '1 hour', now(), now())`;
    });

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
          clientRequestId: "sb-1",
          idempotencyKey: "sb-create-1",
        },
      }),
    );
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
    const envelopeRows = await sql`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE workspace_id = ${seeded.workspaceId}
    `;
    const schedRows = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(envelopeRows[0].n, 0, "sandbox 0 canonical envelope");
    assert.equal(schedRows[0].n, 0, "sandbox 0 review schedule");

    // 过期 namespace → 409 fail closed。
    const expiredNs = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`INSERT INTO companion_sandbox_namespaces (id, workspace_id, user_id, status, expires_at, created_at, updated_at)
               VALUES (${expiredNs}, ${seeded.workspaceId}, ${seeded.userId}, 'active', now() - interval '1 minute', now(), now())`;
    });
    await assert.rejects(
      () => withWorkspaceTransaction(scope, async (tx) =>
        createRun(tx, {
          ...scope,
          request: {
            version: 1,
            origin: {
              kind: "onboarding",
              sampleMode: "sandbox",
              keyPointId: seeded.keyPointId,
              sandboxNamespaceId: expiredNs,
            },
            goal: "stabilize",
            clientRequestId: "sb-2",
            idempotencyKey: "sb-create-2",
          },
        })),
      /沙箱教学空间不存在或已过期/,
      "过期 namespace 拒绝",
    );
  } finally {
    await seeded.cleanup();
  }
});

test("P7：star_map origin 有效基线可创建；伪造基线 409 fail closed", async () => {
  const seeded = await seed();
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  try {
    // 有效基线（当前无最新 checkpoint → watermarkBehind=false 通过）。
    const token = issueCheckpointToken({
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
      lastCanonicalEventId: null,
      lastPracticeEventId: null,
      capturedAt: new Date().toISOString(),
    });
    assert.ok(token, "测试密钥下应能签发 checkpoint token");

    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createRun(tx, {
        ...scope,
        request: {
          version: 1,
          origin: {
            kind: "star_map",
            keyPointId: seeded.keyPointId,
            lens: "current_target",
            filter: { showArchived: false, cardId: seeded.cardId },
            baselineCheckpoint: {
              version: 1,
              workspaceId: seeded.workspaceId,
              userId: seeded.userId,
              token,
              capturedAt: new Date().toISOString(),
            },
          },
          goal: "stabilize",
          clientRequestId: "sm-1",
          idempotencyKey: "sm-create-1",
        },
      }),
    );
    assert.ok(run.runId, "star_map 入口已接入（有效基线可创建 Run）");
    assert.equal(run.returnTarget.kind, "star_map");

    // 伪造基线（篡改 token）→ 409 fail closed。
    await assert.rejects(
      () => withWorkspaceTransaction(scope, async (tx) =>
        createRun(tx, {
          ...scope,
          request: {
            version: 1,
            origin: {
              kind: "star_map",
              keyPointId: seeded.keyPointId,
              lens: "current_target",
              filter: { showArchived: false, cardId: seeded.cardId },
              baselineCheckpoint: {
                version: 1,
                workspaceId: seeded.workspaceId,
                userId: seeded.userId,
                token: `${token.slice(0, -4)}tampered`,
                capturedAt: new Date().toISOString(),
              },
            },
            goal: "stabilize",
            clientRequestId: "sm-2",
            idempotencyKey: "sm-create-2",
          },
        })),
      /checkpoint/,
      "伪造基线拒绝",
    );
  } finally {
    await seeded.cleanup();
  }
});
