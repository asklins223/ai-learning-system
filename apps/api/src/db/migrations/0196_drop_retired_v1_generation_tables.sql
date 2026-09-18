-- 0196: remove the retired V1 generation and image-analysis pipeline.
--
-- The active pipeline is card-generation-v2. These tables have no current
-- ORM mapping, route, worker handler, export path, or test fixture. Drop the
-- child tables first so this migration remains dependency-explicit.

-- jobs still carried foreign keys and indexes from the retired V1 generation
-- queue. Remove those dependencies before dropping the referenced tables;
-- the remaining legacy columns are removed by migration 0200.
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_generation_unit_fk,
  DROP CONSTRAINT IF EXISTS jobs_generation_unit_requires_run_check,
  DROP CONSTRAINT IF EXISTS jobs_generation_run_fk;
ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_latest_generation_run_fk;
DROP INDEX IF EXISTS public.jobs_generation_run_idx;
DROP INDEX IF EXISTS public.jobs_generation_unit_idx;

DROP FUNCTION IF EXISTS public.ailearn_purge_old_agent_events(integer, integer);
DROP TABLE IF EXISTS public.card_generation_agent_events;

DROP TABLE IF EXISTS public.card_generation_quality_reports;
DROP TABLE IF EXISTS public.card_generation_drafts;
DROP TABLE IF EXISTS public.card_generation_events;
DROP TABLE IF EXISTS public.card_generation_candidates;
DROP TABLE IF EXISTS public.card_generation_units;
DROP TABLE IF EXISTS public.card_generation_plans;
DROP TABLE IF EXISTS public.card_generation_source_bundles;
DROP TABLE IF EXISTS public.card_generation_runs;

DROP TABLE IF EXISTS public.note_image_evidence_units;
DROP TABLE IF EXISTS public.note_image_insights;
