-- 0132: assistant_memory_items（文档 16 §10 分层记忆）。
--
-- 有来源、可审计、可删除的长期语义记忆；不复制 Learner Model。canonical
-- 学习事实与记忆解耦：删除记忆不影响学习真相。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.assistant_memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content text NOT NULL,
  source_event_id text,
  source_session_id uuid,
  user_stated boolean NOT NULL DEFAULT false,
  user_confirmed boolean NOT NULL DEFAULT false,
  candidate boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_memory_items_kind_check CHECK (kind IN (
    'preference', 'goal', 'learning_context', 'interaction_note'
  ))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS assistant_memory_items_content_unique_idx
  ON public.assistant_memory_items (workspace_id, user_id, kind, source_event_id)
  WHERE deleted_at IS NULL AND source_event_id IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_memory_items_ws_user_idx
  ON public.assistant_memory_items (workspace_id, user_id, updated_at);

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_memory_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_memory_items_workspace_user_isolation
  ON public.assistant_memory_items;
CREATE POLICY assistant_memory_items_workspace_user_isolation
  ON public.assistant_memory_items FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_memory_items TO ailearn_api;
GRANT SELECT ON public.assistant_memory_items TO ailearn_worker;
