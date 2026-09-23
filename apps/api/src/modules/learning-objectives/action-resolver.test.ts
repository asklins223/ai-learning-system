/**
 * Plan 23 W2-15/W2-16：Primary Action 解析器单元测试。
 * 优先级：superseded > archived/blocked > resume > review due > initial ready
 * > practice_only > initial deferred > create_run > refresh/none。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePrimaryActionV3, type ActionResolverInputV3 } from "./action-resolver.ts";

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
    hasActiveCard: true,
    cardId: CARD,
    activeRun: null,
    hasPriorFormalResult: false,
    reviewDue: null,
    initialReady: null,
    initialDeferred: null,
    practiceOnly: false,
    practiceReasonCodes: [],
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

test("active 但无 Card 且无个人状态 → refresh（修复入口）", () => {
  const action = resolvePrimaryActionV3(base({ hasActiveCard: false, cardId: null }));
  assert.equal(action.kind, "refresh");
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
