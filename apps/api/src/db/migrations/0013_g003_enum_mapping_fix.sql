-- G-003 compatibility step.
--
-- The tag/category tables were intentionally removed by 0008.  Static
-- `CREATE TABLE ... AS SELECT ... FROM note_tags` statements fail at parse time
-- once those relations are gone.  Use dynamic SQL guarded by to_regclass so
-- databases that still have a legacy table can preserve it, while the normal
-- 0008+ path remains a no-op.

DO $migration$
DECLARE
  legacy_table text;
BEGIN
  FOREACH legacy_table IN ARRAY ARRAY[
    'note_tags',
    'note_categories',
    'tags',
    'categories'
  ]
  LOOP
    IF to_regclass(format('public.%I', legacy_table)) IS NOT NULL
       AND to_regclass(format('public.%I_backup', legacy_table)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I_backup AS TABLE public.%I',
        legacy_table,
        legacy_table
      );
    END IF;
  END LOOP;
END
$migration$;

-- Enum reconciliation is deliberately forward-only in 0015.  Trying to update
-- legacy labels after 0003 has already installed the narrow enum cannot work:
-- those old labels can no longer exist in a column of that enum type.
