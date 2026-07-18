ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "title_source" text DEFAULT 'auto' NOT NULL;
