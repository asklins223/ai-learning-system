-- 0071: 补齐 0068/0069/0070 遗漏的 least-privilege GRANT(review should-fix)
-- 对照 0044:399-407 模式:按角色存在性授权,保证 roles.sql 未重放前角色也可用。
-- ailearn_api:读写 card_generation_plans / provisional_candidates(API 层编排/查询);
-- ailearn_worker:写 plan/候选(生成流程),读取无需 SELECT(经 RLS workspace 隔离)。

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.card_generation_plans TO ailearn_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.provisional_candidates TO ailearn_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT ON public.card_generation_plans TO ailearn_worker;
    GRANT SELECT, INSERT, UPDATE ON public.provisional_candidates TO ailearn_worker;
  END IF;
END $$;
