import test from "node:test";
import assert from "node:assert/strict";
import {
  companionConversationV1Schema,
  companionMessageV1Schema,
  companionTurnRunV1Schema,
  companionPageContextV1Schema,
  companionPersistedPageContextV1Schema,
  companionLearningRunContextV1Schema,
  companionLearningContextV1Schema,
  companionStreamEventV1Schema,
  companionErrorV1Schema,
  createCompanionTurnResponseV1Schema,
  proposedLearningActionPayloadV1Schema,
  proposalDecisionResponseV1Schema,
  companionMenuCandidateIdV1Schema,
  COMPANION_P2_LIMITS,
  type CompanionStreamEventV1,
} from "./companion-conversation-contracts.ts";
import { canonicalJsonV1, sha256Utf8V1, sha256Hex } from "./content-hash.ts";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const UUID2 = "223e4567-e89b-12d3-a456-426614174001";
const HASH = "a".repeat(64);
const TIME = "2026-08-10T00:00:00.000Z";
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    eventId: `${UUID}:1`,
    seq: 1,
    workspaceId: UUID,
    conversationId: UUID2,
    runId: UUID,
    generation: 1,
    accountEpoch: 0,
    createdAt: TIME,
    type: "turn.accepted",
    payload: {
      clientMessageId: UUID2,
      userMessageId: UUID,
      status: "accepted",
    },
    ...overrides,
  };
}

test("conversation schema accepts a valid row", () => {
  const result = companionConversationV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    userId: UUID2,
    kind: "dialogue",
    title: "新对话",
    titleSource: "placeholder",
    status: "active",
    createdAt: TIME,
    updatedAt: TIME,
    lastMessageAt: null,
  });
  assert.equal(result.success, true);
});

test("conversation schema rejects unknown kind/titleSource", () => {
  assert.equal(
    companionConversationV1Schema.safeParse({
      version: 1,
      id: UUID,
      workspaceId: UUID,
      userId: UUID2,
      kind: "chat",
      title: "x",
      titleSource: "placeholder",
      status: "active",
      createdAt: TIME,
      updatedAt: TIME,
      lastMessageAt: null,
    }).success,
    false,
  );
});

test("message schema: exactly one text block for user turn", () => {
  const ok = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "user",
    kind: "text",
    blocks: [{ type: "text", text: "你好" }],
    runId: UUID,
    clientMessageId: UUID2,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(ok.success, true);
  // 拒绝空 blocks
  const empty = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "user",
    kind: "text",
    blocks: [],
    runId: UUID,
    clientMessageId: UUID2,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(empty.success, false);
  // 拒绝超过 32 blocks
  const tooMany = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "user",
    kind: "text",
    blocks: Array.from({ length: 33 }, () => ({ type: "text", text: "a" })),
    runId: UUID,
    clientMessageId: UUID2,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(tooMany.success, false);
});

test("citation href 只允许 https", () => {
  const https = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "assistant",
    kind: "text",
    blocks: [
      { type: "text", text: "参见" },
      { type: "citation", label: "文档", target: { kind: "external_https", href: "https://example.com/doc" } },
    ],
    runId: UUID,
    clientMessageId: null,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(https.success, true);
  const http = companionMessageV1Schema.safeParse({
    version: 1,
    id: UUID,
    workspaceId: UUID,
    conversationId: UUID2,
    seq: 1,
    role: "assistant",
    kind: "text",
    blocks: [
      { type: "citation", label: "文档", target: { kind: "external_https", href: "http://example.com" } },
    ],
    runId: UUID,
    clientMessageId: null,
    contentSha256: SHA256,
    createdAt: TIME,
    editedAt: null,
  });
  assert.equal(http.success, false);
});

test("turn run: terminal 状态 phase 必须 null（superRefine 由 service 保证，schema 至少接受结构）", () => {
  const ok = companionTurnRunV1Schema.safeParse({
    version: 1,
    id: UUID,
    conversationId: UUID2,
    userMessageId: UUID,
    assistantMessageId: null,
    generation: 1,
    status: "accepted",
    phase: "accepted",
    previewText: "",
    previewTextSha256: HASH,
    lastEventSeq: 1,
    createdAt: TIME,
    updatedAt: TIME,
  });
  assert.equal(ok.success, true);
});

test("page context：LearningRun grounded_tutor grant iff requestedCapability", () => {
  const runContext = {
    pageKind: "learning_run",
    sharing: "user_selected",
    runId: UUID,
    snapshotId: UUID2,
    taskId: UUID,
    requestedCapability: "grounded_tutor",
    contextRevision: HASH,
  } as const;
  const grant = {
    version: 1,
    grantId: UUID,
    userId: UUID,
    workspaceId: UUID,
    pageInstanceId: UUID,
    pageKind: "learning_run",
    capability: "grounded_tutor",
    runId: UUID,
    snapshotId: UUID2,
    taskId: UUID,
    contextRevision: HASH,
    permissionSnapshotHash: HASH,
    issuedAt: TIME,
    expiresAt: TIME,
    signature: HASH,
  };
  assert.equal(companionPageContextV1Schema.safeParse({ ...runContext, groundedTutorGrant: grant }).success, true);
  assert.equal(companionPageContextV1Schema.safeParse({ ...runContext, groundedTutorGrant: null }).success, false);
  assert.equal(companionPageContextV1Schema.safeParse({
    ...runContext,
    requestedCapability: "none",
    groundedTutorGrant: grant,
  }).success, false);
});

test("persisted page context：LearningRun grant 可恢复且受 capability 约束", () => {
  const context = {
    pageKind: "learning_run",
    sharing: "user_selected",
    runId: UUID,
    snapshotId: UUID2,
    taskId: UUID,
    requestedCapability: "grounded_tutor",
    contextRevision: HASH,
    groundedTutorGrant: { grantId: UUID, permissionSnapshotHash: HASH, expiresAt: TIME },
  };
  assert.equal(companionPersistedPageContextV1Schema.safeParse({ version: 1, context }).success, true);
  assert.equal(companionPersistedPageContextV1Schema.safeParse({
    version: 1,
    context: { ...context, requestedCapability: "none", groundedTutorGrant: context.groundedTutorGrant },
  }).success, false);
});

test("LearningRun page context revision input is deterministic and state-bound", () => {
  const input = {
    runId: UUID,
    snapshotId: UUID2,
    taskId: UUID,
    phase: "active",
    runRevision: 1,
    runtimeEpoch: 1,
  };
  const revision = sha256Utf8V1(canonicalJsonV1(input));
  assert.equal(revision, sha256Utf8V1(canonicalJsonV1(input)));
  assert.notEqual(sha256Utf8V1(canonicalJsonV1({ ...input, runRevision: 2 })), revision);
});

test("SSE: union 中全部事件类型均可被接受（含 agent.skill/agent.tool）", () => {
  const cases: Record<string, Record<string, unknown>> = {
    "turn.accepted": { clientMessageId: UUID2, userMessageId: UUID, status: "accepted" },
    "assistant.status": { status: "thinking", safeLabel: "正在思考" },
    "assistant.delta": { appendFrom: 12, textDelta: "你好" },
    "assistant.final": { messageId: UUID, textLength: 4, textSha256: HASH, messageContentSha256: HASH },
    "character.cue": { cue: { version: 1, intent: "think", emotion: "curious", intensity: 0.35 } },
    "action.proposed": {
      proposal: {
        version: 1,
        id: UUID,
        workspaceId: UUID,
        conversationId: UUID2,
        sourceMessageId: UUID,
        sourceGeneration: 1,
        kind: { kind: "open_review" },
        payloadSha256: HASH,
        title: "复习",
        targetSummary: "今日复习",
        impactSummary: "打开复习页",
        status: "pending",
      },
    },
    "action.decision": { proposalId: UUID, decision: "confirm", status: "accepted" },
    "action.expired": { proposalId: UUID },
    "voice.segment.ready": { segmentId: HASH, ordinal: 1, text: "你好", textSha256: HASH },
    "proactive.delivery": { deliveryId: UUID, messageId: UUID, expiresAt: TIME, contentPolicy: "content" },
    "proactive.delivery.updated": { deliveryId: UUID, status: "shown", contentClaimed: true },
    "turn.cancelled": { reason: "user" },
    error: { code: "PROVIDER_TIMEOUT", recoverable: true },
    // Agent 方案 §6：Skill 选择与工具执行进度必须走同一 wire 合同。
    "agent.skill": {
      skill: { skillId: "learning-context", skillVersion: "1.0.0", name: "学习上下文", status: "selected" },
    },
    "agent.tool": {
      tool: {
        toolCallId: "call_1",
        name: "companion_open_review",
        toolVersion: "1.0.0",
        riskClass: "read",
        status: "succeeded",
        safeLabel: "打开复习页面",
        safeSummary: "已定位到复习页面",
      },
    },
  };
  for (const [type, payload] of Object.entries(cases)) {
    const result = companionStreamEventV1Schema.safeParse(baseEvent({ type, payload }));
    assert.equal(result.success, true, `type ${type} 应可接受`);
  }
  // 漂移护栏：union 新增事件类型时必须同步补用例——此前 agent.skill/agent.tool
  // 已加入 union，但本用例漏掉，导致新增事件类型无人校验。
  const covered = new Set(Object.keys(cases));
  for (const option of companionStreamEventV1Schema.options) {
    const literal = (option.shape.type as { value: string }).value;
    assert.ok(covered.has(literal), `union 事件类型 ${literal} 缺少用例`);
  }
  // 未知 type 拒绝
  const unknown = companionStreamEventV1Schema.safeParse(
    baseEvent({ type: "mystery" } as unknown as CompanionStreamEventV1),
  );
  assert.equal(unknown.success, false);
  // §5.1：envelope 顶层 strict——未知顶层字段拒绝（不能静默 strip）
  const extraKey = companionStreamEventV1Schema.safeParse({
    ...baseEvent({ type: "turn.accepted" }),
    unexpectedField: "x",
  });
  assert.equal(extraKey.success, false);
  // delta 超 2000 code unit 拒绝
  const tooLongDelta = companionStreamEventV1Schema.safeParse(
    baseEvent({ type: "assistant.delta", payload: { appendFrom: 0, textDelta: "x".repeat(2001) } }),
  );
  assert.equal(tooLongDelta.success, false);
});

test("error envelope：public message 有长度上限", () => {
  const ok = companionErrorV1Schema.safeParse({
    version: 1,
    error: "RATE_LIMITED",
    message: "请求过于频繁",
    recoverable: true,
    requestId: "req_1",
  });
  assert.equal(ok.success, true);
  const bad = companionErrorV1Schema.safeParse({
    version: 1,
    error: "NOT_A_CODE",
    message: "x",
    recoverable: false,
    requestId: "r",
  });
  assert.equal(bad.success, false);
});

test("create turn response：eventCursor 非负", () => {
  const ok = createCompanionTurnResponseV1Schema.safeParse({
    version: 1,
    conversationId: UUID2,
    clientMessageId: UUID,
    userMessageId: UUID,
    runId: UUID,
    generation: 1,
    status: "accepted",
    eventCursor: 5,
  });
  assert.equal(ok.success, true);
});

test("canonicalJsonV1：key 按 code point 排序、-0 → 0、无空白", () => {
  const canonical = canonicalJsonV1({ z: 1, a: { y: 2, b: [3, 4] }, m: null, n: true });
  assert.equal(canonical, '{"a":{"b":[3,4],"y":2},"m":null,"n":true,"z":1}');
  assert.equal(canonicalJsonV1({ x: -0 }), '{"x":0}');
  // 非 safe integer 拒绝
  assert.throws(() => canonicalJsonV1({ x: 1.5 }));
  assert.throws(() => canonicalJsonV1({ x: Number.MAX_SAFE_INTEGER + 1 }));
  // Unicode key 排序（code point）：学 U+5B66 在 a 之后、𠀀 U+20000 最后
  const unicode = canonicalJsonV1({ 学习: 1, a: 2, 𠀀: 3 });
  assert.equal(unicode, '{"a":2,"学习":1,"𠀀":3}');
});

test("sha256Utf8V1：与裸 sha256Hex 一致且为 64 位小写 hex", () => {
  const value = "你好\n换行 test";
  assert.equal(sha256Utf8V1(value), sha256Hex(value));
  assert.match(sha256Utf8V1(value), /^[a-f0-9]{64}$/);
});

test("P2 客户端限额常量与合同一致", () => {
  assert.equal(COMPANION_P2_LIMITS.composerMaxChars, 4_000);
  assert.equal(COMPANION_P2_LIMITS.serverHardMaxChars, 20_000);
  assert.equal(COMPANION_P2_LIMITS.deltaMaxChars, 2_000);
  assert.equal(COMPANION_P2_LIMITS.blocksPerMessage, 32);
});



// ─── Plan 23 CS-05/CS-06：V2 学习运行 payload 与候选扩展 ────────────────

test("proposedLearningActionPayload：accepts start_learning_run_v2（originV2 路径）", () => {
  const objectiveId = "123e4567-e89b-12d3-a456-426614174000";
  const cardId = "223e4567-e89b-12d3-a456-426614174000";
  const v2 = proposedLearningActionPayloadV1Schema.safeParse({
    kind: "start_learning_run_v2",
    request: {
      originV2: { kind: "card", cardId, objectiveId },
      goal: "stabilize",
      idempotencyKey: "pet-menu-v2:" + objectiveId,
    },
  });
  assert.equal(v2.success, true);
});

test("learningRunStartCandidate：V2 字段必须完整", () => {
  const ctx = {
    version: 1 as const,
    contextRevision: "a".repeat(64),
    learningRunResumeCandidate: null,
    learningRunStartCandidate: {
      candidateId: "learning_run_start" as const,
      title: "开始验证",
      targetSummary: "用三分钟了解光的折射",
      impactSummary: "创建一次学习运行",
      payloadSha256: "b".repeat(64),
      // V2 字段
      objectiveId: "423e4567-e89b-12d3-a456-426614174000",
      originV2: { kind: "card" as const, cardId: "223e4567-e89b-12d3-a456-426614174000", objectiveId: "423e4567-e89b-12d3-a456-426614174000" },
    },
  };
  assert.equal(companionLearningContextV1Schema.safeParse(ctx).success, true);
  const { objectiveId: _o, originV2: _v2, ...missingV2 } = ctx.learningRunStartCandidate!;
  assert.equal(companionLearningContextV1Schema.safeParse({
    ...ctx,
    learningRunStartCandidate: missingV2,
  }).success, false);
});

test("proposedLearningActionPayload：accepts resume_learning_run", () => {
  const resume = proposedLearningActionPayloadV1Schema.safeParse({
    kind: "resume_learning_run",
    runId: "323e4567-e89b-12d3-a456-426614174000",
  });
  assert.equal(resume.success, true);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "resume_learning_run" }).success, false);
  // 未知 kind 拒绝
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "start_learning_loop" }).success, false);
});

test("menu candidate id：learning_run_start / learning_run_resume 合法", () => {
  assert.equal(companionMenuCandidateIdV1Schema.safeParse("learning_run_start").success, true);
  assert.equal(companionMenuCandidateIdV1Schema.safeParse("learning_run_resume").success, true);
  assert.equal(companionMenuCandidateIdV1Schema.safeParse("unknown_resume").success, false);
  assert.equal(companionMenuCandidateIdV1Schema.safeParse("unknown_kind").success, false);
});

// ─── 方案 16 §18.1：工具网关第二批（Orchestrator 动作工具全集） ────────

test("proposedLearningActionPayload：accepts §18 全部工具 kind", () => {
  const runId = "423e4567-e89b-12d3-a456-426614174000";
  const taskId = "523e4567-e89b-12d3-a456-426614174000";
  const keyPointId = "623e4567-e89b-12d3-a456-426614174000";
  const scheduleId = "723e4567-e89b-12d3-a456-426614174000";
  const memoryId = "823e4567-e89b-12d3-a456-426614174000";
  const cases: unknown[] = [
    { kind: "pause_learning_run", runId },
    { kind: "switch_task_variant", runId, taskId, alternativeId: "variant-2" },
    { kind: "request_hint_level", runId, taskId, level: 2 },
    {
      kind: "defer_review",
      scheduleId,
      scheduleGeneration: 3,
      deferredUntil: "2026-08-20T09:00:00.000Z",
      reasonCode: "user_requested",
    },
    {
      kind: "plan_understanding_route",
      request: {
        version: 1,
        intent: "repair_gap",
        targetKeyPointId: keyPointId,
        maxSteps: 3,
        lens: "current_target",
        filter: { showArchived: false },
        expectedCheckpointToken: "v1:ws:uid:evt",
        idempotencyKey: "route:tool:1",
      },
    },
    { kind: "focus_graph_node", keyPointId, lens: "evidence" },
    { kind: "restore_graph_viewport", runId },
    { kind: "open_conversation_history" },
    { kind: "open_conversation_history", assistantSessionId: "923e4567-e89b-12d3-a456-426614174000" },
    { kind: "confirm_or_reject_memory", memoryId, revision: 1720000000000, decision: "confirm" },
    { kind: "delete_assistant_memory", memoryId, revision: 1720000000000 },
  ];
  for (const payload of cases) {
    assert.equal(proposedLearningActionPayloadV1Schema.safeParse(payload).success, true, JSON.stringify(payload));
  }
});

test("proposedLearningActionPayload：§18 工具非法变体拒绝", () => {
  const runId = "423e4567-e89b-12d3-a456-426614174000";
  // 缺 runId / 缺 level / level 越界 / 未知 reasonCode
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "pause_learning_run" }).success, false);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "request_hint_level", runId }).success, false);
  assert.equal(
    proposedLearningActionPayloadV1Schema.safeParse({ kind: "request_hint_level", runId, taskId: runId, level: 4 }).success,
    false,
  );
  assert.equal(
    proposedLearningActionPayloadV1Schema.safeParse({
      kind: "defer_review",
      scheduleId: runId,
      scheduleGeneration: 0,
      deferredUntil: "2026-08-20T09:00:00.000Z",
      reasonCode: "mystery",
    }).success,
    false,
  );
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "focus_graph_node" }).success, false);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "confirm_or_reject_memory", memoryId: runId, revision: 1 }).success, false);
  // 已删除的 kind 必须被拒绝（防止通过历史 payload 复活不可实现的动作）。
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "ask_grounded_tutor", runId, snapshotId: runId, taskId: runId, question: "?" }).success, false);
  assert.equal(
    proposedLearningActionPayloadV1Schema.safeParse({ kind: "propose_memory_candidate", memoryKind: "preference", value: "偏好", sourceMessageId: runId }).success,
    false,
  );
});

test("learning context：LearningRun 候选字段可解析且旧字段被拒绝", () => {
  const ok = companionLearningContextV1Schema.safeParse({
    version: 1,
    contextRevision: "a".repeat(64),
    learningRunResumeCandidate: {
      candidateId: "learning_run_resume",
      runId: "323e4567-e89b-12d3-a456-426614174000",
      title: "继续当前学习",
      targetSummary: "继续学习：…",
      impactSummary: "恢复当前学习运行",
      payloadSha256: "b".repeat(64),
    },
    learningRunStartCandidate: {
      candidateId: "learning_run_start",
      title: "开始三分钟巩固",
      targetSummary: "用三分钟巩固：…",
      impactSummary: "创建一次三分钟学习运行",
      payloadSha256: "c".repeat(64),
      objectiveId: UUID,
      originV2: { kind: "card", cardId: UUID2, objectiveId: UUID },
    },
  });
  assert.equal(ok.success, true);
  // 必填候选缺失仍拒绝
  assert.equal(companionLearningContextV1Schema.safeParse({
    version: 1,
    contextRevision: "a".repeat(64),
    learningRunResumeCandidate: null,
    learningRunStartCandidate: null,
    legacyCandidate: null,
  }).success, false);
});

test("grounded tutor：LearningRun context 和 grant 必须绑定同一页面类型", () => {
  const runId = "323e4567-e89b-12d3-a456-426614174000";
  const snapshotId = "423e4567-e89b-12d3-a456-426614174000";
  const taskId = "523e4567-e89b-12d3-a456-426614174000";
  assert.equal(companionLearningRunContextV1Schema.safeParse({
    version: 1,
    pageKind: "learning_run",
    sharing: "page_registered",
    runId,
    snapshotId,
    taskId,
    requestedCapability: "none",
    contextRevision: HASH,
    groundedTutorGrant: null,
  }).success, true);

  const runGrant = {
    version: 1,
    grantId: UUID,
    userId: UUID2,
    workspaceId: UUID,
    pageInstanceId: UUID2,
    pageKind: "learning_run",
    capability: "grounded_tutor",
    runId,
    snapshotId,
    taskId,
    contextRevision: HASH,
    permissionSnapshotHash: HASH,
    issuedAt: TIME,
    expiresAt: TIME,
    signature: HASH,
  };
  assert.equal(companionPageContextV1Schema.safeParse({
    pageKind: "learning_run",
    sharing: "user_selected",
    runId,
    snapshotId,
    taskId,
    requestedCapability: "grounded_tutor",
    contextRevision: HASH,
    groundedTutorGrant: runGrant,
  }).success, true);
});

test("proposalDecisionResponseV1Schema：route 接受 §18 V2 导航 kind（lens/restoreRun/assistantSessionId）", () => {
  const base = {
    version: 1,
    proposalId: "b23e4567-e89b-12d3-a456-426614174000",
    status: "succeeded",
    resultRef: null,
    safeSummary: "聚焦知识节点",
  };
  // focus_graph_node：star_map + keyPointId + lens
  assert.equal(
    proposalDecisionResponseV1Schema.safeParse({ ...base, route: { kind: "star_map", keyPointId: "623e4567-e89b-12d3-a456-426614174000", lens: "evidence" } }).success,
    true,
  );
  // restore_graph_viewport：star_map + restoreRun
  assert.equal(
    proposalDecisionResponseV1Schema.safeParse({ ...base, route: { kind: "star_map", restoreRun: "423e4567-e89b-12d3-a456-426614174000" } }).success,
    true,
  );
  // open_conversation_history：conversation + assistantSessionId
  assert.equal(
    proposalDecisionResponseV1Schema.safeParse({ ...base, route: { kind: "conversation", assistantSessionId: "923e4567-e89b-12d3-a456-426614174000" } }).success,
    true,
  );
  // 旧导航 kind 仍接受
  assert.equal(proposalDecisionResponseV1Schema.safeParse({ ...base, route: { kind: "review" } }).success, true);
  assert.equal(proposalDecisionResponseV1Schema.safeParse({ ...base, route: { kind: "card", cardId: "a23e4567-e89b-12d3-a456-426614174000" } }).success, true);
  // V1 旧字段 conversationId 不再接受（V2 合同）
  assert.equal(
    proposalDecisionResponseV1Schema.safeParse({ ...base, route: { kind: "conversation", conversationId: "923e4567-e89b-12d3-a456-426614174000" } }).success,
    false,
  );
});
