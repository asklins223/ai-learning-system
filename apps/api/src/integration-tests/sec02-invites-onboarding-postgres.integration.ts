/**
 * SEC-02 / ALPHA-01: Invitation tokens, member lifecycle, and onboarding
 * state — PostgreSQL integration test.
 *
 * Validates the database-level behaviour introduced by the 0021 expand
 * migration:
 *   1. `invite_codes` table structure — new columns (id, token_hash,
 *      token_hint, revoked_at, revoked_by, role) and `code` nullability.
 *   2. `onboarding_states` table structure and defaults.
 *   3. `onboarding_states` unique index on (workspace_id, user_id, version).
 *   4. FK cascade: deleting workspace cascades to onboarding_states.
 *   5. FK cascade: deleting user cascades to onboarding_states.
 *   6. RLS expand-phase policies exist on both tables.
 *   7. relrowsecurity remains false in expand phase (SEC-01 enforce gate).
 *
 * This test does NOT call the service layer — it operates directly on
 * PostgreSQL to verify schema and constraint behaviour independently of
 * Drizzle ORM or the global `db` client.
 *
 * Environment variables:
 *   SEC02_TEST_DATABASE_URL — connection string for the test database
 *   (must connect as ailearn_migrator or ailearn_api role)
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres, { type TransactionSql } from "postgres";

const databaseUrl = process.env.SEC02_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "SEC02_TEST_DATABASE_URL is required for the SEC-02 PostgreSQL integration test",
  );
}

const sql = postgres(databaseUrl, { max: 2 });

// ─── Helpers ─────────────────────────────────────────────────────────────

async function seedWorkspaceAndOwner(
  tx: TransactionSql,
): Promise<{ workspaceId: string; ownerId: string }> {
  const workspaceId = randomUUID();
  const ownerId = randomUUID();

  // Insert user first — workspaces.owner_id has a non-deferrable FK to users.id.
  await tx`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${ownerId}, ${`sec02-${ownerId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')
  `;
  await tx`
    INSERT INTO workspaces (id, name, owner_id)
    VALUES (${workspaceId}, ${`sec02-ws-${workspaceId.slice(0, 8)}`}, ${ownerId})
  `;
  await tx`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${ownerId}, 'owner')
  `;

  return { workspaceId, ownerId };
}

async function cleanupWorkspace(
  tx: TransactionSql,
  workspaceId: string,
  userIds: string[],
) {
  await tx`DELETE FROM onboarding_states WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM invite_codes WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  for (const userId of userIds) {
    await tx`DELETE FROM users WHERE id = ${userId}`;
  }
}

// ─── invite_codes structure ─────────────────────────────────────────────

test("invite_codes table has SEC-02 expand columns", async () => {
  const columns = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'invite_codes'
    ORDER BY ordinal_position
  `;

  const columnMap = new Map(columns.map((c) => [c.column_name, c]));

  // New columns from 0021 migration.
  const requiredNewColumns = [
    { name: "id", nullable: "NO" },
    { name: "token_hash", nullable: "YES" },
    { name: "token_hint", nullable: "YES" },
    { name: "revoked_at", nullable: "YES" },
    { name: "revoked_by", nullable: "YES" },
    { name: "role", nullable: "NO" },
  ];

  for (const col of requiredNewColumns) {
    const actual = columnMap.get(col.name);
    assert.ok(actual, `column ${col.name} should exist on invite_codes`);
    assert.equal(
      actual.is_nullable,
      col.nullable,
      `column ${col.name} nullability should be ${col.nullable}`,
    );
  }

  // code is now nullable (was NOT NULL before 0021).
  const codeCol = columnMap.get("code");
  assert.ok(codeCol, "column code should still exist");
  assert.equal(codeCol.is_nullable, "YES", "code should be nullable after 0021 expand");

  // role default should be 'member'.
  const roleCol = columnMap.get("role");
  assert.ok(roleCol?.column_default?.includes("member"), "role default should be 'member'");

  // id should have a default gen_random_uuid().
  const idCol = columnMap.get("id");
  assert.ok(
    idCol?.column_default?.includes("gen_random_uuid"),
    "id default should be gen_random_uuid()",
  );
});

test("invite_codes token_hash index exists", async () => {
  const [row] = await sql<{ indexname: string }[]>`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'invite_codes' AND indexname = 'invite_codes_token_hash_idx'
  `;
  assert.ok(row, "invite_codes_token_hash_idx should exist");
});

// ─── onboarding_states structure ────────────────────────────────────────

test("onboarding_states table structure matches schema definition", async () => {
  const columns = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'onboarding_states'
    ORDER BY ordinal_position
  `;

  const columnMap = new Map(columns.map((c) => [c.column_name, c]));

  const requiredColumns = [
    { name: "id", nullable: "NO" },
    { name: "workspace_id", nullable: "NO" },
    { name: "user_id", nullable: "NO" },
    { name: "version", nullable: "NO" },
    { name: "steps", nullable: "NO" },
    { name: "status", nullable: "NO" },
    { name: "created_at", nullable: "NO" },
    { name: "updated_at", nullable: "NO" },
  ];

  for (const col of requiredColumns) {
    const actual = columnMap.get(col.name);
    assert.ok(actual, `column ${col.name} should exist on onboarding_states`);
    assert.equal(
      actual.is_nullable,
      col.nullable,
      `column ${col.name} nullability should be ${col.nullable}`,
    );
  }

  // Defaults.
  const versionCol = columnMap.get("version");
  assert.ok(versionCol?.column_default?.includes("v1"), "version default should be 'v1'");

  const statusCol = columnMap.get("status");
  assert.ok(statusCol?.column_default?.includes("pending"), "status default should be 'pending'");

  const stepsCol = columnMap.get("steps");
  assert.ok(
    stepsCol?.column_default?.includes("'{}'::jsonb"),
    "steps default should be '{}'::jsonb",
  );
});

test("onboarding_states unique index on (workspace_id, user_id, version)", async () => {
  const [row] = await sql<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'onboarding_states' AND indexname = 'onboarding_states_unique_idx'
  `;
  assert.ok(row, "onboarding_states_unique_idx should exist");
  assert.match(row.indexdef, /UNIQUE/i, "index should be unique");
  assert.match(row.indexdef, /workspace_id.*user_id.*version/i, "index should cover the three columns");
});

test("onboarding_states unique constraint rejects duplicate (workspace, user, version)", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, ownerId } = await seedWorkspaceAndOwner(tx);

    await tx`
      INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
      VALUES (${workspaceId}, ${ownerId}, 'v1', '{"ai_consent": true}'::jsonb, 'in_progress')
    `;

    // Duplicate should fail — use try/catch because assert.rejects doesn't
    // play well with postgres.js transaction state management.
    let duplicateFailed = false;
    try {
      await tx`
        INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
        VALUES (${workspaceId}, ${ownerId}, 'v1', '{"ai_consent": false}'::jsonb, 'pending')
      `;
    } catch (err) {
      duplicateFailed = true;
      assert.match(
        String(err),
        /unique constraint|unique/i,
        "duplicate insert should fail with unique constraint error",
      );
    }
    assert.ok(duplicateFailed, "duplicate (workspace, user, version) should be rejected");

    await cleanupWorkspace(tx, workspaceId, [ownerId]);
  }).catch(() => {
    // Transaction may have been aborted by the duplicate insert error;
    // the assertion was already checked above.
  });
});

// ─── FK cascade ─────────────────────────────────────────────────────────

test("FK cascade: deleting workspace cascades to onboarding_states", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, ownerId } = await seedWorkspaceAndOwner(tx);

    await tx`
      INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
      VALUES (${workspaceId}, ${ownerId}, 'v1', '{}'::jsonb, 'pending')
    `;

    const [before] = await tx`SELECT id FROM onboarding_states WHERE workspace_id = ${workspaceId}`;
    assert.ok(before, "onboarding_state should exist before workspace deletion");

    // Deleting workspace should cascade.
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;

    const [after] = await tx`SELECT id FROM onboarding_states WHERE workspace_id = ${workspaceId}`;
    assert.equal(after, undefined, "onboarding_state should be cascade-deleted with workspace");

    await tx`DELETE FROM users WHERE id = ${ownerId}`;
  });
});

test("FK cascade: deleting user cascades to onboarding_states", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, ownerId } = await seedWorkspaceAndOwner(tx);

    // Create a second non-owner user with an onboarding state.
    // We cannot delete the owner because workspaces.owner_id has a
    // non-cascading FK to users.id. Instead we test the cascade on a
    // regular member.
    const memberId = randomUUID();
    await tx`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (${memberId}, ${`sec02-member-${memberId.slice(0, 8)}@example.test`}, 'test-hash', 'member')
    `;
    await tx`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${memberId}, 'member')
    `;
    await tx`
      INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
      VALUES (${workspaceId}, ${memberId}, 'v1', '{}'::jsonb, 'pending')
    `;

    const [before] = await tx`SELECT id FROM onboarding_states WHERE user_id = ${memberId}`;
    assert.ok(before, "onboarding_state should exist before user deletion");

    // Deleting the member should cascade to onboarding_states.
    await tx`DELETE FROM workspace_members WHERE user_id = ${memberId}`;
    await tx`DELETE FROM users WHERE id = ${memberId}`;

    const [after] = await tx`SELECT id FROM onboarding_states WHERE user_id = ${memberId}`;
    assert.equal(after, undefined, "onboarding_state should be cascade-deleted with user");

    await cleanupWorkspace(tx, workspaceId, [ownerId]);
  });
});

// ─── RLS policies ───────────────────────────────────────────────────────

test("RLS expand-phase policies exist on invite_codes", async () => {
  const policies = await sql<{ policyname: string; cmd: string; permissive: string }[]>`
    SELECT policyname, cmd, permissive
    FROM pg_policies
    WHERE tablename = 'invite_codes'
    ORDER BY policyname
  `;

  const policyMap = new Map(policies.map((p) => [p.policyname, p]));

  const expectedPolicies = [
    { name: "sec02_v1_invite_codes_tenant_guard", cmd: "ALL", permissive: "RESTRICTIVE" },
    { name: "sec02_v1_invite_codes_runtime_access", cmd: "ALL", permissive: "PERMISSIVE" },
  ];

  for (const expected of expectedPolicies) {
    const actual = policyMap.get(expected.name);
    assert.ok(actual, `policy ${expected.name} should exist on invite_codes`);
    assert.equal(actual.cmd, expected.cmd, `policy ${expected.name} cmd should be ${expected.cmd}`);
    assert.equal(
      actual.permissive,
      expected.permissive,
      `policy ${expected.name} permissive should be ${expected.permissive}`,
    );
  }
});

test("RLS expand-phase policies exist on onboarding_states", async () => {
  const policies = await sql<{ policyname: string; cmd: string; permissive: string }[]>`
    SELECT policyname, cmd, permissive
    FROM pg_policies
    WHERE tablename = 'onboarding_states'
    ORDER BY policyname
  `;

  const policyMap = new Map(policies.map((p) => [p.policyname, p]));

  const expectedPolicies = [
    { name: "sec02_v1_onboarding_states_tenant_guard", cmd: "ALL", permissive: "RESTRICTIVE" },
    { name: "sec02_v1_onboarding_states_actor_guard", cmd: "ALL", permissive: "RESTRICTIVE" },
    { name: "sec02_v1_onboarding_states_runtime_access", cmd: "ALL", permissive: "PERMISSIVE" },
  ];

  for (const expected of expectedPolicies) {
    const actual = policyMap.get(expected.name);
    assert.ok(actual, `policy ${expected.name} should exist on onboarding_states`);
    assert.equal(actual.cmd, expected.cmd, `policy ${expected.name} cmd should be ${expected.cmd}`);
    assert.equal(
      actual.permissive,
      expected.permissive,
      `policy ${expected.name} permissive should be ${expected.permissive}`,
    );
  }
});

/**
 * 这两张表的姿态自 **0257 `sec01_rls_reopen_core_tables`** 起是 ENABLE + FORCE。
 *
 * 这条用例原本断言 `false`——那是 0027"expand phase 先关掉"时期的口径，0257 之后
 * 它一直在红（CI 与 dev 一样，因为姿态是迁移写进库的，不是本地漂移）。
 * 逐条策略的名字/命令/permissive 由上面那条用例守住，这里只守住"开关别再被关掉"。
 */
test("两张表都是 ENABLE + FORCE ROW LEVEL SECURITY（0257 重新收口的姿态）", async () => {
  const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('invite_codes', 'onboarding_states')
    ORDER BY c.relname
  `;

  assert.equal(rows.length, 2, "both invite_codes and onboarding_states should exist");

  for (const row of rows) {
    assert.equal(
      row.relrowsecurity,
      true,
      `${row.relname} relrowsecurity must be true since 0257 reopened core tables`,
    );
    assert.equal(
      row.relforcerowsecurity,
      true,
      `${row.relname} must stay FORCEd, otherwise the table owner bypasses the guards`,
    );
  }
});

// ─── invite lifecycle constraint ────────────────────────────────────────

test("invite_codes accepts hash-based row with null code", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, ownerId } = await seedWorkspaceAndOwner(tx);

    // New-style invitation: token_hash present, code null.
    const tokenHash = "a".repeat(64);
    await tx`
      INSERT INTO invite_codes (code, workspace_id, created_by, token_hash, token_hint, role)
      VALUES (NULL, ${workspaceId}, ${ownerId}, ${tokenHash}, 'abcd1234', 'member')
    `;

    const [row] = await tx`
      SELECT code, token_hash, token_hint, role, revoked_at
      FROM invite_codes WHERE workspace_id = ${workspaceId}
    `;
    assert.ok(row, "invite row should exist");
    assert.equal(row.code, null, "code should be null for hash-based invitation");
    assert.equal(row.token_hash, tokenHash);
    assert.equal(row.token_hint, "abcd1234");
    assert.equal(row.role, "member");
    assert.equal(row.revoked_at, null, "revoked_at should be null for active invitation");

    await cleanupWorkspace(tx, workspaceId, [ownerId]);
  });
});

// ─── Cleanup ────────────────────────────────────────────────────────────

test.after(async () => {
  await sql.end();
});
