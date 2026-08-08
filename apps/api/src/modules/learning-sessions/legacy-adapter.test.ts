/**
 * 任务 02-7：existing-domain-multimodal-adapter-v1（旧域兼容 adapter）单测。
 *
 * 覆盖（验收，02-w1 任务 02-7）：
 * - toLegacyDomainSummary：摘要不泄 graph/order/repair JSON（不伪装进 userAnswer）；
 * - fromLegacyAnswer：input uniqueness 键稳定（content hash + probe/version）；
 * - redaction 级联：计划结构 + mock tx 执行（content-free tombstone）；
 * - canonicalCompatibilityCheck：旧 question-first / 新 Episode 唯一消费矩阵。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTableName } from "drizzle-orm";
import {
  applyRedactionCascade,
  buildLegacyUniquenessKey,
  buildRedactionCascadeSql,
  canonicalCompatibilityCheck,
  fromLegacyAnswer,
  LegacyAdapterError,
  MAX_RENDER_SUMMARY_PREVIEW_CHARS,
  parseOpaqueArtifactRef,
  REDACTION_TOMBSTONE_ANSWER,
  toLegacyDomainSummary,
  toOpaqueArtifactRef,
  type LegacyArtifactInput,
} from "./legacy-adapter.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function artifact(overrides: Partial<LegacyArtifactInput> = {}): LegacyArtifactInput {
  return {
    id: "3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f",
    probeId: "probe-1",
    keyPointId: "kp-1",
    workspaceId: "ws-1",
    modality: "drag_graph",
    contentHash: "a".repeat(64),
    revision: 2,
    payload: {},
    effectiveTrustClass: "mastery_eligible",
    capturedAt: "2026-08-08T00:00:00Z",
    status: "locked",
    ...overrides,
  };
}

const dragGraphPayload = {
  nodes: ["node-A", "node-B", "node-C"],
  edges: [
    { source: "node-A", target: "node-B", relationType: "prerequisite" },
    { source: "node-B", target: "node-C", relationType: "derives_from" },
  ],
  relationTypes: ["prerequisite", "derives_from"],
};

// ─── toLegacyDomainSummary：摘要不泄 graph/order/repair JSON ───────────────

describe("toLegacyDomainSummary", () => {
  it("drag_graph：摘要只含节点/边计数，不泄 graph JSON 与节点/边 ID", () => {
    const summary = toLegacyDomainSummary(artifact({ payload: dragGraphPayload }));
    assert.equal(summary.renderSummary, "拖拽图回答（3 节点 / 2 边）");
    // 不泄 JSON 原文
    const payloadJson = JSON.stringify(dragGraphPayload);
    assert.ok(!summary.renderSummary.includes(payloadJson), "摘要不得包含 payload JSON");
    assert.ok(!summary.renderSummary.includes("node-A"), "摘要不得包含节点 ID");
    assert.ok(!summary.renderSummary.includes("prerequisite"), "摘要不得包含 relation type");
  });

  it("ordering：摘要只含项数，不泄 ordered IDs", () => {
    const summary = toLegacyDomainSummary(
      artifact({
        modality: "ordering",
        payload: { orderedIds: ["item-1", "item-2", "item-3", "item-4"] },
      }),
    );
    assert.equal(summary.renderSummary, "排序回答（4 项）");
    assert.ok(!summary.renderSummary.includes("item-1"), "摘要不得包含 item ID");
  });

  it("repair：摘要只含操作数，不泄 typed operations JSON", () => {
    const repairPayload = {
      operations: [
        { op: "replace", targetId: "block-1", replacementRef: "block-9" },
        { op: "connect", sourceId: "block-2", targetId: "block-3", relationType: "evidence" },
      ],
    };
    const summary = toLegacyDomainSummary(
      artifact({ modality: "repair", payload: repairPayload }),
    );
    assert.equal(summary.renderSummary, "修复回答（2 个操作）");
    assert.ok(!summary.renderSummary.includes(JSON.stringify(repairPayload)));
    assert.ok(!summary.renderSummary.includes("block-1"), "摘要不得包含 target ID");
    assert.ok(!summary.renderSummary.includes("replace"), "摘要不得包含操作类型");
  });

  it("scenario：摘要只含步数", () => {
    const summary = toLegacyDomainSummary(
      artifact({
        modality: "scenario",
        payload: { steps: ["opt-1", "opt-2"], branchPath: ["branch-B"] },
      }),
    );
    assert.equal(summary.renderSummary, "情景作答（2 步）");
    assert.ok(!summary.renderSummary.includes("opt-1"));
  });

  it("voice：摘要只含确认转写字数，不泄转写原文", () => {
    const transcript = "我认为地球围绕太阳公转，周期约为一年。";
    const summary = toLegacyDomainSummary(
      artifact({
        modality: "voice",
        payload: { transcript, asr: { provider: "mock", confidence: 0.98 } },
      }),
    );
    assert.equal(summary.renderSummary, `语音回答（确认转写 ${transcript.length} 字）`);
    assert.ok(!summary.renderSummary.includes(transcript), "摘要不得包含转写原文");
  });

  it("text_or_mixed：短文本显示完整预览，长文本截断且不超上限", () => {
    const short = artifact({
      modality: "text_or_mixed",
      payload: { text: "简短回答" },
    });
    assert.equal(toLegacyDomainSummary(short).renderSummary, "文本回答（4 字）：“简短回答”");

    const longText = "很".repeat(MAX_RENDER_SUMMARY_PREVIEW_CHARS + 20);
    const long = toLegacyDomainSummary(
      artifact({ modality: "text_or_mixed", payload: { text: longText } }),
    ).renderSummary;
    assert.match(long, /文本回答（\d+ 字）/);
    assert.ok(!long.includes(longText), "长文本不得完整出现在摘要中");
  });

  it("payload 结构未知时给出泛化摘要（不抛错、不泄任何字段）", () => {
    const summary = toLegacyDomainSummary(
      artifact({ modality: "repair", payload: { unknown: { nested: "secret" } } }),
    );
    assert.equal(summary.renderSummary, "修复回答");
    assert.ok(!summary.renderSummary.includes("secret"));
  });

  it("输出只含 opaque ref / content hash / 可读摘要 / point assessment refs", () => {
    const summary = toLegacyDomainSummary(
      artifact({ payload: dragGraphPayload, pointAssessmentRefs: ["pa-1", "pa-2"] }),
    );
    assert.equal(summary.artifactRef, `artifact:${"3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f"}`);
    assert.equal(summary.artifactHash, "a".repeat(64));
    assert.deepEqual(summary.pointAssessmentRefs, ["pa-1", "pa-2"]);
    // 默认空数组
    assert.deepEqual(toLegacyDomainSummary(artifact()).pointAssessmentRefs, []);
    // 不包含 payload 与 trust 字段（旧域 reader 不需要）
    assert.ok(!JSON.stringify(summary).includes("effectiveTrustClass"));
  });

  it("非法输入 fail closed", () => {
    assert.throws(
      () => toLegacyDomainSummary(artifact({ modality: "graph" as never })),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_MODALITY",
    );
    assert.throws(
      () => toLegacyDomainSummary(artifact({ revision: -1 })),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_ARTIFACT_REVISION",
    );
    assert.throws(
      () => toLegacyDomainSummary(artifact({ id: "" })),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "MISSING_ARTIFACT_ID",
    );
  });
});

// ─── opaque artifact ref round-trip ───────────────────────────────────────

describe("opaque artifact ref", () => {
  it("toOpaqueArtifactRef / parseOpaqueArtifactRef round-trip", () => {
    const id = "3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f";
    assert.equal(parseOpaqueArtifactRef(toOpaqueArtifactRef(id)), id);
  });

  it("非法 ref fail closed", () => {
    assert.throws(
      () => parseOpaqueArtifactRef("artifact:"),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_ARTIFACT_REF",
    );
    assert.throws(
      () => parseOpaqueArtifactRef("uuid-only"),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_ARTIFACT_REF",
    );
  });
});

// ─── fromLegacyAnswer：uniqueness 键稳定 ──────────────────────────────────

describe("fromLegacyAnswer: input uniqueness 键（content hash + probe/version）", () => {
  const row = {
    artifactRef: "artifact:3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f",
    artifactHash: "b".repeat(64),
    probeRef: "probe-7",
    version: 3,
  };

  it("相同输入两次得到相同键（稳定可复现）", () => {
    const k1 = fromLegacyAnswer(row);
    const k2 = fromLegacyAnswer(row);
    assert.equal(k1.key, k2.key);
    assert.equal(k1.key, buildLegacyUniquenessKey({ contentHash: row.artifactHash, probeRef: row.probeRef, version: row.version }));
    assert.equal(k1.contentHash, row.artifactHash);
    assert.equal(k1.probeRef, row.probeRef);
    assert.equal(k1.version, 3);
  });

  it("content hash / probe / version 任一变化 → 键变化", () => {
    const base = fromLegacyAnswer(row).key;
    assert.notEqual(fromLegacyAnswer({ ...row, artifactHash: "c".repeat(64) }).key, base);
    assert.notEqual(fromLegacyAnswer({ ...row, probeRef: "probe-8" }).key, base);
    assert.notEqual(fromLegacyAnswer({ ...row, version: 4 }).key, base);
  });

  it("键只由 content hash + probe/version 决定，与任何 graph JSON 无关", () => {
    const withJson = fromLegacyAnswer({
      ...row,
      artifactHash: "d".repeat(64),
    }).key;
    // 同一 content hash 下，即使旧域行里混入无关 JSON 也不影响键
    const sameHash = buildLegacyUniquenessKey({
      contentHash: "d".repeat(64),
      probeRef: "probe-7",
      version: 3,
    });
    assert.equal(withJson, sameHash);
    assert.ok(!withJson.includes("drag_graph"), "键不得包含 JSON/模态信息");
  });

  it("required 缺失 fail closed（redaction 后行/老行）", () => {
    assert.throws(
      () => fromLegacyAnswer({ ...row, artifactHash: "" }),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "MISSING_ARTIFACT_HASH",
    );
    assert.throws(
      () => fromLegacyAnswer({ ...row, probeRef: null }),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "MISSING_PROBE_REF",
    );
    assert.throws(
      () => fromLegacyAnswer({ ...row, version: undefined }),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "MISSING_ARTIFACT_VERSION",
    );
  });
});

// ─── redaction 级联 ───────────────────────────────────────────────────────

describe("redaction 级联（content-free tombstone）", () => {
  it("REDACTION_TOMBSTONE_ANSWER 是固定 content-free 标记，不携带任何内容", () => {
    assert.equal(REDACTION_TOMBSTONE_ANSWER, "[redacted]");
    assert.ok(!REDACTION_TOMBSTONE_ANSWER.includes("artifact:"));
  });

  it("buildRedactionCascadeSql 覆盖 validation_events 与 review_attempts 的 answer copy", () => {
    const id = "3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f";
    const plan = buildRedactionCascadeSql(id);
    assert.equal(plan.artifactId, id);
    assert.equal(plan.artifactRef, `artifact:${id}`);

    const [validationStep, reviewStep] = plan.steps;
    assert.equal(validationStep.table, "validation_events");
    assert.deepEqual(validationStep.set, [
      { column: "userAnswer", value: "tombstone_marker" },
      { column: "feedback", value: "null" },
    ]);
    assert.equal(validationStep.matchColumn, "userAnswer");

    assert.equal(reviewStep.table, "review_attempts");
    assert.deepEqual(reviewStep.set, [
      { column: "answerText", value: "null" },
      { column: "answerType", value: "null" },
    ]);
    assert.equal(reviewStep.matchColumn, "answerText");
  });

  it("applyRedactionCascade：mock tx 验证对两张表执行 content-free UPDATE", async () => {
    const calls: Array<{ table: string; set: Record<string, unknown>; hasWhere: boolean }> = [];
    const fakeTx = {
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => ({
            returning: async () => {
              calls.push({
                table: getTableName(table as Parameters<typeof getTableName>[0]),
                set: values,
                hasWhere: Boolean(cond),
              });
              return [];
            },
          }),
        }),
      }),
    } as never;

    const result = await applyRedactionCascade(fakeTx, "3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f");

    assert.equal(calls.length, 2);
    const validationCall = calls.find((c) => c.table === "validation_events");
    const reviewCall = calls.find((c) => c.table === "review_attempts");
    assert.ok(validationCall, "必须更新 validation_events");
    assert.ok(reviewCall, "必须更新 review_attempts");
    assert.equal(validationCall!.set.userAnswer, REDACTION_TOMBSTONE_ANSWER);
    assert.equal(validationCall!.set.feedback, null);
    assert.equal(reviewCall!.set.answerText, null);
    assert.equal(reviewCall!.set.answerType, null);
    assert.ok(validationCall!.hasWhere, "必须按 answer copy 匹配列过滤");
    assert.ok(reviewCall!.hasWhere);
    assert.equal(result.validationEventsRedacted, 0);
    assert.equal(result.reviewAttemptsRedacted, 0);
    assert.equal(result.artifactRef, "artifact:3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f");
  });

  it("mock tx 模拟命中行时返回计数", async () => {
    const fakeTx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: "row-1" }, { id: "row-2" }],
          }),
        }),
      }),
    } as never;
    const result = await applyRedactionCascade(fakeTx, "3f0d2e40-1a2b-4c5d-8e6f-9a0b1c2d3e4f");
    assert.equal(result.validationEventsRedacted, 2);
    assert.equal(result.reviewAttemptsRedacted, 2);
  });
});

// ─── canonical compatibility matrix ───────────────────────────────────────

describe("canonicalCompatibilityCheck（旧 question-first / 新 Episode 唯一消费）", () => {
  const SCHEDULE = "sched-1";
  const gen = 2;
  const pendingState = (overrides: Partial<Parameters<typeof canonicalCompatibilityCheck>[3]> = {}) => ({
    id: SCHEDULE,
    status: "pending",
    generation: gen,
    consumedBy: "none" as const,
    ...overrides,
  });

  it("矩阵：pending 且无人消费 → 两条写路径都 allowed", () => {
    const state = pendingState();
    assert.deepEqual(canonicalCompatibilityCheck(SCHEDULE, gen, "question_first", state), {
      allowed: true,
      requester: "question_first",
      scheduleId: SCHEDULE,
    });
    assert.deepEqual(canonicalCompatibilityCheck(SCHEDULE, gen, "episode", state), {
      allowed: true,
      requester: "episode",
      scheduleId: SCHEDULE,
    });
  });

  it("矩阵：已被旧 question-first 消费 → 旧路径幂等 allowed、新 Episode blocked", () => {
    const state = pendingState({ consumedBy: "question_first" });
    const legacy = canonicalCompatibilityCheck(SCHEDULE, gen, "question_first", state);
    assert.equal(legacy.allowed, true);
    const episode = canonicalCompatibilityCheck(SCHEDULE, gen, "episode", state);
    assert.deepEqual(episode, {
      allowed: false,
      blockedBy: "already_consumed",
      scheduleId: SCHEDULE,
      reason: "schedule 已被 question_first 消费，episode 不可再消费同一 pending schedule",
    });
  });

  it("矩阵：已被新 Episode 消费 → 新 Episode 幂等 allowed、旧 question-first blocked", () => {
    const state = pendingState({ consumedBy: "episode" });
    assert.equal(canonicalCompatibilityCheck(SCHEDULE, gen, "episode", state).allowed, true);
    const legacy = canonicalCompatibilityCheck(SCHEDULE, gen, "question_first", state);
    assert.equal(legacy.allowed, false);
    assert.equal(legacy.allowed === false && legacy.blockedBy, "already_consumed");
  });

  it("矩阵：非 pending（completed/cancelled）→ 两条写路径都 blocked", () => {
    for (const status of ["completed", "cancelled", "deleted"]) {
      const state = pendingState({ status, consumedBy: "none" });
      const legacy = canonicalCompatibilityCheck(SCHEDULE, gen, "question_first", state);
      const episode = canonicalCompatibilityCheck(SCHEDULE, gen, "episode", state);
      assert.equal(legacy.allowed, false);
      assert.equal(legacy.allowed === false && legacy.blockedBy, "schedule_not_pending");
      assert.equal(episode.allowed, false);
    }
  });

  it("矩阵：generation 不匹配（supersede 换代）→ 两条写路径都 blocked", () => {
    const state = pendingState({ generation: 3 });
    const legacy = canonicalCompatibilityCheck(SCHEDULE, gen, "question_first", state);
    assert.equal(legacy.allowed, false);
    assert.equal(legacy.allowed === false && legacy.blockedBy, "generation_mismatch");
    const episode = canonicalCompatibilityCheck(SCHEDULE, gen, "episode", state);
    assert.equal(episode.allowed, false);
    assert.equal(episode.allowed === false && episode.blockedBy, "generation_mismatch");
  });

  it("矩阵：消费状态未知 → fail closed 两条写路径都 blocked", () => {
    const state = pendingState({ consumedBy: "unknown" });
    for (const requester of ["question_first", "episode"] as const) {
      const result = canonicalCompatibilityCheck(SCHEDULE, gen, requester, state);
      assert.equal(result.allowed, false);
      assert.equal(result.allowed === false && result.blockedBy, "unknown_state");
    }
  });

  it("参数校验 fail closed：空 schedule id / 非法 generation / id 不匹配", () => {
    const state = pendingState();
    assert.throws(
      () => canonicalCompatibilityCheck("", gen, "episode", state),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "MISSING_SCHEDULE_ID",
    );
    assert.throws(
      () => canonicalCompatibilityCheck(SCHEDULE, -1, "episode", state),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_SCHEDULE_GENERATION",
    );
    assert.throws(
      () => canonicalCompatibilityCheck("sched-other", gen, "episode", state),
      (err: unknown) => err instanceof LegacyAdapterError && err.code === "SCHEDULE_MISMATCH",
    );
  });
});
