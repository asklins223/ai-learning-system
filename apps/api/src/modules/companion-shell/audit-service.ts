/**
 * Companion audit 写入与隐私生命周期（§5.8 + §12.2）。
 *
 * 职责：
 * - logCompanionAudit：写 companion_audit 行（只存 page/action/entity opaque IDs、
 *   context/permission hashes、policyVersion 与 result；不保存整页内容/DOM/截图/
 *   凭据/未提交输入）。单条 INSERT，无外部模型调用，适合调用方 fire-and-forget
 *   （不高频阻塞）。
 * - 导出/删除：按 user 导出/删除 audit+ledger（级联；全存储残留语义见注释）。
 *
 * 隐私边界（02-4 决策记录）：本模块所有数据只用于安全、幂等、预算与用户支持；
 * 不进入增长画像、兴趣推断或跨 workspace analytics；不写学习事实。
 */

import { DomainError } from "@ailearn/shared";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import {
  withWorkspaceTransaction,
} from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import {
  companionAudit,
  companionInvitationLedger,
  type CompanionAuditContextPermissionHashes,
  type CompanionAuditPageActionType,
} from "@ailearn/shared/db-schema/companion";

export type {
  CompanionAuditContextPermissionHashes,
  CompanionAuditPageActionType,
};

// ─── 常量 ───────────────────────────────────────────────────────────────

/** audit 短 TTL：默认 30 天（W0 privacy owner 冻结，§12.2 §2.2）。 */
export const COMPANION_AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** ledger 原始 entity refs 保留期限：默认 30 天（冷却/idempotency/retry 最短期限）。 */
export const COMPANION_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** ledger/audit 相关 policy 版本标记（审计写入用）。 */
export const COMPANION_AUDIT_POLICY_VERSION = "companion-audit-v1";

export class CompanionAuditError extends DomainError {
  constructor(code: string, statusCode: number, message: string) {
    super({ name: "CompanionAuditError", code, message, statusCode });
  }
}

// ─── Companion audit：写入（轻量，不高频阻塞）────────────────────────────

export interface CompanionAuditInput {
  userId: string;
  workspaceId: string;
  pageActionType: CompanionAuditPageActionType;
  /** opaque IDs：只做关联/去重，不可读回页面内容（§12.2）。 */
  pageOpaqueId?: string;
  actionOpaqueId?: string;
  entityOpaqueIds?: string[];
  contextPermissionHashes?: CompanionAuditContextPermissionHashes;
  policyVersion?: string;
  result?: string;
}

/**
 * 写一条 Companion audit 行。只存 opaque IDs/hashes/版本/结果，不存内容。
 * 单条 INSERT 且无外部依赖，适合调用方 fire-and-forget（不阻塞高频请求）。
 */
export async function logCompanionAudit(input: CompanionAuditInput): Promise<void> {
  await withWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    async (tx) => {
      await tx.insert(companionAudit).values({
        userId: input.userId,
        workspaceId: input.workspaceId,
        pageActionType: input.pageActionType,
        pageOpaqueId: input.pageOpaqueId ?? null,
        actionOpaqueId: input.actionOpaqueId ?? null,
        entityOpaqueIds: input.entityOpaqueIds ?? [],
        contextPermissionHashes: input.contextPermissionHashes ?? null,
        policyVersion: input.policyVersion ?? COMPANION_AUDIT_POLICY_VERSION,
        result: input.result ?? null,
      });
    },
  );
}

/** 审计行最小列（导出/清理共用）。 */
type AuditRow = typeof companionAudit.$inferSelect;

// ─── 导出 / 删除（用户数据能力；01-3 §3.1 无此端点，见决策记录 02-4）──────

type LedgerRow = typeof companionInvitationLedger.$inferSelect;

export interface CompanionUserDataExport {
  userId: string;
  exportedAt: string;
  auditTtlDays: number;
  ledgerTtlDays: number;
  note: string;
  audit: AuditRow[];
  invitationLedger: LedgerRow[];
}

/**
 * 导出当前 workspace 内该用户的 audit + ledger 行（user-private 语义）。
 * 导出内容只含 opaque IDs/hashes/版本/结果，不含页面内容/DOM/截图/凭据/未提交输入。
 */
export async function exportCompanionUserData(
  userId: string,
  workspaceId: string,
): Promise<CompanionUserDataExport> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // R10（round-3 审计）：原实现两大表各一条无 LIMIT 的全量 SELECT 一次性入内存返回体
      // （超大工作区内存/响应峰值）。现按 keyset（createdAt,id）每批 1000 分页扫描，
      // 结果保持 createdAt 有序拼接，输出与原先逐字节一致。
      // R10b（round-5）：即便分页，仍把每页 push 进无界数组——追加最大行数护栏，
      // 命中上限截断并告警，避免极端大工作区把整表驻留内存（对齐 companion-export 的
      // COMPANION_EXPORT_MAX_ROWS 思想）。
      const BATCH = 1000;
      const MAX_ROWS = 50_000;
      const audit: AuditRow[] = [];
      // R10c（2026-09-16 修复，实测缺陷）：游标必须用 **µs 精度的 epoch**，不能用
      // JS Date。timestamptz 的精度是微秒，而 drizzle 映射到 JS Date 时会截断到
      // 毫秒：同一毫秒内的多行（同一请求写多条 audit 就会发生）在
      // `createdAt > lastCreated` 下**永远为真**，分页因此原地打转——实测会把同一
      // 批行重复读到 MAX_ROWS 上限并让响应耗时数十秒（导出结果还含大量重复行）。
      // 现在按 (extract(epoch …), id) 做行比较，游标精度与列精度一致，严格前进。
      let auditCursor: { epoch: string; id: string } | null = null;
      for (;;) {
        // 显式标注行类型：page 的推断会经 auditCursor 回到自身（TS7022 循环推断）。
        const page: Array<AuditRow & { cursorEpoch: string }> = await tx
          .select({
            ...getTableColumns(companionAudit),
            cursorEpoch: sql<string>`extract(epoch from ${companionAudit.createdAt})::text`,
          })
          .from(companionAudit)
          .where(and(
            eq(companionAudit.workspaceId, workspaceId),
            eq(companionAudit.userId, userId),
            auditCursor
              ? sql`(extract(epoch from ${companionAudit.createdAt}), ${companionAudit.id}) > (${auditCursor.epoch}::numeric, ${auditCursor.id}::uuid)`
              : undefined,
          ))
          .orderBy(companionAudit.createdAt, companionAudit.id)
          .limit(BATCH);
        if (page.length === 0) break;
        for (const row of page) {
          const { cursorEpoch: _cursorEpoch, ...auditRow } = row;
          audit.push(auditRow as AuditRow);
        }
        if (audit.length >= MAX_ROWS) {
          logger.warn(
            { userId, workspaceId, table: "companion_audit", limit: MAX_ROWS },
            "companion audit 导出达到行数上限，已截断",
          );
          break;
        }
        const last = page[page.length - 1];
        auditCursor = { epoch: String(last.cursorEpoch), id: String(last.id) };
      }

      const ledger: LedgerRow[] = [];
      // 同一 µs 精度游标修复（见上方 audit 循环注释）。
      let ledgerCursor: { epoch: string; id: string } | null = null;
      for (;;) {
        const page: Array<LedgerRow & { cursorEpoch: string }> = await tx
          .select({
            ...getTableColumns(companionInvitationLedger),
            cursorEpoch: sql<string>`extract(epoch from ${companionInvitationLedger.createdAt})::text`,
          })
          .from(companionInvitationLedger)
          .where(and(
            eq(companionInvitationLedger.workspaceId, workspaceId),
            eq(companionInvitationLedger.userId, userId),
            ledgerCursor
              ? sql`(extract(epoch from ${companionInvitationLedger.createdAt}), ${companionInvitationLedger.id}) > (${ledgerCursor.epoch}::numeric, ${ledgerCursor.id}::uuid)`
              : undefined,
          ))
          .orderBy(companionInvitationLedger.createdAt, companionInvitationLedger.id)
          .limit(BATCH);
        if (page.length === 0) break;
        for (const row of page) {
          const { cursorEpoch: _cursorEpoch, ...ledgerRow } = row;
          ledger.push(ledgerRow as LedgerRow);
        }
        if (ledger.length >= MAX_ROWS) {
          logger.warn(
            { userId, workspaceId, table: "companion_invitation_ledger", limit: MAX_ROWS },
            "companion invitation ledger 导出达到行数上限，已截断",
          );
          break;
        }
        const last = page[page.length - 1];
        ledgerCursor = { epoch: String(last.cursorEpoch), id: String(last.id) };
      }

      return {
        userId,
        exportedAt: new Date().toISOString(),
        auditTtlDays: Math.round(COMPANION_AUDIT_TTL_MS / (24 * 60 * 60 * 1000)),
        ledgerTtlDays: Math.round(COMPANION_LEDGER_TTL_MS / (24 * 60 * 60 * 1000)),
        note: "audit/ledger 是安全、幂等、预算与用户支持记录；不含页面内容/DOM/截图/凭据/未提交输入；不进入增长画像或跨 workspace analytics",
        audit,
        invitationLedger: ledger,
      };
    },
  );
}

export interface CompanionDeleteResult {
  deletedAudit: number;
  deletedLedger: number;
}

/**
 * 删除当前 workspace 内该用户的 audit + ledger 行（级联；用户数据删除能力）。
 * 不触发重新邀请，不把拒绝行为重建为画像（02-4 §4）。
 */
export async function deleteCompanionUserData(
  userId: string,
  workspaceId: string,
): Promise<CompanionDeleteResult> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const [deletedAudit, deletedLedger] = await Promise.all([
        tx
          .delete(companionAudit)
          .where(and(
            eq(companionAudit.workspaceId, workspaceId),
            eq(companionAudit.userId, userId),
          ))
          .returning({ id: companionAudit.id }),
        tx
          .delete(companionInvitationLedger)
          .where(and(
            eq(companionInvitationLedger.workspaceId, workspaceId),
            eq(companionInvitationLedger.userId, userId),
          ))
          .returning({ id: companionInvitationLedger.id }),
      ]);
      return {
        deletedAudit: deletedAudit.length,
        deletedLedger: deletedLedger.length,
      };
    },
  );
}
