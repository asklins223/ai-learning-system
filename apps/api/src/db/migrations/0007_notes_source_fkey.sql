-- P1-2: Add foreign key constraint for notes.source_id
-- Iteration plan §4.2 requires: REFERENCES sources(id) ON DELETE SET NULL
DO $$ BEGIN
  ALTER TABLE "notes"
    ADD CONSTRAINT "notes_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "sources"("id")
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
