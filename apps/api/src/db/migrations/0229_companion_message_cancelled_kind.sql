-- 0229: 放开 companion_messages.kind 白名单——新增 cancelled（用户"停止"时已产出的部分记录）。
--
-- 背景（2026-09-19）：
--   取消链路（POST /companion/runs/:id/cancel）会让 worker 的 latest-generation
--   fence 拒绝迟到的 assistant.final，于是**服务端不留下任何 assistant 消息**：
--   用户在气泡里已经看到的那几句，一旦停止就从历史里消失了。
--   本次让 worker 在 fence 处把当时累积的文本以 kind='cancelled' 落库，
--   保住"已经输出的东西"。该记录是**给人看的历史**，不进下一轮 prompt
--   （装配侧按 kind 排除，见 companion-dialogue.ts 的历史 SELECT）。
--
--   与 0224（assistant_deliveries.kind）同族：CHECK 白名单必须与代码实际写入的
--   kind 集合一致，不许出现"代码写得出、约束不允许"的漂移——本次是**新增**写入方向。
--
-- 幂等：可重复执行（DROP IF EXISTS + 重建）。
--
-- ⚠️ 锁：DROP + ADD CONSTRAINT 会全表校验，对 companion_messages 取
--   ACCESS EXCLUSIVE。当前库无生产流量，直接重建；若将来该表已很大，
--   应改为 `ADD CONSTRAINT ... NOT VALID` 并在单独的迁移/维护窗口里
--   `VALIDATE CONSTRAINT`，避免长时间阻塞写入。

--> statement-breakpoint

ALTER TABLE public.companion_messages
  DROP CONSTRAINT IF EXISTS companion_messages_kind_check;

ALTER TABLE public.companion_messages
  ADD CONSTRAINT companion_messages_kind_check CHECK (kind IN (
    'text', 'voice_transcript', 'proactive', 'action', 'result', 'error', 'cancelled'
  ));
