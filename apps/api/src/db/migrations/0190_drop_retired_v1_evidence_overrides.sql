-- 0190: retire the orphaned V1 evidence override table.
--
-- migration 0183 removed the V1 `evidences` table and detached the old
-- foreign keys from `evidence_overrides`. There is no active V2 reader or
-- writer for this table: V2 evidence is immutable and governed by its
-- snapshot/binding/eligibility tables. Keeping the detached override table
-- would only preserve an unusable schema surface and misleading export data.

DROP TABLE IF EXISTS public.evidence_overrides;
