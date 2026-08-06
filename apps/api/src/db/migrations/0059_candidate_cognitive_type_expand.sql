-- P1-14 fix: Add 'code' and 'formula' to cognitive_type CHECK constraint.
-- The Extractor agent's type system allows 'code' and 'formula' as valid
-- cognitive types, but the original CHECK constraint (migration 0045) only
-- allowed 'concept', 'comparison', 'causal', 'procedure', 'boundary'.
-- This caused INSERT failures when the DashScope model returned candidates
-- with cognitiveType='formula' or cognitiveType='code'.

ALTER TABLE card_generation_candidates
  DROP CONSTRAINT IF EXISTS card_generation_candidates_cognitive_check;

ALTER TABLE card_generation_candidates
  ADD CONSTRAINT card_generation_candidates_cognitive_check CHECK (
    cognitive_type IN ('concept', 'comparison', 'causal', 'procedure', 'boundary', 'code', 'formula')
  );
