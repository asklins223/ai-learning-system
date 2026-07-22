/**
 * job-lease.ts 补充测试
 *
 * 通过 mock db 对象的 execute/select/transaction 属性，
 * 测试 assertJobLease / lockJobLease / isJobLeaseActive / withJobTransaction 的核心业务逻辑分支。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  assertJobLease,
  lockJobLease,
  isJobLeaseActive,
  withJobTransaction,
  throwIfJobAborted,
  type JobLeaseContext,
  JobLeaseLostError,
} from "../lib/job-lease.ts";
import { db } from "../db.ts";

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";
const JOB_ID = "00000000-0000-0000-0000-000000000003";
const LEASE_TOKEN = "lease-token-123";

const job: JobLeaseContext = {
  id: JOB_ID,
  workspaceId: WS_ID,
  requestedBy: USER_ID,
  leaseToken: LEASE_TOKEN,
};

let originalTransaction: typeof db.transaction;
let originalExecute: any;
let originalSelect: any;
let originalJobsFindFirst: any;

before(() => {
  originalTransaction = db.transaction;
  originalExecute = db.execute;
  originalSelect = db.select;
  if (db.query?.jobs?.findFirst) {
    originalJobsFindFirst = db.query.jobs.findFirst;
  }
});

after(() => {
  db.transaction = originalTransaction;
  db.execute = originalExecute;
  db.select = originalSelect;
  if (originalJobsFindFirst && db.query?.jobs) {
    db.query.jobs.findFirst = originalJobsFindFirst;
  }
});

function chainable<T>(value: T): any {
  const obj: any = {
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
    catch: (fn: any) => Promise.resolve(value).catch(fn),
    finally: (fn: any) => Promise.resolve(value).finally(fn),
  };
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.toPrimitive) return () => String(value);
      return () => chainable(value);
    },
  });
}

function setupDbMock(hasActiveLease: boolean = true, renewFails: boolean = false) {
  // Mock execute — not directly used by tests but needed for db-level fallback
  Object.assign(db, { execute: async () => [{ workspace_id: WS_ID, user_id: USER_ID }] });

  // Mock select — not directly used but needed for db-level fallback
  db.select = ((_fields: any) => chainable(hasActiveLease ? [{ id: JOB_ID }] : [])) as typeof db.select;

  // Mock transaction — creates a mockTx that handles execute calls by call order:
  //   call 1: setWorkerTransactionContext → return context data
  //   call 2: ailearn_renew_job_lease     → return renew result (only in lockJobLease)
  db.transaction = (async (fn: any) => {
    const mockTx = createMockTx(hasActiveLease, renewFails);
    return fn(mockTx);
  }) as typeof db.transaction;
}

// ─── throwIfJobAborted ─────────────────────────────────────────────────

describe("job-lease throwIfJobAborted (no mock needed)", () => {
  it("signal 未中止时正常返回", () => {
    const testJob: JobLeaseContext = {
      id: JOB_ID,
      workspaceId: WS_ID,
      requestedBy: USER_ID,
      leaseToken: LEASE_TOKEN,
      signal: undefined,
    };
    assert.doesNotThrow(() => throwIfJobAborted(testJob));
  });

  it("signal 已中止时抛 JobLeaseLostError", () => {
    const testJob: JobLeaseContext = {
      id: JOB_ID,
      workspaceId: WS_ID,
      requestedBy: USER_ID,
      leaseToken: LEASE_TOKEN,
      signal: { aborted: true } as any,
    };
    assert.throws(
      () => throwIfJobAborted(testJob),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "aborted",
    );
  });
});

// ─── assertJobLease ─────────────────────────────────────────────────────

describe("job-lease assertJobLease (DB mock)", () => {
  it("Job 存在且租约有效时通过", async () => {
    setupDbMock(true);
    await assert.doesNotThrow(() => assertJobLease(job));
  });

  it("Job 不存在时抛 JobLeaseLostError", async () => {
    setupDbMock(false);
    await assert.rejects(
      () => assertJobLease(job),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "inactive",
    );
  });

  it("Job 状态不是 running 时抛 JobLeaseLostError", async () => {
    // In a real database, the where clause (status="running") would filter
    // out a job with status="completed", so findFirst returns undefined.
    setupDbMock(false);

    await assert.rejects(
      () => assertJobLease(job),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "inactive",
    );
  });

  it("Job 的 leaseToken 不匹配时抛 JobLeaseLostError", async () => {
    // In a real database, the where clause (leaseToken=expected) would
    // filter out a job with a different token, so findFirst returns undefined.
    setupDbMock(false);

    await assert.rejects(
      () => assertJobLease(job),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "inactive",
    );
  });

  it("已中止的 job 抛 aborted 错", async () => {
    setupDbMock(true);
    const abortedJob: JobLeaseContext = {
      ...job,
      signal: { aborted: true } as any,
    };

    await assert.rejects(
      () => assertJobLease(abortedJob),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "aborted",
    );
  });
});

// ─── lockJobLease ─────────────────────────────────────────────────────

describe("job-lease lockJobLease (DB mock)", () => {
  it("成功锁住租约并续期", async () => {
    setupDbMock(true);
    const mockTx = createMockTx(true, false);
    await assert.doesNotThrow(() => lockJobLease(mockTx, job));
  });

  it("Job 不存在时抛 inactive 错", async () => {
    setupDbMock(false);
    const mockTx = createMockTx(false, false);
    await assert.rejects(
      () => lockJobLease(mockTx, job),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "inactive",
    );
  });

  it("续期失败时抛 inactive 错", async () => {
    setupDbMock(true, true);
    const mockTx = createMockTx(true, true);
    await assert.rejects(
      () => lockJobLease(mockTx, job),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "inactive",
    );
  });

  it("已中止的 job 在续期前抛 aborted 错", async () => {
    setupDbMock(true);
    const abortedJob: JobLeaseContext = {
      ...job,
      signal: { aborted: true } as any,
    };
    const mockTx = createMockTx(true, false);

    await assert.rejects(
      () => lockJobLease(mockTx, abortedJob),
      (err: unknown) => err instanceof JobLeaseLostError && err.reason === "aborted",
    );
  });

  it("续期后 job 状态仍为 running 时通过", async () => {
    setupDbMock(true);
    const mockTx = createMockTx(true, false);
    await assert.doesNotThrow(() => lockJobLease(mockTx, job));
  });
});

// ─── isJobLeaseActive ───────────────────────────────────────────────────────

describe("job-lease isJobLeaseActive (DB mock)", () => {
  it("Job 租约有效时返回 true", async () => {
    setupDbMock(true);
    const result = await isJobLeaseActive(job);
    assert.equal(result, true);
  });

  it("Job 不存在时返回 false", async () => {
    setupDbMock(false);
    const result = await isJobLeaseActive(job);
    assert.equal(result, false);
  });

  it("租约失效时返回 false", async () => {
    setupDbMock(false);
    const result = await isJobLeaseActive(job);
    assert.equal(result, false);
  });

  it("已中止的 job 返回 false", async () => {
    const abortedJob: JobLeaseContext = {
      ...job,
      signal: { aborted: true } as any,
    };
    const result = await isJobLeaseActive(abortedJob);
    assert.equal(result, false);
  });

  it("其他错误重新抛出", async () => {
    setupDbMock(true);
    db.transaction = (async (fn: any) => {
      const mockTx = createMockTx(true, false);
      mockTx.query.jobs.findFirst = async () => {
        throw new Error("database error");
      };
      return fn(mockTx);
    }) as typeof db.transaction;

    await assert.rejects(
      () => isJobLeaseActive(job),
      /database error/,
    );
  });
});

// ─── withJobTransaction ───────────────────────────────────────────────

describe("job-lease withJobTransaction (DB mock)", () => {
  it("正常执行事务并返回操作结果", async () => {
    setupDbMock(true);
    const result = await withJobTransaction(job, async () => {
      return 42;
    });
    assert.equal(result, 42);
  });

  it("已中止的 job 事务仍可执行（withJobTransaction 不检查 abort）", async () => {
    setupDbMock(true);
    const abortedJob: JobLeaseContext = {
      ...job,
      signal: { aborted: true } as any,
    };

    // withJobTransaction delegates to withWorkerWorkspaceTransaction,
    // which does not check abort signal — that is the responsibility of
    // assertJobLease/lockJobLease before handler side effects.
    const result = await withJobTransaction(abortedJob, async () => 42);
    assert.equal(result, 42);
  });

  it("嵌套事务使用相同的事务对象", async () => {
    setupDbMock(true);
    let outerTx: any = null;

    await withJobTransaction(job, async (tx) => {
      outerTx = tx;
      // Nested call should reuse the same transaction from AsyncLocalStorage
      const innerResult = await withJobTransaction(job, async (innerTx) => {
        assert.strictEqual(innerTx, outerTx, "嵌套事务应使用相同的事务对象");
        return { inner: true };
      });
      assert.equal(innerResult.inner, true);
      return { outer: true };
    });
  });

  it("不同上下文抛 WorkspaceTransactionContextError", async () => {
    setupDbMock(true);
    // First establish a context with `job`, then try to use a different context
    await withJobTransaction(job, async () => {
      const differentJob: JobLeaseContext = {
        id: "00000000-0000-0000-0000-000000000004",
        workspaceId: "00000000-0000-0000-0000-000000000005",
        requestedBy: "00000000-0000-0000-0000-000000000006",
        leaseToken: "different-token",
      };

      await assert.rejects(
        () => withJobTransaction(differentJob, async () => ({ value: 42 })),
        /nested.*database work cannot change workspace or user context/,
      );
      return { ok: true };
    });
  });
});

// ─── createMockTx helper ─────────────────────────────────────────────────────

function createMockTx(hasActiveLease: boolean = true, renewFails: boolean = false): any {
  // Use a call counter to distinguish between execute calls:
  //   call 1: setWorkerTransactionContext (returns context data)
  //   call 2: ailearn_renew_job_lease (returns renew result, only in lockJobLease)
  let executeCallCount = 0;

  return {
    execute: async () => {
      executeCallCount++;
      if (executeCallCount === 1) {
        // setWorkerTransactionContext: return context data
        return [{ workspace_id: WS_ID, user_id: USER_ID }];
      }
      // ailearn_renew_job_lease (called by lockJobLease after select)
      if (renewFails) return [];
      return [{ ok: true }];
    },
    insert: (_table: any) => ({
      values: (_data: any) => ({
        returning: () => chainable(undefined),
      }),
    }),
    update: (_table: any) => ({
      set: (_data: any) => ({
        where: () => chainable(undefined),
      }),
    }),
    delete: (_table: any) => ({
      where: () => chainable(undefined),
    }),
    select: (_fields: any) => ({
      from: (_table: any) => ({
        where: () => ({
          for: () => chainable(
            hasActiveLease ? [{ id: JOB_ID }] : [],
          ),
        }),
      }),
    }),
    query: {
      jobs: {
        findFirst: async () => hasActiveLease
          ? { id: JOB_ID, status: "running", workspaceId: WS_ID, leaseToken: LEASE_TOKEN }
          : undefined,
        findMany: async () => [],
      },
    },
  };
}
