-- 0250：给桌宠日记加**失败原因**列（用户抱怨「日记跟系统统计数据有什么区别」的落地半场）。
--
-- 日记正文从确定性模板（`companion-daily-summary.ts` 的 `buildSummaryText()`）换成
-- 由她按 `pet_profiles` 人格第一人称写之后，"没有日记"就有了三种完全不同的成因，
-- 而它们对用户的意义不一样：
--   consent_required   —— 这一天的内容没获准外发，她压根没动笔；重试无意义。
--   model_unavailable  —— 她试了，模型那次没回来；job 会重试，之后成功会覆盖。
--   diary_output_invalid —— 她写回来的东西不像日记（在报数，或空到不像话）；不重试。
-- 以前只有 `status IN ('generated','failed')`（`0170_companion_memory_context.sql:309`），
-- 三种挤成一句"生成失败"，用户既不知道该去开哪个开关，也没法判断是不是我们的问题。
--
-- 为什么新增一列而不是给 status 加取值：status 的 CHECK 是既有约束，加取值要
-- DROP + ADD 重挂，且 `companion-thought.ts` 与只读路由都按 `status='generated'` 判
-- "有没有正文"，把成因塞进取值域会让"有没有"和"为什么没有"两件事共用一个字段。
-- 新列可空 ⇒ 历史行不动、不回填（用户明确要求旧日子保持原样）。
ALTER TABLE public.companion_daily_summaries
  ADD COLUMN IF NOT EXISTS failure_reason text;

ALTER TABLE public.companion_daily_summaries
  DROP CONSTRAINT IF EXISTS companion_daily_summaries_failure_reason_check;
ALTER TABLE public.companion_daily_summaries
  ADD CONSTRAINT companion_daily_summaries_failure_reason_check
  CHECK (failure_reason IS NULL OR failure_reason IN
    ('consent_required', 'model_unavailable', 'diary_output_invalid'));

COMMENT ON COLUMN public.companion_daily_summaries.failure_reason IS
  'status=failed 的成因；generated 行必须为 NULL（先失败后成功的日子靠这个区分到底有没有写下来）';

-- 同一次改动里删掉 `highlights`：它是"当天最后 8 条对话"的副本，历史上**从未被任何
-- 界面读过**（只读路由把它作为 conversationHighlights 发出去，渲染层没渲染过一行），
-- 正文换成她自己写的之后它连"素材"都不是了——写日记用的素材在生成时现取，
-- 原始对话本来就在 companion_messages 里，不需要再存一份截断副本。
-- facts 保留：`companion-thought.ts` 用 learningRunsCreated/Completed 算连续学习天数。
ALTER TABLE public.companion_daily_summaries DROP COLUMN IF EXISTS highlights;

-- 授权不变：这张表仍是 worker 写、api 读（`0170:319-343`、`infra/postgres/roles.sql`
-- 的清单按表发放）。加列/删列不新增权限面，无需同步 roles.sql。
