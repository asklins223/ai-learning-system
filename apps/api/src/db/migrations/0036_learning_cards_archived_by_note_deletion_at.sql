-- CONC-10-edge: learning_cards 加专用标记列 archived_by_note_deletion_at
-- deleteNote 归档卡片时设为 deletedAt，restoreDeletedNote 恢复时用此列
-- 精确匹配并清除。该列不受其他操作（如 card/service archiveCard 覆盖
-- updatedAt）的影响，消除 deleteNote → 手动归档 → restoreDeletedNote
-- 时卡片无法被匹配恢复的边缘情况。

ALTER TABLE learning_cards
  ADD COLUMN IF NOT EXISTS archived_by_note_deletion_at timestamptz;
