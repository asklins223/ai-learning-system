-- 0117: LearningRun processing outbox。
--
-- §13.1：Assessment 与 Commit 只能由内部 outbox/worker 驱动。submission
-- 事务原子写入 assessment_requested；声明不会的确定性评估完成后写
-- commit_requested。payload 只含 ID 引用（run/task/artifact/assessment），
-- 答案正文绝不进入队列（CHECK 拒绝 answer/answerText/userAnswer/transcript 键）。
--
-- 幂等：scope key (workspace_id, run_id, idempotency_key) 唯一，
-- at-least-once delivery；消费者按命令幂等重放。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.learning_run_processing_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.learning_runs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.learning_tasks(id) ON DELETE CASCADE,
  artifact_id uuid REFERENCES public.learning_artifacts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  command_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_run_processing_outbox_scope_key_unique
    UNIQUE (workspace_id, run_id, idempotency_key),
  CONSTRAINT learning_run_processing_outbox_command_check
    CHECK (command_type IN ('assessment_requested', 'commit_requested')),
  CONSTRAINT learning_run_processing_outbox_payload_check
    CHECK (
      NOT (payload ? 'answer')
      AND NOT (payload ? 'answerText')
      AND NOT (payload ? 'userAnswer')
      AND NOT (payload ? 'transcript')
    )
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_run_processing_outbox_pending_idx
  ON public.learning_run_processing_outbox (available_at, created_at)
  WHERE processed_at IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_run_processing_outbox_run_idx
  ON public.learning_run_processing_outbox (run_id, command_type);

--> statement-breakpoint

ALTER TABLE public.learning_run_processing_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_run_processing_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_run_processing_outbox_workspace_user_isolation
  ON public.learning_run_processing_outbox;
CREATE POLICY learning_run_processing_outbox_workspace_user_isolation
  ON public.learning_run_processing_outbox FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_run_processing_outbox TO ailearn_api;
GRANT SELECT, UPDATE ON public.learning_run_processing_outbox TO ailearn_worker;
