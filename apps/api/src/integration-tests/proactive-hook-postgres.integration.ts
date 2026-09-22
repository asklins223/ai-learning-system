/**
 * proactive-hook 真实门禁集成测试（postgres）。方案 16 §10.2 + 方案 29 §9.61。
 *
 * 这个 hook 产的是**触发式**推送（run.completed：用户刚跑完一个运行，正在等回执），
 * 所以它不进任何频率闸。覆盖：
 * - 空账号状态 → 入队；
 * - 正式作答中 / 24h 内已有 4 条主动提示 / 6 分钟前刚说过 → **照样入队**；
 * - 设备 dnd、账号级总开关关闭 → 不推（这两条是反向兜底，证明"不进频率"
 *   没被写成"无条件放行"）。
 *
 * 以前这里断言的是"预算满 → 抑制""cooldown → 抑制""quiet 恒抑制"。
 * 那套"一天 N 条"的额度 2026-09-21 被用户否掉（三条气泡根本感知不到主动推送能力），
 * 例行主动改成按偏好定间隔，触发式整个移出频率。
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

test("触发式：formal_answer 页面 context 未过期 → 照样入队", async () => {
  // 这条以前断言的是"0 delivery（正式作答期间零主动提示）"。
  // run.completed 不是她随口搭话，是用户刚跑完一个运行、正在等的回执；
  // 触发式不进任何频率/打断闸（用户 2026-09-21 的口径），所以这里翻成"照样入队"。
  const seeded = await seedBase();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    await insertPageContext(seeded.workspaceId, seeded.userId, "formal_answer");
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId: randomUUID(), outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 1, "作答中也要给完成回执");
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

/**
 * 这两条以前分别断言"24h 预算 moderate=3 已满 → 抑制"和"< 30min cooldown → 抑制"。
 * 现在换成**反向**断言：触发式两类闸都不沾。
 *
 * 为什么必须留在集成测试里而不是只留单测：闸是在这个函数里读的账号状态与
 * 这些历史 delivery，改错方向（把触发式也套进频率）在这里才会红。
 */
test("触发式：历史主动提示再多、刚说过话，都照样入队", async () => {
  const seeded = await seedBase();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    // 3 条 24h 内的历史（以前正好占满 moderate 额度）+ 1 条 6 分钟前的（以前落在冷却里）。
    await insertHistoricalDeliveries(seeded.workspaceId, seeded.userId, [6, 60, 120, 180]);
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 4);
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId: randomUUID(), outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 5, "触发式不进频率限制");
  } finally {
    await seeded.cleanup();
  }
});

/**
 * "不进频率限制"不等于"无条件放行"——下面两条是反向兜底：
 * 方向改坏了（整个 hook 变成无条件写投递）时，这两条会红。
 */
test("设备在勿扰：触发式也不推（气泡等用户回来）", async () => {
  const seeded = await seedBase();
  try {
    await sql`UPDATE user_companion_account_state
              SET presence = ${{ presence: "dnd" } as never} WHERE user_id = ${seeded.userId}`;
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId: randomUUID(), outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 0, "dnd 不该弹提示");
  } finally {
    await seeded.cleanup();
  }
});

test("账号级总开关关掉：触发式同样不推", async () => {
  const seeded = await seedBase();
  try {
    await sql`UPDATE user_companion_account_state
              SET global_enabled = false WHERE user_id = ${seeded.userId}`;
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    await withWorkspaceTransaction(scope, (tx) =>
      hookProactiveOnRunCompleted(tx, scope, { runId: randomUUID(), outcome: "demonstrated" }),
    );
    assert.equal(await countDeliveries(seeded.workspaceId, seeded.userId), 0, "globalEnabled=false 是一切的开关");
  } finally {
    await seeded.cleanup();
  }
});
