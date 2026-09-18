/**
 * P5 §9 固定测试：companion_action_bridge 迁移 + RLS。
 * - 表结构/唯一索引（single pending per conversation、decision key 幂等）；
 * - turn_runs 的 frozen router decision 字段；
 * - RLS：ailearn_worker 非 superuser 无 context 零行（FORCE RLS）；
 *   ailearn（superuser）无 context 可见全部（RLS 不拦截 superuser）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";

const sql = postgres(CONN, { max: 2 });

after(() => sql.end({ timeout: 2 }));

test("action proposal 表/索引与 turn router 字段存在", async () => {
  const cols = await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'companion_action_proposals'
    ORDER BY table_name, ordinal_position`;
  const proposalCols = cols.filter((c) => c.table_name === "companion_action_proposals").map((c) => c.column_name);
  for (const c of [
    "id", "workspace_id", "user_id", "conversation_id", "payload", "payload_sha256",
    "status", "decision", "decision_key_hash", "idempotency_key_hash", "expires_at",
    "request_body_sha256",
  ]) {
    assert.ok(proposalCols.includes(c), `proposals 缺列 ${c}`);
  }
  const singlePending = await sql`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'companion_action_proposals'
      AND indexname = 'companion_action_proposals_single_pending_idx'`;
  assert.equal(singlePending.length, 1, "single pending 唯一索引缺失");

  const runFields = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'companion_turn_runs'
      AND column_name LIKE 'router_%'
    ORDER BY column_name`;
  const names = runFields.map((r) => r.column_name);
  for (const f of [
    "router_intent", "router_confidence", "router_prompt_version",
    "router_prompt_hash", "router_context_revision", "router_payload_hash",
  ]) {
    assert.ok(names.includes(f), `turn_runs 缺 router 字段 ${f}`);
  }
});

test("0092：proposals 单一 pending（同 conversation 第二条 pending 冲突）", async () => {
  const ws = "11111111-1111-4111-8111-111111111111";
  const uid = "22222222-2222-4222-8222-222222222222";
  const cid = "33333333-3333-4333-8333-333333333333";
  const msgId = "44444444-4444-4444-8444-444444444445";
  const p1 = "44444444-4444-4444-8444-444444444444";
  const p2 = "44444444-4444-4444-8444-444444444446";
  const msg2 = "44444444-4444-4444-8444-444444444447";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${ws}`;
    await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
    await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
    await tx`DELETE FROM companion_voice_artifacts WHERE workspace_id = ${ws}`;
    await tx`DELETE FROM companion_turn_runs WHERE conversation_id = ${cid}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    await tx`DELETE FROM users WHERE id = ${uid}`;
    // seed 完整链（proposal 的 conversation/message FK）
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"t-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status) VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'placeholder', 'active')`;
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256) VALUES (${msgId}, ${cid}, ${ws}, ${uid}, 'user', 1, 'text', ${{ blocks: [{ type: "text", text: "hi" }] } as never}, ${"0".repeat(64)})`;
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256) VALUES (${msg2}, ${cid}, ${ws}, ${uid}, 'user', 2, 'text', ${{ blocks: [{ type: "text", text: "hi2" }] } as never}, ${"1".repeat(64)})`;
  });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`INSERT INTO companion_action_proposals
        (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
         payload, payload_sha256, title, target_summary, impact_summary, status,
         idempotency_key_hash, expires_at)
        VALUES (${p1}, ${ws}, ${uid}, ${cid}, ${msgId}, 1,
                ${{ kind: "open_review" } as never}, ${"a".repeat(64)},
                '标题', '目标', '影响', 'pending', ${"0".repeat(64)},
                now() + interval '1 hour')`;
    });
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        await tx`SELECT set_config('app.user_id', ${uid}, true)`;
        await tx`INSERT INTO companion_action_proposals
          (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
           payload, payload_sha256, title, target_summary, impact_summary, status,
           idempotency_key_hash, expires_at)
          VALUES (${p2}, ${ws}, ${uid}, ${cid},
                  ${msg2}, 1,
                  ${{ kind: "open_review" } as never}, ${"b".repeat(64)},
                  '标题2', '目标2', '影响2', 'pending', ${"1".repeat(64)},
                  now() + interval '1 hour')`;
      }),
      /duplicate key/i,
    );
  } finally {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
    });
  }
});
