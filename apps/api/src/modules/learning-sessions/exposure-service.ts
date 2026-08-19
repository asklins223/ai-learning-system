/**
 * 任务 02-8：learning_unit_exposure aggregate/guard（§7.6）
 *
 * 冻结规则（01-2 §10.2 同锁域竞态）：
 * - contentExposureKey = H(workspaceId, userId, keyPointId,
 *   publishedContentRevision, normalizedClaimHash, sortedEvidenceContentHashes)，
 *   **不得包含 Scene、rubric、provider、model 或 assistance policy 版本**；
 * - `enter-practice/reveal` 与 `confirm-and-lock/submit` 锁同一
 *   `(workspaceId, userId, contentExposureKey)` learning-unit guard 和当前
 *   probe row，固定锁序（先 exposure aggregate 锁，后 probe row FOR UPDATE）
 *   并使用 user action nonce；
 *   - **lock 先赢**：冻结 pre-exposure snapshot，之后 reveal 不追溯污染已锁
 *     artifact 但写 exposure/cooldown；
 *   - **assistance 先赢**：事务提交后才允许返回任何内容，之后 lock 必须看到
 *     practice-only；
 * - exposure 跨页面、设备、Session、Scene/policy rollover 和重开持久；共享
 *   evidence 通过确定性 dependency ledger 传播到受影响 content exposure keys；
 * - 旧 question-first 与新 Episode 读写同一 `learning_unit_exposure` aggregate
 *   和 guard，**不能靠切换入口重置**。
 *
 * 实现策略（尽量纯函数化以便单测）：
 * - computeContentExposureKey / revealTransition / lockTransition /
 *   buildGuardLockKey / computeNonceHash 都是纯函数，不依赖 DB；
 * - learningUnitGuard 执行固定锁序（guard 锁 → probe row 锁 → 读 aggregate →
 *   调 transition → CAS 写回），DB 交互全部走可注入的 ExposureRepository；
 * - revealPath / lockPath 是 guard 之上的两个竞态分支入口（legacy/new 共用）；
 * - propagateExposureDependency 写确定性 dependency ledger（幂等边）。
 *
 * 不写掌握/schedule 直接真值：正式 outcome/attempt/schedule 仍落现有
 * validation/review 域；本模块只承载 learning-unit 的 exposure 生命周期。
 */

import { and, eq, sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ApiTransaction } from "../../db/client.ts";
import { sha256Hex } from "@ailearn/shared/content-hash";

// ─── 表定义（与迁移 0077 一致；apps/api schema 镜像树未同步新表，同 02-3 模式）──

export const learningUnitExposureTable = pgTable("learning_unit_exposure", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  contentExposureKey: text("content_exposure_key").notNull(),
  assistanceSnapshot: jsonb("assistance_snapshot").$type<LearningUnitAssistanceSnapshot>(),
  lockedArtifactRef: text("locked_artifact_ref"),
  lastRevealedAt: timestamp("last_revealed_at", { withTimezone: true }),
  lastLockedAt: timestamp("last_locked_at", { withTimezone: true }),
  assistedAt: timestamp("assisted_at", { withTimezone: true }),
  practiceOnlySince: timestamp("practice_only_since", { withTimezone: true }),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  exposureCount: integer("exposure_count").notNull().default(0),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const learningExposureDependencyLedgerTable = pgTable(
  "learning_exposure_dependency_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceContentExposureKey: text("source_content_exposure_key").notNull(),
    affectedContentExposureKey: text("affected_content_exposure_key").notNull(),
    sharedEvidenceRef: text("shared_evidence_ref").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// ─── pre-exposure snapshot（与 packages/db schema learning-exposure.ts 一致）──

export type LearningUnitAssistanceSnapshot = {
  assistanceLevel: string; // none | content_assisted | practice_only
  contentAssisted: boolean;
  capturedAt: string;
  capturedBy: "lock" | "assistance";
  reasonCodes?: string[];
};

// ─── 类型 ───────────────────────────────────────────────────────────────

/** 两条写入口（旧 question-first / 新 Episode），共用同一 aggregate。 */
export type ExposureAccessPath = "legacy_question_first" | "new_episode";

/** learning_unit_exposure 行的最小只读状态（guard 内读取后传入 transition） */
export interface LearningUnitExposureState {
  workspaceId: string;
  userId: string;
  contentExposureKey: string;
  assistanceSnapshot: LearningUnitAssistanceSnapshot | null;
  lockedArtifactRef: string | null;
  lastRevealedAt: Date | null;
  lastLockedAt: Date | null;
  assistedAt: Date | null;
  practiceOnlySince: Date | null;
  cooldownUntil: Date | null;
  exposureCount: number;
  revision: number;
}

/** 一次写回 aggregate 的字段 patch（revision 由 write 统一 +1） */
export interface ExposurePatch {
  assistanceSnapshot?: LearningUnitAssistanceSnapshot | null;
  lockedArtifactRef?: string | null;
  lastRevealedAt?: Date | null;
  lastLockedAt?: Date | null;
  assistedAt?: Date | null;
  practiceOnlySince?: Date | null;
  cooldownUntil?: Date | null;
  exposureCount?: number;
}

/** guard 入参：同锁域 + 当前 probe row + user action nonce + revision CAS */
export interface ExposureGuardContext {
  workspaceId: string;
  userId: string;
  contentExposureKey: string;
  userActionNonce: string;
  /** 乐观并发：必须等于 aggregate 当前 revision（01-3 §2.3 CAS） */
  baseRevision: number;
  /** 当前 probe row id（固定锁序第二步 FOR UPDATE）；无 probe 时可省略 */
  probeId?: string | null;
  /** 入口（legacy/new 共用同一 aggregate，此处仅审计） */
  path: ExposureAccessPath;
  now?: Date;
}

// ─── 纯函数：contentExposureKey（公式冻结，§7.6）──────────────────────────

const EXPOSURE_KEY_PREFIX = "cex:";
// 轻微·14（round-4）：listAffectedKeys 单源最多返回的受影响 key 条数（防御性上限）。
const EXPOSURE_LEDGER_AFFECTED_LIMIT = 500;

/**
 * 计算稳定 exposure 键。
 *
 * 公式（冻结）：H(workspaceId, userId, keyPointId, publishedContentRevision,
 * normalizedClaimHash, sortedEvidenceContentHashes)。
 * - evidence content hashes **内部再排序**后参与哈希，保证乱序输入幂等；
 * - **不得包含 Scene、rubric、provider、model 或 assistance policy 版本**
 *   （本函数签名不含这些维度；Scene/policy rollover 后仍命中同一 key）；
 * - 输出 `cex:{sha256}`，确定性且与 artifact hash 前缀区分。
 */
export function computeContentExposureKey(input: {
  workspaceId: string;
  userId: string;
  keyPointId: string;
  publishedContentRevision: number | string;
  normalizedClaimHash: string;
  sortedEvidenceContentHashes: readonly string[];
}): string {
  const { workspaceId, userId, keyPointId } = input;
  const revision = input.publishedContentRevision;
  const claimHash = input.normalizedClaimHash;
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    throw new ExposureGuardError("workspaceId 不能为空", "invalid_argument");
  }
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new ExposureGuardError("userId 不能为空", "invalid_argument");
  }
  if (typeof keyPointId !== "string" || keyPointId.trim() === "") {
    throw new ExposureGuardError("keyPointId 不能为空", "invalid_argument");
  }
  if (
    (typeof revision !== "number" && typeof revision !== "string")
    || String(revision).trim() === ""
  ) {
    throw new ExposureGuardError("publishedContentRevision 非法", "invalid_argument");
  }
  if (typeof claimHash !== "string" || claimHash.trim() === "") {
    throw new ExposureGuardError("normalizedClaimHash 不能为空", "invalid_argument");
  }
  if (!Array.isArray(input.sortedEvidenceContentHashes)) {
    throw new ExposureGuardError("sortedEvidenceContentHashes 必须是数组", "invalid_argument");
  }
  if (input.sortedEvidenceContentHashes.some((hash) => typeof hash !== "string" || hash.trim() === "")) {
    throw new ExposureGuardError("evidence content hash 非法", "invalid_argument");
  }
  // 内部排序保证幂等（即使调用方传入乱序）。
  const sortedEvidence = [...input.sortedEvidenceContentHashes].sort();
  const canonical = [
    `ws:${workspaceId}`,
    `user:${userId}`,
    `kp:${keyPointId}`,
    `rev:${String(revision)}`,
    `claim:${claimHash}`,
    `evidence:${sortedEvidence.join(",")}`,
  ].join("|");
  return EXPOSURE_KEY_PREFIX + sha256Hex(canonical);
}

// ─── 纯函数：guard 锁序 / user action nonce ──────────────────────────────

/**
 * learning-unit guard 的 advisory lock 键（与 withSessionAdvisoryLock 的
 * hashtextextended 风格一致，但用事务级 pg_advisory_xact_lock 保持与
 * workspace transaction 同一连接/RLS 上下文）。
 */
export function buildGuardLockKey(workspaceId: string, userId: string, contentExposureKey: string): string {
  return `learning-unit-exposure:${workspaceId}:${userId}:${contentExposureKey}`;
}

/** user action nonce 的绑定哈希：同一 (key, nonce) 重复请求幂等判定用。 */
export function computeNonceHash(contentExposureKey: string, userActionNonce: string): string {
  return sha256Hex(`nonce:${userActionNonce}|key:${contentExposureKey}`);
}

function validateUserActionNonce(nonce: string): void {
  if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) {
    throw new ExposureGuardError(
      "userActionNonce 必须为 8-128 字符的字符串",
      "invalid_nonce",
    );
  }
}

// ─── 纯函数：reveal transition（assistance 路径）──────────────────────────

export interface RevealAction {
  userActionNonce: string;
  now: Date;
  /** reveal 后的冷却时长（策略由调用方定，本模块不硬编码掌握/schedule 真值） */
  cooldownMs: number;
}

export type RevealOutcome =
  | {
      allowed: true;
      /** 返回给调用方的内容等级 */
      contentLevel: "full" | "practice_only";
      /** 本次是否首次激活 assistance（触发 practiceOnlySince） */
      assistanceActivated: boolean;
      /** 是否命中已锁 artifact（不追溯污染，但写 exposure/cooldown） */
      sawAlreadyLocked: boolean;
      nonceHash: string;
      patch: ExposurePatch;
    }
  | {
      allowed: false;
      reason: "cooldown";
      nonceHash: string;
      patch: ExposurePatch;
    };

/**
 * reveal（enter-practice/reveal，assistance 路径）的状态转移（纯函数）。
 *
 * 竞态规则（01-2 §10.2）：
 * - **lock 先赢**（state 已锁）：reveal **不追溯污染已锁 artifact**
 *   （不改 assistanceSnapshot / lockedArtifactRef），但写 exposure/cooldown
 *   （lastRevealedAt、exposureCount+1、cooldownUntil）；
 * - **assistance 先赢**（state 无锁、无 practiceOnly）：写 assistedAt +
 *   practiceOnlySince + 降级 snapshot，之后任何 lock 必须看到 practice-only；
 * - 已 practice-only：继续 reveal 只计数/更新 cooldown，不重复激活；
 * - 冷却期内（now < cooldownUntil）：blocked，不返回内容。
 */
export function revealTransition(
  state: LearningUnitExposureState,
  action: RevealAction,
): RevealOutcome {
  validateUserActionNonce(action.userActionNonce);
  const nonceHash = computeNonceHash(state.contentExposureKey, action.userActionNonce);
  const now = action.now;
  if (state.cooldownUntil !== null && now.getTime() < state.cooldownUntil.getTime()) {
    return { allowed: false, reason: "cooldown", nonceHash, patch: {} };
  }

  const patch: ExposurePatch = {
    lastRevealedAt: now,
    exposureCount: state.exposureCount + 1,
    cooldownUntil: new Date(now.getTime() + action.cooldownMs),
  };
  const sawAlreadyLocked =
    state.lockedArtifactRef !== null || state.assistanceSnapshot?.capturedBy === "lock";

  // assistance 已激活（曾先赢）：practice-only 态继续 reveal，不重复激活。
  if (state.practiceOnlySince !== null) {
    return {
      allowed: true,
      contentLevel: "practice_only",
      assistanceActivated: false,
      sawAlreadyLocked,
      nonceHash,
      patch,
    };
  }

  // 已锁（lock 先赢）：不追溯污染已锁 artifact，仅写 exposure/cooldown。
  if (sawAlreadyLocked) {
    return {
      allowed: true,
      contentLevel: "full",
      assistanceActivated: false,
      sawAlreadyLocked: true,
      nonceHash,
      patch,
    };
  }

  // 首次 reveal = assistance 先赢：冻结降级 snapshot + practice-only。
  const snapshot: LearningUnitAssistanceSnapshot = {
    assistanceLevel: "content_assisted",
    contentAssisted: true,
    capturedAt: now.toISOString(),
    capturedBy: "assistance",
    reasonCodes: ["assistance_first_reveal"],
  };
  return {
    allowed: true,
    contentLevel: "practice_only",
    assistanceActivated: true,
    sawAlreadyLocked: false,
    nonceHash,
    patch: {
      ...patch,
      assistanceSnapshot: snapshot,
      assistedAt: now,
      practiceOnlySince: now,
    },
  };
}

// ─── 纯函数：lock transition（confirm-and-lock/submit 路径）───────────────

export interface LockAction {
  userActionNonce: string;
  now: Date;
  /** 要锁定的 artifact opaque ref（01-2 §6.2） */
  lockedArtifactRef: string;
}

export type LockOutcome =
  | {
      allowed: true;
      /** assistance 先赢后 lock 必须看到 practice-only */
      practiceOnly: boolean;
      /** 幂等重放：同 key 已锁过 */
      alreadyLocked: boolean;
      nonceHash: string;
      patch: ExposurePatch;
    }
  | { allowed: false; reason: "invalid_ref"; nonceHash: string; patch: ExposurePatch };

/**
 * lock（confirm-and-lock/submit）的状态转移（纯函数）。
 *
 * 竞态规则（01-2 §10.2）：
 * - **lock 先赢**（state 无 practiceOnly、无锁）：冻结 pre-exposure snapshot
 *   （capturedBy='lock'、contentAssisted=false），设置 lockedArtifactRef /
 *   lastLockedAt；
 * - **assistance 先赢**（state.practiceOnlySince 非空）：lock 必须看到
 *   practice-only —— 不冻结正式 snapshot、不写 lockedArtifactRef；
 * - 已锁（幂等重放）：不覆盖已锁 ref（不污染）。
 */
export function lockTransition(
  state: LearningUnitExposureState,
  action: LockAction,
): LockOutcome {
  validateUserActionNonce(action.userActionNonce);
  const nonceHash = computeNonceHash(state.contentExposureKey, action.userActionNonce);
  const ref = action.lockedArtifactRef;
  if (typeof ref !== "string" || ref.trim() === "" || !ref.startsWith("artifact:")) {
    return { allowed: false, reason: "invalid_ref", nonceHash, patch: {} };
  }

  // 幂等重放：已锁过，不覆盖（不污染）。
  if (state.lockedArtifactRef !== null) {
    return { allowed: true, practiceOnly: false, alreadyLocked: true, nonceHash, patch: {} };
  }

  // assistance 先赢：lock 必须看到 practice-only。
  if (state.practiceOnlySince !== null) {
    return { allowed: true, practiceOnly: true, alreadyLocked: false, nonceHash, patch: {} };
  }

  // lock 先赢：冻结 pre-exposure snapshot。
  const snapshot: LearningUnitAssistanceSnapshot = {
    assistanceLevel: "none",
    contentAssisted: false,
    capturedAt: action.now.toISOString(),
    capturedBy: "lock",
    reasonCodes: ["pre_exposure_frozen"],
  };
  return {
    allowed: true,
    practiceOnly: false,
    alreadyLocked: false,
    nonceHash,
    patch: {
      assistanceSnapshot: snapshot,
      lockedArtifactRef: ref,
      lastLockedAt: action.now,
    },
  };
}

// ─── 可注入 repository（DB 交互封装，单测用内存实现）───────────────────────

export interface ExposureRepository {
  /** guard 锁序第一步：获取 learning-unit guard（同锁域 advisory lock） */
  acquireExposureGuard(context: ExposureGuardContext): Promise<void>;
  /** guard 锁序第二步：锁定当前 probe row（FOR UPDATE） */
  lockProbeRow(context: ExposureGuardContext, probeId: string): Promise<void>;
  /** 读或创建 aggregate 行（新建 revision=0） */
  getOrCreateExposure(context: ExposureGuardContext): Promise<LearningUnitExposureState>;
  /** CAS 写回：revision 必须等于 expectedRevision，否则抛 STALE_REVISION */
  writeExposure(
    context: ExposureGuardContext,
    expectedRevision: number,
    patch: ExposurePatch,
  ): Promise<LearningUnitExposureState>;
  /** dependency ledger 幂等写边 */
  recordDependency(
    workspaceId: string,
    sourceContentExposureKey: string,
    affectedContentExposureKey: string,
    sharedEvidenceRef: string,
  ): Promise<void>;
  /** 2026-08-11：批量记录依赖边（单条多行 INSERT，替代循环逐条） */
  recordDependencies(
    workspaceId: string,
    sourceContentExposureKey: string,
    edges: ReadonlyArray<{ affectedContentExposureKey: string; sharedEvidenceRef: string }>,
  ): Promise<void>;
  /** 确定性传播：某 source 影响的所有 affected keys（按 key 排序） */
  listAffectedKeys(workspaceId: string, sourceContentExposureKey: string): Promise<string[]>;
}

// ─── learningUnitGuard：固定锁序 + CAS ───────────────────────────────────

export interface ExposureGuardSession {
  context: ExposureGuardContext;
  state: LearningUnitExposureState;
  /** 事务提交后才允许返回任何内容（assistance 先赢语义由调用方在提交后落地） */
  write(patch: ExposurePatch): Promise<LearningUnitExposureState>;
}

/**
 * 执行固定锁序并带 user action nonce：
 * 1. acquireExposureGuard（learning-unit guard，同锁域）；
 * 2. lockProbeRow（当前 probe row FOR UPDATE）；
 * 3. 读 aggregate（getOrCreateExposure）；
 * 4. revision CAS 校验（baseRevision 必须等于当前 revision）；
 * 5. 在锁内执行 operation（调用方调 transition 并用 write 落 patch）。
 */
export async function learningUnitGuard<T>(
  context: ExposureGuardContext,
  repository: ExposureRepository,
  operation: (session: ExposureGuardSession) => Promise<T>,
): Promise<T> {
  validateUserActionNonce(context.userActionNonce);
  if (context.contentExposureKey.trim() === "") {
    throw new ExposureGuardError("contentExposureKey 不能为空", "invalid_argument");
  }
  const now = context.now ?? new Date();

  await repository.acquireExposureGuard(context);
  if (context.probeId !== undefined && context.probeId !== null) {
    await repository.lockProbeRow(context, context.probeId);
  }
  const state = await repository.getOrCreateExposure(context);
  if (state.revision !== context.baseRevision) {
    throw new ExposureGuardError(
      `revision CAS 失败：base=${context.baseRevision}，当前=${state.revision}`,
      "stale_revision",
    );
  }

  const session: ExposureGuardSession = {
    context: { ...context, now },
    state,
    async write(patch) {
      const next = await repository.writeExposure(context, state.revision, patch);
      session.state = next;
      return next;
    },
  };
  return operation(session);
}

// ─── revealPath / lockPath：两个竞态入口（legacy/new 共用同一 aggregate）──

export interface RevealPathOptions {
  cooldownMs: number;
}

export async function revealPath(
  context: ExposureGuardContext,
  repository: ExposureRepository,
  options: RevealPathOptions,
): Promise<RevealOutcome> {
  return learningUnitGuard(context, repository, async (session) => {
    const outcome = revealTransition(session.state, {
      userActionNonce: context.userActionNonce,
      now: context.now ?? new Date(),
      cooldownMs: options.cooldownMs,
    });
    if (Object.keys(outcome.patch).length > 0) {
      await session.write(outcome.patch);
    }
    return outcome;
  });
}

export async function lockPath(
  context: ExposureGuardContext,
  repository: ExposureRepository,
  lockedArtifactRef: string,
): Promise<LockOutcome> {
  return learningUnitGuard(context, repository, async (session) => {
    const outcome = lockTransition(session.state, {
      userActionNonce: context.userActionNonce,
      now: context.now ?? new Date(),
      lockedArtifactRef,
    });
    if (Object.keys(outcome.patch).length > 0) {
      await session.write(outcome.patch);
    }
    return outcome;
  });
}

// ─── 确定性 dependency ledger 传播（§7.6）────────────────────────────────

/**
 * 写 dependency ledger：共享 evidence 使 source → affected 之间建立 dependency
 * 边。输入按 (affectedKey, sharedEvidenceRef) 确定性排序后逐个幂等 upsert，
 * 同一条边重复调用不产生新行。
 */
export async function propagateExposureDependency(
  repository: ExposureRepository,
  workspaceId: string,
  sourceContentExposureKey: string,
  edges: ReadonlyArray<{ affectedContentExposureKey: string; sharedEvidenceRef: string }>,
): Promise<void> {
  const sorted = [...edges].sort((a, b) =>
    a.affectedContentExposureKey < b.affectedContentExposureKey ? -1
    : a.affectedContentExposureKey > b.affectedContentExposureKey ? 1
    : a.sharedEvidenceRef < b.sharedEvidenceRef ? -1
    : a.sharedEvidenceRef > b.sharedEvidenceRef ? 1
    : 0,
  );
  // 2026-08-11：批量多行 INSERT（此前循环逐条，一次一条往返）
  await repository.recordDependencies(workspaceId, sourceContentExposureKey, sorted);
}

// ─── PostgreSQL 默认 repository（在 workspace transaction 内使用）────────

/**
 * 默认 DB 实现（调用方传入已设置 RLS 上下文的 tx，来自 withWorkspaceTransaction）。
 * guard 锁用事务级 pg_advisory_xact_lock（与 withSessionAdvisoryLock 的
 * hashtextextended 键一致，但保持同一连接/RLS 上下文，事务结束自动释放）。
 */
export function createPgExposureRepository(transaction: ApiTransaction): ExposureRepository {
  const table = learningUnitExposureTable;
  const ledgerTable = learningExposureDependencyLedgerTable;
  return {
    async acquireExposureGuard(context) {
      const lockKey = buildGuardLockKey(
        context.workspaceId,
        context.userId,
        context.contentExposureKey,
      );
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
    },
    async lockProbeRow(context, probeId) {
      // 锁当前 probe row（固定锁序第二步）。调用方传入的 probe 必须属于
      // 同一 workspace/user；RLS FORCE 下不匹配行自然不可见。
      await transaction.execute(
        sql`SELECT id FROM public.learning_session_probes
            WHERE id = ${probeId}
              AND workspace_id = ${context.workspaceId}
              AND user_id = ${context.userId}
            FOR UPDATE`,
      );
    },
    async getOrCreateExposure(context) {
      const rows = await transaction
        .select()
        .from(table)
        .where(
          and(
            eq(table.workspaceId, context.workspaceId),
            eq(table.contentExposureKey, context.contentExposureKey),
          ),
        )
        .limit(1);
      if (rows[0] !== undefined) {
        return rowToState(rows[0]);
      }
      const [created] = await transaction
        .insert(table)
        .values({
          workspaceId: context.workspaceId,
          userId: context.userId,
          contentExposureKey: context.contentExposureKey,
        })
        .returning();
      return rowToState(created);
    },
    async writeExposure(context, expectedRevision, patch) {
      const setValues: Record<string, unknown> = {
        updatedAt: new Date(),
        revision: expectedRevision + 1,
      };
      if (patch.assistanceSnapshot !== undefined) setValues.assistanceSnapshot = patch.assistanceSnapshot;
      if (patch.lockedArtifactRef !== undefined) setValues.lockedArtifactRef = patch.lockedArtifactRef;
      if (patch.lastRevealedAt !== undefined) setValues.lastRevealedAt = patch.lastRevealedAt;
      if (patch.lastLockedAt !== undefined) setValues.lastLockedAt = patch.lastLockedAt;
      if (patch.assistedAt !== undefined) setValues.assistedAt = patch.assistedAt;
      if (patch.practiceOnlySince !== undefined) setValues.practiceOnlySince = patch.practiceOnlySince;
      if (patch.cooldownUntil !== undefined) setValues.cooldownUntil = patch.cooldownUntil;
      if (patch.exposureCount !== undefined) setValues.exposureCount = patch.exposureCount;

      const rows = await transaction
        .update(table)
        .set(setValues)
        .where(
          and(
            eq(table.workspaceId, context.workspaceId),
            eq(table.contentExposureKey, context.contentExposureKey),
            eq(table.revision, expectedRevision),
          ),
        )
        .returning();
      if (rows[0] === undefined) {
        throw new ExposureGuardError(
          `revision CAS 写回失败：expected=${expectedRevision}`,
          "stale_revision",
        );
      }
      return rowToState(rows[0]);
    },
    async recordDependency(workspaceId, sourceKey, affectedKey, sharedEvidenceRef) {
      await transaction
        .insert(ledgerTable)
        .values({
          workspaceId,
          sourceContentExposureKey: sourceKey,
          affectedContentExposureKey: affectedKey,
          sharedEvidenceRef,
        })
        .onConflictDoNothing();
    },
    async recordDependencies(workspaceId, sourceKey, edges) {
      if (edges.length === 0) return;
      await transaction
        .insert(ledgerTable)
        .values(edges.map((edge) => ({
          workspaceId,
          sourceContentExposureKey: sourceKey,
          affectedContentExposureKey: edge.affectedContentExposureKey,
          sharedEvidenceRef: edge.sharedEvidenceRef,
        })))
        .onConflictDoNothing();
    },
    async listAffectedKeys(workspaceId, sourceKey) {
      // 轻微·14（round-4）：热源边多时 affected key 数组无界增长。加 LIMIT
      // 作为防御性上限（去重后仍可能超过；调用方为低频同步路径，兜底即可）。
      const rows = await transaction
        .select({ affectedContentExposureKey: ledgerTable.affectedContentExposureKey })
        .from(ledgerTable)
        .where(
          and(
            eq(ledgerTable.workspaceId, workspaceId),
            eq(ledgerTable.sourceContentExposureKey, sourceKey),
          ),
        )
        .limit(EXPOSURE_LEDGER_AFFECTED_LIMIT);
      return [...new Set(rows.map((row) => row.affectedContentExposureKey))].sort();
    },
  };
}

function rowToState(row: {
  workspaceId: string;
  userId: string;
  contentExposureKey: string;
  assistanceSnapshot: LearningUnitAssistanceSnapshot | null;
  lockedArtifactRef: string | null;
  lastRevealedAt: Date | null;
  lastLockedAt: Date | null;
  assistedAt: Date | null;
  practiceOnlySince: Date | null;
  cooldownUntil: Date | null;
  exposureCount: number;
  revision: number;
}): LearningUnitExposureState {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    contentExposureKey: row.contentExposureKey,
    assistanceSnapshot: row.assistanceSnapshot,
    lockedArtifactRef: row.lockedArtifactRef,
    lastRevealedAt: row.lastRevealedAt,
    lastLockedAt: row.lastLockedAt,
    assistedAt: row.assistedAt,
    practiceOnlySince: row.practiceOnlySince,
    cooldownUntil: row.cooldownUntil,
    exposureCount: row.exposureCount,
    revision: row.revision,
  };
}

export type ExposureGuardErrorCode =
  | "invalid_argument"
  | "invalid_nonce"
  | "stale_revision";

/** exposure guard 的 fail-closed 错误（风格同 LegacyAdapterError） */
export class ExposureGuardError extends Error {
  readonly code: ExposureGuardErrorCode;

  constructor(message: string, code: ExposureGuardErrorCode) {
    super(message);
    this.name = "ExposureGuardError";
    this.code = code;
  }
}
