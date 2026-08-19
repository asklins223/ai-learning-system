/**
 * P5 §9.4 Dialogue Router（03 合同冻结）— worker 侧 action classifier。
 *
 * 三态路由语义（方案 13 §7.2）：
 * - casual_chat / learning_question：不触发 classifier（lexeme 预检不命中）
 *   → 走 persona 文字回复（learning_question 由 grounded-tutor 分支承接）；
 * - learning_action：lexeme 预检命中 → classifier 只输出 intent/confidence，
 *   经 shared schema 验证 + confidence>=0.90 + availableIntents 检查后，
 *   由调用方决定是否构造 proposal（payload 来自只读 Learning adapter，
 *   模型不提供 ID/route/payload）。
 *
 * 冻结规则（§9.4）：
 * - classifier input 只含 userText + availableIntents，不含 entity ID /
 *   隐藏答案 / conversation history；
 * - prompt 正文固定为 COMPANION_ACTION_ROUTER_V1_PROMPT（578 bytes，
 *   SHA-256 已冻结）；参数固定 temperature 0 / maxTokens 80 / json_object；
 * - 失败 / timeout / invalid JSON 永远回落 none，不影响正文回复；
 * - 该内部结果只写 run row 的 router_* 字段，不保存 prompt body 或重复
 *   user text。
 */

import { randomUUID } from "node:crypto";
import { sha256Hex } from "@ailearn/shared/content-hash";
import { sql } from "drizzle-orm";
import type { AIProvider } from "../lib/ai-provider.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { COMPANION_ACTION_LEXEMES, COMPANION_ACTION_ROUTER_OPTIONS, COMPANION_ACTION_ROUTER_V1_PROMPT, COMPANION_ACTION_ROUTER_V1_SHA256, companionActionClassifierInputV1Schema, companionActionIntentV1Schema, type CompanionActionIntentV1,  } from "@ailearn/shared";
import { canonicalJsonV1 } from "@ailearn/shared/content-hash";

// 2026-08-12（契约收口）：冻结参数单一来源迁移到 @ailearn/shared
// （COMPANION_ACTION_ROUTER_OPTIONS）——此前本地双份定义与 shared
// responseFormat 值不一致（"json_object" vs "json"）。

export interface AvailableIntentsV1 {
  resume_current: boolean;
  start_short: boolean;
  open_review: boolean;
  open_current_card: boolean;
  open_star_map: boolean;
  ask_grounded_tutor: boolean;
}

export interface RouterDecisionV1 {
  intent: CompanionActionIntentV1["intent"];
  /** Math.round(confidence * 10000) 落库（0..10000）。 */
  confidenceBps: number;
  promptVersion: string;
  promptHash: string;
}

/** 预检：NFC/trim/lowercase 后仅当正文包含 bounded lexeme 才需要 classifier。 */
export function shouldRunActionClassifier(
  userText: string,
  availableIntents: AvailableIntentsV1,
): boolean {
  const anyAvailable = Object.values(availableIntents).some(Boolean);
  if (!anyAvailable) return false;
  const normalized = userText.normalize("NFC").trim().toLowerCase();
  return COMPANION_ACTION_LEXEMES.some((lexeme) => normalized.includes(lexeme));
}

/** 构造 §9.4 冻结的 classifier input（只含 userText + availableIntents）。 */
export function buildActionClassifierInput(
  userText: string,
  availableIntents: AvailableIntentsV1,
): unknown {
  return companionActionClassifierInputV1Schema.parse({
    version: 1,
    userText: userText.normalize("NFC").trim().slice(0, 4_000),
    availableIntents,
  });
}

/**
 * 调用 classifier provider，返回验证后的 intent。
 * - provider 失败 / timeout / invalid JSON / schema 不合法 → none（§9.4）；
 * - confidence < 0.90 或 intent 不在 availableIntents → none；
 * - intent 不可用 → none；none → none。
 */
export async function classifyDialogueAction(
  provider: AIProvider,
  input: unknown,
  availableIntents: AvailableIntentsV1,
  signal: AbortSignal | undefined,
): Promise<RouterDecisionV1> {
  const none: RouterDecisionV1 = {
    intent: "none",
    confidenceBps: 0,
    promptVersion: "companion-action-router-v1",
    promptHash: COMPANION_ACTION_ROUTER_V1_SHA256,
  };
  try {
    const result = await provider.chatCompletion(
      [
        { role: "system", content: COMPANION_ACTION_ROUTER_V1_PROMPT },
        { role: "user", content: canonicalJsonV1(input) },
      ],
      // capability 是 provider 选择提示字段，非 ChatOptions——调用时剥离
      { temperature: COMPANION_ACTION_ROUTER_OPTIONS.temperature, maxTokens: COMPANION_ACTION_ROUTER_OPTIONS.maxTokens, responseFormat: COMPANION_ACTION_ROUTER_OPTIONS.responseFormat },
      signal,
    );
    const parsed = JSON.parse(result.content) as unknown;
    const validated = companionActionIntentV1Schema.safeParse(parsed);
    if (!validated.success) return none;
    const { intent, confidence } = validated.data;
    if (intent === "none") return none;
    if (confidence < 0.9) return none;
    if (availableIntents[intent] !== true) return none;
    return {
      intent,
      confidenceBps: Math.round(confidence * 10_000),
      promptVersion: "companion-action-router-v1",
      promptHash: COMPANION_ACTION_ROUTER_V1_SHA256,
    };
  } catch {
    // §9.4：classifier 失败永远回落 none，不影响正文回复。
    return none;
  }
}

/** 解析 classifier 任务的 provider：由调用方传入（复用 companion_dialogue 的
 *  text_generation 槽位，调用方 resolveProviderForTask(govCtx, "companion_dialogue")
 *  后 createProvider 传入本模块）。不在此重复解析，保持模块纯函数可测。 */

/**
 * worker 侧只读构造 availableIntents（§9.4 服务端从只读 Learning adapter
 * 构造）。与 API 侧 resolveCompanionLearningContext 同源语义（resume 最近
 * active session；start 最近 episode 的 key point），但只输出布尔 availability，
 * 不输出 payload/ID——候选 payload 构造仍在 API proposal create 时做。
 */
export async function resolveAvailableIntentsInWorker(args: {
  workspaceId: string;
  userId: string;
  groundedTutorRequested: boolean;
}): Promise<AvailableIntentsV1> {
  const { workspaceId, userId } = args;
  return withWorkerWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const resumeRows = await tx.execute<{ id: string }>(sql`
        SELECT s.id
        FROM learning_sessions s
        WHERE s.workspace_id = ${workspaceId}
          AND s.user_id = ${userId}
          AND s.status = 'active'
        ORDER BY s.created_at DESC
        LIMIT 1
      `);
      // V2: key_point_id is now an alias for objective_id;
      // check existence via learning_objectives_v2.
      const startRows = await tx.execute<{ key_point_id: string }>(sql`
        SELECT e.key_point_id
        FROM learning_episodes e
        JOIN learning_objectives_v2 o ON o.objective_id = e.key_point_id
        WHERE e.workspace_id = ${workspaceId}
          AND e.user_id = ${userId}
          AND o.workspace_id = ${workspaceId}
        ORDER BY e.created_at DESC
        LIMIT 1
      `);
      return {
        resume_current: resumeRows[0] != null,
        start_short: startRows[0] != null,
        open_review: true,
        open_current_card: startRows[0] != null,
        open_star_map: true,
        // §9.4 步骤 6：ask_grounded_tutor 只有当前 Learning Session 显式 UI
        // 设置 requestedCapability=grounded_tutor、服务端确认 session/episode
        // 正在进行且允许 assistance 时才 available——由调用方传 groundedTutorRequested。
        ask_grounded_tutor: args.groundedTutorRequested,
      };
    },
  );
}

/**
 * worker 侧 proposal 构造 + 落库（03 §8.3 步骤 5：P5 若 router 产生
 * candidate，在同一 final 事务内重新计算 context/构造 payload/插入 proposal
 * + action.proposed 事件 + assistant message action_ref）。与 API 菜单路径
 * createCompanionMenuProposal 同构，但运行在 worker 的 run final 事务内，
 * conversation/run 已存在，不新建对话。
 *
 * 支持 intent：resume_current / start_short（有学习副作用的两种）。
 * open_review / open_current_card / open_star_map 为纯导航，本轮不构造
 * proposal（persona 文本已给出入口），保持与菜单路径能力对齐。
 *
 * 返回 proposalId 或 null（candidate 不可用/非支持 intent 时）。
 */
export async function constructActionProposalInWorker(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  runId: string;
  generation: number;
  accountEpoch: number;
  userMessageId: string;
  intent: string;
  /** §8.3：由调用方（run final 事务）统一分配的 event seq（action.proposed）。 */
  eventSeq: number;
  tx: {
    execute(query: unknown): Promise<{ [k: string]: unknown }[]>;
  };
}): Promise<{ proposalId: string; proposalPayload: Record<string, unknown>; payloadSha256: string; title: string; targetSummary: string; impactSummary: string; eventSeq: number } | null> {
  const { workspaceId, userId, conversationId, runId, generation, accountEpoch, userMessageId, intent } = args;
  const tx = args.tx;

  // 只支持有学习副作用的两种 action；其余回落文字。
  if (intent !== "resume_current" && intent !== "start_short") return null;

  // 重算候选（§8.3 步骤 5：重新计算 context 并精确匹配，失败零可见）。
  let payload: Record<string, unknown>;
  let title: string;
  let targetSummary: string;
  let impactSummary: string;
  if (intent === "resume_current") {
    const rows = await tx.execute(sql`
      SELECT s.id, s.intent
      FROM learning_sessions s
      WHERE s.workspace_id = ${workspaceId}
        AND s.user_id = ${userId}
        AND s.status = 'active'
      ORDER BY s.created_at DESC LIMIT 1
    `);
    const session = rows[0] as { id: string; intent: string | null } | undefined;
    if (!session) return null;
    const claim = sanitizeProposalText(session.intent ?? "", 80) || "继续当前学习";
    title = claim;
    targetSummary = `继续学习：${claim}`;
    impactSummary = "完成后更新学习进度";
    payload = { kind: "resume_session", sessionId: session.id };
  } else {
    // V2: key_point_id is now an alias for objective_id;
    // card_id from learning_cards_v2; claim → objective_statement from
    // learning_objective_revisions_v2.
    const rows = await tx.execute(sql`
      SELECT e.key_point_id AS key_point_id,
             c.card_id AS card_id,
             rev.objective_statement AS claim
      FROM learning_episodes e
      JOIN learning_objectives_v2 o ON o.objective_id = e.key_point_id
      JOIN learning_objective_revisions_v2 rev ON rev.objective_revision_id = o.current_objective_revision_id
      LEFT JOIN learning_cards_v2 c ON c.objective_id = e.key_point_id
        AND c.workspace_id = ${workspaceId}
      WHERE e.workspace_id = ${workspaceId}
        AND e.user_id = ${userId}
        AND o.workspace_id = ${workspaceId}
      ORDER BY e.created_at DESC LIMIT 1
    `);
    const candidate = rows[0] as { key_point_id: string; card_id: string; claim: string | null } | undefined;
    if (!candidate) return null;
    const claim = sanitizeProposalText(candidate.claim ?? "", 80) || "开始一小段学习";
    title = claim;
    targetSummary = `开始学习：${claim}`;
    impactSummary = "完成后更新学习进度";
    payload = {
      kind: "start_session",
      origin: "now",
      cardId: candidate.card_id,
      keyPointId: candidate.key_point_id,
    };
  }
  const payloadSha256 = sha256Hex(canonicalJsonV1(payload));

  // 幂等 fence：同 conversation 已有 pending proposal（含已过期未回收的）则跳过。
  // §6.6 单一 pending 由部分唯一索引强制；旧过期 pending 若不回收会阻塞新
  // proposal（唯一索引冲突），因此先原子回收过期 pending，再检查仍存在的。
  // 回收时写 action.expired 事件（与 API 侧 appendActionExpiredEvent 对齐），
  // 否则客户端仍展示旧 proposal 卡片，且事件流出现无声状态跃迁。
  const expired = (await tx.execute(sql`
    UPDATE companion_action_proposals
    SET status = 'expired', updated_at = now()
    WHERE conversation_id = ${conversationId} AND status = 'pending'
      AND expires_at < now()
    RETURNING id, conversation_id
  `)) as unknown as Array<{ id: string; conversation_id: string }>;
  for (const row of expired) {
    const expiredCounters = (await tx.execute(sql`
      UPDATE companion_conversations SET next_event_seq = next_event_seq + 1
      WHERE id = ${conversationId}
      RETURNING next_event_seq
    `)) as unknown as Array<{ next_event_seq: string }>;
    const expiredSeq = Number(expiredCounters[0]?.next_event_seq ?? 0) - 1;
    await tx.execute(sql`
      INSERT INTO companion_stream_events
        (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
         type, payload, expires_at)
      VALUES
        (${conversationId}, ${expiredSeq}, ${workspaceId}, ${userId}, ${runId}, ${generation},
         ${accountEpoch}, 'action.expired', ${JSON.stringify({ proposalId: row.id })},
         now() + interval '24 hours')
    `);
  }
  const existing = await tx.execute(sql`
    SELECT p.id FROM companion_action_proposals p
    WHERE p.conversation_id = ${conversationId} AND p.status = 'pending'
    LIMIT 1
  `);
  if (existing[0]) return null;

  const proposalId = randomUUID();
  // §8.3：event seq 由调用方（run final 事务）统一分配并预留，这里只消费传入
  // 的 eventSeq，避免与 final/delta/segment 事件 seq 冲突。
  const eventSeq = args.eventSeq;
  // idempotency_key_hash（0092 NOT NULL）：worker 侧确定性派生，同一 run 重试
  // 复用同一 key。实际重放保护由 run-status fence + single-pending 检查 + 部分
  // 唯一索引提供（无 idempotency_key_hash 唯一索引；同 final 事务内不会重复插入）。
  const idempotencyKeyHash = sha256Hex(`router:${runId}:${generation}`);

  await tx.execute(sql`
    INSERT INTO companion_action_proposals
      (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
       payload, payload_sha256, title, target_summary, impact_summary, status,
       idempotency_key_hash, expires_at)
    VALUES
      (${proposalId}, ${workspaceId}, ${userId}, ${conversationId}, ${userMessageId}, ${generation},
       ${JSON.stringify(payload)}, ${payloadSha256},
       ${title.slice(0, 80)}, ${targetSummary.slice(0, 160)}, ${impactSummary.slice(0, 160)}, 'pending',
       ${idempotencyKeyHash}, now() + interval '5 minutes')
  `);

  const eventPayload = {
    proposal: {
      version: 1,
      id: proposalId,
      workspaceId,
      conversationId,
      sourceMessageId: userMessageId,
      sourceGeneration: generation,
      kind: payload,
      payloadSha256,
      title,
      targetSummary,
      impactSummary,
      status: "pending",
    },
  };
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
    VALUES
      (${conversationId}, ${eventSeq}, ${workspaceId}, ${userId}, ${runId}, ${generation},
       ${accountEpoch}, 'action.proposed', ${JSON.stringify(eventPayload)},
       now() + interval '24 hours')
  `);

  return {
    proposalId,
    proposalPayload: payload,
    payloadSha256,
    title,
    targetSummary,
    impactSummary,
    eventSeq,
  };
}

function sanitizeProposalText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * 读回 run row 已冻结的 router decision（§9.4 retry 复用；persist 返回 false
 * 时调用，避免重新分类导致 decision 与已落库 proposal 分歧）。
 */
export async function readStoredRouterIntent(args: {
  runId: string;
  workspaceId: string;
  userId: string;
  generation: number;
}): Promise<RouterDecisionV1 | null> {
  const { runId, workspaceId, userId, generation } = args;
  return withWorkerWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const rows = await tx.execute<{
        router_intent: string | null;
        router_confidence: number | null;
        router_prompt_version: string | null;
        router_prompt_hash: string | null;
      }>(sql`
        SELECT router_intent, router_confidence, router_prompt_version, router_prompt_hash
        FROM companion_turn_runs
        WHERE id = ${runId} AND generation = ${generation}
          AND workspace_id = ${workspaceId} AND user_id = ${userId}
        LIMIT 1
      `);
      const row = rows[0] as
        | { router_intent: string | null; router_confidence: number | null; router_prompt_version: string | null; router_prompt_hash: string | null }
        | undefined;
      if (!row?.router_intent) return null;
      return {
        intent: row.router_intent as RouterDecisionV1["intent"],
        confidenceBps: row.router_confidence ?? 0,
        promptVersion: row.router_prompt_version ?? "companion-action-router-v1",
        promptHash: row.router_prompt_hash ?? COMPANION_ACTION_ROUTER_V1_SHA256,
      };
    },
  );
}

/**
 * 把 router decision 写入 run row（§9.4：worker 以 run row lock 只写一次；
 * retry 时字段已存在必须复用并重新验证，不得重新分类）。
 * 返回是否本次新写入。
 */
export async function persistRouterDecision(
  args: {
    runId: string;
    workspaceId: string;
    userId: string;
    generation: number;
    decision: RouterDecisionV1;
    contextRevision: string | null;
    payloadHash: string | null;
  },
): Promise<boolean> {
  const { runId, workspaceId, userId, generation, decision } = args;
  return withWorkerWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const existing = await tx.execute<{ router_intent: string | null }>(sql`
        SELECT router_intent FROM companion_turn_runs
        WHERE id = ${runId} AND generation = ${generation}
          AND workspace_id = ${workspaceId} AND user_id = ${userId}
        FOR UPDATE
      `);
      const row = existing[0];
      if (!row) return false;
      if (row.router_intent !== null) return false; // retry 复用，不重新分类
      await tx.execute(sql`
        UPDATE companion_turn_runs
        SET router_intent = ${decision.intent},
            router_confidence = ${decision.confidenceBps},
            router_prompt_version = ${decision.promptVersion},
            router_prompt_hash = ${decision.promptHash},
            router_context_revision = ${args.contextRevision},
            router_payload_hash = ${args.payloadHash},
            updated_at = now()
        WHERE id = ${runId} AND generation = ${generation}
      `);
      return true;
    },
  );
}
