-- 0103：多实例安全的 device runtime-fence。
--
-- fence 仍然是短 TTL、content-free 的运行态数据，不是账号偏好：只保存
-- user/device/surface epoch/created/expiry。落库是为了让多个 API 实例共享
-- 同一撤销边界；每次读写都会清理过期行，业务不会依赖历史 fence。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_runtime_fences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_session_id text NOT NULL,
  surface_epoch integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.companion_runtime_fences
    ADD CONSTRAINT companion_runtime_fences_device_session_check
    CHECK (length(device_session_id) BETWEEN 1 AND 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.companion_runtime_fences
    ADD CONSTRAINT companion_runtime_fences_surface_epoch_check
    CHECK (surface_epoch >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.companion_runtime_fences
    ADD CONSTRAINT companion_runtime_fences_expiry_check
    CHECK (expires_at > created_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_runtime_fences_user_device_unique_idx
  ON public.companion_runtime_fences (user_id, device_session_id);
CREATE INDEX IF NOT EXISTS companion_runtime_fences_expiry_idx
  ON public.companion_runtime_fences (user_id, expires_at);

--> statement-breakpoint

ALTER TABLE public.companion_runtime_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_runtime_fences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companion_runtime_fences_user_isolation
  ON public.companion_runtime_fences;
CREATE POLICY companion_runtime_fences_user_isolation
  ON public.companion_runtime_fences FOR ALL
  USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.companion_runtime_fences TO ailearn_api;
  END IF;
END $$;
