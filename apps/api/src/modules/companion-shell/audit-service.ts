/**
 * 阶段 02（W1）任务 02-4：Companion audit/ledger 与隐私生命周期（§5.8 + §12.2）。
 *
 * 职责：
 * - logCompanionAudit：写 companion_audit 行（只存 page/action/entity opaque IDs、
 *   context/permission hashes、policyVersion 与 result；不保存整页内容/DOM/截图/
 *   凭据/未提交输入）。单条 INSERT，无外部模型调用，适合调用方 fire-and-forget
 *   （不高频阻塞）。
 * - TTL 清理：audit 默认 30 天，ledger 原始 entity refs 默认 30 天；到期后删除或
 *   替换为不可逆、content-free 的预算 tombstone。
 * - invitation ledger：context/reason 双预算、activeSuggestionLease 与一次性 permit
 *   在单事务内原子签发（01-3 §12.5）；重复触发/跨设备旧写/迟到 dismiss 不得回退
 *   终态或重复展示。
 * - suppressedSuggestionClassIds 复用 user_companion_account_state.suppression
 *   （可持续保存但不携带 target，02-4）。
 * - 导出/删除：按 user 导出/删除 audit+ledger（级联；全存储残留语义见注释）。
 *
 * 隐私边界（02-4 决策记录）：本模块所有数据只用于安全、幂等、预算与用户支持；
 * 不进入增长画像、兴趣推断或跨 workspace analytics；不写学习事实。
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, isNull, sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  withWorkspaceTransaction,
  type ApiTransaction,
} from "../../db/client.ts";
import { listUserWorkspaces } from "../identity/service.ts";

// ─── 表定义（与迁移 0076 一致）────────────────────────────────────────
// apps/api 的 db schema 镜像树尚未同步 companion.ts，因此在模块内声明读取用途的
// 表对象；列名/类型与 packages/db/src/schema/companion.ts 保持一致（同 02-3 模式）。

export type CompanionSuggestionLease = {
  leaseId: string;
  surfaceEpoch: number;
  issuedAt: string;
  expiresAt: string;
};

export type CompanionOneTimePermit = {
  permitId: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  consumedByDeviceSessionId?: string;
};

export type CompanionAuditPageActionType =
  | "page_view"
  | "invitation_shown"
  | "invitation_dismissed"
  | "invitation_permit_issued"
  | "page_action_confirm"
  | "onboarding_transition"
  | "runtime_fence"
  | "suppression_change"
  | "audit_export"
  | "audit_delete";

export type CompanionAuditContextPermissionHashes = {
  contextVersion?: string;
  permissionSnapshotHash?: string;
  impactPreviewHash?: string;
  requestHash?: string;
};

export const companionInvitationLedger = pgTable(
  "companion_invitation_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    stablePageContextKey: text("stable_page_context_key").notNull(),
    contextBudgetKey: text("context_budget_key").notNull(),
    reasonBudgetKey: text("reason_budget_key").notNull(),
    reasonBudgetRemaining: integer("reason_budget_remaining").notNull().default(0),
    boundedReason: text("bounded_reason"),
    cooldownEpoch: integer("cooldown_epoch").notNull().default(0),
    shownAt: timestamp("shown_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    suggestionLease: jsonb("suggestion_lease").$type<CompanionSuggestionLease>(),
    oneTimePermit: jsonb("one_time_permit").$type<CompanionOneTimePermit>(),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const companionAudit = pgTable(
  "companion_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    pageActionType: text("page_action_type")
      .$type<CompanionAuditPageActionType>().notNull(),
    pageOpaqueId: text("page_opaque_id"),
    actionOpaqueId: text("action_opaque_id"),
    entityOpaqueIds: text("entity_opaque_ids").array().notNull().default([]),
    contextPermissionHashes: jsonb("context_permission_hashes")
      .$type<CompanionAuditContextPermissionHashes>(),
    policyVersion: text("policy_version"),
    result: text("result"),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// suppression 读取用途：user_companion_account_state（account-scoped，0075 policy）。
const userCompanionAccountStateForSuppression = pgTable(
  "user_companion_account_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    suppression: jsonb("suppression").$type<{
      suppressedSuggestionClassIds?: string[];
      paused?: boolean;
      until?: string;
    }>(),
  },
);

// ─── 常量 ───────────────────────────────────────────────────────────────

/** audit 短 TTL：默认 30 天（W0 privacy owner 冻结，§12.2 §2.2）。 */
export const COMPANION_AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** ledger 原始 entity refs 保留期限：默认 30 天（冷却/idempotency/retry 最短期限）。 */
export const COMPANION_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** activeSuggestionLease 存活期：15 分钟（过期后不再续期，不重复展示）。 */
export const SUGGESTION_LEASE_TTL_MS = 15 * 60 * 1000;
/** 一次性 permit 存活期：15 分钟。 */
export const ONE_TIME_PERMIT_TTL_MS = 15 * 60 * 1000;
/** reason 预算默认次数：同一 reasonBudgetKey 至多展示 2 次（有界、可配置）。 */
export const REASON_BUDGET_DEFAULT = 2;
/** bounded reason 最大长度（与迁移 CHECK 一致）。 */
export const MAX_BOUNDED_REASON_LENGTH = 200;
/** ledger/audit 相关 policy 版本标记（审计写入用）。 */
export const COMPANION_LEDGER_POLICY_VERSION = "companion-invitation-ledger-v1";
export const COMPANION_AUDIT_POLICY_VERSION = "companion-audit-v1";

/** content-free tombstone 的不可逆 key 前缀（SHA-256 截断，保持唯一索引合法）。 */
const LEDGER_TOMBSTONE_KEY_PREFIX = "ledger_tombstone_";

export class CompanionAuditError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "CompanionAuditError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const CompanionAuditErrorCode = {
  /** ledger 行已 tombstone（content-free 终态）：不得再发起邀请展示。 */
  LEDGER_TOMBSTONED: "LEDGER_TOMBSTONED",
  /** dismiss 已发生：不得重复自动展示（终态不回退）。 */
  ALREADY_DISMISSED: "ALREADY_DISMISSED",
  /** 另一设备/标签页持有未过期 lease：本请求不得展示。 */
  LEASE_ACTIVE_ELSEWHERE: "LEASE_ACTIVE_ELSEWHERE",
  /** 客户端 cooldown epoch 落后：跨设备旧写被拒。 */
  STALE_COOLDOWN: "STALE_COOLDOWN",
  /** context 预算已用（该 context 已展示过且 permit 已消费）。 */
  CONTEXT_BUDGET_EXHAUSTED: "CONTEXT_BUDGET_EXHAUSTED",
  /** reason 预算耗尽。 */
  REASON_BUDGET_EXHAUSTED: "REASON_BUDGET_EXHAUSTED",
  /** 输入非法（超长 bounded reason、空键等）。 */
  INVALID_INPUT: "INVALID_INPUT",
} as const;
export type CompanionAuditErrorCode =
  (typeof CompanionAuditErrorCode)[keyof typeof CompanionAuditErrorCode];

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === "23505";
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}

/** 不可逆 key：tombstone 时替换 entity refs（SHA-256 截断），content-free 且保持唯一。 */
function contentFreeLedgerKey(original: string): string {
  return LEDGER_TOMBSTONE_KEY_PREFIX
    + createHash("sha256").update(original).digest("hex").slice(0, 24);
}

function assertValidLedgerKeys(req: {
  stablePageContextKey: string;
  contextBudgetKey: string;
  reasonBudgetKey: string;
  boundedReason?: string;
}): void {
  const { stablePageContextKey, contextBudgetKey, reasonBudgetKey } = req;
  const invalid =
    !stablePageContextKey?.trim() || !contextBudgetKey?.trim() || !reasonBudgetKey?.trim()
    || stablePageContextKey.length > 300 || contextBudgetKey.length > 300
    || reasonBudgetKey.length > 300;
  if (invalid) {
    throw new CompanionAuditError(
      CompanionAuditErrorCode.INVALID_INPUT, 400, "ledger keys must be non-empty and bounded",
    );
  }
  if (req.boundedReason && req.boundedReason.length > MAX_BOUNDED_REASON_LENGTH) {
    throw new CompanionAuditError(
      CompanionAuditErrorCode.INVALID_INPUT, 400, "bounded reason exceeds max length",
    );
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

// ─── Companion audit：TTL 清理（删除或 content-free tombstone）────────────

export interface CompanionTtlSweepOptions {
  /** 清理作用域：workspace + user（RLS 双条件要求 workspace 上下文）。 */
  workspaceId: string;
  userId: string;
  /** "delete"：整行删除；"tombstone"：清空 entity refs 保留版本/结果计数。 */
  mode?: "delete" | "tombstone";
  /** 过期判定：created_at 早于 (now - olderThanMs)。默认 30 天。 */
  olderThanMs?: number;
}

async function sweepAuditWithin(
  tx: ApiTransaction,
  cutoff: Date,
  mode: "delete" | "tombstone",
): Promise<number> {
  if (mode === "delete") {
    const rows = await tx
      .delete(companionAudit)
      .where(lt(companionAudit.createdAt, cutoff))
      .returning({ id: companionAudit.id });
    return rows.length;
  }
  // tombstone：清空所有 opaque IDs/内容字段，保留 page_action_type/policy_version/
  // result/created_at 的不可逆计数；不可逆且 content-free（§12.2 §2.2）。
  const rows = await tx
    .update(companionAudit)
    .set({
      tombstonedAt: new Date(),
      pageOpaqueId: null,
      actionOpaqueId: null,
      entityOpaqueIds: [],
      contextPermissionHashes: null,
    })
    .where(and(
      lt(companionAudit.createdAt, cutoff),
      isNull(companionAudit.tombstonedAt),
    ))
    .returning({ id: companionAudit.id });
  return rows.length;
}

/**
 * TTL 清理（按 workspace+user 作用域）：删除或替换为 content-free tombstone 的
 * 过期 audit 行。由维护任务按 workspace 调用（低频，不阻塞请求路径）。
 */
export async function sweepCompanionAuditTtl(
  options: CompanionTtlSweepOptions,
): Promise<{ mode: "delete" | "tombstone"; removed: number; tombstoned: number }> {
  const mode = options.mode ?? "delete";
  const cutoff = new Date(Date.now() - (options.olderThanMs ?? COMPANION_AUDIT_TTL_MS));
  return withWorkspaceTransaction(
    { workspaceId: options.workspaceId, userId: options.userId },
    async (tx) => {
      const affected = await sweepAuditWithin(tx, cutoff, mode);
      return {
        mode,
        removed: mode === "delete" ? affected : 0,
        tombstoned: mode === "tombstone" ? affected : 0,
      };
    },
  );
}

// ─── Companion invitation ledger：原子签发 / consume / dismiss ───────────

export interface InvitationPermitRequest {
  userId: string;
  workspaceId: string;
  /** 页面稳定上下文键（opaque）。 */
  stablePageContextKey: string;
  /** context 预算键：每 context 至多一次原子签发（唯一索引兜底）。 */
  contextBudgetKey: string;
  /** reason 预算键：有界次数，独立于 context 预算。 */
  reasonBudgetKey: string;
  /** 有界 reason（≤200 字符，用户支持/幂等说明用，不进入画像）。 */
  boundedReason?: string;
  /** 客户端设备 session（opaque）。 */
  deviceSessionId: string;
  /** 签发时客户端看到的 account surface epoch（跨设备旧写检测）。 */
  surfaceEpoch: number;
  /** 幂等键：重试复用同一 leaseId 返回同一 permit，不重复展示。 */
  clientLeaseId: string;
  /** 客户端持有的 base cooldown epoch；不一致视为旧写拒绝。 */
  baseCooldownEpoch?: number;
}

export type InvitationPermitResult =
  | { won: true; permit: CompanionOneTimePermit; lease: CompanionSuggestionLease }
  | { won: false; reason: string };

type LedgerRow = typeof companionInvitationLedger.$inferSelect;

function buildLease(req: InvitationPermitRequest, now: Date): CompanionSuggestionLease {
  return {
    leaseId: req.clientLeaseId,
    surfaceEpoch: req.surfaceEpoch,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SUGGESTION_LEASE_TTL_MS).toISOString(),
  };
}

function buildPermit(now: Date): CompanionOneTimePermit {
  return {
    permitId: randomToken(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ONE_TIME_PERMIT_TTL_MS).toISOString(),
  };
}

function leaseActive(lease: CompanionSuggestionLease | null | undefined, now: Date): boolean {
  return !!lease && new Date(lease.expiresAt).getTime() > now.getTime();
}

function permitConsumable(
  permit: CompanionOneTimePermit | null | undefined,
  now: Date,
): boolean {
  return !!permit
    && !permit.consumedAt
    && new Date(permit.expiresAt).getTime() > now.getTime();
}

/**
 * 原子签发邀请：context/reason 双预算 + activeSuggestionLease + 一次性 permit
 * 在单事务内完成（01-3 §12.5）。行级 FOR UPDATE 保证并发设备/标签页只有一个获胜。
 * 规则：dismiss 后不重复展示；同 leaseId 重试幂等返回；他处 lease 活跃则 won=false；
 * 迟到 cooldown 旧写拒绝；context 预算一次、reason 预算有界。
 */
export async function issueCompanionInvitationPermit(
  req: InvitationPermitRequest,
): Promise<InvitationPermitResult> {
  assertValidLedgerKeys(req);

  return withWorkspaceTransaction(
    { workspaceId: req.workspaceId, userId: req.userId },
    async (tx) => {
      const now = new Date();
      const findRow = () => tx
        .select()
        .from(companionInvitationLedger)
        .where(and(
          eq(companionInvitationLedger.workspaceId, req.workspaceId),
          eq(companionInvitationLedger.userId, req.userId),
          eq(companionInvitationLedger.stablePageContextKey, req.stablePageContextKey),
        ))
        .for("update");

      let rows = await findRow();
      let row = rows[0];

      if (!row) {
        try {
          const lease = buildLease(req, now);
          const permit = buildPermit(now);
          const [created] = await tx
            .insert(companionInvitationLedger)
            .values({
              workspaceId: req.workspaceId,
              userId: req.userId,
              stablePageContextKey: req.stablePageContextKey,
              contextBudgetKey: req.contextBudgetKey,
              reasonBudgetKey: req.reasonBudgetKey,
              reasonBudgetRemaining: Math.max(0, REASON_BUDGET_DEFAULT - 1),
              boundedReason: req.boundedReason ?? null,
              cooldownEpoch: 0,
              shownAt: now,
              suggestionLease: lease,
              oneTimePermit: permit,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          await logAuditWithinTx(tx, req, "invitation_permit_issued", "issued");
          return { won: true as const, permit: created.oneTimePermit!, lease: created.suggestionLease! };
        } catch (err) {
          // 并发建行：budgetKey 唯一冲突 → 重读获胜行按既有行判定。
          if (isUniqueViolation(err)) {
            rows = await findRow();
            row = rows[0];
          } else {
            throw err;
          }
        }
      }
      if (!row) {
        throw new CompanionAuditError(
          CompanionAuditErrorCode.CONTEXT_BUDGET_EXHAUSTED, 409,
          "could not create invitation ledger row",
        );
      }

      // content-free 终态：tombstone 后不得再发起邀请展示。
      if (row.tombstonedAt) {
        throw new CompanionAuditError(
          CompanionAuditErrorCode.LEDGER_TOMBSTONED, 409,
          "invitation ledger row is tombstoned and no longer issuable",
        );
      }
      // dismiss 终态：不得重复自动展示（迟到 dismiss 不回退）。
      if (row.dismissedAt) {
        return { won: false, reason: "already_dismissed" };
      }
      // 迟到 cooldown 旧写（跨设备旧写）：client 落后于当前 epoch → 拒绝。
      if (
        req.baseCooldownEpoch !== undefined
        && req.baseCooldownEpoch !== row.cooldownEpoch
      ) {
        throw new CompanionAuditError(
          CompanionAuditErrorCode.STALE_COOLDOWN, 409,
          "stale cooldown epoch; refresh and retry",
        );
      }

      // 幂等：同 leaseId 且 lease 未过期、permit 可消费 → 返回同一 permit，不重复展示。
      if (
        row.suggestionLease?.leaseId === req.clientLeaseId
        && leaseActive(row.suggestionLease, now)
        && permitConsumable(row.oneTimePermit, now)
      ) {
        return { won: true, permit: row.oneTimePermit!, lease: row.suggestionLease! };
      }
      // 其他设备/标签页持有活跃 lease（或 permit 已消费）：本请求不得展示。
      if (leaseActive(row.suggestionLease, now)) {
        return { won: false, reason: "lease_active_elsewhere" };
      }
      if (row.oneTimePermit?.consumedAt) {
        // permit 已消费：该 context 展示已发生，不再重复展示。
        throw new CompanionAuditError(
          CompanionAuditErrorCode.CONTEXT_BUDGET_EXHAUSTED, 409,
          "one-time permit already consumed; context budget exhausted",
        );
      }

      // reason 预算：同 key 检查剩余；换 key 重置后再消耗。
      let reasonBudgetRemaining = row.reasonBudgetRemaining;
      const reasonKeyChanged = row.reasonBudgetKey !== req.reasonBudgetKey;
      if (reasonKeyChanged) {
        reasonBudgetRemaining = REASON_BUDGET_DEFAULT;
      }
      if (reasonBudgetRemaining <= 0) {
        return { won: false, reason: "reason_budget_exhausted" };
      }

      const lease = buildLease(req, now);
      const permit = buildPermit(now);
      const [updated] = await tx
        .update(companionInvitationLedger)
        .set({
          contextBudgetKey: req.contextBudgetKey,
          reasonBudgetKey: req.reasonBudgetKey,
          reasonBudgetRemaining: reasonBudgetRemaining - 1,
          boundedReason: req.boundedReason ?? row.boundedReason,
          shownAt: row.shownAt ?? now,
          suggestionLease: lease,
          oneTimePermit: permit,
          updatedAt: now,
        })
        .where(eq(companionInvitationLedger.id, row.id))
        .returning();
      await logAuditWithinTx(tx, req, "invitation_permit_issued", "issued");
      return { won: true as const, permit: updated.oneTimePermit!, lease: updated.suggestionLease! };
    },
  );
}

async function logAuditWithinTx(
  tx: ApiTransaction,
  req: InvitationPermitRequest,
  pageActionType: CompanionAuditPageActionType,
  result: string,
): Promise<void> {
  // 审计只存 opaque 信息（clientLeaseId 为幂等键的不可逆哈希），不存页面内容。
  await tx.insert(companionAudit).values({
    userId: req.userId,
    workspaceId: req.workspaceId,
    pageActionType,
    actionOpaqueId: createHash("sha256").update(req.clientLeaseId).digest("hex"),
    entityOpaqueIds: [
      createHash("sha256").update(req.stablePageContextKey).digest("hex"),
    ],
    policyVersion: COMPANION_LEDGER_POLICY_VERSION,
    result,
  });
}

export interface InvitationDismissInput {
  userId: string;
  workspaceId: string;
  stablePageContextKey: string;
  /** 可选：dismiss 前持有的一次性 permit id（仅用于幂等匹配）。 */
  permitId?: string;
  deviceSessionId: string;
}

/**
 * dismiss 邀请：置 dismissedAt（终态）、cooldown epoch +1、清除 lease/permit。
 * 迟到 dismiss（已 dismissed）幂等返回，不回退终态；之后不得重复自动展示。
 */
export async function dismissCompanionInvitation(
  input: InvitationDismissInput,
): Promise<{ dismissed: boolean; cooldownEpoch: number }> {
  return withWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    async (tx) => {
      const now = new Date();
      const rows = await tx
        .select()
        .from(companionInvitationLedger)
        .where(and(
          eq(companionInvitationLedger.workspaceId, input.workspaceId),
          eq(companionInvitationLedger.userId, input.userId),
          eq(companionInvitationLedger.stablePageContextKey, input.stablePageContextKey),
        ))
        .for("update");
      const row = rows[0];
      if (!row || row.tombstonedAt) {
        // 无行/tombstone：无可 dismiss 的终态，幂等返回。
        return { dismissed: false, cooldownEpoch: row?.cooldownEpoch ?? 0 };
      }
      if (row.dismissedAt) {
        // 迟到 dismiss：终态已建立，幂等返回，不回退。
        return { dismissed: false, cooldownEpoch: row.cooldownEpoch };
      }
      const [updated] = await tx
        .update(companionInvitationLedger)
        .set({
          dismissedAt: now,
          cooldownEpoch: row.cooldownEpoch + 1,
          suggestionLease: null,
          oneTimePermit: null,
          updatedAt: now,
        })
        .where(eq(companionInvitationLedger.id, row.id))
        .returning();
      await logAuditWithinTx(
        tx,
        {
          userId: input.userId,
          workspaceId: input.workspaceId,
          stablePageContextKey: input.stablePageContextKey,
          contextBudgetKey: "",
          reasonBudgetKey: "",
          deviceSessionId: input.deviceSessionId,
          surfaceEpoch: 0,
          clientLeaseId: input.permitId ?? "dismiss",
        },
        "invitation_dismissed",
        "dismissed",
      );
      return { dismissed: true, cooldownEpoch: updated.cooldownEpoch };
    },
  );
}

export interface InvitationConsumeInput {
  userId: string;
  workspaceId: string;
  stablePageContextKey: string;
  permitId: string;
  deviceSessionId: string;
}

/**
 * 消费一次性 permit：客户端确认展示后调用。已消费则幂等返回；
 * permit 不匹配/不存在 → 错误（fail closed）。
 */
export async function consumeCompanionInvitationPermit(
  input: InvitationConsumeInput,
): Promise<{ consumed: boolean }> {
  return withWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    async (tx) => {
      const now = new Date();
      const rows = await tx
        .select()
        .from(companionInvitationLedger)
        .where(and(
          eq(companionInvitationLedger.workspaceId, input.workspaceId),
          eq(companionInvitationLedger.userId, input.userId),
          eq(companionInvitationLedger.stablePageContextKey, input.stablePageContextKey),
        ))
        .for("update");
      const row = rows[0];
      if (!row || !row.oneTimePermit) {
        throw new CompanionAuditError(
          CompanionAuditErrorCode.INVALID_INPUT, 404,
          "no one-time permit on this ledger row",
        );
      }
      if (row.oneTimePermit.permitId !== input.permitId) {
        throw new CompanionAuditError(
          CompanionAuditErrorCode.INVALID_INPUT, 409,
          "permit id does not match; stale or wrong device",
        );
      }
      if (row.oneTimePermit.consumedAt) {
        // 幂等：重复消费返回已消费。
        return { consumed: false };
      }
      await tx
        .update(companionInvitationLedger)
        .set({
          oneTimePermit: {
            ...row.oneTimePermit,
            consumedAt: now.toISOString(),
            consumedByDeviceSessionId: input.deviceSessionId,
          },
          updatedAt: now,
        })
        .where(eq(companionInvitationLedger.id, row.id));
      await logAuditWithinTx(
        tx,
        {
          userId: input.userId,
          workspaceId: input.workspaceId,
          stablePageContextKey: input.stablePageContextKey,
          contextBudgetKey: "",
          reasonBudgetKey: "",
          deviceSessionId: input.deviceSessionId,
          surfaceEpoch: 0,
          clientLeaseId: input.permitId,
        },
        "invitation_shown",
        "consumed",
      );
      return { consumed: true };
    },
  );
}

// ─── suppressedSuggestionClassIds（复用 account state.suppression，02-4）───

/**
 * 读取当前账号的 suppressedSuggestionClassIds。可持续保存但不携带 target
 * （§12.2 §2.2）；持久化继续复用 user_companion_account_state.suppression，
 * 本函数只提供读取钩子，不新增存储。
 */
export async function getSuppressedSuggestionClassIds(
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const rows = await tx
        .select()
        .from(userCompanionAccountStateForSuppression)
        .where(eq(userCompanionAccountStateForSuppression.userId, userId))
        .limit(1);
      return rows[0]?.suppression?.suppressedSuggestionClassIds ?? [];
    },
  );
}

// ─── 导出 / 删除（用户数据能力；01-3 §3.1 无此端点，见决策记录 02-4）──────

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
      const [audit, ledger] = await Promise.all([
        tx
          .select()
          .from(companionAudit)
          .where(and(
            eq(companionAudit.workspaceId, workspaceId),
            eq(companionAudit.userId, userId),
          ))
          .orderBy(companionAudit.createdAt),
        tx
          .select()
          .from(companionInvitationLedger)
          .where(and(
            eq(companionInvitationLedger.workspaceId, workspaceId),
            eq(companionInvitationLedger.userId, userId),
          ))
          .orderBy(companionInvitationLedger.createdAt),
      ]);
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

/**
 * 全存储残留扫描/账号删除钩子：删除该用户在【全部 workspace】的 audit + ledger 行。
 * 逐 workspace 走 withWorkspaceTransaction（RLS 双条件要求 workspace 上下文）。
 * 残留语义（02-4 §4）：audit/ledger 只存在本库（无 cache/队列/分析副本）；若未来
 * 引入分析副本，需在删除流程中同步清理并扫描（本函数为唯一删除入口）。
 */
export async function deleteAllUserCompanionAuditAndLedger(
  userId: string,
): Promise<{ perWorkspace: Array<CompanionDeleteResult & { workspaceId: string }> }> {
  const workspaces = await listUserWorkspaces(userId);
  const perWorkspace: Array<CompanionDeleteResult & { workspaceId: string }> = [];
  for (const ws of workspaces) {
    const result = await deleteCompanionUserData(userId, ws.workspaceId);
    perWorkspace.push({ workspaceId: ws.workspaceId, ...result });
  }
  return { perWorkspace };
}

export type { LedgerRow, AuditRow };

/**
 * ledger TTL 清理（按 workspace+user 作用域）：
 * - delete：删除过期行；
 * - tombstone：把 entity refs（stablePageContextKey/contextBudgetKey/reasonBudgetKey）
 *   替换为不可逆 SHA-256 截断键并置 tombstonedAt，保留预算计数
 *   （cooldown_epoch/reason_budget_remaining/shown_at）——不可逆、content-free
 *   的预算 tombstone（§12.2 §2.2）。tombstone 后不再发起邀请展示（fail closed）。
 */
export async function sweepCompanionInvitationLedgerTtl(
  options: CompanionTtlSweepOptions,
): Promise<{ mode: "delete" | "tombstone"; removed: number; tombstoned: number }> {
  const mode = options.mode ?? "delete";
  const cutoff = new Date(Date.now() - (options.olderThanMs ?? COMPANION_LEDGER_TTL_MS));
  return withWorkspaceTransaction(
    { workspaceId: options.workspaceId, userId: options.userId },
    async (tx) => {
      if (mode === "delete") {
        const removed = await tx
          .delete(companionInvitationLedger)
          .where(and(
            eq(companionInvitationLedger.workspaceId, options.workspaceId),
            eq(companionInvitationLedger.userId, options.userId),
            lt(companionInvitationLedger.updatedAt, cutoff),
          ))
          .returning({ id: companionInvitationLedger.id });
        return { mode, removed: removed.length, tombstoned: 0 };
      }
      // 先取待 tombstone 行的原始 refs（生成不可逆替换键），再更新。
      const stale = await tx
        .select({
          id: companionInvitationLedger.id,
          stablePageContextKey: companionInvitationLedger.stablePageContextKey,
          contextBudgetKey: companionInvitationLedger.contextBudgetKey,
          reasonBudgetKey: companionInvitationLedger.reasonBudgetKey,
        })
        .from(companionInvitationLedger)
        .where(and(
          eq(companionInvitationLedger.workspaceId, options.workspaceId),
          eq(companionInvitationLedger.userId, options.userId),
          lt(companionInvitationLedger.updatedAt, cutoff),
          isNull(companionInvitationLedger.tombstonedAt),
        ));
      // 2026-08-11：单条 UPDATE + VALUES 派生表批量 tombstone（此前逐行
      // UPDATE，过期行上千时 N 次往返）。
      const tuples = stale.map((row) => ({
        id: row.id,
        sk: contentFreeLedgerKey(row.stablePageContextKey),
        ck: contentFreeLedgerKey(row.contextBudgetKey),
        rk: contentFreeLedgerKey(row.reasonBudgetKey),
      }));
      let tombstoned = 0;
      if (tuples.length > 0) {
        const updated = await tx.execute(sql`
          UPDATE companion_invitation_ledger AS l
          SET stable_page_context_key = v.sk,
              context_budget_key = v.ck,
              reason_budget_key = v.rk,
              bounded_reason = NULL,
              suggestion_lease = NULL,
              one_time_permit = NULL,
              tombstoned_at = now(),
              updated_at = now()
          FROM (VALUES ${sql.join(
            tuples.map((t) => sql`(${t.id}, ${t.sk}, ${t.ck}, ${t.rk})`),
            sql`, `,
          )}) AS v(id, sk, ck, rk)
          WHERE l.id = v.id
        `);
        tombstoned = Number((updated as unknown as { rowCount?: number }).rowCount ?? 0);
      }
      return { mode, removed: 0, tombstoned };
    },
  );
}
