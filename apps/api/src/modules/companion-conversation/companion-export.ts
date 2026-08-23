/**
 * P2 companion export（03 §12 NDJSON）。
 *
 * - GET /companion/export 以 application/x-ndjson 输出；
 * - manifest 首行、conversation/message（及 P2 空类别）升序、footer 末行；
 * - recordsSha256 对 manifest 至 footer 前一行止的原始 UTF-8 NDJSON bytes 计算；
 * - read-only repeatable-read RLS 事务；开始前确认无非终态 dialogue turn（409）；
 * - 不导出 stream event/delta、turn/provider/prompt 元数据、其他 workspace。
 */

import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  companionConversations,
  companionMessages,
  companionTurnRuns,
} from "./turn-service.ts";
import { db, setApiTransactionContext } from "../../db/client.ts";
import { logCompanionAudit } from "../companion-shell/audit-service.ts";
import { logger } from "../../lib/logger.ts";

export type ExportCompanionResult =
  | { ok: true; ndjson: string[] }
  | { ok: false; statusCode: number; code: string; message: string };

/** 流式导出结果：不含 ndjson 数组——行由 onLine 回调在产生时立即写出。 */
export type ExportCompanionStreamResult =
  | { ok: true; statusCode?: never; code?: never; message?: never }
  | { ok: false; statusCode: number; code: string; message: string };

const ACTIVE_RUN_STATUSES = "'accepted', 'running', 'cancel_requested'";

// N#7-11: 每个 record 类型的行数上限（对齐主导出的 EXPORT_MAX_ROWS 思想）。
// 命中上限时记告警并截断——导出仍成功返回，但超出部分不包含，规避超长历史用户
// 全量累积 ~2× 载荷（原始行 + 序列化串）导致的内存压力。
const COMPANION_EXPORT_MAX_ROWS = 50_000;

// §12 keyset 游标：proactive/action 三类 record 表统一按
// (conversation_id, created_at, id) 升序分页装载（与 conversations/messages
// 同理，避免大 scope 全量单查询占满连接缓冲）。
type RecordsCursor = { conversationId: string; createdAt: Date; id: string } | null;
function recordsKeysetWhere(cursor: RecordsCursor, table: string) {
  if (cursor === null) return sql`TRUE`;
  return sql`(${sql.raw(table)}.conversation_id, ${sql.raw(table)}.created_at, ${sql.raw(table)}.id)
             > (${cursor.conversationId}::uuid, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
}

/**
 * 流式导出（round-5 修复）：每一行 NDJSON 在装载后立即交给 onLine 写出，不再
 * 把整份输出累积进内存数组再返回。峰值内存被约束为「一页原始行 + 已写出行累
 * 计 SHA-256 摘要」（footer 仍最后一行，recordsSha256 语义与旧实现一致）。
 * 返回 { ok:true } 表示全部写出成功；{ ok:false } 携带错误状态（错误发生在任何
 * 行写出前，故调用方无需回滚已写出内容）。
 *
 * 兼容旧 API 的 exportCompanionData 保留为薄封装（供测试/内部直接调用累积数组）。
 */
export async function exportCompanionDataStream(
  args: { workspaceId: string; userId: string },
  onLine: (line: string) => void | Promise<void>,
): Promise<ExportCompanionStreamResult> {
  // read-only repeatable-read RLS transaction（§12 规则 4）；BEGIN 时设置隔离级别
  const result = await db.transaction<ExportCompanionStreamResult>(async (tx) => {
      // read-only 必须在事务第一条查询（set_config）之前设置
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await setApiTransactionContext(tx, { workspaceId: args.workspaceId, userId: args.userId });

      // 开始前确认当前 scope 无非终态 dialogue turn → 409
      const active = await tx
        .select({ id: companionTurnRuns.id })
        .from(companionTurnRuns)
        .where(sql`${companionTurnRuns.workspaceId} = ${args.workspaceId}
                   AND ${companionTurnRuns.userId} = ${args.userId}
                   AND ${companionTurnRuns.status} IN (${sql.raw(ACTIVE_RUN_STATUSES)})`)
        .limit(1);
      if (active[0]) {
        return {
          ok: false,
          statusCode: 409,
          code: "RUN_ALREADY_ACTIVE",
          message: "active turn in progress; export requires all turns terminal",
        } as const;
      }

      // conversations：dialogue（active/archived）+ inbox，升序，游标分页
      // （大 workspace 的全量单查询会占满连接缓冲；分批循环装载）
      const PAGE_SIZE = 200;
      // 流式序列化：manifest 先行、footer 末行；每页装载后立即序列化并增量
      // 更新 SHA-256，避免「整类 50k 原始行 + 已序列化串」同时驻留内存，
      // 峰值内存被约束为「一页原始行 + 累计 ndjson 输出」。
      const counts = {
        conversations: 0,
        messages: 0,
        voiceProvenance: 0,
        proactiveDeliveries: 0,
        actionProposals: 0,
        actionRuns: 0,
      };
      const hasher = createHash("sha256");
      const emitLine = async (line: string): Promise<void> => {
        // recordsSha256 覆盖 manifest 至 footer 前一行（每行含 LF）。
        hasher.update(`${line}\n`);
        await onLine(line);
      };
      await emitLine(JSON.stringify({
        version: 1,
        kind: "manifest",
        format: "companion-export-ndjson-v1",
        workspaceId: args.workspaceId,
        userId: args.userId,
        exportedAt: new Date().toISOString(),
      }));

      // conversations：dialogue（active/archived）+ inbox，升序，游标分页
      // （大 workspace 的全量单查询会占满连接缓冲；分批循环装载）
      let cursorCreatedAt: string | null = null;
      let cursorConversationId: string | null = null;
      let conversationCount = 0;
      for (;;) {
        const page: Array<{
          id: string; workspaceId: string; userId: string; kind: string; title: string;
          titleSource: string; status: string; createdAt: Date; updatedAt: Date; lastMessageAt: Date | null;
          sortKey: string;
        }> = await tx
          .select({
            id: companionConversations.id,
            workspaceId: companionConversations.workspaceId,
            userId: companionConversations.userId,
            kind: companionConversations.kind,
            title: companionConversations.title,
            titleSource: companionConversations.titleSource,
            status: companionConversations.status,
            createdAt: companionConversations.createdAt,
            updatedAt: companionConversations.updatedAt,
            lastMessageAt: companionConversations.lastMessageAt,
            // 2026-08-11：微秒精度游标（JS Date 毫秒截断会漏掉同毫秒行）
            sortKey: sql<string>`to_char(${companionConversations.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(companionConversations)
          .where(sql`${companionConversations.kind} IN ('dialogue', 'inbox')
                     AND ${companionConversations.workspaceId} = ${args.workspaceId}
                     AND ${companionConversations.userId} = ${args.userId}
                     AND ${companionConversations.status} IN ('active', 'archived')
                     AND (
                       ${cursorCreatedAt === null ? sql`TRUE` : sql`${companionConversations.createdAt} > ${cursorCreatedAt}::timestamptz
                         OR (${companionConversations.createdAt} = ${cursorCreatedAt}::timestamptz
                             AND ${companionConversations.id} > ${cursorConversationId})`}
                     )`)
          .orderBy(companionConversations.createdAt, companionConversations.id)
          .limit(PAGE_SIZE);
        if (page.length === 0) break;
        for (const c of page) {
          await emitLine(JSON.stringify({
            version: 1,
            kind: "conversation",
            value: {
              version: 1,
              id: c.id,
              workspaceId: c.workspaceId,
              userId: c.userId,
              kind: c.kind,
              title: c.title,
              titleSource: c.titleSource,
              status: c.status,
              createdAt: new Date(c.createdAt).toISOString(),
              updatedAt: new Date(c.updatedAt).toISOString(),
              lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
            },
          }));
          conversationCount += 1;
        }
        // N#7-11: 每类型行数上限，超限截断 + 告警，避免大历史全量装载。
        if (conversationCount >= COMPANION_EXPORT_MAX_ROWS) {
          logger.warn(
            { workspaceId: args.workspaceId, userId: args.userId, type: "conversations", limit: COMPANION_EXPORT_MAX_ROWS },
            "companion export 达到 conversations 行数上限，导出被截断",
          );
          break;
        }
        if (page.length < PAGE_SIZE) break;
        const last = page[page.length - 1]!;
        cursorCreatedAt = last.sortKey;
        cursorConversationId = last.id;
      }
      counts.conversations = conversationCount;

      // messages：按 conversation 升序、conversation 内 seq 升序，游标分页
      let cursorConv: string | null = null;
      let cursorSeq: number | null = null;
      let messageCount = 0;
      for (;;) {
        const page: Array<{
          id: string; conversationId: string; seq: number; role: string; kind: string;
          blocks: unknown; runId: string | null; clientMessageId: string | null;
          contentSha256: string | null; createdAt: Date;
        }> = await tx
          .select({
            id: companionMessages.id,
            conversationId: companionMessages.conversationId,
            seq: companionMessages.seq,
            role: companionMessages.role,
            kind: companionMessages.kind,
            blocks: companionMessages.blocks,
            runId: companionMessages.runId,
            clientMessageId: companionMessages.clientMessageId,
            contentSha256: companionMessages.contentSha256,
            createdAt: companionMessages.createdAt,
          })
          .from(companionMessages)
          .where(sql`${companionMessages.workspaceId} = ${args.workspaceId}
                     AND ${companionMessages.userId} = ${args.userId}
                     AND ${cursorConv === null ? sql`TRUE` : sql`(${companionMessages.conversationId}, ${companionMessages.seq}) > (${cursorConv}, ${cursorSeq})`}`)
          .orderBy(companionMessages.conversationId, companionMessages.seq)
          .limit(PAGE_SIZE);
        if (page.length === 0) break;
        for (const m of page) {
          await emitLine(JSON.stringify({
            version: 1,
            kind: "message",
            value: {
              version: 1,
              id: m.id,
              conversationId: m.conversationId,
              seq: Number(m.seq),
              role: m.role,
              kind: m.kind,
              blocks: m.blocks,
              runId: m.runId,
              clientMessageId: m.clientMessageId,
              contentSha256: m.contentSha256,
              createdAt: new Date(m.createdAt).toISOString(),
            },
          }));
          messageCount += 1;
        }
        // N#7-11: 行数上限，超限截断 + 告警。
        if (messageCount >= COMPANION_EXPORT_MAX_ROWS) {
          logger.warn(
            { workspaceId: args.workspaceId, userId: args.userId, type: "messages", limit: COMPANION_EXPORT_MAX_ROWS },
            "companion export 达到 messages 行数上限，导出被截断",
          );
          break;
        }
        if (page.length < PAGE_SIZE) break;
        const last = page[page.length - 1]!;
        cursorConv = last.conversationId;
        cursorSeq = Number(last.seq);
      }
      counts.messages = messageCount;

      // proactive deliveries / action proposals / action runs（§12 六类 record 契约）：
      // keyset 分页循环装载（见 recordsKeysetWhere），避免全量单查询。
      {
        let cursor: RecordsCursor = null;
        let recordCount = 0;
        for (;;) {
          const page = (await tx.execute(sql`
            SELECT id, conversation_id AS "conversationId", message_id AS "messageId",
                   permit_id AS "permitId", reason_id AS "reasonId",
                   suggestion_class_id AS "suggestionClassId",
                   content_policy AS "contentPolicy", status, created_at AS "createdAt"
            FROM companion_proactive_deliveries
            WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
              AND ${recordsKeysetWhere(cursor, "companion_proactive_deliveries")}
            ORDER BY conversation_id, created_at, id
            LIMIT ${PAGE_SIZE}
          `)) as unknown as Array<Record<string, unknown>>;
          if (page.length === 0) break;
          for (const delivery of page) {
            await emitLine(JSON.stringify({
              version: 1,
              kind: "proactive_delivery",
              value: {
                id: delivery.id,
                conversationId: delivery.conversationId,
                messageId: delivery.messageId,
                permitId: delivery.permitId,
                reasonId: delivery.reasonId,
                suggestionClassId: delivery.suggestionClassId,
                contentPolicy: delivery.contentPolicy,
                status: delivery.status,
                createdAt: delivery.createdAt instanceof Date
                  ? delivery.createdAt.toISOString()
                  : new Date(String(delivery.createdAt ?? "")).toISOString(),
              },
            }));
            recordCount += 1;
          }
          // N#7-11: 行数上限，超限截断 + 告警。
          if (recordCount >= COMPANION_EXPORT_MAX_ROWS) {
            logger.warn(
              { workspaceId: args.workspaceId, userId: args.userId, type: "proactiveDeliveries", limit: COMPANION_EXPORT_MAX_ROWS },
              "companion export 达到 proactive_deliveries 行数上限，导出被截断",
            );
            break;
          }
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1] as { conversationId: string; createdAt: Date; id: string };
          cursor = { conversationId: String(last.conversationId), createdAt: last.createdAt, id: String(last.id) };
        }
        counts.proactiveDeliveries = recordCount;
      }
      // action 表（0092 建表）无 drizzle schema 对象——用原生 sql 查询
      {
        let cursor: RecordsCursor = null;
        let recordCount = 0;
        for (;;) {
          const page = (await tx.execute(sql`
            SELECT id, conversation_id AS "conversationId", source_message_id AS "sourceMessageId",
                   status, created_at AS "createdAt"
            FROM companion_action_proposals
            WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
              AND ${recordsKeysetWhere(cursor, "companion_action_proposals")}
            ORDER BY conversation_id, created_at, id
            LIMIT ${PAGE_SIZE}
          `)) as unknown as Array<Record<string, unknown>>;
          if (page.length === 0) break;
          for (const proposal of page) {
            await emitLine(JSON.stringify({
              version: 1,
              kind: "action_proposal",
              value: {
                id: String(proposal.id),
                conversationId: proposal.conversationId ? String(proposal.conversationId) : null,
                sourceMessageId: proposal.sourceMessageId ? String(proposal.sourceMessageId) : null,
                status: String(proposal.status ?? ""),
                createdAt: proposal.createdAt instanceof Date
                  ? proposal.createdAt.toISOString()
                  : new Date(String(proposal.createdAt ?? "")).toISOString(),
              },
            }));
            recordCount += 1;
          }
          // N#7-11: 行数上限，超限截断 + 告警。
          if (recordCount >= COMPANION_EXPORT_MAX_ROWS) {
            logger.warn(
              { workspaceId: args.workspaceId, userId: args.userId, type: "actionProposals", limit: COMPANION_EXPORT_MAX_ROWS },
              "companion export 达到 action_proposals 行数上限，导出被截断",
            );
            break;
          }
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1] as { conversationId: string; createdAt: Date; id: string };
          cursor = { conversationId: String(last.conversationId), createdAt: last.createdAt, id: String(last.id) };
        }
        counts.actionProposals = recordCount;
      }
      {
        let cursor: RecordsCursor = null;
        let recordCount = 0;
        for (;;) {
          const page = (await tx.execute(sql`
            SELECT id, conversation_id AS "conversationId", proposal_id AS "proposalId",
                   status, created_at AS "createdAt"
            FROM companion_action_runs
            WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
              AND ${recordsKeysetWhere(cursor, "companion_action_runs")}
            ORDER BY conversation_id, created_at, id
            LIMIT ${PAGE_SIZE}
          `)) as unknown as Array<Record<string, unknown>>;
          if (page.length === 0) break;
          for (const run of page) {
            await emitLine(JSON.stringify({
              version: 1,
              kind: "action_run",
              value: {
                id: String(run.id),
                conversationId: run.conversationId ? String(run.conversationId) : null,
                proposalId: run.proposalId ? String(run.proposalId) : null,
                status: String(run.status ?? ""),
                createdAt: run.createdAt instanceof Date
                  ? run.createdAt.toISOString()
                  : new Date(String(run.createdAt ?? "")).toISOString(),
              },
            }));
            recordCount += 1;
          }
          // N#7-11: 行数上限，超限截断 + 告警。
          if (recordCount >= COMPANION_EXPORT_MAX_ROWS) {
            logger.warn(
              { workspaceId: args.workspaceId, userId: args.userId, type: "actionRuns", limit: COMPANION_EXPORT_MAX_ROWS },
              "companion export 达到 action_runs 行数上限，导出被截断",
            );
            break;
          }
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1] as { conversationId: string; createdAt: Date; id: string };
          cursor = { conversationId: String(last.conversationId), createdAt: last.createdAt, id: String(last.id) };
        }
        counts.actionRuns = recordCount;
      }

      const recordsSha256 = hasher.digest("hex");
      // footer 不参与 recordsSha256（覆盖范围至 footer 前一行为止），且 hasher
      // 已终结——必须直写 onLine，不能走会 update 哈希的 emitLine（2026-08-23
      // 修复：此前经 emitLine 写 footer 触发 ERR_CRYPTO_HASH_FINALIZED，
      // 导出必失败）。
      await onLine(JSON.stringify({
        version: 1,
        kind: "footer",
        counts,
        recordsSha256,
      }));

      return { ok: true };
    },
    { isolationLevel: "repeatable read" },
  );
  // §12：导出成功写 content-free audit（read-only 事务内不能 INSERT，
  // 放事务提交后 fire-and-forget；不阻塞导出响应）。
  if (result.ok) {
    void logCompanionAudit({
      userId: args.userId,
      workspaceId: args.workspaceId,
      pageActionType: "audit_export",
      result: "companion_export",
    }).catch(() => undefined);
  }
  return result;
}

/**
 * 兼容旧 API：把流式导出的每一行累积进 ndjson 数组一次性返回。生产路由应使用
 * exportCompanionDataStream 直接流式写出，避免整份输出驻留内存；本封装供集成
 * 测试与内部调用保持既有契约。
 */
export async function exportCompanionData(args: {
  workspaceId: string;
  userId: string;
}): Promise<ExportCompanionResult> {
  const ndjson: string[] = [];
  const result = await exportCompanionDataStream(args, (line) => {
    ndjson.push(line);
  });
  if (!result.ok) return result;
  return { ok: true, ndjson };
}
