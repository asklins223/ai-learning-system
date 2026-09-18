-- 0206: learning runs are V2-only. Remove rows that cannot satisfy the
-- current frozen-target contract before enforcing the non-null boundary.

DELETE FROM public.learning_run_private_contracts
WHERE snapshot_id IS NULL
   OR snapshot_hash IS NULL
   OR semantic_target_fingerprint IS NULL
   OR target_revision_hash IS NULL
   OR expected_objective_lifecycle_epoch IS NULL
   OR evidence_eligibility_vector_hash IS NULL
   OR published_target_eligibility IS NULL
   OR snapshot_id IN (
     SELECT snapshot_id
     FROM public.learning_target_snapshots_v2
     WHERE target IS NULL
   );

DELETE FROM public.learning_target_snapshots_v2
WHERE target IS NULL;

ALTER TABLE public.learning_run_private_contracts
  ALTER COLUMN snapshot_id SET NOT NULL,
  ALTER COLUMN snapshot_hash SET NOT NULL,
  ALTER COLUMN semantic_target_fingerprint SET NOT NULL,
  ALTER COLUMN target_revision_hash SET NOT NULL,
  ALTER COLUMN expected_objective_lifecycle_epoch SET NOT NULL,
  ALTER COLUMN evidence_eligibility_vector_hash SET NOT NULL,
  ALTER COLUMN published_target_eligibility SET NOT NULL;

ALTER TABLE public.learning_target_snapshots_v2
  ALTER COLUMN target SET NOT NULL;
