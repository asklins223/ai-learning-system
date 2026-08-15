-- 0150: learning_run_processing_outbox 的 mark-processed 增加 lease CAS。
--
-- 背景（PERF-B8 / 审计发现）：0121 中的 ailearn_mark_run_processing_processed
-- 仅按 outbox id 置 processed_at，不校验 lease_owner 也不校验 processed_at
-- IS NULL。对比同迁移的 ailearn_release_run_processing（校验 lease_owner），
-- 风格不一致。当 LEASE_SECONDS=120 而 Critic HTTP 调用可能超过 120s 时，
-- 租约过期后第二实例可重领并处理同一条命令；慢一拍的第一实例随后 mark 仍会
-- 置位，形成理论双写窗口。
--
-- 修复：给 mark 函数增加 p_worker_id 参数（默认 NULL），WHERE 加两个门闩：
--   AND processed_at IS NULL                    -- 已处理则 no-op（幂等）
--   AND (p_worker_id IS NULL OR lease_owner = p_worker_id)
-- 不传 worker 时保持旧语义（向后兼容 2 参调用），传 worker 时启用完整 CAS。
-- 返回类型保持 void，签名在尾参（默认值）上兼容。

--> statement-breakpoint

-- CREATE OR REPLACE 无法变更参数个数/类型（只会新建同名 overload），
-- 因此先 DROP 旧的 2 参函数再以 3 参签名重建，确保不残留未打补丁的重载。
DROP FUNCTION IF EXISTS public.ailearn_mark_run_processing_processed(uuid, timestamptz);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ailearn_mark_run_processing_processed(
  p_outbox_id uuid,
  p_worker_id text DEFAULT NULL,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.learning_run_processing_outbox
  SET processed_at = p_now,
      updated_at = p_now
  WHERE public.learning_run_processing_outbox.id = p_outbox_id
    AND public.learning_run_processing_outbox.processed_at IS NULL
    AND (p_worker_id IS NULL OR public.learning_run_processing_outbox.lease_owner = p_worker_id);
END;
$function$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_mark_run_processing_processed(uuid, text, timestamptz) TO ailearn_api;
REVOKE ALL ON FUNCTION public.ailearn_mark_run_processing_processed(uuid, text, timestamptz) FROM PUBLIC;
