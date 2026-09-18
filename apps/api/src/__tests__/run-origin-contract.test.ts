/**
 * LearningRun origin/returnTarget 合同漂移修复的纯函数测试。
 *
 * 背景（2026-08-22 审查）：createRunV2 把 V2 形状 origin（objectiveId，无
 * keyPointId）写入 DB，读取端原样 cast 成 LearningRunPublicV1 返回——公开
 * 合同承诺的 keyPointId 字段在响应中是 undefined，且 returnTarget 非 card
 * 分支缺 V1 字段。修复：run-view.ts 的 normalizeOriginToV1 / deriveReturnTargetV1
 * 统一归一，buildRunPublicView 出口接 learningRunPublicSchema 校验。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveReturnTargetV1,
  normalizeOriginToV1,
} from "../modules/learning-runs/run-view.ts";

const OBJECTIVE = "1b7f6a5e-1111-4222-8333-444455556666";
const CARD = "2c8f6a5e-1111-4222-8333-444455556667";
const SCHEDULE = "3d8f6a5e-1111-4222-8333-444455556668";
const CHECKPOINT = {
  version: 1,
  workspaceId: "4e8f6a5e-1111-4222-8333-444455556669",
  userId: "5f8f6a5e-1111-4222-8333-444455556670",
  token: "ckpt-token",
  capturedAt: "2026-08-22T00:00:00.000Z",
};

describe("normalizeOriginToV1", () => {
  it("V2 现行形状（objectiveId）→ V1 合同（keyPointId）", () => {
    const out = normalizeOriginToV1({ kind: "card", cardId: CARD, objectiveId: OBJECTIVE });
    assert.deepEqual(out, { kind: "card", cardId: CARD, keyPointId: OBJECTIVE });
  });

  it("review 透传 scheduleId/scheduleGeneration 并归一 alias", () => {
    const out = normalizeOriginToV1({
      kind: "review", scheduleId: SCHEDULE, objectiveId: OBJECTIVE, scheduleGeneration: 3,
    });
    assert.deepEqual(out, {
      kind: "review", scheduleId: SCHEDULE, keyPointId: OBJECTIVE, scheduleGeneration: 3,
    });
  });

  it("today 可选 recommendationId 保留", () => {
    const rec = "6a8f6a5e-1111-4222-8333-444455556671";
    assert.deepEqual(
      normalizeOriginToV1({ kind: "today", objectiveId: OBJECTIVE, recommendationId: rec }),
      { kind: "today", recommendationId: rec, keyPointId: OBJECTIVE },
    );
    assert.deepEqual(
      normalizeOriginToV1({ kind: "today", objectiveId: OBJECTIVE }),
      { kind: "today", keyPointId: OBJECTIVE },
    );
  });

  it("star_map 透传 lens/filter/baselineCheckpoint", () => {
    const origin = {
      kind: "star_map",
      objectiveId: OBJECTIVE,
      lens: "evidence",
      filter: { kinds: [], states: [] },
      baselineCheckpoint: CHECKPOINT,
    };
    const out = normalizeOriginToV1(origin);
    assert.equal(out.kind, "star_map");
    assert.equal(out.keyPointId, OBJECTIVE);
    if (out.kind === "star_map") {
      assert.equal(out.lens, "evidence");
      assert.deepEqual(out.baselineCheckpoint, CHECKPOINT);
    }
  });

  it("onboarding 归一 sampleMode 与可选 sandboxNamespaceId", () => {
    const ns = "7b8f6a5e-1111-4222-8333-444455556672";
    assert.deepEqual(
      normalizeOriginToV1({ kind: "onboarding", objectiveId: OBJECTIVE, sampleMode: "sandbox", sandboxNamespaceId: ns }),
      { kind: "onboarding", sampleMode: "sandbox", keyPointId: OBJECTIVE, sandboxNamespaceId: ns },
    );
  });

  it("缺 alias 或 kind 非法时 fail-loud", () => {
    assert.throws(() => normalizeOriginToV1({ kind: "card", cardId: CARD }));
    assert.throws(() => normalizeOriginToV1({ kind: "unknown_kind", objectiveId: OBJECTIVE }));
    assert.throws(() => normalizeOriginToV1(null));
  });
});

describe("deriveReturnTargetV1", () => {
  it("card：由 origin 推导完整 V1 形状并保留 objectiveId 标记", () => {
    const out = deriveReturnTargetV1({ kind: "card", cardId: CARD, objectiveId: OBJECTIVE });
    assert.deepEqual(out, { kind: "card", cardId: CARD, keyPointId: OBJECTIVE, objectiveId: OBJECTIVE });
  });

  it("review：由当前 origin 推导完整目标", () => {
    const out = deriveReturnTargetV1({ kind: "review", scheduleId: SCHEDULE, objectiveId: OBJECTIVE, scheduleGeneration: 2 });
    assert.deepEqual(out, { kind: "review", scheduleId: SCHEDULE, keyPointId: OBJECTIVE });
  });

  it("star_map：lens/filter 从 origin 推导，routePlanId 保留", () => {
    const planId = "8c8f6a5e-1111-4222-8333-444455556673";
    const out = deriveReturnTargetV1({
      kind: "star_map", objectiveId: OBJECTIVE, lens: "provenance",
      filter: { kinds: [], states: [] }, routePlanId: planId, baselineCheckpoint: CHECKPOINT,
    });
    if (out.kind !== "star_map") throw new Error("kind 应为 star_map");
    assert.equal(out.keyPointId, OBJECTIVE);
    assert.equal(out.lens, "provenance");
    assert.equal(out.routePlanId, planId);
  });

  it("today：V1 合同为裸 {kind:'today'}", () => {
    assert.deepEqual(deriveReturnTargetV1({ kind: "today", objectiveId: OBJECTIVE }), { kind: "today" });
  });

  it("onboarding：destination 约定 own_content→card、sandbox→today", () => {
    assert.deepEqual(
      deriveReturnTargetV1({ kind: "onboarding", objectiveId: OBJECTIVE, sampleMode: "own_content" }),
      { kind: "onboarding", destination: "card" },
    );
    assert.deepEqual(
      deriveReturnTargetV1({ kind: "onboarding", objectiveId: OBJECTIVE, sampleMode: "sandbox" }),
      { kind: "onboarding", destination: "today" },
    );
  });

  it("origin 形状非法时直接失败", () => {
    assert.throws(() => deriveReturnTargetV1({ kind: "bogus" }));
  });
});
