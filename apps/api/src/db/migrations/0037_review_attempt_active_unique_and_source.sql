-- 0037: V05-RISK-04 + V05-RISK-05
-- 1. Partial unique index: per (workspace, user, schedule) only one 'started' attempt
--    Prevents cross-page/cross-device duplicate started attempts.
-- 2. next_schedule_id column: persist the schedule created by submit on the
--    attempt row, so historical attempts can be traced to their successor schedule.
-- 3. abandoned_at column: record when a started attempt was explicitly abandoned
--    (user cancel, auto-abandon on new start, or stale cleanup).

-- V05-RISK-05: next_schedule_id for source tracking
ALTER TABLE review_attempts
  ADD COLUMN IF NOT EXISTS next_schedule_id uuid;

-- V05-RISK-04: abandoned_at timestamp
ALTER TABLE review_attempts
  ADD COLUMN IF NOT EXISTS abandoned_at timestamptz;

-- V05-RISK-04: Partial unique index — at most one 'started' attempt per
-- (workspace, user, schedule). This is a database-level guarantee that
-- prevents cross-device/cross-tab duplicate starts even if the application
-- layer race window is hit.
CREATE UNIQUE INDEX IF NOT EXISTS review_attempts_active_started_unique_idx
  ON review_attempts (workspace_id, user_id, review_schedule_id)
  WHERE status = 'started';

-- Helpful index for querying the active started attempt for a schedule
CREATE INDEX IF NOT EXISTS review_attempts_active_schedule_idx
  ON review_attempts (workspace_id, user_id, review_schedule_id, status)
  WHERE status = 'started';
