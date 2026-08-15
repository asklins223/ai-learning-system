-- 0163: card_generation_cutover_events.event_type CHECK 扩展（R35/C34）。
--
-- C34 legacy multi-keypoint Card 迁移需要审计事件（legacy_card_migration），
-- 原 CHECK 仅允许 v1_writer_shutdown / v1_writer_epoch_bump / rollback_drill。
-- 迁移前先核对现有 CHECK 定义（hash 一致性由迁移工具保证）。

--> statement-breakpoint

ALTER TABLE public.card_generation_cutover_events DROP CONSTRAINT IF EXISTS cgce_v2_type_chk;

--> statement-breakpoint

ALTER TABLE public.card_generation_cutover_events ADD CONSTRAINT cgce_v2_type_chk CHECK (
  event_type IN (
    'v1_writer_shutdown','v1_writer_epoch_bump','rollback_drill','legacy_card_migration'
  )
);
