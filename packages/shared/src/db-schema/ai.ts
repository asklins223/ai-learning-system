import { pgTable, uuid, text, jsonb, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { artifactStatusEnum, artifactTypeEnum } from "./enums.ts";

/**
 * AI 派生物统一存储（对齐产品文档 §5.5）。
 * 当前 AI 生成结果（学习卡、摘要和解释等）统一落这张表，
 * 记录输入来源、模型、prompt 版本、状态和成本，保证可追溯、可重算、可失效。
 */
export const aiArtifacts = pgTable(
  "ai_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    type: artifactTypeEnum("type").notNull(),
    inputRefs: jsonb("input_refs")
      .$type<{ noteId?: string; noteVersionId?: string; cardId?: string; keyPointId?: string; userId?: string }>()
      .notNull(),
    output: jsonb("output").$type<unknown>().notNull(),
    modelId: text("model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    /** 输入指纹，用于幂等去重（同 input_hash 的 artifact 可复用而不重复调用模型） */
    inputHash: text("input_hash"),
    /** 模型返回的 token 用量（prompt + completion），用于成本统计 */
    costTokens: integer("cost_tokens"),
    status: artifactStatusEnum("status").notNull().default("ready"),
    // ── v0.6 扩展 (计划 §6.6) ──
    parentArtifactId: uuid("parent_artifact_id"), // draft → repair → final lineage
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    typeIdx: index("ai_artifacts_type_idx").on(t.type),
    workspaceIdx: index("ai_artifacts_workspace_idx").on(t.workspaceId),
    inputHashIdx: index("ai_artifacts_input_hash_idx").on(t.inputHash),

    idWorkspaceUnique: uniqueIndex("ai_artifacts_id_workspace_unique").on(t.id, t.workspaceId),}),
);
