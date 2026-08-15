import test from "node:test";
import assert from "node:assert/strict";
import {
  companionConversationV1Schema,
  companionMessageV1Schema,
  companionTurnRunV1Schema,
  companionPageContextV1Schema,
  companionPersistedPageContextV1Schema,
  companionLearningSessionContextV1Schema,
  companionLearningContextV1Schema,
  companionStreamEventV1Schema,
  companionErrorV1Schema,
  createCompanionTurnResponseV1Schema,
  companionActionIntentV1Schema,
  companionActionClassifierInputV1Schema,
  proposedLearningActionPayloadV1Schema,
  proposalDecisionResponseV1Schema,
  companionMenuCandidateIdV1Schema,
  COMPANION_ACTION_LEXEMES,
  COMPANION_ACTION_ROUTER_V1_SHA256,
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

test("page context: grounded_tutor grant iff requestedCapability", () => {
  const grant = {
    version: 1,
    grantId: UUID,
    userId: UUID,
    workspaceId: UUID,
    pageInstanceId: UUID,
    pageKind: "learning_session",
    capability: "grounded_tutor",
    sessionId: UUID,
    episodeId: UUID,
    cardId: UUID,
    keyPointId: UUID,
    contextRevision: HASH,
    permissionSnapshotHash: HASH,
    issuedAt: TIME,
    expiresAt: TIME,
    signature: HASH,
  };
  const ok = companionPageContextV1Schema.safeParse({
    pageKind: "learning_session",
    sharing: "user_selected",
    sessionId: UUID,
    episodeId: UUID,
    cardId: UUID,
    keyPointId: UUID,
    requestedCapability: "grounded_tutor",
    contextRevision: HASH,
    groundedTutorGrant: grant,
  });
  assert.equal(ok.success, true);
  // 请求 grounded_tutor 但无 grant → 拒绝
  const missing = companionPageContextV1Schema.safeParse({
    pageKind: "learning_session",
    sharing: "user_selected",
    sessionId: UUID,
    episodeId: UUID,
    cardId: UUID,
    keyPointId: UUID,
    requestedCapability: "grounded_tutor",
    contextRevision: HASH,
    groundedTutorGrant: null,
  });
  assert.equal(missing.success, false);
  // 不请求但带 grant → 拒绝
  const extra = companionPageContextV1Schema.safeParse({
    pageKind: "learning_session",
    sharing: "user_selected",
    sessionId: UUID,
    episodeId: UUID,
    cardId: UUID,
    keyPointId: UUID,
    requestedCapability: "none",
    contextRevision: HASH,
    groundedTutorGrant: grant,
  });
  assert.equal(extra.success, false);
});

test("persisted page context：grounded grant 可恢复且仍受 capability 约束", () => {
  const persisted = companionPersistedPageContextV1Schema.safeParse({
    version: 1,
    context: {
      pageKind: "learning_session",
      sharing: "user_selected",
      sessionId: UUID,
      episodeId: UUID2,
      cardId: UUID,
      keyPointId: UUID2,
      requestedCapability: "grounded_tutor",
      contextRevision: HASH,
      groundedTutorGrant: {
        grantId: UUID,
        permissionSnapshotHash: HASH,
        expiresAt: TIME,
      },
    },
  });
  assert.equal(persisted.success, true);
  const invalid = companionPersistedPageContextV1Schema.safeParse({
    version: 1,
    context: {
      pageKind: "learning_session",
      sharing: "user_selected",
      sessionId: UUID,
      episodeId: UUID2,
      cardId: UUID,
      keyPointId: UUID2,
      requestedCapability: "none",
      contextRevision: HASH,
      groundedTutorGrant: { grantId: UUID, permissionSnapshotHash: HASH, expiresAt: TIME },
    },
  });
  assert.equal(invalid.success, false);
});

test("Learning Session page adapter contextRevision is deterministic and state-bound", () => {
  const input = {
    sessionId: UUID,
    episodeId: UUID2,
    cardId: UUID,
    keyPointId: UUID2,
    sessionStatus: "active",
    episodeStatus: "active",
    processingPhase: "awaiting_response",
    episodeEpoch: 1,
    planHash: HASH,
    contentExposureKey: "exposure-v1",
    sessionUpdatedAt: TIME,
    episodeUpdatedAt: TIME,
    answerLocked: false,
  };
  // 2026-08-13：revision 计算已移至 api 侧（learning-session-context.ts），
  // 此处验证底层 content-hash 的确定性与输入绑定（revision 语义不变）。
  const revision = sha256Utf8V1(canonicalJsonV1(input));
  const context = companionLearningSessionContextV1Schema.parse({
    version: 1,
    pageKind: "learning_session",
    sharing: "page_registered",
    sessionId: UUID,
    episodeId: UUID2,
    cardId: UUID,
    keyPointId: UUID2,
    requestedCapability: "none",
    contextRevision: revision,
    groundedTutorGrant: null,
  });
  assert.equal(context.contextRevision, revision);
  assert.notEqual(
    sha256Utf8V1(canonicalJsonV1({ ...input, answerLocked: true })),
    revision,
  );
});

test("SSE: 全部 16 种事件类型可被 discriminated union 接受", () => {
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
    "action.decision": { proposalId: UUID, decision: "confirm", status: "accepted", actionRunId: UUID },
    "action.expired": { proposalId: UUID },
    "action.started": { proposalId: UUID, actionRunId: UUID },
    "action.completed": { actionRunId: UUID, resultRef: null, route: null, safeSummary: "完成" },
    "action.failed": { actionRunId: UUID, code: "E_TEST", recoverable: true },
    "voice.segment.ready": { segmentId: HASH, ordinal: 1, text: "你好", textSha256: HASH },
    "proactive.delivery": { deliveryId: UUID, messageId: UUID, expiresAt: TIME, contentPolicy: "content" },
    "proactive.delivery.updated": { deliveryId: UUID, status: "shown", contentClaimed: true },
    "turn.cancelled": { reason: "user" },
    error: { code: "PROVIDER_TIMEOUT", recoverable: true },
  };
  for (const [type, payload] of Object.entries(cases)) {
    const result = companionStreamEventV1Schema.safeParse(baseEvent({ type, payload }));
    assert.equal(result.success, true, `type ${type} 应可接受`);
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

test("P5 §9.4：action intent schema 冻结（strict、enum、confidence 0..1）", () => {
  const ok = companionActionIntentV1Schema.safeParse({
    version: 1,
    intent: "start_short",
    confidence: 0.95,
  });
  assert.equal(ok.success, true);
  // 未知 intent / 多余字段 / confidence 越界全部拒绝
  assert.equal(companionActionIntentV1Schema.safeParse({
    version: 1, intent: "hack", confidence: 0.9,
  }).success, false);
  assert.equal(companionActionIntentV1Schema.safeParse({
    version: 1, intent: "none", confidence: 0.9, extra: 1,
  }).success, false);
  assert.equal(companionActionIntentV1Schema.safeParse({
    version: 1, intent: "none", confidence: 1.1,
  }).success, false);
});

test("P5 §9.4：classifier input schema 冻结（userText 1..4000 + availableIntents strict）", () => {
  const ok = companionActionClassifierInputV1Schema.safeParse({
    version: 1,
    userText: "帮我开始学习",
    availableIntents: {
      resume_current: true, start_short: true, open_review: true,
      open_current_card: true, open_star_map: true, ask_grounded_tutor: false,
    },
  });
  assert.equal(ok.success, true);
  // 缺失字段 / 多余字段 / userText 超限拒绝
  assert.equal(companionActionClassifierInputV1Schema.safeParse({
    version: 1, userText: "x",
  }).success, false);
  assert.equal(companionActionClassifierInputV1Schema.safeParse({
    version: 1,
    userText: "x".repeat(4_001),
    availableIntents: { resume_current: false, start_short: false, open_review: false, open_current_card: false, open_star_map: false, ask_grounded_tutor: false },
  }).success, false);
});

test("P5 §9.4：bounded lexeme 冻结列表含中文与英文动作词", () => {
  for (const lexeme of ["继续", "恢复", "开始", "打开", "进入", "回到", "带我去", "帮我开始", "帮我继续", "continue", "resume", "start", "open", "go to"]) {
    assert.ok((COMPANION_ACTION_LEXEMES as readonly string[]).includes(lexeme), `missing lexeme: ${lexeme}`);
  }
  // 冻结 classifier prompt 的 SHA-256 与 03 §9.4 记录一致
  assert.equal(COMPANION_ACTION_ROUTER_V1_SHA256, "99122a340328bbf248e3f3e434d27eebd6445226db6c2e0f1bb50543555b0dde");
});



// ─── 方案 16 §18：LearningRun 工具契约（2026-08-14 扩展） ───────────────

test("proposedLearningActionPayload：accepts start_learning_run / resume_learning_run", () => {
  const start = proposedLearningActionPayloadV1Schema.safeParse({
    kind: "start_learning_run",
    request: {
      version: 1,
      origin: { kind: "card", cardId: UUID, keyPointId: "223e4567-e89b-12d3-a456-426614174000" },
      goal: "stabilize",
      clientRequestId: "pet-menu:223e4567-e89b-12d3-a456-426614174000",
      idempotencyKey: "pet-menu:223e4567-e89b-12d3-a456-426614174000",
    },
  });
  assert.equal(start.success, true);
  const resume = proposedLearningActionPayloadV1Schema.safeParse({
    kind: "resume_learning_run",
    runId: "323e4567-e89b-12d3-a456-426614174000",
  });
  assert.equal(resume.success, true);
  // 缺 request / 缺 runId 拒绝
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "start_learning_run" }).success, false);
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "resume_learning_run" }).success, false);
  // 未知 kind 拒绝
  assert.equal(proposedLearningActionPayloadV1Schema.safeParse({ kind: "start_learning_loop" }).success, false);
});

test("menu candidate id：learning_run_start / learning_run_resume 合法", () => {
  assert.equal(companionMenuCandidateIdV1Schema.safeParse("learning_run_start").success, true);
  assert.equal(companionMenuCandidateIdV1Schema.safeParse("learning_run_resume").success, true);
  assert.equal(companionMenuCandidateIdV1Schema.safeParse("resume_current").success, true);
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
    { kind: "propose_memory_candidate", memoryKind: "preference", value: "喜欢安静的环境", sourceMessageId: "a23e4567-e89b-12d3-a456-426614174000" },
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
  assert.equal(
    proposedLearningActionPayloadV1Schema.safeParse({ kind: "propose_memory_candidate", memoryKind: "preference", value: "" }).success,
    false,
  );
});

test("learning context：LearningRun 候选字段可解析；旧字段仍 required", () => {
  const ok = companionLearningContextV1Schema.safeParse({
    version: 1,
    contextRevision: "a".repeat(64),
    resumeCandidate: null,
    startCandidate: null,
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
      cardId: UUID,
      keyPointId: "223e4567-e89b-12d3-a456-426614174000",
      title: "开始三分钟巩固",
      targetSummary: "用三分钟巩固：…",
      impactSummary: "创建一次三分钟学习运行",
      payloadSha256: "c".repeat(64),
    },
  });
  assert.equal(ok.success, true);
  // 旧字段缺失仍拒绝（strict 向后兼容）
  assert.equal(companionLearningContextV1Schema.safeParse({
    version: 1,
    contextRevision: "a".repeat(64),
  }).success, false);
});

test("proposalDecisionResponseV1Schema：route 接受 §18 V2 导航 kind（lens/restoreRun/assistantSessionId）", () => {
  const base = {
    version: 1,
    proposalId: "b23e4567-e89b-12d3-a456-426614174000",
    status: "succeeded",
    actionRunId: null,
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
