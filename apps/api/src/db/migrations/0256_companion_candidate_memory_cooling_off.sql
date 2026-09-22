-- 0256: 候选记忆的冷静期——满 3 天自动落进记忆库（方案 29 §11 C2，用户 2026-09-22 定）。
--
-- 为什么要动这条：过目面是**有的**（`/companion/memory?includeCandidates=true` 列得出候选，
-- 伴星中心的「确认写入」走 `memory-service` 的确认函数把 `candidate` 翻成 false）——
-- 我一度写成"全仓没有确认通路"，那是错的：我只搜了 SQL 文本里的 `candidate = false`，
-- 而这条路是 drizzle 的对象字面量 `candidate: false`。真正的事实是**没人来确认**：
-- 实测 26 条候选、最久的一条已经等了两天，抽取器每天还在往里加。
-- 所以用户定的规则是"等几天自动落库"，把默认从"不理它就永远读不到"改成"不理它就算通过"。
--
-- 规则：**只清 candidate，不冒充用户确认**（`user_confirmed` 保持 false——翻成 true 就是
-- 我们第二次"把没发生的事写成成功"，见 §9.70；手动确认那条路才会置 true）。
--
-- 例外（不自动放行）：正文同时带"当前时间窗"（本周/今天/截至…）和统计量词
-- （分钟/张/篇/…）的行。那种数字是系统随时重算的，存成活记忆等于让她自己的编造
-- 长出"记忆出处"——实机 2026-09-21 的"本周 23 分钟"（真值 60）就是这么变成下一轮
-- 的合法引用的（判据同 companion-memory-extractor 的 isVolatileStatisticMemory）。
--
-- 不做 `updated_at = now()`：嵌入任务按 `ORDER BY updated_at ASC` 取 pending 行，
-- 一 bump 就把这批刚解禁、还缺向量的行推到队列最后面。

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
  v_promoted integer := 0;
BEGIN
  INSERT INTO public.companion_memory_maintenance_runs (run_date)
  VALUES (v_run_date)
  ON CONFLICT (run_date) DO NOTHING
  RETURNING run_date INTO v_claimed_date;

  IF v_claimed_date IS NULL THEN
    RETURN 0;
  END IF;

  -- 先解禁再归档：解禁后的行如果本来就满足归档条件（低重要性、久未使用），
  -- 同一轮里就该被归档，不该多活一天。
  WITH promoted AS (
    UPDATE public.assistant_memory_items
    SET candidate = false
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND candidate = true
      AND created_at < now() - interval '3 days'
      AND NOT (
        content ~ '(本周|这周|今天|今日|截至|这一阵)'
        AND content ~ '\d+(\.\d+)?\s*(分钟|小时|张|篇|项|题|次|条|%)'
      )
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_promoted FROM promoted;

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

  RETURN v_archived + v_decayed + v_promoted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ailearn_run_companion_memory_maintenance() TO ailearn_worker;

COMMENT ON FUNCTION public.ailearn_run_companion_memory_maintenance() IS
  '桌宠记忆维护：每个数据库日期最多执行一次；pinned 记忆不衰减；'
  '满 3 天的候选记忆自动落库（带当前时间窗统计量的行除外），不冒充用户确认。';
