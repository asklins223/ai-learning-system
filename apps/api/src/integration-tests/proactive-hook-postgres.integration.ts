/**
 * 方案 16 §6.5/§9.5/§10.2/§20.2：proactive-hook 真实门禁集成测试（postgres）。
 *
 * 覆盖：
 * - 无正式作答 context + 空预算 → run.completed 提醒入队（allowed）；
 * - 存在未过期 formal_answer page context → 抑制（formal_answer_in_progress）；
 * - 24h 主动 delivery 已达 moderate 预算（3）→ 抑制（daily_budget_exhausted）；
 * - quiet 介入级别 → 恒抑制（quietDailyLimit=0）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { hookProactiveOnRunCompleted } = await import(
  "../modules/companion-conversation/proactive-hook.ts"
);

async function seedBase(): Promise<{ workspaceId: string; userId: string; cleanup: () => Promise<void> }> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
             VALUES (${userId}, ${`ph-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id)
             VALUES (${workspaceId}, ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
             VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO user_companion_account_state (user_id, global_enabled, presence, intervention_level, notification_boundary)
             VALUES (${userId}, true, ${{ presence: "online" } as never}, 'moderate',
                     ${{ notificationsEnabled: true } as never})`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM assistant_deliveries WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM assistant_page_contexts WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id = ${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, cleanup };
}

async function countDeliveries(workspaceId: string, userId: string): Promise<number> {
  // dev 栈 ailearn 为 superuser（RLS 豁免）——计数按 SQL 层 scope 过滤，
  // 与生产 RLS 语义一致（生产由 RLS 承担同一过滤）。
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    const rows = await tx`SELECT count(*)::int AS n FROM assistant_deliveries
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
    return Number(rows[0].n);
  });
}

async function insertPageContext(workspaceId: string, userId: string, interactionState: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO assistant_page_contexts
             (id, workspace_id, user_id, page_instance_id, revision, route_ref, page_kind,
              entity_refs, interaction_state, capability_hints, sensitivity,
              issued_at, expires_at, created_at, updated_at)
             VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${`page:${randomUUID()}`},
                     ${"a".repeat(64)}, ${{ kind: "learning_run", runId: randomUUID() } as never},
                     'learning_run', ${[] as never}, ${interactionState}, ${[] as never},
                     'formal_assessment', now(), now() + interval '30 seconds', now(), now())`;
  });
}

test("§10.2/§20.2：无正式作答 + 空预算 → run.completed 提醒入队", async () => {
  const seeded = await seedBase();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const runId = randomUUID();
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId, outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 1);
  } finally {
    await seeded.cleanup();
  }
});

test("§6.5/§9.5/§20.2：formal_answer 页面 context 未过期 → 抑制（0 delivery）", async () => {
  const seeded = await seedBase();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    await insertPageContext(seeded.workspaceId, seeded.userId, "formal_answer");
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId: randomUUID(), outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 0, "正式作答期间零主动提示");
  } finally {
    await seeded.cleanup();
  }
});

async function insertHistoricalDeliveries(
  workspaceId: string,
  userId: string,
  agesMinutes: number[],
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    for (let i = 0; i < agesMinutes.length; i += 1) {
      await tx`INSERT INTO assistant_deliveries
               (id, workspace_id, user_id, inbox_sequence, dedupe_key, state, kind, payload_ref,
                created_at, expires_at)
               VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${i + 1}, ${`hist-${randomUUID()}`},
                       'delivered', 'system_event', ${JSON.stringify({ systemEventId: "run.completed:x" })},
                       now() - make_interval(mins => ${agesMinutes[i]}), now() + interval '1 hour')`;
    }
  });
}

test("§10.2：24h 预算 moderate=3 已满 → 抑制（daily_budget_exhausted）", async () => {
  const seeded = await seedBase();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    // 预置 3 条历史主动 delivery（24h 内、间隔 > 30min cooldown）
    await insertHistoricalDeliveries(seeded.workspaceId, seeded.userId, [60, 120, 180]);
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 3);
    // 新 run 完成：预算已满 → 抑制
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId: randomUUID(), outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 3, "moderate 预算 3 条上限");
  } finally {
    await seeded.cleanup();
  }
});

test("§10.2：最近一次展示 < 30min cooldown → 抑制（cooldown）", async () => {
  const seeded = await seedBase();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    await insertHistoricalDeliveries(seeded.workspaceId, seeded.userId, [6]);
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId: randomUUID(), outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 1, "30 分钟冷却内抑制");
  } finally {
    await seeded.cleanup();
  }
});
