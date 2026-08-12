/**
 * redaction 与两级 replay 单测（阶段 04 / W3 任务 04-5，§13.2 + §7.2 状态机）
 *
 * 覆盖（node:test + assert，验收）：
 * - 状态机：capturing→transcribed→awaiting_confirmation→locked|superseded|stale；
 *   locked→redacted（append-only tombstone 不可恢复）；redacted 回退一律拒绝；
 * - applyRedaction：只接受 locked；content-free tombstone（不含 transcript/segments/hash）；
 *   删除后 reAudit=false（不宣称可完整语义重审）；
 * - redactionCascade：级联覆盖 artifact/assessment/Critic rationale/Tutor/Critic job
 *   payload/retry payload/对象引用/cache；learning_result 追加 legacy 旧域表；
 * - contentScan：残留扫描为 0 通过，命中即 fail closed；tombstone content-free 校验；
 * - 两级 replay：canonical 确定性重放（hash 稳定、顺序敏感）；reAuditAllowed 仅 locked；
 * - compensatingInvalidation：写 invalidation event 不改历史、幂等、payload 无原文残留；
 * - 删除影响说明（raw audio / answer content / learning result）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendCanonicalEvent,
  canonicalFactIdempotencyKey,
  CanonicalEventValidationError,
  type CanonicalEventDomain,
  type CanonicalEventType,
  type CanonicalEventStore,
  type CanonicalFactInsert,
  type CanonicalReplayEvent,
  type WorkspaceUserScope,
} from "./canonical-events.ts";
import {
  applyRedaction,
  applyRedactionCascade,
  artifactCanTransition,
  assertResidualFree,
  assertValidArtifactTransition,
  buildRedactionCascade,
  canonicalReplayAllowed,
  deletionImpacts,
  reAuditAllowed,
  replayCanonical,
  RedactionServiceError,
  scanForResidual,
  tombstoneIsContentFree,
  writeCompensatingInvalidation,
  type RedactionExecutor,
  type RedactionStep,
} from "./redaction-service.ts";

// ─── 内存 store（幂等键与 pg 语义一致）───────────────────────────────────

function domainToEventType(domain: CanonicalEventDomain): CanonicalEventType {
  switch (domain) {
    case "validation": return "validation.event";
    case "review": return "review.attempt";
    case "understanding": return "understanding.event";
  }
}

class InMemoryCanonicalEventStore implements CanonicalEventStore {
  facts = new Map<string, string>();
  outboxRows: Array<{ sequence: number; eventType: CanonicalEventType }> = [];
  private nextSequence = 1;
  private factCounter = 0;

  async hasCanonicalFact(fact: CanonicalFactInsert, scope: WorkspaceUserScope): Promise<boolean> {
    return this.facts.has(
      canonicalFactIdempotencyKey(scope, domainToEventType(fact.domain), fact),
    );
  }

  async insertCanonicalFact(fact: CanonicalFactInsert, scope: WorkspaceUserScope): Promise<string | null> {
    const key = canonicalFactIdempotencyKey(scope, domainToEventType(fact.domain), fact);
    if (this.facts.has(key)) return null;
    const id = `fact-${++this.factCounter}`;
    this.facts.set(key, id);
    return id;
  }

  async findCanonicalFactId(fact: CanonicalFactInsert, scope: WorkspaceUserScope): Promise<string> {
    const key = canonicalFactIdempotencyKey(scope, domainToEventType(fact.domain), fact);
    const existing = this.facts.get(key);
    if (existing) return existing;
    throw new Error("内存 store 回查失败：事实不存在");
  }

  async insertOutboxRow(
    row: { workspaceId: string; userId: string; eventType: CanonicalEventType },
  ): Promise<{ sequence: number }> {
    const sequence = this.nextSequence++;
    this.outboxRows.push({ sequence, eventType: row.eventType });
    return { sequence };
  }
}

const scope: WorkspaceUserScope = { workspaceId: "w-1", userId: "u-1" };

// ─── 1. 状态机（§7.2 / 01-2 §6.2）────────────────────────────────────────

describe("状态机", () => {
  it("主链合法：capturing→transcribed→awaiting_confirmation→locked→redacted", () => {
    assert.ok(artifactCanTransition("capturing", "transcribed"));
    assert.ok(artifactCanTransition("transcribed", "awaiting_confirmation"));
    assert.ok(artifactCanTransition("awaiting_confirmation", "locked"));
    assert.ok(artifactCanTransition("locked", "redacted"));
    assert.doesNotThrow(() => assertValidArtifactTransition("locked", "redacted"));
  });

  it("awaiting_confirmation → superseded / stale 合法", () => {
    assert.ok(artifactCanTransition("awaiting_confirmation", "superseded"));
    assert.ok(artifactCanTransition("awaiting_confirmation", "stale"));
    assert.ok(artifactCanTransition("transcribed", "superseded"));
    assert.ok(artifactCanTransition("capturing", "stale"));
  });

  it("redacted 是 append-only 终态：任何出边（含恢复为 locked）一律拒绝", () => {
    for (const to of ["locked", "superseded", "stale", "awaiting_confirmation"] as const) {
      assert.ok(!artifactCanTransition("redacted", to));
      assert.throws(
        () => assertValidArtifactTransition("redacted", to),
        (err: unknown) => err instanceof RedactionServiceError,
      );
    }
  });
});

// ─── 2. applyRedaction：locked → redacted（不可恢复 tombstone）────────────

describe("applyRedaction", () => {
  it("locked artifact → redacted：生成 content-free tombstone，reAudit=false", () => {
    const result = applyRedaction({
      artifactId: "11111111-1111-4111-8111-111111111111",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      status: "locked",
      modality: "voice",
      policyVersion: "redaction-policy-v1",
      reasonCode: "user_request",
      deletionScope: "answer_content",
      outcomeRef: "validation-event-42",
      now: "2026-08-08T00:00:00Z",
    });
    assert.equal(result.tombstone.status, "redacted");
    assert.equal(result.tombstone.reasonCode, "user_request");
    assert.equal(result.tombstone.outcomeRef, "validation-event-42");
    assert.equal(result.tombstone.policyVersion, "redaction-policy-v1");
    assert.equal(result.reAudit, false);
    assert.ok(!reAuditAllowed(result.tombstone.status));
    // tombstone 不含任何用户答案内容字段
    const keys = Object.keys(result.tombstone);
    assert.ok(!keys.includes("transcript"));
    assert.ok(!keys.includes("segments"));
    assert.ok(!keys.includes("contentHash"));
    assert.ok(!keys.includes("audioRef"));
    assert.ok(tombstoneIsContentFree(result.tombstone, ["氧气是燃烧反应的氧化剂。"]));
  });

  it("非 locked 状态（superseded/stale/awaiting_confirmation）→ fail closed", () => {
    for (const status of ["superseded", "stale", "awaiting_confirmation", "transcribed", "capturing"] as const) {
      assert.throws(
        () => applyRedaction({
          artifactId: "11111111-1111-4111-8111-111111111111",
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          status,
          modality: "voice",
          policyVersion: "redaction-policy-v1",
          reasonCode: "user_request",
          deletionScope: "answer_content",
        }),
        (err: unknown) => err instanceof RedactionServiceError && err.code === "not_locked",
        `status=${status} 应 fail closed`,
      );
    }
  });

  it("已 redacted 不能重复删除；缺删除原因拒绝；raw_audio 不转 redacted", () => {
    assert.throws(
      () => applyRedaction({
        artifactId: "22222222-2222-4222-8222-222222222222",
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        status: "redacted",
        modality: "voice",
        policyVersion: "p1",
        reasonCode: "user_request",
        deletionScope: "answer_content",
      }),
      (err: unknown) => err instanceof RedactionServiceError && err.code === "already_redacted",
    );
    assert.throws(
      () => applyRedaction({
        artifactId: "22222222-2222-4222-8222-222222222222",
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        status: "locked",
        modality: "voice",
        policyVersion: "p1",
        reasonCode: "",
        deletionScope: "answer_content",
      }),
      (err: unknown) => err instanceof RedactionServiceError && err.code === "missing_redaction_reason",
    );
    assert.throws(
      () => applyRedaction({
        artifactId: "22222222-2222-4222-8222-222222222222",
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        status: "locked",
        modality: "voice",
        policyVersion: "p1",
        reasonCode: "user_request",
        deletionScope: "raw_audio",
      }),
      (err: unknown) => err instanceof RedactionServiceError && err.code === "raw_audio_only_not_redaction",
    );
  });
});

// ─── 3. redactionCascade：全复制面覆盖 ───────────────────────────────────

describe("redactionCascade", () => {
  it("answer_content 级联覆盖 artifact/assessment/Critic rationale/job payload/retry/对象引用/cache", () => {
    const plan = buildRedactionCascade("artifact-1", "answer_content");
    const surfaces = new Set(plan.steps.map((s) => s.surface));
    assert.ok(surfaces.has("response_artifact"));
    assert.ok(surfaces.has("assessment"));
    assert.ok(surfaces.has("critic_job_payload"));
    assert.ok(surfaces.has("tutor_job_payload"));
    assert.ok(surfaces.has("retry_payload"));
    assert.ok(surfaces.has("object_reference"));
    assert.ok(surfaces.has("cache"));
    // assessment 步骤必须覆盖 answerExcerpt 与复述用户答案的 rationale
    const assessment = plan.steps.find((s) => s.surface === "assessment")!;
    assert.deepEqual(
      assessment.set.map((s) => s.field),
      ["answerExcerpt", "rationale", "feedback"],
    );
    // artifact 步骤覆盖 transcript/segments/hash
    const artifactStep = plan.steps.find((s) => s.surface === "response_artifact")!;
    const fields = artifactStep.set.map((s) => s.field);
    for (const f of ["transcript", "segments", "contentHash", "audioRef", "audioHash"]) {
      assert.ok(fields.includes(f), `artifact 级联应覆盖 ${f}`);
    }
    // learning_result scope 追加 legacy 旧域表
    const legacy = buildRedactionCascade("artifact-1", "learning_result");
    const legacySurfaces = new Set(legacy.steps.map((s) => s.surface));
    assert.ok(legacySurfaces.has("legacy_validation_events"));
    assert.ok(legacySurfaces.has("legacy_review_attempts"));
  });

  it("applyRedactionCascade 逐步骤执行并汇总受影响数", async () => {
    const plan = buildRedactionCascade("artifact-1", "full");
    const applied: string[] = [];
    const executor: RedactionExecutor = {
      applyStep: async (step: RedactionStep) => {
        applied.push(step.surface);
        return 1;
      },
    };
    const outcome = await applyRedactionCascade(plan, executor);
    assert.equal(outcome.affectedTotal, plan.steps.length);
    assert.equal(applied.length, plan.steps.length);
    assert.ok(applied.includes("assessment"));
    assert.ok(applied.includes("cache"));
  });

  it("executor 失败 → fail closed 抛错，不半途留下 content copy", async () => {
    const plan = buildRedactionCascade("artifact-1", "full");
    const executor: RedactionExecutor = {
      applyStep: async () => {
        throw new RedactionServiceError("执行失败", "execution_failed");
      },
    };
    await assert.rejects(() => applyRedactionCascade(plan, executor), RedactionServiceError);
  });
});

// ─── 4. contentScan：残留扫描 ────────────────────────────────────────────

describe("contentScan", () => {
  it("各复制面（DB/对象存储/队列/cache）残留命中 → 扫描不干净并 fail closed", () => {
    const tokens = ["氧气是燃烧反应的氧化剂。"];
    const candidates = [
      { surface: "database", location: "validation_point_assessments/1", content: "answerExcerpt=氧气是燃烧反应的氧化剂。" },
      { surface: "object_storage", location: "audio/x.wav", content: "raw audio bytes" },
      { surface: "queue", location: "learning_agent_jobs/9", content: "payload 氧气是燃烧反应的氧化剂。" },
      { surface: "cache", location: "learning_cache:artifact-1", content: "氧气是燃烧反应的氧化剂。" },
      { surface: "database", location: "learning_response_artifacts/2", content: "已清理 [redacted]" },
    ];
    const result = scanForResidual({ sensitiveTokens: tokens, candidates });
    assert.equal(result.clean, false);
    assert.ok(result.hits.length >= 3, "DB/queue/cache 残留应被命中");
    assert.throws(
      () => assertResidualFree(result),
      (err: unknown) => err instanceof RedactionServiceError && err.code === "residual_found",
    );
  });

  it("删除后各复制面扫描残留为 0 → clean 通过", () => {
    const tokens = ["氧气是燃烧反应的氧化剂。"];
    const candidates = [
      { surface: "database", location: "learning_response_artifacts/2", content: "[redacted]" },
      { surface: "database", location: "validation_point_assessments/1", content: "[redacted]" },
      { surface: "object_storage", location: "audio/x.wav", content: "" },
      { surface: "queue", location: "learning_agent_jobs/9", content: "" },
      { surface: "cache", location: "learning_cache:artifact-1", content: "" },
    ];
    const result = scanForResidual({ sensitiveTokens: tokens, candidates });
    assert.equal(result.clean, true);
    assert.doesNotThrow(() => assertResidualFree(result));
  });

  it("tombstone content-free：不含 transcript 原词；含则判为不干净", () => {
    const tombstone = applyRedaction({
      artifactId: "11111111-1111-4111-8111-111111111111",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      status: "locked",
      modality: "voice",
      policyVersion: "p1",
      reasonCode: "user_request",
      deletionScope: "answer_content",
      now: "2026-08-08T00:00:00Z",
    }).tombstone;
    assert.ok(tombstoneIsContentFree(tombstone, ["氧气是燃烧反应的氧化剂。"]));
    const leaked = { ...tombstone, transcript: "氧气是燃烧反应的氧化剂。" };
    assert.ok(!tombstoneIsContentFree(leaked, ["氧气是燃烧反应的氧化剂。"]));
  });
});

// ─── 5. 两级 replay：canonical 确定性重放 + semantic re-audit 门禁 ───────

describe("两级 replay", () => {
  function event(
    sequence: number,
    payload: Record<string, unknown>,
    eventType: CanonicalEventType = "validation.event",
  ): CanonicalReplayEvent {
    return { workspaceId: scope.workspaceId, userId: scope.userId, sequence, eventType, payload };
  }

  const events: CanonicalReplayEvent[] = [
    event(1, { action: "completed", cardId: "card-1", keyPointId: "kp-1", outcomeSummary: "solid", confidence: 80 }),
    event(2, {
      action: "invalidate",
      artifactId: "11111111-1111-4111-8111-111111111111",
      keyPointId: "kp-1",
      status: "superseded",
      skipReasonCode: "user_requested_deletion",
    }, "understanding.event"),
  ];

  it("canonical 确定性重放：相同事件流 → 相同 hash 与投影；顺序敏感", () => {
    const r1 = replayCanonical(events);
    const r2 = replayCanonical(events);
    assert.equal(r1.hash, r2.hash);
    assert.equal(r1.eventCount, 2);
    assert.equal(r1.deterministic, true);
    assert.equal(r1.snapshot.mastery["kp-1"]!.validatedCount, 1);
    // 顺序敏感：交换事件 → 不同 hash
    const reordered = [events[1]!, events[0]!];
    assert.notEqual(replayCanonical(reordered).hash, r1.hash);
  });

  it("reAuditAllowed：只有 locked 可 semantic re-audit；redacted 只能 canonical replay", () => {
    assert.equal(reAuditAllowed("locked"), true);
    for (const status of ["superseded", "stale", "redacted", "awaiting_confirmation", "transcribed", "capturing"] as const) {
      assert.equal(reAuditAllowed(status), false, `${status} 不允许 semantic re-audit`);
    }
    // redacted 仍可 canonical replay（tombstone 保留 outcome ref）
    assert.equal(canonicalReplayAllowed("redacted"), true);
    assert.equal(canonicalReplayAllowed("locked"), true);
    assert.equal(canonicalReplayAllowed("awaiting_confirmation"), false);
  });

  it("删除后不能宣称可完整语义重审：applyRedaction reAudit=false 且 reAuditAllowed(redacted)=false", () => {
    const result = applyRedaction({
      artifactId: "11111111-1111-4111-8111-111111111111",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      status: "locked",
      modality: "voice",
      policyVersion: "redaction-policy-v1",
      reasonCode: "user_request",
      deletionScope: "answer_content",
      now: "2026-08-08T00:00:00Z",
    });
    assert.equal(result.reAudit, false);
    assert.equal(reAuditAllowed(result.tombstone.status), false);
  });
});

// ─── 6. compensatingInvalidation：append-only，不改写历史 ────────────────

describe("compensatingInvalidation", () => {
  it("写 understanding.event invalidation；payload 无用户答案原文；幂等不重复占 sequence", async () => {
    const store = new InMemoryCanonicalEventStore();
    const input = {
      ...scope,
      artifactId: "11111111-1111-4111-8111-111111111111",
      keyPointId: "kp-1",
      outcomeRef: "validation-event-42",
      reasonCode: "user_request",
      policyVersion: "redaction-policy-v1",
    };
    const first = await writeCompensatingInvalidation(store, input);
    assert.equal(first.idempotent, false);
    assert.equal(first.sequence, 1);
    assert.equal(store.outboxRows.length, 1);
    assert.equal(store.outboxRows[0]!.eventType, "understanding.event");

    // payload 白名单校验：若包含 transcript/answer 原文会抛 CanonicalEventValidationError
    const second = await writeCompensatingInvalidation(store, input);
    assert.equal(second.idempotent, true, "重复删除应幂等命中");
    assert.equal(second.sequence, null);
    assert.equal(store.outboxRows.length, 1, "幂等命中不重复占 sequence");
  });

  it("invalidation payload 含用户答案原文 → 被 appendCanonicalEvent 拒绝（fail closed）", async () => {
    const store = new InMemoryCanonicalEventStore();
    await assert.rejects(
      () => appendCanonicalEvent(store, {
        ...scope,
        eventType: "understanding.event",
        payload: {
          action: "invalidate",
          artifactId: "11111111-1111-4111-8111-111111111111",
          transcript: "氧气是燃烧反应的氧化剂。",
        },
        canonicalFact: {
          domain: "understanding",
          row: { subjectType: "artifact", subjectId: "artifact-1", eventType: "invalidated" },
        },
      }),
      (err: unknown) => err instanceof CanonicalEventValidationError,
    );
  });

  it("历史事件不可改写：invalidation 是 append-only，之前事件保留", async () => {
    const store = new InMemoryCanonicalEventStore();
    await appendCanonicalEvent(store, {
      ...scope,
      eventType: "validation.event",
      payload: { action: "completed", cardId: "card-1", keyPointId: "kp-1", outcomeSummary: "solid", confidence: 80 },
      canonicalFact: {
        domain: "validation",
        row: { cardId: "card-1", keyPointId: "kp-1", question: "q", questionType: "text", userAnswer: "氧气是燃烧反应的氧化剂。", outcome: "solid", confidence: 80 },
      },
    });
    await writeCompensatingInvalidation(store, {
      ...scope,
      artifactId: "11111111-1111-4111-8111-111111111111",
      keyPointId: "kp-1",
      policyVersion: "redaction-policy-v1",
    });
    assert.equal(store.outboxRows.length, 2, "历史事件 + 新 invalidation 事件（不改写）");
    assert.equal(store.outboxRows[0]!.eventType, "validation.event");
    assert.equal(store.outboxRows[1]!.eventType, "understanding.event");
  });
});

// ─── 7. 删除影响说明（UI 删除前展示；§13.2）──────────────────────────────

describe("删除影响", () => {
  it("三种删除影响：raw audio / answer content / learning result", () => {
    const rawAudio = deletionImpacts("raw_audio");
    assert.equal(rawAudio.length, 1);
    assert.ok(rawAudio[0]!.includes("raw audio"));
    assert.ok(rawAudio[0]!.includes("既有 trust/outcome 不改变"));

    const answerContent = deletionImpacts("answer_content");
    assert.equal(answerContent.length, 1);
    assert.ok(answerContent[0]!.includes("redacted"));
    assert.ok(answerContent[0]!.includes("完整语义重审"));

    const learningResult = deletionImpacts("learning_result");
    assert.equal(learningResult.length, 2);
    assert.ok(learningResult.some((t) => t.includes("invalidation event")));
    assert.ok(learningResult.some((t) => t.includes("恰好一个 active schedule")));
  });
});
