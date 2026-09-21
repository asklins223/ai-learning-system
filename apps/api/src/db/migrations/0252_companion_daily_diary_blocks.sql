-- 0252：桌宠日记从"一段纯文本"改成**块结构**（用户 2026-09-21 的第二轮反馈）。
--
-- 第一轮把统计句换成她写的第一人称正文之后，用户的意见是两条：
--   ① "太短了，而且只有一段，这不是日记的格式"——日记该有若干段，
--      并且除了学习，还要有她自己在用户不在线时的一天；
--   ② 日记里提到某篇笔记时，**那篇笔记里的图、表格、引用要能真的出现在日记里**
--      （音频视频以后放开时同一形状接上），但"想写就写，不想写就不写"，不是配额。
-- ② 决定了存什么：`summary text` 装不下一张图和它的图注。
--
-- 为什么不复用 `companion_messages.blocks`：那是**一轮对话**的块，形状里带着
-- 对话才有的东西（`action_ref`、`emotion`、`nav` 的落点语义）。日记是每天一篇的
-- 独立产物，把两者并成一张表会让"消息流"的 schema 变更随时打到日记上。
-- 但**成员 schema 必须同源**：`text`/`quote`/`image` 三块直接从
-- `companion-conversation-contracts` 里导出复用，不再抄第二份——
-- 抄的那一份会在图片 url 校验规则变化时悄悄落后，而"合同收得下、客户端显示不出"
-- 是这个仓库已经写进注释的教训。
--
-- `summary` 保留：它是正文的纯文本投影（`previousOpenings` 读它，历史行也只有它），
-- 不再作为展示面。历史行 `blocks` 取默认 `'[]'`，由只读路由投影成单个 text 块，
-- 所以旧日子照常显示、不重写（用户裁定）。
ALTER TABLE public.companion_daily_summaries
  ADD COLUMN IF NOT EXISTS blocks jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.companion_daily_summaries.blocks IS
  '日记正文的块序列（text/quote/image）；[] = 本次改动之前的历史行，读取时从 summary 投影';

-- 授权不变：这张表仍是 worker 写、api 读，`infra/postgres/roles.sql` 的清单按表发放。
