-- 0153: sources 列表排序补 (workspace_id, updated_at DESC) 复合索引。
--
-- 背景（PERF-BN7 / 审计发现，第一轮 #14 遗留弱项）：sources 仅有单列
-- sources_workspace_idx(workspace_id)。source/service 的 listSources 按
-- updated_at DESC + id 排序，工作区来源数大时需在 workspace 分区内排序重排。
-- 补复合索引使排序直接走索引，避免 Sort 节点。

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sources_workspace_updated_idx
  ON public.sources (workspace_id, updated_at DESC);
