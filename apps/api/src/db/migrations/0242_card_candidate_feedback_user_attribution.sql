-- 0242: 学习卡候选的人工判定要能归到人（批次 3 归属修复）。
--
-- `card_candidate_feedback_v2` 记的是"这个人驳回/留下了这张卡、理由是什么"——
-- 它是**行为**，不是资料。表上只有 workspace_id，所以协作空间里两个人的判定混在
-- 一起分不开，也没法像 review_schedules 那样按人收口。补 user_id 并让它非空。
--
-- 旧行怎么处理：现有 58 行里有 45 行的 run 已经不在 `card_generation_runs_v2`
-- 里了（测试夹具删 run 留下的孤儿）。孤儿行既不能凭空归因给谁，也不该假装是空间
-- 所有者的判断，所以直接删——本项目未上线、开发库可重建，这 45 行全是夹具残留，
-- 不是用户数据。能回溯到 run 的 13 行按 run 的 user_id 回填。

--> statement-breakpoint

ALTER TABLE public.card_candidate_feedback_v2
  ADD COLUMN IF NOT EXISTS user_id uuid;

--> statement-breakpoint

DELETE FROM public.card_candidate_feedback_v2 f
 WHERE NOT EXISTS (
   SELECT 1 FROM public.card_generation_runs_v2 r WHERE r.id = f.run_id
 );

--> statement-breakpoint

UPDATE public.card_candidate_feedback_v2 f
   SET user_id = r.user_id
  FROM public.card_generation_runs_v2 r
 WHERE r.id = f.run_id
   AND f.user_id IS NULL;

--> statement-breakpoint

ALTER TABLE public.card_candidate_feedback_v2
  ALTER COLUMN user_id SET NOT NULL;

--> statement-breakpoint

ALTER TABLE public.card_candidate_feedback_v2
  ADD CONSTRAINT ccf_v2_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
