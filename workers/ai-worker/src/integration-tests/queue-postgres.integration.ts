import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "@ailearn/shared/db-schema";
import type {
  ClaimedJob,
  QueueSqlExecutor,
} from "../queue.ts";

const REQUIRED_URLS = [
  "QUEUE_TEST_MIGRATOR_DATABASE_URL",
  "QUEUE_TEST_WORKER_A_DATABASE_URL",
  "QUEUE_TEST_WORKER_B_DATABASE_URL",
] as const;

type RequiredUrlName = (typeof REQUIRED_URLS)[number];

type ConnectionIdentity = {
  current_user: string;
  database_name: string;
  database_oid: number;
  server_address: string | null;
  server_port: number | null;
  postmaster_started_at: string;
  backend_pid: number;
  bypass_rls: boolean;
  server_version_num: number;
};

type JobState = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "dead";
  attempts: number;
  started_at: Date | null;
  finished_at: Date | null;
  lease_token: string | null;
};

function requireDatabaseUrl(name: RequiredUrlName): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the Worker queue PostgreSQL integration gate`);
  }
  return value;
}

async function readConnectionIdentity(
  client: Sql,
  expectedRole: "ailearn_migrator" | "ailearn_worker",
): Promise<ConnectionIdentity> {
  const [identity] = await client<ConnectionIdentity[]>`
    SELECT
      CURRENT_USER::text AS current_user,
      pg_catalog.current_database() AS database_name,
      database.oid::integer AS database_oid,
      pg_catalog.inet_server_addr()::text AS server_address,
      pg_catalog.inet_server_port() AS server_port,
      pg_catalog.pg_postmaster_start_time()::text AS postmaster_started_at,
      pg_catalog.pg_backend_pid() AS backend_pid,
      role.rolbypassrls AS bypass_rls,
      pg_catalog.current_setting('server_version_num')::integer AS server_version_num
    FROM pg_catalog.pg_roles AS role
    JOIN pg_catalog.pg_database AS database
      ON database.datname = pg_catalog.current_database()
    WHERE role.rolname = CURRENT_USER
  `;

  assert.ok(identity, `could not inspect ${expectedRole} connection identity`);
  assert.equal(identity.current_user, expectedRole);
  assert.equal(identity.bypass_rls, expectedRole === "ailearn_migrator");
  assert.equal(
    Math.floor(identity.server_version_num / 10_000),
    16,
    `Worker queue integration gate requires PostgreSQL 16, got ${identity.server_version_num}`,
  );
  return identity;
}

function databaseIdentityKey(identity: ConnectionIdentity): string {
  return [
    identity.server_address ?? "local-socket",
    identity.server_port ?? "local-port",
    identity.postmaster_started_at,
    identity.database_name,
    identity.database_oid,
  ].join("/");
}

async function readJobStates(migrator: Sql, ids: string[]): Promise<Map<string, JobState>> {
  const rows = await migrator<JobState[]>`
    SELECT
      id::text AS id,
      status::text AS status,
      attempts,
      started_at,
      finished_at,
      lease_token
    FROM public.jobs
    WHERE id = ANY(${migrator.array(ids)}::uuid[])
    ORDER BY id
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

async function readJobsRlsState(
  migrator: Sql,
): Promise<{ enabled: boolean; forced: boolean }> {
  const [state] = await migrator<{ enabled: boolean; forced: boolean }[]>`
    SELECT
      relation.relrowsecurity AS enabled,
      relation.relforcerowsecurity AS forced
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'jobs'
  `;
  assert.ok(state, "public.jobs must exist before the queue integration gate runs");
  return state;
}

test("keeps Worker queue claims, leases, reaping, and pool context atomic on PostgreSQL 16", async (t) => {
  // These explicit URLs are the safety boundary: this test never falls back to
  // a development database and must be run against a disposable isolated DB.
  const migratorUrl = requireDatabaseUrl("QUEUE_TEST_MIGRATOR_DATABASE_URL");
  const workerAUrl = requireDatabaseUrl("QUEUE_TEST_WORKER_A_DATABASE_URL");
  const workerBUrl = requireDatabaseUrl("QUEUE_TEST_WORKER_B_DATABASE_URL");

  const migrator = postgres(migratorUrl, { max: 1 });
  const workerA = postgres(workerAUrl, { max: 1 });
  const workerB = postgres(workerBUrl, { max: 1 });
  const workerDatabaseA = drizzle(workerA, { schema });
  const workerDatabaseB = drizzle(workerB, { schema });

  const previousWorkerUrl = process.env.DATABASE_URL_WORKER;
  process.env.DATABASE_URL_WORKER = workerAUrl;

  let closeDefaultWorkerDatabase: (() => Promise<void>) | undefined;
  let primaryFailure: unknown;
  let jobsRlsMustBeRestored = false;

  const runId = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const userA = randomUUID();
  const userB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const fixtureJobIds = new Set<string>();

  try {
    const queue = await import("../queue.ts");
    const workerDb = await import("../db.ts");
    closeDefaultWorkerDatabase = workerDb.closeDatabase;

    const [migratorIdentity, workerAIdentity, workerBIdentity] = await Promise.all([
      readConnectionIdentity(migrator, "ailearn_migrator"),
      readConnectionIdentity(workerA, "ailearn_worker"),
      readConnectionIdentity(workerB, "ailearn_worker"),
    ]);
    assert.equal(databaseIdentityKey(workerAIdentity), databaseIdentityKey(migratorIdentity));
    assert.equal(databaseIdentityKey(workerBIdentity), databaseIdentityKey(migratorIdentity));
    assert.equal(
      new Set([
        migratorIdentity.backend_pid,
        workerAIdentity.backend_pid,
        workerBIdentity.backend_pid,
      ]).size,
      3,
      "the migrator and two Workers must be independent database sessions",
    );

    const jobPolicies = await migrator<{
      policy_name: string;
      permissive: "PERMISSIVE" | "RESTRICTIVE";
      command: string;
    }[]>`
      SELECT
        policyname AS policy_name,
        permissive,
        cmd AS command
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'jobs'
        AND policyname LIKE 'sec01_v1_jobs_%'
      ORDER BY policyname
    `;
    const policyCatalog = new Map(jobPolicies.map((policy) => [policy.policy_name, policy]));
    assert.equal(policyCatalog.get("sec01_v1_jobs_tenant_guard")?.permissive, "RESTRICTIVE");
    assert.equal(policyCatalog.get("sec01_v1_jobs_insert_actor_guard")?.command, "INSERT");
    assert.equal(
      policyCatalog.get("sec01_v1_jobs_worker_update_actor_guard")?.permissive,
      "RESTRICTIVE",
    );
    assert.equal(
      policyCatalog.get("sec01_v1_jobs_worker_workspace_select_policy")?.command,
      "SELECT",
    );
    assert.equal(
      policyCatalog.get("sec01_v1_jobs_worker_workspace_update_policy")?.command,
      "UPDATE",
    );

    // 生产迁移（0024 sec01 起）已永久启用 jobs RLS；worker 角色策略
    // （sec01_v1_jobs_worker_workspace_*）允许跨 workspace claim/reap——
    // 前置状态即真实 schema 状态（R24 修正陈旧断言，此前期望 RLS 关闭）。
    assert.deepEqual(await readJobsRlsState(migrator), { enabled: true, forced: true });

    // Claim/reap intentionally cross workspace boundaries. Refuse to run when
    // an existing active queue could be mistaken for this test's fixtures.
    const [initialQueue] = await migrator<{ active_count: number }[]>`
      SELECT count(*)::integer AS active_count
      FROM public.jobs
      WHERE status IN ('pending', 'running')
    `;
    assert.equal(
      initialQueue?.active_count,
      0,
      "queue integration test requires an isolated database with no pending/running jobs",
    );

    await migrator.begin(async (transaction) => {
      await transaction`
        INSERT INTO public.users (id, email, password_hash, role)
        VALUES
          (${userA}, ${`queue-a-${runId}@example.invalid`}, 'integration-test-only', 'owner'),
          (${userB}, ${`queue-b-${runId}@example.invalid`}, 'integration-test-only', 'owner')
      `;
      await transaction`
        INSERT INTO public.workspaces (id, owner_id, name)
        VALUES
          (${workspaceA}, ${userA}, ${`queue-a-${runId}`}),
          (${workspaceB}, ${userB}, ${`queue-b-${runId}`})
      `;
      await transaction`
        INSERT INTO public.workspace_members (workspace_id, user_id, role)
        VALUES
          (${workspaceA}, ${userA}, 'owner'),
          (${workspaceB}, ${userB}, 'owner')
      `;
    });

    // The expand migration only installs policies. This isolated gate opts in
    // temporarily so claim/reap and lease-fenced updates exercise real RLS.
    jobsRlsMustBeRestored = true;
    await migrator`ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY`;
    await migrator`ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY`;
    assert.deepEqual(await readJobsRlsState(migrator), { enabled: true, forced: true });

    const createExecutor = (
      database: typeof workerDatabaseA,
    ): QueueSqlExecutor => ({
      execute: async <T extends Record<string, unknown>>(query: SQL) =>
        await database.execute<T>(query) as unknown as T[],
    });
    const executorA = createExecutor(workerDatabaseA);
    const executorB = createExecutor(workerDatabaseB);

    /**
     * worker A 的 **max:1** 池上的事务外壳：上下文写入用生产实现
     * （db.ts 的 setWorkerTransactionContext），测试只补 drizzle 的事务壳。
     *
     * 2026-09-15 修复：`runnerA` 此前被遗留为未定义标识符——删除仅服务于单测的
     * `createDrizzleQueueJobUpdater` 旧链路时，把定义它的 `createTransactionRunner`
     * 一起删了，但「1000 次提交/回滚不泄漏上下文」子用例仍在引用它，于是该子用例
     * 恒以 `ReferenceError: runnerA is not defined` 失败。worker 的
     * tsconfig 排除了 src/integration-tests/**，类型检查也照不到这里。
     * 刻意用每 worker 一条连接的池（而不是 db.ts 的模块级池）——只有单连接池
     * 才能真正暴露「上下文在提交/回滚后泄漏到下一个事务」的问题。
     */
    const runnerA = async <T>(
      context: { workspaceId: string; userId: string | null },
      operation: (transaction: Parameters<Parameters<typeof workerDatabaseA.transaction>[0]>[0]) => Promise<T>,
    ): Promise<T> =>
      workerDatabaseA.transaction(async (transaction) => {
        await workerDb.setWorkerTransactionContext(transaction, context);
        return operation(transaction);
      });

    // 生产路径就是 SQL 函数（ailearn_finish_job / ailearn_fail_job，migration 0022）。
    // 这里用生产实现的两个独立实例做并发/围栏对照——此前用的是仅供单测的
    // drizzle 版 updater（createDrizzleQueueJobUpdater），已按 AGENTS.md 删除旧链路，
    // 于是本用例现在验证的是**真实生产围栏**在两个 worker 连接上的行为。
    const updaterA = queue.createSqlFunctionQueueJobUpdater(executorA);
    const updaterB = queue.createSqlFunctionQueueJobUpdater(executorB);

    const insertPendingJob = async (
      workspaceId: string,
      requestedBy: string,
      type: string,
    ): Promise<string> => {
      const id = randomUUID();
      fixtureJobIds.add(id);
      await migrator`
        INSERT INTO public.jobs (
          id, type, workspace_id, requested_by, payload,
          status, attempts, scheduled_at
        )
        VALUES (
          ${id}, ${type}, ${workspaceId}, ${requestedBy},
          ${migrator.json({ queueTestRunId: runId })},
          'pending', 0, clock_timestamp() - interval '1 minute'
        )
      `;
      return id;
    };

    const assertPersistedLeases = async (claims: ClaimedJob[]): Promise<void> => {
      const states = await readJobStates(migrator, claims.map((claim) => claim.id));
      for (const claim of claims) {
        const state = states.get(claim.id);
        assert.ok(state);
        assert.equal(state.status, "running");
        assert.equal(state.lease_token, claim.leaseToken);
      }
    };

    const claimConcurrently = async (
      expectedIds: string[],
      perWorkerLimit: number,
    ): Promise<{ claimsA: ClaimedJob[]; claimsB: ClaimedJob[]; all: ClaimedJob[] }> => {
      const [claimsA, claimsB] = await Promise.all([
        queue.claimJobs(executorA, perWorkerLimit, queue.MAX_ATTEMPTS),
        queue.claimJobs(executorB, perWorkerLimit, queue.MAX_ATTEMPTS),
      ]);
      const all = [...claimsA, ...claimsB];
      assert.deepEqual(
        all.map((claim) => claim.id).sort(),
        [...expectedIds].sort(),
      );
      assert.equal(new Set(all.map((claim) => claim.id)).size, expectedIds.length);
      assert.equal(new Set(all.map((claim) => claim.leaseToken)).size, expectedIds.length);
      assert.ok(all.every((claim) => claim.leaseToken.length > 0));
      if (expectedIds.length >= 2 && perWorkerLimit < expectedIds.length) {
        assert.ok(claimsA.length > 0, "Worker A should claim at least one row");
        assert.ok(claimsB.length > 0, "Worker B should claim at least one row");
      }
      await assertPersistedLeases(all);
      return { claimsA, claimsB, all };
    };

    const reapConcurrently = async (
      expectedIds: string[],
    ): Promise<{ pending: number; dead: number }> => {
      const [reapedA, reapedB] = await Promise.all([
        queue.reapStaleJobs(executorA, 120_000, queue.MAX_ATTEMPTS),
        queue.reapStaleJobs(executorB, 120_000, queue.MAX_ATTEMPTS),
      ]);
      const ids = [...reapedA.ids, ...reapedB.ids];
      assert.deepEqual(ids.sort(), [...expectedIds].sort());
      assert.equal(new Set(ids).size, expectedIds.length);
      assert.equal(reapedA.total + reapedB.total, expectedIds.length);
      assert.equal(reapedA.total, reapedA.pending + reapedA.dead);
      assert.equal(reapedB.total, reapedB.pending + reapedB.dead);
      return {
        pending: reapedA.pending + reapedB.pending,
        dead: reapedA.dead + reapedB.dead,
      };
    };

    await t.test("two Workers never duplicate claims and persist independent leases", async () => {
      const ids = await Promise.all([
        insertPendingJob(workspaceA, userA, "queue_concurrent_claim"),
        insertPendingJob(workspaceA, userA, "queue_concurrent_claim"),
        insertPendingJob(workspaceB, userB, "queue_concurrent_claim"),
        insertPendingJob(workspaceB, userB, "queue_concurrent_claim"),
      ]);

      const { claimsA, claimsB } = await claimConcurrently(ids, 2);
      for (const claim of claimsA) {
        assert.equal(await queue.markJobSucceeded(claim, updaterA), true);
      }
      for (const claim of claimsB) {
        assert.equal(await queue.markJobSucceeded(claim, updaterB), true);
      }
    });

    await t.test("a max:1 pool never leaks context across 1000 commits and rollbacks", async () => {
      const contexts = [
        { workspaceId: workspaceA, userId: userA },
        { workspaceId: workspaceB, userId: userB },
      ] as const;
      const rollbackSignal = new Error("intentional queue context rollback");
      let rollbackCount = 0;

      for (let iteration = 0; iteration < 1_000; iteration += 1) {
        const context = contexts[iteration % contexts.length];
        const shouldRollback = iteration % 23 === 0;
        try {
          await runnerA(context, async (transaction) => {
            const rows = await transaction.execute<{
              workspace_id: string | null;
              user_id: string | null;
            }>(sql`
              SELECT
                pg_catalog.current_setting('app.workspace_id', true) AS workspace_id,
                pg_catalog.current_setting('app.user_id', true) AS user_id
            `);
            assert.equal(rows[0]?.workspace_id, context.workspaceId);
            assert.equal(rows[0]?.user_id, context.userId);
            if (shouldRollback) throw rollbackSignal;
          });
          assert.equal(shouldRollback, false, "rollback transaction unexpectedly committed");
        } catch (error) {
          assert.equal(error, rollbackSignal);
          rollbackCount += 1;
        }

        const [outsideTransaction] = await workerA<{
          workspace_id: string | null;
          user_id: string | null;
        }[]>`
          SELECT
            pg_catalog.current_setting('app.workspace_id', true) AS workspace_id,
            pg_catalog.current_setting('app.user_id', true) AS user_id
        `;
        assert.equal(outsideTransaction?.workspace_id || "", "");
        assert.equal(outsideTransaction?.user_id || "", "");
      }

      assert.equal(rollbackCount, 44);
    });

    await t.test("a stale lease cannot finish after reap and a new claim", async () => {
      const jobId = await insertPendingJob(workspaceA, userA, "queue_stale_lease");
      const [oldClaim] = await queue.claimJobs(executorA, 1, queue.MAX_ATTEMPTS);
      assert.equal(oldClaim?.id, jobId);
      assert.ok(oldClaim);

      await migrator`
        UPDATE public.jobs
        SET started_at = clock_timestamp() - interval '10 minutes'
        WHERE id = ${jobId}
      `;
      const reaped = await queue.reapStaleJobs(executorB, 120_000, queue.MAX_ATTEMPTS);
      assert.deepEqual(reaped.ids, [jobId]);
      assert.equal(reaped.pending, 1);
      assert.equal(reaped.dead, 0);

      await migrator`
        UPDATE public.jobs
        SET scheduled_at = clock_timestamp() - interval '1 second'
        WHERE id = ${jobId}
      `;
      const [newClaim] = await queue.claimJobs(executorB, 1, queue.MAX_ATTEMPTS);
      assert.equal(newClaim?.id, jobId);
      assert.ok(newClaim);
      assert.notEqual(newClaim.leaseToken, oldClaim.leaseToken);

      assert.equal(await queue.markJobSucceeded(oldClaim, updaterA), false);
      const afterOldLease = (await readJobStates(migrator, [jobId])).get(jobId);
      assert.equal(afterOldLease?.status, "running");
      assert.equal(afterOldLease?.lease_token, newClaim.leaseToken);

      assert.equal(await queue.markJobSucceeded(newClaim, updaterB), true);
      const finalState = (await readJobStates(migrator, [jobId])).get(jobId);
      assert.equal(finalState?.status, "succeeded");
      assert.equal(finalState?.attempts, 1);
      assert.equal(finalState?.lease_token, null);
    });

    await t.test("double reapers and claimers increment attempts once and converge to dead", async () => {
      const initialAttempts = [0, 0, 1, 1, 2, 2] as const;
      const jobs: Array<{
        id: string;
        workspaceId: string;
        requestedBy: string;
        attempts: number;
      }> = initialAttempts.map((attempts, index) => ({
        id: randomUUID(),
        workspaceId: index % 2 === 0 ? workspaceA : workspaceB,
        requestedBy: index % 2 === 0 ? userA : userB,
        attempts,
      }));
      for (const job of jobs) fixtureJobIds.add(job.id);

      for (const job of jobs) {
        await migrator`
          INSERT INTO public.jobs (
            id, type, workspace_id, requested_by, payload, status, attempts,
            scheduled_at, started_at, lease_token
          )
          VALUES (
            ${job.id}, 'queue_reap_convergence', ${job.workspaceId}, ${job.requestedBy},
            ${migrator.json({ queueTestRunId: runId })}, 'running', ${job.attempts},
            clock_timestamp() - interval '20 minutes',
            clock_timestamp() - interval '10 minutes', ${randomUUID()}
          )
        `;
      }

      const expectedAttempts = new Map<string, number>(
        jobs.map((job) => [job.id, job.attempts]),
      );
      let runningIds: string[] = jobs.map((job) => job.id);
      let cycle = 0;

      while (runningIds.length > 0) {
        cycle += 1;
        assert.ok(cycle <= queue.MAX_ATTEMPTS);
        const reapSummary = await reapConcurrently(runningIds);

        for (const id of runningIds) {
          expectedAttempts.set(id, (expectedAttempts.get(id) ?? 0) + 1);
        }
        const states = await readJobStates(migrator, jobs.map((job) => job.id));
        const pendingIds: string[] = [];
        let expectedDead = 0;
        for (const job of jobs) {
          const state = states.get(job.id);
          assert.ok(state);
          const attempts = expectedAttempts.get(job.id);
          assert.equal(state.attempts, attempts);
          if (attempts === queue.MAX_ATTEMPTS) {
            expectedDead += 1;
            assert.equal(state.status, "dead");
            assert.equal(state.started_at, null);
            assert.equal(state.lease_token, null);
            assert.ok(state.finished_at);
          } else {
            assert.equal(state.status, "pending");
            assert.equal(state.started_at, null);
            assert.equal(state.finished_at, null);
            assert.equal(state.lease_token, null);
            pendingIds.push(job.id);
          }
        }
        assert.equal(reapSummary.pending, pendingIds.length);
        assert.equal(reapSummary.dead, expectedDead - (jobs.length - runningIds.length));

        if (pendingIds.length === 0) {
          runningIds = [];
          break;
        }

        await migrator`
          UPDATE public.jobs
          SET scheduled_at = clock_timestamp() - interval '1 second'
          WHERE id = ANY(${migrator.array(pendingIds)}::uuid[])
        `;
        const perWorkerLimit = Math.ceil(pendingIds.length / 2);
        const claimed = await claimConcurrently(pendingIds, perWorkerLimit);
        for (const claim of claimed.all) {
          assert.equal(claim.attempts, expectedAttempts.get(claim.id));
        }
        await migrator`
          UPDATE public.jobs
          SET started_at = clock_timestamp() - interval '10 minutes'
          WHERE id = ANY(${migrator.array(pendingIds)}::uuid[])
            AND status = 'running'
        `;
        runningIds = pendingIds;
      }

      assert.equal(cycle, queue.MAX_ATTEMPTS);
      const finalStates = await readJobStates(migrator, jobs.map((job) => job.id));
      for (const state of finalStates.values()) {
        assert.equal(state.status, "dead");
        assert.equal(state.attempts, queue.MAX_ATTEMPTS);
        assert.equal(state.started_at, null);
        assert.equal(state.lease_token, null);
        assert.ok(state.finished_at);
      }
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (jobsRlsMustBeRestored) {
      // R24：生产迁移（0024 sec01）永久启用 jobs RLS——本测试只验证 RLS 下
      // claim/reap 行为，绝不在 finally 关闭 RLS（旧逻辑会破坏生产安全状态）。
      // 恢复为迁移后的强制状态（幂等，若被外部改动则纠正）。
      try {
        await migrator`ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY`;
        await migrator`ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY`;
        assert.deepEqual(
          await readJobsRlsState(migrator),
          { enabled: true, forced: true },
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      if (fixtureJobIds.size > 0) {
        await migrator`
          DELETE FROM public.jobs
          WHERE id = ANY(${migrator.array([...fixtureJobIds])}::uuid[])
        `;
      }
      await migrator`
        DELETE FROM public.workspaces
        WHERE id IN (${workspaceA}, ${workspaceB})
      `;
      await migrator`
        DELETE FROM public.users
        WHERE id IN (${userA}, ${userB})
      `;
    } catch (error) {
      cleanupFailures.push(error);
    }

    const closeResults = await Promise.allSettled([
      closeDefaultWorkerDatabase?.(),
      workerA.end({ timeout: 5 }),
      workerB.end({ timeout: 5 }),
      migrator.end({ timeout: 5 }),
    ]);
    for (const result of closeResults) {
      if (result.status === "rejected") cleanupFailures.push(result.reason);
    }

    if (previousWorkerUrl === undefined) {
      delete process.env.DATABASE_URL_WORKER;
    } else {
      process.env.DATABASE_URL_WORKER = previousWorkerUrl;
    }

    if (primaryFailure === undefined && cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Worker queue integration cleanup failed");
    }
  }
});
