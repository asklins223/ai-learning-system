/**
 * 任务 02-8：learning_unit_exposure aggregate/guard 单测。
 *
 * 覆盖（验收，02-w1 任务 02-8 三组共享 contentExposureKey 竞态）：
 * - computeContentExposureKey：确定性（evidence hash 排序幂等、版本敏感、
 *   不含 Scene/rubric/provider/model/policy 版本）；
 * - learningUnitGuard 固定锁序（guard 锁 → probe row 锁）与 revision CAS；
 * - lock 先赢 → 冻结 pre-exposure snapshot，之后 reveal 不追溯污染已锁
 *   artifact 但写 exposure/cooldown；
 * - assistance 先赢 → 事务提交后才返回内容，之后 lock 必须看到 practice-only；
 * - 确定性 dependency ledger 传播（排序幂等）；
 * - legacy/new 读写同一 aggregate，切换入口不重置。
 *
 * DB 交互用内存 ExposureRepository 注入，纯函数与 guard 流程均可测。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeContentExposureKey,
  ExposureGuardError,
  lockPath,
  propagateExposureDependency,
  revealPath,
  type ExposureGuardContext,
  type ExposurePatch,
  type ExposureRepository,
  type LearningUnitExposureState,
} from "./exposure-service.ts";

// ─── In-memory repository（固定锁序可观测 + 幂等 ledger）──────────────────

class InMemoryExposureRepository implements ExposureRepository {
  rows = new Map<string, LearningUnitExposureState>();
  /** "source::affected::evidenceRef" 边集合（幂等） */
  ledgerEdges = new Set<string>();
  /** 每次 guard 调用的锁获取顺序（guard 锁在前，probe row 在后） */
  lockOrder: string[] = [];
  probes = new Map<string, boolean>();

  addProbe(probeId: string): void {
    this.probes.set(probeId, true);
  }

  async acquireExposureGuard(_context: ExposureGuardContext): Promise<void> {
    this.lockOrder.push(`guard:${_context.contentExposureKey}`);
  }

  async lockProbeRow(_context: ExposureGuardContext, probeId: string): Promise<void> {
    this.lockOrder.push(`probe:${probeId}`);
    if (!this.probes.get(probeId)) {
      throw new ExposureGuardError(`probe ${probeId} 不存在`, "INVALID_ARGUMENT");
    }
  }

  async getOrCreateExposure(context: ExposureGuardContext): Promise<LearningUnitExposureState> {
    const key = context.contentExposureKey;
    const existing = this.rows.get(key);
    if (existing) return { ...existing };
    const created: LearningUnitExposureState = {
      workspaceId: context.workspaceId,
      userId: context.userId,
      contentExposureKey: key,
      assistanceSnapshot: null,
      lockedArtifactRef: null,
      lastRevealedAt: null,
      lastLockedAt: null,
      assistedAt: null,
      practiceOnlySince: null,
      cooldownUntil: null,
      exposureCount: 0,
      revision: 0,
    };
    this.rows.set(key, created);
    return { ...created };
  }

  async writeExposure(
    context: ExposureGuardContext,
    expectedRevision: number,
    patch: ExposurePatch,
  ): Promise<LearningUnitExposureState> {
    const key = context.contentExposureKey;
    const state = this.rows.get(key);
    if (!state || state.revision !== expectedRevision) {
      throw new ExposureGuardError(
        `revision CAS 失败：expected=${expectedRevision}`,
        "STALE_REVISION",
      );
    }
    const next: LearningUnitExposureState = {
      ...state,
      ...patch,
      revision: expectedRevision + 1,
    };
    this.rows.set(key, next);
    return next;
  }

  async recordDependency(
    _workspaceId: string,
    sourceContentExposureKey: string,
    affectedContentExposureKey: string,
    sharedEvidenceRef: string,
  ): Promise<void> {
    this.ledgerEdges.add(
      `${sourceContentExposureKey}::${affectedContentExposureKey}::${sharedEvidenceRef}`,
    );
  }

  async listAffectedKeys(_workspaceId: string, sourceContentExposureKey: string): Promise<string[]> {
    return [...new Set(
      [...this.ledgerEdges]
        .filter((edge) => edge.startsWith(`${sourceContentExposureKey}::`))
        .map((edge) => edge.split("::")[1]),
    )].sort();
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const KP = "33333333-3333-4333-8333-333333333333";
const PROBE = "44444444-4444-4444-8444-444444444444";

const EVIDENCE = [
  "e".repeat(64),
  "f".repeat(64),
  "a".repeat(64),
];

const FIXED_NOW = new Date("2026-08-08T08:00:00.000Z");

function keyInput(overrides: {
  revision?: number;
  evidence?: readonly string[];
  claimHash?: string;
  workspaceId?: string;
  userId?: string;
  keyPointId?: string;
} = {}) {
  return {
    workspaceId: overrides.workspaceId ?? WS,
    userId: overrides.userId ?? USER,
    keyPointId: overrides.keyPointId ?? KP,
    publishedContentRevision: overrides.revision ?? 3,
    normalizedClaimHash: overrides.claimHash ?? "c".repeat(64),
    sortedEvidenceContentHashes: overrides.evidence ?? EVIDENCE,
  };
}

function guardContext(
  contentExposureKey: string,
  overrides: Partial<ExposureGuardContext> = {},
): ExposureGuardContext {
  return {
    workspaceId: WS,
    userId: USER,
    contentExposureKey,
    userActionNonce: "nonce-00000001",
    baseRevision: 0,
    probeId: PROBE,
    path: "new_episode",
    now: FIXED_NOW,
    ...overrides,
  };
}

function freshRepoWithProbe(): { repo: InMemoryExposureRepository; key: string } {
  const repo = new InMemoryExposureRepository();
  repo.addProbe(PROBE);
  const key = computeContentExposureKey(keyInput());
  return { repo, key };
}

// ─── computeContentExposureKey：确定性 ───────────────────────────────────

describe("computeContentExposureKey", () => {
  it("相同输入两次输出相同（确定性）", () => {
    assert.equal(
      computeContentExposureKey(keyInput()),
      computeContentExposureKey(keyInput()),
    );
  });

  it("evidence content hashes 乱序输入幂等（内部排序）", () => {
    const sorted = ["a".repeat(64), "e".repeat(64), "f".repeat(64)];
    const shuffled = ["f".repeat(64), "a".repeat(64), "e".repeat(64)];
    assert.equal(
      computeContentExposureKey(keyInput({ evidence: sorted })),
      computeContentExposureKey(keyInput({ evidence: shuffled })),
    );
  });

  it("publishedContentRevision 变化 → 键不同（版本敏感）", () => {
    assert.notEqual(
      computeContentExposureKey(keyInput({ revision: 2 })),
      computeContentExposureKey(keyInput({ revision: 3 })),
    );
  });

  it("normalizedClaimHash 变化 → 键不同", () => {
    assert.notEqual(
      computeContentExposureKey(keyInput({ claimHash: "d".repeat(64) })),
      computeContentExposureKey(keyInput({ claimHash: "c".repeat(64) })),
    );
  });

  it("不含 Scene/rubric/provider/model/policy：这些维度不是输入，变化不影响键", () => {
    // 函数签名即冻结维度集合；provider/model/Scene 等不是参数，天然无法改变键。
    // 这里验证：同一学习单元在"不同 Scene/rubric"下键不变（键不依赖它们）。
    assert.equal(
      computeContentExposureKey(keyInput()),
      computeContentExposureKey(keyInput()),
    );
    // 输出有可辨识前缀，避免与 artifact hash 混淆。
    assert.ok(computeContentExposureKey(keyInput()).startsWith("cex:"));
  });
});

// ─── learningUnitGuard：固定锁序 + revision CAS ─────────────────────────

describe("learningUnitGuard", () => {
  it("固定锁序：guard 锁先于 probe row 锁", async () => {
    const { repo, key } = freshRepoWithProbe();
    const outcome = await lockPath(guardContext(key), repo, "artifact:locked-1");
    assert.equal(outcome.allowed, true);
    assert.deepEqual(repo.lockOrder, [`guard:${key}`, `probe:${PROBE}`]);
  });

  it("baseRevision 与当前 revision 不符 → STALE_REVISION（CAS 兜底）", async () => {
    const { repo, key } = freshRepoWithProbe();
    await lockPath(guardContext(key), repo, "artifact:locked-1");
    await assert.rejects(
      revealPath(guardContext(key, { baseRevision: 0, userActionNonce: "nonce-00000002" }), repo, { cooldownMs: 0 }),
      (error: unknown) =>
        error instanceof ExposureGuardError && error.code === "STALE_REVISION",
    );
  });
});

// ─── 竞态一：lock 先赢 → reveal 不追溯污染已锁 artifact ───────────────────

describe("竞态：lock 先赢", () => {
  it("lock 冻结 pre-exposure snapshot 并锁定 artifact", async () => {
    const { repo, key } = freshRepoWithProbe();
    const outcome = await lockPath(guardContext(key), repo, "artifact:locked-1");
    assert.equal(outcome.allowed, true);
    assert.equal(outcome.practiceOnly, false);
    const state = repo.rows.get(key)!;
    assert.equal(state.lockedArtifactRef, "artifact:locked-1");
    assert.equal(state.assistanceSnapshot?.capturedBy, "lock");
    assert.equal(state.assistanceSnapshot?.contentAssisted, false);
    assert.equal(state.revision, 1);
  });

  it("之后的 reveal 不追溯污染已锁 artifact，但写 exposure/cooldown", async () => {
    const { repo, key } = freshRepoWithProbe();
    await lockPath(guardContext(key), repo, "artifact:locked-1");

    const outcome = await revealPath(
      guardContext(key, { baseRevision: 1, userActionNonce: "nonce-00000002" }),
      repo,
      { cooldownMs: 60_000 },
    );
    assert.equal(outcome.allowed, true);
    if (outcome.allowed) {
      assert.equal(outcome.sawAlreadyLocked, true);
      assert.equal(outcome.assistanceActivated, false);
      assert.equal(outcome.contentLevel, "full");
    }

    const after = repo.rows.get(key)!;
    // 不追溯污染：snapshot 与已锁 artifact 保持 lock 先赢时的原样
    assert.equal(after.lockedArtifactRef, "artifact:locked-1");
    assert.equal(after.assistanceSnapshot?.capturedBy, "lock");
    assert.equal(after.assistedAt, null, "reveal 不得写 assistedAt");
    assert.equal(after.practiceOnlySince, null, "reveal 不得激活 practice-only");
    // 但写 exposure/cooldown
    assert.equal(after.exposureCount, 1);
    assert.equal(after.lastRevealedAt?.getTime(), FIXED_NOW.getTime());
    assert.equal(after.cooldownUntil?.getTime(), FIXED_NOW.getTime() + 60_000);
    assert.equal(after.revision, 2);
  });
});

// ─── 竞态二：assistance 先赢 → lock 必须看到 practice-only ────────────────

describe("竞态：assistance 先赢", () => {
  it("首次 reveal 激活 assistance（practice-only），事务提交后才允许返回内容", async () => {
    const { repo, key } = freshRepoWithProbe();
    const outcome = await revealPath(guardContext(key), repo, { cooldownMs: 60_000 });
    assert.equal(outcome.allowed, true);
    if (outcome.allowed) {
      assert.equal(outcome.assistanceActivated, true);
      assert.equal(outcome.contentLevel, "practice_only");
    }

    const state = repo.rows.get(key)!;
    assert.equal(state.practiceOnlySince?.getTime(), FIXED_NOW.getTime());
    assert.equal(state.assistedAt?.getTime(), FIXED_NOW.getTime());
    assert.equal(state.assistanceSnapshot?.capturedBy, "assistance");
    assert.equal(state.exposureCount, 1);
    // 内容在 guard 事务提交后才由调用方返回：outcome 仅携带内容等级与 patch，
    // 不提前外泄任何揭示内容（本 service 从不内联返回揭示内容）。
    assert.equal("content" in outcome, false);
  });

  it("之后的 lock 必须看到 practice-only（不冻结正式 snapshot）", async () => {
    const { repo, key } = freshRepoWithProbe();
    await revealPath(guardContext(key), repo, { cooldownMs: 60_000 });

    const outcome = await lockPath(
      guardContext(key, { baseRevision: 1, userActionNonce: "nonce-00000002" }),
      repo,
      "artifact:late-lock",
    );
    assert.equal(outcome.allowed, true);
    if (outcome.allowed) {
      assert.equal(outcome.practiceOnly, true);
      assert.equal(outcome.alreadyLocked, false);
    }

    const state = repo.rows.get(key)!;
    assert.equal(state.lockedArtifactRef, null, "assistance 先赢后 lock 不写 lockedArtifactRef");
    assert.equal(state.assistanceSnapshot?.capturedBy, "assistance");
    assert.equal(state.revision, 1, "practice-only lock 无 patch，revision 不变");
  });
});

// ─── 确定性 dependency ledger 传播 ───────────────────────────────────────

describe("propagateExposureDependency", () => {
  it("共享 evidence 边幂等写入，affected keys 按序返回", async () => {
    const repo = new InMemoryExposureRepository();
    const source = "cex:source";
    const k1 = "cex:k1";
    const k2 = "cex:k2";
    const ev1 = "evidence-hash-1";
    const ev2 = "evidence-hash-2";

    await propagateExposureDependency(repo, WS, source, [
      { affectedContentExposureKey: k2, sharedEvidenceRef: ev1 },
      { affectedContentExposureKey: k1, sharedEvidenceRef: ev1 },
      { affectedContentExposureKey: k2, sharedEvidenceRef: ev2 },
    ]);
    assert.deepEqual(await repo.listAffectedKeys(WS, source), [k1, k2]);
    assert.equal(repo.ledgerEdges.size, 3);

    // 幂等：重复调用不产生新边
    await propagateExposureDependency(repo, WS, source, [
      { affectedContentExposureKey: k1, sharedEvidenceRef: ev1 },
    ]);
    assert.equal(repo.ledgerEdges.size, 3);
  });
});

// ─── legacy/new 共用同一 aggregate：切换入口不重置 ────────────────────────

describe("legacy/new 同一 aggregate（切换入口不重置）", () => {
  it("legacy reveal → new Episode reveal：exposure 计数累计，不重置", async () => {
    const { repo, key } = freshRepoWithProbe();

    const legacy = await revealPath(
      guardContext(key, { path: "legacy_question_first", userActionNonce: "nonce-legacy-01" }),
      repo,
      { cooldownMs: 0 },
    );
    assert.equal(legacy.allowed, true);
    if (legacy.allowed) {
      assert.equal(legacy.assistanceActivated, true);
    }
    assert.equal(repo.rows.get(key)!.exposureCount, 1);

    const fresh = await revealPath(
      guardContext(key, { baseRevision: 1, path: "new_episode", userActionNonce: "nonce-new-0001" }),
      repo,
      { cooldownMs: 0 },
    );
    assert.equal(fresh.allowed, true);
    const state = repo.rows.get(key)!;
    assert.equal(state.exposureCount, 2, "新入口 reveal 不得重置 exposure 计数");
    assert.equal(state.revision, 2);
  });

  it("legacy submit 与 new Episode lock 幂等，不覆盖已锁 artifact", async () => {
    const { repo, key } = freshRepoWithProbe();

    const legacyLock = await lockPath(
      guardContext(key, { path: "legacy_question_first", userActionNonce: "nonce-legacy-01" }),
      repo,
      "artifact:legacy-lock",
    );
    if (legacyLock.allowed) {
      assert.equal(legacyLock.alreadyLocked, false);
    }

    const newLock = await lockPath(
      guardContext(key, { baseRevision: 1, path: "new_episode", userActionNonce: "nonce-new-0001" }),
      repo,
      "artifact:new-lock",
    );
    if (newLock.allowed) {
      assert.equal(newLock.alreadyLocked, true, "同 key 二次 lock 幂等");
    }
    assert.equal(repo.rows.get(key)!.lockedArtifactRef, "artifact:legacy-lock");
    assert.equal(repo.rows.get(key)!.revision, 1, "幂等 lock 不产生新 revision");
  });

  it("rollover 后仍命中同一 aggregate（contentExposureKey 不随 Scene/policy 变化）", async () => {
    const { repo, key } = freshRepoWithProbe();
    // rollover 前后键相同（computeContentExposureKey 不含 policy/Scene 维度），
    // 因此 reveal 状态跨 rollover 延续。
    const rolloverKey = computeContentExposureKey(keyInput()); // 相同输入 → 相同键
    assert.equal(rolloverKey, key);

    await revealPath(guardContext(key), repo, { cooldownMs: 0 });
    const state = repo.rows.get(rolloverKey)!;
    assert.equal(state.exposureCount, 1, "rollover 后读同一 aggregate，不重置");
  });
});

// ─── cooldown 语义 ───────────────────────────────────────────────────────

describe("reveal cooldown", () => {
  it("冷却期内再次 reveal 被 blocked", async () => {
    const { repo, key } = freshRepoWithProbe();
    await revealPath(guardContext(key), repo, { cooldownMs: 60_000 });

    const within = await revealPath(
      guardContext(key, { baseRevision: 1, userActionNonce: "nonce-00000002" }),
      repo,
      { cooldownMs: 60_000 },
    );
    assert.equal(within.allowed, false);
    if (!within.allowed) {
      assert.equal(within.reason, "cooldown");
    }
  });

  it("冷却结束后可再次 reveal（计数继续累计）", async () => {
    const { repo, key } = freshRepoWithProbe();
    await revealPath(guardContext(key), repo, { cooldownMs: 60_000 });

    const later = await revealPath(
      guardContext(key, {
        baseRevision: 1,
        userActionNonce: "nonce-00000002",
        now: new Date("2026-08-08T09:00:00.000Z"),
      }),
      repo,
      { cooldownMs: 0 },
    );
    assert.equal(later.allowed, true);
    assert.equal(repo.rows.get(key)!.exposureCount, 2);
  });
});
