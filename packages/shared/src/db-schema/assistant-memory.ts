/**
 * 分层记忆表（文档 16 §10/§21 保留清单 + 22 方案 V2 扩展）。
 *
 * 不复制 Learner Model：每条记忆必须有来源（事件/会话引用）、可审计字段、
 * 删除级联；canonical 学习事实保持不变（记忆删除不影响学习真相）。
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/**
 * 「同一件事」的相似度判据（pg_trgm `similarity`）。
 *
 * 两处读它，且必须同一个数：
 * - api 侧写活记忆时的冲突分组（`memory-service.ts` 的 `markMemoryConflictIfSimilar`）；
 * - worker 抽取器上"用户忽略过的候选别再抽出来"那道守卫（`companion-memory-extractor.ts`）。
 * 各写一个 0.85，迟早一处收紧一处放宽，然后同一句话在一边算重复、另一边算新事。
 */
export const MEMORY_CONTENT_SIMILARITY_THRESHOLD = 0.85;

/**
 * 语义（embedding 余弦）相似度阈值——"换了一种说法的同一件事"（doc 34 L14）。
 *
 * 出处只有一次实测（2026-09-23，dev 库）：`assistant_memory_embeddings` 7 行 / 1 个用户，
 * 两两 21 对，内容逐条核看互不相关 —— cosine similarity **min 0.428 / median 0.517 / max 0.663**。
 * 0.80 明显在那条上界之上、留了一截余量。**n=21 就是 n=21**：它证明"不同的事不会靠近 0.8"，
 * 没有证明"同一件事改写后一定 > 0.8"（那要有真实改写对才量得出来）。
 * 方向是有意的：宁可漏挡（她多点一次"不是我的情况"），不可误挡
 * （误挡会把一条真新记忆永久判死，且没有任何地方能翻回来）。
 */
export const MEMORY_SEMANTIC_SIMILARITY_THRESHOLD = 0.8;

export const assistantMemoryItems = pgTable(
  "assistant_memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // preference | goal | learning_context | interaction_note | episodic
    content: text("content").notNull(),
    /** 来源引用（可审计）：事件 id 或会话 id。 */
    sourceEventId: text("source_event_id"),
    sourceSessionId: uuid("source_session_id"),
    /** 用户显式提供的来源（如目标设定），区别于模型推断。 */
    userStated: boolean("user_stated").notNull().default(false),
    /** 独立来源记忆（无事件/会话来源）由用户明确确认。 */
    userConfirmed: boolean("user_confirmed").notNull().default(false),
    /** 候选记忆（未经确认）不参与主动策略。 */
    candidate: boolean("candidate").notNull().default(false),
    /** 记忆重要性（0-1），影响检索排序。 */
    importance: real("importance").notNull().default(0.5),
    /** 提取置信度（0-1），低于阈值不生成候选。 */
    confidence: real("confidence").notNull().default(0.5),
    /** 可见范围：global | workspace | task。 */
    scope: text("scope").notNull().default("workspace"),
    /**
     * 同一条"弱空间绑定"记忆在各空间的共同身份（0267）。
     *
     * 约定与 `ailearn_fanout_global_companion_memory` 一致：**源行认领自己的 id 作为 key**，
     * 铺出去的副本带同一个 key。0268 的两支同步触发器的条件是
     * `OLD.global_key IS NOT NULL OR NEW.global_key IS NOT NULL`，而"加入/重新加入空间时补铺"
     * 也只挑 `global_key IS NOT NULL` 的行——所以这一位为 NULL 的 global 记忆，
     * 删除/纠正/固定永不扩散，新空间也永远补不到它（doc 34 L9）。
     * 唯一索引 `(workspace_id, global_key) WHERE global_key IS NOT NULL AND deleted_at IS NULL`
     * 由 0267 建在库里。
     */
    globalKey: uuid("global_key"),
    /** 固定记忆：高优先级、不参与衰减。 */
    pinned: boolean("pinned").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    conflictGroup: uuid("conflict_group"),
    embeddingProfileVersion: text("embedding_profile_version"),
    sourceType: text("source_type").notNull().default("model_inferred"),
    /** 气泡“忽略”时间；忽略后 30 天内不重复弹出，管理页仍可见。 */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** embedding 状态：none | pending | ready | failed。 */
    embeddingStatus: text("embedding_status").notNull().default("none"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 内容去重：同一 (kind, content 前缀 hash) 至多一条活跃记忆。
    contentUnique: uniqueIndex("assistant_memory_items_content_unique_idx")
      .on(t.workspaceId, t.userId, t.kind, t.sourceEventId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.sourceEventId} IS NOT NULL`),
    workspaceUserIdx: index("assistant_memory_items_ws_user_idx").on(
      t.workspaceId, t.userId, t.updatedAt,
    ),
  }),
);

/**
 * 语义孪生的判据表达式——**整个仓库只有这一处**把 `<=>` 与阈值拼在一起
 * （doc 34 L14；两边各自写一遍就是"同一句话两个来源"，改一处忘一处必然发生）。
 *
 * @param lhs 左边向量表达式，如 `dv.embedding`
 * @param rhs 右边向量表达式（已是 vector，或带 `::vector` 的自表达）
 */
export function semanticTwinPredicateSql(lhs: string, rhs: string): string {
  return `1 - (${lhs} <=> ${rhs}) > ${MEMORY_SEMANTIC_SIMILARITY_THRESHOLD}`;
}
