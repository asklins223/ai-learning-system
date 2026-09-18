-- 0195: remove V2 compatibility tables with no current runtime consumer.
--
-- These tables were created by intermediate rollout plans. The active card
-- generation and learning-run paths use the candidate reports, objective
-- revisions, and current run/outbox tables instead.

DROP TABLE IF EXISTS public.card_generation_cutover_events;
DROP TABLE IF EXISTS public.learning_objective_private_contracts_v2;
DROP TABLE IF EXISTS public.card_candidate_lineage_v2;
DROP TABLE IF EXISTS public.learning_session_practice_events;
