-- 0189: drop the retired W1 canonical outbox.
--
-- The active projection path uses canonical_learning_event_outbox from the
-- LearningRun V2 commit transaction.  learning_outbox_events had no runtime
-- writer or consumer after that cutover; keeping it only created a second,
-- misleading outbox contract.

DROP TABLE IF EXISTS public.learning_outbox_events;
DROP SEQUENCE IF EXISTS public.learning_outbox_events_seq;
