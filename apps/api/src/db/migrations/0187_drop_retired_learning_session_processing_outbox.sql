-- 0187: remove the retired Learning Session processing outbox.
--
-- The current product path uses learning_run_processing_outbox. The old
-- learning_session_processing_outbox has no producer or consumer anymore;
-- its API worker, assessment enqueue path, claim function, and TTL cleanup
-- were deleted together. Keep the historical migrations intact, but remove
-- the dead runtime database objects from existing development databases.

DROP FUNCTION IF EXISTS public.ailearn_claim_commit_outbox(text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.ailearn_purge_processed_outbox_ttl(integer, integer);
DROP TABLE IF EXISTS public.learning_session_processing_outbox;
