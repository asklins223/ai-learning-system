-- 0172: 桌宠记忆衰减维护（22-real-desktop-pet-memory-context-prd-tdd.md §10.6）
--
-- Worker 通过 SECURITY DEFINER 函数每日执行：低重要性且长期未使用的记忆自动归档。

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_run_companion_memory_maintenance()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE assistant_memory_items
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
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_run_companion_memory_maintenance() TO ailearn_worker;

--> statement-breakpoint

COMMENT ON FUNCTION public.ailearn_run_companion_memory_maintenance() IS
  '桌宠记忆衰减：低重要性且长期未使用的 active 记忆自动归档（pinned 不衰减）。';
