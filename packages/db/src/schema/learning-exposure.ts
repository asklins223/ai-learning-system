/**
 * 阶段 02（W1）任务 02-8：learning_unit_exposure aggregate/guard（§7.6）。
 *
 * 对应冻结记录 01-2 §10（Assistance、exposure 与同锁域竞态）：
 * - contentExposureKey 是稳定 exposure 键（见 exposure-service.computeContentExposureKey），
 *   决定同一 (workspaceId, userId, contentExposureKey) learning-unit guard 的锁域；
 * - learning_unit_exposure 是旧 question-first 与新 Episode **共用同一 aggregate**
 *   的落点：exposure 跨页面、设备、Session、Scene/policy rollover 和重开持久，
 *   **不能靠切换入口重置**；
 * - assistanceSnapshot 是 lock 先赢时冻结的 pre-exposure snapshot（后续 reveal
 *   不追溯污染已锁 artifact）；practiceOnlySince 表达 assistance 先赢后的
 *   practice-only 态（之后 lock 必须看到 practice-only）；
 * - learning_exposure_dependency_ledger 是确定性 dependency ledger：共享 evidence
 *   使 affected content exposure key 需要传播 exposure 状态。
 *
 * 不写掌握/schedule 直接真值：正式 outcome/attempt/schedule 仍落现有
 * validation/review 域；本表只承载 learning-unit 的 exposure 生命周期。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./identity.ts";

// ─── pre-exposure snapshot 形状（01-2 §10.2 lock 先赢冻结）────────────────

/**
 * lock 先赢时冻结的 pre-exposure snapshot。
 *
 * 在 exposure 被 reveal 前，lock/confirm-and-lock 一方先赢得 guard 时，把
 * 当时的 assistance 状态固化为不可变的 JSONB 快照，之后任何 reveal 只写
 * exposure/cooldown 字段，**不追溯污染已锁 artifact**（01-2 §10.2）。
 */
export type LearningUnitAssistanceSnapshot = {
  /** 冻结时点的 assistance 级别（none | content_assisted | practice_only） */
  assistanceLevel: string;
  /** 冻结时点是否已提供内容性辅助 */
  contentAssisted: boolean;
  /** 冻结时点（ISO-8601，服务端时间） */
  capturedAt: string;
  /** 该 snapshot 由哪条路径先赢（"lock" | "assistance"），审计/诊断用 */
  capturedBy: "lock" | "assistance";
  /** 附加原因码（如 assistance 先赢的降级原因） */
  reasonCodes?: string[];
};

/**
 * learning_unit_exposure：learning-unit 的 exposure 生命周期 aggregate。
 *
 * 每 (workspace, user, contentExposureKey) 一行（content_exposure_key 全局唯一，
 * 由 workspaceId+userId+... 哈希得到，跨 workspace 冲突为零），revision 乐观
 * 并发递增。旧 question-first 与新 Episode 的 reveal/lock/submit 读写**同一行**。
 *
 * 持久语义（01-2 §10.2）：跨页面、设备、Session、Scene/policy rollover 和重开
 * 不重置；Scene/rubric/provider/model/assistance policy 版本变化**不改变
 * contentExposureKey**（键不包含这些维度），因此 rollover 后仍命中同一 aggregate。
 */
export const learningUnitExposure = pgTable(
  "learning_unit_exposure",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // 稳定 exposure 键（公式冻结，见 exposure-service.computeContentExposureKey）。
    // 全局唯一即"每 user+workspace 至多一个当前 exposure"的最终兜底。
    contentExposureKey: text("content_exposure_key").notNull(),
    // lock 先赢冻结的 pre-exposure snapshot（不可变）；assistance 先赢时也在此
    // 记录 capturedBy='assistance' 的降级 snapshot 以便审计。
    assistanceSnapshot: jsonb("assistance_snapshot")
      .$type<LearningUnitAssistanceSnapshot>(),
    // 已锁 artifact 的 opaque ref（01-2 §6.2 artifact lock 的 exposure 侧引用）。
    lockedArtifactRef: text("locked_artifact_ref"),
    lastRevealedAt: timestamp("last_revealed_at", { withTimezone: true }),
    lastLockedAt: timestamp("last_locked_at", { withTimezone: true }),
    // assistance 先赢：提供内容性辅助的时间点。
    assistedAt: timestamp("assisted_at", { withTimezone: true }),
    // practice-only 生效时间点：存在即该 learning unit 对后续 lock 只见
    // practice-only（01-2 §10.2「assistance 先赢 → lock 必须看到 practice-only」）。
    practiceOnlySince: timestamp("practice_only_since", { withTimezone: true }),
    // reveal 后的冷却截止；冷却期内不再返回内容性揭示。
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    // 累计 reveal 次数（单调递增，跨入口共享，不重置）。
    exposureCount: integer("exposure_count").notNull().default(0),
    // 乐观并发版本：每次写入递增，请求须携带 baseRevision（01-3 §2.3 CAS）。
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // content_exposure_key 全局唯一：旧/新入口、跨 Session/rollover 都命中同一行。
    exposureKeyUnique: uniqueIndex("learning_unit_exposure_key_unique_idx")
      .on(t.workspaceId, t.contentExposureKey),
    // user+workspace 查询路径（guard 主查询）。
    workspaceUserIdx: index("learning_unit_exposure_workspace_user_idx").on(
      t.workspaceId, t.userId,
    ),
    // 冷却/重开持久查询。
    cooldownIdx: index("learning_unit_exposure_cooldown_idx").on(
      t.workspaceId, t.userId, t.cooldownUntil,
    ),
  }),
);

// ─── 确定性 dependency ledger（共享 evidence 传播）────────────────────────

/**
 * learning_exposure_dependency_ledger：确定性 dependency ledger。
 *
 * 共享 evidence 使受影响 learning unit 的 content exposure key 之间产生
 * dependency 边：sourceContentExposureKey → affectedContentExposureKey，
 * 由 sharedEvidenceRef 标识共享 evidence（确定性排序后写入，同一条边幂等）。
 *
 * 用途（01-2 §10.2「共享 evidence 通过确定性 dependency ledger 传播到受影响
 * content exposure keys」）：当 source learning unit 发生 exposure 状态变化
 * （如 reveal/assisted/lock）时，调用方可查询本 ledger 得到受影响 keys，
 * 以同样确定性顺序传播 exposure/cooldown。
 */
export const learningExposureDependencyLedger = pgTable(
  "learning_exposure_dependency_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceContentExposureKey: text("source_content_exposure_key").notNull(),
    affectedContentExposureKey: text("affected_content_exposure_key").notNull(),
    // 共享 evidence 引用（确定性内容 hash 或 ref），同一条边的幂等键。
    sharedEvidenceRef: text("shared_evidence_ref").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 同一条边幂等：source + affected + evidence 唯一（确定性 ledger 语义）。
    edgeUnique: uniqueIndex("learning_exposure_dependency_edge_unique_idx")
      .on(t.workspaceId, t.sourceContentExposureKey, t.affectedContentExposureKey, t.sharedEvidenceRef),
    // 反向查询：某 affected key 的所有 source（传播入口）。
    affectedIdx: index("learning_exposure_dependency_affected_idx").on(
      t.workspaceId, t.affectedContentExposureKey,
    ),
    // 正向查询：某 source 影响的所有 keys（传播出口）。
    sourceIdx: index("learning_exposure_dependency_source_idx").on(
      t.workspaceId, t.sourceContentExposureKey,
    ),
  }),
);
