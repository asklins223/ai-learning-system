-- CONC-03: 软删除/回收站 — 为 notes 表添加 deleted_at 列
-- 删除时设置 deleted_at = now()，查询时过滤 deleted_at IS NULL
-- 30 天后由定时任务物理删除（physicalDeleteNote）
-- 提供 POST /notes/:id/restore 恢复接口

ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 部分索引：查询未删除笔记时使用 WHERE deleted_at IS NULL
CREATE INDEX IF NOT EXISTS notes_active_idx
  ON notes (workspace_id)
  WHERE deleted_at IS NULL;

-- 搜索索引表也需同步过滤 — 由 service 层在删除时清理搜索文档
