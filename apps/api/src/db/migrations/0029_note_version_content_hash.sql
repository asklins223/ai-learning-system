-- 0029_note_version_content_hash.sql
-- 为 note_versions 添加 content_hash 列，用于内容去重和版本恢复

-- 1. 添加 nullable content_hash 列
ALTER TABLE note_versions
  ADD COLUMN content_hash text;

-- 2. 为已有数据回填哈希（使用 MD5）
UPDATE note_versions
SET content_hash = md5(content_json::text)
WHERE content_hash IS NULL;

-- 3. 添加 NOT NULL 约束
ALTER TABLE note_versions
  ALTER COLUMN content_hash SET NOT NULL;

-- 4. 添加 (note_id, content_hash) 索引用于快速去重查找
CREATE INDEX note_versions_content_hash_idx
  ON note_versions (note_id, content_hash);
