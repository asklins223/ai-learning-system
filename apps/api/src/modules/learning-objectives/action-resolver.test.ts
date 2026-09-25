/**
 * Plan 23 W2-15/W2-16：Primary Action 解析器单元测试。
 * 优先级：superseded > archived/blocked > resume > review due > initial ready
 * > practice_only > initial deferred > create_run。
 * （2026-09-25 W4-2：active 目标不再因为"没有卡"落到 refresh——见下面四条无卡用例。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLatestCompletedRunV3, resolvePrimaryActionV3, type ActionResolverInputV3 } from "./action-resolver.ts";

const OBJ = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const RUN = "55555555-5555-4555-8555-555555555555";
const SCHED = "66666666-6666-4666-8666-666666666666";
const REMINDER = "77777777-7777-4777-8777-777777777777";

function base(over: Partial<ActionResolverInputV3> = {}): ActionResolverInputV3 {
  return {
    objectiveId: OBJ,
    lifecycle: "active",
    successorObjectiveId: null,
    successorCardId: null,
    cardId: CARD,
    activeRun: null,
    hasPriorFormalResult: false,
    reviewDue: null,
    initialReady: null,
    initialDeferred: null,
    practiceOnly: false,
    practiceReasonCodes: [],
    lastResultOutcome: null,
    answerModePreference: "any",
    ...over,
  };
}

test("superseded → view_successor（携带 successor 稳定 ID）", () => {
  const action = resolvePrimaryActionV3(
    base({ lifecycle: "superseded", successorObjectiveId: "99999999-9999-4999-8999-999999999999" }),
  );
  assert.equal(action.kind, "view_successor");
  if (action.kind === "view_successor") {
    assert.equal(action.successorObjectiveId, "99999999-9999-4999-8999-999999999999");
  }
});

test("archived → none；blocked_content_upgrade → refresh", () => {
  assert.equal(resolvePrimaryActionV3(base({ lifecycle: "archived" })).kind, "none");
  assert.equal(resolvePrimaryActionV3(base({ lifecycle: "blocked_content_upgrade" })).kind, "refresh");
});

test("activeRun 优先于 review due（resume > review）", () => {
  const action = resolvePrimaryActionV3(
    base({ activeRun: { runId: RUN }, reviewDue: { scheduleId: SCHED, generation: 2 } }),
  );
  assert.deepEqual(action, { kind: "resume_run", runId: RUN, objectiveId: OBJ });
});

test("review due 优先于 initial ready，携带精确 scheduleId/generation", () => {
  const action = resolvePrimaryActionV3(
    base({ reviewDue: { scheduleId: SCHED, generation: 3 }, initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" } }),
  );
  assert.deepEqual(action, {
    kind: "create_review_run",
    objectiveId: OBJ,
    label: "开始到期复习",
    start: {
      version: 2,
      originV2: { kind: "review", scheduleId: SCHED, objectiveId: OBJ, scheduleGeneration: 3 },
      goal: "stabilize",
      requestedTimeBudgetSeconds: 180,
      responsePreference: "adaptive",
    },
  });
});

test("initial ready → create_run（启动参数由服务端完整下发）", () => {
  const action = resolvePrimaryActionV3(
    base({ initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" } }),
  );
  assert.deepEqual(action, {
    kind: "create_run",
    objectiveId: OBJ,
    label: "开始首次验证",
    start: {
      version: 2,
      originV2: { kind: "card", cardId: CARD, objectiveId: OBJ },
      goal: "stabilize",
      requestedTimeBudgetSeconds: 180,
      responsePreference: "adaptive",
    },
  });
});

test("已有正式结果时，重新挑战不能再写成首次验证", () => {
  const action = resolvePrimaryActionV3(base({
    hasPriorFormalResult: true,
    initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" },
  }));
  assert.equal(action.kind, "create_run");
  assert.equal(action.label, "再做一次正式挑战");
});

test("initial deferred → wait_for_initial_validation（§7.5）", () => {
  const action = resolvePrimaryActionV3(
    base({ initialDeferred: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" } }),
  );
  assert.deepEqual(action, {
    kind: "wait_for_initial_validation",
    reminderId: REMINDER,
    qualificationNotBefore: "2026-08-16T00:00:00.000Z",
  });
});

test("看过答案 + 正式验证还在冷却 = 练习照给，不是整卡停用（复盘 #9）", () => {
  const action = resolvePrimaryActionV3(base({
    initialDeferred: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" },
    practiceOnly: true,
    practiceReasonCodes: ["exposed"],
  }));
  assert.deepEqual(action, {
    kind: "practice_only",
    objectiveId: OBJ,
    reasonCodes: ["exposed"],
    label: "带着参考答案练一下",
    start: {
      version: 2,
      originV2: { kind: "card", cardId: CARD, objectiveId: OBJ },
      goal: "stabilize",
      requestedTimeBudgetSeconds: 180,
      responsePreference: "adaptive",
    },
    formalValidationNotBefore: "2026-08-16T00:00:00.000Z",
  });
});

test("冷却到期（initialReady）时正式验证重新压过练习", () => {
  const action = resolvePrimaryActionV3(base({
    initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-08-15T00:00:00.000Z" },
    practiceOnly: true,
    practiceReasonCodes: ["exposed"],
  }));
  assert.equal(action.kind, "create_run");
  assert.equal(action.label, "开始首次验证");
});

test("practice_only → practice_only（reasonCodes 保留服务端裁决）", () => {
  const action = resolvePrimaryActionV3(
    base({ practiceOnly: true, practiceReasonCodes: ["exposed", "practice_only_ledger"] }),
  );
  assert.equal(action.kind, "practice_only");
  if (action.kind === "practice_only") {
    assert.deepEqual(action.reasonCodes, ["exposed", "practice_only_ledger"]);
    // 没有冷却记录时明确给 null，而不是留一个"看起来永远等不到"的时间。
    assert.equal(action.formalValidationNotBefore, null);
  }
});

test("无个人状态但有 active Card → create_run（home 默认 origin）", () => {
  const action = resolvePrimaryActionV3(base());
  assert.equal(action.kind, "create_run");
});

test("active 但无 Card 且无个人状态 → 开始学习，origin 走无卡那一种（W4-2）", () => {
  const action = resolvePrimaryActionV3(base({ cardId: null }));
  assert.equal(action.kind, "create_run");
  if (action.kind === "create_run") {
    assert.equal(action.label, "开始学习");
    assert.deepEqual(action.start.originV2, { kind: "today", objectiveId: OBJ });
  }
});

test("无卡的 initialReady 不再落到 refresh：给正式验证，origin 是无卡那一种", () => {
  const action = resolvePrimaryActionV3(base({
    cardId: null,
    initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-09-20T00:00:00.000Z" },
  }));
  assert.equal(action.kind, "create_run");
  if (action.kind === "create_run") {
    assert.equal(action.label, "开始首次验证");
    assert.equal(action.start.originV2.kind, "today");
  }
});

test("无卡且已 reveal 过 → 练习入口照给（此前是 refresh，一次好奇换一整天死路）", () => {
  const action = resolvePrimaryActionV3(base({ cardId: null, practiceOnly: true }));
  assert.equal(action.kind, "practice_only");
  if (action.kind === "practice_only") assert.equal(action.start.originV2.kind, "today");
});

test("有卡时三种情况都仍走 card origin，且带 cardId（无卡改动不许顺手改掉有卡那一半）", () => {
  const plain = resolvePrimaryActionV3(base());
  assert.equal(plain.kind, "create_run");
  if (plain.kind === "create_run") {
    assert.deepEqual(plain.start.originV2, { kind: "card", cardId: CARD, objectiveId: OBJ });
  }
  const ready = resolvePrimaryActionV3(base({
    initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-09-20T00:00:00.000Z" },
  }));
  assert.equal(ready.kind, "create_run");
  if (ready.kind === "create_run") assert.equal(ready.start.originV2.kind, "card");
  const practice = resolvePrimaryActionV3(base({ practiceOnly: true }));
  assert.equal(practice.kind, "practice_only");
  if (practice.kind === "practice_only") assert.equal(practice.start.originV2.kind, "card");
});

test("generation=0 的 review 不会生成不可执行启动参数", () => {
  assert.deepEqual(resolvePrimaryActionV3(base({ reviewDue: { scheduleId: SCHED, generation: 0 } })), { kind: "refresh" });
});

// ─── doc 34 L15：账号「作答方式」偏好要真的进到启动参数 ────────────────────
// 这三条存在的理由：过去 `responsePreference` 在本文件两处硬写 `adaptive`，
// 设置页那个三选纯展示。把两处改回硬编码，下面每一条都会红。

test("作答偏好 voice：卡开跑与到期复习都换成语音优先的启动参数", () => {
  const card = resolvePrimaryActionV3(base({ answerModePreference: "voice" }));
  assert.equal(card.kind, "create_run");
  if (card.kind === "create_run") assert.equal(card.start.responsePreference, "voice");
  const review = resolvePrimaryActionV3(base({ answerModePreference: "voice", reviewDue: { scheduleId: SCHED, generation: 1 } }));
  assert.equal(review.kind, "create_review_run");
  if (review.kind === "create_review_run") assert.equal(review.start.responsePreference, "voice");
});

test("作答偏好 silent → structured（不是 text）", () => {
  const action = resolvePrimaryActionV3(base({ answerModePreference: "silent" }));
  assert.equal(action.kind === "create_run" && action.start.responsePreference, "structured");
});

test("作答偏好未设置（any）才走 adaptive，text 原样透传", () => {
  const unset = resolvePrimaryActionV3(base({ answerModePreference: "any" }));
  assert.equal(unset.kind === "create_run" && unset.start.responsePreference, "adaptive");
  const text = resolvePrimaryActionV3(base({ answerModePreference: "text" }));
  assert.equal(text.kind === "create_run" && text.start.responsePreference, "text");
});

test("偏好不改变行动种类：语音偏好也拿不到越过冷却的正式验证", () => {
  const action = resolvePrimaryActionV3(base({
    answerModePreference: "voice",
    initialDeferred: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" },
    practiceOnly: true,
    practiceReasonCodes: ["exposed"],
  }));
  assert.equal(action.kind, "practice_only");
});

// ─── §3.2 第三种情况「最近一轮仍有明显缺口」（39d W4-2 第三刀收尾）─────────
//
// 判这条的是**服务端**，不是页面：列表、详情、星图三处都把最近一轮的结论喂进来，
// 动词由这里换一个，action kind 与开出去的那一轮一个字都不变。
// 反过来，"客户端看 latestResult 自己判"是这一组用例存在的原因——那样同一张卡
// 会在两块屏上说出两个动词。

test("最近一轮判成 needs_repair ⇒ 动词换成「接着弄懂…」，但仍是同一个 create_run", () => {
  const gap = resolvePrimaryActionV3(base({ lastResultOutcome: "needs_repair" }));
  const fresh = resolvePrimaryActionV3(base());
  assert.equal(gap.kind, "create_run");
  assert.ok(gap.kind === "create_run" && fresh.kind === "create_run");
  assert.equal(gap.label, "接着弄懂上次没弄通的地方");
  assert.equal(fresh.label, "开始学习");
  // 开出去的那一轮必须**逐字节相同**：换一个词不许顺手换 origin。
  assert.deepEqual(gap.start, fresh.start);
});

test("partial 也算缺口；判不了／练过／答对过都不算", () => {
  const createRunLabel = (over: Partial<ActionResolverInputV3>): string => {
    const action = resolvePrimaryActionV3(base(over));
    assert.ok(action.kind === "create_run", `期望 create_run，实际 ${action.kind}`);
    return action.label;
  };
  assert.equal(createRunLabel({ lastResultOutcome: "partial" }), "接着弄懂上次没弄通的地方");
  // `not_assessable` 是"这一轮我判不了"，说成缺口是把系统的无能报成用户的缺陷。
  for (const outcome of ["not_assessable", "demonstrated", "practice_completed", "skipped", "declared_unable"]) {
    assert.equal(
      createRunLabel({ lastResultOutcome: outcome }),
      "开始学习",
      `${outcome} 不该被当成明显缺口`,
    );
  }
});

test("缺口不许插到更靠前的判断前面：有未完成那一轮时仍是「继续作答」", () => {
  const action = resolvePrimaryActionV3(base({
    activeRun: { runId: RUN },
    lastResultOutcome: "needs_repair",
  }));
  assert.equal(action.kind, "resume_run");
  const due = resolvePrimaryActionV3(base({
    reviewDue: { scheduleId: SCHED, generation: 2 },
    lastResultOutcome: "needs_repair",
  }));
  assert.equal(due.kind, "create_review_run");
  // 动词也要一起钉住：这一档说的是"回访到点了"，把缺口词漏到这里就是两个判断抢一个按钮。
  assert.equal(due.kind === "create_review_run" && due.label, "开始到期复习");
  // 参考答案看过的那一轮优先给练习（练不推进正式证据），缺口词不抢它。
  const practice = resolvePrimaryActionV3(base({
    practiceOnly: true,
    practiceReasonCodes: ["exposed"],
    lastResultOutcome: "needs_repair",
  }));
  assert.equal(practice.kind, "practice_only");
});

test("最近一轮按判完的时刻取，不按开始的时刻取（三处装配同一条口径）", () => {
  // 先开后交、后开后交：createdAt 最大的那一轮**不是**最近的结论。
  const rows = [
    { runId: "a", outcome: "demonstrated", updatedAt: new Date("2026-09-20T10:00:00Z") },
    { runId: "b", outcome: "needs_repair", updatedAt: new Date("2026-09-21T09:00:00Z") },
  ];
  assert.equal(pickLatestCompletedRunV3(rows)?.runId, "b");
  assert.equal(pickLatestCompletedRunV3([...rows].reverse())?.runId, "b");
  // 没有结论／结论不合枚举的行都不算（老数据里 result 可能是别的形状）。
  assert.equal(pickLatestCompletedRunV3([
    { runId: "c", outcome: null, updatedAt: new Date("2026-09-22T09:00:00Z") },
    { runId: "d", outcome: "gone_fishing", updatedAt: new Date("2026-09-23T09:00:00Z") },
    { runId: "e", outcome: "partial", updatedAt: new Date("2026-09-19T09:00:00Z") },
  ])?.runId, "e");
  assert.equal(pickLatestCompletedRunV3([]), null);
});
