-- 0225: listSources 的游标分页改按 (updated_at DESC, id) 排序，索引同步补齐 id 列。
--
-- 背景（2026-09-16 来源库复查）：
-- 1) 来源库列表按 created_at DESC 排序，但每一行展示的是 updated_at
--    （source-library-surface 的时间戳来自 updatedAt）。于是一份「很久以前采集、
--    刚刚重命名或刚解析完」的材料排在列表末尾，行内却写着「刚刚更新」——排序与
--    可见时间戳自相矛盾。改为按 updated_at DESC 排序后，列表顺序、行内时间与
--    详情页的「X 更新」三者一致。
-- 2) 游标是 (时间戳, id) 复合键，0164 为此建了
--    sources_workspace_created_idx (workspace_id, created_at DESC, id)。
--    换成 updated_at 排序后需要对应的三列索引，否则每页在 workspace 分区内 Sort。
--    0153 的 sources_workspace_updated_idx 只有两列，服务不了带 id 的游标比较。
--
-- sources_workspace_created_idx 保留：export/service.ts 的来源导出批次仍按
-- (created_at, id) 做 keyset 分页，仍需要它。
--
-- 幂等：可重复执行。

--> statement-breakpoint

DROP INDEX IF EXISTS public.sources_workspace_updated_idx;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sources_workspace_updated_idx
  ON public.sources (workspace_id, updated_at DESC, id);
