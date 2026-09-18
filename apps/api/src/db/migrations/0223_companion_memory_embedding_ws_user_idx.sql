-- 0223: 补齐 Drizzle schema 已声明、但从未建到库上的复合索引。
--
-- packages/shared/src/db-schema/companion-memory.ts 声明了
-- assistant_memory_embeddings_ws_user_idx (workspace_id, user_id)，而 0170 只创建了
-- HNSW 向量索引 assistant_memory_embeddings_hnsw_idx：按工作区/用户列举、维护扫描
-- 与记忆重建的定位查询因此只能走顺序扫描，并且 schema 与实库长期不一致（2026-09-16
-- 用「db-schema 声明 ↔ 迁移 SQL」对账发现的唯一一个伴星相关缺口）。
--
-- 幂等创建，兼容已应用 0170 的库与全新库。

CREATE INDEX IF NOT EXISTS assistant_memory_embeddings_ws_user_idx
  ON public.assistant_memory_embeddings (workspace_id, user_id);
