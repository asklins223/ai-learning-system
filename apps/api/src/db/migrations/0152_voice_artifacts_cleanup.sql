-- 0152: companion_voice_artifacts pending 过期清理加分批 LIMIT + 支撑索引。
--
-- 背景（PERF-BN3 / 审计发现）：0104 的 ailearn_expire_pending_voice_artifacts()
-- 对 status='pending' AND expires_at<'now()' 一次性 UPDATE 全量，无 LIMIT
-- 分批（对比同迁移 stream_events 清理带 p_limit）；且表仅 status='attached'
-- 的 partial 唯一索引，无 (status, expires_at) 支撑索引 → 每次全表扫描 +
-- 长事务/表锁窗口。pending 音频随长尾/异常积累放大。
--
-- 修复：补 (status, expires_at) partial 索引（仅 pending），并把清理函数改为
-- 分批 LIMIT 循环。签名向后兼容：新增尾参 p_limit（默认 200），0 参调用仍可行。

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_voice_artifacts_pending_expires_idx
  ON public.companion_voice_artifacts (status, expires_at)
  WHERE status = 'pending';

--> statement-breakpoint

-- CREATE OR REPLACE 无法变更参数个数（只会新建 overload），先 DROP 旧 0 参
-- 函数再以带 p_limit 的版本重建，确保不残留。
DROP FUNCTION IF EXISTS public.ailearn_expire_pending_voice_artifacts();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_expire_pending_voice_artifacts(
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_total integer := 0;
  v_rows integer;
BEGIN
  LOOP
    WITH target AS (
      SELECT id
      FROM public.companion_voice_artifacts
      WHERE status = 'pending' AND expires_at < now()
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    ), expired AS (
      UPDATE public.companion_voice_artifacts
      SET status = 'expired'
      WHERE id IN (SELECT id FROM target)
      RETURNING id
    )
    SELECT count(*) INTO v_rows FROM expired;

    v_total := v_total + v_rows;
    -- 无剩余或本批未满则结束（未满说明已无待清理项）。
    EXIT WHEN v_rows = 0 OR v_rows < p_limit;
  END LOOP;

  RETURN v_total;
END;
$function$;

--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    REVOKE ALL ON FUNCTION public.ailearn_expire_pending_voice_artifacts(integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION public.ailearn_expire_pending_voice_artifacts(integer)
      TO ailearn_api;
  END IF;
END $$;
