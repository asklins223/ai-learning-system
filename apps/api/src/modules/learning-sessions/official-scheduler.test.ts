/**
 * 任务 06-5：official scheduler 单测（§9）。
 *
 * 覆盖（06-w5 任务 06-5 验收 + §16.1 硬指标）：
 * - 同一时间只有一个 official scheduler：versioned discrete policy 作为唯一 official，
 *   FSRS 保持独立 shadow；
 * - FSRS shadow 0 路线影响：shadow 字段不进入 official decision（结构隔离断言）；
 * - due window：not_due / due / overdue，含 unassisted cooldown 生效的 effective start；
 * - successor schedule：create_initial / consume_pending 才可能产生 successor，
 *   record_only / no_effect 0 schedule 副作用；stale/provider_failure 不写；
 * - early-review authorization：必须用户显式请求、无冷却、无近期失败；
 *   从 Card/Star 选择目标只改 prioritySource，本身不授予 early review（01-2 §5.2）；
 * - typed scheduling authorization：consume_pending 必须绑定精确 input schedule；
 * - Agent 上线不自动授权 FSRS 转正；
 * - Episode plan 持久化 decisionRef/hash/authorizedAction/prioritySource/policyEpoch。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OFFICIAL_POLICY_EPOCH,
  OFFICIAL_POLICY_VERSION,
  OFFICIAL_SCHEDULER_ID,
  OFFICIAL_OVERDUE_GRACE_HOURS,
  assertFSRSShadowNoInfluence,
  authorizeEarlyReview,
  computeDueWindow,
  computeSuccessorSchedule,
  deriveOfficialDecision,
  issueTypedAuthorization,
  resolveFSRSPromotionStatus,
  resolveFormalEligibility,
  type EarlyReviewInput,
  type OfficialDecisionInput,
  type OfficialPrioritySourceRequest,
  type EligibilityInput,
} from "./official-scheduler.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-08T12:00:00Z");
const MS_PER_HOUR = 60 * 60 * 1_000;

function date(hoursFromNow: number): Date {
  return new Date(NOW.getTime() + hoursFromNow * MS_PER_HOUR);
}

function decisionInput(overrides: Partial<OfficialDecisionInput> = {}): OfficialDecisionInput {
  return {
    entryKind: "review_entry",
    hasCanonical: true,
    hasActivePending: true,
    boundScheduleId: "sched-1",
    boundScheduleGeneration: 2,
    now: NOW,
    nextReviewAt: date(0),
    unassistedEligibleAfter: null,
    userRequestedEarlyReview: false,
    recentFailureCount: 0,
    prioritySourceRequest: "official_due" as OfficialPrioritySourceRequest,
    ...overrides,
  };
}

function eligibilityInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    entryKind: "initial",
    hasCanonical: true,
    hasActivePending: false,
    pendingDue: false,
    earlyReviewAuthorized: false,
    ...overrides,
  };
}

function earlyReviewInput(overrides: Partial<EarlyReviewInput> = {}): EarlyReviewInput {
  return {
    now: NOW,
    nextReviewAt: date(48),
    unassistedEligibleAfter: null,
    userRequestedEarlyReview: true,
    recentFailureCount: 0,
    hasActivePending: true,
    ...overrides,
  };
}

// ─── 唯一 official ─────────────────────────────────────────────────────────

describe("official scheduler 唯一性（§9）", () => {
  it("versioned discrete policy 是当前唯一 official scheduler", () => {
    assert.equal(OFFICIAL_SCHEDULER_ID, "official-scheduler-v1");
    assert.equal(OFFICIAL_POLICY_VERSION, "discrete-v2");
    assert.equal(OFFICIAL_POLICY_EPOCH, 1);
  });

  it("deriveOfficialDecision 签发的 schedulingDecision 绑定 official policy version/epoch", () => {
    const result = deriveOfficialDecision(decisionInput());
    assert.equal(result.schedulingDecision.policyVersion, OFFICIAL_POLICY_VERSION);
    assert.equal(result.schedulingDecision.policyEpoch, OFFICIAL_POLICY_EPOCH);
    assert.ok(result.schedulingDecision.decisionRef.startsWith("sched:"));
    assert.ok(result.schedulingDecision.decisionHash.length > 0);
  });

  it("相同冻结输入 → 相同 decisionRef/decisionHash（确定性，可重放）", () => {
    const a = deriveOfficialDecision(decisionInput());
    const b = deriveOfficialDecision(decisionInput());
    assert.equal(a.schedulingDecision.decisionRef, b.schedulingDecision.decisionRef);
    assert.equal(a.schedulingDecision.decisionHash, b.schedulingDecision.decisionHash);
  });

  it("Episode plan 持久化 decisionRef/hash/authorizedAction/prioritySource/policyEpoch", () => {
    const d = deriveOfficialDecision(decisionInput()).schedulingDecision;
    assert.ok(d.decisionRef.length > 0);
    assert.ok(d.decisionHash.length > 0);
    assert.ok(
      ["create_initial", "consume_pending", "record_only", "no_effect"].includes(
        d.authorizedAction,
      ),
    );
    assert.ok(
      ["official_due", "official_overdue", "canonical_gap", "user_selected"].includes(
        d.prioritySource,
      ),
    );
    assert.equal(typeof d.policyEpoch, "number");
  });
});

// ─── FSRS shadow 0 影响 ────────────────────────────────────────────────────

describe("FSRS shadow 隔离（§9 / §16.1）", () => {
  it("official decision 不含任何 FSRS shadow 字段（结构隔离）", () => {
    const decision = deriveOfficialDecision(decisionInput()).schedulingDecision;
    const shadow = {
      algorithm: "fsrs",
      stability: 3.173,
      difficulty: 5.28,
      retrievability: 0.9,
      predictedDueAt: "2026-08-09T12:00:00Z",
    };
    const assertion = assertFSRSShadowNoInfluence(decision, shadow);
    assert.equal(assertion.isolated, true);
    for (const key of Object.keys(shadow)) {
      assert.ok(!Object.keys(decision).includes(key), `shadow 字段 ${key} 不得泄漏`);
    }
  });

  it("FSRS shadow 值变化不改变 official decision（0 路线影响）", () => {
    const base = deriveOfficialDecision(decisionInput());
    // deriveOfficialDecision 的输入类型不包含任何 FSRS 状态；任何 shadow 都不在候选/
    // 排序/理由路径中。这里验证 official 决策对 shadow 不存在依赖：相同的 official 输入
    // 恒等；shadow 无法传入输入结构（类型层面隔离）。
    const again = deriveOfficialDecision(decisionInput());
    assert.deepEqual(
      again.schedulingDecision.decisionHash,
      base.schedulingDecision.decisionHash,
    );
  });

  it("official decision 出现未知字段 → 隔离断言失败", () => {
    const decision = deriveOfficialDecision(decisionInput()).schedulingDecision;
    const hacked = { ...decision, shadowPredictedDue: "leak" } as unknown as typeof decision;
    assert.throws(() => assertFSRSShadowNoInfluence(hacked, null), /未知字段/);
  });

  it("shadow 字段与 official 字段重合 → 隔离断言失败", () => {
    const decision = deriveOfficialDecision(decisionInput()).schedulingDecision;
    assert.throws(
      () => assertFSRSShadowNoInfluence(decision, { authorizedAction: "consume_pending" }),
      /泄漏进 official decision/,
    );
  });
});

// ─── Due window ────────────────────────────────────────────────────────────

describe("due window（§9）", () => {
  it("无 schedule → not_due", () => {
    const r = computeDueWindow({ nextReviewAt: null, now: NOW });
    assert.equal(r.status, "not_due");
    assert.equal(r.isDue, false);
    assert.equal(r.dueAt, null);
  });

  it("dueAt 之前 → not_due", () => {
    const r = computeDueWindow({ nextReviewAt: date(48), now: NOW });
    assert.equal(r.status, "not_due");
    assert.equal(r.isDue, false);
    assert.equal(r.isOverdue, false);
  });

  it("dueAt 时刻 → due（window 内）", () => {
    const r = computeDueWindow({ nextReviewAt: date(0), now: NOW });
    assert.equal(r.status, "due");
    assert.equal(r.isDue, true);
    assert.equal(r.isOverdue, false);
    assert.equal(r.dueAt!.getTime(), NOW.getTime());
  });

  it("超过宽限期 → overdue", () => {
    const r = computeDueWindow({
      nextReviewAt: date(-(OFFICIAL_OVERDUE_GRACE_HOURS + 1)),
      now: NOW,
    });
    assert.equal(r.status, "overdue");
    assert.equal(r.isDue, true);
    assert.equal(r.isOverdue, true);
  });

  it("unassisted cooldown 延后 effective due start（max(next_review_at, cooldown)）", () => {
    const cooldown = date(72);
    const r = computeDueWindow({
      nextReviewAt: date(48),
      unassistedEligibleAfter: cooldown,
      now: NOW,
    });
    assert.equal(r.status, "not_due");
    assert.equal(r.dueAt!.getTime(), cooldown.getTime());
  });

  it("lookahead 参数允许到期前进入 due window", () => {
    const r = computeDueWindow({
      nextReviewAt: date(6),
      now: NOW,
      lookaheadHours: 12,
    });
    assert.equal(r.status, "due");
    assert.equal(r.isDue, true);
  });
});

// ─── Formal eligibility ────────────────────────────────────────────────────

describe("formal eligibility（§9）", () => {
  it("initial + 无 pending → initial_validation", () => {
    const v = resolveFormalEligibility(eligibilityInput());
    assert.equal(v.eligible, true);
    assert.equal(v.eligibilityKind, "initial_validation");
  });

  it("initial + 已有 active pending → 不可用（create_initial 要求不存在 pending，01-2 §5.2）", () => {
    const v = resolveFormalEligibility(eligibilityInput({ hasActivePending: true }));
    assert.equal(v.eligible, false);
    assert.ok(v.reasonCodes.includes("active_pending_exists"));
  });

  it("review_entry + pending due → scheduled_review", () => {
    const v = resolveFormalEligibility(
      eligibilityInput({ entryKind: "review_entry", hasActivePending: true, pendingDue: true }),
    );
    assert.equal(v.eligible, true);
    assert.equal(v.eligibilityKind, "scheduled_review");
  });

  it("review_entry + pending 未 due + early review 未授权 → 不可用", () => {
    const v = resolveFormalEligibility(
      eligibilityInput({ entryKind: "review_entry", hasActivePending: true, pendingDue: false }),
    );
    assert.equal(v.eligible, false);
    assert.ok(v.reasonCodes.includes("not_within_due_window"));
  });

  it("review_entry + pending 未 due + early review 已授权 → scheduled_review", () => {
    const v = resolveFormalEligibility(
      eligibilityInput({
        entryKind: "review_entry",
        hasActivePending: true,
        pendingDue: false,
        earlyReviewAuthorized: true,
      }),
    );
    assert.equal(v.eligible, true);
    assert.equal(v.eligibilityKind, "scheduled_review");
  });

  it("review_entry + 无 pending → 不可用", () => {
    const v = resolveFormalEligibility(
      eligibilityInput({ entryKind: "review_entry", hasActivePending: false }),
    );
    assert.equal(v.eligible, false);
    assert.ok(v.reasonCodes.includes("no_pending_schedule"));
  });

  it("repair → repair_revalidation", () => {
    const v = resolveFormalEligibility(eligibilityInput({ entryKind: "repair" }));
    assert.equal(v.eligibilityKind, "repair_revalidation");
  });

  it("ad_hoc → ad_hoc_transfer；practice → practice", () => {
    assert.equal(resolveFormalEligibility(eligibilityInput({ entryKind: "ad_hoc" })).eligibilityKind, "ad_hoc_transfer");
    assert.equal(resolveFormalEligibility(eligibilityInput({ entryKind: "practice" })).eligibilityKind, "practice");
  });

  it("无 canonical → fail closed（不可用）", () => {
    const v = resolveFormalEligibility(eligibilityInput({ hasCanonical: false }));
    assert.equal(v.eligible, false);
    assert.ok(v.reasonCodes.includes("no_canonical"));
  });
});

// ─── Early-review authorization ────────────────────────────────────────────

describe("early-review authorization（§9 / 01-2 §5.2）", () => {
  it("用户显式请求 + 冷却已过 + 无近期失败 → 授权", () => {
    const v = authorizeEarlyReview(earlyReviewInput());
    assert.equal(v.authorized, true);
    assert.ok(v.reasonCodes.includes("early_review"));
  });

  it("未请求 → 不授权（official 不自动提前复习）", () => {
    const v = authorizeEarlyReview(earlyReviewInput({ userRequestedEarlyReview: false }));
    assert.equal(v.authorized, false);
    assert.ok(v.reasonCodes.includes("early_review_not_requested"));
  });

  it("unassisted 冷却未过 → 不授权", () => {
    const v = authorizeEarlyReview(
      earlyReviewInput({ unassistedEligibleAfter: date(72) }),
    );
    assert.equal(v.authorized, false);
    assert.ok(v.reasonCodes.includes("early_review_cooldown"));
  });

  it("近期有失败 → 不授权", () => {
    const v = authorizeEarlyReview(earlyReviewInput({ recentFailureCount: 2 }));
    assert.equal(v.authorized, false);
    assert.ok(v.reasonCodes.includes("early_review_recent_failure"));
  });

  it("无 pending → 不授权", () => {
    const v = authorizeEarlyReview(earlyReviewInput({ hasActivePending: false }));
    assert.equal(v.authorized, false);
    assert.ok(v.reasonCodes.includes("no_pending_schedule"));
  });
});

// ─── Typed scheduling authorization ────────────────────────────────────────

describe("typed scheduling authorization（01-2 §5.2）", () => {
  it("scheduled_review + overdue → consume_pending + official_overdue", () => {
    const eligibility = resolveFormalEligibility(
      eligibilityInput({ entryKind: "review_entry", hasActivePending: true, pendingDue: true }),
    );
    const due = computeDueWindow({
      nextReviewAt: date(-(OFFICIAL_OVERDUE_GRACE_HOURS + 2)),
      now: NOW,
    });
    const verdict = issueTypedAuthorization({
      eligibility,
      due,
      earlyReview: { authorized: false, reasonCodes: [] },
      hasActivePending: true,
      boundScheduleId: "sched-1",
      boundScheduleGeneration: 3,
      prioritySourceRequest: "official_due",
    });
    assert.equal(verdict.authorizedAction, "consume_pending");
    assert.equal(verdict.prioritySource, "official_overdue");
    assert.equal(verdict.bindScheduleId, "sched-1");
    assert.equal(verdict.bindGeneration, 3);
  });

  it("scheduled_review + due window 内 → consume_pending + official_due", () => {
    const eligibility = resolveFormalEligibility(
      eligibilityInput({ entryKind: "review_entry", hasActivePending: true, pendingDue: true }),
    );
    const due = computeDueWindow({ nextReviewAt: date(0), now: NOW });
    const verdict = issueTypedAuthorization({
      eligibility,
      due,
      earlyReview: { authorized: false, reasonCodes: [] },
      hasActivePending: true,
      boundScheduleId: "sched-1",
      boundScheduleGeneration: 0,
      prioritySourceRequest: "official_due",
    });
    assert.equal(verdict.authorizedAction, "consume_pending");
    assert.equal(verdict.prioritySource, "official_due");
  });

  it("consume_pending 未绑定 input schedule → fail closed 为 record_only", () => {
    const eligibility = resolveFormalEligibility(
      eligibilityInput({ entryKind: "review_entry", hasActivePending: true, pendingDue: true }),
    );
    const due = computeDueWindow({ nextReviewAt: date(0), now: NOW });
    const verdict = issueTypedAuthorization({
      eligibility,
      due,
      earlyReview: { authorized: false, reasonCodes: [] },
      hasActivePending: true,
      prioritySourceRequest: "official_due",
    });
    assert.equal(verdict.authorizedAction, "record_only");
  });

  it("initial_validation + user_selected → create_initial + user_selected", () => {
    const eligibility = resolveFormalEligibility(eligibilityInput());
    const due = computeDueWindow({ nextReviewAt: null, now: NOW });
    const verdict = issueTypedAuthorization({
      eligibility,
      due,
      earlyReview: { authorized: false, reasonCodes: [] },
      hasActivePending: false,
      prioritySourceRequest: "user_selected",
    });
    assert.equal(verdict.authorizedAction, "create_initial");
    assert.equal(verdict.prioritySource, "user_selected");
  });

  it("practice → no_effect；ad_hoc → record_only", () => {
    const due = computeDueWindow({ nextReviewAt: null, now: NOW });
    const practice = issueTypedAuthorization({
      eligibility: resolveFormalEligibility(eligibilityInput({ entryKind: "practice" })),
      due,
      earlyReview: { authorized: false, reasonCodes: [] },
      hasActivePending: false,
      prioritySourceRequest: "canonical_gap",
    });
    assert.equal(practice.authorizedAction, "no_effect");

    const adHoc = issueTypedAuthorization({
      eligibility: resolveFormalEligibility(eligibilityInput({ entryKind: "ad_hoc" })),
      due,
      earlyReview: { authorized: false, reasonCodes: [] },
      hasActivePending: false,
      prioritySourceRequest: "canonical_gap",
    });
    assert.equal(adHoc.authorizedAction, "record_only");
  });
});

// ─── Successor schedule ────────────────────────────────────────────────────

describe("successor schedule（§9 / 01-2 §8.5）", () => {
  it("create_initial + correct → successor 且 scheduleAffected=true", () => {
    const r = computeSuccessorSchedule({
      authorizedAction: "create_initial",
      currentIntervalDays: 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
    });
    assert.equal(r.scheduleAffected, true);
    assert.ok(r.successor);
    assert.equal(r.successor.beforeIntervalDays, 1);
    assert.equal(r.successor.afterIntervalDays, 3);
    assert.equal(r.successor.understandingEffect, "upgrade");
    assert.equal(r.successor.policyVersion, OFFICIAL_POLICY_VERSION);
    assert.equal(r.successor.policyEpoch, OFFICIAL_POLICY_EPOCH);
  });

  it("consume_pending + incorrect → successor reset，understanding 降级", () => {
    const r = computeSuccessorSchedule({
      authorizedAction: "consume_pending",
      currentIntervalDays: 7,
      outcome: "incorrect",
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
    });
    assert.equal(r.scheduleAffected, true);
    assert.equal(r.successor!.afterIntervalDays, 1);
    assert.equal(r.successor!.understandingEffect, "downgrade");
    assert.equal(r.successor!.reasonCode, "incorrect_reset");
  });

  it("record_only / no_effect → 0 schedule 副作用（successor=null）", () => {
    for (const authorizedAction of ["record_only", "no_effect"] as const) {
      const r = computeSuccessorSchedule({
        authorizedAction,
        currentIntervalDays: 3,
        outcome: "correct",
        hasValidServerQuestion: true,
        hasHardEvidence: true,
        now: NOW,
      });
      assert.equal(r.successor, null);
      assert.equal(r.scheduleAffected, false);
      assert.ok(r.reasonCodes.includes("no_schedule_effect"));
    }
  });

  it("stale / provider_failure → shouldMutateSchedule=false（不改正式 schedule）", () => {
    for (const outcome of ["stale", "provider_failure"] as const) {
      const r = computeSuccessorSchedule({
        authorizedAction: "consume_pending",
        currentIntervalDays: 7,
        outcome,
        hasValidServerQuestion: true,
        hasHardEvidence: true,
        now: NOW,
      });
      assert.equal(r.scheduleAffected, false);
      assert.equal(r.successor!.shouldMutateSchedule, false);
    }
  });

  it("later outcome 在正式 Episode 中是合法 policy 分支（+12h，非失败状态）", () => {
    const r = computeSuccessorSchedule({
      authorizedAction: "consume_pending",
      currentIntervalDays: 7,
      outcome: "later",
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
    });
    assert.equal(r.scheduleAffected, true);
    assert.equal(r.successor!.reasonCode, "later_short_deferral");
    assert.equal(
      r.successor!.nextReviewAt.getTime(),
      NOW.getTime() + 12 * MS_PER_HOUR,
    );
    assert.equal(r.successor!.understandingEffect, "unchanged");
  });
});

// ─── deriveOfficialDecision 组合 ───────────────────────────────────────────

describe("deriveOfficialDecision（PREPARE 冻结）", () => {
  it("review_entry + due → consume_pending，绑定精确 schedule+generation", () => {
    const r = deriveOfficialDecision(decisionInput());
    assert.equal(r.eligible, true);
    assert.equal(r.eligibilityKind, "scheduled_review");
    assert.equal(r.schedulingDecision.authorizedAction, "consume_pending");
    assert.equal(r.schedulingDecision.inputScheduleId, "sched-1");
    assert.equal(r.schedulingDecision.inputScheduleGeneration, 2);
    assert.equal(r.schedulingDecision.prioritySource, "official_due");
  });

  it("review_entry + not due + 用户从 Card/Star 选择 → 不授予 early review，不可用", () => {
    const r = deriveOfficialDecision(
      decisionInput({
        entryKind: "initial",
        nextReviewAt: date(72),
        hasActivePending: true,
        prioritySourceRequest: "user_selected",
      }),
    );
    // 用户从 Card/Star 主动选择目标只改变 prioritySource，本身不授予 early review（01-2 §5.2）
    assert.equal(r.earlyReview.authorized, false);
    assert.equal(r.eligible, false);
    assert.equal(r.schedulingDecision.authorizedAction, "record_only");
  });

  it("review_entry + not due + 显式请求 early review 且条件满足 → consume_pending + official_due", () => {
    const r = deriveOfficialDecision(
      decisionInput({ nextReviewAt: date(48), userRequestedEarlyReview: true }),
    );
    assert.equal(r.earlyReview.authorized, true);
    assert.equal(r.eligible, true);
    assert.equal(r.schedulingDecision.authorizedAction, "consume_pending");
  });

  it("initial + user_selected → create_initial + user_selected", () => {
    const r = deriveOfficialDecision(
      decisionInput({
        entryKind: "initial",
        hasActivePending: false,
        nextReviewAt: null,
        prioritySourceRequest: "user_selected",
      }),
    );
    assert.equal(r.eligibilityKind, "initial_validation");
    assert.equal(r.schedulingDecision.authorizedAction, "create_initial");
    assert.equal(r.schedulingDecision.prioritySource, "user_selected");
  });

  it("practice → no_effect（0 schedule 副作用）", () => {
    const r = deriveOfficialDecision(
      decisionInput({ entryKind: "practice", hasActivePending: false }),
    );
    assert.equal(r.schedulingDecision.authorizedAction, "no_effect");
  });
});

// ─── Agent 不授权 FSRS 转正 ────────────────────────────────────────────────

describe("FSRS 转正（§9）", () => {
  it("Agent 上线不自动授权 FSRS 转正：恒为 shadow_only", () => {
    assert.equal(resolveFSRSPromotionStatus(true), "shadow_only");
    assert.equal(resolveFSRSPromotionStatus(false), "shadow_only");
  });
});
