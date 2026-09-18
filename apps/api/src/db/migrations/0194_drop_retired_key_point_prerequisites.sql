-- 0194: remove the unused prerequisite table.
--
-- No current route, worker, planner, or export path reads or writes this
-- experimental V1 table.  Its shared mapping was also only a partial shell
-- and did not represent the table's prerequisite columns.

DROP TABLE IF EXISTS public.key_point_prerequisites;
