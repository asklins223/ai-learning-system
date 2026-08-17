/**
 * Plan 23 FE-18/RUN-01..03：typed action → 路由映射测试。
 * - 每个 action kind 生成正确 createRunV2 参数（origin=card_v2/review_v2）；
 * - resume 只恢复服务端 runId；
 * - none/refresh 不产生跳转；
 * - 禁止 label 推断（映射由类型穷尽保证）。
 */
import { describe, it, expect } from "vitest";
import { objectiveActionHref } from "./action-navigation.ts";

const OBJ = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const RUN = "55555555-5555-4555-8555-555555555555";
const SCHED = "66666666-6666-4666-8666-666666666666";
const SUCCESSOR = "99999999-9999-4999-8999-999999999999";

describe("objectiveActionHref", () => {
  it("create_run → /learning-runs/new 携带 card_v2 origin + objectiveId + goal", () => {
    const href = objectiveActionHref(
      { kind: "create_run", origin: "card", objectiveId: OBJ, cardId: CARD, goal: "首次验证" },
      "/today",
    )!;
    expect(href).toContain("/learning-runs/new?");
    expect(href).toContain("origin=card_v2");
    expect(href).toContain("objectiveId=" + OBJ);
    expect(href).toContain("cardId=" + CARD);
    expect(href).toContain("goal=" + encodeURIComponent("首次验证"));
    expect(href).toContain("returnTo=" + encodeURIComponent("/today"));
    expect(href).not.toContain("keyPointId");
  });

  it("resume_run → 精确 runId，不带 create 参数", () => {
    const href = objectiveActionHref({ kind: "resume_run", runId: RUN, objectiveId: OBJ }, "/");
    expect(href).toBe("/learning-runs/" + RUN + "?returnTo=" + encodeURIComponent("/"));
  });

  it("create_review_run → review_v2 origin + scheduleId + generation", () => {
    const href = objectiveActionHref(
      { kind: "create_review_run", objectiveId: OBJ, scheduleId: SCHED, generation: 3 },
      "/review",
    )!;
    expect(href).toContain("origin=review_v2");
    expect(href).toContain("scheduleId=" + SCHED);
    expect(href).toContain("generation=3");
    expect(href).toContain("objectiveId=" + OBJ);
  });

  it("view_successor → successor 详情路由", () => {
    const href = objectiveActionHref(
      { kind: "view_successor", successorObjectiveId: OBJ, successorCardId: SUCCESSOR },
      "/",
    );
    expect(href).toBe("/learning-cards/" + SUCCESSOR);
  });

  it("practice_only → 详情页 practice 参数（不携带 submit 语义）", () => {
    const href = objectiveActionHref(
      { kind: "practice_only", objectiveId: OBJ, cardId: CARD, reasonCodes: ["exposed"] },
      "/",
    );
    expect(href).toBe("/learning-cards/" + CARD + "?practice=1");
  });

  it("none / refresh / wait_for_initial_validation → 无跳转", () => {
    expect(objectiveActionHref({ kind: "none" }, "/")).toBeNull();
    expect(objectiveActionHref({ kind: "refresh" }, "/")).toBeNull();
    expect(
      objectiveActionHref(
        { kind: "wait_for_initial_validation", reminderId: RUN, qualificationNotBefore: "2026-08-18T00:00:00.000Z" },
        "/",
      ),
    ).toBeNull();
  });
});
