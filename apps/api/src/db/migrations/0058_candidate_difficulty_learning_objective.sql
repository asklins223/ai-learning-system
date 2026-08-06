-- P1-11: 质量标准与密度约束
-- 1. 添加 candidate difficulty 列（basic | intermediate | advanced）
-- 2. learningObjective 存储在 draft contentJson 的 cards 中（无需 DDL）

ALTER TABLE card_generation_candidates
  ADD COLUMN IF NOT EXISTS difficulty text;
