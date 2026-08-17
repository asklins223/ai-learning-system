/**
 * Plan 23 W1-01..W1-08 集成测试（真实 Postgres）。
 *
 * 验证迁移 0175：
 *  1. learning_objective_origins_v2 / legacy_route_mappings_v2 存在且 FORCE RLS；
 *  2. concept_label / compatibility_role / surface_revision / surface_updated_at 列存在；
 *  3. Origin RLS：跨 workspace 读写拒绝；本 workspace 读写通过（事务内 set_config）；
 *  4. Origin kind 条件约束：note 缺 note_version_id 拒绝、manual 带 note 拒绝；
 *  5. 同一 objective revision + note version 重复绑定被唯一索引拒绝；
 *  6. route mapping mapped 必须带 objective / status 枚举。
 *
 * 环境：DATABASE_URL_API_RLS（默认 ailearn_api，非 superuser——dev 的 ailearn 是
 * superuser，无条件绕过 RLS 即使 FORCE RLS 也不生效）。无 DB fail closed。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const CONN =
  process.env.DATABASE_URL_API_RLS ??
  "postgres://ailearn_api:ailearn_dev@localhost:5432/ailearn";

function mustConnect() {
  if (!CONN) {
    throw new Error("DATABASE_URL_API_RLS 未配置——W1 集成测试要求真实 Postgres");
  }
  return postgres(CONN, { max: 4 });
}

test("W1-01/07/04: 0175 新表存在且 FORCE RLS", async () => {
  const sql = mustConnect();
  try {
    const rows = await sql`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
      FROM pg_class c
      WHERE c.relname IN ('learning_objective_origins_v2','legacy_route_mappings_v2')
      ORDER BY 1
    `;
    assert.equal(rows.length, 2, "新表缺失");
    for (const row of rows) {
      assert.equal(row.rls, true, row.table_name + " 未 ENABLE RLS");
      assert.equal(row.force_rls, true, row.table_name + " 未 FORCE RLS");
    }
    const policies = await sql`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('learning_objective_origins_v2','legacy_route_mappings_v2')
    `;
    assert.equal(policies.length, 2, "每张新表至少一个 policy");
  } finally {
    await sql.end();
  }
});

test("W1-05/06/08: 列存在（concept_label / compatibility_role / surface_revision / surface_updated_at）", async () => {
  const sql = mustConnect();
  try {
    const rows = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'learning_objective_revisions_v2' AND column_name = 'concept_label')
        OR (table_name = 'learning_cards' AND column_name = 'compatibility_role')
        OR (table_name = 'learning_objectives_v2' AND column_name IN ('surface_revision','surface_updated_at'))
      )
    `;
    const key = rows.map((r) => r.table_name + "." + r.column_name).sort();
    assert.deepEqual(key, [
      "learning_cards.compatibility_role",
      "learning_objective_revisions_v2.concept_label",
      "learning_objectives_v2.surface_revision",
      "learning_objectives_v2.surface_updated_at",
    ]);
  } finally {
    await sql.end();
  }
});

test("W1-04: Origin RLS 跨 workspace 隔离", async () => {
  const sql = mustConnect();
  const wsA = randomUUID();
  const wsB = randomUUID();
  const originId = randomUUID();
  const objectiveId = randomUUID();
  const revisionId = randomUUID();
  try {
    // 本 workspace 写入并读取
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${wsA}, true)`;
      await tx`
        INSERT INTO learning_objective_origins_v2
          (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
        VALUES (${wsA}, ${originId}, ${objectiveId}, ${revisionId}, 'manual')
      `;
    });
    const own = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${wsA}, true)`;
      return tx`SELECT count(*)::int AS n FROM learning_objective_origins_v2 WHERE workspace_id = ${wsA}`;
    });
    assert.equal(Number(own[0].n), 1);

    // 切到另一 workspace 读不到（FORCE RLS 过滤）
    const other = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${wsB}, true)`;
      return tx`SELECT count(*)::int AS n FROM learning_objective_origins_v2 WHERE origin_id = ${originId}`;
    });
    assert.equal(Number(other[0].n), 0);

    // 跨 workspace 写入被拒绝（wsB 上下文中插入 wsA 行 → WITH CHECK 失败）
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${wsB}, true)`;
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
          VALUES (${wsA}, ${originId}, ${objectiveId}, ${revisionId}, 'manual')
        `;
      }),
      /row-level security policy/,
    );
  } finally {
    await sql`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${wsA}`.catch(() => {});
    await sql.end();
  }
});

test("W1-02: Origin kind 条件约束", async () => {
  const sql = mustConnect();
  const ws = randomUUID();
  try {
    const base = (tx: postgres.TransactionSql<Record<string, never>>) =>
      tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    // note 缺 note_version_id → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await base(tx);
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id)
          VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'note', ${randomUUID()})
        `;
      }),
      /loo_v2_kind_fields_chk/,
      "note 缺 note_version_id",
    );
    // manual 带 note → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await base(tx);
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id)
          VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'manual', ${randomUUID()}, ${randomUUID()})
        `;
      }),
      /loo_v2_kind_fields_chk/,
      "manual 带 note",
    );
    // imported 缺 import_batch_ref → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await base(tx);
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
          VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'imported')
        `;
      }),
      /loo_v2_kind_fields_chk/,
      "imported 缺 import_batch_ref",
    );
    // 有效 manual → 通过
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`
        INSERT INTO learning_objective_origins_v2
          (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
        VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'manual')
      `;
    });
  } finally {
    await sql`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${ws}`.catch(() => {});
    await sql.end();
  }
});

test("W1-03: 同一 objective revision + note version 重复绑定被唯一索引拒绝", async () => {
  const sql = mustConnect();
  const ws = randomUUID();
  const objectiveRevisionId = randomUUID();
  const noteVersionId = randomUUID();
  try {
    const insert = (tx: postgres.TransactionSql<Record<string, never>>) =>
      tx`
        INSERT INTO learning_objective_origins_v2
          (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id)
        VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${objectiveRevisionId}, 'note', ${randomUUID()}, ${noteVersionId})
      `;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await insert(tx);
    });
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        await insert(tx);
      }),
      /loo_v2_note_binding_unique_idx/,
    );
  } finally {
    await sql`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${ws}`.catch(() => {});
    await sql.end();
  }
});

test("W1-07: route mapping 约束（mapped 必须带 objective；status 枚举）", async () => {
  const sql = mustConnect();
  const ws = randomUUID();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`
        INSERT INTO legacy_route_mappings_v2 (workspace_id, mapping_id, legacy_kind, legacy_id, status, objective_id)
        VALUES (${ws}, ${randomUUID()}, 'card', ${randomUUID()}, 'mapped', ${randomUUID()})
      `;
    });
    // mapped 缺 objective → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        await tx`
          INSERT INTO legacy_route_mappings_v2 (workspace_id, mapping_id, legacy_kind, legacy_id, status)
          VALUES (${ws}, ${randomUUID()}, 'key_point', ${randomUUID()}, 'mapped')
        `;
      }),
      /lrm_v2_mapped_chk/,
    );
    // 非法 status → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        await tx`
          INSERT INTO legacy_route_mappings_v2 (workspace_id, mapping_id, legacy_kind, legacy_id, status)
          VALUES (${ws}, ${randomUUID()}, 'card', ${randomUUID()}, 'weird')
        `;
      }),
      /lrm_v2_status_chk/,
    );
  } finally {
    await sql`DELETE FROM legacy_route_mappings_v2 WHERE workspace_id = ${ws}`.catch(() => {});
    await sql.end();
  }
});
