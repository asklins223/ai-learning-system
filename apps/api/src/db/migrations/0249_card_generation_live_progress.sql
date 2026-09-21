-- 0249: 生成过程的**实时进度读数**表（#2「进度不是一格格走」的根治点）。
--
-- 症状与真因（docs/plans/objective-card-items-2026-09-21.md §12/§21，两次真跑实测）：
-- 四阶段管道整个跑在**一个**事务里，候选行与 `run.status` 都到提交才可见，所以
-- `progress.authored` 在 `authoring` 期间恒为 0——界面上那一格永远不动。这不是读数
-- 写错了，是读数**无从读到**：数据还不存在。
--
-- 为什么不直接逐候选提交（那是 §18 的 A1）：调研（§21）给出两条否决——入口守卫
-- `run.status !== 'planning' → return` 会让重投的 job 对着已提交的 `authoring` 静默
-- 空转，把 run 永久钉死在 `authoring`（in-flight 守卫只看 status+error_code，此后这篇
-- 笔记每次生成都吃 409）；而 `insertAuthoredCandidatesBatched` 是裸 INSERT，没有
-- ON CONFLICT 也没有先删后插，逐候选提交等于把重复候选放出来。A1 需要先做重放语义
-- 与候选幂等，是独立一批。
--
-- 本表因此只承担"读数"：**产物仍然原子提交**，进度数字改为由管道在每张卡写完时
-- 用一个毫秒级短事务写到这里，读取端在 run 未到终态时优先读它。
--
-- 三个刻意的"没做"：
-- 1. **不建指向 `card_generation_runs_v2` 的外键**。外键会对被引用行取 KEY SHARE，
--    而那条 run 行正被管道事务 `FOR UPDATE` 持有（分钟级）——加了外键，进度写入会
--    一直阻塞到整批 LLM 跑完，这张表就白造了。孤儿行由 `workspace_id` 级联与
--    "只在非终态被读"两条兜底。
-- 2. **不给 DELETE/清理**。到终态后读取端不再看这张表（改回按候选表数），留着旧值
--    无害；同 run 再次生成时由 upsert 覆盖，写入门禁靠 `lease_token` 判活。
-- 3. **`lease_token` 不指向 outbox**。它是 fence 值本身：写入方先只读核对"这条租约
--    还在、还没过期"，不通过就静默不写，过期租约的旧 worker 便写不进读数。
--    核对用只读而非 `FOR UPDATE` 也是刻意的——管道事务里的 `fenceV2OutboxLease`
--    会 UPDATE 同一行并持锁到提交，加锁读会排在它后面阻塞分钟级。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.card_generation_run_progress_v2 (
  run_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lease_token uuid NOT NULL,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_generation_run_progress_v2_progress_chk
    CHECK (jsonb_typeof(progress) = 'object')
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS card_generation_run_progress_v2_workspace_idx
  ON public.card_generation_run_progress_v2 (workspace_id);

--> statement-breakpoint

ALTER TABLE public.card_generation_run_progress_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_run_progress_v2 FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- 先 DROP 再 CREATE：本文件若在已应用过的库上重跑，缺这一行会停在
-- "policy already exists"（与 0237/0238/0244 同一处理）。
DROP POLICY IF EXISTS card_generation_run_progress_v2_workspace_isolation
  ON public.card_generation_run_progress_v2;
CREATE POLICY card_generation_run_progress_v2_workspace_isolation
  ON public.card_generation_run_progress_v2 FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

-- worker 的 INSERT/UPDATE 授权来自 roles.sql（唯一授权源，每次 bootstrap 先 REVOKE ALL
-- 再按清单重授）；API 只读，且必须在迁移里显式给——dev 栈不跑 compose 里那个一次性的
-- role-grants 服务，缺这一行的症状是"读不到读数、进度回到恒 0"。
GRANT SELECT ON TABLE public.card_generation_run_progress_v2 TO ailearn_api;
