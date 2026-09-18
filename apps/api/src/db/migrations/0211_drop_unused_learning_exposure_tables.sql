-- 0211: remove the unused pre-launch learning-unit exposure aggregate.
-- The current product uses learning_exposures_v2 and card_exposure_ledger_v2;
-- no runtime code reads or writes the 0077 tables.

DROP TABLE IF EXISTS public.learning_exposure_dependency_ledger;
DROP TABLE IF EXISTS public.learning_unit_exposure;
