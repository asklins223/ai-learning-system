-- 2026-09-23 性能重扫收尾：删掉 6 棵**形状重复**的索引（docs/performance-scan-2026-09-22.md）。
--
-- 判据一律是"静态可证的重复"，不是"pg_stat 里没扫过"。开发库只有几十到几百行，
-- idx_scan 为 0 只能说明本地没跑到，说明不了上线后没人用；反过来"两棵索引的列、
-- 顺序、空值序、谓词完全等价"则与数据量无关，任何时候都成立。每一条都单独核过等价性：
--
--   1–3) 三对**列清单逐字节相同**的索引，其中一棵是 UNIQUE（约束必须留），另一棵非唯一
--        → 非唯一那棵对任何扫描都是多余的：同样的键、同样的顺序，规划器把它换成
--        UNIQUE 那棵是等价改写。
--        · assistant_deliveries: inbox_idx (workspace_id, user_id, inbox_sequence)
--          与 inbox_sequence_unique_idx 同键。实测当前热点在被删的这棵上
--          （idx_scan 19694 vs 352），删后这些查询改走 UNIQUE 那棵——已用 EXPLAIN 对过
--          （见本报告"续批五"）。
--        · card_generation_plans_v2: cg_v2_plan_run_idx (workspace_id, run_id, plan_version)
--          与 cg_v2_plan_run_version_idx 同键（3316 vs 16，同理）。
--        · note_versions: note_versions_note_idx (note_id, version_no)
--          与 note_versions_unique_idx 同键（0 vs 44759）。
--
--   4–5) search_documents 上那两棵"部分 GIN"：谓词是 workspace_id IS NOT NULL，而这一列
--        在 information_schema 里就是 is_nullable='NO'——**恒真谓词的部分索引**等价于
--        全量索引，于是它们与 search_documents_body_trgm_idx / title_trgm_idx 是逐字节
--        重复的两棵 gin_trgm_ops 树。这两棵是全场最贵的重复：开发库 58 行正文上
--        各占 3320 kB 与 120 kB，而每张搜索文档写入都要同时喂两棵树。
--
--   6)   card_generation_candidates_v2 的 (workspace_id, run_id, candidate_id, revision DESC)
--        与 (workspace_id, run_id, candidate_id, revision)：普通 btree 可以**反向扫描**，
--        正序那棵反着走就得到"DESC 且 NULLS FIRST"。这里两列都 NOT NULL（实测），
--        所以空值序也没有差别，DESC 那棵纯属第二份维护成本。
--        删的这棵当前 idx_scan=5757（是热的那棵），所以本条**必须**看 EXPLAIN 证据：
--        删后计划变成 `Index Scan Backward using cg_v2_cand_run_idx`，见续批五。
--
-- 没有一起删的相邻两条，理由写在续批五里：companion_reminders 那对同键索引中
-- 有一棵（companion_reminders_ws_user_idx）既不在任何迁移里、也不在 Drizzle schema 里，
-- 属于开发库漂移，不能由本迁移替它做主；notes_active_idx 与 notes_workspace_idx
-- 是"部分 vs 全量"的正常分工（谓词 deleted_at IS NULL 有真实筛选力），不是重复。

DROP INDEX IF EXISTS public.assistant_deliveries_inbox_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS public.cg_v2_plan_run_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS public.note_versions_note_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS public.search_documents_workspace_body_trgm_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS public.search_documents_workspace_title_trgm_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS public.cg_v2_cand_latest_idx;
