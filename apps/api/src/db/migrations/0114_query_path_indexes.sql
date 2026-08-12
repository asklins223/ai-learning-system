-- 0114: 第十三轮 DB schema 完整性审计 —— 高频查询路径索引补齐。
--
-- 全部为增量 CREATE INDEX IF NOT EXISTS（不改变现有约束/语义），
-- 且同步声明到 drizzle schema（防止后续 generate 产出删索引 diff）。

-- 1) review_schedules listDue 高频路径：workspace + status='pending' +
--    next_review_at <= now（review/service.ts:151-171、card/service.ts:156-173）。
--    原有索引均不以 workspace_id 开头（RLS 强制 workspace 过滤后全扫+sort）。
CREATE INDEX IF NOT EXISTS review_schedules_workspace_status_next_idx
  ON public.review_schedules (workspace_id, status, next_review_at);

-- 2) notes 列表：workspace + deleted_at IS NULL ORDER BY updated_at DESC
--    （note/service.ts:629-632）。现有 notes_active_idx 只含 workspace_id，
--    翻页需 sort。
CREATE INDEX IF NOT EXISTS notes_active_updated_idx
  ON public.notes (workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- 3) learning_cards 列表：workspace 过滤 ORDER BY created_at DESC
--    （card/service.ts:74-76）。现有 learning_cards_workspace_idx 无排序列。
CREATE INDEX IF NOT EXISTS learning_cards_workspace_created_idx
  ON public.learning_cards (workspace_id, created_at DESC);

-- 4) validation_events 按 workspace 聚合（card/service.ts:138-146、
--    note/service.ts:1348）：该表无 workspace 前缀索引（仅 card/user/keypoint）。
CREATE INDEX IF NOT EXISTS validation_events_workspace_created_idx
  ON public.validation_events (workspace_id, created_at DESC);

-- 5) note_image_assets 按 (workspace_id, status) 查询（note/service.ts:170-174,
--    217-221）：现有索引均无 status 列。
CREATE INDEX IF NOT EXISTS note_image_assets_workspace_status_idx
  ON public.note_image_assets (workspace_id, status);
