/**
 * Journey V2 集成测试（真实 postgres，文档 16 §10.1 状态机）。
 *
 * 覆盖：invitation CAS（offer 语义经 ensure 缺省 → defer → skip；start_journey
 * 创建 active journey + accepted；同账号第二 active journey conflict）→
 * journey 动作 CAS（pause/resume/dismiss/skip；branch_locked）→ 领域事件
 * 推进（learning_run.completed + created schedule → completed real_first_loop）
 * → 事件幂等（同 domainEventId 不重复推进）→ replay 新旅程。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/companion-journey-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  applyInvitationAction,
  applyJourneyActionRequest,
  applyJourneyDomainEvent,
  bootstrapJourney,
  findActiveJourney,
} = await import("../modules/companion-journey/journey-service.ts");

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

async function seed() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`jv-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'jv-ws', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_journey_pending_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_journeys WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_account_invitations WHERE user_id = ${userId}`;
      await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, cleanup };
}

test("P6 纵切：invitation CAS → start_journey → 事件推进完成 → 幂等 → replay", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    // 1) bootstrap：桌宠首邀卡出现即视为已 offer（文档 16 §8.1.1——
    // 首邀卡渲染即发送邀请；不再停留在 not_offered 死态）。
    const boot1 = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    assert.equal(boot1.invitation.status, "offered");
    assert.equal(boot1.invitation.revision, 1);
    assert.equal(boot1.journey, null);

    // 2) start_journey（offered → accepted，直接可用 bootstrap revision）。
    const started = await withWorkspaceTransaction(scope, (tx) =>
      applyInvitationAction(tx, scope, {
        expectedRevision: boot1.invitation.revision,
        action: { kind: "start_journey", workspaceId: seeded.workspaceId, branch: "own_material" },
        idempotencyKey: "jv-start-1",
      }, now),
    );
    assert.equal(started.status, "accepted");
    const boot2 = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    assert.ok(boot2.journey, "active journey created");
    assert.equal(boot2.journey!.status, "active");
    assert.equal(boot2.journey!.currentStep, "boundary_intro");
    assert.equal(boot2.journey!.branch, "own_material");
    const journeyId = boot2.journey!.journeyId;

    // 3) 同账号第二个 active journey conflict。
    await assert.rejects(
      withWorkspaceTransaction(scope, (tx) =>
        applyInvitationAction(tx, scope, {
          expectedRevision: started.revision,
          action: { kind: "replay", workspaceId: seeded.workspaceId, branch: "own_material" },
          idempotencyKey: "jv-replay-conflict",
        }, now),
      ),
      (err: unknown) => (err as { code?: string }).code === "journey_conflict",
    );

    // 4) journey 动作：dismiss → pause → resume → 事件推进。
    const dismissed = await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyActionRequest(tx, scope, journeyId, {
        expectedRevision: boot2.journey!.revision,
        action: { kind: "dismiss_step_narration", step: "boundary_intro" },
        idempotencyKey: "jv-dismiss-1",
      }, now),
    );
    assert.deepEqual(dismissed.dismissedNarrationSteps, ["boundary_intro"]);
    const paused = await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyActionRequest(tx, scope, journeyId, {
        expectedRevision: dismissed.revision,
        action: { kind: "pause" },
        idempotencyKey: "jv-pause-1",
      }, now),
    );
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "user");
    const resumed = await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyActionRequest(tx, scope, journeyId, {
        expectedRevision: paused.revision,
        action: { kind: "resume", resumeToken: null },
        idempotencyKey: "jv-resume-1",
      }, now),
    );
    assert.equal(resumed.status, "active");

    // 5) 领域事件推进：learning_run.completed + created schedule → completed。
    const completed = (await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyDomainEvent(tx, scope, {
        journeyId,
        domainEventId: "run.completed:r1",
        eventType: "learning_run.completed",
        payload: { runId: "r1", result: { outcome: "demonstrated", scheduleImpact: { kind: "created" } } },
      }, now),
    ))!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.currentStep, "closing");
    assert.equal(completed.completionKind, "real_first_loop");
    assert.equal(completed.refs.runId, "r1");

    // 6) 事件幂等：同 domainEventId 不重复推进。
    const again = (await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyDomainEvent(tx, scope, {
        journeyId,
        domainEventId: "run.completed:r1",
        eventType: "learning_run.completed",
        payload: { runId: "r1", result: { outcome: "demonstrated", scheduleImpact: { kind: "created" } } },
      }, now),
    ))!;
    assert.equal(again.revision, completed.revision, "idempotent replay");
    assert.equal(again.stepRevision, completed.stepRevision);

    // 7) replay：完成态后 replay 创建新旅程（active）。
    const replayed = await withWorkspaceTransaction(scope, (tx) =>
      applyInvitationAction(tx, scope, {
        expectedRevision: started.revision,
        action: { kind: "replay", workspaceId: seeded.workspaceId, branch: "own_material" },
        idempotencyKey: "jv-replay-1",
      }, now),
    );
    assert.equal(replayed.status, "accepted");
    const boot3 = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    assert.ok(boot3.journey, "new journey active");
    assert.notEqual(boot3.journey.journeyId, journeyId);
  } finally {
    await seeded.cleanup();
  }
});

test("P6 里程碑：乱序不越级 + drain 补进（source→note→card→evidence 顺序守卫）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();
    const boot0 = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    await sql`UPDATE companion_account_invitations SET status='offered', offered_at=now(), revision=${boot0.invitation.revision + 1} WHERE user_id=${seeded.userId}`;
    await withWorkspaceTransaction(scope, (tx) =>
      applyInvitationAction(tx, scope, {
        expectedRevision: boot0.invitation.revision + 1,
        action: { kind: "start_journey", workspaceId: seeded.workspaceId, branch: "own_material" },
        idempotencyKey: "jv-ms-start",
      }, now),
    );
    const boot = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    const journeyId = boot.journey!.journeyId;
    // AssistantSession bootstrap：journey 绑定 kind='journey' 会话。
    assert.ok(boot.journey!.assistantSessionId, "assistant session created");
    const sessionRows = await sql`
      SELECT kind FROM companion_conversations WHERE id = ${boot.journey!.assistantSessionId}
    `;
    assert.equal(sessionRows[0]?.kind, "journey");

    // 乱序事件：note 先到（缺少 source）→ 不越级，保持 pending。
    await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyDomainEvent(tx, scope, {
        journeyId,
        domainEventId: "note.created:n1",
        eventType: "note.created",
        payload: { entityId: "n1" },
      }, now),
    );
    const afterNote = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    assert.equal(afterNote.journey!.currentStep, "boundary_intro", "乱序事件不越级");
    const pendingRows = await sql`
      SELECT status FROM companion_journey_pending_events WHERE journey_id = ${journeyId} AND domain_event_id = 'note.created:n1'
    `;
    assert.equal(pendingRows[0]?.status, "pending", "乱序事件保持 pending 等前置");

    // source 到达 → drain 顺序推进 source 与 note。
    await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyDomainEvent(tx, scope, {
        journeyId,
        domainEventId: "source.created:s1",
        eventType: "source.created",
        payload: { entityId: "s1" },
      }, now),
    );
    const afterDrain = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    assert.equal(afterDrain.journey!.currentStep, "first_note");
    assert.equal(afterDrain.journey!.refs.sourceId, "s1");
    assert.equal(afterDrain.journey!.refs.noteId, "n1");

    // card 到达 → first_card；evidence 到达 → first_evidence。
    await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyDomainEvent(tx, scope, {
        journeyId,
        domainEventId: "card.created:c1",
        eventType: "card.created",
        payload: { entityId: "c1" },
      }, now),
    );
    await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyDomainEvent(tx, scope, {
        journeyId,
        domainEventId: "evidence.created:e1",
        eventType: "evidence.created",
        payload: { entityId: "e1" },
      }, now),
    );
    const afterAll = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    assert.equal(afterAll.journey!.currentStep, "first_evidence");
    assert.equal(afterAll.journey!.refs.cardId, "c1");
  } finally {
    await seeded.cleanup();
  }
});

test("P6 RLS：跨 user 读 journey 被拒（app.user_id 上下文收口）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();
    const boot0 = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    await sql`UPDATE companion_account_invitations SET status='offered', offered_at=now(), revision=${boot0.invitation.revision + 1} WHERE user_id=${seeded.userId}`;
    await withWorkspaceTransaction(scope, (tx) =>
      applyInvitationAction(tx, scope, {
        expectedRevision: boot0.invitation.revision + 1,
        action: { kind: "start_journey", workspaceId: seeded.workspaceId, branch: "own_material" },
        idempotencyKey: "jv-rls-start",
      }, now),
    );
    const boot = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    const journeyId = boot.journey!.journeyId;

    // 另一个 user 以正确 workspace 上下文读该 journey → RLS 拒（0 行）。
    // 用 ailearn_api 角色连接（NOBYPASSRLS，owner 会绕过 RLS）。
    const apiSql = postgres("postgres://ailearn_api:ailearn_dev@127.0.0.1:5432/ailearn", { max: 1 });
    const otherUser = randomUUID();
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES (${otherUser}, ${`jv-other-${otherUser.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    try {
      await apiSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${otherUser}, true)`;
        const rows = await tx`SELECT id FROM companion_journeys WHERE id = ${journeyId}`;
        assert.equal(rows.length, 0, "cross-user journey read must be rejected by RLS");
      });
      // 正确 user 可读（对照）。
      await apiSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
        const rows = await tx`SELECT id FROM companion_journeys WHERE id = ${journeyId}`;
        assert.equal(rows.length, 1, "own journey must be readable");
      });
    } finally {
      await apiSql.end({ timeout: 2 }).catch(() => {});
      await sql`DELETE FROM users WHERE id = ${otherUser}`;
    }
  } finally {
    await seeded.cleanup();
  }
});

test("P6 skip：终态 skip 不伪造里程碑；branch_locked 拒绝切换", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();
    // ensure invitation 行存在，再置为 offered（revision+1）。
    const boot0 = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    await sql`UPDATE companion_account_invitations SET status='offered', offered_at=now(), revision=${boot0.invitation.revision + 1} WHERE user_id=${seeded.userId}`;
    await withWorkspaceTransaction(scope, (tx) =>
      applyInvitationAction(tx, scope, {
        expectedRevision: boot0.invitation.revision + 1,
        action: { kind: "start_journey", workspaceId: seeded.workspaceId, branch: "own_material" },
        idempotencyKey: "jv-skip-start",
      }, now),
    );
    const boot = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    const journeyId = boot.journey!.journeyId;

    // 领域事件写入 refs（模拟已有分支对象）→ switch_branch 拒绝。
    await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyDomainEvent(tx, scope, {
        journeyId,
        domainEventId: "run.completed:r-skip",
        eventType: "learning_run.completed",
        payload: { runId: "r-skip", result: { outcome: "demonstrated", scheduleImpact: { kind: "none" } } },
      }, now),
    );
    const afterEvent = await withWorkspaceTransaction(scope, (tx) => bootstrapJourney(tx, scope, now));
    await assert.rejects(
      withWorkspaceTransaction(scope, (tx) =>
        applyJourneyActionRequest(tx, scope, journeyId, {
          expectedRevision: afterEvent.journey!.revision,
          action: { kind: "switch_branch", branch: "sandbox_sample" },
          idempotencyKey: "jv-switch-locked",
        }, now),
      ),
      (err: unknown) => (err as { code?: string }).code === "branch_locked",
    );

    // skip：终态，completionKind 不伪造。
    const skipped = await withWorkspaceTransaction(scope, (tx) =>
      applyJourneyActionRequest(tx, scope, journeyId, {
        expectedRevision: afterEvent.journey!.revision,
        action: { kind: "skip" },
        idempotencyKey: "jv-skip-1",
      }, now),
    );
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.completionKind, null);
    // skip 后无 active journey。
    const active = await withWorkspaceTransaction(scope, (tx) => findActiveJourney(tx, scope));
    assert.equal(active, null);
  } finally {
    await seeded.cleanup();
  }
});
