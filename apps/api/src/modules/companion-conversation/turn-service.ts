/**
 * P2 — companion turn create（03 §8.1 原子流程）。
 *
 * 同一 RLS transaction：lock conversation → 校验 owner/workspace →
 * 幂等（key hash / clientMessageId）→ active run 规则（supersedesGeneration）→
 * 分配 seq/generation → 插入 user message → auto title → 插入 turn run →
 * 插入 companion_agent job → 更新 counters → 写 turn.accepted event。
 * 任一步失败全部回滚，返回 202。
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { createJob } from "../job/service.ts";
import { type CompanionGroundedTutorGrantV1 } from "@ailearn/shared";
import { DomainError } from "@ailearn/shared";
import { sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { canonicalJsonV1 } from "@ailearn/shared/content-hash";
import {
  createCompanionTurnRequestV1Schema,
  createCompanionTurnResponseV1Schema,
  type CompanionPublicErrorCodeV1,
  type CreateCompanionTurnRequestV1,
} from "@ailearn/shared";
import { resolveAuthSurfaceManifestSecret } from "../companion-shell/auth-surface.ts";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";
import { reclaimExpiredCompanionProposals, invalidateSupersededRunProposals } from "./companion-proposal-expiry.ts";
import {
  contextRevisionForCompanionLearningRun,
  isCompanionLearningRunTutorEligible,
  loadCompanionLearningRunContext,
} from "./learning-run-context.ts";
import {
  companionConversations,
  companionMessages,
  companionStreamEvents,
  companionTurnRuns,
} from "@ailearn/shared/db-schema/companion-conversations";

export {
  companionConversations,
  companionMessages,
  companionStreamEvents,
  companionTurnRuns,
};

export class CompanionConversationError extends DomainError {
  constructor(
    public readonly code: CompanionPublicErrorCodeV1,
    public readonly statusCode: number,
    message: string,
  ) {
    super({ name: "CompanionConversationError", code, message, statusCode });
  }
}

/** 用户消息文本上限（P2 §6.10：server hard max 20,000 code unit）。 */
const HARD_MAX_CHARS = 20_000;

function textOfBlocks(blocks: CreateCompanionTurnRequestV1["blocks"]): string {
  const first = blocks[0];
  return first?.type === "text" ? first.text : "";
}

/** 计算持久化 page context：只保存 grant 的 opaque 元数据，不保存签名。 */
function sanitizeContext(request: CreateCompanionTurnRequestV1): unknown {
  if (!request.context && !request.selection) return null;
  // 划选/拖拽投喂（2026-09-18）：selection 与 context 同 jsonb 持久化，
  // worker parsePageContext 读取后以 <selection_data> 注入 prompt。
  const selection = request.selection
    ? { text: request.selection.text, sharing: request.selection.sharing }
    : null;
  if (!request.context) return { version: 1, context: null, selection };
  const ctx = request.context;
  const base = {
    pageKind: ctx.pageKind,
    sharing: ctx.sharing,
    // 非学习运行页渲染层不携带 revision（契约 optional），落库存 null。
    contextRevision: ctx.contextRevision ?? null,
  };
  switch (ctx.pageKind) {
    case "today":
      return { version: 1, context: { ...base }, ...(selection ? { selection } : {}) };
    case "review":
      return { version: 1, context: { ...base, cardId: ctx.cardId ?? null, keyPointId: ctx.keyPointId ?? null }, ...(selection ? { selection } : {}) };
    case "card":
      return { version: 1, context: { ...base, cardId: ctx.cardId, keyPointId: ctx.keyPointId ?? null }, ...(selection ? { selection } : {}) };
    case "star_map":
      return { version: 1, context: { ...base, keyPointId: ctx.keyPointId ?? null }, ...(selection ? { selection } : {}) };
    case "learning_run":
      return {
        version: 1,
        context: {
          ...base,
          runId: ctx.runId,
          snapshotId: ctx.snapshotId,
          taskId: ctx.taskId,
          requestedCapability: ctx.requestedCapability,
          groundedTutorGrant: ctx.groundedTutorGrant === null
            ? null
            : {
              grantId: ctx.groundedTutorGrant.grantId,
              permissionSnapshotHash: ctx.groundedTutorGrant.permissionSnapshotHash,
              expiresAt: ctx.groundedTutorGrant.expiresAt,
            },
        },
        ...(selection ? { selection } : {}),
      };
  }
}

function grantHmacSecret(): string {
  const configured = resolveAuthSurfaceManifestSecret();
  if (configured) return configured;
  // fail-closed：任何环境未配置 AUTH_SURFACE_MANIFEST_SECRET 都拒绝签发 grant。
  // 已移除公开常量回退（"companion-dev-grant-secret" 可被伪造签名，绕过
  // "仅学习页可签发 grant" 的控制与一次性消费）。dev 由 docker-compose.dev.yml
  // 显式配置 dev 密钥；staging/生产未配置 → 503，宁可功能不可用也不降级安全。
  throw new CompanionConversationError(
    "INTERNAL_ERROR", 503, "companion grant signing is not configured",
  );
}

function rejectGroundedTutorGrant(message: string): never {
  throw new CompanionConversationError("ACTION_STALE", 409, message);
}

function verifyGrantSignature(grant: CompanionGroundedTutorGrantV1): void {
  const { signature, ...payload } = grant;
  const expected = createHmac("sha256", grantHmacSecret())
    .update(`companion-grounded-tutor-grant-v1:${canonicalJsonV1(payload)}`)
    .digest("hex");
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(signature, "hex");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    rejectGroundedTutorGrant("grounded tutor grant signature invalid");
  }
}

/** 在 turn 原子事务内重查 LearningRun 页面关系，并以 unique grant id 消费。 */
async function validateGroundedTutorGrant(
  tx: ApiTransaction,
  request: CreateCompanionTurnRequestV1,
  scope: { workspaceId: string; userId: string },
): Promise<string | null> {
  const context = request.context;
  if (!context || context.pageKind !== "learning_run") return null;
  if (context.requestedCapability === "none") return null;
  const grant = context.groundedTutorGrant;
  if (grant === null) rejectGroundedTutorGrant("grounded tutor grant missing");

  if (grant.userId !== scope.userId || grant.workspaceId !== scope.workspaceId || grant.contextRevision !== context.contextRevision) {
    rejectGroundedTutorGrant("grounded tutor grant scope or context mismatch");
  }
  const now = Date.now();
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now || expiresAt < now) {
    rejectGroundedTutorGrant("grounded tutor grant expired or not yet valid");
  }
  verifyGrantSignature(grant);

  // PostgreSQL advisory lock serializes two concurrent turn requests carrying the
  // same HMAC grant before the partial unique index is reached.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${grant.grantId}, 0))`);
  const consumed = await tx.execute<{ id: string }>(sql`
    SELECT id
    FROM companion_turn_runs
    WHERE context_grant_id = ${grant.grantId}
    LIMIT 1
  `);
  if (consumed[0]) rejectGroundedTutorGrant("grounded tutor grant already consumed");

  if (
    grant.pageKind !== "learning_run"
    || grant.runId !== context.runId
    || grant.snapshotId !== context.snapshotId
    || grant.taskId !== context.taskId
  ) {
    rejectGroundedTutorGrant("grounded tutor grant scope or context mismatch");
  }
  const current = await loadCompanionLearningRunContext(tx, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    runId: context.runId,
  });
  if (!current) rejectGroundedTutorGrant("learning run context not found");
  if (
    !isCompanionLearningRunTutorEligible(current)
    || current.snapshotId !== context.snapshotId
    || current.taskId !== context.taskId
    || contextRevisionForCompanionLearningRun(current) !== context.contextRevision
  ) {
    rejectGroundedTutorGrant("learning run context is stale or no longer eligible");
  }
  return grant.grantId;
}

function eventRow(
  tx: ApiTransaction,
  args: {
    conversationId: string;
    workspaceId: string;
    userId: string;
    seq: number;
    runId: string;
    generation: number;
    type: "turn.accepted" | "turn.cancelled";
    payload: unknown;
    /** 事件 TTL 小时数；null = 非终态事件用 infinity（§7.4 line 1276）。 */
    ttlHours: number | null;
    /** L11：事件发生时的账号世代（surface_epoch）。 */
    accountEpoch: number;
  },
) {
  // 用 raw SQL 而非 drizzle insert：JS Date 无法表示 Postgres infinity
  // （new Date("infinity") 是 Invalid Date），必须用 SQL 字面量。
  // 注意 drizzle 会把 ${null} 渲染成 NULL 字面量（不占参数位），因此
  // 不能用 CASE WHEN ${args.ttlHours} IS NULL 的形式——嵌套 sql 片段。
  const expiresAtExpr = args.ttlHours === null
    ? sql`'infinity'::timestamptz`
    : sql`now() + make_interval(hours => ${args.ttlHours})`;
  return tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
       type, payload, expires_at)
    VALUES
      (${args.conversationId}, ${args.seq}, ${args.workspaceId}, ${args.userId},
       ${args.runId}, ${args.generation}, ${args.accountEpoch}, ${args.type},
       ${JSON.stringify(args.payload)},
       ${expiresAtExpr})
  `);
}

export async function createCompanionTurn(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  idempotencyKey: string;
  body: unknown;
}): Promise<{ statusCode: number; body: unknown }> {
  const parsed = createCompanionTurnRequestV1Schema.safeParse(args.body);
  if (!parsed.success) {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "turn request schema invalid");
  }
  const request = parsed.data;

  // body hash：canonical JSON（不含 Idempotency-Key header），用于幂等比对。
  const requestBodyHash = sha256Utf8V1(canonicalJsonV1(request));
  const idempotencyKeyHash = sha256Utf8V1(args.idempotencyKey.toLowerCase());

  const text = textOfBlocks(request.blocks);
  if (text.length > HARD_MAX_CHARS) {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "text exceeds server hard limit");
  }

  return withWorkspaceTransaction({ workspaceId: args.workspaceId, userId: args.userId }, async (tx) => {
    const conversationRows = await tx
      .select()
      .from(companionConversations)
      .where(eq(companionConversations.id, args.conversationId))
      .limit(1)
      .for("update");
    const conversation = conversationRows[0];
    if (!conversation) {
      throw new CompanionConversationError("NOT_FOUND", 404, "conversation not found");
    }
    // RLS 已保证 scope；双保险校验 owner
    if (conversation.workspaceId !== args.workspaceId || conversation.userId !== args.userId) {
      throw new CompanionConversationError("FORBIDDEN", 403, "conversation scope mismatch");
    }

    // Agent 方案 §5：确认过期后必须先把挂起的 run 置为终态，再判 active run。
    // 顺序不能反——等待确认的 run 仍是 active（partial unique index 覆盖
    // waiting_for_confirmation），先判 active 会让用户在 5min 确认 TTL 过后
    // 永远收到 409 RUN_ALREADY_ACTIVE：既不能确认、也不能继续对话。
    await reclaimExpiredCompanionProposals(tx, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      conversationId: args.conversationId,
    });

    // 幂等：同 key 或同 clientMessageId + 同 body hash → 返回原 run
    const existingByKey = await tx
      .select()
      .from(companionTurnRuns)
      .where(and(
        eq(companionTurnRuns.conversationId, args.conversationId),
        eq(companionTurnRuns.idempotencyKeyHash, idempotencyKeyHash),
      ))
      .limit(1);
    if (existingByKey[0]) {
      if (existingByKey[0].requestBodyHash !== requestBodyHash) {
        throw new CompanionConversationError("IDEMPOTENCY_CONFLICT", 409, "same key, different body");
      }
      const body = createCompanionTurnResponseV1Schema.parse({
        version: 1,
        conversationId: args.conversationId,
        clientMessageId: request.clientMessageId,
        userMessageId: existingByKey[0].userMessageId,
        runId: existingByKey[0].id,
        generation: existingByKey[0].generation,
        // §6.3：幂等重放返回真实状态（schema 已含 running）。cancel_requested
        // 是取消中间态，客户端应继续挂 SSE 观察终态事件，映射为 running。
        status: existingByKey[0].status === "cancel_requested"
          ? "running"
          : existingByKey[0].status,
        eventCursor: existingByKey[0].lastEventSeq,
      });
      return { statusCode: 200, body };
    }

    // clientMessageId 幂等：同 conversation + clientMessageId 需查 user message
    const clientMessageRows = await tx
      .select()
      .from(companionMessages)
      .where(and(
        eq(companionMessages.conversationId, args.conversationId),
        eq(companionMessages.clientMessageId, request.clientMessageId),
      ))
      .limit(1);
    if (clientMessageRows[0]) {
      const runOfMessage = await tx
        .select()
        .from(companionTurnRuns)
        .where(eq(companionTurnRuns.userMessageId, clientMessageRows[0].id))
        .limit(1);
      if (runOfMessage[0]) {
        if (runOfMessage[0].requestBodyHash !== requestBodyHash) {
          throw new CompanionConversationError("IDEMPOTENCY_CONFLICT", 409, "same clientMessageId, different body");
        }
        const body = createCompanionTurnResponseV1Schema.parse({
          version: 1,
          conversationId: args.conversationId,
          clientMessageId: request.clientMessageId,
          userMessageId: runOfMessage[0].userMessageId,
          runId: runOfMessage[0].id,
          generation: runOfMessage[0].generation,
          status: runOfMessage[0].status === "succeeded" || runOfMessage[0].status === "cancelled"
            || runOfMessage[0].status === "failed" || runOfMessage[0].status === "superseded"
            ? runOfMessage[0].status
            : "accepted",
          eventCursor: runOfMessage[0].lastEventSeq,
        });
        return { statusCode: 200, body };
      }
    }

    // active run 规则（partial unique 保证至多一条 active；SQL 过滤避免
    // 拉取该 conversation 全部 run 行——L6）
    const activeRows = await tx
      .select({ id: companionTurnRuns.id, generation: companionTurnRuns.generation })
      .from(companionTurnRuns)
      .where(and(
        eq(companionTurnRuns.conversationId, args.conversationId),
        sql`${companionTurnRuns.status} IN ('accepted', 'running', 'waiting_for_confirmation', 'cancel_requested')`,
      ))
      .limit(1);
    const activeRun = activeRows[0] ?? null;
    let supersededRunId: string | null = null;
    if (activeRun) {
      if (request.supersedesGeneration !== activeRun.generation) {
        throw new CompanionConversationError("RUN_ALREADY_ACTIVE", 409, "active run requires matching supersedesGeneration");
      }
      // 旧 run → superseded，先写 turn.cancelled
      await tx
        .update(companionTurnRuns)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(eq(companionTurnRuns.id, activeRun.id));
      // 被取代的 run 可能停在 waiting_for_confirmation 并带一个可确认的 Agent
      // proposal。不作废它，用户之后点确认会通过 epoch/active 校验真正执行副作用，
      // 而 continuation 阶段因 run 已非 waiting 而放弃 → 动作生效却无人回填结果。
      // 与 cancel 一致先行作废（proposal → expired、工具调用 → expired）。
      await invalidateSupersededRunProposals(tx, { runId: activeRun.id });
      supersededRunId = activeRun.id;
    } else if (request.supersedesGeneration !== undefined) {
      const latestRun = await tx
        .select({ generation: companionTurnRuns.generation })
        .from(companionTurnRuns)
        .where(eq(companionTurnRuns.conversationId, args.conversationId))
        .orderBy(sql`${companionTurnRuns.generation} DESC`)
        .limit(1);
      if (request.supersedesGeneration !== (latestRun[0]?.generation ?? 0)) {
        throw new CompanionConversationError("STALE_GENERATION", 409, "supersedesGeneration mismatch");
      }
    }

    // §11.2 voice provenance：turn 事务内 FOR UPDATE 校验 pending artifact（scope/status/expiry/hash）
    let voiceArtifactId: string | null = null;
    if (request.inputKind === "voice_transcript" && request.voiceArtifactId) {
      const artifactRows = await tx.execute<{
        id: string; status: string; transcript_sha256: string; expires_at: Date;
      }>(sql`
        SELECT id, status, transcript_sha256, expires_at
        FROM companion_voice_artifacts
        WHERE id = ${request.voiceArtifactId}
        FOR UPDATE
      `);
      const artifact = artifactRows[0];
      if (!artifact) {
        throw new CompanionConversationError("NOT_FOUND", 404, "voice artifact not found");
      }
      if (artifact.status !== "pending") {
        throw new CompanionConversationError(
          "IDEMPOTENCY_CONFLICT", 409, "voice artifact already bound",
        );
      }
      if (new Date(artifact.expires_at).getTime() < Date.now()) {
        throw new CompanionConversationError(
          "IDEMPOTENCY_CONFLICT", 409, "voice artifact expired",
        );
      }
      // transcript hash 与唯一 text block 精确相等（§11.2：transcriptSha256 是对
      // transcript 裸文本的 hash，见 §11.2 响应）
      const textBlocks = (request.blocks as { type: string; text?: string }[]).filter(
        (b) => b.type === "text",
      );
      if (textBlocks.length !== 1) {
        throw new CompanionConversationError(
          "INVALID_REQUEST", 400, "voice transcript must be a single text block",
        );
      }
      const transcriptSha256 = sha256Utf8V1(textBlocks[0].text ?? "");
      if (transcriptSha256 !== artifact.transcript_sha256) {
        throw new CompanionConversationError(
          "INVALID_REQUEST", 400, "voice transcript hash mismatch",
        );
      }
      voiceArtifactId = artifact.id;
    }

    // P5 grounded tutor：所有授权字段都在写入前于同一事务重查并原子消费。
    const contextGrantId = await validateGroundedTutorGrant(
      tx,
      request,
      { workspaceId: args.workspaceId, userId: args.userId },
    );

    // 分配 seq/generation（原子自增）：UPDATE ... RETURNING 返回的是递增后的值，
    // 当前 turn 的 generation 应为递增前的旧值（首个 turn = 1）。
    const counters = await tx
      .update(companionConversations)
      .set({
        nextMessageSeq: sql`${companionConversations.nextMessageSeq} + 1`,
        nextEventSeq: sql`${companionConversations.nextEventSeq} + 1`,
        nextGeneration: sql`${companionConversations.nextGeneration} + 1`,
      })
      .where(eq(companionConversations.id, args.conversationId))
      .returning();
    const next = counters[0];
    if (!next) {
      throw new CompanionConversationError("NOT_FOUND", 404, "conversation not found");
    }
    const messageSeq = next.nextMessageSeq - 1;
    const eventSeq = next.nextEventSeq - 1;
    const generation = next.nextGeneration - 1;

    // 插入 user message
    const contentSha256 = sha256Utf8V1(canonicalJsonV1(request.blocks));
    const userMessage = await tx
      .insert(companionMessages)
      .values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        userId: args.userId,
        conversationId: args.conversationId,
        seq: messageSeq,
        role: "user",
        kind: request.inputKind === "voice_transcript" ? "voice_transcript" : "text",
        blocks: request.blocks as never,
        runId: null,
        clientMessageId: request.clientMessageId,
        contentSha256,
      })
      .returning();
    const insertedUserMessage = userMessage[0];
    if (voiceArtifactId) {
      if (!insertedUserMessage) {
        throw new CompanionConversationError("INTERNAL_ERROR", 500, "user message insert failed");
      }
      await tx.execute(sql`
        UPDATE companion_voice_artifacts
        SET status = 'attached',
            conversation_id = ${args.conversationId},
            message_id = ${insertedUserMessage.id},
            attached_at = now()
        WHERE id = ${voiceArtifactId}
      `);
    }

    // auto title（placeholder + 首条 message）
    let title = conversation.title;
    let titleSource = conversation.titleSource;
    if (conversation.titleSource === "placeholder" && messageSeq === 1) {
      // 03 §6.1：auto title 取前 32 个 Unicode code point（非 UTF-16 code unit），
      // 先去控制字符并折叠连续空白。
      const normalized = text
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const chars = Array.from(normalized);
      const t = chars.length > 32 ? `${chars.slice(0, 32).join("")}…` : normalized;
      title = t.length > 0 ? t : "新对话";
      titleSource = "auto";
    }

    const runId = randomUUID();
    // L11：run 创建时冻结当前账号世代（user_companion_account_state.epoch）。
    // worker 产出的事件与该 run 后续的 cancel/action 事件都携带此 epoch，
    // 客户端据此拒绝 global off 之前的迟到事件。
    const accountEpoch = await getCompanionAccountEpoch(tx, args.userId);
    const job = await createJob({
      workspaceId: args.workspaceId,
      requestedBy: args.userId,
      type: "companion_agent",
      dedupe: { payloadField: "runId", value: runId },
      // runbook 6.4 步骤 5：payload 只传 opaque ID；worker 从 DB 读
      // conversation/user/generation/page_context（RLS context 内）。
      payload: {
        runId,
      },
    });

    const now = new Date();
    await tx
      .insert(companionTurnRuns)
      .values({
        id: runId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        conversationId: args.conversationId,
        userMessageId: userMessage[0].id,
        assistantMessageId: null,
        jobId: job.id,
        generation,
        status: "accepted",
        idempotencyKeyHash,
        requestBodyHash,
        accountEpoch,
        pageContext: sanitizeContext(request) as never,
        contextGrantId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (supersededRunId) {
      // 旧 run 的 turn.cancelled（superseded）使用旧 run 的 seq 之前——按 §8.1
      // 顺序：旧 run 置 superseded 后先写其 cancelled event，再分配新 event seq。
      // 简化：P2 在提交新 turn 前补写 cancelled（用分配前的 eventSeq-1 不可靠，
      // 因此这里使用新事务的 eventSeq，顺序在新 accepted 之前由 seq 保证）。
      // 更精确做法：先读旧 run 的 lastEventSeq+1 作为 cancelled seq。此处采用
      // 事务内先写 cancelled（seq = eventSeq），accepted 使用 eventSeq+1。
      await eventRow(tx, {
        conversationId: args.conversationId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        seq: eventSeq,
        runId: supersededRunId,
        generation: activeRun?.generation ?? 1,
        type: "turn.cancelled",
        payload: { reason: "superseded" },
        ttlHours: 24,
        accountEpoch,
      });
      await tx
        .update(companionTurnRuns)
        .set({ lastEventSeq: eventSeq })
        .where(eq(companionTurnRuns.id, supersededRunId));
      await tx
        .update(companionConversations)
        .set({ nextEventSeq: sql`${companionConversations.nextEventSeq} + 1` })
        .where(eq(companionConversations.id, args.conversationId));
    }

    const acceptedSeq = supersededRunId ? eventSeq + 1 : eventSeq;
    await eventRow(tx, {
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      userId: args.userId,
      seq: acceptedSeq,
      runId,
      generation,
      type: "turn.accepted",
      payload: { clientMessageId: request.clientMessageId, userMessageId: userMessage[0].id, status: "accepted" },
      // 非终态：run 终态时 worker 会改为 finished_at+24h。
      ttlHours: null,
      accountEpoch,
    });
    await tx
      .update(companionTurnRuns)
      .set({ lastEventSeq: acceptedSeq })
      .where(eq(companionTurnRuns.id, runId));

    // 更新 conversation 状态/title/lastMessageAt
    await tx
      .update(companionConversations)
      .set({
        title,
        titleSource: titleSource as "placeholder" | "auto" | "user" | "system",
        lastMessageAt: now,
        updatedAt: now,
      })
      .where(eq(companionConversations.id, args.conversationId));

    const responseBody = createCompanionTurnResponseV1Schema.parse({
      version: 1,
      conversationId: args.conversationId,
      clientMessageId: request.clientMessageId,
      userMessageId: userMessage[0].id,
      runId,
      generation,
      status: "accepted",
      eventCursor: acceptedSeq,
    });
    return { statusCode: 202, body: responseBody };
  });
}
