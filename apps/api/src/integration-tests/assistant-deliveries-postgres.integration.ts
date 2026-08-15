/**
 * P8 durable delivery 纵切集成测试（真实 postgres，文档 16 §14.3）。
 *
 * 覆盖：deliver（dedupe + inboxSequence 单调）→ claim display lease（单租约
 * 竞争：第二设备 claim 被拒）→ ACK 状态机（displayed/acted 幂等 + lease 不
 * 匹配拒绝）→ inbox Last-Event-ID 拉取。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/assistant-deliveries-postgres.integration.ts
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
  deliver,
  claimDisplayLease,
  ackDelivery,
  listInbox,
} = await import("../modules/companion-conversation/delivery-service.ts");

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
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`dl-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'dl-ws', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM assistant_deliveries WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, cleanup };
}

test("P8 delivery 纵切：dedupe → lease 竞争 → ACK 状态机 → inbox 游标", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    // 1) deliver：两条不同 key → inboxSequence 单调；同 key dedupe 返回既有。
    const first = await withWorkspaceTransaction(scope, (tx) =>
      deliver(tx, scope, {
        assistantSessionId: null,
        kind: "proactive_cue",
        payloadRef: { kind: "proactive_cue", cueId: randomUUID() },
        dedupeKey: "cue-1",
        expiresAt: new Date(now.getTime() + 60_000),
      }, now),
    );
    const second = await withWorkspaceTransaction(scope, (tx) =>
      deliver(tx, scope, {
        assistantSessionId: null,
        kind: "system_event",
        payloadRef: { kind: "system_event", systemEventId: "evt-1" },
        dedupeKey: "evt-1",
        expiresAt: new Date(now.getTime() + 60_000),
      }, now),
    );
    assert.equal(first.inboxSequence + 1, second.inboxSequence);
    const dup = await withWorkspaceTransaction(scope, (tx) =>
      deliver(tx, scope, {
        assistantSessionId: null,
        kind: "proactive_cue",
        payloadRef: { kind: "proactive_cue", cueId: randomUUID() },
        dedupeKey: "cue-1",
        expiresAt: new Date(now.getTime() + 60_000),
      }, now),
    );
    assert.equal(dup.deliveryId, first.deliveryId, "dedupe 返回既有行");

    // 2) claim display lease：第一设备成功；第二设备被拒（单租约）。
    const leaseToken1 = "lease-1";
    const claimed = await withWorkspaceTransaction(scope, (tx) =>
      claimDisplayLease(tx, scope, { deliveryId: first.deliveryId, deviceSessionId: "dev-1", leaseToken: leaseToken1 }, now),
    );
    assert.equal(claimed.state, "delivered");
    assert.equal(claimed.displayLease?.deviceSessionId, "dev-1");
    await assert.rejects(
      withWorkspaceTransaction(scope, (tx) =>
        claimDisplayLease(tx, scope, { deliveryId: first.deliveryId, deviceSessionId: "dev-2", leaseToken: "lease-2" }, now),
      ),
      (err: unknown) => (err as { code?: string }).code === "lease_conflict",
    );

    // 3) ACK：lease 不匹配拒绝；正确 lease displayed → acted 幂等。
    await assert.rejects(
      withWorkspaceTransaction(scope, (tx) =>
        ackDelivery(tx, scope, {
          deliveryId: first.deliveryId,
          deviceSessionId: "dev-1",
          leaseToken: "wrong",
          transition: "displayed",
        }, now),
      ),
      (err: unknown) => (err as { code?: string }).code === "lease_mismatch",
    );
    const leaseBeforeAck = await sql`SELECT display_lease, state FROM assistant_deliveries WHERE id = ${first.deliveryId}`;
    console.log("leaseBeforeAck:", JSON.stringify(leaseBeforeAck[0]));
    const displayed = await withWorkspaceTransaction(scope, (tx) =>
      ackDelivery(tx, scope, {
        deliveryId: first.deliveryId,
        deviceSessionId: "dev-1",
        leaseToken: leaseToken1,
        transition: "displayed",
      }, now),
    );
    assert.equal(displayed.state, "displayed");
    const acted = await withWorkspaceTransaction(scope, (tx) =>
      ackDelivery(tx, scope, {
        deliveryId: first.deliveryId,
        deviceSessionId: "dev-1",
        leaseToken: leaseToken1,
        transition: "acted",
      }, now),
    );
    assert.equal(acted.state, "acted");
    assert.equal(acted.displayLease, null);
    // 终态幂等重放。
    const replay = await withWorkspaceTransaction(scope, (tx) =>
      ackDelivery(tx, scope, {
        deliveryId: first.deliveryId,
        deviceSessionId: "dev-1",
        leaseToken: leaseToken1,
        transition: "acted",
      }, now),
    );
    assert.equal(replay.state, "acted");

    // 4) inbox Last-Event-ID 拉取。
    const inbox = await withWorkspaceTransaction(scope, (tx) =>
      listInbox(tx, scope, { afterSequence: 0, limit: 10 }),
    );
    assert.equal(inbox.length, 2);
    assert.equal(inbox[0].inboxSequence, first.inboxSequence);
  } finally {
    await seeded.cleanup();
  }
});
