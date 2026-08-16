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
 * - device runtime-fence：短 TTL、content-free 的共享 server-side fence；不写账号偏好。
 *
 * 注意：companion 表在迁移 0075 下 FORCE RLS，policy 只按 app.user_id 授权
 * （fail closed），因此所有表读写必须经 withWorkspaceTransaction 设置 RLS 上下文；
 * account-scoped 语义由 user_id 过滤保证，不依赖 workspace。
 */

import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
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
import { COMPANION_ACCOUNT_NOTIFY_CHANNEL } from "../companion-conversation/companion-notify.ts";
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
    // 方案 16 §10.3：主动介入强度与静默时段（0140 迁移）。
    interventionLevel: text("intervention_level").$type<"quiet" | "moderate" | "active">().notNull().default("moderate"),
    quietHours: jsonb("quiet_hours").$type<{ startLocal: string; endLocal: string; timezone: string } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const companionRuntimeFences = pgTable(
  "companion_runtime_fences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    deviceSessionId: text("device_session_id").notNull(),
    surfaceEpoch: integer("surface_epoch").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
);

// ─── 常量与类型 ─────────────────────────────────────────────────────────

/** resume token 恢复预算：签发后 7 天内可被动续接；过期只能被动恢复入口/重播。 */
const RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** onboarding 初始 step（版本内首个页面）。 */
const INITIAL_ONBOARDING_STEP_ID = "intro";

/** 服务端约束客户端提交的 runId/stepId：只接受受限字符集与长度，非法值回退默认
 *  （防超长字符串写入 activeRun jsonb、防任意 stepId 污染前端状态机）。 */
function sanitizeOnboardingRefs(input: { runId?: string; stepId?: string }): {
  runId?: string;
  stepId?: string;
} {
  const runId = input.runId && /^[A-Za-z0-9_-]{1,128}$/.test(input.runId) ? input.runId : undefined;
  const stepId = input.stepId && /^[A-Za-z0-9_-]{1,64}$/.test(input.stepId) ? input.stepId : undefined;
  return { runId, stepId };
}
/** 每用户共享 fence 上限，防止 deviceSessionId 枚举撑爆短 TTL 存储。 */
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
    // 方案 16 §10.3：主动介入强度与静默时段。
    interventionLevel: row.interventionLevel,
    quietHours: row.quietHours ?? undefined,
  };
}

function emptyAccountState(): CompanionAccountStateV1 {
  return {
    revision: 0,
    epoch: 0,
    globalEnabled: true,
    interventionLevel: "moderate",
    quietHours: undefined,
  };
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
          const refs = sanitizeOnboardingRefs(input);
          const activeRun = buildActiveRun({
            entryMode: "first_run",
            runId: refs.runId ?? randomToken(),
            stepId: refs.stepId ?? INITIAL_ONBOARDING_STEP_ID,
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
          const refs = sanitizeOnboardingRefs(input);
          const activeRun = buildActiveRun({
            entryMode: "manual_replay",
            runId: refs.runId ?? randomToken(),
            stepId: refs.stepId ?? INITIAL_ONBOARDING_STEP_ID,
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
 * - global off（globalEnabled false）时 epoch 单调递增，并在同一 DB 事务内
 *   写入 PostgreSQL NOTIFY；账号 SSE 在各 API 进程内 fan-out 到 active devices。
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
          epoch: patch.globalEnabled === false ? 1 : 0,
          globalEnabled: patch.globalEnabled ?? true,
          presence: patch.presence ?? null,
          suggestionPause: patch.suggestionPause ?? null,
          suppression: patch.suppression ?? null,
          animationVoiceOff: mergeAnimationVoiceOff(null, patch),
          notificationBoundary: patch.notificationBoundary ?? null,
          updatedAt: now,
        })
        .returning();
      if (!created.globalEnabled) {
        await notifyGlobalOffBroadcast(tx, userId, created.epoch);
      }
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
        // 方案 16 §10.3：主动介入强度与静默时段。
        interventionLevel: patch.interventionLevel ?? row.interventionLevel,
        quietHours: patch.quietHours !== undefined ? patch.quietHours : row.quietHours,
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

    if (globalOffApplied) await notifyGlobalOffBroadcast(tx, userId, updated.epoch);
    return serializeAccount(updated);
  });
}

/**
 * 查询钩子：当前 account epoch。供设备侧校验 surfaceEpoch 是否过期
 * （账号 SSE 撤销与迟到结果丢弃）。
 */
export async function getAccountEpoch(userId: string, workspaceId: string): Promise<number> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const row = await fetchAccountRow(tx, userId);
    return row?.epoch ?? 0;
  });
}

async function notifyGlobalOffBroadcast(
  tx: ApiTransaction,
  userId: string,
  epoch: number,
): Promise<void> {
  // pg_notify is part of the same transaction as the epoch update. PostgreSQL
  // delivers it only after commit, so a device can never receive a revocation
  // for an update that later rolls back; other API replicas receive it through
  // the process-level LISTEN fan-out.
  await tx.execute(sql`
    select pg_notify(
      ${COMPANION_ACCOUNT_NOTIFY_CHANNEL},
      ${JSON.stringify({ userId, epoch })}
    )
  `);
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

// ─── Device runtime-fence（短 TTL、跨实例共享）────────────────────────────

interface RuntimeFenceRecord {
  deviceSessionId: string;
  surfaceEpoch: number;
  createdAt: string;
  expiresAt: string;
}

/**
 * 共享存储：Postgres 短 TTL 表，不保存 page/entity/content。
 * 按 user 的事务 advisory lock 保证多 API 实例下的 64 条上限和单调 epoch
 * 更新仍然成立；过期行在每次读写时清理。
 */
function serializeRuntimeFence(row: typeof companionRuntimeFences.$inferSelect): RuntimeFenceRecord {
  return {
    deviceSessionId: row.deviceSessionId,
    surfaceEpoch: row.surfaceEpoch,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * 创建/续期一条 device-session runtime fence。authenticated 客户端发送
 * 短生命周期 deviceSessionId + surfaceEpoch，服务端用它取消该设备尚未开始
 * 或可取消的 Companion 调用；不写账号偏好。
 */
export async function createRuntimeFence(
  userId: string,
  workspaceId: string,
  req: RuntimeFenceRequest,
): Promise<RuntimeFenceResponse> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    // Serialize all writes for one user across API instances. This makes the
    // per-user cap and oldest-row eviction deterministic without a process
    // local cache or a Redis dependency.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`companion-runtime-fence:${userId}`}, 0)
      )
    `);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + req.ttlSeconds * 1000);
    await tx.delete(companionRuntimeFences).where(and(
      eq(companionRuntimeFences.userId, userId),
      lte(companionRuntimeFences.expiresAt, now),
    ));

    const existing = await tx
      .select()
      .from(companionRuntimeFences)
      .where(and(
        eq(companionRuntimeFences.userId, userId),
        eq(companionRuntimeFences.deviceSessionId, req.deviceSessionId),
      ))
      .limit(1);

    if (!existing[0]) {
      const active = await tx
        .select({ id: companionRuntimeFences.id })
        .from(companionRuntimeFences)
        .where(and(
          eq(companionRuntimeFences.userId, userId),
          gt(companionRuntimeFences.expiresAt, now),
        ))
        .orderBy(asc(companionRuntimeFences.expiresAt), asc(companionRuntimeFences.id));
      if (active.length >= RUNTIME_FENCE_MAX_PER_USER && active[0]) {
        await tx.delete(companionRuntimeFences).where(eq(companionRuntimeFences.id, active[0].id));
      }
    }

    const row = existing[0]
      ? (await tx
          .update(companionRuntimeFences)
          .set({
            // A retried/late request must never move a device backwards.
            surfaceEpoch: Math.max(existing[0].surfaceEpoch, req.surfaceEpoch),
            createdAt: now,
            expiresAt,
          })
          .where(eq(companionRuntimeFences.id, existing[0].id))
          .returning())[0]
      : (await tx
          .insert(companionRuntimeFences)
          .values({
            userId,
            deviceSessionId: req.deviceSessionId,
            surfaceEpoch: req.surfaceEpoch,
            createdAt: now,
            expiresAt,
          })
          .returning())[0];

    if (!row) throw new Error("runtime fence write returned no row");
    const serialized = serializeRuntimeFence(row);
    return {
      deviceSessionId: serialized.deviceSessionId,
      surfaceEpoch: serialized.surfaceEpoch,
      ttlSeconds: req.ttlSeconds,
      createdAt: serialized.createdAt,
      expiresAt: serialized.expiresAt,
    };
  });
}

/** 查询钩子：该 device session 是否在有效 fence 内（过期即返回 null）。 */
export async function getActiveRuntimeFence(
  userId: string,
  workspaceId: string,
  deviceSessionId: string,
): Promise<RuntimeFenceRecord | null> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const now = new Date();
    // F5（审计 #15）：读路径纯 SELECT——过期行的物理清理统一由写路径
    // createRuntimeFence（以及将来的维护任务）负责，读路径不再突变表。
    const row = (await tx
      .select()
      .from(companionRuntimeFences)
      .where(and(
        eq(companionRuntimeFences.userId, userId),
        eq(companionRuntimeFences.deviceSessionId, deviceSessionId),
        gt(companionRuntimeFences.expiresAt, now),
      ))
      .limit(1))[0];
    return row ? serializeRuntimeFence(row) : null;
  });
}

/** 查询钩子：该用户全部有效 fence（供广播/撤销逻辑使用）。 */
export async function listActiveRuntimeFences(
  userId: string,
  workspaceId: string,
): Promise<RuntimeFenceRecord[]> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const now = new Date();
    // F5（审计 #15）：读路径纯 SELECT——过期行的物理清理统一由写路径
    // createRuntimeFence（以及将来的维护任务）负责，读路径不再突变表。
    const rows = await tx
      .select()
      .from(companionRuntimeFences)
      .where(and(
        eq(companionRuntimeFences.userId, userId),
        gt(companionRuntimeFences.expiresAt, now),
      ))
      .orderBy(asc(companionRuntimeFences.expiresAt), asc(companionRuntimeFences.deviceSessionId));
    return rows.map(serializeRuntimeFence);
  });
}

export type { RuntimeFenceRecord };

// ─── 任务 14：作答模态偏好（设置 → 伴星，跨设备一致；Owner 决策 4）──────

/** user_learning_preferences 表（迁移 0074；镜像树未同步，模块内声明）。 */
const userLearningPreferencesTable = pgTable("user_learning_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  workspaceId: uuid("workspace_id"),
  explicitPreferences: jsonb("explicit_preferences").$type<Record<string, unknown>>(),
  suggestedPreferences: jsonb("suggested_preferences").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 07-9 冻结键：default_input_priority（voice/touch_structure/text；any=未设置） */
const ANSWER_MODE_PREFERENCE_KEY = "default_input_priority" as const;
const ANSWER_MODE_PREFERENCE_VALUES = new Set(["voice", "touch_structure", "text"]);

/**
 * 读作答模态偏好（account 级跨设备一致，workspace_id IS NULL）。
 * "any" = 未设置（跟随安排，Supervisor 默认编排）。
 */
export async function getAnswerModePreference(
  userId: string,
  workspaceId: string,
): Promise<{ preference: "voice" | "silent" | "text" | "any"; updatedAt: string | null }> {
  // RLS（迁移 0075）：account 级行（workspace_id IS NULL）在任意 workspace
  // 上下文可读（policy：user_id 匹配 AND (workspace_id IS NULL OR 等于上下文)）——
  // 跨设备一致正是依赖该行；事务上下文必须传真实 UUID（空串会被
  // normalizeContextUuid 拒绝）。
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const rows = await tx
      .select({ explicitPreferences: userLearningPreferencesTable.explicitPreferences, updatedAt: userLearningPreferencesTable.updatedAt })
      .from(userLearningPreferencesTable)
      .where(and(
        eq(userLearningPreferencesTable.userId, userId),
        sql`${userLearningPreferencesTable.workspaceId} IS NULL`,
      ))
      .limit(1);
    const row = rows[0];
    const raw = row?.explicitPreferences?.[ANSWER_MODE_PREFERENCE_KEY];
    const stored = typeof raw === "string" && ANSWER_MODE_PREFERENCE_VALUES.has(raw) ? raw : null;
    // touch_structure（触控结构操作）即 silent 模态（05-1 静音结构化 proof）。
    const preference = stored === "voice" ? "voice" as const
      : stored === "touch_structure" ? "silent" as const
      : stored === "text" ? "text" as const
      : "any" as const;
    return {
      preference,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });
}

/**
 * 写作答模态偏好（upsert account 级行；CAS 由行锁保证）。
 * "any" → 删除该键（回跟随安排）。
 */
export async function setAnswerModePreference(
  userId: string,
  workspaceId: string,
  preference: "voice" | "silent" | "text" | "any",
): Promise<{ preference: "voice" | "silent" | "text" | "any"; updatedAt: string }> {
  const storedValue = preference === "any" ? undefined
    : preference === "silent" ? "touch_structure"
    : preference;
  // RLS 同上：account 级行（workspace_id IS NULL）在任意 workspace 上下文可写。
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const now = new Date();
    const existing = await tx
      .select()
      .from(userLearningPreferencesTable)
      .where(and(
        eq(userLearningPreferencesTable.userId, userId),
        sql`${userLearningPreferencesTable.workspaceId} IS NULL`,
      ))
      .for("update");
    const row = existing[0];
    const explicit = { ...(row?.explicitPreferences ?? {}) };
    if (storedValue === undefined) {
      delete explicit[ANSWER_MODE_PREFERENCE_KEY];
    } else {
      explicit[ANSWER_MODE_PREFERENCE_KEY] = storedValue;
    }
    if (!row) {
      await tx.insert(userLearningPreferencesTable).values({
        userId,
        explicitPreferences: explicit,
        suggestedPreferences: {},
        updatedAt: now,
      });
    } else {
      await tx
        .update(userLearningPreferencesTable)
        .set({ explicitPreferences: explicit, updatedAt: now })
        .where(eq(userLearningPreferencesTable.id, row.id));
    }
    return { preference, updatedAt: now.toISOString() };
  });
}
