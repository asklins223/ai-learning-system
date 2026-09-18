/**
 * assistant_deliveries.kind 的「代码集合 == 数据库约束」对账（2026-09-16 修复回归）。
 *
 * 背景（真实缺陷，非理论风险）：0131 手写的
 * `assistant_deliveries_kind_check` 漏掉了 `memory_candidate`，而 worker 的记忆抽取
 * handler 恰好写入该 kind——INSERT 与候选记忆写入在同一个
 * withWorkerWorkspaceTransaction 内，CHECK 违例中止整个事务，等于「记忆抽取一旦
 * 找到候选就整体失败」。四份各自维护的 kind 清单（TS union / zod enum /
 * timeline / DB CHECK）里任何一份落后都会重现这个 bug。
 *
 * 现在 kind 清单只有一个来源：shared 的 ASSISTANT_DELIVERY_KIND_VALUES，
 * 本测试断言数据库约束与它精确相等（既不能少一个，也不能多一个死值）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ASSISTANT_DELIVERY_KIND_VALUES } from "@ailearn/shared";

const CONN = process.env.DATABASE_URL_API
  ?? "postgres://ailearn_api:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 1 });

after(async () => {
  await sql.end({ timeout: 2 });
});

test("assistant_deliveries_kind_check 与 shared 的 kind 清单精确一致", async () => {
  const rows = await sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.assistant_deliveries'::regclass
      AND conname = 'assistant_deliveries_kind_check'
  `;
  assert.equal(rows.length, 1, "assistant_deliveries_kind_check 必须存在");

  // 从 CHECK 定义里提取字符串字面量（'message'::text → message）。
  const allowed = [...rows[0].def.matchAll(/'([a-z_]+)'(?:::text)?/g)].map((m) => m[1]).sort();
  const declared: string[] = [...ASSISTANT_DELIVERY_KIND_VALUES].sort();
  assert.deepEqual(
    allowed,
    declared,
    `数据库允许的 delivery kind 必须与 shared 声明完全一致：`
    + `missing_in_db=${declared.filter((k) => !allowed.includes(k)).join(",") || "-"} `
    + `extra_in_db=${allowed.filter((k) => !declared.includes(k)).join(",") || "-"}`,
  );
});

test("每个声明的 kind 都能真实写入（含此前的 memory_candidate）", async () => {
  const seeded = await sql<{ workspace_id: string; user_id: string }[]>`
    SELECT w.id AS workspace_id, u.id AS user_id
    FROM workspaces w
    JOIN users u ON u.id = (
      SELECT id FROM users ORDER BY created_at LIMIT 1
    )
    ORDER BY w.created_at
    LIMIT 1
  `;
  if (seeded.length === 0) return; // 空库：约束集合断言已在上一条覆盖
  const { workspace_id: workspaceId, user_id: userId } = seeded[0];

  // delivery kind 与 payload_ref kind 是一对一映射（见 AssistantDeliveryPayloadRefV2）：
  // memory_candidate 交付携带 memory_item payload。这里逐 kind 构造最小合法 payload，
  // 目的是证明「代码写得出」与「库允许写」一致。
  const payloadRefFor = (kind: (typeof ASSISTANT_DELIVERY_KIND_VALUES)[number]): Record<string, unknown> => {
    switch (kind) {
      case "message":
        return { kind: "message", messageId: crypto.randomUUID() };
      case "proposal":
        return { kind: "proposal", proposalId: crypto.randomUUID() };
      case "action_result":
        return { kind: "action_result", proposalId: crypto.randomUUID() };
      case "system_event":
        return { kind: "system_event", systemEventId: `probe:${crypto.randomUUID()}` };
      case "memory_candidate":
        return { kind: "memory_item", memoryItemId: crypto.randomUUID(), contentPreview: "候选记忆" };
    }
  };

  for (const [index, kind] of ASSISTANT_DELIVERY_KIND_VALUES.entries()) {
    const payload = JSON.stringify(payloadRefFor(kind));
    const dedupeKey = `kind-constraint-probe:${kind}:${index}`;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${userId}, true)`;
        await tx`
          INSERT INTO assistant_deliveries
            (workspace_id, user_id, inbox_sequence, dedupe_key, state, kind, payload_ref, expires_at)
          SELECT ${workspaceId}, ${userId}, COALESCE(MAX(inbox_sequence), 0) + 1,
                 ${dedupeKey}, 'queued', ${kind}, ${payload}::jsonb, now() + interval '1 hour'
          FROM assistant_deliveries
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
          ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING
        `;
      });
    } finally {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${userId}, true)`;
        await tx`DELETE FROM assistant_deliveries WHERE dedupe_key = ${dedupeKey}`;
      });
    }
  }
});
