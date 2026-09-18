-- 0191: remove the last unused V1 evidence column from review attempts.
--
-- Review attempts now identify their V2 target through subject_id and keep
-- validation_event_id/validation_question_id only where applicable. No active
-- reader or writer uses review_attempts.evidence_id after the V1 evidences
-- table was retired in 0183.

ALTER TABLE public.review_attempts DROP COLUMN IF EXISTS evidence_id;
