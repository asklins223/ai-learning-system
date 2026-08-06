-- 0060: Multi-platform BYOK support — add model_type column to user_ai_model_configs
--
-- Previously each user could only have one AI provider config (text + vision
-- sharing the same platform/apiKey). This migration adds a `model_type` column
-- so users can configure different platforms for different model types:
--
--   model_type = 'text'      → text generation (card generation, validation, etc.)
--   model_type = 'vision'    → vision/OCR (image analysis)
--   model_type = 'embedding' → vector embeddings for semantic search
--
-- Existing rows are backfilled to 'text' (their current behavior — they
-- primarily configure the text model, and the visionModel field already
-- allows specifying a different vision model on the same platform).
--
-- The primary key changes from (user_id) to (user_id, model_type) to allow
-- one row per model type per user.

-- 1. Add model_type column with default 'text'
ALTER TABLE user_ai_model_configs
  ADD COLUMN IF NOT EXISTS model_type text NOT NULL DEFAULT 'text';

-- 2. Backfill: ensure all existing rows have model_type = 'text'
UPDATE user_ai_model_configs
  SET model_type = 'text'
  WHERE model_type IS NULL OR model_type = '';

-- 3. Drop the old primary key constraint (user_id only)
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT con.conname
    INTO pk_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
   WHERE rel.relname = 'user_ai_model_configs'
     AND con.contype = 'p'
     AND nsp.nspname = current_schema();

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_ai_model_configs DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

-- 4. Create new composite unique index (user_id, model_type)
CREATE UNIQUE INDEX IF NOT EXISTS user_ai_model_configs_pk
  ON user_ai_model_configs (user_id, model_type);
