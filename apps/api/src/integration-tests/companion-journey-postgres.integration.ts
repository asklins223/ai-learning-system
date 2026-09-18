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
// 跨 user 隔离断言必须用**不绕过 RLS** 的角色（超级用户会让隔离断言变成假通过），
// 因此默认值保持受限的 ailearn_api，而不是回落到主连接。需要指向别的库时用
// DATABASE_URL_API_RLS 显式覆盖（角色仍须是 NOBYPASSRLS 的受限角色）。
//
// 默认值由 CONN 派生 host/port/database：写死 "/ailearn" 会让套件在指向别的库
// （CI/测试库）时探针连到**另一个数据库**，于是"跨 user 读被拒"因读不到任何行
// 而假通过、"本人可读"却失败。角色与密码仍取受限的 ailearn_api。
function deriveRestrictedApiUrl(main: string): string {
  try {
    const url = new URL(main);
    url.username = "ailearn_api";
    url.password = process.env.API_PASSWORD ?? "ailearn_dev";
    return url.toString();
  } catch {
    return "postgres://ailearn_api:ailearn_dev@127.0.0.1:5432/ailearn";
  }
}
const API_RLS_CONN = process.env.DATABASE_URL_API_RLS ?? deriveRestrictedApiUrl(CONN);
const sql = postgres(CONN, { max: 2 });

/**
 * 裸 SQL 夹具/校验必须带 workspace/user 上下文。
 *
 * companion_conversations / companion_journeys / companion_journey_pending_events /
 * companion_account_invitations 都是 FORCE RLS：受限角色（ailearn_api）在无上下文
 * 事务里读或写会命中 0 行——校验读会取到 undefined 而假失败，夹具 UPDATE 会静默
 * 失效让后续 CAS 恒 stale。超级用户则绕过 RLS 掩盖同一问题。
 */
function scoped<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

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
  await scoped({ workspaceId, userId }, async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`jv-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'jv-ws', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  });
  const cleanup = async () => {
    await scoped({ workspaceId, userId }, async (tx) => {
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
    // 首邀卡渲染即发送邀请，初始状态就是 offered。
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
    // companion_account_invitations 是 FORCE RLS 的用户私有表（策略要求
    // user_id = app.user_id）。裸 SQL 无会话上下文时 USING 求值为 NULL → 0 行，
    // 邀请 revision 不会推进，随后的 CAS 必然 stale_revision。
    await scoped(scope, (tx) => tx`UPDATE companion_account_invitations
               SET status='offered', offered_at=now(), revision=${boot0.invitation.revision + 1}
               WHERE user_id=${seeded.userId}`);
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
    const sessionRows = await scoped(scope, (tx) => tx`
      SELECT kind FROM companion_conversations WHERE id = ${boot.journey!.assistantSessionId}
    `);
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
    const pendingRows = await scoped(scope, (tx) => tx`
      SELECT status FROM companion_journey_pending_events WHERE journey_id = ${journeyId} AND domain_event_id = 'note.created:n1'
    `);
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
    // companion_account_invitations 是 FORCE RLS 的用户私有表（策略要求
    // user_id = app.user_id）。裸 SQL 无会话上下文时 USING 求值为 NULL → 0 行，
    // 邀请 revision 不会推进，随后的 CAS 必然 stale_revision。
    await scoped(scope, (tx) => tx`UPDATE companion_account_invitations
               SET status='offered', offered_at=now(), revision=${boot0.invitation.revision + 1}
               WHERE user_id=${seeded.userId}`);
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
    const apiSql = postgres(API_RLS_CONN, { max: 1 });
    // 探针连接必须与套件主连接同库、且角色不绕过 RLS。否则下面的负向断言会因
    // "探针连到别的库 → 谁都读不到"而假通过，或"角色是超级用户 → 谁都读得到"
    // 而假失败。这里显式失败，避免隔离断言退化成静默无效。
    const [probeIdentity] = await apiSql<{ db: string; bypass: boolean }[]>`
      SELECT current_database() AS db,
             COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypass
    `;
    const [mainIdentity] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    assert.equal(probeIdentity.db, mainIdentity.db, "RLS 探针必须与套件连接到同一个数据库");
    assert.equal(probeIdentity.bypass, false, "RLS 探针角色不得 BYPASSRLS");
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
    // companion_account_invitations 是 FORCE RLS 的用户私有表（策略要求
    // user_id = app.user_id）。裸 SQL 无会话上下文时 USING 求值为 NULL → 0 行，
    // 邀请 revision 不会推进，随后的 CAS 必然 stale_revision。
    await scoped(scope, (tx) => tx`UPDATE companion_account_invitations
               SET status='offered', offered_at=now(), revision=${boot0.invitation.revision + 1}
               WHERE user_id=${seeded.userId}`);
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
