-- Add optional vision_model column to user_ai_model_configs.
-- When NULL, the provider uses its built-in default (e.g. qwen3-vl-plus for DashScope).
-- When set, the worker passes it to the provider constructor as visionModel.
ALTER TABLE public.user_ai_model_configs
  ADD COLUMN IF NOT EXISTS vision_model text;
