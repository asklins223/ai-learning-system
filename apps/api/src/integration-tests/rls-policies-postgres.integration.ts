import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
const POLICY_CATALOG_REPAIR_STATEMENTS = readFileSync(
  new URL("../db/migrations/0039_sec01_policy_catalog_repair.sql", import.meta.url),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const POLICY_TABLES = [
  "workspaces",
  "workspace_members",
  "invite_codes",
  "sources",
  "source_segments",
  "notes",
  "note_versions",
  "note_blocks",
  // V1 tables removed: learning_cards, card_key_points, evidences
  "validation_questions",
  "search_documents",
  "ai_artifacts",
  "ai_audit_log",
  "benchmark_reports",
  "benchmark_labels",
  "evidence_overrides",
  "validation_events",
  "review_schedules",
  "review_attempts",
  "understanding_events",
  "jobs",
] as const;

const WORKSPACE_POLICY_TABLES = POLICY_TABLES.filter((table) => ![
  "evidence_overrides",
  "validation_events",
  "review_schedules",
  "review_attempts",
  "understanding_events",
  "validation_questions",
  "ai_artifacts",
  "ai_audit_log",
  "jobs",
].includes(table));

const USER_PRIVATE_POLICY_TABLES = [
  "evidence_overrides",
  "validation_events",
  "review_schedules",
  "review_attempts",
  "understanding_events",
] as const;

const API_ONLY_WORKSPACE_TABLES = new Set([
  "workspace_members",
  "invite_codes",
  "benchmark_reports",
  "benchmark_labels",
]);

const JOB_POLICIES = new Map([
  ["sec01_v1_jobs_tenant_guard", { command: "ALL", permissive: "RESTRICTIVE" }],
  ["sec01_v1_jobs_insert_actor_guard", { command: "INSERT", permissive: "RESTRICTIVE" }],
  ["sec01_v1_jobs_worker_update_actor_guard", { command: "UPDATE", permissive: "RESTRICTIVE" }],
  ["sec01_v1_jobs_api_workspace_select_policy", { command: "SELECT", permissive: "PERMISSIVE" }],
  ["sec01_v1_jobs_api_workspace_insert_actor_policy", { command: "INSERT", permissive: "PERMISSIVE" }],
  ["sec01_v1_jobs_api_workspace_delete_policy", { command: "DELETE", permissive: "PERMISSIVE" }],
  ["sec01_v1_jobs_worker_workspace_select_policy", { command: "SELECT", permissive: "PERMISSIVE" }],
  ["sec01_v1_jobs_worker_workspace_update_policy", { command: "UPDATE", permissive: "PERMISSIVE" }],
  // 0174→0182：worker 自入队类型白名单已改名脱离 sec01_v1_ 托管命名空间，
  // 不再计入本目录（见迁移 0182 注释）。
]);

const AI_ARTIFACT_POLICIES = new Map([
  ["sec01_v1_ai_artifacts_tenant_guard", { command: "ALL", permissive: "RESTRICTIVE" }],
  ["sec01_v1_ai_artifacts_validation_actor_guard", { command: "ALL", permissive: "RESTRICTIVE" }],
  ["sec01_v1_ai_artifacts_runtime_access", { command: "ALL", permissive: "PERMISSIVE" }],
]);

const AI_AUDIT_POLICIES = new Map([
  ["sec01_v1_ai_audit_tenant_guard", { command: "ALL", permissive: "RESTRICTIVE" }],
  ["sec01_v1_ai_audit_insert_actor_guard", { command: "INSERT", permissive: "RESTRICTIVE" }],
  ["sec01_v1_ai_audit_api_owner_read", { command: "SELECT", permissive: "PERMISSIVE" }],
  ["sec01_v1_ai_audit_runtime_insert", { command: "INSERT", permissive: "PERMISSIVE" }],
]);

const TEMPORARILY_ENFORCED_TABLES = [
  "workspaces",
  "sources",
  "validation_questions",
  "validation_events",
  "understanding_events",
  "ai_artifacts",
  "ai_audit_log",
  "jobs",
] as const;

function requireDatabaseUrl(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the PostgreSQL RLS policy integration test`);
  }
  return value;
}

async function assertConnectionIdentity(
  sql: Sql,
  expectedRole: "ailearn_migrator" | "ailearn_api" | "ailearn_worker",
): Promise<{
  databaseName: string;
  databaseOid: string;
  serverAddress: string;
  serverPort: number;
  postmasterStartedAt: string;
  backendPid: number;
  serverVersionNum: number;
}> {
  const [identity] = await sql<{
    current_user: string;
    database_name: string;
    database_oid: string;
    server_address: string;
    server_port: number;
    postmaster_started_at: string;
    backend_pid: number;
    server_version_num: number;
    bypass_rls: boolean;
  }[]>`
    SELECT
      CURRENT_USER::text AS current_user,
      pg_catalog.current_database() AS database_name,
      database.oid::text AS database_oid,
      coalesce(pg_catalog.inet_server_addr()::text, 'local-socket') AS server_address,
      pg_catalog.inet_server_port() AS server_port,
      extract(epoch FROM pg_catalog.pg_postmaster_start_time())::text
        AS postmaster_started_at,
      pg_catalog.pg_backend_pid() AS backend_pid,
      pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
      role.rolbypassrls AS bypass_rls
    FROM pg_catalog.pg_roles AS role
    CROSS JOIN pg_catalog.pg_database AS database
    WHERE role.rolname = CURRENT_USER
      AND database.datname = pg_catalog.current_database()
  `;
  assert.equal(identity?.current_user, expectedRole);
  assert.equal(identity?.bypass_rls, expectedRole === "ailearn_migrator");
  assert.ok(identity?.database_name);
  assert.ok(identity?.database_oid);
  assert.ok(identity?.server_address);
  assert.ok(identity?.server_port);
  assert.ok(identity?.postmaster_started_at);
  assert.ok(identity?.backend_pid);
  assert.equal(Math.floor(identity.server_version_num / 10_000), 16);
  return {
    databaseName: identity.database_name,
    databaseOid: identity.database_oid,
    serverAddress: identity.server_address,
    serverPort: identity.server_port,
    postmasterStartedAt: identity.postmaster_started_at,
    backendPid: identity.backend_pid,
    serverVersionNum: identity.server_version_num,
  };
}

async function withContext<T>(
  sql: Sql,
  context: { workspaceId?: string; userId?: string },
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    if (context.workspaceId !== undefined) {
      await transaction`
        SELECT pg_catalog.set_config('app.workspace_id', ${context.workspaceId}, true)
      `;
    }
    if (context.userId !== undefined) {
      await transaction`
        SELECT pg_catalog.set_config('app.user_id', ${context.userId}, true)
      `;
    }
    return operation(transaction);
  }) as Promise<T>;
}

async function assertRlsCheckDenied(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as { code?: string }).code, "42501");
    return true;
  });
}

let rlsActiveBeforeReplay: string[] = [];

async function rerunPolicyCatalogRepair(sql: Sql): Promise<void> {
  // 2026-08-23 修复：0039 的守卫按设计"任一目标表已激活 RLS 即拒绝重放"
  // （0024 起生产终态就是激活态，实库必然命中）。本测试重放的是历史修复的
  // 策略形状与 manifest 隔离性——先临时解除清单内表的 RLS（记录原状态），
  // 重放后精确恢复。
  const rlsState = await sql`
    SELECT class.relname AS table_name,
           class.relrowsecurity AS enabled,
           class.relforcerowsecurity AS forced
    FROM pg_catalog.pg_class AS class
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relname = ANY(${sql.array([...POLICY_TABLES])})
      AND (class.relrowsecurity OR class.relforcerowsecurity)
  `;
  const previouslyActive = rlsState.map((r) => String(r.table_name));
  rlsActiveBeforeReplay = previouslyActive;
  try {
    await sql.begin(async (transaction) => {
      for (const tableName of previouslyActive) {
        await transaction.unsafe(`ALTER TABLE public.${tableName} NO FORCE ROW LEVEL SECURITY`);
        await transaction.unsafe(`ALTER TABLE public.${tableName} DISABLE ROW LEVEL SECURITY`);
      }
      for (const statement of POLICY_CATALOG_REPAIR_STATEMENTS) {
        await transaction.unsafe(statement);
      }
    });
  } finally {
    for (const tableName of previouslyActive) {
      await sql.unsafe(`ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY`);
      if (previouslyActive.length > 0) {
        const row = (await sql`
          SELECT relforcerowsecurity FROM pg_class
          WHERE relname = ${tableName} AND relnamespace = 'public'::regnamespace
        `)[0];
        // ENABLE 会清掉 FORCE 位；原先 FORCE 的表恢复 FORCE。
        if (row && !row.relforcerowsecurity && rlsState.find((r) => String(r.table_name) === tableName)?.forced) {
          await sql.unsafe(`ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY`);
        }
      }
    }
  }
}

test("installs fail-closed SEC-01 policies without making this an HTTP or M1 gate", async () => {
  const migrator = postgres(requireDatabaseUrl("RLS_TEST_MIGRATOR_DATABASE_URL"), { max: 1 });
  const api = postgres(requireDatabaseUrl("RLS_TEST_API_DATABASE_URL"), { max: 1 });
  const worker = postgres(requireDatabaseUrl("RLS_TEST_WORKER_DATABASE_URL"), { max: 1 });

  const runId = `${process.pid}-${Date.now()}`;
  const userA = randomUUID();
  const userB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const noteA = randomUUID();
  const noteVersionA = randomUUID();
  const sharedArtifactA = randomUUID();
  const privateArtifactA = randomUUID();
  const sharedArtifactB = randomUUID();
  const cardA = randomUUID();
  const validationAUserA = randomUUID();
  const questionAUserA = randomUUID();
  const questionAUserB = randomUUID();
  const auditAOwner = randomUUID();
  const auditAMember = randomUUID();
  const auditAWorker = randomUUID();
  const eventAUserA = randomUUID();
  const eventAUserB = randomUUID();
  const eventBUserB = randomUUID();
  const jobA = randomUUID();
  const jobB = randomUUID();
  const sentinelTable = `sec01_policy_scope_${randomUUID().replaceAll("-", "")}`;
  const tablesEnabledByTest: string[] = [];
  let sentinelTableCreated = false;
  let primaryFailure: unknown;

  try {
    const [migratorIdentity, apiIdentity, workerIdentity] = await Promise.all([
      assertConnectionIdentity(migrator, "ailearn_migrator"),
      assertConnectionIdentity(api, "ailearn_api"),
      assertConnectionIdentity(worker, "ailearn_worker"),
    ]);
    const databaseFingerprint = ({ backendPid: _backendPid, ...identity }: typeof migratorIdentity) => (
      identity
    );
    assert.deepEqual(databaseFingerprint(apiIdentity), databaseFingerprint(migratorIdentity));
    assert.deepEqual(databaseFingerprint(workerIdentity), databaseFingerprint(migratorIdentity));
    assert.equal(
      new Set([
        migratorIdentity.backendPid,
        apiIdentity.backendPid,
        workerIdentity.backendPid,
      ]).size,
      3,
      "migrator/API/Worker URLs must use three independent PostgreSQL backends",
    );

    // Replaying the forward repair must not discover or rewrite policies
    // outside its explicit 24-table manifest. These two sentinels catch both
    // broad *_runtime_access drops and broad RESTRICTIVE -> PERMISSIVE rewrites.
    await migrator.unsafe(`CREATE TABLE public.${sentinelTable} (id bigint PRIMARY KEY)`);
    sentinelTableCreated = true;
    await migrator.unsafe(
      `CREATE POLICY external_runtime_access ON public.${sentinelTable} `
      + "AS RESTRICTIVE FOR SELECT TO ailearn_api USING (true)",
    );
    await migrator.unsafe(
      `CREATE POLICY external_restrictive_guard ON public.${sentinelTable} `
      + "AS RESTRICTIVE FOR SELECT TO ailearn_api USING (true)",
    );

    await rerunPolicyCatalogRepair(migrator);

    const sentinelPolicies = await migrator<{
      policy_name: string;
      permissive: string;
      command: string;
      roles: string[];
    }[]>`
      SELECT
        policyname AS policy_name,
        permissive,
        cmd AS command,
        roles
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = ${sentinelTable}
      ORDER BY policyname
    `;
    assert.deepEqual([...sentinelPolicies], [
      {
        policy_name: "external_restrictive_guard",
        permissive: "RESTRICTIVE",
        command: "SELECT",
        roles: ["ailearn_api"],
      },
      {
        policy_name: "external_runtime_access",
        permissive: "RESTRICTIVE",
        command: "SELECT",
        roles: ["ailearn_api"],
      },
    ]);

    const policies = await migrator<{
      table_name: string;
      policy_name: string;
      permissive: "PERMISSIVE" | "RESTRICTIVE";
      command: string;
      roles: string[];
      using_expression: string | null;
      check_expression: string | null;
    }[]>`
      SELECT
        tablename AS table_name,
        policyname AS policy_name,
        permissive,
        cmd AS command,
        roles,
        qual AS using_expression,
        with_check AS check_expression
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(${migrator.array([...POLICY_TABLES])})
        AND policyname LIKE 'sec01\_v1\_%'
      ORDER BY tablename, policyname
    `;

    const expectedPolicyCount = WORKSPACE_POLICY_TABLES.length * 2
      + USER_PRIVATE_POLICY_TABLES.length * 3
      + 3
      + AI_ARTIFACT_POLICIES.size
      + AI_AUDIT_POLICIES.size
      + JOB_POLICIES.size;
    assert.equal(policies.length, expectedPolicyCount);
    assert.ok(policies.every((policy) => policy.policy_name.startsWith("sec01_v1_")));

    const findPolicy = (tableName: string, policyName: string) => {
      const policy = policies.find((candidate) => (
        candidate.table_name === tableName && candidate.policy_name === policyName
      ));
      assert.ok(policy, `missing ${tableName} policy ${policyName}`);
      assert.deepEqual(policy.roles, ["public"]);
      return policy;
    };

    for (const tableName of POLICY_TABLES) {
      const tablePolicies = policies.filter((policy) => policy.table_name === tableName);
      assert.ok(
        tablePolicies.some((policy) => (
          policy.permissive === "RESTRICTIVE"
          && policy.policy_name.endsWith("tenant_guard")
          && `${policy.using_expression ?? ""} ${policy.check_expression ?? ""}`
            .includes("app.workspace_id")
        )),
        `${tableName} is missing its restrictive workspace tenant guard`,
      );
      assert.ok(
        tablePolicies.some((policy) => policy.permissive === "PERMISSIVE"),
        `${tableName} is missing an explicit permissive role/command policy`,
      );
    }

    for (const tableName of WORKSPACE_POLICY_TABLES) {
      const tenantGuard = findPolicy(tableName, `sec01_v1_${tableName}_tenant_guard`);
      assert.equal(tenantGuard.permissive, "RESTRICTIVE");
      assert.equal(tenantGuard.command, "ALL");
      assert.match(tenantGuard.using_expression ?? "", /app\.workspace_id/);
      assert.match(tenantGuard.check_expression ?? "", /app\.workspace_id/);

      const runtimeAccess = findPolicy(tableName, `sec01_v1_${tableName}_runtime_access`);
      assert.equal(runtimeAccess.permissive, "PERMISSIVE");
      assert.equal(runtimeAccess.command, "ALL");
      assert.match(runtimeAccess.using_expression ?? "", /ailearn_api/);
      if (API_ONLY_WORKSPACE_TABLES.has(tableName)) {
        assert.doesNotMatch(runtimeAccess.using_expression ?? "", /ailearn_worker/);
      } else {
        assert.match(runtimeAccess.using_expression ?? "", /ailearn_worker/);
      }
    }

    for (const tableName of USER_PRIVATE_POLICY_TABLES) {
      const tenantGuard = findPolicy(tableName, `sec01_v1_${tableName}_tenant_guard`);
      assert.equal(tenantGuard.permissive, "RESTRICTIVE");
      assert.match(tenantGuard.using_expression ?? "", /app\.workspace_id/);

      const actorGuard = findPolicy(tableName, `sec01_v1_${tableName}_actor_guard`);
      assert.equal(actorGuard.permissive, "RESTRICTIVE");
      assert.match(actorGuard.using_expression ?? "", /app\.user_id/);
      assert.match(actorGuard.check_expression ?? "", /app\.user_id/);

      const runtimeAccess = findPolicy(tableName, `sec01_v1_${tableName}_runtime_access`);
      assert.equal(runtimeAccess.permissive, "PERMISSIVE");
    }

    const validationQuestionTenant = findPolicy(
      "validation_questions",
      "sec01_v1_validation_questions_tenant_guard",
    );
    assert.equal(validationQuestionTenant.permissive, "RESTRICTIVE");
    const validationQuestionCreator = findPolicy(
      "validation_questions",
      "sec01_v1_validation_questions_creator_guard",
    );
    assert.equal(validationQuestionCreator.permissive, "RESTRICTIVE");
    assert.match(validationQuestionCreator.using_expression ?? "", /created_by/);
    assert.match(validationQuestionCreator.using_expression ?? "", /app\.user_id/);
    const validationQuestionAccess = findPolicy(
      "validation_questions",
      "sec01_v1_validation_questions_api_access",
    );
    assert.equal(validationQuestionAccess.permissive, "PERMISSIVE");
    assert.match(validationQuestionAccess.using_expression ?? "", /ailearn_api/);

    for (const [policyName, expected] of AI_ARTIFACT_POLICIES) {
      const policy = findPolicy("ai_artifacts", policyName);
      assert.equal(policy.command, expected.command);
      assert.equal(policy.permissive, expected.permissive);
      const expression = `${policy.using_expression ?? ""} ${policy.check_expression ?? ""}`;
      if (policyName.includes("validation_actor")) {
        assert.match(expression, /validation_feedback/);
        assert.match(expression, /input_refs/);
        assert.match(expression, /userId/);
        assert.match(expression, /app\.user_id/);
      }
    }

    for (const [policyName, expected] of AI_AUDIT_POLICIES) {
      const policy = findPolicy("ai_audit_log", policyName);
      assert.equal(policy.command, expected.command);
      assert.equal(policy.permissive, expected.permissive);
      const expression = `${policy.using_expression ?? ""} ${policy.check_expression ?? ""}`;
      if (policyName.includes("owner_read")) {
        assert.match(expression, /workspaces/);
        assert.match(expression, /owner_id/);
        assert.match(expression, /app\.user_id/);
      }
      if (policyName.includes("insert_actor")) {
        assert.match(expression, /user_id/);
        assert.match(expression, /app\.user_id/);
      }
    }

    for (const [policyName, expected] of JOB_POLICIES) {
      const policy = findPolicy("jobs", policyName);
      assert.equal(policy.command, expected.command);
      assert.equal(policy.permissive, expected.permissive);
      const expression = `${policy.using_expression ?? ""} ${policy.check_expression ?? ""}`;
      if (expected.permissive === "PERMISSIVE" && policyName.includes("worker")) {
        assert.match(expression, /ailearn_worker/);
      }
      if (expected.permissive === "PERMISSIVE" && policyName.includes("api_")) {
        assert.match(expression, /ailearn_api/);
      }
      if (policyName.includes("insert_actor_guard")) {
        assert.match(expression, /requested_by/);
        assert.match(expression, /app\.user_id/);
      }
      if (policyName.includes("worker_update_actor_guard")) {
        assert.match(expression, /requested_by/);
        assert.match(expression, /app\.user_id/);
        assert.match(expression, /NOT/);
        assert.match(expression, /IS DISTINCT FROM/i);
      }
    }

    const rlsState = await migrator<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
    }[]>`
      SELECT
        class.relname AS table_name,
        class.relrowsecurity AS enabled,
        class.relforcerowsecurity AS forced
      FROM pg_catalog.pg_class AS class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'public'
        AND class.relname = ANY(${migrator.array([...POLICY_TABLES])})
      ORDER BY class.relname
    `;
    assert.equal(rlsState.length, POLICY_TABLES.length);
    // 2026-08-23 对齐：0024 起生产终态是激活态——重放（含测试内的临时解除/
    // 恢复）必须保持激活集合不变，而非要求全部未激活。
    const enabledNow = rlsState.filter((state) => state.enabled || state.forced).map((s) => String(s.table_name)).sort();
    assert.deepEqual(enabledNow, [...rlsActiveBeforeReplay].sort());

    const [queueFunctions] = await migrator<{
      secure_count: number;
      worker_execute_count: number;
      api_execute_count: number;
    }[]>`
      SELECT
        count(*) FILTER (
          WHERE procedure.prosecdef
            AND procedure.proconfig IS NOT DISTINCT FROM
              ARRAY['search_path=pg_catalog, public']::text[]
        )::integer AS secure_count,
        count(*) FILTER (
          WHERE pg_catalog.has_function_privilege(
            'ailearn_worker', procedure.oid, 'EXECUTE'
          )
        )::integer AS worker_execute_count,
        count(*) FILTER (
          WHERE pg_catalog.has_function_privilege(
            'ailearn_api', procedure.oid, 'EXECUTE'
          )
        )::integer AS api_execute_count
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid IN (
        'public.ailearn_claim_jobs(integer,integer)'::regprocedure,
        'public.ailearn_reap_stale_jobs(integer,integer)'::regprocedure,
        'public.ailearn_renew_job_lease(uuid,uuid,text)'::regprocedure,
        'public.ailearn_finish_job(uuid,uuid,text)'::regprocedure,
        'public.ailearn_fail_job(uuid,uuid,text,text,integer)'::regprocedure
      )
    `;
    assert.deepEqual(queueFunctions, {
      secure_count: 5,
      worker_execute_count: 5,
      api_execute_count: 0,
    });

    const [activeBeforeFixture] = await migrator<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM jobs
      WHERE status IN ('pending', 'running')
    `;
    assert.equal(
      activeBeforeFixture?.count,
      0,
      "RLS policy integration test requires an isolated database with no active jobs",
    );

    await migrator.begin(async (transaction) => {
      await transaction`
        INSERT INTO users (id, email, password_hash, role)
        VALUES
          (${userA}, ${`rls-a-${runId}@example.test`}, 'integration-only', 'owner'),
          (${userB}, ${`rls-b-${runId}@example.test`}, 'integration-only', 'owner')
      `;
      await transaction`
        INSERT INTO workspaces (id, owner_id, name)
        VALUES
          (${workspaceA}, ${userA}, ${`RLS A ${runId}`}),
          (${workspaceB}, ${userB}, ${`RLS B ${runId}`})
      `;
      await transaction`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES
          (${workspaceA}, ${userA}, 'owner'),
          (${workspaceA}, ${userB}, 'member'),
          (${workspaceB}, ${userB}, 'owner')
      `;
      await transaction`
        INSERT INTO sources (id, workspace_id, type, title, created_by)
        VALUES
          (${sourceA}, ${workspaceA}, 'text', 'workspace A source', ${userA}),
          (${sourceB}, ${workspaceB}, 'text', 'workspace B source', ${userB})
      `;
      await transaction`
        INSERT INTO notes (id, workspace_id, title, created_by)
        VALUES (${noteA}, ${workspaceA}, 'RLS artifact fixture', ${userA})
      `;
      await transaction`
        INSERT INTO note_versions (
          id, note_id, workspace_id, version_no, content_json, content_hash, created_by
        ) VALUES (
          ${noteVersionA}, ${noteA}, ${workspaceA}, 1,
          ${transaction.json({ blocks: [] })}, 'rls-test-hash', ${userA}
        )
      `;
      await transaction`
        INSERT INTO ai_artifacts (
          id, workspace_id, type, input_refs, output, model_id, prompt_version
        )
        VALUES
          (
            ${sharedArtifactA}, ${workspaceA}, 'learning_card',
            ${transaction.json({ noteVersionId: noteVersionA })},
            ${transaction.json({ title: 'shared A' })}, 'rls-test', 'v1'
          ),
          (
            ${privateArtifactA}, ${workspaceA}, 'validation_feedback',
            ${transaction.json({ cardId: cardA, userId: userA })},
            ${transaction.json({ feedback: 'private A' })}, 'rls-test', 'v1'
          ),
          (
            ${sharedArtifactB}, ${workspaceB}, 'summary',
            ${transaction.json({ sourceId: sourceB })},
            ${transaction.json({ title: 'shared B' })}, 'rls-test', 'v1'
          )
      `;
      await transaction`
        INSERT INTO learning_cards_v2 (
          id, workspace_id, card_id, objective_id, note_version_id, card_revision,
          current_publication_revision, lifecycle, front, public_summary,
          knowledge_form, strategy, presentation_hash
        ) VALUES (
          ${cardA}, ${workspaceA}, ${cardA}, ${cardA}, ${noteVersionA}, 1,
          1, 'active', ${transaction.json({ cue: 'card', prompt: 'card' })},
          'card', 'definition', 'recall', ${'c'.repeat(64)}
        )
      `;
      // 2026-08-23：validation_events.card_id NOT NULL + FK(learning_cards)——
      // 补一行 legacy 卡（V1 表仍在，0176 仅清数据）供 FK 引用。
      await transaction`
        INSERT INTO learning_cards (id, note_version_id, workspace_id, schema_json)
        VALUES (${cardA}, ${noteVersionA}, ${workspaceA}, '{}'::jsonb)
      `;
      await transaction`
        INSERT INTO validation_events (
          id, workspace_id, card_id, user_id, artifact_id,
          question, question_type, user_answer, outcome, confidence
        ) VALUES (
          ${validationAUserA}, ${workspaceA}, ${cardA}, ${userA}, ${privateArtifactA},
          'fixture question', 'explain', 'fixture answer',
          'preliminary_understanding', 80
        )
      `;
      await transaction`
        INSERT INTO validation_questions (
          id, workspace_id, card_id, note_version_id,
          question_type, question, created_by
        )
        VALUES
          (
            ${questionAUserA}, ${workspaceA}, ${cardA}, ${noteVersionA},
            'explain', 'private question A', ${userA}
          ),
          (
            ${questionAUserB}, ${workspaceA}, ${cardA}, ${noteVersionA},
            'explain', 'private question B', ${userB}
          )
      `;
      await transaction`
        INSERT INTO understanding_events (
          id, workspace_id, user_id, subject_type, subject_id, event_type
        )
        VALUES
          (${eventAUserA}, ${workspaceA}, ${userA}, 'note', ${sourceA}, 'seen'),
          (${eventAUserB}, ${workspaceA}, ${userB}, 'note', ${sourceA}, 'seen'),
          (${eventBUserB}, ${workspaceB}, ${userB}, 'note', ${sourceB}, 'seen')
      `;
      await transaction`
        INSERT INTO jobs (
          id, type, workspace_id, requested_by, payload, scheduled_at
        )
        VALUES
          (
            ${jobA}, 'rls_integration', ${workspaceA}, ${userA},
            ${transaction.json({ runId })}, '2000-01-01T00:00:00Z'
          ),
          (
            ${jobB}, 'rls_integration', ${workspaceB}, ${userB},
            ${transaction.json({ runId })}, '2000-01-01T00:00:00Z'
          )
      `;
    });

    for (const tableName of TEMPORARILY_ENFORCED_TABLES) {
      await migrator.unsafe(`ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY`);
      tablesEnabledByTest.push(tableName);
      await migrator.unsafe(`ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY`);
    }

    const missingWorkspaceRows = await api<{ id: string }[]>`
      SELECT id FROM sources WHERE id IN (${sourceA}, ${sourceB})
    `;
    assert.equal(missingWorkspaceRows.length, 0);

    const emptyWorkspaceRows = await withContext(
      api,
      { workspaceId: "", userId: "" },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id FROM sources WHERE id IN (${sourceA}, ${sourceB})
      `,
    );
    assert.equal(emptyWorkspaceRows.length, 0);

    const workspaceARows = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id FROM sources WHERE id IN (${sourceA}, ${sourceB}) ORDER BY id
      `,
    );
    assert.deepEqual(workspaceARows.map((row) => row.id), [sourceA]);

    const crossWorkspaceUpdate = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        UPDATE sources SET title = 'must not change' WHERE id = ${sourceB} RETURNING id
      `,
    );
    assert.equal(crossWorkspaceUpdate.length, 0);

    await assertRlsCheckDenied(() => withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO sources (workspace_id, type, title, created_by)
        VALUES (${workspaceB}, 'text', 'cross-workspace write', ${userA})
      `,
    ));

    const privateRows = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id
        FROM understanding_events
        WHERE id IN (${eventAUserA}, ${eventAUserB}, ${eventBUserB})
      `,
    );
    assert.deepEqual(privateRows.map((row) => row.id), [eventAUserA]);

    const missingUserRows = await withContext(
      api,
      { workspaceId: workspaceA, userId: "" },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id FROM understanding_events WHERE id = ${eventAUserA}
      `,
    );
    assert.equal(missingUserRows.length, 0);

    await assertRlsCheckDenied(() => withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO understanding_events (
          workspace_id, user_id, subject_type, subject_id, event_type
        ) VALUES (${workspaceA}, ${userB}, 'note', ${sourceA}, 'seen')
      `,
    ));

    const creatorQuestions = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id
        FROM validation_questions
        WHERE id IN (${questionAUserA}, ${questionAUserB})
      `,
    );
    assert.deepEqual(creatorQuestions.map((row) => row.id), [questionAUserA]);

    const otherCreatorQuestions = await withContext(
      api,
      { workspaceId: workspaceA, userId: userB },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id
        FROM validation_questions
        WHERE id IN (${questionAUserA}, ${questionAUserB})
      `,
    );
    assert.deepEqual(otherCreatorQuestions.map((row) => row.id), [questionAUserB]);

    const ownerArtifacts = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id
        FROM ai_artifacts
        WHERE id IN (${sharedArtifactA}, ${privateArtifactA}, ${sharedArtifactB})
        ORDER BY id
      `,
    );
    assert.deepEqual(
      new Set(ownerArtifacts.map((row) => row.id)),
      new Set([sharedArtifactA, privateArtifactA]),
    );

    const memberArtifacts = await withContext(
      api,
      { workspaceId: workspaceA, userId: userB },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id
        FROM ai_artifacts
        WHERE id IN (${sharedArtifactA}, ${privateArtifactA}, ${sharedArtifactB})
      `,
    );
    assert.deepEqual(memberArtifacts.map((row) => row.id), [sharedArtifactA]);

    await assertRlsCheckDenied(() => withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO ai_artifacts (
          workspace_id, type, input_refs, output, model_id, prompt_version
        ) VALUES (
          ${workspaceB}, 'summary', ${transaction.json({})},
          ${transaction.json({})}, 'rls-test', 'v1'
        )
      `,
    ));

    await assertRlsCheckDenied(() => withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO ai_artifacts (
          workspace_id, type, input_refs, output, model_id, prompt_version
        ) VALUES (
          ${workspaceA}, 'validation_feedback',
          ${transaction.json({ cardId: cardA, userId: userB })},
          ${transaction.json({})}, 'rls-test', 'v1'
        )
      `,
    ));

    await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO ai_audit_log (
          id, workspace_id, user_id, provider, model_id, operation
        ) VALUES (
          ${auditAOwner}, ${workspaceA}, ${userA}, 'mock', 'rls-test', 'owner-call'
        )
      `,
    );
    await withContext(
      api,
      { workspaceId: workspaceA, userId: userB },
      (transaction) => transaction`
        INSERT INTO ai_audit_log (
          id, workspace_id, user_id, provider, model_id, operation
        ) VALUES (
          ${auditAMember}, ${workspaceA}, ${userB}, 'mock', 'rls-test', 'member-call'
        )
      `,
    );
    await withContext(
      worker,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO ai_audit_log (
          id, workspace_id, user_id, provider, model_id, operation
        ) VALUES (
          ${auditAWorker}, ${workspaceA}, ${userA}, 'mock', 'rls-test', 'worker-call'
        )
      `,
    );

    const ownerAuditRows = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id
        FROM ai_audit_log
        WHERE id IN (${auditAOwner}, ${auditAMember}, ${auditAWorker})
      `,
    );
    assert.deepEqual(
      new Set(ownerAuditRows.map((row) => row.id)),
      new Set([auditAOwner, auditAMember, auditAWorker]),
    );

    const memberAuditRows = await withContext(
      api,
      { workspaceId: workspaceA, userId: userB },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id
        FROM ai_audit_log
        WHERE id IN (${auditAOwner}, ${auditAMember}, ${auditAWorker})
      `,
    );
    assert.equal(memberAuditRows.length, 0);

    await assertRlsCheckDenied(() => withContext(
      api,
      { workspaceId: workspaceA, userId: userB },
      (transaction) => transaction`
        INSERT INTO ai_audit_log (
          workspace_id, user_id, provider, model_id, operation
        ) VALUES (${workspaceA}, ${userA}, 'mock', 'rls-test', 'actor-mismatch')
      `,
    ));

    const apiWorkspaceJobs = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id FROM jobs WHERE id IN (${jobA}, ${jobB})
      `,
    );
    assert.deepEqual(apiWorkspaceJobs.map((row) => row.id), [jobA]);

    const apiDirectUpdate = await withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        UPDATE jobs SET last_error = 'API must not update jobs'
        WHERE id = ${jobA}
        RETURNING id
      `,
    );
    assert.equal(apiDirectUpdate.length, 0);

    await assertRlsCheckDenied(() => withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO jobs (type, workspace_id, requested_by, payload)
        VALUES ('rls_cross_workspace', ${workspaceB}, ${userA}, ${transaction.json({ runId })})
      `,
    ));

    await assertRlsCheckDenied(() => withContext(
      api,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO jobs (type, workspace_id, requested_by, payload)
        VALUES ('rls_actor_mismatch', ${workspaceA}, ${userB}, ${transaction.json({ runId })})
      `,
    ));

    const workerWorkspaceJobs = await withContext(
      worker,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        SELECT id FROM jobs WHERE id IN (${jobA}, ${jobB})
      `,
    );
    assert.deepEqual(workerWorkspaceJobs.map((row) => row.id), [jobA]);

    const workerActorScopedUpdate = await withContext(
      worker,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        UPDATE jobs SET last_error = 'actor-scoped worker update'
        WHERE id = ${jobA}
        RETURNING id
      `,
    );
    assert.deepEqual(workerActorScopedUpdate.map((row) => row.id), [jobA]);

    await assertRlsCheckDenied(() => withContext(
      worker,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        UPDATE jobs SET requested_by = ${userB} WHERE id = ${jobA}
      `,
    ));

    const workerCrossWorkspaceUpdate = await withContext(
      worker,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction<{ id: string }[]>`
        UPDATE jobs SET last_error = 'must not change' WHERE id = ${jobB} RETURNING id
      `,
    );
    assert.equal(workerCrossWorkspaceUpdate.length, 0);

    await assertRlsCheckDenied(() => withContext(
      worker,
      { workspaceId: workspaceA, userId: userA },
      (transaction) => transaction`
        INSERT INTO jobs (type, workspace_id, requested_by, payload)
        VALUES ('rls_worker_direct_insert', ${workspaceA}, ${userA}, ${transaction.json({ runId })})
      `,
    ));

    const claimed = await worker<{ id: string }[]>`
      SELECT id FROM public.ailearn_claim_jobs(2, 3)
      WHERE id IN (${jobA}, ${jobB})
      ORDER BY id
    `;
    assert.deepEqual(new Set(claimed.map((row) => row.id)), new Set([jobA, jobB]));
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let cleanupFailure: unknown;
    for (const tableName of [...tablesEnabledByTest].reverse()) {
      try {
        await migrator.unsafe(`ALTER TABLE public.${tableName} NO FORCE ROW LEVEL SECURITY`);
      } catch (error) {
        cleanupFailure ??= error;
      }
      try {
        await migrator.unsafe(`ALTER TABLE public.${tableName} DISABLE ROW LEVEL SECURITY`);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }

    if (sentinelTableCreated) {
      try {
        await migrator.unsafe(`DROP TABLE IF EXISTS public.${sentinelTable}`);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }

    try {
      try {
        if (tablesEnabledByTest.length > 0) {
          const finalRlsState = await migrator<{ enabled_count: number }[]>`
            SELECT count(*)::integer AS enabled_count
            FROM pg_catalog.pg_class AS class
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
            WHERE namespace.nspname = 'public'
              AND class.relname = ANY(${migrator.array(tablesEnabledByTest)})
              AND (class.relrowsecurity OR class.relforcerowsecurity)
          `;
          assert.equal(finalRlsState[0]?.enabled_count, 0);
        }

        await migrator`DELETE FROM jobs WHERE id IN (${jobA}, ${jobB})`;
        await migrator`
          DELETE FROM ai_audit_log
          WHERE id IN (${auditAOwner}, ${auditAMember}, ${auditAWorker})
        `;
        await migrator`
          DELETE FROM validation_questions
          WHERE id IN (${questionAUserA}, ${questionAUserB})
        `;
        await migrator`
          DELETE FROM validation_events WHERE id = ${validationAUserA}
        `;
        await migrator`
          DELETE FROM understanding_events
          WHERE id IN (${eventAUserA}, ${eventAUserB}, ${eventBUserB})
        `;
        await migrator`DELETE FROM learning_cards_v2 WHERE workspace_id = ${workspaceA}`;
        await migrator`
          DELETE FROM ai_artifacts
          WHERE id IN (${sharedArtifactA}, ${privateArtifactA}, ${sharedArtifactB})
        `;
        await migrator`DELETE FROM note_versions WHERE id = ${noteVersionA}`;
        await migrator`DELETE FROM notes WHERE id = ${noteA}`;
        await migrator`DELETE FROM sources WHERE id IN (${sourceA}, ${sourceB})`;
        await migrator`DELETE FROM workspaces WHERE id IN (${workspaceA}, ${workspaceB})`;
        await migrator`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
      } catch (error) {
        cleanupFailure ??= error;
      }
    } finally {
      await Promise.allSettled([migrator.end(), api.end(), worker.end()]);
    }

    if (!primaryFailure && cleanupFailure) {
      throw cleanupFailure;
    }
  }
});
