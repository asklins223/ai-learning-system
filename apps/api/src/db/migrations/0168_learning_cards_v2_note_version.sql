-- 方案 20 R37：V2 Card 记录来源 NoteVersion，供“重新生成”直接发起，
-- 无需前端额外携带 noteVersionId。
ALTER TABLE public.learning_cards_v2
  ADD COLUMN IF NOT EXISTS note_version_id uuid REFERENCES public.note_versions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS lc_v2_ws_note_version_idx
  ON public.learning_cards_v2 (workspace_id, note_version_id);

COMMENT ON COLUMN public.learning_cards_v2.note_version_id IS
  'V2 卡来源 NoteVersion；激活时从生成 run 写入，重新生成时复用。';
