-- 0230: 产品层连续对话历史按全局时间游标读取，不再按 conversation 分页。
-- 仍保留 conversation_id 作为内部实时传输与运行隔离键。

CREATE INDEX IF NOT EXISTS companion_messages_workspace_user_created_id_idx
  ON public.companion_messages (workspace_id, user_id, created_at DESC, id DESC);
