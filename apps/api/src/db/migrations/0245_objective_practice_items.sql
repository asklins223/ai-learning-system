-- 0245: 客观练习件落库（选择 / 判断 / 排序 / 配对）。
--
-- 背景（2026-09-21 用户实走：「从始至终没看到过一道非主观题」）：判分链路里
-- 唯一被派给学习者的作答形态就是自由文本 + LLM critic，所以每一道题都是主观题。
-- 排查结论（docs/plans/objective-card-items-2026-09-21.md §1）分两层：
--   1) 引擎其实在——结构题（ordering / relation_canvas / repair）有确定性判分
--      `deterministic_structured`（migration 0123：只产 verdicts，绝不产 canonical），
--      界面编辑器也在；但它只吃 canonicalAnswer 的显式结构
--      （ordered_steps / mapping / comparison），而全库 47 个有答案的目标修订里
--      这三样一共只有 2 个，157 个冻结快照中仅 3 个可能出结构题；
--   2) 选择题 / 判断题在代码库里从来没有过（交互种类里无 single_choice / true_false）。
-- 所以作者产出的客观题素材需要一个存放处，一路带到规划器读取的冻结快照。
--
-- 为什么落在 revision 一张表（与 0234 的 hints 同路径）：
--   - 不能放 `learning_support`：那列受 R30「必须严格基于证据」约束并由 Grounding
--     Critic 逐字段核对，且它是**讲解内容**；练习件的正确项是**判分内容**。
--   - 快照侧不需要加列：§16.4 规定 planner 只从 frozen snapshot 消费
--     （run-planner.ts:33 PlannerV2Target），而它读的是
--     `learning_target_snapshots_v2.target` 这一整坨 jsonb
--     （run-service.ts:733 取 `frozen.snapshot.target.relations`；该 jsonb 在
--     target-snapshot-adapter.ts:500 由 revision 逐字段拼装）。practiceItem 随
--     `target` 一起冻下去即可，再加一列就是没人读的死角。
--   - 正确项必须在 revision 哈希闭包内 —— 与 hints 相反（提示不是判分内容，
--     当初被明确要求排除在闭包之外）。
--
-- 与 0234 的 `NOT NULL DEFAULT '{}'` 故意不同：practice_item 是判别联合，
-- `'{}'` 不是任何一个合法分支，读方还得额外分辨；这里用 NULL 表示
-- 「这张卡没有客观练习件」——它本身就是诚实的状态，绝不为凑数伪造一道题。
--
-- 存量行不回填：开发库可重建，且历史卡本来就没有作者产出的干扰项，
-- 凭空造选项等于制造无证据的干扰项（§16.5 明令禁止）。

--> statement-breakpoint

ALTER TABLE public.learning_objective_revisions_v2
  ADD COLUMN IF NOT EXISTS practice_item jsonb;
