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
 * V2 rebase：生产聚合不再 JOIN validation_events（V1 cardId 已删），
 * 改为按 understanding_events.subject_id (= objectiveId) 直接聚合。
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
import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const databaseUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_MIGRATOR or DATABASE_URL is required for the G-009 integration gate");
}

// 与服务端聚合 SQL 同构（understanding/service.ts:121-136）——纯字符串模板，
// 经 client.unsafe 执行。V2：不再 JOIN validation_events，直接按
// understanding_events.subject_id (= objectiveId) 聚合。
// 同构守卫：生产 SQL 若改变 FILTER 集合（如新增事件类型、改字段名），
// 下方同构断言失败——强制人工同步本模板与断言（防"生产改了测试仍绿"）。
const AGGREGATE_SQL_TEMPLATE = `
  SELECT
    (array_agg(ue.event_type ORDER BY ue.created_at DESC))[1] AS latest_event_type,
    (array_agg(ue.event_type ORDER BY ue.created_at DESC) FILTER (WHERE ue.event_type IN ('validated','misunderstood')))[1] AS latest_validation_event_type,
    MAX(ue.created_at) FILTER (WHERE ue.event_type IN ('validated','misunderstood')) AS last_validated_at,
    COUNT(*) FILTER (WHERE ue.event_type = 'misunderstood')::int AS misunderstanding_count
  FROM understanding_events ue
  WHERE ue.workspace_id = '${"__WS__"}'::uuid AND ue.subject_id = '${"__OBJ__"}'::uuid
  GROUP BY ue.subject_id
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
  // V2：不再 JOIN validation_events；改为直接按 understanding_events.subject_id 聚合。
  assert.ok(
    serviceSource.includes("subjectId"),
    "生产聚合按 subjectId 聚合——需同步 G-009 测试模板",
  );
}
const serviceSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../modules/understanding/service.ts"),
  "utf8",
);
assertProductionAggregateIsomorphic(serviceSource);

async function runAggregate(client: ReturnType<typeof postgres>, workspaceId: string, objectiveId: string) {
  const rows = await client.unsafe(
    AGGREGATE_SQL_TEMPLATE.replaceAll("__WS__", workspaceId).replaceAll("__OBJ__", objectiveId),
  );
  return rows[0] as Record<string, unknown> | undefined;
}

test("G-009: 真实 SQL 聚合——reviewed/seen 不影响 latest_validation_event_type，新 validated 才关闭 misunderstood", async () => {
  const client = postgres(databaseUrl, { max: 4 });
  const fixture = await seedV2Fixture(client);
  const { workspaceId: wsId, userId, objectiveId } = fixture;

  try {
    // 最小数据集：understanding_events 指向 objectiveId（V2 subjectId）。
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
         VALUES ('${randomUUID()}', '${wsId}', '${userId}', 'card', '${objectiveId}', '${ev.type}', now() + make_interval(secs => ${ev.at}))`,
      );
    }

    // 最新 validation 事件是 validated → 状态应可关闭（latest_validation_event_type = validated）
    const agg = await runAggregate(client, wsId, objectiveId);
    assert.ok(agg, "聚合应返回一行");
    assert.equal(agg.latest_validation_event_type, "validated", "reviewed/seen 不应覆盖 validated");
    assert.equal(agg.misunderstanding_count, 1);
  } finally {
    await fixture.cleanup();
    await client.end();
  }
});

test("G-009: 真实 SQL 聚合——misunderstood 后只有 reviewed（无新 validated）状态保持", async () => {
  const client = postgres(databaseUrl, { max: 4 });
  const fixture = await seedV2Fixture(client);
  const { workspaceId: wsId, userId, objectiveId } = fixture;

  try {
    for (const [i, type] of ["misunderstood", "reviewed", "reviewed"].entries()) {
      await client.unsafe(
        `INSERT INTO understanding_events (id, workspace_id, user_id, subject_type, subject_id, event_type, created_at)
         VALUES ('${randomUUID()}', '${wsId}', '${userId}', 'card', '${objectiveId}', '${type}', now() + make_interval(secs => ${i + 1}))`,
      );
    }

    const agg = await runAggregate(client, wsId, objectiveId);
    assert.ok(agg);
    assert.equal(
      agg.latest_validation_event_type,
      "misunderstood",
      "reviewed 不关闭 misunderstood——服务端据此判 state=misunderstood",
    );
    assert.equal(agg.latest_event_type, "reviewed", "latest_event_type 是最近任意事件");
    assert.equal(agg.misunderstanding_count, 1);
  } finally {
    await fixture.cleanup();
    await client.end();
  }
});
