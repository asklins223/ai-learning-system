-- CONC-10: review_schedules 加 updated_at 列
-- deleteNote 取消计划时将 updated_at 设为笔记的 deletedAt 时间戳，
-- restoreDeletedNote 恢复时用 updated_at = deletedAt 精确匹配，
-- 避免误恢复用户在笔记删除前就已手动取消的复习计划。

ALTER TABLE review_schedules
  ADD COLUMN IF NOT EXISTS updated_at timestamptz
  NOT NULL DEFAULT now();
