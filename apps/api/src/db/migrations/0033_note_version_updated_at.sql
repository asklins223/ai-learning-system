-- 0033_note_version_updated_at.sql
-- 为 note_versions 添加 updated_at 字段，追踪原地更新（isAutosave）的修改时间。
--
-- note_versions 设计为不可变（append-only），但 isAutosave 原地更新是受控例外。
-- updated_at 允许审计和调试时区分：
--   - 原始创建时间（created_at）
--   - 最后原地修改时间（updated_at）
--
-- 对于从未被原地更新的版本，updated_at === created_at。

-- 1. 添加 updated_at 列，默认 NOW()
ALTER TABLE note_versions
  ADD COLUMN updated_at timestamp with time zone DEFAULT now() NOT NULL;

-- 2. 回填：已有版本的 updated_at 设为 created_at（从未被原地更新）
UPDATE note_versions
SET updated_at = created_at
WHERE updated_at IS NULL OR updated_at = created_at;
