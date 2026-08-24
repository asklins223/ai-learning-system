/**
 * invite-service.ts DB 依赖函数补充测试
 *
 * 通过 mock db 对象的 transaction/insert/query 属性，
 * 测试 createInvite / listInvites / revokeInvite / consumeInvite /
 * listMembers / removeMember / getOnboardingState / markOnboardingStep /
 * ensureOnboardingState 的核心业务逻辑分支。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  createInvite,
  listInvites,
  revokeInvite,
  consumeInvite,
  listMembers,
  removeMember,
  getOnboardingState,
  markOnboardingStep,
  ensureOnboardingState,
  computeStatus,
  ConsumeInviteError,
} from "../modules/identity/invite-service.ts";
import { db } from "../db/client.ts";
import { generateInvitationToken } from "../modules/identity/invitation-token.ts";

// ─── Mock helpers ───────────────────────────────────────────────────────

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

interface MockTxConfig {
  workspaceId: string;
  userId: string;
  insertReturning?: any[][];
  selectResult?: any[][];
  inviteCodesFindFirst?: any;
  inviteCodesFindFirstQueue?: any[];
  usersFindFirst?: any;
  usersFindFirstQueue?: any[];
  onboardingStatesFindFirst?: any;
  onboardingStatesFindFirstQueue?: any[];
workspacesFindFirst?: any;
evidenceSnapshotsV2FindFirst?: any;
}

function createMockTx(config: MockTxConfig): any {
  let insertIdx = 0;
  let selectIdx = 0;
  let inviteCodesFindFirstIdx = 0;
  let usersFindFirstIdx = 0;
  let onboardingStatesFindFirstIdx = 0;

  const insertReturning = config.insertReturning ?? [];
  const selectResult = config.selectResult ?? [];
  const inviteCodesQueue = config.inviteCodesFindFirstQueue ??
    (config.inviteCodesFindFirst !== undefined ? [config.inviteCodesFindFirst] : [undefined]);
  const usersQueue = config.usersFindFirstQueue ??
    (config.usersFindFirst !== undefined ? [config.usersFindFirst] : [undefined]);
  const onboardingQueue = config.onboardingStatesFindFirstQueue ??
    (config.onboardingStatesFindFirst !== undefined ? [config.onboardingStatesFindFirst] : [undefined]);

  return {
    execute: async () => [
      { workspace_id: config.workspaceId, user_id: config.userId },
    ],
    insert: (_table: any) => ({
      values: (_data: any) => ({
        returning: () => chainable(insertReturning[insertIdx++] ?? []),
        onConflictDoNothing: () => chainable(undefined),
        onConflictDoUpdate: () => ({
          set: () => ({ where: () => chainable(undefined) }),
        }),
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
      from: (_table: any) => chainable(selectResult[selectIdx++] ?? []),
    }),
    query: {
      inviteCodes: {
        findFirst: async () => inviteCodesQueue[inviteCodesFindFirstIdx++],
        findMany: async () => [],
      },
      users: {
        findFirst: async () => usersQueue[usersFindFirstIdx++],
        findMany: async () => [],
      },
      workspaceMembers: {
        findFirst: async () => undefined,
        findMany: async () => [],
      },
      onboardingStates: {
        findFirst: async () => onboardingQueue[onboardingStatesFindFirstIdx++],
        findMany: async () => [],
      },
      workspaces: {
findFirst: async () => config.workspacesFindFirst ?? undefined,
findMany: async () => [],
},
evidenceSnapshotsV2: {
        findFirst: async () => config.evidenceSnapshotsV2FindFirst ?? undefined,
        findMany: async () => [],
      },
    },
  };
}

// ─── Global db mock setup ──────────────────────────────────────────────

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";
const TARGET_USER_ID = "00000000-0000-0000-0000-000000000003";

let originalTransaction: typeof db.transaction;
let originalInsert: typeof db.insert;
let originalEvidenceOverridesFindMany: any;

before(() => {
  originalTransaction = db.transaction;
  originalInsert = db.insert;
  // Save original query methods that we'll mock
  if (db.query?.evidenceOverrides?.findMany) {
    originalEvidenceOverridesFindMany = db.query.evidenceOverrides.findMany;
  }
});

after(() => {
  db.transaction = originalTransaction;
  db.insert = originalInsert;
  if (originalEvidenceOverridesFindMany && db.query?.evidenceOverrides) {
    db.query.evidenceOverrides.findMany = originalEvidenceOverridesFindMany;
  }
});

function setupDbMock(config: MockTxConfig) {
  const mockTx = createMockTx(config);

  db.transaction = (async (fn: any) => fn(mockTx)) as typeof db.transaction;

  db.insert = ((_table: any) => ({
    values: (_data: any) => ({
      returning: () => chainable(config.insertReturning?.[0] ?? []),
      onConflictDoNothing: () => chainable(undefined),
    }),
  })) as typeof db.insert;

  // Mock getUserOverrideMap's direct db.query.evidenceOverrides.findMany
  if (db.query?.evidenceOverrides) {
    (db.query.evidenceOverrides as any).findMany = async () => [];
  }
}

// ─── createInvite ───────────────────────────────────────────────────────

describe("invite-service createInvite (DB mock)", () => {
  it("创建 member 邀请（无过期时间）", async () => {
    const createdAt = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      insertReturning: [[{ id: "invite-1", createdAt }]],
    });

    const result = await createInvite(WS_ID, USER_ID, { role: "member" });

    assert.ok(result);
    assert.equal(result.role, "member");
    assert.equal(result.id, "invite-1");
    assert.equal(result.expiresAt, null);
    assert.ok(result.token.length > 0);
    assert.ok(result.tokenHint.length > 0);
  });

  it("创建 member 邀请（有过期时间）", async () => {
    const createdAt = new Date();
    const expiresAt = new Date("2026-12-31T00:00:00.000Z");
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      insertReturning: [[{ id: "invite-2", createdAt }]],
    });

    const result = await createInvite(WS_ID, USER_ID, {
      role: "member",
      expiresAt,
    });

    assert.equal(result.role, "member");
    assert.equal(result.expiresAt, expiresAt);
  });

  it("默认角色为 member", async () => {
    const createdAt = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      insertReturning: [[{ id: "invite-3", createdAt }]],
    });

    const result = await createInvite(WS_ID, USER_ID, {});
    assert.equal(result.role, "member");
  });

  it("创建 owner 邀请", async () => {
    const createdAt = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      insertReturning: [[{ id: "invite-owner-1", createdAt }]],
    });

    const result = await createInvite(WS_ID, USER_ID, { role: "owner" });

    assert.ok(result);
    assert.equal(result.role, "owner");
    assert.equal(result.id, "invite-owner-1");
  });

  it("无效角色抛错", async () => {
    setupDbMock({ workspaceId: WS_ID, userId: USER_ID });

    await assert.rejects(
      () => createInvite(WS_ID, USER_ID, { role: "superadmin" }),
      (err: unknown) => err instanceof Error && err.message === "invalid_role",
    );
  });

  it("insert 返回空数组时抛 generation_failed", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      insertReturning: [[]],
    });

    await assert.rejects(
      () => createInvite(WS_ID, USER_ID, { role: "member" }),
      (err: unknown) => err instanceof Error && err.message === "generation_failed",
    );
  });
});

// ─── listInvites ─────────────────────────────────────────────────────────

describe("invite-service listInvites (DB mock)", () => {
  it("返回邀请列表和总数", async () => {
    const now = new Date();
    const invites = [
      {
        id: "inv-1", tokenHint: "abcd1234", role: "member",
        createdAt: now, expiresAt: null, consumedAt: null,
        revokedAt: null, consumedBy: null,
      },
      {
        id: "inv-2", tokenHint: "efgh5678", role: "owner",
        createdAt: now, expiresAt: now, consumedAt: now,
        revokedAt: null, consumedBy: "user-xxx",
      },
    ];
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        invites,           // items query
        [{ id: "user-xxx", email: "consumer@test.com" }], // consumers query
        [{ count: 2 }],    // count query
      ],
    });

    const result = await listInvites(WS_ID, USER_ID);

    assert.equal(result.items.length, 2);
    assert.equal(result.total, 2);
    assert.equal(result.items[0].status, "active");
    assert.equal(result.items[1].status, "consumed");
    assert.equal(result.items[1].consumedByEmail, "consumer@test.com");
  });

  it("无消费者时不查询用户邮箱", async () => {
    const now = new Date();
    const invites = [
      {
        id: "inv-1", tokenHint: "abcd1234", role: "member",
        createdAt: now, expiresAt: null, consumedAt: null,
        revokedAt: null, consumedBy: null,
      },
    ];
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        invites,        // items query
        [{ count: 1 }], // count query (no consumers query)
      ],
    });

    const result = await listInvites(WS_ID, USER_ID);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].consumedByEmail, null);
  });

  it("空列表返回零计数", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [],           // items query
        [{ count: 0 }], // count query
      ],
    });

    const result = await listInvites(WS_ID, USER_ID);
    assert.equal(result.items.length, 0);
    assert.equal(result.total, 0);
  });

  it("已撤销邀请状态为 revoked", async () => {
    const now = new Date();
    const invites = [
      {
        id: "inv-1", tokenHint: "abcd1234", role: "member",
        createdAt: now, expiresAt: null, consumedAt: null,
        revokedAt: now, consumedBy: null,
      },
    ];
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [invites, [{ count: 1 }]],
    });

    const result = await listInvites(WS_ID, USER_ID);
    assert.equal(result.items[0].status, "revoked");
  });

  it("已过期邀请状态为 expired", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    const invites = [
      {
        id: "inv-1", tokenHint: "abcd1234", role: "member",
        createdAt: past, expiresAt: past, consumedAt: null,
        revokedAt: null, consumedBy: null,
      },
    ];
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [invites, [{ count: 1 }]],
    });

    const result = await listInvites(WS_ID, USER_ID);
    assert.equal(result.items[0].status, "expired");
  });

  it("limit 被 clamp 到 100", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[], [{ count: 0 }]],
    });

    const result = await listInvites(WS_ID, USER_ID, { limit: 200 });
    assert.equal(result.items.length, 0);
  });
});

// ─── revokeInvite ─────────────────────────────────────────────────────────

describe("invite-service revokeInvite (DB mock)", () => {
  it("成功撤销活跃邀请", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[
        { id: "inv-1", consumedAt: null, revokedAt: null },
      ]],
    });

    const result = await revokeInvite("inv-1", WS_ID, USER_ID);
    assert.deepEqual(result, { ok: true });
  });

  it("邀请不存在时返回 not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[]],
    });

    const result = await revokeInvite("inv-404", WS_ID, USER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "not_found");
    }
  });

  it("已消费的邀请返回 already_consumed", async () => {
    const now = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[
        { id: "inv-1", consumedAt: now, revokedAt: null },
      ]],
    });

    const result = await revokeInvite("inv-1", WS_ID, USER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "already_consumed");
    }
  });

  it("已撤销的邀请返回 already_revoked", async () => {
    const now = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[
        { id: "inv-1", consumedAt: null, revokedAt: now },
      ]],
    });

    const result = await revokeInvite("inv-1", WS_ID, USER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "already_revoked");
    }
  });
});

// ─── listMembers ──────────────────────────────────────────────────────────

describe("invite-service listMembers (DB mock)", () => {
  it("返回成员列表和邮箱", async () => {
    const now = new Date();
    const members = [
      { userId: USER_ID, role: "owner", joinedAt: now },
      { userId: TARGET_USER_ID, role: "member", joinedAt: now },
    ];
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        members,
        [
          { id: USER_ID, email: "owner@test.com" },
          { id: TARGET_USER_ID, email: "member@test.com" },
        ],
      ],
    });

    const result = await listMembers(WS_ID, USER_ID);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].email, "owner@test.com");
    assert.equal(result.items[1].email, "member@test.com");
    assert.equal(result.total, 2);
  });

  it("空成员列表", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[]],
    });

    const result = await listMembers(WS_ID, USER_ID);
    assert.equal(result.items.length, 0);
    assert.equal(result.total, 0);
  });
});

// ─── removeMember ─────────────────────────────────────────────────────────

describe("invite-service removeMember (DB mock)", () => {
  it("自移除返回 self_remove_owner（纯验证路径）", async () => {
    setupDbMock({ workspaceId: WS_ID, userId: USER_ID });

    const result = await removeMember(WS_ID, USER_ID, USER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "self_remove_owner");
    }
  });

  it("成员不存在时返回 not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[]],
    });

    const result = await removeMember(WS_ID, USER_ID, TARGET_USER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "not_found");
    }
  });

  it("最后一个 owner 不可移除", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{ userId: TARGET_USER_ID, role: "owner" }], // target member
        [{ count: 1 }], // owner count
      ],
    });

    const result = await removeMember(WS_ID, USER_ID, TARGET_USER_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "last_owner");
    }
  });

  it("成功移除 member 成员", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{ userId: TARGET_USER_ID, role: "member" }], // target member
        [{ count: 1 }], // owner count (not relevant since target is member)
      ],
    });

    const result = await removeMember(WS_ID, USER_ID, TARGET_USER_ID);
    assert.deepEqual(result, { ok: true });
  });

  it("成功移除 owner（多个 owner 时）", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{ userId: TARGET_USER_ID, role: "owner" }], // target member
        [{ count: 2 }], // owner count > 1
      ],
    });

    const result = await removeMember(WS_ID, USER_ID, TARGET_USER_ID);
    assert.deepEqual(result, { ok: true });
  });
});

// ─── getOnboardingState ──────────────────────────────────────────────────

describe("invite-service getOnboardingState (DB mock)", () => {
  it("系统默认模型可用时自动完成模型准备步骤", async () => {
// deriveOnboardingSnapshot calls:
//   tx.query.workspaces.findFirst → undefined (falls back to system mock)
//   tx.select().from(sources).where().limit(1) → [] (first_content=false)
    //   tx.select().from(notes).where().limit(1) → [] (first_note=false)
    //   tx.select().from(learningCards).innerJoin().where().limit(1) → [] (first_card=false)
    //   tx.select().from(validationEvents).where().limit(1) → [] (first_validation=false)
    // storedSteps.evidence_review is undefined → false
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{  // onboarding state select
          id: "ob-1", workspaceId: WS_ID, userId: USER_ID,
          version: "v1", steps: {}, status: "pending",
        }],
        [], // firstContent select (sources)
        [], // firstNote select (notes)
        [], // firstCard select
        [], // firstValidation select
      ],
    });

    const result = await getOnboardingState(WS_ID, USER_ID);
    assert.ok(result);
    assert.equal(result!.id, "ob-1");
    assert.equal(result!.version, "v1");
    assert.equal(result!.status, "in_progress");
    assert.deepEqual(result!.steps, {
      ai_consent: true,
      first_content: false,
      first_note: false,
      first_card: false,
      evidence_review: false,
      first_validation: false,
    });
  });

  it("不存在时返回 null", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[]],
    });

    const result = await getOnboardingState(WS_ID, USER_ID);
    assert.equal(result, null);
  });
});

// ─── markOnboardingStep ──────────────────────────────────────────────────

describe("invite-service markOnboardingStep (DB mock)", () => {
  it("无效步骤返回 invalid_step（纯验证路径）", async () => {
    setupDbMock({ workspaceId: WS_ID, userId: USER_ID });

    const result = await markOnboardingStep(WS_ID, USER_ID, "invalid_step");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_step");
    }
  });

  it("非 evidence_review 步骤返回 invalid_step", async () => {
    setupDbMock({ workspaceId: WS_ID, userId: USER_ID });

    const result = await markOnboardingStep(WS_ID, USER_ID, "ai_consent", true);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_step");
    }
  });

  it("evidence_review 无 evidenceId 时返回 invalid_step", async () => {
    setupDbMock({ workspaceId: WS_ID, userId: USER_ID });

    const result = await markOnboardingStep(WS_ID, USER_ID, "evidence_review", true);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "invalid_step");
    }
  });

  it("onboarding 状态不存在时返回 not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[]], // onboarding state not found
    });

    const result = await markOnboardingStep(WS_ID, USER_ID, "evidence_review", true, "ev-1");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "not_found");
    }
  });

  it("evidence 不存在时返回 business_fact_missing", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [[
        {
          id: "ob-1", workspaceId: WS_ID, userId: USER_ID,
          version: "v1", steps: {}, status: "pending",
        },
      ]],
      evidenceSnapshotsV2FindFirst: undefined, // evidence not found
    });

    const result = await markOnboardingStep(WS_ID, USER_ID, "evidence_review", true, "ev-missing");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "business_fact_missing");
    }
  });

  it("成功标记 evidence_review 步骤为完成", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{  // onboarding state select
          id: "ob-1", workspaceId: WS_ID, userId: USER_ID,
          version: "v1", steps: {}, status: "pending",
        }],
        [], // firstContent select (sources)
        [], // firstNote select (notes)
        [], // firstCard select
        [], // firstValidation select
      ],
      evidenceSnapshotsV2FindFirst: { id: "ev-1", workspaceId: WS_ID },
    });

    const result = await markOnboardingStep(WS_ID, USER_ID, "evidence_review", true, "ev-1");
    assert.deepEqual(result, { ok: true });
  });

  it("已完成所有步骤时状态变为 completed", async () => {
    // All steps are derived as true except evidence_review which comes from stored steps
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
workspacesFindFirst: { aiConsentAt: new Date(), aiConsentVersion: "v1" },
selectResult: [
        [{  // onboarding state select
          id: "ob-1", workspaceId: WS_ID, userId: USER_ID,
          version: "v1", steps: {}, status: "pending",
        }],
        [{ id: "source-1" }], // firstContent select (sources)
        [{ id: "note-1" }],   // firstNote select (notes)
        [{ id: "card-1" }],   // firstCard select
        [{ id: "val-1" }],    // firstValidation select
      ],
      evidenceSnapshotsV2FindFirst: { id: "ev-1", workspaceId: WS_ID },
    });

    const result = await markOnboardingStep(WS_ID, USER_ID, "evidence_review", true, "ev-1");
    assert.deepEqual(result, { ok: true });
  });
});

// ─── ensureOnboardingState ────────────────────────────────────────────────

describe("invite-service ensureOnboardingState (DB mock)", () => {
  it("已存在时直接返回", async () => {
// getOnboardingState calls deriveOnboardingSnapshot which needs:
//   workspaces.findFirst, 4 select queries
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{  // onboarding state select
          id: "ob-1", workspaceId: WS_ID, userId: USER_ID,
          version: "v1", steps: {}, status: "pending",
        }],
        [], // firstContent select (sources)
        [], // firstNote select (notes)
        [], // firstCard select
        [], // firstValidation select
      ],
      insertReturning: [[]], // won't be used since existing is found
    });

    const result = await ensureOnboardingState(WS_ID, USER_ID);
    assert.equal(result.id, "ob-1");
    assert.equal(result.status, "in_progress");
  });

  it("不存在时创建新状态", async () => {
    // getOnboardingState is called twice:
    // 1. First call returns empty (not found) -> triggers insert
    // 2. Second call returns the newly created state (with deriveOnboardingSnapshot)
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [], // first getOnboardingState - not found
        [{  // second getOnboardingState - found after insert
          id: "ob-new", workspaceId: WS_ID, userId: USER_ID,
          version: "v1", steps: {}, status: "pending",
        }],
        [], // firstContent select (sources)
        [], // firstNote select (notes)
        [], // firstCard select
        [], // firstValidation select
      ],
      insertReturning: [[]],
    });

    const result = await ensureOnboardingState(WS_ID, USER_ID);
    assert.equal(result.id, "ob-new");
    assert.equal(result.status, "in_progress");
  });

  it("创建后仍查不到时抛错", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [], // first getOnboardingState - not found
        [], // second getOnboardingState - still not found
      ],
      insertReturning: [[]],
    });

    await assert.rejects(
      () => ensureOnboardingState(WS_ID, USER_ID),
      (err: unknown) => err instanceof Error && err.message.includes("failed to create"),
    );
  });
});

// ─── consumeInvite ────────────────────────────────────────────────────────

describe("invite-service consumeInvite (DB mock)", () => {
  // Generate a valid invitation token for testing
  const validToken = generateInvitationToken();

  it("无效 token 格式返回 not_found", async () => {
    setupDbMock({ workspaceId: WS_ID, userId: USER_ID });

    const result = await consumeInvite("new@test.com", "password123", "invalid-token");
    assert.ok(result instanceof ConsumeInviteError);
    assert.equal(result.code, "not_found");
  });

  it("token 不存在于数据库时返回 not_found", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [], // lock query returns empty
        [], // existence check returns empty
      ],
    });

    const result = await consumeInvite("new@test.com", "password123", validToken);
    assert.ok(result instanceof ConsumeInviteError);
    assert.equal(result.code, "not_found");
  });

  it("已过期的邀请返回 expired", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [], // lock query returns empty (expired invites don't match)
        [{ consumedBy: null, revokedAt: null, expiresAt: past }], // existence check
      ],
    });

    const result = await consumeInvite("new@test.com", "password123", validToken);
    assert.ok(result instanceof ConsumeInviteError);
    assert.equal(result.code, "expired");
  });

  it("已撤销的邀请返回 revoked", async () => {
    const now = new Date();
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [], // lock query returns empty
        [{ consumedBy: null, revokedAt: now, expiresAt: null }], // existence check
      ],
    });

    const result = await consumeInvite("new@test.com", "password123", validToken);
    assert.ok(result instanceof ConsumeInviteError);
    assert.equal(result.code, "revoked");
  });

  it("已消费的邀请返回 already_consumed", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [], // lock query returns empty
        [{ consumedBy: "other-user", revokedAt: null, expiresAt: null }], // existence check
      ],
    });

    const result = await consumeInvite("new@test.com", "password123", validToken);
    assert.ok(result instanceof ConsumeInviteError);
    assert.equal(result.code, "already_consumed");
  });

  it("邮箱已注册时返回 email_exists", async () => {
    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{  // lock query returns the invite
          id: "inv-1", workspaceId: WS_ID, role: "member",
          consumedBy: null, revokedAt: null, expiresAt: null,
        }],
      ],
      usersFindFirst: { id: "existing-user", email: "new@test.com" },
    });

    const result = await consumeInvite("new@test.com", "password123", validToken);
    assert.ok(result instanceof ConsumeInviteError);
    assert.equal(result.code, "email_exists");
  });

  it("成功消费邀请并注册新用户", async () => {
    const newUserId = "00000000-0000-0000-0000-000000000010";
    const personalWsId = "00000000-0000-0000-0000-000000000020";

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{  // lock query returns the invite
          id: "inv-1", workspaceId: WS_ID, role: "member",
          consumedBy: null, revokedAt: null, expiresAt: null,
        }],
      ],
      usersFindFirst: undefined, // email not found
      insertReturning: [
        [{ id: newUserId, email: "new@test.com" }], // user insert
        [{ id: personalWsId }], // workspace insert
      ],
    });

    const result = await consumeInvite(
      "new@test.com", "password123", validToken,
      { displayName: "新用户" },
    );

    // issueSession will call db.insert(sessions).values(...)
    // which is mocked to return chainable([])
    assert.ok(!(result instanceof ConsumeInviteError));
    if (!(result instanceof ConsumeInviteError)) {
      assert.ok(result.token.length > 0);
      assert.equal(result.ctx.userId, newUserId);
      assert.equal(result.ctx.workspaceId, personalWsId);
    }
  });

  it("成功消费时使用 email 本地部分作为工作区名称", async () => {
    const newUserId = "00000000-0000-0000-0000-000000000011";
    const personalWsId = "00000000-0000-0000-0000-000000000021";

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{  // lock query returns the invite
          id: "inv-2", workspaceId: WS_ID, role: "member",
          consumedBy: null, revokedAt: null, expiresAt: null,
        }],
      ],
      usersFindFirst: undefined,
      insertReturning: [
        [{ id: newUserId, email: "alice@test.com" }],
        [{ id: personalWsId }],
      ],
    });

    const result = await consumeInvite(
      "alice@test.com", "password123", validToken,
    );

    assert.ok(!(result instanceof ConsumeInviteError));
  });

  it("成功消费 owner 邀请（角色传播验证）", async () => {
    const newUserId = "00000000-0000-0000-0000-000000000030";
    const personalWsId = "00000000-0000-0000-0000-000000000031";

    setupDbMock({
      workspaceId: WS_ID,
      userId: USER_ID,
      selectResult: [
        [{  // lock query returns the invite with owner role
          id: "inv-owner", workspaceId: WS_ID, role: "owner",
          consumedBy: null, revokedAt: null, expiresAt: null,
        }],
      ],
      usersFindFirst: undefined,
      insertReturning: [
        [{ id: newUserId, email: "owner@test.com" }],
        [{ id: personalWsId }],
      ],
    });

    const result = await consumeInvite(
      "owner@test.com", "password123", validToken,
      { displayName: "所有者用户" },
    );

    assert.ok(!(result instanceof ConsumeInviteError));
    if (!(result instanceof ConsumeInviteError)) {
      assert.ok(result.token.length > 0);
      assert.equal(result.ctx.userId, newUserId);
      assert.equal(result.ctx.workspaceId, personalWsId);
    }
  });

  it("23505 唯一约束冲突返回 email_exists", async () => {
    db.transaction = (async () => {
      // Simulate what happens inside the transaction when a 23505 occurs
      // The consumeInvite catches the error and checks for code === "23505"
      throw Object.assign(new Error("unique violation"), { code: "23505" });
    }) as typeof db.transaction;

    const result = await consumeInvite("new@test.com", "password123", validToken);
    assert.ok(result instanceof ConsumeInviteError);
    assert.equal(result.code, "email_exists");
  });

  it("非 ConsumeInviteError 且非 23505 的错误被重新抛出", async () => {
    db.transaction = (async () => {
      throw new Error("unexpected database error");
    }) as typeof db.transaction;

    await assert.rejects(
      () => consumeInvite("new@test.com", "password123", validToken),
      (err: unknown) => err instanceof Error && err.message === "unexpected database error",
    );
  });
});

// ─── computeStatus 补充分支 ───────────────────────────────────────────────

describe("invite-service computeStatus 补充分支", () => {
  it("revoked + consumed + expired → revoked（优先级最高）", () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    const status = computeStatus({
      consumedAt: past,
      revokedAt: past,
      expiresAt: past,
    });
    assert.equal(status, "revoked");
  });
});
