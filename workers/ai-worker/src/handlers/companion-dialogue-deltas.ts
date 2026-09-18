/**
 * Companion 对话 delta 写库管线。
 *
 * Agent 运行时（companion-agent-runtime.ts）拿到的是**完整**最终答复，不再有
 * provider 逐增量流：writeBatchedDeltas 按批分块写 assistant.delta，保留
 * fence + 数量级幂等续写语义，并在批次间保留 50ms 节流。
 *
 * fence 语义：run 被 cancel/supersede → 停止写入并返回 false；重试 fail-closed：
 * 发现已写 delta 数与批次起点不一致 → 抛错，不拼接错乱内容。
 */

import { sql } from "drizzle-orm";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { chunkTextIntoDeltas } from "./companion-dialogue-content.ts";
import type { ReadContext } from "./companion-dialogue-store.ts";

interface BatchedDeltasArgs {
  assistantText: string;
  ctx: { workspaceId: string };
  read: ReadContext;
  expiresAt: string;
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
}

/** 全文取回后按 256-code-unit 分块、每事务 4 块批量写 delta。 */
export async function writeBatchedDeltas(args: BatchedDeltasArgs): Promise<boolean> {
  const { assistantText, ctx, read, expiresAt, notifyCompanionEvent } = args;
  const streamDeltas = chunkTextIntoDeltas(assistantText, 256);
  // 每事务批量写入多个 delta，减少事务/DB round-trip 开销；
  // 保留 fence + 数量级幂等续写语义，并在批次间保留 50ms 节流。
  const DELTAS_PER_TX = 4;
  for (let i = 0; i < streamDeltas.length; i += DELTAS_PER_TX) {
    const batch = streamDeltas.slice(i, i + DELTAS_PER_TX);
    const written = await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: read.userId },
      async (tx) => {
        const alive = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'running', updated_at = now()
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
            AND generation = ${read.generation}
          RETURNING id
        `);
        if (!alive[0]) return false;
        const countRows = await tx.execute<{ n: string }>(sql`
          SELECT count(*)::int AS n FROM companion_stream_events
          WHERE conversation_id = ${read.conversationId}
            AND run_id = ${read.runId} AND type = 'assistant.delta'
        `);
        const writtenDeltaCount = Number(countRows[0].n);
        if (writtenDeltaCount >= streamDeltas.length) return true;
        if (writtenDeltaCount !== i) {
          throw new Error(`companion delta stream desync: written=${writtenDeltaCount} expected=${i}`);
        }
        // 一次性递增 next_event_seq 为整个批次分配连续 seq
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + ${batch.length}
          WHERE id = ${read.conversationId}
          RETURNING next_event_seq
        `);
        const endSeq = Number(counters[0].next_event_seq) - 1;
        const startSeq = endSeq - batch.length + 1;
        // 多行批量 INSERT
        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES ${sql.join(batch.map((delta, j) => sql`(
            ${read.conversationId}, ${startSeq + j}, ${ctx.workspaceId}, ${read.userId},
            ${read.runId}, ${read.generation}, ${read.accountEpoch}, 'assistant.delta',
            ${JSON.stringify(delta)}, ${expiresAt}
          )`), sql`, `)}
        `);
        // 批次内事件已全部落库，只需在批尾通知一次 maxSeq——消费端按
        // maxSeq 增量拉取，逐条 NOTIFY 只是对同一行的重复 UPDATE + 重复消息。
        await notifyCompanionEvent(tx, endSeq);
        return true;
      },
    );
    if (!written) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
