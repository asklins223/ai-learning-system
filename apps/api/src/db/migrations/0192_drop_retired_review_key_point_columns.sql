-- 0192: remove the retired V1 review target columns.
--
-- V2 review rows use subject_id (the learning_objectives_v2 objective id).
-- No current ORM mapping, query, writer, or export contract uses these two
-- columns.  They were only kept alive by the V1 compatibility migration.

ALTER TABLE public.review_attempts
  DROP CONSTRAINT IF EXISTS review_attempts_key_point_id_fkey;
ALTER TABLE public.review_schedules
  DROP CONSTRAINT IF EXISTS review_schedules_key_point_id_fkey;

ALTER TABLE public.review_attempts
  DROP COLUMN IF EXISTS key_point_id;
ALTER TABLE public.review_schedules
  DROP COLUMN IF EXISTS key_point_id;
