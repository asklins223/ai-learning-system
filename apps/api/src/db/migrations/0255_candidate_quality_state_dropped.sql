-- 0255: 候选新增 `dropped` 终态（§52/§53 第一步，只加状态、不写不读）。
--
-- 要修的事实（4938cf7f 真跑实测）：候选行的 quality_state 只被 grounding 那一次批量
-- UPDATE 写过（handler:2060-2092）；pedagogy 与 deck gate 的结论从不回写。于是没进
-- 最终牌堆的卡行上仍写 passed——审核页按 passed∧undecided∧unpublished 判可审核，
-- 就把牌堆外的卡也给了出去（真实牌堆 2 张，界面给出 4 张），练习件配额也因此读出
-- 与结算事件不同的数（{3,3} vs {3,1}）。
--
-- 这一步刻意只做两件事：把合法值加上、把 drizzle schema 同步。没有任何写入方与读取方
-- 分支到它，所以单独交付是安全的；若与写入/读点混在一次改动里，中途失败就会留下
-- “库里有状态、代码不写、读点不认识”的三不管地带。
--
-- 为什么不复用 failed：那会把“质量不合格”（要重生成）与“被 pedagogy 丢弃/与别的卡重复”
-- （用户什么都不用做）混成一件。

--> statement-breakpoint

ALTER TABLE public.card_generation_candidates_v2
  DROP CONSTRAINT cg_v2_cand_quality_chk;

--> statement-breakpoint

ALTER TABLE public.card_generation_candidates_v2
  ADD CONSTRAINT cg_v2_cand_quality_chk
  CHECK (quality_state IN ('authored','checking','passed','failed','dropped'));
