/**
 * P2 companion cancel（03 §8.2 / §6.5）。
 *
 * POST /companion/runs/:id/cancel：
 * - 仅 active（accepted/running/waiting_for_confirmation/cancel_requested）run 可取消；终态 run 幂等返回 200；
 * - 原子：run → cancelled（finished_at）+ turn.cancelled event（reason=user）+
 *   该 run 全部 event expires 改终态+24h + NOTIFY；
 * - Worker 侧 fence 保证 cancel 后迟到 delta/final 零写入。
 */

import { eq, and, inArray, sql } from "drizzle-orm";
import {
  companionTurnRuns,
  companionConversations,
  companionStreamEvents,
  CompanionConversationError,
} from "./turn-service.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  cancelCompanionRunRequestV1Schema,
  cancelCompanionRunResponseV1Schema,
  type CompanionRunStatusV1,
} from "@ailearn/shared";

export interface CancelCompanionRunResult {
  statusCode: number;
  body: {
    version: 1;
    conversationId: string;
    runId: string;
    generation: number;
    status: CompanionRunStatusV1;
    eventCursor: number;
  };
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "superseded"] as const;

export async function cancelCompanionRun(args: {
  workspaceId: string;
  userId: string;
  runId: string;
  body: unknown;
}): Promise<CancelCompanionRunResult> {
  const request = cancelCompanionRunRequestV1Schema.safeParse(args.body);
  if (!request.success) {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "cancel request schema invalid");
  }
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const runRows = await tx
        .select({
          id: companionTurnRuns.id,
          conversationId: companionTurnRuns.conversationId,
          generation: companionTurnRuns.generation,
          status: companionTurnRuns.status,
          lastEventSeq: companionTurnRuns.lastEventSeq,
          workspaceId: companionTurnRuns.workspaceId,
          userId: companionTurnRuns.userId,
          accountEpoch: companionTurnRuns.accountEpoch,
        })
        .from(companionTurnRuns)
        .where(eq(companionTurnRuns.id, args.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) {
        throw new CompanionConversationError("NOT_FOUND", 404, "run not found");
      }
      if (run.workspaceId !== args.workspaceId || run.userId !== args.userId) {
        throw new CompanionConversationError("FORBIDDEN", 403, "run scope mismatch");
      }
      if (request.data.generation !== run.generation) {
        throw new CompanionConversationError("STALE_GENERATION", 409, "run generation mismatch");
      }

      // 幂等：终态 run 直接 200（不重复写事件）
      if (TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
        return {
          statusCode: 200,
          body: {
            version: 1 as const,
            conversationId: run.conversationId,
            runId: run.id,
            generation: run.generation,
            status: run.status as CompanionRunStatusV1,
            eventCursor: run.lastEventSeq,
          },
        };
      }

      // 原子取消（并发下 status 已变的 run 不重复处理）
      const updated = await tx
        .update(companionTurnRuns)
        .set({
          status: "cancelled",
          cancelRequestedAt: sql`COALESCE(${companionTurnRuns.cancelRequestedAt}, now())`,
          finishedAt: sql`now()`,
        })
        .where(and(
          eq(companionTurnRuns.id, args.runId),
          inArray(companionTurnRuns.status, ["accepted", "running", "waiting_for_confirmation", "cancel_requested"]),
        ))
        .returning({ id: companionTurnRuns.id });
      if (!updated[0]) {
        // 并发下状态已变（如刚 succeeded）——按幂等处理
        const currentRows = await tx
          .select({ status: companionTurnRuns.status, lastEventSeq: companionTurnRuns.lastEventSeq })
          .from(companionTurnRuns)
          .where(eq(companionTurnRuns.id, args.runId))
          .limit(1);
        const current = currentRows[0];
        return {
          statusCode: 200,
          body: {
            version: 1 as const,
            conversationId: run.conversationId,
            runId: run.id,
            generation: run.generation,
            status: (current?.status ?? run.status) as CompanionRunStatusV1,
            eventCursor: current?.lastEventSeq ?? run.lastEventSeq,
          },
        };
      }

      // A cancelled Agent run must invalidate its frozen proposal and audit
      // row. A later confirm therefore cannot resurrect or execute the action.
      await tx.execute(sql`
        UPDATE companion_agent_tool_calls
        SET status = 'expired', result_safe_summary = '运行已取消', updated_at = now()
        WHERE run_id = ${run.id}
          AND status IN ('requested', 'executing', 'waiting_confirmation')
      `);
      await tx.execute(sql`
        UPDATE companion_action_proposals
        SET status = 'expired', updated_at = now()
        WHERE agent_run_id = ${run.id} AND status = 'pending'
      `);

      // turn.cancelled event（reason=user，§5.2）
      const counters = await tx
        .update(companionConversations)
        .set({ nextEventSeq: sql`${companionConversations.nextEventSeq} + 1` })
        .where(eq(companionConversations.id, run.conversationId))
        .returning({ nextEventSeq: companionConversations.nextEventSeq });
      const next = counters[0];
      const eventSeq = next ? Number(next.nextEventSeq) - 1 : 0;
      const expiresAt = new Date(Date.now() + 24 * 3_600_000);
      await tx.insert(companionStreamEvents).values({
        conversationId: run.conversationId,
        seq: eventSeq,
        workspaceId: args.workspaceId,
        userId: args.userId,
        runId: run.id,
        generation: run.generation,
        accountEpoch: run.accountEpoch,
        type: "turn.cancelled",
        payload: { reason: "user" } as never,
        expiresAt,
      });
      await tx
        .update(companionTurnRuns)
        .set({ lastEventSeq: eventSeq })
        .where(eq(companionTurnRuns.id, run.id));
      await tx
        .update(companionStreamEvents)
        .set({ expiresAt })
        .where(and(
          eq(companionStreamEvents.conversationId, run.conversationId),
          eq(companionStreamEvents.runId, run.id),
        ));

      await tx.execute(sql`
        SELECT pg_notify('ailearn_companion_events_v1',
                         ${JSON.stringify({ conversationId: run.conversationId, maxSeq: eventSeq })})
      `);

      const body = {
        version: 1 as const,
        conversationId: run.conversationId,
        runId: run.id,
        generation: run.generation,
        status: "cancelled" as const,
        eventCursor: eventSeq,
      };
      cancelCompanionRunResponseV1Schema.parse(body);
      return {
        statusCode: 202,
        body,
      };
    },
  );
}
