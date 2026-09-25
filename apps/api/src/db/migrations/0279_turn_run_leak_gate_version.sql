-- 39d #28 第二步：每一发伴星回合记下它产出于**哪一版闸**。
-- 之前 G-id 只活在重放台的 python 里（第一步已把闸身份表搬进 shared，版本由表内容派生）。
-- 可空：这一列落地之前的历史行填不出真值，NULL 表示"未归因"，不是"版本为空"——
-- 台子与探针必须把 NULL 当成证据不足，而不是当成某一版。
ALTER TABLE "companion_turn_runs" ADD COLUMN "leak_gate_version" text;
