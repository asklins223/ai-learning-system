-- 0263: 高危动作的审计留痕（审查附录 C）。
--
-- 审查原文：「`ai_audit_log`、`companion_audit` 的 workspace 维度与 RLS 状态需专项
-- 核实；导出/删除这类高危动作**是否留痕**（导出目前是一个 owner-only 的 GET，
-- 未见审计写入）」。
--
-- 核实结果：**没有留痕**。现有的两张审计表都不是这个用途——
-- `ai_audit_log` 记的是"哪次 AI 调用外发了什么类别的内容"，`companion_audit` 记的是
-- 伴星的页面动作。于是"谁在什么时候把整个空间导出去了""谁物理删掉了哪篇笔记"
-- 这两个问题在库里查不到答案。
--
-- 这一支建一张通用审计表，并把两个已知的高危动作接上。
--
-- ─── 为什么不是"再写一张 append-only 日志表" ───
-- 审计行必须与动作**同事务**写入：动作回滚了却留下"他导出了"的记录是假证据，
-- 反过来动作成功而审计丢失是缺证据。所以写入点是 `withWorkspaceTransaction` 里的
-- 同一个 tx，而不是异步队列或日志文件。
--
-- ─── 可见性 ───
-- 只有 owner 读得到本空间的审计行（与 `ai_audit_log` 的 `api_owner_read` 同一形状）；
-- 写入由 runtime 策略放行。RLS 在这张表上**第一天就 ENABLE + FORCE**：审计表如果
-- 自己不受策略约束，"谁看过审计"这件事就没有底线。

CREATE TABLE IF NOT EXISTS public.workspace_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- 动作发起人。审计的第一问是"谁"，所以 NOT NULL。
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 动作名：`export.workspace` / `note.permanent_delete` / …（点分命名，便于按前缀过滤）。
  action text NOT NULL,
  -- 被作用对象的类型与 id（空间级动作用 'workspace' + 空间 id）。
  target_kind text NOT NULL,
  target_id uuid,
  -- 结构化补充（行数、字节数、被删对象的标题等）。不放敏感正文。
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS workspace_audit_log_workspace_created_idx
  ON public.workspace_audit_log (workspace_id, created_at DESC);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS workspace_audit_log_action_created_idx
  ON public.workspace_audit_log (action, created_at DESC);

--> statement-breakpoint

ALTER TABLE public.workspace_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_audit_log FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- 租户守卫：与其余表同一形状。给了空间就按空间收；空值只可能来自 actor 事务。
CREATE POLICY sec01_v1_workspace_audit_log_tenant_guard ON public.workspace_audit_log
  AS RESTRICTIVE FOR ALL TO public
  USING (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  )
  WITH CHECK (
    NULLIF(current_setting('app.workspace_id', true), '') IS NULL
    OR workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
  );

--> statement-breakpoint

-- 写入：API 角色即可（动作本来就由已认证请求触发）。
CREATE POLICY sec01_v1_workspace_audit_log_runtime_insert ON public.workspace_audit_log
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    CURRENT_USER = 'ailearn_api'::name
    AND actor_user_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
  );

--> statement-breakpoint

-- 读取：只有空间 owner。与 `ai_audit_log` 的 `api_owner_read` 同一判据——
-- 审计记录里含"谁做了什么"，member 不该看见别人的动作。
CREATE POLICY sec01_v1_workspace_audit_log_api_owner_read ON public.workspace_audit_log
  AS PERMISSIVE FOR SELECT TO public
  USING (
    CURRENT_USER = 'ailearn_api'::name
    AND workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid
    AND EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_audit_log.workspace_id
        AND w.owner_id = (NULLIF(current_setting('app.user_id', true), ''))::uuid
    )
  );

--> statement-breakpoint

-- 审计行不可改不可删：这是"审计"与"日志"的区别。允许删就等于允许擦痕迹，
-- 而删除空间时整表会随 FK 的 CASCADE 一起走（那是空间级的销毁，不是单行擦除）。
CREATE POLICY sec01_v1_workspace_audit_log_no_update ON public.workspace_audit_log
  AS RESTRICTIVE FOR UPDATE TO public
  USING (false);

--> statement-breakpoint

CREATE POLICY sec01_v1_workspace_audit_log_no_delete ON public.workspace_audit_log
  AS RESTRICTIVE FOR DELETE TO public
  USING (false);

--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE public.workspace_audit_log TO ailearn_api;

--> statement-breakpoint

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name) INTO v_missing
  FROM (VALUES
    ('sec01_v1_workspace_audit_log_tenant_guard'),
    ('sec01_v1_workspace_audit_log_runtime_insert'),
    ('sec01_v1_workspace_audit_log_api_owner_read'),
    ('sec01_v1_workspace_audit_log_no_update'),
    ('sec01_v1_workspace_audit_log_no_delete')
  ) AS required (name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.workspace_audit_log'::regclass AND polname = required.name
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_audit_log 缺策略：%', v_missing;
  END IF;

  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
          FROM pg_class WHERE oid = 'public.workspace_audit_log'::regclass) THEN
    RAISE EXCEPTION 'workspace_audit_log 必须 ENABLE + FORCE RLS';
  END IF;

  RAISE NOTICE 'workspace_audit_log 就绪（RLS ENABLE+FORCE，5 条策略）';
END
$$;
