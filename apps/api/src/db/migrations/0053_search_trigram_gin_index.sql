-- PERF-05: Add GIN trigram indexes on search_documents body and title.
-- ILIKE '%query%' cannot use B-tree indexes and causes full table scans.
-- With pg_trgm extension already enabled, GIN trigram indexes accelerate
-- both ILIKE and %/similarity% operations, making search scale to large
-- datasets without linear degradation.

-- Ensure pg_trgm extension exists (should already be created by earlier migrations)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on body (the primary search field)
-- Note: Cannot use CONCURRENTLY because the migration runner wraps each
-- migration in a transaction block. Use plain CREATE INDEX instead.
CREATE INDEX IF NOT EXISTS search_documents_body_trgm_idx
  ON search_documents USING gin (body gin_trgm_ops);

-- GIN trigram index on title (used in OR with body)
CREATE INDEX IF NOT EXISTS search_documents_title_trgm_idx
  ON search_documents USING gin (title gin_trgm_ops);

-- Composite index for workspace-scoped searches (body)
CREATE INDEX IF NOT EXISTS search_documents_workspace_body_trgm_idx
  ON search_documents USING gin (body gin_trgm_ops)
  WHERE workspace_id IS NOT NULL;

-- Composite index for workspace-scoped searches (title)
CREATE INDEX IF NOT EXISTS search_documents_workspace_title_trgm_idx
  ON search_documents USING gin (title gin_trgm_ops)
  WHERE workspace_id IS NOT NULL;
