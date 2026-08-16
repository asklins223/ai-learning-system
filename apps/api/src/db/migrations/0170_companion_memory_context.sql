-- 0170: 真桌宠记忆与上下文（22-real-desktop-pet-memory-context-prd-tdd.md）
--
-- Phase 1-4 的数据基础：
--  - assistant_memory_items 扩展 V2 字段（importance/scope/pinned/archived/embedding 等）
--  - assistant_memory_embeddings（pgvector 派生索引）
--  - pet_profiles（人格档案 + 关系状态）
--  - memory_links（记忆 ↔ 实体关联）
--  - conversation_summaries（会话摘要候选）
--  - memory_usage_log（检索使用日志，供衰减/可观测性）
--  - companion_daily_summaries（桌宠日记，只读页面数据）
--
-- 与 22 方案最终一致性声明一致：字段/约束以第 9/10/11/12/13/14/15/16 轮补强为准。

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items
  ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS conflict_group uuid,
  ADD COLUMN IF NOT EXISTS embedding_profile_version text,
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'model_inferred',
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'none';

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_kind_check;

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_kind_check CHECK (kind IN (
    'preference', 'goal', 'learning_context', 'interaction_note', 'episodic'
  ));

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_memory_items_retrieval_idx
  ON public.assistant_memory_items (workspace_id, user_id, candidate, archived_at, deleted_at, updated_at DESC);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.assistant_memory_embeddings (
  memory_id uuid PRIMARY KEY REFERENCES public.assistant_memory_items(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  embedding vector(1024) NOT NULL,
  model_revision text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_memory_embeddings_hnsw_idx
  ON public.assistant_memory_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

--> statement-breakpoint

ALTER TABLE public.assistant_memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_memory_embeddings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_memory_embeddings_workspace_user_isolation
  ON public.assistant_memory_embeddings;
CREATE POLICY assistant_memory_embeddings_workspace_user_isolation
  ON public.assistant_memory_embeddings FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_memory_embeddings TO ailearn_worker;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.pet_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  preset_id text,
  name text NOT NULL,
  personality_tags jsonb NOT NULL DEFAULT '[]',
  speaking_style text NOT NULL,
  examples jsonb NOT NULL DEFAULT '[]',
  activeness text NOT NULL DEFAULT 'moderate',
  boundaries jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  familiarity real NOT NULL DEFAULT 0,
  interaction_count integer NOT NULL DEFAULT 0,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pet_profiles_activeness_check CHECK (activeness IN ('quiet', 'moderate', 'active'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS pet_profiles_workspace_user_unique
  ON public.pet_profiles (workspace_id, user_id);

--> statement-breakpoint

ALTER TABLE public.pet_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pet_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pet_profiles_workspace_user_isolation
  ON public.pet_profiles;
CREATE POLICY pet_profiles_workspace_user_isolation
  ON public.pet_profiles FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pet_profiles TO ailearn_api;
GRANT SELECT ON public.pet_profiles TO ailearn_worker;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.memory_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES public.assistant_memory_items(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  auto_linked boolean NOT NULL DEFAULT false,
  orphaned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS memory_links_unique_idx
  ON public.memory_links (memory_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS memory_links_entity_idx
  ON public.memory_links (workspace_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS memory_links_memory_idx
  ON public.memory_links (workspace_id, user_id, memory_id);

--> statement-breakpoint

ALTER TABLE public.memory_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_links_workspace_user_isolation
  ON public.memory_links;
CREATE POLICY memory_links_workspace_user_isolation
  ON public.memory_links FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_links TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_links TO ailearn_worker;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  summary jsonb NOT NULL,
  source_run_id uuid,
  status text NOT NULL DEFAULT 'candidate',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS conversation_summaries_unique_idx
  ON public.conversation_summaries (workspace_id, user_id, conversation_id, source_run_id);
CREATE INDEX IF NOT EXISTS conversation_summaries_status_idx
  ON public.conversation_summaries (workspace_id, user_id, status, created_at);

--> statement-breakpoint

ALTER TABLE public.conversation_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_summaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_summaries_workspace_user_isolation
  ON public.conversation_summaries;
CREATE POLICY conversation_summaries_workspace_user_isolation
  ON public.conversation_summaries FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_summaries TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_summaries TO ailearn_worker;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.memory_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  run_id uuid NOT NULL,
  memory_ids uuid[] NOT NULL,
  retrieval_mode text NOT NULL,
  latency_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS memory_usage_log_ws_user_run_idx
  ON public.memory_usage_log (workspace_id, user_id, run_id, created_at);

--> statement-breakpoint

ALTER TABLE public.memory_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_usage_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_usage_log_workspace_user_isolation
  ON public.memory_usage_log;
CREATE POLICY memory_usage_log_workspace_user_isolation
  ON public.memory_usage_log FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_usage_log TO ailearn_worker;
GRANT SELECT ON public.memory_usage_log TO ailearn_api;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_daily_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date text NOT NULL,
  timezone text NOT NULL,
  facts jsonb NOT NULL,
  highlights jsonb NOT NULL DEFAULT '[]',
  summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'generated',
  revision integer NOT NULL DEFAULT 1,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_daily_summaries_status_check CHECK (status IN ('generated', 'failed'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_daily_summaries_ws_user_date_unique
  ON public.companion_daily_summaries (workspace_id, user_id, date);

--> statement-breakpoint

ALTER TABLE public.companion_daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_daily_summaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_daily_summaries_workspace_user_isolation
  ON public.companion_daily_summaries;
CREATE POLICY companion_daily_summaries_workspace_user_isolation
  ON public.companion_daily_summaries FOR ALL
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_daily_summaries TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_daily_summaries TO ailearn_worker;
