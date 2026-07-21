-- 0038_sec01_rls_enforce_policy_fix.sql
-- SEC-01: Fix RLS policies for enforce mode
--
-- This migration prepares the policy catalog for SEC-01 enforce by:
-- 1. Dropping all *_runtime_access bypass policies (expand-mode workaround)
-- 2. Converting all RESTRICTIVE policies to PERMISSIVE
--
-- After this migration, when 0024 (ENABLE+FORCE RLS) is applied:
-- - No runtime_access bypass policies exist
-- - tenant_guard policies are PERMISSIVE and filter by workspace_id
-- - Cross-workspace isolation is enforced correctly
--
-- Prerequisite: 0027 (expansion fail-safe) must be applied first.
-- This migration is forward-compatible: it runs in expand mode (RLS disabled)
-- but prepares the policy catalog for when 0024 is re-applied for enforce.

-- ─── 1. Drop all *_runtime_access bypass policies ────────────────────

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT polname, polrelid::regclass::text AS tbl
    FROM pg_policy
    WHERE polname LIKE '%\_runtime_access' ESCAPE '\'
  )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', r.polname, r.tbl);
    RAISE NOTICE 'Dropped runtime_access policy % on %', r.polname, r.tbl;
  END LOOP;
END $$;

-- ─── 2. Convert RESTRICTIVE policies to PERMISSIVE ───────────────────
--
-- PostgreSQL does not support ALTER POLICY ... AS PERMISSIVE, so we must
-- drop and recreate each restrictive policy.  The expressions are read
-- from the catalog to preserve the exact semantics.

DO $$
DECLARE
  r RECORD;
  cmd text;
BEGIN
  FOR r IN (
    SELECT polname,
           polrelid::regclass::text AS tbl,
           polcmd,
           pg_get_expr(polqual, polrelid) AS using_expr,
           pg_get_expr(polwithcheck, polrelid) AS check_expr
    FROM pg_policy
    WHERE polpermissive = false
    ORDER BY polrelid::regclass::text, polname
  )
  LOOP
    -- Map polcmd code to text
    cmd := CASE r.polcmd
      WHEN '*' THEN 'ALL'
      WHEN 'r' THEN 'SELECT'
      WHEN 'a' THEN 'INSERT'
      WHEN 'w' THEN 'UPDATE'
      WHEN 'd' THEN 'DELETE'
    END;

    -- Drop the restrictive policy
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', r.polname, r.tbl);

    -- Recreate as PERMISSIVE, preserving USING and/or WITH CHECK
    IF r.using_expr IS NOT NULL AND r.check_expr IS NOT NULL THEN
      EXECUTE format(
        'CREATE POLICY %I ON %s AS PERMISSIVE FOR %s USING (%s) WITH CHECK (%s)',
        r.polname, r.tbl, cmd, r.using_expr, r.check_expr
      );
    ELSIF r.using_expr IS NOT NULL THEN
      EXECUTE format(
        'CREATE POLICY %I ON %s AS PERMISSIVE FOR %s USING (%s)',
        r.polname, r.tbl, cmd, r.using_expr
      );
    ELSIF r.check_expr IS NOT NULL THEN
      EXECUTE format(
        'CREATE POLICY %I ON %s AS PERMISSIVE FOR %s WITH CHECK (%s)',
        r.polname, r.tbl, cmd, r.check_expr
      );
    END IF;

    RAISE NOTICE 'Converted % to PERMISSIVE on %', r.polname, r.tbl;
  END LOOP;
END $$;

-- ─── 3. Verify no RESTRICTIVE policies remain ────────────────────────

DO $$
DECLARE
  restrictive_count integer;
BEGIN
  SELECT count(*)
  INTO restrictive_count
  FROM pg_policy
  WHERE polpermissive = false;

  IF restrictive_count > 0 THEN
    RAISE EXCEPTION
      'SEC-01 policy fix verification failed: % restrictive policy(ies) remain',
      restrictive_count
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
