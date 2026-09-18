-- 0185: 首页 V2 伴星房间收藏与装备状态。
--
-- 解锁列表只由 API 根据 canonical 笔记、学习目标、复习与已确认记忆里程碑
-- 写入；客户端 PATCH 只能修改已解锁资源的装备位置，并通过 revision 做 CAS。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_room_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  unlocked_decor_ids text[] NOT NULL DEFAULT '{}',
  equipped_decor_by_slot jsonb NOT NULL DEFAULT '{"desk":null,"shelf":null,"window":null,"rest":null}',
  unlocked_effect_ids text[] NOT NULL DEFAULT '{}',
  equipped_effect_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_room_profiles_revision_check CHECK (revision >= 1),
  CONSTRAINT companion_room_profiles_decor_ids_check CHECK (
    array_position(unlocked_decor_ids, NULL) IS NULL
    AND unlocked_decor_ids <@ ARRAY[
      'keepsake.first-note',
      'keepsake.first-goal',
      'keepsake.first-review',
      'keepsake.first-memory'
    ]::text[]
  ),
  CONSTRAINT companion_room_profiles_decor_ids_unique_check CHECK (
    cardinality(array_positions(unlocked_decor_ids, 'keepsake.first-note')) <= 1
    AND cardinality(array_positions(unlocked_decor_ids, 'keepsake.first-goal')) <= 1
    AND cardinality(array_positions(unlocked_decor_ids, 'keepsake.first-review')) <= 1
    AND cardinality(array_positions(unlocked_decor_ids, 'keepsake.first-memory')) <= 1
  ),
  CONSTRAINT companion_room_profiles_effect_ids_check CHECK (
    array_position(unlocked_effect_ids, NULL) IS NULL
    AND unlocked_effect_ids <@ ARRAY[
      'effect.page-ribbon',
      'effect.ink-ripple'
    ]::text[]
  ),
  CONSTRAINT companion_room_profiles_effect_ids_unique_check CHECK (
    cardinality(array_positions(unlocked_effect_ids, 'effect.page-ribbon')) <= 1
    AND cardinality(array_positions(unlocked_effect_ids, 'effect.ink-ripple')) <= 1
  ),
  CONSTRAINT companion_room_profiles_equipped_effect_check CHECK (
    equipped_effect_id IS NULL OR equipped_effect_id IN (
      'effect.page-ribbon',
      'effect.ink-ripple'
    )
  ),
  CONSTRAINT companion_room_profiles_equipped_effect_unlocked_check CHECK (
    equipped_effect_id IS NULL OR equipped_effect_id = ANY(unlocked_effect_ids)
  ),
  CONSTRAINT companion_room_profiles_slot_shape_check CHECK (
    jsonb_typeof(equipped_decor_by_slot) = 'object'
    AND equipped_decor_by_slot ?& ARRAY['desk', 'shelf', 'window', 'rest']
    AND equipped_decor_by_slot - ARRAY['desk', 'shelf', 'window', 'rest'] = '{}'::jsonb
  ),
  CONSTRAINT companion_room_profiles_slot_values_check CHECK (
    (equipped_decor_by_slot->>'desk' IS NULL OR equipped_decor_by_slot->>'desk' IN (
      'keepsake.first-note', 'keepsake.first-goal', 'keepsake.first-review'
    ))
    AND (equipped_decor_by_slot->>'shelf' IS NULL OR equipped_decor_by_slot->>'shelf' IN (
      'keepsake.first-note', 'keepsake.first-memory'
    ))
    AND (equipped_decor_by_slot->>'window' IS NULL OR equipped_decor_by_slot->>'window' = 'keepsake.first-goal')
    AND (equipped_decor_by_slot->>'rest' IS NULL OR equipped_decor_by_slot->>'rest' IN (
      'keepsake.first-review', 'keepsake.first-memory'
    ))
  ),
  CONSTRAINT companion_room_profiles_equipped_decor_unlocked_check CHECK (
    (equipped_decor_by_slot->>'desk' IS NULL OR equipped_decor_by_slot->>'desk' = ANY(unlocked_decor_ids))
    AND (equipped_decor_by_slot->>'shelf' IS NULL OR equipped_decor_by_slot->>'shelf' = ANY(unlocked_decor_ids))
    AND (equipped_decor_by_slot->>'window' IS NULL OR equipped_decor_by_slot->>'window' = ANY(unlocked_decor_ids))
    AND (equipped_decor_by_slot->>'rest' IS NULL OR equipped_decor_by_slot->>'rest' = ANY(unlocked_decor_ids))
  ),
  CONSTRAINT companion_room_profiles_equipped_decor_unique_check CHECK (
    (equipped_decor_by_slot->>'desk' IS NULL OR equipped_decor_by_slot->>'shelf' IS NULL
      OR equipped_decor_by_slot->>'desk' <> equipped_decor_by_slot->>'shelf')
    AND (equipped_decor_by_slot->>'desk' IS NULL OR equipped_decor_by_slot->>'window' IS NULL
      OR equipped_decor_by_slot->>'desk' <> equipped_decor_by_slot->>'window')
    AND (equipped_decor_by_slot->>'desk' IS NULL OR equipped_decor_by_slot->>'rest' IS NULL
      OR equipped_decor_by_slot->>'desk' <> equipped_decor_by_slot->>'rest')
    AND (equipped_decor_by_slot->>'shelf' IS NULL OR equipped_decor_by_slot->>'window' IS NULL
      OR equipped_decor_by_slot->>'shelf' <> equipped_decor_by_slot->>'window')
    AND (equipped_decor_by_slot->>'shelf' IS NULL OR equipped_decor_by_slot->>'rest' IS NULL
      OR equipped_decor_by_slot->>'shelf' <> equipped_decor_by_slot->>'rest')
    AND (equipped_decor_by_slot->>'window' IS NULL OR equipped_decor_by_slot->>'rest' IS NULL
      OR equipped_decor_by_slot->>'window' <> equipped_decor_by_slot->>'rest')
  )
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_room_profiles_workspace_user_unique
  ON public.companion_room_profiles (workspace_id, user_id);

--> statement-breakpoint

ALTER TABLE public.companion_room_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_room_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_room_profiles_workspace_user_isolation
  ON public.companion_room_profiles;
CREATE POLICY companion_room_profiles_workspace_user_isolation
  ON public.companion_room_profiles FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_room_profiles TO ailearn_api;
GRANT SELECT ON public.companion_room_profiles TO ailearn_worker;
