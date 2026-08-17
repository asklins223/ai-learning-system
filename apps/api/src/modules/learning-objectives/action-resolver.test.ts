/**
 * Plan 23 W2-15/W2-16：Primary Action 解析器单元测试。
 * 优先级：superseded > archived/blocked > resume > review due > initial ready
 * > practice_only > create_run > refresh/none。
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
    reviewDue: null,
    initialReady: null,
    practiceOnly: false,
    practiceReasonCodes: [],
    origin: "card",
    goal: "首次验证",
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
    scheduleId: SCHED,
    generation: 3,
  });
});

test("initial ready → create_run（origin/goal 来自入口）", () => {
  const action = resolvePrimaryActionV3(
    base({ initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" }, origin: "graph" }),
  );
  assert.deepEqual(action, {
    kind: "create_run",
    origin: "graph",
    objectiveId: OBJ,
    cardId: CARD,
    goal: "首次验证",
  });
});

test("practice_only → practice_only（reasonCodes 保留服务端裁决）", () => {
  const action = resolvePrimaryActionV3(
    base({ practiceOnly: true, practiceReasonCodes: ["exposed", "practice_only_ledger"] }),
  );
  assert.equal(action.kind, "practice_only");
  if (action.kind === "practice_only") {
    assert.deepEqual(action.reasonCodes, ["exposed", "practice_only_ledger"]);
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

test("非法 origin 被 schema 拒绝（不产生 label 猜测）", () => {
  assert.throws(() =>
    resolvePrimaryActionV3(base({ initialReady: { reminderId: REMINDER, qualificationNotBefore: "2026-08-16T00:00:00.000Z" }, origin: "guess" as never })),
  );
});
