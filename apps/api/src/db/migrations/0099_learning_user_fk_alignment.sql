-- 0099: workspace-scoped learning tables user FK alignment.
--
-- 0079 已承认：0074 建表时未落地 user_id FK（schema 侧声明了
-- references(users.id) ON DELETE CASCADE，见 db/schema/learning-sessions.ts），
-- 导致账号注销后过程数据无法级联清除（隐私合规风险，W7 审计 2026-08）。
-- 本迁移补齐 5 张主表的 user_id FK，与 schema 声明一致。
--
-- 采用 NOT VALID + VALIDATE：NOT VALID 使新写入/更新立即受引用约束，
-- VALIDATE 校验存量；若存量存在孤儿 user_id（理论上不应有，0078/0081/0083
-- 均按同一规范建表），VALIDATE 失败会在 DO 块中转为 NOTICE 记录，
-- 保留 NOT VALID 约束并继续（不阻塞后续迁移），由人工按 NOTICE 排查。

--> statement-breakpoint

DO $$
DECLARE
  orphan_count integer;
BEGIN
  -- 存量孤儿行计数（诊断用，不自动删除——数据归属需人工确认）
  SELECT count(*) INTO orphan_count
  FROM public.learning_sessions s
  LEFT JOIN public.users u ON u.id = s.user_id
  WHERE u.id IS NULL;
  IF orphan_count > 0 THEN
    RAISE NOTICE 'learning_sessions: % orphan user_id rows before FK', orphan_count;
  END IF;
END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_sessions
    ADD CONSTRAINT learning_sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_episodes
    ADD CONSTRAINT learning_episodes_user_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_session_probes
    ADD CONSTRAINT learning_session_probes_user_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_response_artifacts
    ADD CONSTRAINT learning_response_artifacts_user_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_assessment_reports
    ADD CONSTRAINT learning_assessment_reports_user_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

-- 存量校验：失败转 NOTICE（保留 NOT VALID 约束），不阻塞迁移链。
DO $$
DECLARE
  failed_constraint text;
  error_detail text;
BEGIN
  BEGIN
    ALTER TABLE public.learning_sessions VALIDATE CONSTRAINT learning_sessions_user_fk;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'VALIDATE learning_sessions_user_fk failed (orphan rows exist): %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE public.learning_episodes VALIDATE CONSTRAINT learning_episodes_user_fk;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'VALIDATE learning_episodes_user_fk failed (orphan rows exist): %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE public.learning_session_probes VALIDATE CONSTRAINT learning_session_probes_user_fk;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'VALIDATE learning_session_probes_user_fk failed (orphan rows exist): %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE public.learning_response_artifacts VALIDATE CONSTRAINT learning_response_artifacts_user_fk;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'VALIDATE learning_response_artifacts_user_fk failed (orphan rows exist): %', SQLERRM;
  END;
  BEGIN
    ALTER TABLE public.learning_assessment_reports VALIDATE CONSTRAINT learning_assessment_reports_user_fk;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'VALIDATE learning_assessment_reports_user_fk failed (orphan rows exist): %', SQLERRM;
  END;
END $$;
