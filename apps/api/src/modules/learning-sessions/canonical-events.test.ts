/**
 * 任务 02-9：canonical 事件、投影与重放单测。
 *
 * 覆盖（验收，02-w1 任务 02-9）：
 * - append 幂等 / sequence 每 workspace 单调（内存 store）；
 * - 重放 hash 确定：相同事件流同 hash；乱序（不同流）不同 hash；
 * - drift 检测：一致 → 未漂移；不一致 → 漂移；
 * - payload 禁止敏感字段：校验函数拒绝 raw answer / chain-of-thought /
 *   rationale / question 原文 / 未知字段；
 * - 旧 reader：projection 关闭时仍可读 pending schedule、attempt 和结果。
 *
 * DB 交互用内存 CanonicalEventStore / CanonicalFactReader 注入，纯函数与
 * append 流程均可测（不需要真实数据库）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendCanonicalEvent,
  canonicalFactIdempotencyKey,
  CanonicalEventValidationError,
  computeProjectionHash,
  driftCheck,
  readCanonicalFacts,
  replayProjection,
  validateCanonicalEventPayload,
  type CanonicalEventAppendInput,
  type CanonicalEventDomain,
  type CanonicalEventType,
  type CanonicalFactInsert,
  type CanonicalFactReader,
  type CanonicalProjectionEvent,
  type CanonicalReplayEvent,
  type CanonicalEventStore,
  type PendingScheduleView,
  type ReviewAttemptView,
  type ValidationOutcomeView,
  type WorkspaceUserScope,
} from "./canonical-events.ts";

// ─── 内存 store / reader（幂等键与 pg 语义一致）───────────────────────────

function domainToEventType(domain: CanonicalEventDomain): CanonicalEventType {
  switch (domain) {
    case "validation": return "validation.event";
    case "review": return "review.attempt";
    case "understanding": return "understanding.event";
  }
}

class InMemoryCanonicalEventStore implements CanonicalEventStore {
  /** idempotencyKey → fact id */
  facts = new Map<string, string>();
  /** 按写入顺序记录 sequence（断言每 workspace 单调） */
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
    const existing = this.facts.get(key);
    // 与真实 store 的 onConflictDoNothing 语义一致：冲突返回 null，由调用方回查转幂等
    if (existing) return null;
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

class InMemoryCanonicalFactReader implements CanonicalFactReader {
  schedules: PendingScheduleView[] = [];
  attempts: ReviewAttemptView[] = [];
  outcomes: ValidationOutcomeView[] = [];

  async listPendingSchedules(_scope: WorkspaceUserScope): Promise<PendingScheduleView[]> {
    return [...this.schedules];
  }

  async listReviewAttempts(_scope: WorkspaceUserScope): Promise<ReviewAttemptView[]> {
    return [...this.attempts];
  }

  async listValidationOutcomes(_scope: WorkspaceUserScope): Promise<ValidationOutcomeView[]> {
    return [...this.outcomes];
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const scope: WorkspaceUserScope = { workspaceId: "w-1", userId: "u-1" };

const validationPayload = {
  action: "completed",
  cardId: "card-1",
  keyPointId: "kp-1",
  questionId: "q-1",
  answerHash: "abc123",
  sourceFingerprint: "fp-1",
  rubricVersion: "rv1",
  outcomeSummary: "solid",
  confidence: 80,
  facetSummaries: [
    { rubricItemId: "ri-1", keyPointId: "kp-1", verdict: "covered", confidence: 80, rubricVersion: "rv1" },
  ],
};

const understandingPayload = {
  action: "seen",
  subjectType: "keyPoint",
  subjectId: "kp-1",
  occurredAt: "2026-08-08T00:00:00.000Z",
};

const reviewPayload = {
  action: "completed",
  reviewScheduleId: "rs-1",
  reviewAttemptId: "ra-1",
  outcomeSummary: "solid",
  confidence: 85,
};

const validationFact: CanonicalFactInsert = {
  domain: "validation",
  row: {
    cardId: "card-1",
    keyPointId: "kp-1",
    question: "请解释该 key point 的含义（原文只进权威表）",
    questionType: "explain",
    userAnswer: "用户回答原文（只进权威表）",
    outcome: "solid",
    confidence: 80,
    questionId: "q-1",
    sourceFingerprint: "fp-1",
    rubricVersion: "rv1",
  },
};

const understandingFact: CanonicalFactInsert = {
  domain: "understanding",
  row: { subjectType: "keyPoint", subjectId: "kp-1", eventType: "seen", payload: {} },
};

const reviewFact: CanonicalFactInsert = {
  domain: "review",
  row: {
    reviewScheduleId: "rs-1",
    subjectType: "keyPoint",
    subjectId: "kp-1",
    idempotencyKey: "idem-1",
    outcome: "solid",
    status: "completed",
    completedAt: new Date("2026-08-08T10:00:00.000Z"),
  },
};

// ─── payload 安全摘要校验 ─────────────────────────────────────────────────

describe("validateCanonicalEventPayload", () => {
  it("接受白名单内的安全摘要并裁剪", () => {
    const safe = validateCanonicalEventPayload({
      action: "completed",
      keyPointId: "kp-1",
      answerHash: "abc123",
      confidence: 80,
      facetSummaries: [{ rubricItemId: "ri-1", verdict: "covered", confidence: 80 }],
    });
    assert.equal(safe.keyPointId, "kp-1");
    assert.equal(safe.answerHash, "abc123");
    assert.equal(safe.confidence, 80);
    assert.equal(safe.facetSummaries?.length, 1);
    assert.equal(safe.facetSummaries?.[0]?.verdict, "covered");
  });

  it("拒绝 raw answer（userAnswer）", () => {
    assert.throws(
      () => validateCanonicalEventPayload({ userAnswer: "raw answer" }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "SENSITIVE_FIELD_DENIED",
    );
  });

  it("拒绝 chain-of-thought", () => {
    assert.throws(
      () => validateCanonicalEventPayload({ chainOfThought: "raw reasoning" }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "SENSITIVE_FIELD_DENIED",
    );
    assert.throws(
      () => validateCanonicalEventPayload({ chain_of_thought: "raw reasoning" }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "SENSITIVE_FIELD_DENIED",
    );
  });

  it("拒绝 question 原文 / rationale 原文等敏感键", () => {
    for (const sensitive of [{ question: "原文" }, { rationale: "raw" }, { feedback: "raw" }, { answerText: "raw" }]) {
      assert.throws(
        () => validateCanonicalEventPayload(sensitive),
        (err: unknown) =>
          err instanceof CanonicalEventValidationError && err.code === "SENSITIVE_FIELD_DENIED",
        `应拒绝 ${Object.keys(sensitive)[0]}`,
      );
    }
  });

  it("拒绝 facetSummaries 项内的敏感字段", () => {
    assert.throws(
      () => validateCanonicalEventPayload({
        facetSummaries: [{ rubricItemId: "ri-1", verdict: "covered", confidence: 80, rationale: "raw" }],
      }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "SENSITIVE_FIELD_DENIED",
    );
  });

  it("拒绝未知字段（fail closed，必须显式加入白名单）", () => {
    assert.throws(
      () => validateCanonicalEventPayload({ unknownField: "x" }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "UNKNOWN_PAYLOAD_FIELD",
    );
  });

  it("拒绝类型错误的字段", () => {
    assert.throws(
      () => validateCanonicalEventPayload({ confidence: "80" }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "INVALID_PAYLOAD_TYPE",
    );
    assert.throws(
      () => validateCanonicalEventPayload({ keyPointId: 42 }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "INVALID_PAYLOAD_TYPE",
    );
  });
});

// ─── appendCanonicalEvent：幂等 / sequence 单调 ───────────────────────────

describe("appendCanonicalEvent", () => {
  it("同事务追加权威事实 + outbox；幂等命中不重复写、不重复占 sequence", async () => {
    const store = new InMemoryCanonicalEventStore();
    const input: CanonicalEventAppendInput = {
      ...scope,
      eventType: "validation.event",
      payload: validationPayload,
      canonicalFact: validationFact,
    };

    const first = await appendCanonicalEvent(store, input);
    assert.equal(first.idempotent, false);
    assert.equal(first.sequence, 1);
    assert.equal(first.canonicalFactId, "fact-1");

    // 相同权威事实 + payload 再次 append → 幂等命中，不写 outbox
    const second = await appendCanonicalEvent(store, input);
    assert.equal(second.idempotent, true);
    assert.equal(second.sequence, null);
    assert.equal(second.canonicalFactId, null);
    assert.equal(store.outboxRows.length, 1);

    // 不同事件 → 新 sequence，且严格单调递增
    const third = await appendCanonicalEvent(store, {
      ...scope,
      eventType: "understanding.event",
      payload: understandingPayload,
      canonicalFact: understandingFact,
    });
    assert.equal(third.idempotent, false);
    assert.equal(third.sequence, 2);
    assert.equal(store.outboxRows.length, 2);
    assert.ok(store.outboxRows[1]!.sequence > store.outboxRows[0]!.sequence);
  });

  it("projectionHash 与 computeProjectionHash 对规范化 payload 一致", async () => {
    const store = new InMemoryCanonicalEventStore();
    const input: CanonicalEventAppendInput = {
      ...scope,
      eventType: "validation.event",
      payload: validationPayload,
      canonicalFact: validationFact,
    };
    const result = await appendCanonicalEvent(store, input);
    const safe = validateCanonicalEventPayload(validationPayload);
    const expected: CanonicalProjectionEvent = {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      eventType: "validation.event",
      payload: safe,
    };
    assert.equal(result.projectionHash, computeProjectionHash(expected));
  });

  it("eventType 与权威事实 domain 不一致时 fail closed", async () => {
    const store = new InMemoryCanonicalEventStore();
    await assert.rejects(
      appendCanonicalEvent(store, {
        ...scope,
        eventType: "validation.event",
        payload: validationPayload,
        canonicalFact: understandingFact, // domain 不一致
      }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "EVENT_TYPE_DOMAIN_MISMATCH",
    );
  });

  it("敏感 payload 直接拒绝（不写任何行）", async () => {
    const store = new InMemoryCanonicalEventStore();
    await assert.rejects(
      appendCanonicalEvent(store, {
        ...scope,
        eventType: "validation.event",
        payload: { ...validationPayload, userAnswer: "raw" },
        canonicalFact: validationFact,
      }),
      (err: unknown) =>
        err instanceof CanonicalEventValidationError && err.code === "SENSITIVE_FIELD_DENIED",
    );
    assert.equal(store.outboxRows.length, 0);
  });
});

// ─── 确定性投影 / 重放 ────────────────────────────────────────────────────

function buildStream(): CanonicalReplayEvent[] {
  return [
    { ...scope, sequence: 1, eventType: "validation.event", payload: validateCanonicalEventPayload(validationPayload) },
    { ...scope, sequence: 2, eventType: "understanding.event", payload: validateCanonicalEventPayload(understandingPayload) },
    { ...scope, sequence: 3, eventType: "review.attempt", payload: validateCanonicalEventPayload(reviewPayload) },
  ];
}

describe("replayProjection", () => {
  it("相同事件流重放得到相同 mastery/facet/map/hash（确定性）", () => {
    const stream = buildStream();
    const a = replayProjection(stream);
    const b = replayProjection(stream);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.mastery, b.mastery);
    assert.deepEqual(a.facet, b.facet);
    assert.deepEqual(a.map, b.map);
    assert.deepEqual(a.eventTrace, b.eventTrace);
    assert.equal(a.eventTrace.length, stream.length);
  });

  it("空流重放 hash 确定", () => {
    const a = replayProjection([]);
    const b = replayProjection([]);
    assert.equal(a.hash, b.hash);
    assert.equal(a.eventTrace.length, 0);
  });

  it("乱序（不同流）得到不同 hash", () => {
    const stream = buildStream();
    const forward = replayProjection(stream);
    const reversed = replayProjection([...stream].reverse());
    assert.notEqual(reversed.hash, forward.hash);
    assert.notDeepEqual(reversed.eventTrace, forward.eventTrace);
  });

  it("投影聚合结果符合 reducer 语义", () => {
    const snapshot = replayProjection(buildStream());
    // validation.event → validatedCount + lastOutcome
    assert.equal(snapshot.mastery["kp-1"]?.validatedCount, 1);
    assert.equal(snapshot.mastery["kp-1"]?.lastOutcome, "solid");
    // understanding.event(seen) → seenCount
    assert.equal(snapshot.mastery["kp-1"]?.seenCount, 1);
    // facet：validation.event 的 facetSummaries → 1 条观测
    assert.equal(snapshot.facet["ri-1"]?.observations, 1);
    assert.equal(snapshot.facet["ri-1"]?.lastVerdict, "covered");
    // map：understanding.event → keyPoint:kp-1 节点
    assert.equal(snapshot.map["keyPoint:kp-1"]?.eventCount, 1);
    assert.equal(snapshot.map["keyPoint:kp-1"]?.lastStatus, "seen");
  });
});

describe("computeProjectionHash", () => {
  it("相同事件内容同 hash；payload 键序不同不影响 hash", () => {
    const base: CanonicalProjectionEvent = {
      ...scope,
      eventType: "validation.event",
      payload: { action: "completed", keyPointId: "kp-1", confidence: 80 },
    };
    const reordered: CanonicalProjectionEvent = {
      ...base,
      payload: { keyPointId: "kp-1", confidence: 80, action: "completed" },
    };
    assert.equal(computeProjectionHash(base), computeProjectionHash(reordered));
  });

  it("内容变化 → hash 变化", () => {
    const base: CanonicalProjectionEvent = {
      ...scope,
      eventType: "validation.event",
      payload: { keyPointId: "kp-1" },
    };
    const changed: CanonicalProjectionEvent = {
      ...base,
      payload: { keyPointId: "kp-2" },
    };
    assert.notEqual(computeProjectionHash(base), computeProjectionHash(changed));
  });
});

// ─── drift 检测 ───────────────────────────────────────────────────────────

describe("driftCheck", () => {
  it("重放 hash 与存储 hash 一致 → 未漂移", () => {
    const hash = replayProjection(buildStream()).hash;
    const result = driftCheck(hash, hash);
    assert.equal(result.drifted, false);
    assert.equal(result.projectedHash, hash);
    assert.equal(result.storedHash, hash);
  });

  it("重放 hash 与存储 hash 不一致 → 漂移", () => {
    const projected = replayProjection(buildStream()).hash;
    const stored = "stale-or-tampered-hash";
    const result = driftCheck(projected, stored);
    assert.equal(result.drifted, true);
  });
});

// ─── 幂等键确定性 ─────────────────────────────────────────────────────────

describe("canonicalFactIdempotencyKey", () => {
  it("相同事件生成相同幂等键；不同事件不同键", () => {
    const k1 = canonicalFactIdempotencyKey(scope, "validation.event", validationFact);
    const k2 = canonicalFactIdempotencyKey(scope, "validation.event", validationFact);
    assert.equal(k1, k2);
    const k3 = canonicalFactIdempotencyKey(scope, "understanding.event", understandingFact);
    assert.notEqual(k3, k1);
    assert.match(k3, /^understanding:/);
    assert.match(
      canonicalFactIdempotencyKey(scope, "review.attempt", reviewFact),
      /^review:w-1:u-1:idem-1$/,
    );
  });
});

// ─── 旧 reader（projection 关闭仍可读权威事实）─────────────────────────────

describe("readCanonicalFacts", () => {
  it("projection 关闭时仍可读 pending schedule、attempt 和结果（权威表只读）", async () => {
    const reader = new InMemoryCanonicalFactReader();
    reader.schedules = [{
      scheduleId: "rs-1",
      subjectType: "keyPoint",
      subjectId: "kp-1",
      keyPointId: "kp-1",
      status: "pending",
      nextReviewAt: new Date("2026-08-10T00:00:00.000Z"),
      intervalDays: 2,
      generation: 1,
    }];
    reader.attempts = [{
      attemptId: "ra-1",
      scheduleId: "rs-1",
      subjectType: "keyPoint",
      subjectId: "kp-1",
      outcome: "solid",
      status: "completed",
      completedAt: new Date("2026-08-08T10:00:00.000Z"),
    }];
    reader.outcomes = [{
      eventId: "ve-1",
      keyPointId: "kp-1",
      outcome: "solid",
      confidence: 80,
      createdAt: new Date("2026-08-08T09:00:00.000Z"),
    }];

    const view = await readCanonicalFacts(reader, scope);
    assert.equal(view.pendingSchedules.length, 1);
    assert.equal(view.pendingSchedules[0]?.status, "pending");
    assert.equal(view.reviewAttempts.length, 1);
    assert.equal(view.reviewAttempts[0]?.outcome, "solid");
    assert.equal(view.validationOutcomes.length, 1);
    assert.equal(view.validationOutcomes[0]?.confidence, 80);
  });
});
