-- 0212: make companion memory maintenance a database-guarded daily operation.
--
-- A process-local throttle plus an advisory lock only prevents overlapping runs.
-- With multiple workers, a second process can acquire the lock later in the same
-- day and apply familiarity decay again. The date row is the durable exactly-once
-- gate for the current maintenance window.

CREATE TABLE IF NOT EXISTS public.companion_memory_maintenance_runs (
  run_date date PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL PRIVILEGES ON TABLE public.companion_memory_maintenance_runs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.companion_memory_maintenance_runs FROM ailearn_api;
REVOKE ALL PRIVILEGES ON TABLE public.companion_memory_maintenance_runs FROM ailearn_worker;
GRANT SELECT, INSERT ON TABLE public.companion_memory_maintenance_runs TO ailearn_migrator;

CREATE OR REPLACE FUNCTION public.ailearn_run_companion_memory_maintenance()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run_date date := CURRENT_DATE;
  v_claimed_date date;
  v_archived integer := 0;
  v_decayed integer := 0;
BEGIN
  INSERT INTO public.companion_memory_maintenance_runs (run_date)
  VALUES (v_run_date)
  ON CONFLICT (run_date) DO NOTHING
  RETURNING run_date INTO v_claimed_date;

  IF v_claimed_date IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.assistant_memory_items
  SET archived_at = now(), updated_at = now()
  WHERE deleted_at IS NULL
    AND archived_at IS NULL
    AND pinned = false
    AND (
      (
        (last_used_at IS NULL OR last_used_at < now() - interval '30 days')
        AND importance < 0.4
      )
      OR (
        last_used_at < now() - interval '90 days'
        AND importance < 0.6
      )
    );
  GET DIAGNOSTICS v_archived = ROW_COUNT;

  WITH stale AS (
    UPDATE public.pet_profiles
    SET familiarity = GREATEST(familiarity - 0.05, 0),
        updated_at = now()
    WHERE last_active_at IS NOT NULL
      AND last_active_at < now() - interval '14 days'
      AND familiarity > 0
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_decayed FROM stale;

  RETURN v_archived + v_decayed;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ailearn_run_companion_memory_maintenance() TO ailearn_worker;

COMMENT ON TABLE public.companion_memory_maintenance_runs IS
  'Database idempotency gate: companion memory maintenance runs at most once per database date.';

COMMENT ON FUNCTION public.ailearn_run_companion_memory_maintenance() IS
  '桌宠记忆与关系衰减：每个数据库日期最多执行一次；pinned 记忆不衰减。';

-- companion_memory_maintenance 曾被列入 worker 自入队白名单，但当前 worker
-- 没有这个 job handler；维护由上面的直接 tick 执行，删除孤立 job 类型入口。
DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard" ON public.jobs;
CREATE POLICY "worker_type_allowlist_insert_guard"
  ON public.jobs
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'::name
    AND "type" IN ('companion_memory_extract', 'companion_summarizer', 'companion_daily_summary')
  );
