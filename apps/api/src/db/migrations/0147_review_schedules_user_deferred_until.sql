-- 方案 16 §18.1 defer_review 工具：复习队列"展示层延后"。
-- 只写 user_deferred_until（队列 UI 的展示字段），不修改 official
-- next_review_at、不消费 schedule、不创建 successor；"只是稍后提醒，
-- 不算完成复习"（§18.3）。空值 = 无用户延后。

ALTER TABLE public.review_schedules
  ADD COLUMN user_deferred_until timestamptz;

--> statement-breakpoint

COMMENT ON COLUMN public.review_schedules.user_deferred_until IS
  '§18 defer_review 展示层：用户主动延后的提醒时间；不改 official next_review_at，不代表完成复习';
