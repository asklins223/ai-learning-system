-- 0197: remove unused V1 generation queue helper functions.
--
-- These SECURITY DEFINER helpers no longer have runtime callers. Several of
-- them still referenced the retired card_generation_runs and
-- card_generation_units tables, so keeping them made the database expose
-- callable functions that could fail against the current schema.

DROP FUNCTION IF EXISTS public.ailearn_mark_dead_jobs_under_terminal_runs();
DROP FUNCTION IF EXISTS public.ailearn_find_reaped_generation_jobs(uuid[]);
DROP FUNCTION IF EXISTS public.ailearn_latest_dead_generation_job_ids(integer);
DROP FUNCTION IF EXISTS public.ailearn_enqueue_agent_turn_job(
  uuid, uuid, uuid, uuid, integer, text, integer, text, text, text
);
DROP FUNCTION IF EXISTS public.ailearn_find_active_turn_job(uuid, uuid, uuid);

-- Trigger functions whose tables were retired with the V1 evidence/image
-- pipeline. The note_image_assets identity guard remains current.
DROP FUNCTION IF EXISTS public.ailearn_guard_note_evidence_span();
DROP FUNCTION IF EXISTS public.ailearn_guard_succeeded_image_insight();
DROP FUNCTION IF EXISTS public.ailearn_guard_note_image_evidence_unit();
