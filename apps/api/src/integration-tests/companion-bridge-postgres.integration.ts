/**
 * Companion Bridge 服务端 context hydration 集成测试（真实 postgres）。
 *
 * 覆盖：publish（EntityRef 归属校验通过）→ renew（CAS）→ revoke →
 * 跨 workspace 实体拒绝（fail closed）→ 白名单外实体 kind 拒绝 →
 * 未知/错误 revision renew 拒绝。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/companion-bridge-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { MainPageContextInputV2 } from "@ailearn/shared";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  publishContext,
  renewContext,
  revokeContext,
} = await import("../modules/companion-bridge/context-service.ts");
const { ContextHydrationError } = await import("../modules/companion-bridge/context-hydration.ts");

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
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`cb-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'cb-ws', ${userId})`;
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
             VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, '遗忘曲线', '间隔重复。')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM assistant_page_contexts WHERE workspace_id = ${workspaceId}`;
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

function makePage(cardId: string, keyPointId: string): MainPageContextInputV2 {
  return {
    routeRef: { kind: "card", cardId },
    pageKind: "card",
    entityRefs: [
      { kind: "card", cardId },
      { kind: "key_point", keyPointId },
    ],
    interactionState: "idle",
    capabilityHints: ["open_route"],
    sensitivity: "normal",
  };
}

test("P5 hydration：publish → renew → revoke 全链 + 失败路径 fail closed", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const contextId = randomUUID();
    const pageInstanceId = `page:${randomUUID()}`;
    const now = new Date();

    const snapshot = await withWorkspaceTransaction(scope, (tx) =>
      publishContext(tx, scope, {
        contextId,
        accountSessionId: "acct-1",
        deviceSessionId: "dev-1",
        pageInstanceId,
        page: makePage(seeded.cardId, seeded.keyPointId),
        now,
      }),
    );
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.contextId, contextId);
    assert.equal(snapshot.workspaceId, seeded.workspaceId);
    assert.equal(snapshot.pageInstanceId, pageInstanceId);
    assert.ok(snapshot.revision.length === 64);

    // renew（正确 revision）→ 新 expiresAt。
    const renewed = await withWorkspaceTransaction(scope, (tx) =>
      renewContext(tx, scope, {
        contextId,
        pageInstanceId,
        expectedRevision: snapshot.revision,
        now: new Date(),
      }),
    );
    assert.ok(renewed);
    assert.equal(renewed.revision, snapshot.revision);

    // renew（错误 revision）→ ContextHydrationError（fail closed）。
    await assert.rejects(
      withWorkspaceTransaction(scope, (tx) =>
        renewContext(tx, scope, {
          contextId,
          pageInstanceId,
          expectedRevision: "wrong-revision",
          now: new Date(),
        }),
      ),
      ContextHydrationError,
    );

    // revoke（CAS）。
    const revoked = await withWorkspaceTransaction(scope, (tx) =>
      revokeContext(tx, scope, {
        contextId,
        pageInstanceId,
        expectedRevision: snapshot.revision,
        now: new Date(),
      }),
    );
    assert.equal(revoked, true);

    // revoke 后 renew → null。
    const afterRevoke = await withWorkspaceTransaction(scope, (tx) =>
      renewContext(tx, scope, {
        contextId,
        pageInstanceId,
        expectedRevision: snapshot.revision,
        now: new Date(),
      }),
    );
    assert.equal(afterRevoke, null);
  } finally {
    await seeded.cleanup();
  }
});

test("P5 hydration：跨 workspace 实体 / 白名单外实体 kind → 整体拒绝", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    // 跨 workspace 实体（另一个 workspace 的 card id）→ 拒绝。
    await assert.rejects(
      withWorkspaceTransaction(scope, (tx) =>
        publishContext(tx, scope, {
          contextId: randomUUID(),
          accountSessionId: "acct-1",
          deviceSessionId: "dev-1",
          pageInstanceId: `page:${randomUUID()}`,
          page: makePage(randomUUID(), seeded.keyPointId),
          now,
        }),
      ),
      ContextHydrationError,
    );

    // 白名单外实体 kind（route_plan 有表映射但不在 HYDRATABLE_TABLES）→ 拒绝。
    await assert.rejects(
      withWorkspaceTransaction(scope, (tx) =>
        publishContext(tx, scope, {
          contextId: randomUUID(),
          accountSessionId: "acct-1",
          deviceSessionId: "dev-1",
          pageInstanceId: `page:${randomUUID()}`,
          page: {
            ...makePage(seeded.cardId, seeded.keyPointId),
            entityRefs: [{ kind: "route_plan", routePlanId: randomUUID() }],
          },
          now,
        }),
      ),
      ContextHydrationError,
    );
  } finally {
    await seeded.cleanup();
  }
});

test("P5 hydration 负向：未注册 renew→null；同 pageInstance 覆盖旧 context；多窗口共存；账号切换隔离", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    // 未注册：renew 随机 contextId → null（fail closed）。
    const missing = await withWorkspaceTransaction(scope, (tx) =>
      renewContext(tx, scope, {
        contextId: randomUUID(),
        pageInstanceId: `page:${randomUUID()}`,
        expectedRevision: "f".repeat(64),
        now,
      }),
    );
    assert.equal(missing, null);

    // 发布 context A（pageInstance-A）。
    const contextA = randomUUID();
    const pageInstanceA = `page:${randomUUID()}`;
    const snapshotA = await withWorkspaceTransaction(scope, (tx) =>
      publishContext(tx, scope, {
        contextId: contextA,
        accountSessionId: "acct-1",
        deviceSessionId: "dev-1",
        pageInstanceId: pageInstanceA,
        page: makePage(seeded.cardId, seeded.keyPointId),
        now,
      }),
    );

    // 同 pageInstance 内容变化重新 publish → 旧 context 立即撤销（覆盖语义），
    // 旧 contextId renew → null（§14.2：重新 publish 并立即 revoke 旧 context）。
    const contextB = randomUUID();
    const later = new Date(now.getTime() + 1000);
    const snapshotB = await withWorkspaceTransaction(scope, (tx) =>
      publishContext(tx, scope, {
        contextId: contextB,
        accountSessionId: "acct-1",
        deviceSessionId: "dev-1",
        pageInstanceId: pageInstanceA,
        page: {
          ...makePage(seeded.cardId, seeded.keyPointId),
          interactionState: "formal_answer",
        },
        now: later,
      }),
    );
    assert.notEqual(snapshotB.revision, snapshotA.revision);
    const oldRenew = await withWorkspaceTransaction(scope, (tx) =>
      renewContext(tx, scope, {
        contextId: contextA,
        pageInstanceId: pageInstanceA,
        expectedRevision: snapshotA.revision,
        now,
      }),
    );
    assert.equal(oldRenew, null, "覆盖后旧 contextId 不再可续租");

    // 多窗口：不同 pageInstance 各自独立 context 共存（互不撤销）。
    const pageInstanceC = `page:${randomUUID()}`;
    const snapshotC = await withWorkspaceTransaction(scope, (tx) =>
      publishContext(tx, scope, {
        contextId: randomUUID(),
        accountSessionId: "acct-1",
        deviceSessionId: "dev-2",
        pageInstanceId: pageInstanceC,
        page: makePage(seeded.cardId, seeded.keyPointId),
        now,
      }),
    );
    assert.ok(snapshotC.revision);
    const renewC = await withWorkspaceTransaction(scope, (tx) =>
      renewContext(tx, scope, {
        contextId: contextB,
        pageInstanceId: pageInstanceA,
        expectedRevision: snapshotB.revision,
        now,
      }),
    );
    assert.ok(renewC, "覆盖后新 context 正常续租（多窗口互不影响）");

    // 账号切换：另一 userId（同 workspace）→ scope 隔离，renew → null。
    const otherUser = randomUUID();
    const otherScope = { workspaceId: seeded.workspaceId, userId: otherUser };
    const otherRenew = await withWorkspaceTransaction(otherScope, (tx) =>
      renewContext(tx, otherScope, {
        contextId: contextB,
        pageInstanceId: pageInstanceA,
        expectedRevision: snapshotB.revision,
        now,
      }),
    );
    assert.equal(otherRenew, null, "账号切换后旧 context 不可见（RLS scope 隔离）");
  } finally {
    await seeded.cleanup();
  }
});
