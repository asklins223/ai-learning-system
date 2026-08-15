-- 0126: companion_conversations.kind 增加 'journey'（P6 AssistantSession bootstrap）。
--
-- §10.1：invitation accepted 创建 onboarding AssistantSession。会话 kind 用
-- 'journey'（与 dialogue/inbox 并列的第三种来源），历史页可区分引导会话。

--> statement-breakpoint

ALTER TABLE public.companion_conversations
  DROP CONSTRAINT IF EXISTS companion_conversations_kind_check;

--> statement-breakpoint

ALTER TABLE public.companion_conversations
  ADD CONSTRAINT companion_conversations_kind_check CHECK (kind IN ('dialogue', 'inbox', 'journey'));
