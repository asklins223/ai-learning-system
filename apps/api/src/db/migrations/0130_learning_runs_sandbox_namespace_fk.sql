-- 0130: learning_runs.sandbox_namespace_id 外键（§16.4 纵深）。
--
-- sandbox namespace 引用必须有归属约束：孤儿 namespace id 无法通过 createRun
-- 校验写入（唯一写入口已校验），FK 作为纵深防线。

--> statement-breakpoint

ALTER TABLE public.learning_runs
  ADD CONSTRAINT learning_runs_sandbox_namespace_fk
  FOREIGN KEY (sandbox_namespace_id)
  REFERENCES public.companion_sandbox_namespaces(id)
  ON DELETE SET NULL;
