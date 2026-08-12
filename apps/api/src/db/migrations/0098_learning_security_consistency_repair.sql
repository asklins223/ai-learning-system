-- 0098: consistency repair bundle（2026-08 审查修复，修订版）。
--
-- 最终版（2026-08-11 第三稿）：在测试环境完成 jobs RLS 重开与 outbox 租约
-- 收紧。worker 侧全部 jobs/outbox 裸访问已收口：
--   * jobs 写：queue.ts（workspace 事务内）、reconciler（函数）、
--     unit-helpers createNextTurnJob（整体 workspace 事务）；
--   * jobs 跨 workspace 维护读：index.ts 三处改调下方 SECURITY DEFINER 函数；
--   * outbox 消费：claim/process/release 事务内设置 app.worker_id。
-- 因此可以安全恢复 0019/0039 的 jobs RLS（0024 ENABLE+FORCE 被 0027 failsafe
-- 暂停，此处重新启用）并收紧 0081 outbox worker 分支的租约约束。
-- 本迁移的完整修复：
--   1) jobs RLS 重开（ENABLE + FORCE）+ 维护读/写函数收口；
--   2) 0081 outbox policy：worker 分支增加 lease_owner 租约约束（app.worker_id）；
--   3) outbox payload 敏感键 CHECK 补全 rationale/chainOfThought（0078/0084 对齐）；
--   4) learning_episodes status='completed' ⇒ processing_phase='committed' 一致性；
--   5) learning_tutor_detours 同一 episode 至多一个 active detour 的部分唯一索引；
--   6) TTL 清理 SECURITY DEFINER 函数（migrator owner BYPASSRLS 绕过 RLS，
--      API 经 EXECUTE 调用，使 0076/0081/0083 的 TTL 承诺真正落地）。

--> statement-breakpoint

-- ─── 1. jobs RLS 重开与维护函数收口 ──────────────────────────────────────
-- 跨 workspace 维护查询（index.ts projectReapedGenerationJobs /
-- reconcileTerminalGenerationJobs / refreshQueueMetrics）与
-- reconciler 的 dead-job 标记全部经 SECURITY DEFINER 函数（migrator owner
-- BYPASSRLS，函数内绕过 RLS）；worker 仅 EXECUTE，不直接 SELECT/UPDATE
-- 任意 workspace 的 job 行（保留 SELECT+UPDATE 表权限但受 RLS 行级约束）。

CREATE OR REPLACE FUNCTION public.ailearn_mark_dead_jobs_under_terminal_runs()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH updated AS (
    UPDATE public.jobs
    SET status = 'dead',
        finished_at = NOW()
    WHERE jobs.status IN ('pending', 'running')
      AND jobs.generation_run_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.card_generation_runs
        WHERE card_generation_runs.id = jobs.generation_run_id
          AND card_generation_runs.engine_mode = 'supervisor_agent_v1'
          AND card_generation_runs.status IN ('succeeded', 'partial_ready', 'cancelled', 'superseded')
      )
    RETURNING jobs.id
  )
  SELECT count(*)::integer FROM updated;
$function$;

-- projectReapedGenerationJobs：按 id 取 reaped 的 dead job（窄列集）。
CREATE OR REPLACE FUNCTION public.ailearn_find_reaped_generation_jobs(
  p_ids uuid[]
)
RETURNS TABLE(
  id uuid,
  type text,
  payload jsonb,
  workspace_id uuid,
  requested_by uuid,
  attempts integer,
  generation_run_id uuid,
  last_error text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    j.id, j.type, j.payload, j.workspace_id, j.requested_by, j.attempts,
    j.generation_run_id, j.last_error
  FROM public.jobs AS j
  WHERE j.id = ANY(p_ids)
    AND j.status = 'dead';
$function$;

-- reconcileTerminalGenerationJobs：每 generation_unit 最新一条 dead job id
--（与 index.ts 原 SQL 语义逐字一致）。
CREATE OR REPLACE FUNCTION public.ailearn_latest_dead_generation_job_ids(
  p_batch_size integer
)
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH latest_generation_jobs AS (
    SELECT DISTINCT ON (generation_unit_id)
      id,
      generation_run_id,
      generation_unit_id,
      status
    FROM public.jobs
    WHERE generation_run_id IS NOT NULL
      AND generation_unit_id IS NOT NULL
      AND scheduled_at >= clock_timestamp() - interval '30 days'
    ORDER BY
      generation_unit_id,
      COALESCE(finished_at, started_at, scheduled_at) DESC,
      id DESC
  )
  SELECT latest.id
  FROM latest_generation_jobs AS latest
  JOIN public.card_generation_units AS generation_unit
    ON generation_unit.id = latest.generation_unit_id
  JOIN public.card_generation_runs AS generation_run
    ON generation_run.id = latest.generation_run_id
  WHERE latest.status = 'dead'
    AND generation_unit.status NOT IN (
      'succeeded',
      'terminal_failed',
      'cancelled',
      'superseded'
    )
    AND generation_run.status NOT IN (
      'needs_attention',
      'partial_ready',
      'succeeded',
      'cancelled',
      'superseded'
    )
  ORDER BY latest.id
  LIMIT greatest(1, least(p_batch_size, 1000));
$function$;

-- refreshQueueMetrics：队列深度按状态分组。
CREATE OR REPLACE FUNCTION public.ailearn_queue_job_depth()
RETURNS TABLE(status text, total integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT status::text AS status, count(*)::integer AS total
  FROM public.jobs
  GROUP BY status;
$function$;

-- refreshQueueMetrics：最老 pending job 的等待秒数。
CREATE OR REPLACE FUNCTION public.ailearn_queue_oldest_pending_age()
RETURNS double precision
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(
    EXTRACT(EPOCH FROM (clock_timestamp() - min(scheduled_at))),
    0
  )::double precision
  FROM public.jobs
  WHERE status = 'pending';
$function$;

-- 跨 workspace 对账补投（specialist-persist resume / reconciler resume job）：
-- 统一经此函数入队（migrator owner BYPASSRLS），worker 不直接 INSERT jobs。
-- 与 drizzle 的 onConflictDoNothing() 语义一致：任意唯一冲突静默跳过。
CREATE OR REPLACE FUNCTION public.ailearn_enqueue_agent_turn_job(
  p_workspace_id uuid,
  p_requested_by uuid,
  p_generation_run_id uuid,
  p_generation_unit_id uuid,
  p_turn_no integer,
  p_input_hash text,
  p_priority integer,
  p_resource_class text,
  p_idempotency_key text,
  p_user_id text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  INSERT INTO public.jobs (
    type, workspace_id, requested_by, payload, status, generation_run_id,
    generation_unit_id, stage, priority, resource_class, idempotency_key,
    scheduled_at
  ) VALUES (
    'execute_card_agent_turn', p_workspace_id, p_requested_by,
    jsonb_build_object(
      'generationRunId', p_generation_run_id,
      'agentUnitId', p_generation_unit_id,
      'turnNo', p_turn_no,
      'inputHash', p_input_hash,
      'userId', p_user_id
    ),
    'pending', p_generation_run_id, p_generation_unit_id, 'complete',
    p_priority, p_resource_class, p_idempotency_key, now()
  )
  ON CONFLICT DO NOTHING
  RETURNING id;
$function$;

-- reconcileStuckSupervisors 的"是否已有 pending/running job"检查
--（跨 workspace 对账读，RLS 下 worker 裸 SELECT 会被 tenant guard 拦）。
CREATE OR REPLACE FUNCTION public.ailearn_find_active_turn_job(
  p_workspace_id uuid,
  p_run_id uuid,
  p_unit_id uuid
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT j.id
  FROM public.jobs AS j
  WHERE j.workspace_id = p_workspace_id
    AND j.generation_run_id = p_run_id
    AND j.generation_unit_id = p_unit_id
    AND j.status IN ('pending', 'running')
  LIMIT 1;
$function$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    REVOKE ALL ON FUNCTION
      public.ailearn_mark_dead_jobs_under_terminal_runs(),
      public.ailearn_find_reaped_generation_jobs(uuid[]),
      public.ailearn_latest_dead_generation_job_ids(integer),
      public.ailearn_queue_job_depth(),
      public.ailearn_queue_oldest_pending_age(),
      public.ailearn_enqueue_agent_turn_job(uuid, uuid, uuid, uuid, integer, text, integer, text, text, text),
      public.ailearn_find_active_turn_job(uuid, uuid, uuid)
      FROM PUBLIC, ailearn_api;
    GRANT EXECUTE ON FUNCTION
      public.ailearn_mark_dead_jobs_under_terminal_runs(),
      public.ailearn_find_reaped_generation_jobs(uuid[]),
      public.ailearn_latest_dead_generation_job_ids(integer),
      public.ailearn_queue_job_depth(),
      public.ailearn_queue_oldest_pending_age(),
      public.ailearn_enqueue_agent_turn_job(uuid, uuid, uuid, uuid, integer, text, integer, text, text, text),
      public.ailearn_find_active_turn_job(uuid, uuid, uuid)
      TO ailearn_worker;
  END IF;
END $$;

-- 重新启用 jobs RLS（0024 的 0019/0039 策略定义仍在，此处恢复 ENABLE+FORCE）。
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

-- 0039 insert_actor_guard 用普通 `=`，requested_by IS NULL 的 job
--（对账补投，p_requested_by=NULL）在续跑 createNextTurnJob 裸 INSERT 时会被拒
-- （NULL = NULL → NULL → RESTRICTIVE 拒绝）。与 worker_update_actor_guard 的
-- IS NOT DISTINCT FROM 对齐：仅放宽 requested_by 为 NULL 的兼容，非 NULL 仍要求相等。
DROP POLICY IF EXISTS "sec01_v1_jobs_insert_actor_guard" ON public.jobs;
CREATE POLICY "sec01_v1_jobs_insert_actor_guard"
  ON public.jobs AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    "requested_by" IS NOT DISTINCT FROM
      NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

-- ─── 2. outbox worker 分支租约约束（0081 policy 收紧）────────────────────
-- worker 分支：只能 claim/更新 lease_owner IS NULL 或属于自己
-- （app.worker_id）的行；worker 消费事务已在代码层设置 app.worker_id。

DROP POLICY IF EXISTS learning_session_processing_outbox_workspace_user_isolation
  ON public.learning_session_processing_outbox;
CREATE POLICY learning_session_processing_outbox_workspace_user_isolation
  ON public.learning_session_processing_outbox FOR ALL
  USING (
    (
      CURRENT_USER = 'ailearn_worker'
      AND (
        lease_owner IS NULL
        OR lease_owner = NULLIF(current_setting('app.worker_id', true), '')
        -- 过期租约豁免：worker 崩溃未走 release 的行，其它 worker 可回收
        --（claim 的候选条件本身要求 lease_expires_at <= now，这里只放行 USING）。
        OR (lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp())
      )
    )
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    (
      CURRENT_USER = 'ailearn_worker'
      AND (
        lease_owner IS NULL
        OR lease_owner = NULLIF(current_setting('app.worker_id', true), '')
      )
    )
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

-- ─── 2. outbox payload 敏感键 CHECK 补全 ───────────────────────────────────

ALTER TABLE public.learning_session_processing_outbox
  DROP CONSTRAINT IF EXISTS learning_session_processing_outbox_payload_check;
ALTER TABLE public.learning_session_processing_outbox
  ADD CONSTRAINT learning_session_processing_outbox_payload_check
  CHECK (
    NOT (payload ? 'answer')
    AND NOT (payload ? 'answerText')
    AND NOT (payload ? 'userAnswer')
    AND NOT (payload ? 'question')
    AND NOT (payload ? 'rationale')
    AND NOT (payload ? 'chainOfThought')
  );

--> statement-breakpoint

-- ─── 3. episodes phase 一致性 ─────────────────────────────────────────────

-- 存量修复：已 completed 但 phase 未置 committed 的行对齐（约束前置条件）。
UPDATE public.learning_episodes
SET processing_phase = 'committed'
WHERE status = 'completed' AND processing_phase IS DISTINCT FROM 'committed';

DO $$ BEGIN
  ALTER TABLE public.learning_episodes
    ADD CONSTRAINT learning_episodes_phase_status_check
    CHECK (
      (status = 'completed' AND processing_phase = 'committed')
      OR (status <> 'completed')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

-- ─── 4. tutor detours active 唯一 ─────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS learning_tutor_detours_episode_active_unique_idx
  ON public.learning_tutor_detours (workspace_id, user_id, episode_id)
  WHERE status = 'active';

--> statement-breakpoint

-- ─── 5. TTL 清理 SECURITY DEFINER 函数（0076/0081/0083 TTL 落地）──────────
-- 四张表均 RLS ENABLE+FORCE（workspace_id+user_id 隔离），API 连接（ailearn_api
-- NOBYPASSRLS）裸查询会全部被拦成 0 行；因此清理经 migrator owner（BYPASSRLS）
-- 的 SECURITY DEFINER 函数执行，API 仅 EXECUTE。参数化 retention_days/limit。

CREATE OR REPLACE FUNCTION public.ailearn_purge_companion_audit_ttl(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.companion_audit
    WHERE created_at < now() - make_interval(days => p_retention_days)
      AND tombstoned_at IS NULL
    LIMIT p_limit
  ), updated AS (
    UPDATE public.companion_audit
    SET page_opaque_id = NULL,
        action_opaque_id = NULL,
        entity_opaque_ids = '{}',
        context_permission_hashes = NULL,
        tombstoned_at = now()
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM updated;
$function$;

CREATE OR REPLACE FUNCTION public.ailearn_purge_invitation_ledger_ttl(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.companion_invitation_ledger
    WHERE created_at < now() - make_interval(days => p_retention_days)
      AND tombstoned_at IS NULL
    LIMIT p_limit
  ), updated AS (
    UPDATE public.companion_invitation_ledger
    SET bounded_reason = NULL,
        suggestion_lease = NULL,
        one_time_permit = NULL,
        tombstoned_at = now(),
        updated_at = now()
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM updated;
$function$;

CREATE OR REPLACE FUNCTION public.ailearn_purge_processed_outbox_ttl(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.learning_session_processing_outbox
    WHERE processed_at IS NOT NULL
      AND processed_at < now() - make_interval(days => p_retention_days)
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.learning_session_processing_outbox
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM deleted;
$function$;

CREATE OR REPLACE FUNCTION public.ailearn_purge_tutor_nonces_ttl(
  p_retention_days integer DEFAULT 7,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH target AS (
    SELECT id
    FROM public.learning_tutor_action_nonces
    WHERE (consumed_at IS NOT NULL AND consumed_at < now() - make_interval(days => p_retention_days))
       OR (consumed_at IS NULL AND expires_at < now() - make_interval(days => p_retention_days))
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.learning_tutor_action_nonces
    WHERE id IN (SELECT id FROM target)
    RETURNING id
  )
  SELECT count(*)::integer FROM deleted;
$function$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    REVOKE ALL ON FUNCTION
      public.ailearn_purge_companion_audit_ttl(integer, integer),
      public.ailearn_purge_invitation_ledger_ttl(integer, integer),
      public.ailearn_purge_processed_outbox_ttl(integer, integer),
      public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      FROM PUBLIC, ailearn_worker;
    GRANT EXECUTE ON FUNCTION
      public.ailearn_purge_companion_audit_ttl(integer, integer),
      public.ailearn_purge_invitation_ledger_ttl(integer, integer),
      public.ailearn_purge_processed_outbox_ttl(integer, integer),
      public.ailearn_purge_tutor_nonces_ttl(integer, integer)
      TO ailearn_api;
  END IF;
END $$;
