-- 0202: remove the retired Session/Episode/Tutor schema.
--
-- LearningRun is the only current learning-process contract.  The old tables
-- have no current writer or reader; keeping them would leave a second
-- canonical learning path in a fresh database.

DROP FUNCTION IF EXISTS public.ailearn_purge_tutor_nonces_ttl(integer, integer);

DROP TABLE IF EXISTS public.learning_tutor_action_nonces;
DROP TABLE IF EXISTS public.learning_tutor_permissions;
DROP TABLE IF EXISTS public.learning_tutor_detours;
DROP TABLE IF EXISTS public.learning_assessment_reports;
DROP TABLE IF EXISTS public.learning_response_artifacts;
DROP TABLE IF EXISTS public.learning_session_probes;
DROP TABLE IF EXISTS public.learning_episodes;
DROP TABLE IF EXISTS public.learning_sessions;
