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
  entityLinks: {
    entityType: string;
    entityId: string;
    orphaned: boolean;
  }[];
}

export interface MemoryStarMapResult {
  version: 1;
  nodes: MemoryStarMapNode[];
  cursor: null;
}

const STAR_MAP_LIMIT = 500;

export async function getMemoryStarMap(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<MemoryStarMapResult> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT m.id, m.kind, m.content, m.importance, m.pinned,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'entityType', l.entity_type,
                 'entityId', l.entity_id,
                 'orphaned', l.orphaned
               )
             ) FILTER (WHERE l.id IS NOT NULL),
             '[]'::jsonb
           ) AS links
    FROM assistant_memory_items m
    LEFT JOIN memory_links l
      ON l.memory_id = m.id
     AND l.workspace_id = m.workspace_id
     AND l.user_id = m.user_id
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
    entityLinks: Array.isArray(row.links)
      ? (row.links as { entityType: string; entityId: string; orphaned: boolean }[])
      : [],
  }));

  return { version: 1, nodes, cursor: null };
}
