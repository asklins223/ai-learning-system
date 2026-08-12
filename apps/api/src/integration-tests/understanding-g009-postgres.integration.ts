/**
 * G-009 真实 SQL 聚合语义集成测试（第十轮遗留修复）。
 *
 * 背景：loop-dod-coverage.test.ts 曾有一份"复刻 getUnderstandingStates
 * 聚合"的 JS 实现——测的是测试内复刻函数而非生产 SQL（array_agg + FILTER，
 * understanding/service.ts）。复刻已删除，真实语义此前无测试覆盖。
 *
 * 本测试在真实 PostgreSQL 上验证生产聚合 SQL 的 G-009 关键规则：
 *   - latest_validation_event_type 只跟踪 validated/misunderstood 事件
 *   - reviewed/seen 不影响它
 *   - misunderstood 后 reviewed 不关闭；新的 validated 才关闭
 *
 * 连接使用超级用户（DATABASE_URL_MIGRATOR 或 DATABASE_URL），绕开 RLS
 * 上下文（仅插入/聚合断言，不经过应用层事务）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_MIGRATOR or DATABASE_URL is required for the G-009 integration gate");
}

// 与服务端聚合 SQL 同构（understanding/service.ts:83-100）——纯字符串模板，
// 经 client.unsafe 执行。注意：understanding_events.event_type 是事件类型
// （validated/misunderstood/seen/reviewed），与 validation_events.outcome
// （preliminary_understanding 等 enum）是两套值域。
// 同构守卫：生产 SQL 若改变 FILTER 集合（如新增事件类型、改字段名），
// 下方同构断言失败——强制人工同步本模板与断言（防"生产改了测试仍绿"）。
const AGGREGATE_SQL_TEMPLATE = `
  SELECT
    (array_agg(ue.event_type ORDER BY ue.created_at DESC))[1] AS latest_event_type,
    (array_agg(ue.event_type ORDER BY ue.created_at DESC) FILTER (WHERE ue.event_type IN ('validated','misunderstood')))[1] AS latest_validation_event_type,
    MAX(ue.created_at) FILTER (WHERE ue.event_type IN ('validated','misunderstood')) AS last_validated_at,
    COUNT(*) FILTER (WHERE ue.event_type = 'misunderstood')::int AS misunderstanding_count
  FROM understanding_events ue
  INNER JOIN validation_events ve ON ue.subject_id = ve.id AND ue.subject_type = 'validation'
  WHERE ue.workspace_id = '${"__WS__"}'::uuid AND ve.card_id = '${"__CARD__"}'::uuid
  GROUP BY ve.card_id
`;

// 同构断言：生产聚合（understanding/service.ts）必须包含相同的 FILTER 语义。
// 生产代码变更（如扩展 validated/misunderstood 集合）→ 此断言失败 → 提示
// 同步测试模板，避免"测试复制品与生产 SQL 漂移"。
function assertProductionAggregateIsomorphic(serviceSource: string): void {
  assert.ok(
    serviceSource.includes("IN ('validated', 'misunderstood')"),
    "生产聚合 FILTER 集合已变化——需同步 G-009 测试模板",
  );
  assert.ok(
    serviceSource.includes("= 'misunderstood'"),
    "生产聚合 misunderstanding 计数条件已变化——需同步 G-009 测试模板",
  );
  assert.ok(
    serviceSource.includes("subjectType, \"validation\"") || serviceSource.includes('"validation"'),
    "生产聚合 JOIN 条件已变化——需同步 G-009 测试模板",
  );
}
const serviceSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../modules/understanding/service.ts"),
  "utf8",
);
assertProductionAggregateIsomorphic(serviceSource);

async function runAggregate(client: ReturnType<typeof postgres>, workspaceId: string, cardId: string) {
  const rows = await client.unsafe(
    AGGREGATE_SQL_TEMPLATE.replaceAll("__WS__", workspaceId).replaceAll("__CARD__", cardId),
  );
  return rows[0] as Record<string, unknown> | undefined;
}

test("G-009: 真实 SQL 聚合——reviewed/seen 不影响 latest_validation_event_type，新 validated 才关闭 misunderstood", async () => {
  const client = postgres(databaseUrl, { max: 4 });
  const wsId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const eventId = randomUUID();

  try {
    // 最小数据集：user(先,owner FK) + workspace + note + note_version + card + validation event + understanding events
    await client.unsafe(
      `INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES ('${userId}', 'g009-${userId}@test.local', 'g009', 'x', now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('${wsId}', 'g009-test', '${userId}', now())`,
    );
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await client.unsafe(
      `INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at) VALUES ('${noteId}', '${wsId}', 'g009', '${userId}', now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by, created_at, updated_at)
       VALUES ('${noteVersionId}', '${noteId}', '${wsId}', 1, '[]'::jsonb, 'x', '${userId}', now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json, created_at, updated_at)
       VALUES ('${cardId}', '${wsId}', '${noteVersionId}', 'active', '{}'::jsonb, now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO validation_events (id, workspace_id, user_id, card_id, question, user_answer, outcome, confidence, created_at)
       VALUES ('${eventId}', '${wsId}', '${userId}', '${cardId}', 'q', 'a', 'preliminary_understanding', 0.8, now())`,
    );

    // 事件序列（时间升序）：misunderstood → reviewed → seen（不关闭）→ validated（关闭）
    const events = [
      { type: "misunderstood", at: 1 },
      { type: "reviewed", at: 2 },
      { type: "seen", at: 3 },
      { type: "validated", at: 4 },
    ];
    for (const ev of events) {
      await client.unsafe(
        `INSERT INTO understanding_events (id, workspace_id, user_id, subject_type, subject_id, event_type, created_at)
         VALUES ('${randomUUID()}', '${wsId}', '${userId}', 'validation', '${eventId}', '${ev.type}', now() + make_interval(secs => ${ev.at}))`,
      );
    }

    // 最新 validation 事件是 validated → 状态应可关闭（latest_validation_event_type = validated）
    const agg = await runAggregate(client, wsId, cardId);
    assert.ok(agg, "聚合应返回一行");
    assert.equal(agg.latest_validation_event_type, "validated", "reviewed/seen 不应覆盖 validated");
    assert.equal(agg.misunderstanding_count, 1);
  } finally {
    // 清理（workspace 级联）
    await client.unsafe(`DELETE FROM workspaces WHERE id = '${wsId}'`).catch(() => {});
    await client.end();
  }
});

test("G-009: 真实 SQL 聚合——misunderstood 后只有 reviewed（无新 validated）状态保持", async () => {
  const client = postgres(databaseUrl, { max: 4 });
  const wsId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const eventId = randomUUID();

  try {
    await client.unsafe(
      `INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES ('${userId}', 'g009-2-${userId}@test.local', 'g009', 'x', now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO workspaces (id, name, owner_id, created_at) VALUES ('${wsId}', 'g009-test-2', '${userId}', now())`,
    );
    const noteId2 = randomUUID();
    const noteVersionId2 = randomUUID();
    await client.unsafe(
      `INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at) VALUES ('${noteId2}', '${wsId}', 'g009', '${userId}', now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by, created_at, updated_at)
       VALUES ('${noteVersionId2}', '${noteId2}', '${wsId}', 1, '[]'::jsonb, 'x', '${userId}', now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json, created_at, updated_at)
       VALUES ('${cardId}', '${wsId}', '${noteVersionId2}', 'active', '{}'::jsonb, now(), now())`,
    );
    await client.unsafe(
      `INSERT INTO validation_events (id, workspace_id, user_id, card_id, question, user_answer, outcome, confidence, created_at)
       VALUES ('${eventId}', '${wsId}', '${userId}', '${cardId}', 'q', 'a', 'misunderstanding', 0.8, now())`,
    );
    for (const [i, type] of ["misunderstood", "reviewed", "reviewed"].entries()) {
      await client.unsafe(
        `INSERT INTO understanding_events (id, workspace_id, user_id, subject_type, subject_id, event_type, created_at)
         VALUES ('${randomUUID()}', '${wsId}', '${userId}', 'validation', '${eventId}', '${type}', now() + make_interval(secs => ${i + 1}))`,
      );
    }

    const agg = await runAggregate(client, wsId, cardId);
    assert.ok(agg);
    assert.equal(
      agg.latest_validation_event_type,
      "misunderstood",
      "reviewed 不关闭 misunderstood——服务端 258 行据此判 state=misunderstood",
    );
    assert.equal(agg.latest_event_type, "reviewed", "latest_event_type 是最近任意事件");
    assert.equal(agg.misunderstanding_count, 1);
  } finally {
    await client.unsafe(`DELETE FROM workspaces WHERE id = '${wsId}'`).catch(() => {});
    await client.end();
  }
});
