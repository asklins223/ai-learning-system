CREATE TABLE IF NOT EXISTS "user_ai_model_configs" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "base_url" text,
  "model" text,
  "api_key_encrypted" text,
  "api_key_hint" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_ai_model_configs_provider_check"
    CHECK ("provider" IN ('mock', 'dashscope', 'openai_compatible')),
  CONSTRAINT "user_ai_model_configs_external_fields_check"
    CHECK (
      "provider" = 'mock'
      OR (
        "base_url" IS NOT NULL AND length(trim("base_url")) > 0
        AND "model" IS NOT NULL AND length(trim("model")) > 0
        AND "api_key_encrypted" IS NOT NULL AND length(trim("api_key_encrypted")) > 0
        AND "api_key_hint" IS NOT NULL AND length(trim("api_key_hint")) > 0
      )
    )
);
