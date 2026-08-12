-- P2 companion：run 元数据补 prompt hash（03 §9.1：promptVersion 与 hash 一起写入
-- turn run 元数据，可追溯 persona 版本）。

ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS prompt_hash char(64);
