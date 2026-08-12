/**
 * 阶段 07（W6）任务 07-3：触发仲裁、双预算与建议抑制单测（§5.4.5）。
 *
 * 验收覆盖（对应任务 07-3）：
 * - 抑制顺序链固定：auth_local_hidden/global_off > temporary_hidden >
 *   page_muted/page_context_off/focus_until_task_end/suggestion_paused/
 *   suppressedSuggestionClassIds > presence level > rule eligibility >
 *   stable page budget 与 reason budget；
 * - 同一 contextBudgetKey/reasonBudgetKey 不重复；多标签/多设备同一用户同时
 *   最多一条提示（并发签发只有一条成功）；
 * - policy 缺失或 hash 不匹配 → fail closed（主动提示，被动召唤仍可用）；
 * - dismiss 不退还已消费预算（reason 预算耗尽后不再为该 reason 展示）；
 * - 合法 reason 仅 bounded registry 枚举；targetChangeEpoch 服务端单调；
 *   固定优先级。
 *
 * 纯逻辑测试：全部走可注入内存 LedgerRepo（模拟唯一约束/行锁/活跃 lease），
 * 不依赖真实 DB。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildContextBudgetKey,
  buildReasonBudgetKey,
  buildStablePageContextKey,
  classifyTriggerReason,
  compareTriggerPriority,
  computeCanonicalTargetFingerprint,
  computeTriggerPolicyHash,
  consumeSuggestionPermit,
  DEFAULT_TRIGGER_POLICY,
  DEFAULT_TRIGGER_RULES,
  evaluateTargetChange,
  issueSuggestionPermit,
  isValidTriggerReason,
  LedgerUniqueViolationError,
  resolveTriggerRule,
  TriggerArbitrationError,
  TriggerArbitrationErrorCode,
  type CompanionTriggerPolicyV1,
  type IssueSuggestionPermitDeps,
  type IssueSuggestionPermitInput,
  type LedgerRowPatch,
  type LedgerRowV1,
  type LedgerScope,
  type TriggerLedgerRepo,
} from "./trigger-arbitration.ts";
import {
  PRESENCE_TO_ALLOWED_REASON_CLASSES,
  presenceAllowsReasonClass,
  resolvePresenceLevel,
} from "./presence-control.ts";

// ─── 内存 LedgerRepo（模拟唯一约束 / 活跃 lease / 无真实事务）──────────────

class InMemoryLedgerRepo implements TriggerLedgerRepo {
  private rows = new Map<string, LedgerRowV1>();
  private permitIndex = new Map<string, string>();
  /** per-key 锁链（模拟 DB 行锁：同一 stable page context 的操作串行）。 */
  private locks = new Map<string, Promise<void>>();
  private nextId = 1;

  private rowKey(scope: LedgerScope, stablePageContextKey: string): string {
    return `${scope.userId}\u0000${scope.workspaceId}\u0000${stablePageContextKey}`;
  }

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 全局 FIFO 锁：同一 stable page context 的所有 repo 操作严格串行——
   * 模拟真实 DB 中第二个事务等待第一个事务提交后读到已提交行（或唯一索引冲突）。
   * 并发下后到设备的 lock 一定在第一个设备 insert/update 之后执行 → 必然失败。
   */
  private withRowLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withKeyLock("row-lock", fn);
  }

  private nextIdValue(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  async lockLedgerRow(scope: LedgerScope, stablePageContextKey: string): Promise<LedgerRowV1 | null> {
    return this.withRowLock(async () => {
      const row = this.rows.get(this.rowKey(scope, stablePageContextKey));
      return row ? { ...row } : null;
    });
  }

  async insertLedgerRow(scope: LedgerScope, row: LedgerRowV1): Promise<LedgerRowV1> {
    return this.withRowLock(async () => {
      const key = this.rowKey(scope, row.stablePageContextKey);
      if (this.rows.has(key)) {
        // 模拟 userPageUnique 唯一约束（23505）。
        throw new LedgerUniqueViolationError("stable page context already has a ledger row");
      }
      const stored = { ...row, id: row.id };
      this.rows.set(key, stored);
      if (row.oneTimePermit) this.permitIndex.set(row.oneTimePermit.permitId, key);
      return { ...stored };
    });
  }

  async updateLedgerRow(
    scope: LedgerScope,
    id: string,
    patch: LedgerRowPatch,
  ): Promise<LedgerRowV1> {
    return this.withRowLock(async () => {
      for (const [key, row] of this.rows) {
        if (row.id === id && row.userId === scope.userId && row.workspaceId === scope.workspaceId) {
          const updated: LedgerRowV1 = { ...row, ...patch } as LedgerRowV1;
          this.rows.set(key, updated);
          // 维护 permit 索引（签发/consume 后 findPermitById 可命中）。
          if (patch.oneTimePermit !== undefined) {
            this.permitIndex.set(patch.oneTimePermit?.permitId ?? "", key);
          }
          return { ...updated };
        }
      }
      throw new Error("ledger row not found");
    });
  }

  async findPermitById(permitId: string): Promise<LedgerRowV1 | null> {
    const key = this.permitIndex.get(permitId);
    if (!key) return null;
    const row = this.rows.get(key);
    return row ? { ...row } : null;
  }

  /** 直接预置一行（构造「budget 不同但 lease 活跃」的极端场景）。 */
  seed(scope: LedgerScope, row: Omit<LedgerRowV1, "id">): void {
    const id = this.nextIdValue("row");
    const key = this.rowKey(scope, row.stablePageContextKey);
    const stored: LedgerRowV1 = { ...row, id };
    this.rows.set(key, stored);
    if (row.oneTimePermit) this.permitIndex.set(row.oneTimePermit.permitId, key);
  }

  rowsOf(scope: LedgerScope): LedgerRowV1[] {
    const out: LedgerRowV1[] = [];
    for (const [key, row] of this.rows) {
      if (key.startsWith(`${scope.userId}\u0000${scope.workspaceId}\u0000`)) out.push({ ...row });
    }
    return out;
  }
}

// ─── 测试辅助 ─────────────────────────────────────────────────────────────

function makeRepo(): InMemoryLedgerRepo {
  return new InMemoryLedgerRepo();
}

function makeDeps(repo: TriggerLedgerRepo, nowMs = 1_800_000_000_000): IssueSuggestionPermitDeps {
  let counter = 0;
  return {
    repo,
    now: () => new Date(nowMs),
    idSource: () => `id-${counter++}`,
  };
}

function baseInput(overrides: Partial<IssueSuggestionPermitInput> = {}): IssueSuggestionPermitInput {
  return {
    userId: "user-1",
    workspaceId: "ws-1",
    deviceSessionId: "device-a",
    deviceSurfaceEpoch: 0,
    accountEpoch: 0,
    reasonId: "recoverable_error_explanation",
    boundedReason: "可以重试此操作",
    pageKind: "workspace_home",
    routePattern: "/home",
    canonicalTarget: "kp:card-1",
    canonicalOrigin: "source:note-1",
    targetChangeEpoch: 0,
    cooldownEpoch: 0,
    suggestionClassId: "companion:open-help",
    capabilities: ["open_page_help"],
    actionManifestValid: true,
    suppression: {
      authLocalHidden: false,
      globalOff: false,
      temporaryHidden: false,
      pageMuted: false,
      pageContextOff: false,
      focusUntilTaskEnd: false,
      suggestionPaused: false,
      suppressedSuggestionClassIds: [],
      suggestionClassId: "companion:open-help",
    },
    presence: "moderate",
    policy: DEFAULT_TRIGGER_POLICY,
    policyHash: computeTriggerPolicyHash(DEFAULT_TRIGGER_POLICY),
    ...overrides,
  };
}

/** 便捷：把 suppression 中的布尔开关逐个置位。 */
function withSuppression(
  input: IssueSuggestionPermitInput,
  patch: Partial<IssueSuggestionPermitInput["suppression"]>,
): IssueSuggestionPermitInput {
  return { ...input, suppression: { ...input.suppression, ...patch } };
}

async function expectRejected(
  fn: Promise<unknown>,
  code: TriggerArbitrationErrorCode,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof TriggerArbitrationError, `expected TriggerArbitrationError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ─── 1. 合法 reason registry ─────────────────────────────────────────────

describe("trigger reason registry", () => {
  it("只接受 bounded registry 中的 6 个合法 reason（never model-authored）", () => {
    assert.equal(DEFAULT_TRIGGER_RULES.length, 6);
    assert.ok(isValidTriggerReason("resume_paused_task"));
    assert.ok(isValidTriggerReason("recoverable_error_explanation"));
    assert.ok(isValidTriggerReason("canonical_stale_change"));
    assert.ok(isValidTriggerReason("committed_change_display"));
    assert.ok(isValidTriggerReason("long_absence_resume"));
    assert.ok(isValidTriggerReason("active_tier_next_step"));
    assert.equal(isValidTriggerReason("model_invented_reason"), false);
    assert.equal(isValidTriggerReason("spatial_action"), false);
  });

  it("未知 reasonId 无法解析出 rule（fail closed）", () => {
    assert.equal(resolveTriggerRule(DEFAULT_TRIGGER_POLICY, "model_invented_reason"), null);
    assert.ok(resolveTriggerRule(DEFAULT_TRIGGER_POLICY, "resume_paused_task") !== null);
  });

  it("reason 类别映射与存在感档位一致（moderate 无普通建议，quiet 全为 0）", () => {
    // recoverable_error 属 moderate/active；active_tier_next_step 仅 active。
    assert.ok(PRESENCE_TO_ALLOWED_REASON_CLASSES.quiet.length === 0);
    assert.ok(!presenceAllowsReasonClass("moderate", "ordinary_suggestion"));
    assert.ok(presenceAllowsReasonClass("active", "ordinary_suggestion"));
    assert.ok(presenceAllowsReasonClass("moderate", "recoverable_error"));
    assert.ok(presenceAllowsReasonClass("moderate", "resume"));
    assert.ok(presenceAllowsReasonClass("moderate", "canonical_change"));
    // 未选择前默认 quiet（中立选择）。
    assert.equal(resolvePresenceLevel(undefined), "quiet");
    assert.equal(resolvePresenceLevel("moderate"), "moderate");
    assert.equal(resolvePresenceLevel("bogus"), "quiet");
    // classify：long_absence_resume 归 resume 类（moderate 可给非强迫恢复）。
    assert.equal(classifyTriggerReason("long_absence_resume"), "resume");
    assert.equal(classifyTriggerReason("active_tier_next_step"), "ordinary_suggestion");
  });
});

// ─── 2. policy 缺失 / hash 不匹配 → fail closed ───────────────────────────

describe("trigger policy fail closed", () => {
  it("policy 缺失 → TRIGGER_POLICY_INVALID（主动提示 fail closed）", async () => {
    const repo = makeRepo();
    const input = baseInput({ policy: undefined, policyHash: undefined });
    await expectRejected(issueSuggestionPermit(makeDeps(repo), input), TriggerArbitrationErrorCode.TRIGGER_POLICY_INVALID);
    // 未产生任何 permit / ledger 行（fail closed 零副作用）。
    assert.equal(repo.rowsOf({ workspaceId: "ws-1", userId: "user-1" }).length, 0);
  });

  it("policy hash 不匹配 → TRIGGER_POLICY_INVALID", async () => {
    const repo = makeRepo();
    const tampered: CompanionTriggerPolicyV1 = {
      ...DEFAULT_TRIGGER_POLICY,
      leaseTtlMs: 999,
    };
    // 用正确 policy 的 hash 搭配被篡改的 policy → hash 校验失败。
    const input = baseInput({
      policy: tampered,
      policyHash: computeTriggerPolicyHash(DEFAULT_TRIGGER_POLICY),
    });
    await expectRejected(issueSuggestionPermit(makeDeps(repo), input), TriggerArbitrationErrorCode.TRIGGER_POLICY_INVALID);
  });

  it("policy 结构非法（非法 reason 混入）→ 校验拒绝", async () => {
    const repo = makeRepo();
    const evilPolicy: CompanionTriggerPolicyV1 = {
      ...DEFAULT_TRIGGER_POLICY,
      rules: [...DEFAULT_TRIGGER_POLICY.rules, {
        ...DEFAULT_TRIGGER_POLICY.rules[0]!,
        reasonId: "model_invented_reason" as never,
      }],
    };
    // hash 按 evilPolicy 正确计算仍被拒：结构校验（reason 不在 registry）先失败。
    const input = baseInput({
      policy: evilPolicy,
      policyHash: computeTriggerPolicyHash(evilPolicy),
    });
    await expectRejected(issueSuggestionPermit(makeDeps(repo), input), TriggerArbitrationErrorCode.TRIGGER_POLICY_INVALID);
  });
});

// ─── 3. 抑制顺序链 ───────────────────────────────────────────────────────

describe("suppression chain order", () => {
  it("auth_local_hidden/global_off 优先于一切（即使其余全开）", async () => {
    const repo = makeRepo();
    // global_off 与 active presence 冲突配置：global_off 胜出。
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        withSuppression(baseInput({ presence: "active" }), { globalOff: true }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        withSuppression(baseInput(), { authLocalHidden: true }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
  });

  it("temporary_hidden 优先于 page_muted 等路由级抑制", async () => {
    const repo = makeRepo();
    // temporary_hidden 与 page_muted 同时为真：按链序 temporary_hidden 先拦截。
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        withSuppression(baseInput(), { temporaryHidden: true, pageMuted: true }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
  });

  it("page_muted / page_context_off / focus / suggestion_paused 各自拦截", async () => {
    for (const patch of [
      { pageMuted: true },
      { pageContextOff: true },
      { focusUntilTaskEnd: true },
      { suggestionPaused: true },
    ] as const) {
      const repo = makeRepo();
      await expectRejected(
        issueSuggestionPermit(makeDeps(repo), withSuppression(baseInput(), patch)),
        TriggerArbitrationErrorCode.SUPPRESSED,
      );
    }
  });

  it("suppressedSuggestionClassIds 拦截对应 class（其余 class 不拦截）", async () => {
    const repo = makeRepo();
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        withSuppression(baseInput(), { suppressedSuggestionClassIds: ["companion:open-help"] }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
    // 不同 class 不受影响。
    const ok = await issueSuggestionPermit(
      makeDeps(repo),
      withSuppression(baseInput({ suggestionClassId: "companion:other" }), {
        suppressedSuggestionClassIds: ["companion:open-help"],
        suggestionClassId: "companion:other",
      }),
    );
    assert.ok(ok.permitId.length > 0);
  });

  it("presence level 在 rule eligibility 之前（quiet 下即使 capability 满足也拦截）", async () => {
    const repo = makeRepo();
    await expectRejected(
      issueSuggestionPermit(makeDeps(repo), baseInput({ presence: "quiet" })),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
  });

  it("rule capability / page / action eligibility 拦截（active 档但缺 capability）", async () => {
    const repo = makeRepo();
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        baseInput({ presence: "active", capabilities: [] }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
    // page kind 不在 rule.allowedPageKinds。
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        baseInput({ pageKind: "settings" }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
    // action manifest 无效。
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        baseInput({ actionManifestValid: false }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
  });

  it("active_tier_next_step 仅 active 档（moderate 拦截）", async () => {
    const repo = makeRepo();
    await expectRejected(
      issueSuggestionPermit(makeDeps(repo), baseInput({ reasonId: "active_tier_next_step", presence: "moderate" })),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
    const ok = await issueSuggestionPermit(
      makeDeps(repo),
      baseInput({ reasonId: "active_tier_next_step", presence: "active", pageKind: "card_detail" }),
    );
    assert.ok(ok.permitId.length > 0);
  });
});

// ─── 4. 双预算唯一性与稳定身份 ───────────────────────────────────────────

describe("dual budget uniqueness", () => {
  it("key 构造稳定：不依赖 pageInstanceId/contextVersion/viewport", () => {
    const k1 = buildStablePageContextKey({
      workspaceId: "ws-1",
      routePattern: "/cards/:id",
      canonicalTarget: "kp:card-1",
      canonicalOrigin: "source:note-1",
      targetChangeEpoch: 3,
    });
    const k2 = buildStablePageContextKey({
      workspaceId: "ws-1",
      routePattern: "/cards/:id",
      canonicalTarget: "kp:card-1",
      canonicalOrigin: "source:note-1",
      targetChangeEpoch: 3,
    });
    assert.equal(k1, k2);
    // 不同 targetChangeEpoch → 不同 stable 上下文（内容实质变化后新预算域）。
    const k3 = buildStablePageContextKey({
      workspaceId: "ws-1",
      routePattern: "/cards/:id",
      canonicalTarget: "kp:card-1",
      canonicalOrigin: "source:note-1",
      targetChangeEpoch: 4,
    });
    assert.notEqual(k1, k3);

    const cb = buildContextBudgetKey({ userId: "user-1", stablePageContextKey: k1, cooldownEpoch: 0 });
    const rb = buildReasonBudgetKey({
      userId: "user-1",
      workspaceId: "ws-1",
      canonicalTarget: "kp:card-1",
      canonicalOrigin: "source:note-1",
      targetChangeEpoch: 3,
      reasonId: "recoverable_error_explanation",
      cooldownEpoch: 0,
    });
    assert.ok(cb.startsWith("cb\u001f"));
    assert.ok(rb.startsWith("rb\u001f"));
  });

  it("同一 contextBudgetKey 不重复（本 cooldown epoch 二次签发拒绝）", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    const first = await issueSuggestionPermit(deps, baseInput());
    assert.ok(first.permitId.length > 0);
    await expectRejected(
      issueSuggestionPermit(deps, baseInput()),
      TriggerArbitrationErrorCode.CONTEXT_BUDGET_ALREADY_SPENT,
    );
  });

  it("同一 reasonBudgetKey 不重复（同 target/epoch/reason 二次签发拒绝）", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    // 两个 reason 在 card_detail 页都合法 → 第二次被 context 预算拦截（同 cooldown epoch）。
    await issueSuggestionPermit(deps, baseInput({ pageKind: "card_detail" }));
    await expectRejected(
      issueSuggestionPermit(deps, baseInput({ reasonId: "committed_change_display", pageKind: "card_detail" })),
      TriggerArbitrationErrorCode.CONTEXT_BUDGET_ALREADY_SPENT,
    );
  });

  it("reason 预算有界：耗尽后不再为该 reason 展示（dismiss 不退还）", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    const scope = { workspaceId: "ws-1", userId: "user-1" };
    const reasonId = "recoverable_error_explanation";

    // 第一次展示（cooldownEpoch 0）。
    await issueSuggestionPermit(deps, baseInput({ reasonId }));
    // dismiss → cooldownEpoch 1（不退还 reason 预算）。
    const rows0 = repo.rowsOf(scope);
    await consumeSuggestionPermit({ repo, now: deps.now }, {
      permitId: rows0[0]!.oneTimePermit!.permitId,
      deviceSessionId: "device-a",
      deviceSurfaceEpoch: 0,
      accountEpoch: 0,
    });
    // 第二次展示（cooldownEpoch 1，新的 context/reason key）。
    await issueSuggestionPermit(deps, baseInput({ reasonId, cooldownEpoch: 1 }));
    // 再 dismiss → cooldownEpoch 2。
    const rows1 = repo.rowsOf(scope);
    await consumeSuggestionPermit({ repo, now: deps.now }, {
      permitId: rows1[0]!.oneTimePermit!.permitId,
      deviceSessionId: "device-a",
      deviceSurfaceEpoch: 0,
      accountEpoch: 0,
    });
    // 第三次展示：默认 reason 预算 = 2，已消费 2 次且 dismiss 不退还 → 耗尽。
    await expectRejected(
      issueSuggestionPermit(deps, baseInput({ reasonId, cooldownEpoch: 2 })),
      TriggerArbitrationErrorCode.REASON_BUDGET_EXHAUSTED,
    );
    // ledger 行存在但 reasonBudgetRemaining = 0（未因 dismiss 恢复）。
    const row = repo.rowsOf(scope)[0]!;
    assert.equal(row.reasonBudgetRemaining, 0);
  });

  it("多标签/多设备同一用户同时最多一条提示（并发仅一条成功）", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    const scope = { workspaceId: "ws-1", userId: "user-1" };

    const attemptA = issueSuggestionPermit(deps, baseInput({ deviceSessionId: "device-a" }));
    const attemptB = issueSuggestionPermit(deps, baseInput({ deviceSessionId: "device-b" }));
    const results = await Promise.allSettled([attemptA, attemptB]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one device wins the single suggestion");
    assert.equal(rejected.length, 1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(err instanceof TriggerArbitrationError);
    assert.equal(
      err.code,
      TriggerArbitrationErrorCode.CONTEXT_BUDGET_ALREADY_SPENT,
    );
    // 且 ledger 只有一行，只签发过一条 permit。
    const rows = repo.rowsOf(scope);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.oneTimePermit !== null);
  });

  it("活跃 lease 未过期时另一设备再次签发被拒（同时最多一条）", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    const scope = { workspaceId: "ws-1", userId: "user-1" };
    // 预置一行：contextBudgetKey 是「旧」key（本 cooldown 未消费），但 lease 活跃。
    const spc = buildStablePageContextKey({
      workspaceId: "ws-1",
      routePattern: "/home",
      canonicalTarget: "kp:card-1",
      canonicalOrigin: "source:note-1",
      targetChangeEpoch: 0,
    });
    repo.seed(scope, {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      stablePageContextKey: spc,
      contextBudgetKey: buildContextBudgetKey({ userId: "user-1", stablePageContextKey: spc, cooldownEpoch: -1 }),
      reasonBudgetKey: buildReasonBudgetKey({
        userId: "user-1",
        workspaceId: "ws-1",
        canonicalTarget: "kp:card-1",
        canonicalOrigin: "source:note-1",
        targetChangeEpoch: 0,
        reasonId: "recoverable_error_explanation",
        cooldownEpoch: -1,
      }),
      reasonBudgetRemaining: 1,
      boundedReason: null,
      cooldownEpoch: -1,
      shownAt: null,
      dismissedAt: null,
      suggestionLease: {
        leaseId: "lease-other-device",
        surfaceEpoch: 0,
        issuedAt: deps.now().toISOString(),
        expiresAt: new Date(deps.now().getTime() + 60_000).toISOString(),
      },
      oneTimePermit: null,
    });
    // 本次预算 key 是 cooldownEpoch 0（与预置行的 -1 不同 → budget 通过），
    // 但活跃 lease 未过期 → LEASE_CONFLICT。
    await expectRejected(
      issueSuggestionPermit(deps, baseInput()),
      TriggerArbitrationErrorCode.LEASE_CONFLICT,
    );
  });
});

// ─── 5. dismiss 语义 ─────────────────────────────────────────────────────

describe("dismiss semantics", () => {
  it("dismiss 释放 lease、cooldownEpoch+1，不退还已消费预算", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    const scope = { workspaceId: "ws-1", userId: "user-1" };

    const permit = await issueSuggestionPermit(deps, baseInput());
    const before = repo.rowsOf(scope)[0]!;
    assert.ok(before.suggestionLease !== null);
    assert.equal(before.reasonBudgetRemaining, DEFAULT_TRIGGER_POLICY.defaultReasonBudget - 1);

    const result = await consumeSuggestionPermit({ repo, now: deps.now }, {
      permitId: permit.permitId,
      deviceSessionId: "device-a",
      deviceSurfaceEpoch: 0,
      accountEpoch: 0,
    });
    assert.equal(result.consumed, true);

    const after = repo.rowsOf(scope)[0]!;
    // lease 释放、cooldownEpoch +1、consumedAt 终态。
    assert.equal(after.suggestionLease, null);
    assert.equal(after.cooldownEpoch, 1);
    assert.ok(after.oneTimePermit!.consumedAt !== undefined);
    // reason 预算不退还。
    assert.equal(after.reasonBudgetRemaining, before.reasonBudgetRemaining);
  });

  it("迟到 dismiss（设备 surface epoch 落后）一律丢弃，不改变任何状态", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    const scope = { workspaceId: "ws-1", userId: "user-1" };
    const permit = await issueSuggestionPermit(deps, baseInput());
    const before = repo.rowsOf(scope)[0]!;

    const result = await consumeSuggestionPermit({ repo, now: deps.now }, {
      permitId: permit.permitId,
      deviceSessionId: "device-a",
      deviceSurfaceEpoch: 0,
      accountEpoch: 5, // 账号 epoch 已前进（global off 撤销后）
    });
    assert.equal(result.consumed, false);
    const after = repo.rowsOf(scope)[0]!;
    assert.deepEqual(after, before);
  });
});

// ─── 6. targetChangeEpoch 与优先级 ───────────────────────────────────────

describe("targetChangeEpoch and priority", () => {
  it("canonical 指纹实质变化才单调递增 epoch（服务端判定）", () => {
    const fp1 = computeCanonicalTargetFingerprint({
      workspaceId: "ws-1",
      canonicalTargetId: "kp:card-1",
      canonicalContentHash: "h1",
      publishedRevision: "r1",
    });
    const fp2 = computeCanonicalTargetFingerprint({
      workspaceId: "ws-1",
      canonicalTargetId: "kp:card-1",
      canonicalContentHash: "h2",
      publishedRevision: "r2",
    });
    const unchanged = evaluateTargetChange({
      previousFingerprint: fp1,
      currentFingerprint: fp1,
      previousEpoch: 2,
      changeRule: DEFAULT_TRIGGER_POLICY.targetChangeRule,
    });
    assert.deepEqual(unchanged, { changed: false, nextEpoch: 2 });
    const changed = evaluateTargetChange({
      previousFingerprint: fp1,
      currentFingerprint: fp2,
      previousEpoch: 2,
      changeRule: DEFAULT_TRIGGER_POLICY.targetChangeRule,
    });
    assert.deepEqual(changed, { changed: true, nextEpoch: 3 });
  });

  it("targetChangeEpoch 变化后同一页面进入新预算域（可再次提示）", async () => {
    const repo = makeRepo();
    const deps = makeDeps(repo);
    await issueSuggestionPermit(deps, baseInput({ targetChangeEpoch: 0 }));
    // 内容实质变化（epoch 1）：stable 上下文变化 → 新预算域，可再次提示。
    const second = await issueSuggestionPermit(deps, baseInput({ targetChangeEpoch: 1 }));
    assert.ok(second.permitId.length > 0);
    // 但同一 epoch 内不重复。
    await expectRejected(
      issueSuggestionPermit(deps, baseInput({ targetChangeEpoch: 1 })),
      TriggerArbitrationErrorCode.CONTEXT_BUDGET_ALREADY_SPENT,
    );
  });

  it("固定优先级：召唤 > 续接 > 错误 > canonical 变化 > 普通建议", () => {
    const order = [
      "user_invocation",
      "resume_paused_task",
      "recoverable_error_explanation",
      "canonical_stale_change",
      "committed_change_display",
      "long_absence_resume",
      "active_tier_next_step",
    ];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(
        compareTriggerPriority(order[i]!, order[i + 1]!) < 0,
        `${order[i]} should be higher priority than ${order[i + 1]}`,
      );
    }
  });

  it("设备 surface epoch 落后（global off 撤销后）→ 迟到触发丢弃", async () => {
    const repo = makeRepo();
    await expectRejected(
      issueSuggestionPermit(
        makeDeps(repo),
        baseInput({ deviceSurfaceEpoch: 0, accountEpoch: 3 }),
      ),
      TriggerArbitrationErrorCode.SUPPRESSED,
    );
  });
});
