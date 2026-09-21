-- 0237: AI 使用同意与数据外发政策从「工作区级」迁到「账号级」。
--
-- 起因（2026-09-20 多空间审查）：`PRODUCT.md:50` 写的是"工作区级 AI 使用同意，
-- Owner 签署"，代码也照此落（`workspaces` 上的四列 + `PUT /workspace/ai-consent`
-- 挂 requireOwner）。但同意管的是"**我的内容能不能送出去**"——它的授权范围只能是
-- 本人。挂在空间上意味着：我加入你的空间，就被**你的**同意决定了我的笔记会被外发
-- 到哪个模型、哪个政策下，授权链在"加入"这一步直接断裂。
--
-- 产品裁决（2026-09-20）：同意只影响本人，不属于学习空间；因此从 workspaces 摘除。
-- 空间内共享的是**资料**——资料一旦放进协作空间即视为可被该空间成员的伴星读取与
-- 外发，这一条在"放入"时明示，而不是由某个 owner 替所有人签。
--
-- 迁移策略：先把每个人**自己个人空间**上的既有同意搬到他的账号上（不丢签署记录），
-- 再删列。开发库可重建，因此不留兼容视图与转发层（AGENTS.md）。
--
-- RLS：新表按 `user_id` 隔离（没有 workspace_id 列，账号级数据与空间无关）。
-- 注意 `getAIPrivacySettings` 一类读取必须走 `withWorkspaceTransaction`——这张表
-- 启用了 RLS，不设置 `app.user_id` 的查询会**静默返回 0 行**，表现成"同意永远未签"，
-- 而不是报错。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.user_ai_settings (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  consent_version text,
  consent_at timestamptz,
  data_policy jsonb NOT NULL DEFAULT
    '{"sendToExternal": false, "sendImageContent": false, "piiDetection": true, "auditLogging": true}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- 回填：取每个人自己个人空间上的签署结果。
-- 个人空间的 owner 就是本人，所以这一行的同意确实是"他为自己签的"，语义无损。
-- 幂等：ON CONFLICT 不覆盖已存在的行，重跑不会把新写入的政策回退成旧值。
INSERT INTO public.user_ai_settings (user_id, consent_version, consent_at, data_policy)
SELECT
  w.owner_id,
  w.ai_consent_version,
  w.ai_consent_at,
  w.ai_data_policy
FROM public.workspaces w
WHERE w.workspace_type = 'personal'
  AND w.owner_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

--> statement-breakpoint

ALTER TABLE public.user_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_ai_settings FORCE ROW LEVEL SECURITY;

-- 先 DROP 再 CREATE：migrate.ts 按 sha256(文件内容) 判断是否已应用，改动本文件会让
-- 它在已应用过的库上重跑；Postgres 没有 CREATE POLICY IF NOT EXISTS。
DROP POLICY IF EXISTS user_ai_settings_user_isolation ON public.user_ai_settings;
CREATE POLICY user_ai_settings_user_isolation
  ON public.user_ai_settings FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_ai_settings TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_ai_settings TO ailearn_worker;

--> statement-breakpoint

-- 摘除工作区上的四列。`ai_consent_by` 记录"谁替这个空间签的"，迁到账号级之后
-- 签署人恒等于 user_id，这一列不再有意义。
ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS ai_consent_version,
  DROP COLUMN IF EXISTS ai_consent_at,
  DROP COLUMN IF EXISTS ai_consent_by,
  DROP COLUMN IF EXISTS ai_data_policy;
