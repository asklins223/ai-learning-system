-- 39d #28 第三步：念头行也记下它产出于**哪一版闸**。
-- 0279 只给了对话回合（companion_turn_runs），但标「删除」的 G10／G11 的证据来自
-- assistant_thoughts 的气泡正文，那一侧没有这一列就永远归不了因——判据只能整批拒绝。
-- 可空：历史行填不出真值，NULL 表示"未归因"，不是"版本为空"。
ALTER TABLE "assistant_thoughts" ADD COLUMN "leak_gate_version" text;
