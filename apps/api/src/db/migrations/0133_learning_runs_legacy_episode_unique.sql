-- 0133: learning_runs.legacy_episode_id 唯一索引（E17 backfill 幂等）。

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS learning_runs_legacy_episode_unique_idx
  ON public.learning_runs (workspace_id, legacy_episode_id)
  WHERE legacy_episode_id IS NOT NULL;
