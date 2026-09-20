/**
 * 记忆星图查询（22-real-desktop-pet-memory-context-prd-tdd.md §2.6/§14.4）。
 *
 * 只读视图：返回 active/pinned 记忆节点与 memory_links 实体关联；
 * 不做聚合计算，前端 overlay 渲染。默认限制 500 节点。
 */

import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";

export interface MemoryStarMapNode {
  memoryId: string;
  kind: string;
  content: string;
  state: "active" | "pinned";
  importance: number;
  updatedAt: string;
  entityLinks: {
    entityType: "card" | "key_point" | "note" | "source" | "learning_run";
    entityId: string;
    label: string;
    target:
      | { kind: "note"; noteId: string }
      | { kind: "source"; sourceId: string }
      | { kind: "objective"; objectiveId: string }
      | { kind: "understanding"; objectiveId: string }
      | { kind: "learning_run"; runId: string }
      | null;
    orphaned: boolean;
  }[];
}

export interface MemoryStarMapResult {
  version: 2;
  nodes: MemoryStarMapNode[];
  cursor: null;
}

const STAR_MAP_LIMIT = 500;

export async function getMemoryStarMap(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<MemoryStarMapResult> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT m.id, m.kind, m.content, m.importance, m.pinned, m.updated_at,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'entityType', l.entity_type,
                 'entityId', l.entity_id,
                 'label', COALESCE(resolved.label, '关联内容已不存在'),
                 'target', CASE
                   WHEN l.orphaned OR resolved.label IS NULL THEN NULL
                   ELSE resolved.target
                 END,
                 'orphaned', l.orphaned OR resolved.label IS NULL
               )
             ) FILTER (WHERE l.id IS NOT NULL),
             '[]'::jsonb
           ) AS links
    FROM assistant_memory_items m
    LEFT JOIN memory_links l
      ON l.memory_id = m.id
     AND l.workspace_id = m.workspace_id
     AND l.user_id = m.user_id
     AND l.entity_type IN ('card', 'key_point', 'note', 'source', 'learning_run')
    LEFT JOIN LATERAL (
      SELECT
        CASE l.entity_type
          WHEN 'note' THEN (
            SELECT n.title FROM notes n
            WHERE n.id = l.entity_id AND n.workspace_id = m.workspace_id AND n.deleted_at IS NULL
            LIMIT 1
          )
          WHEN 'source' THEN (
            SELECT s.title FROM sources s
            WHERE s.id = l.entity_id AND s.workspace_id = m.workspace_id AND s.status <> 'archived'
            LIMIT 1
          )
          WHEN 'card' THEN (
            SELECT c.public_summary FROM learning_cards_v2 c
            WHERE c.card_id = l.entity_id AND c.workspace_id = m.workspace_id AND c.lifecycle = 'active'
            LIMIT 1
          )
          WHEN 'key_point' THEN (
            SELECT COALESCE(r.concept_label, r.public_summary)
            FROM learning_objective_revisions_v2 r
            WHERE r.objective_id = l.entity_id AND r.workspace_id = m.workspace_id
            ORDER BY r.revision DESC
            LIMIT 1
          )
          WHEN 'learning_run' THEN (
            SELECT CASE r.goal
              WHEN 'stabilize' THEN '巩固学习'
              WHEN 'clarify' THEN '澄清理解'
              WHEN 'repair' THEN '修复理解'
              WHEN 'transfer' THEN '迁移练习'
              WHEN 'explore' THEN '探索学习'
              ELSE '学习旅程'
            END
            FROM learning_runs r
            WHERE r.id = l.entity_id AND r.workspace_id = m.workspace_id AND r.user_id = m.user_id
            LIMIT 1
          )
        END AS label,
        CASE l.entity_type
          WHEN 'note' THEN CASE WHEN EXISTS (
            SELECT 1 FROM notes n WHERE n.id = l.entity_id AND n.workspace_id = m.workspace_id AND n.deleted_at IS NULL
          ) THEN jsonb_build_object('kind', 'note', 'noteId', l.entity_id) END
          WHEN 'source' THEN CASE WHEN EXISTS (
            SELECT 1 FROM sources s WHERE s.id = l.entity_id AND s.workspace_id = m.workspace_id AND s.status <> 'archived'
          ) THEN jsonb_build_object('kind', 'source', 'sourceId', l.entity_id) END
          WHEN 'card' THEN (
            SELECT jsonb_build_object('kind', 'objective', 'objectiveId', c.objective_id)
            FROM learning_cards_v2 c
            WHERE c.card_id = l.entity_id AND c.workspace_id = m.workspace_id AND c.lifecycle = 'active'
            LIMIT 1
          )
          WHEN 'key_point' THEN CASE WHEN EXISTS (
            SELECT 1 FROM learning_objective_revisions_v2 r
            WHERE r.objective_id = l.entity_id AND r.workspace_id = m.workspace_id
          ) THEN jsonb_build_object('kind', 'understanding', 'objectiveId', l.entity_id) END
          WHEN 'learning_run' THEN CASE WHEN EXISTS (
            SELECT 1 FROM learning_runs r
            WHERE r.id = l.entity_id AND r.workspace_id = m.workspace_id AND r.user_id = m.user_id
          ) THEN jsonb_build_object('kind', 'learning_run', 'runId', l.entity_id) END
        END AS target
    ) resolved ON l.id IS NOT NULL
    WHERE m.workspace_id = ${scope.workspaceId}
      AND m.user_id = ${scope.userId}
      AND m.deleted_at IS NULL
      AND m.candidate = false
      AND m.archived_at IS NULL
    GROUP BY m.id
    ORDER BY m.pinned DESC, m.importance DESC, m.updated_at DESC
    LIMIT ${STAR_MAP_LIMIT}
  `);

  const nodes: MemoryStarMapNode[] = (Array.isArray(rows) ? rows : []).map((row) => ({
    memoryId: String(row.id),
    kind: String(row.kind),
    content: String(row.content),
    state: row.pinned ? "pinned" : "active",
    importance: Number(row.importance),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    entityLinks: Array.isArray(row.links)
      ? (row.links as MemoryStarMapNode["entityLinks"])
      : [],
  }));

  return { version: 2, nodes, cursor: null };
}
