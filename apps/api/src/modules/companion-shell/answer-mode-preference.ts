/**
 * 任务 14：作答模态偏好（设置 → 伴星，账号级跨设备一致；Owner 决策 4）。
 *
 * 单独成模块的原因不是整洁，是**事务嵌套**：装配目标表面与星图的那几条路径
 * 自己已经跑在 `withWorkspaceTransaction` 里，而且是在**逐个目标的循环**上。
 * 让它们调用 `getAnswerModePreference` 会在已有事务里再开一个事务，并且在
 * 一个列表页里开 N 次。所以这里把"读哪一行、怎么把落库值折成偏好"收在
 * `readAnswerModePreference`（收执行器），外层两条包装各自负责自己的事务边界。
 *
 * RLS（迁移 0075）：account 级行（`workspace_id IS NULL`）在任意 workspace 上下文
 * 可读可写（policy：user_id 匹配 AND (workspace_id IS NULL OR 等于上下文)）——
 * 跨设备一致正是依赖该行；因此走 workspace 事务时上下文必须传真实 UUID
 * （空串会被 `normalizeContextUuid` 拒绝）。
 */
import { and, eq, sql } from "drizzle-orm";
import type { AnswerModePreferenceV1 } from "@ailearn/shared";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { userLearningPreferences } from "@ailearn/shared/db-schema/companion";

/** 07-9 冻结键：default_input_priority（voice/touch_structure/text；any=未设置） */
const ANSWER_MODE_PREFERENCE_KEY = "default_input_priority" as const;
const ANSWER_MODE_PREFERENCE_VALUES = new Set(["voice", "touch_structure", "text"]);

export interface AnswerModePreferenceState {
  preference: AnswerModePreferenceV1;
  updatedAt: string | null;
}

/**
 * 在**调用方的**事务里读偏好（"any" = 未设置，跟随安排）。
 *
 * 只按 userId 过滤、限定 `workspace_id IS NULL` 那一行账号级记录——它不是空间数据，
 * 所以不带 `visibleXxxCondition` 那类判据；RLS 的 user_id 判据在这里是唯一的门。
 */
export async function readAnswerModePreference(
  tx: ApiTransaction,
  userId: string,
): Promise<AnswerModePreferenceState> {
  const rows = await tx
    .select({
      explicitPreferences: userLearningPreferences.explicitPreferences,
      updatedAt: userLearningPreferences.updatedAt,
    })
    .from(userLearningPreferences)
    .where(and(
      eq(userLearningPreferences.userId, userId),
      sql`${userLearningPreferences.workspaceId} IS NULL`,
    ))
    .limit(1);
  const row = rows[0];
  const raw = row?.explicitPreferences?.[ANSWER_MODE_PREFERENCE_KEY];
  const stored = typeof raw === "string" && ANSWER_MODE_PREFERENCE_VALUES.has(raw) ? raw : null;
  // touch_structure（触控结构操作）即 silent 模态（05-1 静音结构化 proof）。
  const preference: AnswerModePreferenceV1 = stored === "voice" ? "voice"
    : stored === "touch_structure" ? "silent"
    : stored === "text" ? "text"
    : "any";
  return {
    preference,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** 读作答模态偏好（自己开 workspace 事务；路由与 IPC 用这一条）。 */
export async function getAnswerModePreference(
  userId: string,
  workspaceId: string,
): Promise<AnswerModePreferenceState> {
  return withWorkspaceTransaction({ workspaceId, userId }, (tx) => readAnswerModePreference(tx, userId));
}

/**
 * 写作答模态偏好（upsert account 级行；CAS 由行锁保证）。
 * "any" → 删除该键（回跟随安排）。
 */
export async function setAnswerModePreference(
  userId: string,
  workspaceId: string,
  preference: AnswerModePreferenceV1,
): Promise<{ preference: AnswerModePreferenceV1; updatedAt: string }> {
  const storedValue = preference === "any" ? undefined
    : preference === "silent" ? "touch_structure"
    : preference;
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const now = new Date();
    const existing = await tx
      .select()
      .from(userLearningPreferences)
      .where(and(
        eq(userLearningPreferences.userId, userId),
        sql`${userLearningPreferences.workspaceId} IS NULL`,
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
      await tx.insert(userLearningPreferences).values({
        userId,
        explicitPreferences: explicit,
        suggestedPreferences: {},
        updatedAt: now,
      });
    } else {
      await tx
        .update(userLearningPreferences)
        .set({ explicitPreferences: explicit, updatedAt: now })
        .where(eq(userLearningPreferences.id, row.id));
    }
    return { preference, updatedAt: now.toISOString() };
  });
}
