-- P1-09 修复：在 card_generation_candidates 表中添加 bundle_id 列
-- 强制每个 candidate 恰好属于一个 owning bundle，使覆盖率可从 DB 关系重算。
-- 原代码候选没有 bundleId 字段，持久化时把候选归到第一个 section，
-- 并把全部已分配 bundle 都记成 candidate_emitted + 总候选数。
-- 修复后：每个候选必须带唯一 bundleId，覆盖率只从 DB 关系重算。

ALTER TABLE card_generation_candidates
  ADD COLUMN IF NOT EXISTS bundle_id TEXT;

-- 为已有候选回填 bundle_id：从 unit_id 关联到 source_bundles.assigned_agent_unit_id
-- 这不是完美的回填（一个 unit 可能处理多个 bundle），但比 NULL 好。
-- 新代码将强制每个候选带 bundleId。
UPDATE card_generation_candidates c
  SET bundle_id = sub.bundle_key
  FROM (
    SELECT b.bundle_key, b.assigned_agent_unit_id
    FROM card_generation_source_bundles b
    WHERE b.assigned_agent_unit_id IS NOT NULL
  ) sub
  WHERE c.unit_id = sub.assigned_agent_unit_id
    AND c.bundle_id IS NULL;

-- 添加索引以支持按 bundle 查询候选
CREATE INDEX IF NOT EXISTS card_generation_candidates_bundle_idx
  ON card_generation_candidates (workspace_id, run_id, bundle_id);
