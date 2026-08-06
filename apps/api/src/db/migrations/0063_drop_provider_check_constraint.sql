-- 0063: Drop provider CHECK constraint from migration 0017
--
-- The CHECK constraint "user_ai_model_configs_provider_check" was created in
-- migration 0017 and hardcodes the allowed provider values to
-- ('mock', 'dashscope', 'openai_compatible'). This prevents new providers
-- (e.g. siliconflow) from being stored in the user_ai_model_configs table.
--
-- R4 of the provider-registry-refactor replaces DB-level validation with
-- application-level validation driven by PROVIDER_METADATA in
-- packages/shared/src/provider-registry.ts. The provider column remains
-- text NOT NULL, but is no longer constrained to a fixed set of values.

ALTER TABLE "user_ai_model_configs"
  DROP CONSTRAINT IF EXISTS "user_ai_model_configs_provider_check";
