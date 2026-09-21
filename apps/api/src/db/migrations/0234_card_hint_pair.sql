-- 0234: 候选与目标修订各新增私有 hints 列——提示由作者在制卡时产出。
--
-- 背景（2026-09-20 实走复盘 #10）：作答时点「给我一点提示」拿到的是
-- run-planner.ts:746 的 `buildDeterministicHint` —— 一张 9 意图 × 3 条文案的**常量表**，
-- 只按 task.intent 取值，卡片正文完全不参与。所以任意两张卡的第一级提示一字不差，
-- 用户判断为"写死的、没用"，这个判断是对的。
--
-- 修法要求提示在**生成学习卡阶段**随卡片一起产出，于是需要一个服务端私有的存放处：
--   - 不能放 learning_task_variants.interaction：那是**公开交互载荷**，客户端进页面就拿到，
--     等于绕过 exposure ledger 白送提示；而提示一旦下发会永久把该卡计分降级为
--     practice_only（run-processing-tick.ts:611），下发必须是记账的、按需的动作。
--   - 不能放 learning_support：那张 jsonb 受 R30「必须严格基于证据」约束，并由
--     Grounding Critic 逐字段核对。提示是**教学引导不是事实断言**（"先想它的两个
--     组成部分"无法指回证据），混进去会被误杀。
--   - learning_tasks 上没有任何私有 jsonb，且任务每个 run 重建，提示应作者一次、
--     跨 run 复用。
-- 因此落在 objective revision 上：与 canonical_answer / learning_support 同层，
-- 由激活从候选的 objectiveDraft 原样搬过来。
--
-- 默认 '{}' 表示"这张卡没有作者产出的提示"（历史行、以及模型漏交时走兜底之外的情况），
-- 读取方此时退回确定性文案，绝不出空提示。
--
-- 不进 target_revision_hash / private_payload_hash / candidate_revision_hash：
-- 前两个哈希覆盖的是**判分相关**内容（答案单元、rubric、证据绑定），提示不影响判分
-- 结果；candidate_revision_hash 由 computeCandidateRevisionHashV2 对整个候选对象取
-- 哈希，所以提示必须做候选行的**兄弟列**而不是塞进 objective_draft /
-- presentation_draft —— 塞进去就把提示并进了判分内容的同一条审计链。
--
-- 幂等：ADD COLUMN IF NOT EXISTS。

--> statement-breakpoint

ALTER TABLE public.card_generation_candidates_v2
  ADD COLUMN IF NOT EXISTS hints jsonb NOT NULL DEFAULT '{}'::jsonb;

--> statement-breakpoint

ALTER TABLE public.learning_objective_revisions_v2
  ADD COLUMN IF NOT EXISTS hints jsonb NOT NULL DEFAULT '{}'::jsonb;
