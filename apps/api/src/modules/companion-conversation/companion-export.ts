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

export type ExportCompanionResult =
  | { ok: true; ndjson: string[] }
  | { ok: false; statusCode: number; code: string; message: string };

const ACTIVE_RUN_STATUSES = "'accepted', 'running', 'cancel_requested'";

// §12 keyset 游标：proactive/action 三类 record 表统一按
// (conversation_id, created_at, id) 升序分页装载（与 conversations/messages
// 同理，避免大 scope 全量单查询占满连接缓冲）。
type RecordsCursor = { conversationId: string; createdAt: Date; id: string } | null;
function recordsKeysetWhere(cursor: RecordsCursor, table: string) {
  if (cursor === null) return sql`TRUE`;
  return sql`(${sql.raw(table)}.conversation_id, ${sql.raw(table)}.created_at, ${sql.raw(table)}.id)
             > (${cursor.conversationId}::uuid, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
}

export async function exportCompanionData(args: {
  workspaceId: string;
  userId: string;
}): Promise<ExportCompanionResult> {
  // read-only repeatable-read RLS transaction（§12 规则 4）；BEGIN 时设置隔离级别
  const result = await db.transaction<ExportCompanionResult>(async (tx) => {
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
      let cursorCreatedAt: string | null = null;
      let cursorConversationId: string | null = null;
      const conversations: Array<{
        id: string; workspaceId: string; userId: string; kind: string; title: string;
        titleSource: string; status: string; createdAt: Date; updatedAt: Date; lastMessageAt: Date | null;
      }> = [];
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
        conversations.push(...page);
        if (page.length < PAGE_SIZE) break;
        const last = page[page.length - 1]!;
        cursorCreatedAt = last.sortKey;
        cursorConversationId = last.id;
      }

      // messages：按 conversation 升序、conversation 内 seq 升序，游标分页
      const messages: Array<{
        id: string; conversationId: string; seq: number; role: string; kind: string;
        blocks: unknown; runId: string | null; clientMessageId: string | null;
        contentSha256: string | null; createdAt: Date;
      }> = [];
      let cursorConv: string | null = null;
      let cursorSeq: number | null = null;
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
        messages.push(...page);
        if (page.length < PAGE_SIZE) break;
        const last = page[page.length - 1]!;
        cursorConv = last.conversationId;
        cursorSeq = Number(last.seq);
      }

      // proactive deliveries / action proposals / action runs（§12 六类 record 契约）：
      // keyset 分页循环装载（见 recordsKeysetWhere），避免全量单查询。
      const proactiveDeliveries: Array<Record<string, unknown>> = [];
      {
        let cursor: RecordsCursor = null;
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
          `)) as unknown as Array<{ id: string; conversationId: string; createdAt: Date }>;
          if (page.length === 0) break;
          proactiveDeliveries.push(...page);
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1]!;
          cursor = { conversationId: String(last.conversationId), createdAt: last.createdAt, id: String(last.id) };
        }
      }
      // action 表（0092 建表）无 drizzle schema 对象——用原生 sql 查询
      const actionProposals: Array<Record<string, unknown>> = [];
      {
        let cursor: RecordsCursor = null;
        for (;;) {
          const page = (await tx.execute(sql`
            SELECT id, conversation_id AS "conversationId", source_message_id AS "sourceMessageId",
                   status, created_at AS "createdAt"
            FROM companion_action_proposals
            WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
              AND ${recordsKeysetWhere(cursor, "companion_action_proposals")}
            ORDER BY conversation_id, created_at, id
            LIMIT ${PAGE_SIZE}
          `)) as unknown as Array<{ id: string; conversationId: string; createdAt: Date }>;
          if (page.length === 0) break;
          actionProposals.push(...page);
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1]!;
          cursor = { conversationId: String(last.conversationId), createdAt: last.createdAt, id: String(last.id) };
        }
      }
      const actionRuns: Array<Record<string, unknown>> = [];
      {
        let cursor: RecordsCursor = null;
        for (;;) {
          const page = (await tx.execute(sql`
            SELECT id, conversation_id AS "conversationId", proposal_id AS "proposalId",
                   status, created_at AS "createdAt"
            FROM companion_action_runs
            WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
              AND ${recordsKeysetWhere(cursor, "companion_action_runs")}
            ORDER BY conversation_id, created_at, id
            LIMIT ${PAGE_SIZE}
          `)) as unknown as Array<{ id: string; conversationId: string; createdAt: Date }>;
          if (page.length === 0) break;
          actionRuns.push(...page);
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1]!;
          cursor = { conversationId: String(last.conversationId), createdAt: last.createdAt, id: String(last.id) };
        }
      }

      const ndjson: string[] = [];
      const counts = {
        conversations: 0,
        messages: 0,
        voiceProvenance: 0,
        proactiveDeliveries: 0,
        actionProposals: 0,
        actionRuns: 0,
      };

      ndjson.push(JSON.stringify({
        version: 1,
        kind: "manifest",
        format: "companion-export-ndjson-v1",
        workspaceId: args.workspaceId,
        userId: args.userId,
        exportedAt: new Date().toISOString(),
      }));

      for (const c of conversations) {
        ndjson.push(JSON.stringify({
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
        counts.conversations += 1;
      }
      for (const m of messages) {
        ndjson.push(JSON.stringify({
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
        counts.messages += 1;
      }

      // proactive delivery / action proposal / action run 三类 record（§12）
      for (const delivery of proactiveDeliveries) {
        ndjson.push(JSON.stringify({
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
        counts.proactiveDeliveries += 1;
      }
      for (const proposal of actionProposals) {
        ndjson.push(JSON.stringify({
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
        counts.actionProposals += 1;
      }
      for (const run of actionRuns) {
        ndjson.push(JSON.stringify({
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
        counts.actionRuns += 1;
      }

      // recordsSha256：manifest 起至 footer 前一行止的原始 UTF-8 NDJSON bytes（每行含 LF）
      // 2026-08-11：流式增量 hash——此前先 join 成全量 Buffer 再 hash，
      // 大导出（数千消息）时峰值内存翻倍。改为逐行 update。
      const hasher = createHash("sha256");
      for (const line of ndjson) {
        hasher.update(`${line}\n`);
      }
      const recordsSha256 = hasher.digest("hex");
      ndjson.push(JSON.stringify({
        version: 1,
        kind: "footer",
        counts,
        recordsSha256,
      }));

      return { ok: true, ndjson };
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
