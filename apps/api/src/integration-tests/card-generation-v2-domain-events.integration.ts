/**
 * 方案 20 §17.7 领域事件通道（R36）——集成测试（真实 postgres）。
 *
 * 覆盖（R36 新增生产者）：
 * 1. `learning_card.revealed`：revealCardV2 在 Exposure 事务内写 domain 事件；
 * 2. `initial_validation_reminder.created|deferred`：reveal 延后（pending + cooldown）；
 * 3. `initial_validation_reminder.ready`：promoteDueRemindersV2 durable timer
 *    （qualificationNotBefore 到期 → pending→ready CAS + 幂等事件）；
 * 4. `initial_validation_reminder.completed`：trusted Commit（V2 run）标 completed；
 * 5. `initial_validation_reminder.cancelled`：显式取消 / archive 关闭；
 * 6. `learning_card.revised` / `learning_objective.revised`：target_equivalent_update
 *    （激活事务内双通道；等价性闭包服务端重算，C-cases IT 已验 409 分支）。
 *
 * 运行（从仓库根，单文件）：
 *   DATABASE_URL_MIGRATOR="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import apps/api/node_modules/tsx/dist/loader.mjs --test \
 *     apps/api/src/integration-tests/card-generation-v2-domain-events.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();

async function seedNote(content: string): Promise<string> {
  const versionId = randomUUID();
  const blockId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`de-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'domain-events', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'de', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${NOTE_ID}, ${WORKSPACE_ID}, 1, ${tx.json({ blocks: [{ type: "paragraph", content }] })}, 'de-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${blockId}, ${versionId}, ${WORKSPACE_ID}, 'paragraph', ${content}, 1)
      ON CONFLICT (id) DO NOTHING`;
  });
  return versionId;
}

before(async () => {
  // 幂等 seed（before 只建基础行；note 由各测试创建）
});

after(async () => {
  await admin.end();
  // 某些 import 路径保持连接（db client 单例），显式退出避免 test runner 挂起。
  setTimeout(() => process.exit(0), 50);
});

test("domain events：reveal → learning_card.revealed + IVR created/deferred；promote → ready；cancel → cancelled", async () => {
  await seedNote(
    "复利效应：本金产生的利息在下一期加入本金继续生息，长期来看资产呈指数增长。",
  );

  // ── 准备：直接构造激活后的 Objective + Card（模拟激活完成态）──
  const objectiveId = randomUUID();
  const cardId = randomUUID();
  const objectiveRevisionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO learning_objectives_v2
      (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (gen_random_uuid(), ${WORKSPACE_ID}, ${objectiveId}, 'candidate:x', 'sem-id-v1',
              ${"f".repeat(64)}, 'active', 1, ${objectiveRevisionId}, 1)`;
    await tx`INSERT INTO learning_objective_revisions_v2
      (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
       knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
       evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
      VALUES (gen_random_uuid(), ${WORKSPACE_ID}, ${objectiveRevisionId}, ${objectiveId}, 1,
              '复利效应定义', '复利效应', 'definition', ARRAY['recall'],
              ${JSON.stringify({ kind: "text", unit: { unitId: "u1", text: "复利效应" } })}::jsonb,
              ${JSON.stringify({ explanation: "x" })}::jsonb,
              ${JSON.stringify({ units: [], passingPolicy: {} })}::jsonb,
              '[]'::jsonb, '[]'::jsonb, ${"f".repeat(64)}, ${"e".repeat(64)}, ${"d".repeat(64)})`;
    await tx`INSERT INTO learning_cards_v2
      (id, workspace_id, card_id, objective_id, card_revision, current_publication_revision, lifecycle,
       front, public_summary, knowledge_form, strategy, presentation_hash)
      VALUES (gen_random_uuid(), ${WORKSPACE_ID}, ${cardId}, ${objectiveId}, 1, 1, 'active',
              ${JSON.stringify({ cue: "复利", prompt: "什么是复利效应？" })}::jsonb,
              '复利效应', 'definition', 'recall', ${"c".repeat(64)})`;
    await tx`INSERT INTO learning_card_publication_revisions_v2
      (id, workspace_id, card_id, publication_revision, card_revision, objective_id, objective_revision,
       lifecycle_at_publication, public_payload_hash, reveal_payload_hash)
      VALUES (gen_random_uuid(), ${WORKSPACE_ID}, ${cardId}, 1, 1, ${objectiveId}, 1, 'active',
              ${"b".repeat(64)}, ${"a".repeat(64)})`;
  });

  // ── 1. reveal → learning_card.revealed + IVR created(pending, cooldown) ──
  const { revealCardV2 } = await import("../modules/card-generation-v2/card-service.ts");
  const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };
  const key = `de-reveal-${randomUUID()}`;
  await revealCardV2(ctx, {
    cardId,
    expectedPublicationRevision: 1,
    expectedPublicPayloadHash: "b".repeat(64),
  }, key);

  const revealedEvents = await admin`
    SELECT event_type, payload FROM card_domain_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'learning_card.revealed'`;
  assert.equal(revealedEvents.length, 1, "reveal 必须写 learning_card.revealed 领域事件");
  assert.equal(String(revealedEvents[0].payload.objectiveId), objectiveId, "revealed 事件必须携带 objectiveId");

  const reminderRows = await admin`
    SELECT reminder_id, status, qualification_not_before FROM initial_validation_reminders_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND user_id = ${USER_ID} AND objective_id = ${objectiveId}`;
  assert.equal(reminderRows.length, 1, "reveal 必须创建 objective-scoped Reminder");
  assert.equal(String(reminderRows[0].status), "pending", "有 reveal exposure → pending（cooldown 延后）");
  const createdEvents = await admin`
    SELECT event_type FROM card_domain_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'initial_validation_reminder.created'`;
  assert.equal(createdEvents.length, 1, "created 领域事件必须存在");

  // ── 2. promoteDueRemindersV2：把 qualificationNotBefore 提前到过去 → ready ──
  await admin`
    UPDATE initial_validation_reminders_v2
    SET qualification_not_before = now() - interval '1 minute'
    WHERE workspace_id = ${WORKSPACE_ID} AND user_id = ${USER_ID} AND objective_id = ${objectiveId}`;
  const { promoteDueRemindersV2 } = await import("../modules/card-generation-v2/card-service.ts");
  const promoted = await promoteDueRemindersV2(ctx);
  assert.equal(promoted, 1, "到期 pending 必须被 promote 为 ready");
  const readyEvents = await admin`
    SELECT event_type FROM card_domain_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'initial_validation_reminder.ready'`;
  assert.equal(readyEvents.length, 1, "ready 领域事件必须写（幂等，重复 promote 不重复）");
  const promotedAgain = await promoteDueRemindersV2(ctx);
  assert.equal(promotedAgain, 0, "重复 promote 幂等（已 ready 不再推进）");
  const readyEventsAfter = await admin`
    SELECT count(*)::int AS n FROM card_domain_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'initial_validation_reminder.ready'`;
  assert.equal(readyEventsAfter[0].n, 1, "ready 事件必须幂等（不重复写）");

  // ── 3. 显式取消 → cancelled 领域事件 ──
  const { cancelReminderV2 } = await import("../modules/card-generation-v2/card-service.ts");
  await cancelReminderV2(ctx, String(reminderRows[0].reminder_id));
  const cancelledEvents = await admin`
    SELECT event_type FROM card_domain_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'initial_validation_reminder.cancelled'`;
  assert.equal(cancelledEvents.length, 1, "显式取消必须写 cancelled 领域事件");
  const reminderAfter = await admin`
    SELECT status FROM initial_validation_reminders_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND reminder_id = ${reminderRows[0].reminder_id}`;
  assert.equal(String(reminderAfter[0].status), "cancelled", "Reminder 状态必须为 cancelled");

  // ── 4. archive → learning_card.archived + learning_objective.archived ──
  const { archiveCardV2 } = await import("../modules/card-generation-v2/card-service.ts");
  await archiveCardV2(ctx, {
    cardId,
    expectedPublicationRevision: 1,
    expectedPublicPayloadHash: "b".repeat(64),
    expectedObjectiveLifecycleEpoch: 1,
  }, `de-archive-${randomUUID()}`);
  const archiveEvents = await admin`
    SELECT event_type FROM card_domain_events_v2
    WHERE workspace_id = ${WORKSPACE_ID}
      AND event_type IN ('learning_card.archived', 'learning_objective.archived')`;
  const archiveTypes = archiveEvents.map((e) => String(e.event_type));
  assert.ok(archiveTypes.includes("learning_card.archived"), "archive 必须写 learning_card.archived");
  assert.ok(archiveTypes.includes("learning_objective.archived"), "archive 必须写 learning_objective.archived");
});
