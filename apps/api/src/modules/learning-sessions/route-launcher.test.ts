/**
 * 任务 06-5：「此刻」轻量路线启动器 单测（§9）。
 *
 * 覆盖（06-w5 任务 06-5 + §16.1/§16.4）：
 * - 默认只展示一条有理由的推荐路线；「换一个」才生成并替换；
 * - 换一组 / 减少数量 / 稍后 / 自由漫游 / 查看详细到期事实；
 * - 不要求清空、不显示红色欠账、不自动进入下一轮；
 * - later 是合法用户选择，不是失败状态；
 * - 非强迫恢复：长时间未使用先询问时间、只选少量、未处理 schedule 保留事实；
 * - later/dismiss/stop 不修改 schedule、偏好或理解状态（sideEffects 只含 none）；
 * - FSRS shadow 0 路线影响：附加 shadow 字段不改变排序/推荐，文案不含 FSRS。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_ROUTE_ITEMS,
  RECOVERY_MAX_ITEMS,
  answerAvailableTime,
  answerIntent,
  buildRecommendedRoute,
  createRouteLauncher,
  deferLater,
  dismissRoute,
  replaceRoute,
  requestNextRound,
  selectToBegin,
  shiftGroup,
  shrinkRoute,
  shouldAskTimeFirst,
  startFreeRoam,
  stop,
  viewDueFacts,
  type RouteCandidate,
  type RouteLaunchContext,
  type RouteLaunchState,
} from "./route-launcher.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-08T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function candidate(kp: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    keyPointId: kp,
    cardId: `card-${kp}`,
    claim: `claim-${kp}`,
    schedulingDecisionRef: `sched:${kp}`,
    prioritySource: "canonical_gap",
    authorizedAction: "create_initial",
    eligibilityKind: "initial_validation",
    dueAt: null,
    overdue: false,
    reasonCodes: ["fixture"],
    estimatedMinutes: 5,
    ...overrides,
  };
}

function sampleCandidates(): RouteCandidate[] {
  return [
    candidate("kp-a", { prioritySource: "official_overdue", overdue: true, dueAt: daysAgo(3), reasonCodes: ["official_schedule_overdue"] }),
    candidate("kp-b", { prioritySource: "official_due", dueAt: NOW, reasonCodes: ["official_schedule_due"] }),
    candidate("kp-c", { reasonCodes: ["canonical_gap_target"] }),
    candidate("kp-d", { prioritySource: "official_due", dueAt: NOW, estimatedMinutes: 8, reasonCodes: ["official_schedule_due"] }),
  ];
}

function launcherState(overrides: Partial<RouteLaunchContext> = {}): RouteLaunchState {
  return createRouteLauncher({
    candidates: sampleCandidates(),
    now: NOW,
    availableMinutes: 30,
    ...overrides,
  });
}

function sideEffectKinds(state: RouteLaunchState): string[] {
  return state.sideEffects.map((s) => s.kind);
}

// ─── 默认只展示一条推荐路线 ────────────────────────────────────────────────

describe("默认推荐（§9）", () => {
  it("已知时间 → 直接展示一条有理由的推荐路线", () => {
    const s = launcherState();
    assert.equal(s.phase, "recommend");
    assert.ok(s.currentRoute !== null);
    assert.ok(s.currentRoute.recommendation.length > 0);
  });

  it("推荐理由只基于 official 事实（含到期优先级与预计时长）", () => {
    const s = launcherState();
    const rec = s.currentRoute!.recommendation;
    assert.ok(rec.includes("到期"));
    assert.ok(rec.includes("kp-a"));
    assert.ok(rec.includes("分钟"));
    assert.ok(!rec.includes("fsrs") && !rec.includes("FSRS"));
  });

  it("无可用候选 → 不推荐，文案不施加压力", () => {
    const s = createRouteLauncher({ candidates: [], now: NOW, availableMinutes: 10 });
    assert.equal(s.currentRoute, null);
    assert.ok(s.output.length > 0);
  });
});

// ─── 换一个 / 换一组 / 减少数量 ────────────────────────────────────────────

describe("换一个 / 换一组 / 减少数量", () => {
  it("换一个：排除当前推荐目标，生成并替换成一条新推荐", () => {
    const s0 = launcherState();
    assert.equal(s0.currentRoute!.keyPointIds[0], "kp-a"); // overdue 最优先
    const oldIds = [...s0.currentRoute!.keyPointIds];
    const s1 = replaceRoute(s0);
    assert.ok(s1.currentRoute !== null);
    assert.ok(
      s1.currentRoute.keyPointIds.every((id) => !oldIds.includes(id)),
      "旧推荐目标不得再出现",
    );
    for (const id of oldIds) {
      assert.ok(s1.excludedKeyPointIds.includes(id));
    }
    assert.ok(sideEffectKinds(s1).every((k) => k === "none"));
  });

  it("换一个连续多次：目标不重复，最终没有更多可换", () => {
    let s = launcherState();
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const ids = s.currentRoute?.keyPointIds ?? [];
      for (const id of ids) {
        assert.ok(!seen.has(id), `目标 ${id} 不应重复出现`);
        seen.add(id);
      }
      s = replaceRoute(s);
    }
    assert.equal(s.currentRoute, null);
    assert.ok(s.output.includes("没有更多"));
  });

  it("换一组：输出不同的目标组合", () => {
    const s0 = launcherState();
    const s1 = shiftGroup(s0);
    assert.ok(s1.currentRoute !== null);
    assert.ok(
      s1.currentRoute.keyPointIds.some((id) => !s0.currentRoute!.keyPointIds.includes(id)),
    );
    assert.ok(sideEffectKinds(s1).every((k) => k === "none"));
  });

  it("减少数量：只保留前 targetCount 个目标并重算时长", () => {
    const s = launcherState();
    assert.ok(s.currentRoute!.items.length >= 1);
    const total = s.currentRoute!.estimatedMinutes;
    const s1 = shrinkRoute(s, 1);
    assert.equal(s1.currentRoute!.items.length, 1);
    assert.ok(s1.currentRoute!.estimatedMinutes < total || s1.currentRoute!.estimatedMinutes === s1.currentRoute!.items[0]!.estimatedMinutes);
    assert.ok(sideEffectKinds(s1).every((k) => k === "none"));
  });
});

// ─── 稍后（later 是合法选择，不是失败状态）────────────────────────────────

describe("later（§9）", () => {
  it("稍后：目标移出当前推荐并记入 later，schedule 事实保持不变", () => {
    const s0 = launcherState();
    const before = s0.candidates;
    const s1 = deferLater(s0, "kp-a");
    assert.ok(s1.laterKeyPointIds.includes("kp-a"));
    assert.ok(!s1.currentRoute!.keyPointIds.includes("kp-a"));
    assert.deepEqual(s1.candidates, before, "later 不得修改 schedule 事实");
    assert.ok(sideEffectKinds(s1).every((k) => k === "none"));
  });

  it("全部稍后 → 清空当前路线但不自动进入下一轮、不自动生成替代", () => {
    let s = launcherState();
    // 把当前路线全部目标稍后
    for (const id of [...s.currentRoute!.keyPointIds]) {
      s = deferLater(s, id);
    }
    assert.equal(s.currentRoute, null);
    assert.equal(s.phase, "recommend");
    assert.ok(!s.sideEffects.some((e) => e.kind === "begin_episode"));
  });

  it("稍后不是失败状态：无失败标记、无负向记录", () => {
    const s1 = deferLater(launcherState(), "kp-a");
    assert.ok(sideEffectKinds(s1).every((k) => k === "none"));
    assert.ok(!s1.output.includes("失败") && !s1.output.includes("欠"));
  });
});

// ─── 自由漫游 / 到期事实 ───────────────────────────────────────────────────

describe("自由漫游与到期事实", () => {
  it("自由漫游：practice-only，文案明确不影响进度", () => {
    const s = startFreeRoam(launcherState());
    assert.equal(s.phase, "free_roam");
    assert.ok(s.currentRoute !== null);
    assert.equal(s.currentRoute.mode, "free_roam");
    assert.ok(s.currentRoute.recommendation.includes("不影响进度"));
    assert.ok(sideEffectKinds(s).every((k) => k === "none"));
  });

  it("查看详细到期事实：列出事实，不改变任何 schedule", () => {
    const s0 = launcherState();
    const before = s0.candidates;
    const s = viewDueFacts(s0);
    assert.equal(s.phase, "viewing_due");
    assert.ok(s.output.includes("到期"));
    assert.ok(s.output.includes("kp-a"));
    assert.deepEqual(s.candidates, before, "查看到期事实不得修改 schedule");
    assert.ok(sideEffectKinds(s).every((k) => k === "none"));
  });

  it("无红账：到期事实文本不含道德化语言", () => {
    const s = viewDueFacts(launcherState());
    for (const word of ["欠", "失败", "落后", "红色", "债务"]) {
      assert.ok(!s.output.includes(word), `到期事实不应包含「${word}」`);
    }
  });
});

// ─── 不自动进入下一轮 ──────────────────────────────────────────────────────

describe("不自动进入下一轮（§9）", () => {
  it("stop → done，不生成新推荐", () => {
    const s = stop(launcherState());
    assert.equal(s.phase, "done");
    assert.equal(s.currentRoute, null);
    assert.ok(sideEffectKinds(s).every((k) => k === "none"));
  });

  it("dismiss → 关闭推荐，不自动推荐下一条", () => {
    const s = dismissRoute(launcherState());
    assert.equal(s.currentRoute, null);
    assert.equal(s.phase, "recommend");
    assert.ok(!s.sideEffects.some((e) => e.kind === "begin_episode"));
  });

  it("requestNextRound 是显式请求才进入下一轮（绝不自动）", () => {
    const s = launcherState();
    assert.ok(s.currentRoute !== null);
    const s1 = requestNextRound(s);
    assert.equal(s1.phase, "recommend");
    assert.ok(sideEffectKinds(s1).every((k) => k === "none"));
  });
});

// ─── 非强迫恢复 ────────────────────────────────────────────────────────────

describe("非强迫恢复（§9）", () => {
  it("长时间未使用 + 未知时间 → 先询问当前可投入时间", () => {
    const s = createRouteLauncher({
      candidates: sampleCandidates(),
      now: NOW,
      lastUsedAt: daysAgo(10),
    });
    assert.equal(s.phase, "ask_time");
    assert.ok(s.output.includes("分钟"));
    assert.equal(s.currentRoute, null);
  });

  it("首次进入（无 lastUsedAt）+ 未知时间 → 询问", () => {
    assert.equal(shouldAskTimeFirst(null, NOW), true);
    const s = createRouteLauncher({ candidates: sampleCandidates(), now: NOW });
    assert.equal(s.phase, "ask_time");
  });

  it("最近使用过且已知时间 → 直接推荐（沿用可用时间）", () => {
    const s = createRouteLauncher({
      candidates: sampleCandidates(),
      now: NOW,
      lastUsedAt: daysAgo(1),
      availableMinutes: 20,
    });
    assert.equal(s.phase, "recommend");
  });

  it("回答可用时间后：只选少量内容（恢复上限）", () => {
    let s = createRouteLauncher({
      candidates: sampleCandidates(),
      now: NOW,
      lastUsedAt: daysAgo(10),
    });
    s = answerAvailableTime(s, 10);
    assert.equal(s.phase, "recommend");
    assert.ok(s.currentRoute !== null);
    assert.ok(s.currentRoute.items.length <= RECOVERY_MAX_ITEMS);
    assert.ok(s.currentRoute.items.length <= DEFAULT_MAX_ROUTE_ITEMS);
  });

  it("回答 0 分钟 → 不开始，无副作用", () => {
    let s = createRouteLauncher({
      candidates: sampleCandidates(),
      now: NOW,
      lastUsedAt: daysAgo(10),
    });
    s = answerAvailableTime(s, 0);
    assert.equal(s.phase, "done");
    assert.ok(sideEffectKinds(s).every((k) => k === "none"));
  });

  it("未处理 schedule 保留事实：恢复/稍后/查看都不会静默完成或延期任何目标", () => {
    const before = sampleCandidates();
    let s = createRouteLauncher({ candidates: before, now: NOW, lastUsedAt: daysAgo(10) });
    s = answerAvailableTime(s, 10);
    s = deferLater(s, s.currentRoute!.keyPointIds[0]!);
    s = viewDueFacts(s);
    s = dismissRoute(s);
    assert.deepEqual(s.candidates, before, "未处理 schedule 必须保留事实");
    assert.ok(sideEffectKinds(s).every((k) => k === "none"));
  });
});

// ─── later/dismiss/stop 不修改 schedule/偏好/理解状态 ──────────────────────

describe("零副作用保证（§16.4）", () => {
  it("later/dismiss/stop/replace/shift/shrink/view 全部只产生 none 副作用", () => {
    const actions: Array<(s: RouteLaunchState) => RouteLaunchState> = [
      (s) => deferLater(s, "kp-a"),
      dismissRoute,
      stop,
      replaceRoute,
      shiftGroup,
      (s) => shrinkRoute(s, 1),
      viewDueFacts,
      startFreeRoam,
      requestNextRound,
    ];
    for (const action of actions) {
      const next = action(launcherState());
      assert.ok(
        sideEffectKinds(next).every((k) => k === "none"),
        `动作 ${action.name} 不应产生 schedule/偏好/理解状态修改`,
      );
    }
  });

  it("selectToBegin 是唯一允许的副作用，且只引用 official decisionRef", () => {
    const s = launcherState();
    const target = s.currentRoute!.items[0]!;
    const s1 = selectToBegin(s, target.keyPointId);
    const effects = s1.sideEffects.filter((e) => e.kind === "begin_episode");
    assert.equal(effects.length, 1);
    const begin = effects[0]!;
    assert.equal(begin.kind, "begin_episode");
    assert.equal(begin.schedulingDecisionRef, target.schedulingDecisionRef);
  });

  it("目标不在当前路线中 → 不能开始", () => {
    const s = launcherState();
    const s1 = selectToBegin(s, "kp-c");
    assert.ok(!s1.sideEffects.some((e) => e.kind === "begin_episode"));
  });
});

// ─── 时间预算与确定性 ──────────────────────────────────────────────────────

describe("时间预算与确定性", () => {
  it("时间预算裁剪：只选预算内目标", () => {
    const route = buildRecommendedRoute(sampleCandidates(), {
      now: NOW,
      availableMinutes: 6,
      intent: "stabilize",
    });
    assert.ok(route !== null);
    // kp-a(5) 加入；kp-b(5) 超预算跳过；其余跳过 → 只有 kp-a
    assert.deepEqual(route.keyPointIds, ["kp-a"]);
    assert.ok(route.estimatedMinutes <= 6);
  });

  it("相同输入 → 相同推荐（确定性）", () => {
    const a = buildRecommendedRoute(sampleCandidates(), { now: NOW, availableMinutes: 30 });
    const b = buildRecommendedRoute(sampleCandidates(), { now: NOW, availableMinutes: 30 });
    assert.deepEqual(a, b);
  });

  it("回答意图：更新输入条件后重新推荐", () => {
    const s = answerIntent(launcherState(), "explore");
    assert.equal(s.intent, "explore");
    assert.ok(s.currentRoute !== null);
  });
});

// ─── FSRS shadow 0 路线影响 ────────────────────────────────────────────────

describe("FSRS shadow 0 路线影响（§16.1）", () => {
  it("候选附加 FSRS shadow 字段不改变排序与推荐结果", () => {
    const base = sampleCandidates();
    const withShadow = base.map(
      (c) => c as RouteCandidate & { fsrsStability: number; fsrsPredictedDue: string },
    );
    withShadow.forEach((c, i) => {
      c.fsrsStability = 100 - i;
      c.fsrsPredictedDue = new Date(NOW.getTime() + (i + 1) * MS_PER_DAY).toISOString();
    });

    const a = buildRecommendedRoute(base, { now: NOW, availableMinutes: 30, intent: "stabilize" });
    const b = buildRecommendedRoute(withShadow, {
      now: NOW,
      availableMinutes: 30,
      intent: "stabilize",
    });
    assert.deepEqual(b, a, "shadow 字段不得影响路线选择/排序/推荐理由");
  });

  it("推荐理由与到期事实不含任何 FSRS 标识", () => {
    const s = launcherState();
    const text = [s.output, viewDueFacts(s).output, startFreeRoam(s).output].join("\n");
    assert.ok(!/fsrs/i.test(text));
  });
});
