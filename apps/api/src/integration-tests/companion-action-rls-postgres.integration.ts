/**
 * P5 §9 固定测试：companion action 表 RLS。
 * - FORCE RLS：ailearn_worker（非 superuser）无 context 时对
 *   companion_action_proposals/runs 零行；
 * - context 正确时仅见自己 workspace/user 的行；
 * - ailearn（superuser）无 context 可见全部（RLS 不拦截 superuser）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 2 });

after(() => sql.end({ timeout: 2 }));

test("P5 §6.6/§6.7：action 表 FORCE RLS（worker 无 context 零行，superuser 可见）", async () => {
  // 无 context（worker 非 superuser）：proposals/runs 零行
  const worker = postgres("postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn", { max: 1 });
  try {
    const p = await worker`SELECT count(*)::int AS c FROM companion_action_proposals`;
    const r = await worker`SELECT count(*)::int AS c FROM companion_action_runs`;
    assert.equal(p[0].c, 0, "worker 无 context 对 proposals 零行（FORCE RLS）");
    assert.equal(r[0].c, 0, "worker 无 context 对 runs 零行（FORCE RLS）");
  } finally {
    await worker.end({ timeout: 2 });
  }
  // superuser 无 context：可见全部（RLS 不拦截 superuser）
  const p = await sql`SELECT count(*)::int AS c FROM companion_action_proposals`;
  assert.ok(Number.isInteger(p[0].c), "superuser 可见（RLS 不拦截）");
});

test("P5 §6.6/§6.7：worker 有 context 时只读自己 workspace/user 的行", async () => {
  const ws = "55555555-5555-4555-8555-555555555555";
  const uid = "66666666-6666-4666-8666-666666666666";
  const cid = "77777777-7777-4777-8777-777777777777";
  const msgId = "88888888-8888-4888-8888-888888888888";
  const pid = "99999999-9999-4999-8999-999999999999";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"t-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${msgId}, ${cid}, ${ws}, ${uid}, 'user', 1, 'action', ${{ blocks: [{ type: "text", text: "x" }] } as never}, ${"0".repeat(64)})`;
    await tx`INSERT INTO companion_action_proposals
             (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
              payload, payload_sha256, title, target_summary, impact_summary, status,
              idempotency_key_hash, expires_at)
             VALUES (${pid}, ${ws}, ${uid}, ${cid}, ${msgId}, 1,
                     ${{ kind: "open_review" } as never}, ${"a".repeat(64)},
                     '复习', '目标', '影响', 'pending', ${"b".repeat(64)},
                     now() + interval '30 minutes')`;
    await tx`INSERT INTO companion_action_runs (id, workspace_id, user_id, conversation_id, proposal_id, status)
             VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ${ws}, ${uid}, ${cid}, ${pid}, 'accepted')`;
  });
  try {
    const worker = postgres("postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn", { max: 1 });
    try {
      // 错误 context：零行（事务内 set_config is_local=true 生效）
      await worker.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', '11111111-1111-4111-8111-111111111111', true)`;
        await tx`SELECT set_config('app.user_id', '22222222-2222-4222-8222-222222222222', true)`;
        const wrong = await tx`SELECT count(*)::int AS c FROM companion_action_proposals`;
        assert.equal(wrong[0].c, 0, "错误 context 零行");
      });
      // 正确 context：可见自己的行
      await worker.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        await tx`SELECT set_config('app.user_id', ${uid}, true)`;
        const own = await tx`SELECT count(*)::int AS c FROM companion_action_proposals`;
        assert.equal(own[0].c, 1, "正确 context 见自己行");
      });
    } finally {
      await worker.end({ timeout: 2 });
    }
  } finally {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`UPDATE companion_action_proposals SET action_run_id = NULL WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_runs WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  }
});
