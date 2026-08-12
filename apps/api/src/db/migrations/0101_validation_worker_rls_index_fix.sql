-- 0101: validation pipeline RLS worker exemption + input-unique index fix。
--
-- 1) validation_events_input_unique_idx（0034）直接以 question / user_answer
--    原文建 btree 唯一索引：PG btree 单索引条目约 2704B 上限，中文答案
--    900+ 字（UTF-8 3B/字）即报 "index row size exceeds maximum"，
--    validate_validation 事件持久化整体失败。0034 头注释原本就计划
--    hashtextextended（64 位碰撞概率极低，唯一约束在 INSERT 时拒绝第二条），
--    此处把两列改为 hash 表达式索引，语义不变（同一输入仍被拒重）。
--
-- 2) validation_submissions / validation_question_rubric_items /
--    validation_point_assessments / scheduling_shadow_decisions 自 0040/0043
--    起 RLS ENABLE（user_isolation），但从未给 ailearn_worker 豁免；
--    evaluate_rubric handler（生产角色 NOBYPASSRLS）在 assertJobLease 事务
--    结束后裸读这些表被拦成 0 行 → 评估任务必失败至 dead（测试环境 superuser
--    连接掩盖）。与 0100 同类修复：加 worker 豁免 PERMISSIVE 策略。
--    validation_questions / review_attempts 已被 0027 DISABLE，无需豁免。

--> statement-breakpoint

-- ─── 1. validation_events 唯一索引改 hash 表达式 ──────────────────────────

DROP INDEX IF EXISTS validation_events_input_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS validation_events_input_unique_idx
  ON validation_events (
    workspace_id,
    card_id,
    COALESCE(key_point_id, '00000000-0000-0000-0000-000000000000'::uuid),
    user_id,
    hashtextextended(question, 0),
    hashtextextended(user_answer, 0)
  );

COMMENT ON INDEX validation_events_input_unique_idx IS
  'Concurrency safety net (hash 表达式索引, 0034 设计意图)：以 hashtextextended 替代原文 btree,避免长答案超 PG 索引条目上限;同输入仍被唯一拒绝。';

--> statement-breakpoint

-- ─── 2. v0.6 validation 表 worker 豁免（与 0100 同思路）───────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY validation_submissions_worker_all
        ON public.validation_submissions FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY validation_question_rubric_items_worker_all
        ON public.validation_question_rubric_items FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY validation_point_assessments_worker_all
        ON public.validation_point_assessments FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    EXECUTE $policy$
      CREATE POLICY scheduling_shadow_decisions_worker_all
        ON public.scheduling_shadow_decisions FOR ALL TO ailearn_worker
        USING (CURRENT_USER = 'ailearn_worker')
        WITH CHECK (CURRENT_USER = 'ailearn_worker')
    $policy$;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
