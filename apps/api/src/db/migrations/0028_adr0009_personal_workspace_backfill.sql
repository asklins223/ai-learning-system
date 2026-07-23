-- 0028_adr0009_personal_workspace_backfill.sql
-- Complete ADR-0009's legacy-user migration. 0025 added the nullable pointer
-- and inferred workspace_type, but did not assign every existing user a stable
-- personal workspace. Runtime login, rename, leave, and workspace switching all
-- rely on this invariant.

DO $$
DECLARE
  user_row record;
  personal_id uuid;
  personal_name text;
BEGIN
  FOR user_row IN
    SELECT id, email, personal_workspace_id
    FROM public.users
    ORDER BY created_at, id
  LOOP
    personal_id := NULL;

    -- Keep an already-valid assignment (new users created after 0025).
    IF user_row.personal_workspace_id IS NOT NULL THEN
      SELECT id
      INTO personal_id
      FROM public.workspaces
      WHERE id = user_row.personal_workspace_id
        AND owner_id = user_row.id
      LIMIT 1;
    END IF;

    -- Reuse an owned workspace only when it has no other active member. A
    -- shared legacy workspace must remain collaborative; relabelling it as the
    -- owner's personal workspace would expose the wrong identity semantics.
    IF personal_id IS NULL THEN
      SELECT w.id
      INTO personal_id
      FROM public.workspaces w
      WHERE w.owner_id = user_row.id
        AND NOT EXISTS (
          SELECT 1
          FROM public.workspace_members wm
          WHERE wm.workspace_id = w.id
            AND wm.user_id <> user_row.id
            AND wm.left_at IS NULL
        )
      ORDER BY
        CASE WHEN w.workspace_type = 'personal' THEN 0 ELSE 1 END,
        w.created_at,
        w.id
      LIMIT 1;
    END IF;

    -- Member-only accounts and owners of shared legacy workspaces receive a
    -- new empty private workspace. User-private business records require a
    -- separately reviewed migration because of their cross-table references;
    -- workspace-owned data intentionally stays in the shared workspace.
    IF personal_id IS NULL THEN
      personal_name := left(
        COALESCE(NULLIF(trim(split_part(user_row.email, '@', 1)), ''), '用户'),
        46
      ) || '的工作区';

      INSERT INTO public.workspaces (owner_id, name, workspace_type)
      VALUES (user_row.id, personal_name, 'personal')
      RETURNING id INTO personal_id;
    END IF;

    INSERT INTO public.workspace_members (workspace_id, user_id, role, left_at)
    VALUES (personal_id, user_row.id, 'owner', NULL)
    ON CONFLICT (workspace_id, user_id)
    DO UPDATE SET role = 'owner', left_at = NULL;

    UPDATE public.users
    SET personal_workspace_id = personal_id
    WHERE id = user_row.id;

    INSERT INTO public.onboarding_states (workspace_id, user_id, version, steps, status)
    VALUES (personal_id, user_row.id, 'v1', '{}'::jsonb, 'pending')
    ON CONFLICT (workspace_id, user_id, version) DO NOTHING;
  END LOOP;
END
$$;

-- The personal/collaborative label is determined by the durable assignment,
-- not by member count. A workspace is personal for exactly its owning user;
-- other owned workspaces remain collaboration spaces.
UPDATE public.workspaces w
SET workspace_type = CASE
  WHEN EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.personal_workspace_id = w.id
      AND w.owner_id = u.id
  ) THEN 'personal'
  ELSE 'collaborative'
END;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_personal_workspace_id_fkey'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_personal_workspace_id_fkey
      FOREIGN KEY (personal_workspace_id)
      REFERENCES public.workspaces(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- Keep the column nullable at the schema level: registration creates the user
-- before its owner-referencing workspace in the same transaction, so the
-- pointer has a short, uncommitted NULL phase. The verification below enforces
-- the invariant for every committed legacy row without breaking that flow.

-- Fail the migration rather than leaving a partially usable identity graph.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.users u
    LEFT JOIN public.workspaces w
      ON w.id = u.personal_workspace_id
     AND w.owner_id = u.id
    LEFT JOIN public.workspace_members wm
      ON wm.workspace_id = u.personal_workspace_id
     AND wm.user_id = u.id
     AND wm.role = 'owner'
     AND wm.left_at IS NULL
    WHERE w.id IS NULL OR wm.user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'ADR-0009 personal workspace backfill left an invalid user assignment'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
