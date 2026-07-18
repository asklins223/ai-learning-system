-- AI Learn System v0.4 database roles and grants.
--
-- This file is intentionally a psql script, not a PostgreSQL template with
-- literal `${PASSWORD}` placeholders.  apply-roles.sh supplies the three
-- passwords through psql variables (`-v ..._password=...`).  Run it as the
-- database administrator before and after migrations:
--
--   /bin/sh infra/postgres/apply-roles.sh
--
-- The script is safe to repeat.  It does not enable row-level security.  RLS
-- requires a trusted transaction-local workspace context and policies, which
-- are not part of the v0.4 connection model yet.

\set ON_ERROR_STOP on

-- Fail early when the wrapper was bypassed without supplying secrets.  The
-- values are quoted by psql's :'name' syntax before PostgreSQL sees them, then
-- held in transaction-local custom settings for the procedural checks below.
SELECT set_config('ailearn.migrator_password', :'migrator_password', false) AS ignored \gset
SELECT set_config('ailearn.api_password', :'api_password', false) AS ignored \gset
SELECT set_config('ailearn.worker_password', :'worker_password', false) AS ignored \gset
SELECT set_config('ailearn.require_rls_disabled', :'require_rls_disabled', false) AS ignored \gset
DO $$
BEGIN
  IF length(trim(current_setting('ailearn.migrator_password'))) = 0
    OR length(trim(current_setting('ailearn.api_password'))) = 0
    OR length(trim(current_setting('ailearn.worker_password'))) = 0
  THEN
    RAISE EXCEPTION 'role passwords must be non-empty';
  END IF;
END
$$;

-- Create the roles only when absent.  ALTER ROLE below also rotates a role's
-- password when the operator intentionally changes the environment value.
SELECT format(
  'CREATE ROLE ailearn_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS PASSWORD %L',
  :'migrator_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_migrator'
)\gexec

SELECT format(
  'CREATE ROLE ailearn_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'api_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api'
)\gexec

SELECT format(
  'CREATE ROLE ailearn_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'worker_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker'
)\gexec

ALTER ROLE ailearn_migrator
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS
  PASSWORD :'migrator_password';
ALTER ROLE ailearn_api
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'api_password';
ALTER ROLE ailearn_worker
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  PASSWORD :'worker_password';

-- Drizzle always emits CREATE SCHEMA IF NOT EXISTS for its journal, and
-- PostgreSQL checks database-level CREATE even when the schema already exists.
-- Only the dedicated migrator receives that DDL capability.
SELECT format(
  'GRANT CONNECT, CREATE ON DATABASE %I TO ailearn_migrator',
  current_database()
)\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO ailearn_api, ailearn_worker',
  current_database()
)\gexec
SELECT format(
  'REVOKE CREATE ON DATABASE %I FROM ailearn_api, ailearn_worker',
  current_database()
)\gexec

-- Keep the migration tracking schema owned by the migrator.  It is created
-- before the first migration so Drizzle can use a non-superuser connection.
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION ailearn_migrator;
ALTER SCHEMA drizzle OWNER TO ailearn_migrator;
GRANT USAGE, CREATE ON SCHEMA drizzle TO ailearn_migrator;
GRANT USAGE ON SCHEMA public TO ailearn_migrator, ailearn_api, ailearn_worker;
GRANT CREATE ON SCHEMA public TO ailearn_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ailearn_api, ailearn_worker;

-- The application database may have been created with the old `ailearn`
-- owner.  Transfer only ordinary application objects so an existing database
-- can be upgraded by the migrator role; extension-owned objects are skipped.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
    -- PostgreSQL requires an owned sequence and its table to have the same
    -- owner.  A plain pg_dump restore creates both as the restore role, so
    -- transfer tables first; ALTER TABLE OWNER then carries linked sequences
    -- with it, and the final sequence pass is safe and deterministic.
    ORDER BY (c.relkind = 'S'), n.nspname, c.relname
  LOOP
    IF obj.relkind = 'S' THEN
      EXECUTE format(
        'ALTER SEQUENCE %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'v' THEN
      EXECUTE format(
        'ALTER VIEW %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'm' THEN
      EXECUTE format(
        'ALTER MATERIALIZED VIEW %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSIF obj.relkind = 'f' THEN
      EXECUTE format(
        'ALTER FOREIGN TABLE %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE %I.%I OWNER TO ailearn_migrator',
        obj.nspname, obj.relname
      );
    END IF;
  END LOOP;

  -- Enum/domain ownership matters for forward migrations that replace a
  -- legacy enum.  Extension-owned types remain under their extension owner.
  FOR obj IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format(
      'ALTER TYPE %I.%I OWNER TO ailearn_migrator',
      obj.nspname, obj.typname
    );
  END LOOP;
END
$$;

-- Reset grants before applying the explicit matrix.  This removes privileges
-- left by the old shared `ailearn` connection without touching ownership.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ailearn_api, ailearn_worker;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ailearn_api, ailearn_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ailearn_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ailearn_migrator;

-- API is the business CRUD role.  It deliberately receives no schema DDL or
-- migration-schema access beyond the read-only readiness query below.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO ailearn_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ailearn_api;

-- Worker read set. Keep identity/session/benchmark tables out of this list;
-- the personal model-config table is the narrow exception required to resolve
-- the initiating user's provider without granting access to users/sessions.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces',
    'notes',
    'note_versions',
    'note_blocks',
    'sources',
    'source_segments',
    'learning_cards',
    'card_key_points',
    'evidences',
    'evidence_overrides',
    'validation_events',
    'review_schedules',
    'jobs',
    'search_documents',
    'ai_artifacts',
    'user_ai_model_configs'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO ailearn_worker', table_name);
    END IF;
  END LOOP;

  -- Exact write privileges exercised by the current worker handlers.  The
  -- SELECT grants above are intentionally retained because RETURNING and
  -- conflict updates require read access to affected columns.
  FOREACH table_name IN ARRAY ARRAY[
    'learning_cards',
    'review_schedules',
    'jobs',
    'search_documents'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT INSERT, UPDATE ON TABLE public.%I TO ailearn_worker',
        table_name
      );
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'ai_artifacts',
    'card_key_points',
    'evidence_overrides',
    'validation_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('GRANT INSERT ON TABLE public.%I TO ailearn_worker', table_name);
    END IF;
  END LOOP;

  IF to_regclass('public.evidences') IS NOT NULL THEN
    GRANT INSERT, DELETE ON TABLE public.evidences TO ailearn_worker;
  END IF;
  IF to_regclass('public.sources') IS NOT NULL THEN
    GRANT UPDATE ON TABLE public.sources TO ailearn_worker;
  END IF;
  IF to_regclass('public.source_segments') IS NOT NULL THEN
    GRANT INSERT, DELETE ON TABLE public.source_segments TO ailearn_worker;
  END IF;
  IF to_regclass('public.search_documents') IS NOT NULL THEN
    GRANT DELETE ON TABLE public.search_documents TO ailearn_worker;
  END IF;

  IF to_regclass('public.understanding_events') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.understanding_events TO ailearn_worker;
  END IF;
  IF to_regclass('public.ai_audit_log') IS NOT NULL THEN
    GRANT INSERT ON TABLE public.ai_audit_log TO ailearn_worker;
  END IF;
END
$$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ailearn_worker;

-- Drizzle readiness only needs to inspect the journal.  The worker does not
-- need migration metadata and therefore receives no drizzle-schema grant.
DO $$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA drizzle TO ailearn_api;
    GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ailearn_api;
    GRANT ALL PRIVILEGES ON TABLE drizzle.__drizzle_migrations TO ailearn_migrator;
  END IF;
END
$$;

-- New objects created by the migrator receive the same baseline defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ailearn_api;
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ailearn_api;
ALTER DEFAULT PRIVILEGES FOR ROLE ailearn_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

-- Worker privileges are deliberately not granted by default.  This script is
-- re-applied after migrations, so a newly introduced table remains invisible
-- until its handler access is added to the explicit matrix above.

-- Application enums are used in query parameters and therefore need USAGE.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname, t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE format(
      'GRANT USAGE ON TYPE %I.%I TO ailearn_api, ailearn_worker',
      obj.nspname, obj.typname
    );
    EXECUTE format(
      'GRANT USAGE ON TYPE %I.%I TO ailearn_migrator',
      obj.nspname, obj.typname
    );
  END LOOP;
END
$$;

-- Executable least-privilege verification.  Keeping this next to the grants
-- makes the production role-grants service fail before API/Worker start if a
-- future schema or grant change expands access unexpectedly.
DO $$
DECLARE
  mismatch text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'ailearn_migrator'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolinherit AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'ailearn_migrator role attributes are invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('ailearn_api', 'ailearn_worker')
      AND (
        NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolinherit OR rolbypassrls
      )
  ) OR (
    SELECT count(*) FROM pg_roles
    WHERE rolname IN ('ailearn_api', 'ailearn_worker')
  ) <> 2 THEN
    RAISE EXCEPTION 'API/Worker role attributes are invalid';
  END IF;

  IF NOT has_database_privilege(
    'ailearn_migrator', current_database(), 'CREATE'
  ) OR NOT has_schema_privilege(
    'ailearn_migrator', 'public', 'CREATE'
  ) THEN
    RAISE EXCEPTION 'migrator is missing database/schema DDL privileges';
  END IF;
  IF has_database_privilege('ailearn_api', current_database(), 'CREATE')
    OR has_database_privilege('ailearn_worker', current_database(), 'CREATE')
    OR has_schema_privilege('ailearn_api', 'public', 'CREATE')
    OR has_schema_privilege('ailearn_worker', 'public', 'CREATE')
  THEN
    RAISE EXCEPTION 'API/Worker unexpectedly have DDL privileges';
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  INTO mismatch
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND pg_get_userbyid(c.relowner) <> 'ailearn_migrator'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid
        AND d.deptype = 'e'
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'non-migrator object owners: %', mismatch;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  INTO mismatch
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND (
      NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'SELECT'
      )
      OR NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'INSERT'
      )
      OR NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'UPDATE'
      )
      OR NOT has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'DELETE'
      )
      OR has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'TRUNCATE'
      )
      OR has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'REFERENCES'
      )
      OR has_table_privilege(
        'ailearn_api', format('%I.%I', n.nspname, c.relname), 'TRIGGER'
      )
    );
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'API privilege matrix mismatch: %', mismatch;
  END IF;

  WITH expected(
    table_name, can_select, can_insert, can_update, can_delete
  ) AS (
    VALUES
      ('workspaces', true, false, false, false),
      ('notes', true, false, false, false),
      ('note_versions', true, false, false, false),
      ('note_blocks', true, false, false, false),
      ('sources', true, false, true, false),
      ('source_segments', true, true, false, true),
      ('learning_cards', true, true, true, false),
      ('card_key_points', true, true, false, false),
      ('evidences', true, true, false, true),
      ('evidence_overrides', true, true, false, false),
      ('validation_events', true, true, false, false),
      ('review_schedules', true, true, true, false),
      ('jobs', true, true, true, false),
      ('search_documents', true, true, true, true),
      ('ai_artifacts', true, true, false, false),
      ('user_ai_model_configs', true, false, false, false),
      ('understanding_events', false, true, false, false),
      ('ai_audit_log', false, true, false, false)
  ), actual AS (
    SELECT
      c.relname AS table_name,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'SELECT'
      ) AS can_select,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'INSERT'
      ) AS can_insert,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'UPDATE'
      ) AS can_update,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'DELETE'
      ) AS can_delete,
      has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'TRUNCATE'
      ) OR has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'REFERENCES'
      ) OR has_table_privilege(
        'ailearn_worker', format('%I.%I', n.nspname, c.relname), 'TRIGGER'
      ) AS has_admin_table_privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  )
  SELECT string_agg(actual.table_name, ', ')
  INTO mismatch
  FROM actual
  LEFT JOIN expected USING (table_name)
  WHERE actual.can_select <> coalesce(expected.can_select, false)
    OR actual.can_insert <> coalesce(expected.can_insert, false)
    OR actual.can_update <> coalesce(expected.can_update, false)
    OR actual.can_delete <> coalesce(expected.can_delete, false)
    OR actual.has_admin_table_privilege;
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Worker privilege matrix mismatch: %', mismatch;
  END IF;

  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AND (
    NOT has_schema_privilege('ailearn_api', 'drizzle', 'USAGE')
    OR NOT has_table_privilege(
      'ailearn_api', 'drizzle.__drizzle_migrations', 'SELECT'
    )
    OR has_schema_privilege('ailearn_worker', 'drizzle', 'USAGE')
  ) THEN
    RAISE EXCEPTION 'migration journal privilege matrix mismatch';
  END IF;
END
$$;

-- Explicitly document the current security posture.  Do not silently turn on
-- RLS from a bootstrap script that has no policies or workspace context.  The
-- pre-migration pass allows an older unsafe state to reach migration 0015,
-- which removes the unreleased policies.  The post-migration pass sets
-- require_rls_disabled=true and fails closed if any public table remains
-- protected.
DO $$
DECLARE
  enabled_count integer;
BEGIN
  SELECT count(*) INTO enabled_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity;
  IF coalesce(current_setting('ailearn.require_rls_disabled', true), 'false')::boolean
    AND enabled_count > 0
  THEN
    RAISE EXCEPTION
      'RLS is enabled on % public tables; migration/policies must be completed before applications start',
      enabled_count;
  END IF;
END
$$;
