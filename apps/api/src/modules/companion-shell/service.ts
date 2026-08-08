/**
 * 阶段 02（W1）任务 02-3：Companion onboarding 状态机与跨设备同步（§5.4.3 + §12.5）。
 *
 * 核心语义：
 * - onboarding CAS 状态机：not_offered → offered（一次性 display permit，只有获胜
 *   设备/标签页可展示；CAS 成功后即使客户端首帧前崩溃，offered/paused/abandoned 也
 *   不得再次自动展开）→ consumed（单调终态，完成/跳过通过服务端 revision CAS 写
 *   disposition，刷新/重登/并发设备/旧请求不能回退）。
 * - manual replay 只创建 entryMode=manual_replay 独立 run，绝不改变 consumed。
 * - pause 只写 runStatus=paused，不自动展开；resumeTokenRef 绑定 user/onboarding
 *   version/runId/base revision/expiry；跨 workspace 只同步账号级 offer 终态，
 *   不复用上一 workspace 的 resume token。
 * - account state（global off/presence/suppression/动画/语音/通知边界）带 revision
 *   乐观锁；global off 时 epoch 单调递增作为 SSE/WS epoch 撤销信号（广播基础设施
 *   在任务 02-9/后续阶段补）。
 * - device runtime-fence：短 TTL 内存 fence，ephemeral 不落库。
 *
 * 注意：companion 表在迁移 0075 下 FORCE RLS，policy 只按 app.user_id 授权
 * （fail closed），因此所有表读写必须经 withWorkspaceTransaction 设置 RLS 上下文；
 * account-scoped 语义由 user_id 过滤保证，不依赖 workspace。
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  boolean,
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
import {
  CompanionOnboardingErrorCode,
  type CompanionAccountPatch,
  type CompanionAccountStateV1,
  type CompanionNotificationBoundary,
  type CompanionOnboardingActiveRun,
  type CompanionOnboardingDisposition,
  type CompanionOnboardingEntryMode,
  type CompanionOnboardingLastRun,
  type CompanionOnboardingOfferStatus,
  type CompanionOnboardingStateV1,
  type CompanionOverview,
  type CompanionPresenceState,
  type CompanionSuggestionPause,
  type CompanionSuppression,
  type OnboardingTransitionResponse,
  type RuntimeFenceRequest,
  type RuntimeFenceResponse,
  type TransitionAction,
} from "@ailearn/shared";

// ─── 表定义（与迁移 0074/0075 一致）───────────────────────────────────
// apps/api 的 db schema 镜像树（apps/api/src/db/schema/）尚未同步 companion.ts，
// 因此在模块内声明读取用途的表对象；列名/类型须与
// packages/db/src/schema/companion.ts 保持一致，待镜像树同步后可删除并改回统一导出。

export interface CompanionAnimationVoiceOff {
  animationOff: boolean;
  voiceOff: boolean;
}

export const userCompanionOnboarding = pgTable(
  "user_companion_onboarding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    onboardingVersion: text("onboarding_version").notNull(),
    revision: integer("revision").notNull().default(0),
    // 自动欢迎资格严格等于 offer_status = 'not_offered'；consumed 是单调终态。
    offerStatus: text("offer_status")
      .$type<CompanionOnboardingOfferStatus>().notNull().default("not_offered"),
    offerDisposition: text("offer_disposition")
      .$type<CompanionOnboardingDisposition>(),
    activeRun: jsonb("active_run").$type<CompanionOnboardingActiveRun>(),
    lastRun: jsonb("last_run").$type<CompanionOnboardingLastRun>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const userCompanionAccountState = pgTable(
  "user_companion_account_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    // account revision / epoch CAS；SSE/WebSocket epoch 撤销依赖 epoch 单调递增。
    revision: integer("revision").notNull().default(0),
    epoch: integer("epoch").notNull().default(0),
    globalEnabled: boolean("global_enabled").notNull().default(true),
    presence: jsonb("presence").$type<CompanionPresenceState>(),
    suggestionPause: jsonb("suggestion_pause").$type<CompanionSuggestionPause>(),
    suppression: jsonb("suppression").$type<CompanionSuppression>(),
    animationVoiceOff: jsonb("animation_voice_off")
      .$type<CompanionAnimationVoiceOff>(),
    notificationBoundary: jsonb("notification_boundary")
      .$type<CompanionNotificationBoundary>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// ─── 常量与类型 ─────────────────────────────────────────────────────────

/** resume token 恢复预算：签发后 7 天内可被动续接；过期只能被动恢复入口/重播。 */
const RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** onboarding 初始 step（版本内首个页面）。 */
const INITIAL_ONBOARDING_STEP_ID = "intro";
/** 每用户内存 fence 上限，防止 deviceSessionId 枚举撑爆内存。 */
const RUNTIME_FENCE_MAX_PER_USER = 64;

/** account revision 冲突（客户端 base revision 与服务端不一致）。 */
export const ACCOUNT_STATE_STALE_REVISION = "ACCOUNT_STATE_STALE_REVISION" as const;
/** 版本号非法（空串或超长）。 */
const INVALID_ONBOARDING_VERSION = "INVALID_ONBOARDING_VERSION" as const;

type OnboardingRow = typeof userCompanionOnboarding.$inferSelect;
type AccountRow = typeof userCompanionAccountState.$inferSelect;

export class CompanionStateError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "CompanionStateError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === "23505";
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}

function buildLastRun(params: {
  entryMode: CompanionOnboardingEntryMode;
  disposition: CompanionOnboardingLastRun["disposition"];
  at: Date;
}): CompanionOnboardingLastRun {
  return {
    entryMode: params.entryMode,
    disposition: params.disposition,
    at: params.at.toISOString(),
  };
}

function buildActiveRun(params: {
  entryMode: CompanionOnboardingEntryMode;
  runId: string;
  stepId: string;
  workspaceId: string;
  now: Date;
}): CompanionOnboardingActiveRun {
  return {
    runId: params.runId,
    entryMode: params.entryMode,
    runStatus: "in_progress",
    stepId: params.stepId,
    // 服务端签发的不透明 resume 令牌；验证 = 客户端提交值与此行字段一致
    // （user/onboardingVersion/runId/base revision/expiry 均已绑定在当前行）。
    resumeTokenRef: randomBytes(24).toString("hex"),
    resumeWorkspaceRef: params.workspaceId,
    expiresAt: new Date(params.now.getTime() + RESUME_TOKEN_TTL_MS).toISOString(),
  };
}

function serializeOnboarding(row: OnboardingRow): CompanionOnboardingStateV1 {
  return {
    onboardingVersion: row.onboardingVersion,
    revision: row.revision,
    offerStatus: row.offerStatus,
    offerDisposition: row.offerDisposition ?? undefined,
    activeRun: row.activeRun ?? undefined,
    lastRun: row.lastRun ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeAccount(row: AccountRow): CompanionAccountStateV1 {
  return {
    revision: row.revision,
    epoch: row.epoch,
    globalEnabled: row.globalEnabled,
    presence: row.presence ?? undefined,
    suggestionPause: row.suggestionPause ?? undefined,
    suppression: row.suppression ?? undefined,
    animationOff: row.animationVoiceOff?.animationOff,
    voiceOff: row.animationVoiceOff?.voiceOff,
    notificationBoundary: row.notificationBoundary ?? undefined,
  };
}

function emptyAccountState(): CompanionAccountStateV1 {
  return { revision: 0, epoch: 0, globalEnabled: true };
}

// ─── Onboarding transition（CAS 状态机）───────────────────────────────────

export interface OnboardingTransitionInput {
  userId: string;
  workspaceId: string;
  version: string;
  action: TransitionAction;
  /** 客户端持有的 base revision（CAS 乐观锁）；不传则基于服务端当前状态执行。 */
  revision?: number;
  /** pause/resume/abandon 必须带当前 runId；start/replay 由服务端签发。 */
  runId?: string;
  stepId?: string;
  resumeTokenRef?: string;
}

/**
 * 单事务内的 CAS 更新：行已 for update 锁定，UPDATE 仍以 id+revision 兜底，
 * rowCount=0 即并发写入被拦截（STALE_REVISION，理论上被行锁排除）。
 */
async function casUpdateOnboarding(
  tx: ApiTransaction,
  row: OnboardingRow,
  patch: {
    offerStatus?: CompanionOnboardingOfferStatus;
    offerDisposition?: CompanionOnboardingDisposition | null;
    activeRun?: CompanionOnboardingActiveRun | null;
    lastRun?: CompanionOnboardingLastRun | null;
  },
): Promise<OnboardingRow> {
  const setValues: Partial<OnboardingRow> = {
    revision: row.revision + 1,
    updatedAt: new Date(),
  };
  if (patch.offerStatus !== undefined) setValues.offerStatus = patch.offerStatus;
  if (patch.offerDisposition !== undefined) {
    setValues.offerDisposition = patch.offerDisposition;
  }
  if (patch.activeRun !== undefined) setValues.activeRun = patch.activeRun;
  if (patch.lastRun !== undefined) setValues.lastRun = patch.lastRun;

  const [updated] = await tx
    .update(userCompanionOnboarding)
    .set(setValues)
    .where(and(
      eq(userCompanionOnboarding.id, row.id),
      eq(userCompanionOnboarding.revision, row.revision),
    ))
    .returning();
  if (!updated) {
    throw new CompanionStateError(
      CompanionOnboardingErrorCode.STALE_REVISION,
      409,
      "onboarding state changed concurrently; refresh and retry",
    );
  }
  return updated;
}

function alreadyConsumedError(): CompanionStateError {
  return new CompanionStateError(
    CompanionOnboardingErrorCode.ONBOARDING_ALREADY_CONSUMED,
    409,
    "this onboarding version is already consumed and cannot be rolled back",
  );
}

function staleRevisionError(): CompanionStateError {
  return new CompanionStateError(
    CompanionOnboardingErrorCode.STALE_REVISION,
    409,
    "stale onboarding revision; refresh and retry",
  );
}

/**
 * 执行一次 onboarding transition。所有动作在单个事务内完成：
 * SELECT FOR UPDATE → 状态判断 → CAS UPDATE（id+revision 兜底）→ 返回新状态。
 */
export async function transitionOnboarding(
  input: OnboardingTransitionInput,
): Promise<OnboardingTransitionResponse> {
  const version = input.version.trim();
  if (!version || version.length > 100) {
    throw new CompanionStateError(INVALID_ONBOARDING_VERSION, 400, "invalid onboarding version");
  }

  return withWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    async (tx) => {
      const findRow = () => tx
        .select()
        .from(userCompanionOnboarding)
        .where(and(
          eq(userCompanionOnboarding.userId, input.userId),
          eq(userCompanionOnboarding.onboardingVersion, version),
        ))
        .for("update");

      let rows = await findRow();
      let row = rows[0];
      const now = new Date();

      if (!row) {
        if (input.action === "start" || input.action === "skip") {
          // 首访：start 建 not_offered 初始行（revision 0），skip 直接建终态行。
          try {
            await tx.insert(userCompanionOnboarding).values({
              userId: input.userId,
              onboardingVersion: version,
              revision: 0,
              offerStatus: input.action === "start" ? "not_offered" : "consumed",
              offerDisposition: input.action === "start"
                ? undefined
                : "skipped",
              lastRun: input.action === "start"
                ? undefined
                : buildLastRun({
                    entryMode: "first_run",
                    disposition: "skipped",
                    at: now,
                  }),
              createdAt: now,
              updatedAt: now,
            });
          } catch (err) {
            // 并发建行：唯一约束 (user_id, onboarding_version) 冲突，重读获胜行。
            if (isUniqueViolation(err)) {
              rows = await findRow();
              row = rows[0];
            } else {
              throw err;
            }
          }
          rows = await findRow();
          row = rows[0];
        }
        if (!row) {
          throw new CompanionStateError(
            CompanionOnboardingErrorCode.RUN_NOT_FOUND,
            404,
            "no onboarding state for this version",
          );
        }
      }

      // revision CAS：客户端基于旧快照的写入一律拒绝，防止跨设备旧写回退终态。
      if (input.revision !== undefined && input.revision !== row.revision) {
        throw staleRevisionError();
      }

      switch (input.action) {
        case "start": {
          if (row.offerStatus === "consumed") throw alreadyConsumedError();
          if (row.offerStatus === "offered") {
            // 同一 runId 重试（客户端获得 permit 后首帧前崩溃再请求）→ 幂等返回。
            if (row.activeRun && input.runId && row.activeRun.runId === input.runId) {
              return { won: false, state: serializeOnboarding(row) };
            }
            // 其他设备/标签页已赢得一次性 display permit：本请求不得展示。
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.OFFER_NOT_WINNER,
              409,
              "another device already claimed the onboarding display permit",
            );
          }
          // not_offered → offered：CAS 签发一次性 display permit + first_run run。
          const activeRun = buildActiveRun({
            entryMode: "first_run",
            runId: input.runId ?? randomToken(),
            stepId: input.stepId ?? INITIAL_ONBOARDING_STEP_ID,
            workspaceId: input.workspaceId,
            now,
          });
          const updated = await casUpdateOnboarding(tx, row, {
            offerStatus: "offered",
            offerDisposition: null,
            activeRun,
          });
          return { won: true, state: serializeOnboarding(updated) };
        }

        case "skip": {
          if (row.offerStatus === "consumed") {
            if (row.offerDisposition === "skipped") {
              // 幂等：重复 skip 不重复计数、不回退终态。
              return { state: serializeOnboarding(row) };
            }
            throw alreadyConsumedError();
          }
          const lastRun = buildLastRun({
            entryMode: row.activeRun?.entryMode ?? "first_run",
            disposition: "skipped",
            at: now,
          });
          const updated = await casUpdateOnboarding(tx, row, {
            offerStatus: "consumed",
            offerDisposition: "skipped",
            activeRun: null,
            lastRun,
          });
          return { state: serializeOnboarding(updated) };
        }

        case "complete": {
          if (row.offerStatus === "consumed") {
            if (row.offerDisposition === "completed") {
              return { state: serializeOnboarding(row) };
            }
            throw alreadyConsumedError();
          }
          const lastRun = buildLastRun({
            entryMode: row.activeRun?.entryMode ?? "first_run",
            disposition: "completed",
            at: now,
          });
          const updated = await casUpdateOnboarding(tx, row, {
            offerStatus: "consumed",
            offerDisposition: "completed",
            activeRun: null,
            lastRun,
          });
          return { state: serializeOnboarding(updated) };
        }

        case "abandon": {
          if (!input.runId) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "abandon requires the current runId",
            );
          }
          if (row.offerStatus === "consumed") throw alreadyConsumedError();
          if (!row.activeRun) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "no active run to abandon",
            );
          }
          if (row.activeRun.runId !== input.runId) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "runId does not match the active run",
            );
          }
          // 放弃只写 lastRun(abandoned) + 清 activeRun；offerStatus 保持 offered，
          // 此后不得再自动展开，仅保留被动恢复入口。
          const lastRun = buildLastRun({
            entryMode: row.activeRun.entryMode,
            disposition: "abandoned",
            at: now,
          });
          const updated = await casUpdateOnboarding(tx, row, {
            activeRun: null,
            lastRun,
          });
          return { state: serializeOnboarding(updated) };
        }

        case "pause": {
          if (!input.runId) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "pause requires the current runId",
            );
          }
          if (row.offerStatus === "consumed") throw alreadyConsumedError();
          if (!row.activeRun) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "no active run to pause",
            );
          }
          if (row.activeRun.runId !== input.runId) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "runId does not match the active run",
            );
          }
          if (row.activeRun.runStatus === "paused") {
            // 幂等：已暂停不再展开，至多按独立恢复预算展示一次被动续接入口。
            return { state: serializeOnboarding(row) };
          }
          const updated = await casUpdateOnboarding(tx, row, {
            activeRun: { ...row.activeRun, runStatus: "paused" },
          });
          return { state: serializeOnboarding(updated) };
        }

        case "resume": {
          if (!input.runId) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "resume requires the current runId",
            );
          }
          if (row.offerStatus === "consumed") throw alreadyConsumedError();
          if (!row.activeRun) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "no active run to resume",
            );
          }
          if (row.activeRun.runId !== input.runId) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.RUN_NOT_FOUND,
              409,
              "runId does not match the active run",
            );
          }
          if (row.activeRun.runStatus === "in_progress") {
            return { state: serializeOnboarding(row) };
          }
          // resume token 校验：令牌绑定 user（行内）/runId/base revision（已校验）/expiry。
          if (!input.resumeTokenRef || input.resumeTokenRef !== row.activeRun.resumeTokenRef) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.PERMIT_EXPIRED,
              409,
              "resume token does not match the active run",
            );
          }
          if (new Date(row.activeRun.expiresAt).getTime() < now.getTime()) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.PERMIT_EXPIRED,
              409,
              "resume permit expired; start a new run instead",
            );
          }
          // 跨 workspace 只同步账号级 offer 终态，不复用上一 workspace 的 resume token。
          if (
            row.activeRun.resumeWorkspaceRef
            && row.activeRun.resumeWorkspaceRef !== input.workspaceId
          ) {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.CROSS_WORKSPACE_RESUME_DENIED,
              409,
              "resume token is scoped to another workspace",
            );
          }
          const updated = await casUpdateOnboarding(tx, row, {
            activeRun: { ...row.activeRun, runStatus: "in_progress" },
          });
          return { state: serializeOnboarding(updated) };
        }

        case "replay": {
          if (row.offerStatus === "not_offered") {
            throw new CompanionStateError(
              CompanionOnboardingErrorCode.INVALID_TRANSITION,
              409,
              "cannot replay onboarding before it has been offered",
            );
          }
          // 用户主动重播：创建 entryMode=manual_replay 独立 run，绝不改变 consumed。
          // 旧的 in_progress run 被新 run 取代（用户显式重开）。
          const activeRun = buildActiveRun({
            entryMode: "manual_replay",
            runId: input.runId ?? randomToken(),
            stepId: input.stepId ?? INITIAL_ONBOARDING_STEP_ID,
            workspaceId: input.workspaceId,
            now,
          });
          const updated = await casUpdateOnboarding(tx, row, { activeRun });
          return { state: serializeOnboarding(updated) };
        }
      }
    },
  );
}

// ─── Account 级状态（跨设备同步，revision/epoch CAS）──────────────────────

async function fetchAccountRow(tx: ApiTransaction, userId: string): Promise<AccountRow | null> {
  const rows = await tx
    .select()
    .from(userCompanionAccountState)
    .where(eq(userCompanionAccountState.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

function mergeAnimationVoiceOff(
  existing: CompanionAnimationVoiceOff | null | undefined,
  patch: CompanionAccountPatch,
): CompanionAnimationVoiceOff | null {
  const base = existing ?? { animationOff: false, voiceOff: false };
  const animationOff = patch.animationOff ?? base.animationOff;
  const voiceOff = patch.voiceOff ?? base.voiceOff;
  if (!animationOff && !voiceOff) return null;
  return { animationOff, voiceOff };
}

/**
 * 更新账号级 Companion 状态（global off / presence / suppression / 隐私控制）。
 * - revision 乐观锁：UPDATE ... WHERE revision = base，rowCount=0 → 409。
 * - global off（globalEnabled false）时 epoch 单调递增并记录广播钩子，
 *   SSE/WebSocket 广播基础设施在任务 02-9/后续阶段实现。
 */
export async function updateCompanionAccountState(
  userId: string,
  workspaceId: string,
  patch: CompanionAccountPatch,
): Promise<CompanionAccountStateV1> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const existing = await tx
      .select()
      .from(userCompanionAccountState)
      .where(eq(userCompanionAccountState.userId, userId))
      .for("update");
    const row = existing[0];
    const now = new Date();

    if (!row) {
      // 首访：revision 0 起算（客户端 base revision 必须为 0，否则视为旧写）。
      if (patch.revision !== 0) {
        throw new CompanionStateError(
          ACCOUNT_STATE_STALE_REVISION,
          409,
          "account state revision mismatch; refresh and retry",
        );
      }
      const [created] = await tx
        .insert(userCompanionAccountState)
        .values({
          userId,
          revision: 1,
          globalEnabled: patch.globalEnabled ?? true,
          presence: patch.presence ?? null,
          suggestionPause: patch.suggestionPause ?? null,
          suppression: patch.suppression ?? null,
          animationVoiceOff: mergeAnimationVoiceOff(null, patch),
          notificationBoundary: patch.notificationBoundary ?? null,
          updatedAt: now,
        })
        .returning();
      return serializeAccount(created);
    }

    if (row.revision !== patch.revision) {
      throw new CompanionStateError(
        ACCOUNT_STATE_STALE_REVISION,
        409,
        "account state revision mismatch; refresh and retry",
      );
    }

    const globalOffApplied = row.globalEnabled && patch.globalEnabled === false;
    const [updated] = await tx
      .update(userCompanionAccountState)
      .set({
        globalEnabled: patch.globalEnabled ?? row.globalEnabled,
        presence: patch.presence !== undefined ? patch.presence : row.presence,
        suggestionPause: patch.suggestionPause !== undefined
          ? patch.suggestionPause
          : row.suggestionPause,
        suppression: patch.suppression !== undefined ? patch.suppression : row.suppression,
        animationVoiceOff: mergeAnimationVoiceOff(row.animationVoiceOff, patch),
        notificationBoundary: patch.notificationBoundary !== undefined
          ? patch.notificationBoundary
          : row.notificationBoundary,
        revision: row.revision + 1,
        // global off → account epoch 单调递增：所有 active device session 的
        // surfaceEpoch 落后即视为撤销，迟到的 Companion 结果一律丢弃。
        epoch: globalOffApplied ? row.epoch + 1 : row.epoch,
        updatedAt: now,
      })
      .where(and(
        eq(userCompanionAccountState.id, row.id),
        eq(userCompanionAccountState.revision, row.revision),
      ))
      .returning();
    if (!updated) {
      throw new CompanionStateError(
        ACCOUNT_STATE_STALE_REVISION,
        409,
        "account state changed concurrently; refresh and retry",
      );
    }

    if (globalOffApplied) {
      notifyGlobalOffBroadcast(userId, updated.epoch);
    }
    return serializeAccount(updated);
  });
}

/**
 * 查询钩子：当前 account epoch。供设备侧校验 surfaceEpoch 是否过期
 * （SSE/WS 撤销与迟到结果丢弃，任务 02-9/后续阶段）。
 */
export async function getAccountEpoch(userId: string, workspaceId: string): Promise<number> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const row = await fetchAccountRow(tx, userId);
    return row?.epoch ?? 0;
  });
}

function notifyGlobalOffBroadcast(userId: string, epoch: number): void {
  // 本阶段：epoch 递增已落库（上面 UPDATE），广播依赖 SSE/WebSocket 基础设施。
  // TODO(02-9)：向该用户全部 active device session 推送 epoch 撤销 fence；
  // 设备侧 surfaceEpoch < epoch 时丢弃迟到 Companion 结果。
  void userId;
  void epoch;
}

// ─── 聚合视图：GET /me/companion ─────────────────────────────────────────

export async function getCompanionOverview(
  userId: string,
  workspaceId: string,
): Promise<CompanionOverview> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const [onboardingRows, accountRow] = await Promise.all([
      tx
        .select()
        .from(userCompanionOnboarding)
        .where(eq(userCompanionOnboarding.userId, userId)),
      fetchAccountRow(tx, userId),
    ]);
    onboardingRows.sort((a, b) => a.onboardingVersion.localeCompare(b.onboardingVersion));
    return {
      account: accountRow ? serializeAccount(accountRow) : emptyAccountState(),
      onboardingStates: onboardingRows.map(serializeOnboarding),
    };
  });
}

// ─── Device runtime-fence（ephemeral，不落库）────────────────────────────

interface RuntimeFenceRecord {
  deviceSessionId: string;
  surfaceEpoch: number;
  createdAt: string;
  expiresAt: string;
}

/**
 * ephemeral 存储：内存 Map + TTL，不落库（§12.5 device runtime-fence）。
 * 只保留 user + device session + surface epoch + TTL，不存 page/entity/content。
 * 单实例部署足够；多实例需共享存储（Redis/表），见 TODO(02-9)。
 */
const runtimeFenceStore = new Map<string, RuntimeFenceRecord>();
const RUNTIME_FENCE_KEY_SEP = "\u0000";

function runtimeFenceKey(userId: string, deviceSessionId: string): string {
  return `${userId}${RUNTIME_FENCE_KEY_SEP}${deviceSessionId}`;
}

function sweepExpiredRuntimeFences(): void {
  const now = Date.now();
  for (const [key, record] of runtimeFenceStore) {
    if (new Date(record.expiresAt).getTime() < now) runtimeFenceStore.delete(key);
  }
}

/**
 * 创建/续期一条 device-session runtime fence。authenticated 客户端发送
 * 短生命周期 deviceSessionId + surfaceEpoch，服务端用它取消该设备尚未开始
 * 或可取消的 Companion 调用；不写账号偏好。
 */
export async function createRuntimeFence(
  userId: string,
  req: RuntimeFenceRequest,
): Promise<RuntimeFenceResponse> {
  sweepExpiredRuntimeFences();

  // 每用户 fence 数量上限：超过时淘汰最早过期的一条。
  const userFences = listActiveRuntimeFences(userId);
  if (userFences.length >= RUNTIME_FENCE_MAX_PER_USER) {
    const oldest = userFences.reduce((a, b) => (a.expiresAt < b.expiresAt ? a : b));
    runtimeFenceStore.delete(runtimeFenceKey(userId, oldest.deviceSessionId));
  }

  const now = Date.now();
  const record: RuntimeFenceRecord = {
    deviceSessionId: req.deviceSessionId,
    surfaceEpoch: req.surfaceEpoch,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + req.ttlSeconds * 1000).toISOString(),
  };
  runtimeFenceStore.set(runtimeFenceKey(userId, req.deviceSessionId), record);
  return {
    deviceSessionId: record.deviceSessionId,
    surfaceEpoch: record.surfaceEpoch,
    ttlSeconds: req.ttlSeconds,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

/** 查询钩子：该 device session 是否在有效 fence 内（过期即删除并返回 null）。 */
export function getActiveRuntimeFence(userId: string, deviceSessionId: string): RuntimeFenceRecord | null {
  sweepExpiredRuntimeFences();
  const record = runtimeFenceStore.get(runtimeFenceKey(userId, deviceSessionId));
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    runtimeFenceStore.delete(runtimeFenceKey(userId, deviceSessionId));
    return null;
  }
  return record;
}

/** 查询钩子：该用户全部有效 fence（供广播/撤销逻辑使用）。 */
export function listActiveRuntimeFences(userId: string): RuntimeFenceRecord[] {
  sweepExpiredRuntimeFences();
  const prefix = `${userId}${RUNTIME_FENCE_KEY_SEP}`;
  const out: RuntimeFenceRecord[] = [];
  for (const [key, record] of runtimeFenceStore) {
    if (key.startsWith(prefix)) out.push(record);
  }
  return out;
}

export type { RuntimeFenceRecord };
