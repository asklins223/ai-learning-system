/**
 * 阶段 02（W1）任务 02-9：learning_outbox_events —— 同事务 outbox（§12.2/§12.5）。
 *
 * canonical 事件原则（01-3 冻结记录 §2.3/§5）：
 * - 正式 overall outcome / attempt / schedule 落在现有权威域
 *   （validation_events / review_attempts / understanding_events 及其现行
 *   权威表/枚举），facet projection 只读扩展后的 validation_point_assessments；
 *   **不新增 understanding_evidence_events 作为平行 canonical 真相**；
 * - capability/map projection 由**同事务 outbox** 派生：权威事实与 outbox 行在
 *   同一个数据库事务内写入，投影逻辑只消费 outbox（append-only），因此
 *   相同 canonical event stream 重放必须得到相同 mastery / facet / 星图投影 hash；
 * - 事件 payload 只存 schema action、IDs、hash、版本、计数、usage 和安全摘要，
 *   **不存 raw chain-of-thought / 回答原文**（写入路径由
 *   validateCanonicalEventPayload 白名单强制，见 canonical-events.ts；
 *   数据库层另有 CHECK 防御）。
 *
 * sequence 每 workspace 单调：使用全局 PostgreSQL sequence 的单调子集
 * （同一 workspace 内递增），unique(workspace_id, sequence) 兜底。
 */

import {
  pgTable,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/**
 * outbox payload 允许的 facet 安全摘要（结构化，无原文）。
 * 与 validation_point_assessments 的关系：facet 投影只读权威表；outbox 侧只
 * 存 verdict 枚举 / 数字 / IDs 的摘要，不含 rationale、answer_excerpt 等原文。
 */
export interface FacetSummaryPayload {
  /** validation_question_rubric_items.id（opaque ID） */
  rubricItemId: string;
  /** 可选 key point（opaque ID） */
  keyPointId?: string;
  /** verdict 枚举：covered | partial | missing | contradicted | not_assessable */
  verdict: string;
  /** 0-100 整数置信度 */
  confidence: number;
  /** rubric 版本（版本号，无内容） */
  rubricVersion?: string;
}

/**
 * outbox payload 白名单形状（schema action / IDs / hash / 版本 / 计数 / usage /
 * 安全摘要）。**禁止** raw answer / chain-of-thought / rationale / question
 * 原文等敏感字段——validateCanonicalEventPayload 会拒绝它们。
 */
export interface CanonicalEventPayload {
  /** schema action（如 seen | validated | misunderstood | reviewed | completed） */
  action?: string;
  // ── opaque IDs（不含内容）──
  cardId?: string;
  keyPointId?: string;
  questionId?: string;
  artifactId?: string;
  submissionId?: string;
  rubricItemId?: string;
  reviewScheduleId?: string;
  reviewAttemptId?: string;
  validationEventId?: string;
  evidenceId?: string;
  subjectType?: string;
  subjectId?: string;
  sessionId?: string;
  episodeId?: string;
  probeId?: string;
  exposureKey?: string;
  // ── hash / 版本（content-free 指纹）──
  answerHash?: string;
  artifactHash?: string;
  requestHash?: string;
  idempotencyKey?: string;
  sourceFingerprint?: string;
  rubricVersion?: string;
  reducerVersion?: string;
  policyVersion?: string;
  contractVersion?: string;
  schemaVersion?: string;
  // ── 计数 / usage（数字，无内容）──
  confidence?: number;
  intervalDays?: number;
  generation?: number;
  usageCount?: number;
  exposureCount?: number;
  attemptNumber?: number;
  tokensUsed?: number;
  // ── 安全摘要（只含摘要，禁止原文）──
  outcomeSummary?: string;
  verdictSummary?: string;
  feedbackSummary?: string;
  understandingEffect?: string;
  facetSummaries?: FacetSummaryPayload[];
  // ── 状态枚举码 / 时间 ──
  status?: string;
  skipReasonCode?: string;
  occurredAt?: string;
  nextReviewAt?: string;
}

/**
 * learning_outbox_events：canonical 事件的同事务 outbox（append-only）。
 *
 * - 权威事实本身写 validation_events / review_attempts / understanding_events；
 *   本表只保存安全摘要事件行，用于派生 capability/map projection。
 * - sequence 每 workspace 单调（全局序列的子集），unique(workspace_id, sequence)。
 * - sequence 用 bigint：全局累计可能超过 2^31-1（review 发现），integer 会阻断所有 workspace。
 *   保证一个 workspace 内顺序唯一；processed_at 为空 = 尚未被投影消费。
 * - projection_hash 是事件对三类投影（mastery/facet/map）的确定性贡献指纹，
 *   用于 drift 检测：重放得到相同的 hash 即投影未漂移。
 * - RLS：workspace_id + user_id 双条件（§13.3，user-private-in-workspace）。
 */
export const learningOutboxEvents = pgTable(
  "learning_outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // schema action：validation.event | review.attempt | understanding.event
    eventType: text("event_type").notNull(),
    // 只存安全摘要（白名单强制，见 canonical-events.validateCanonicalEventPayload）
    payload: jsonb("payload").$type<CanonicalEventPayload>().notNull(),
    // 每 workspace 单调递增；由全局序列 nextval 分配（迁移 0078）。
    sequence: bigint("sequence", { mode: "number" }).notNull().default(sql`nextval('public.learning_outbox_events_seq')`),
    // 事件对投影的确定性贡献 hash（drift 检测依据）。
    projectionHash: text("projection_hash").notNull(),
    // 投影消费完成时间；NULL = 未消费（投影派生游标）。
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 每 workspace 的 sequence 唯一 → 该 workspace 内事件顺序唯一。
    workspaceSequenceUnique: uniqueIndex("learning_outbox_workspace_sequence_unique_idx")
      .on(t.workspaceId, t.sequence),
    // 投影派生主查询：按 workspace+user 顺序读取未消费事件。
    workspaceUserIdx: index("learning_outbox_workspace_user_idx")
      .on(t.workspaceId, t.userId, t.sequence),
    // 未消费游标（投影 worker）。
    unprocessedIdx: index("learning_outbox_unprocessed_idx").on(t.processedAt),
    // 按事件类型查询。
    typeIdx: index("learning_outbox_type_idx").on(t.workspaceId, t.eventType, t.sequence),
  }),
);
