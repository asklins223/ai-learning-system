-- 0128: understanding_route_plans 幂等键（P7 并发 CAS）。
--
-- 部分唯一索引不能用 now()（volatile）后，"同目标一个未过期 plan"由应用层
-- CAS 保证；并发双请求需要幂等键兜底：(workspace, user, idempotencyKey) 唯一，
-- 重复请求返回既有 plan（不产生多个未过期 plan）。

--> statement-breakpoint

ALTER TABLE public.understanding_route_plans
  ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT '';

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS understanding_route_plans_idempotency_unique_idx
  ON public.understanding_route_plans (workspace_id, user_id, idempotency_key)
  WHERE idempotency_key <> '';
