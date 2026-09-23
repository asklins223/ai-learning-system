-- 2026-09-22 性能重扫 H3 / H8（docs/performance-scan-2026-09-22.md）。
-- 两条都是"谓词侧完全没有可用索引"，且都**不以 workspace_id 打头**，所以现有
-- 那批租户复合索引一条都帮不上。

-- 1) workspace_members 至今只有一个索引：`workspace_members_pk (workspace_id, user_id)`
--    （269 个迁移里没有第二个）。`user_id` 落在第二列，因此只带 user_id 的读法用不上它：
--    实测 `EXPLAIN SELECT 1 FROM workspace_members WHERE user_id=$1 AND left_at IS NULL`
--    得到的是 `Seq Scan`。走这个形状的有：
--      · 登录取活跃空间列表         identity/service.ts:197-201
--      · 列举/切换工作区与配额检查   identity/service.ts:626-631、:586-587
--      · 两个 SECURITY DEFINER 触发函数体内部
--        0261_workspace_epoch.sql:123、0267_cross_space_global_memories.sql:186
--    最后这组是**成员写入时**跑的，也就是说这条全表扫被写路径放大：一次加入空间
--    要按"每个全局记忆 × 每个其它空间"各扫一遍 membership。
--
--    刻意做成**非部分**索引：`:445-451` 一类只带 user_id、不带 `left_at IS NULL` 的
--    读法也要能命中，`WHERE left_at IS NULL` 的部分索引对它们是不可用的。每个用户的
--    成员行本来就只有几行，left_at 留在堆上过滤即可。
CREATE INDEX IF NOT EXISTS workspace_members_user_idx
  ON public.workspace_members (user_id);

-- 2) card_generation_runs_v2 的 4 个二级索引全部以 workspace_id 打头，`user_id`
--    不在任何一个里。按笔记收窄的那几条（generation-run-service.ts:186-192、
--    :487-493）还能靠 `cg_v2_ws_note_idx` 把候选降到"这篇笔记的运行"，
--    真正没人服务的是**只按 (workspace_id, user_id)** 过滤的活动流
--    （activity/service.ts:225-232，而活动流是首页会轮询的）。
--
--    没有顺手再加 `(workspace_id, note_id, updated_at DESC)` 是有意的：:487-493
--    每篇笔记只有个位数运行行，多一次小型排序比在这张写热表上多养一棵树便宜。
--    等真实数据量下量到排序成本再说。
--    （不带 DESC：单列方向的排序 Postgres 会把普通 btree 反着扫，写 DESC 只是白约束
--      未来的复用形状，也与这张表其余索引的声明一致。）
CREATE INDEX IF NOT EXISTS cg_v2_ws_user_created_idx
  ON public.card_generation_runs_v2 (workspace_id, user_id, created_at);
