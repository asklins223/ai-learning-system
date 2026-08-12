import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildActionClassifierInput,
  classifyDialogueAction,
  constructActionProposalInWorker,
  shouldRunActionClassifier,
  type AvailableIntentsV1,
  type RouterDecisionV1,
} from "./companion-dialogue-router.ts";
import {
  COMPANION_ACTION_ROUTER_V1_SHA256,
} from "@ailearn/shared";
import type { AIProvider } from "../lib/ai-provider.ts";

const ALL_AVAILABLE: AvailableIntentsV1 = {
  resume_current: true,
  start_short: true,
  open_review: true,
  open_current_card: true,
  open_star_map: true,
  ask_grounded_tutor: false,
};

function mockProvider(content: string): AIProvider {
  return {
    id: "mock",
    modelId: "mock-model",
    visionModelId: "mock-vision",
    promptVersion: "mock-v1",
    async chatCompletion(messages: unknown[], _options: unknown): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
      assert.ok(messages.length === 2, "classifier 只含 system + user 两消息");
      const [system, user] = messages as [{ content: string }, { content: string }];
      assert.equal(system.content.includes("动作意图分类器"), true);
      const parsed = JSON.parse(user.content as string) as {
        version: number;
        userText: string;
        availableIntents: AvailableIntentsV1;
      };
      assert.equal(parsed.version, 1);
      assert.ok(!("history" in parsed), "classifier input 不得含 history");
      return { content, usage: { promptTokens: 0, completionTokens: 0 } };
    },
  } as unknown as AIProvider;
}

const NONE: RouterDecisionV1 = {
  intent: "none",
  confidenceBps: 0,
  promptVersion: "companion-action-router-v1",
  promptHash: COMPANION_ACTION_ROUTER_V1_SHA256,
};

test("shouldRunActionClassifier：无可用 intent 时不调用 classifier", () => {
  const none: AvailableIntentsV1 = {
    resume_current: false, start_short: false, open_review: false,
    open_current_card: false, open_star_map: false, ask_grounded_tutor: false,
  };
  assert.equal(shouldRunActionClassifier("帮我开始学习", none), false);
});

test("shouldRunActionClassifier：bounded lexeme 命中才调用", () => {
  assert.equal(shouldRunActionClassifier("帮我开始学习光合作用", ALL_AVAILABLE), true);
  assert.equal(shouldRunActionClassifier("继续刚才的课程", ALL_AVAILABLE), true);
  assert.equal(shouldRunActionClassifier("resume my session", ALL_AVAILABLE), true);
  // 无 lexeme 的普通提问/讨论不触发 classifier（§9.4 步骤 2）
  assert.equal(shouldRunActionClassifier("光合作用的原理是什么", ALL_AVAILABLE), false);
  // 含 lexeme 但语义上未必是动作 → 仍触发 classifier，由 classifier 判 none；
  // 预检保持宽松（§9.4 步骤 2 只做 lexeme 预筛）。
  assert.equal(shouldRunActionClassifier("我昨天开始学习了，今天想复习一下，你觉得呢", ALL_AVAILABLE), true);
});

test("classifyDialogueAction：confidence>=0.90 且 available 才返回 action intent", async () => {
  const provider = mockProvider(JSON.stringify({ version: 1, intent: "start_short", confidence: 0.95 }));
  const input = buildActionClassifierInput("帮我开始学习", ALL_AVAILABLE);
  const decision = await classifyDialogueAction(provider, input, ALL_AVAILABLE, undefined);
  assert.equal(decision.intent, "start_short");
  assert.equal(decision.confidenceBps, 9500);
  assert.equal(decision.promptHash, COMPANION_ACTION_ROUTER_V1_SHA256);
});

test("classifyDialogueAction：confidence < 0.90 回落 none", async () => {
  const provider = mockProvider(JSON.stringify({ version: 1, intent: "start_short", confidence: 0.8 }));
  const input = buildActionClassifierInput("帮我开始学习", ALL_AVAILABLE);
  const decision = await classifyDialogueAction(provider, input, ALL_AVAILABLE, undefined);
  assert.deepEqual(decision, NONE);
});

test("classifyDialogueAction：intent 不可用回落 none", async () => {
  const provider = mockProvider(JSON.stringify({ version: 1, intent: "ask_grounded_tutor", confidence: 0.99 }));
  const available: AvailableIntentsV1 = { ...ALL_AVAILABLE, ask_grounded_tutor: false };
  const input = buildActionClassifierInput("带我进入课堂答疑", available);
  const decision = await classifyDialogueAction(provider, input, available, undefined);
  assert.deepEqual(decision, NONE);
});

test("classifyDialogueAction：invalid JSON / schema 不合法回落 none", async () => {
  const badJson = mockProvider("not-json{{{");
  const input = buildActionClassifierInput("帮我开始学习", ALL_AVAILABLE);
  assert.deepEqual(await classifyDialogueAction(badJson, input, ALL_AVAILABLE, undefined), NONE);
  const badSchema = mockProvider(JSON.stringify({ version: 2, intent: "start_short", confidence: 0.99 }));
  assert.deepEqual(await classifyDialogueAction(badSchema, input, ALL_AVAILABLE, undefined), NONE);
});

test("classifyDialogueAction：provider 抛错回落 none 不影响正文", async () => {
  const throwing = {
    ...mockProvider(""),
    async chatCompletion(): Promise<never> {
      throw new Error("provider down");
    },
  } as unknown as AIProvider;
  const input = buildActionClassifierInput("帮我开始学习", ALL_AVAILABLE);
  assert.deepEqual(await classifyDialogueAction(throwing, input, ALL_AVAILABLE, undefined), NONE);
});

test("buildActionClassifierInput：strict schema 冻结字段", () => {
  const input = buildActionClassifierInput("  帮我开始学习  ", ALL_AVAILABLE);
  assert.deepEqual(input, {
    version: 1,
    userText: "帮我开始学习",
    availableIntents: ALL_AVAILABLE,
  });
});

// ─── constructActionProposalInWorker（§8.3 worker 侧 proposal 落库） ────

interface RecordedQuery { sql: string; values: unknown[] }

/**
 * 顺序 mock：drizzle sql 对象无法可靠 toString，按调用次序返回预定结果。
 * 顺序（constructActionProposalInWorker）：
 *   1) 候选查询（resume: learning_sessions / start: learning_episodes）
 *   2) expired 回收 UPDATE → []
 *   3) pending 检查 SELECT → existingPending ? [{id}] : []
 *   4) proposal INSERT → []
 *   5) stream event INSERT → []
 */
function mockTx(overrides?: {
  candidate?: { id: string; intent: string | null } | { key_point_id: string; card_id: string; claim: string | null };
  existingPending?: boolean;
}) {
  const queries: RecordedQuery[] = [];
  const sessionRows = overrides?.candidate && "id" in overrides.candidate
    ? [{ id: overrides.candidate.id, intent: overrides.candidate.intent ?? null }]
    : [];
  const keyPointRows = overrides?.candidate && "key_point_id" in overrides.candidate
    ? [{ key_point_id: overrides.candidate.key_point_id, card_id: overrides.candidate.card_id, claim: overrides.candidate.claim ?? null }]
    : [];
  let call = 0;
  return {
    queries,
    async execute(query: unknown): Promise<unknown[]> {
      // drizzle sql 对象 → 拼接 queryChunks（StringChunk.value）得到可读 SQL
      const chunked = (query as { queryChunks?: unknown[] })?.queryChunks;
      const sqlText = Array.isArray(chunked)
        ? chunked
          .map((c) => (c as { value?: string[] }).value?.[0] ?? "")
          .join("")
        : String(query);
      queries.push({ sql: sqlText, values: [] });
      call += 1;
      // 1) 候选查询
      if (call === 1) {
        return "id" in (overrides?.candidate ?? {}) ? sessionRows : keyPointRows;
      }
      // 2) expired 回收
      if (call === 2) return [];
      // 3) pending 检查
      if (call === 3) return overrides?.existingPending ? [{ id: "pending-1" }] : [];
      return [];
    },
  };
}

const BASE_ARGS = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000004",
  generation: 2,
  accountEpoch: 1,
  userMessageId: "00000000-0000-4000-8000-000000000005",
  eventSeq: 10,
};

test("constructActionProposalInWorker：resume_current 构造 payload 并插入 proposal（含 idempotency_key_hash）", async () => {
  const tx = mockTx({ candidate: { id: "session-1", intent: "光合作用复习" } });
  const result = await constructActionProposalInWorker({
    ...BASE_ARGS,
    intent: "resume_current",
    tx: tx as never,
  });
  assert.ok(result, "resume 候选可用时应构造 proposal");
  assert.equal(result!.proposalPayload.kind, "resume_session");
  assert.equal(result!.proposalPayload.sessionId, "session-1");
  const insertQuery = tx.queries.find((q) => q.sql.includes("INSERT INTO companion_action_proposals"));
  assert.ok(insertQuery, "必须插入 proposal");
  assert.match(insertQuery!.sql, /idempotency_key_hash/, "INSERT 必须含 idempotency_key_hash（0092 NOT NULL）");
  assert.match(insertQuery!.sql, /'pending'/, "proposal 初始 status 为 pending");
});

test("constructActionProposalInWorker：start_short 构造 start_session payload", async () => {
  const tx = mockTx({
    candidate: { key_point_id: "kp-1", card_id: "card-1", claim: "细胞结构" },
  });
  const result = await constructActionProposalInWorker({
    ...BASE_ARGS,
    intent: "start_short",
    tx: tx as never,
  });
  assert.ok(result);
  assert.deepEqual(result!.proposalPayload, {
    kind: "start_session",
    origin: "now",
    cardId: "card-1",
    keyPointId: "kp-1",
  });
  assert.equal(result!.payloadSha256.length, 64);
});

test("constructActionProposalInWorker：候选消失返回 null（零副作用）", async () => {
  const tx = mockTx({ candidate: undefined });
  const result = await constructActionProposalInWorker({
    ...BASE_ARGS,
    intent: "start_short",
    tx: tx as never,
  });
  assert.equal(result, null);
  assert.ok(!tx.queries.some((q) => q.sql.includes("INSERT INTO companion_action_proposals")), "候选消失不得插入");
});

test("constructActionProposalInWorker：已有 pending 跳过（single pending fence）", async () => {
  const tx = mockTx({ candidate: { id: "session-1", intent: "x" }, existingPending: true });
  const result = await constructActionProposalInWorker({
    ...BASE_ARGS,
    intent: "resume_current",
    tx: tx as never,
  });
  assert.equal(result, null, "同 conversation 已有 pending proposal 时跳过");
});

test("constructActionProposalInWorker：非支持 intent（open_review）回落 null", async () => {
  const tx = mockTx();
  const result = await constructActionProposalInWorker({
    ...BASE_ARGS,
    intent: "open_review",
    tx: tx as never,
  });
  assert.equal(result, null);
});
