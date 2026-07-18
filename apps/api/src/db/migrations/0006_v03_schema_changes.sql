-- V0.3 Schema Changes
-- 1. notes 表增加 source_id 列
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "source_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_source_idx" ON "notes" ("source_id");
--> statement-breakpoint

-- 2. source_segments 表增加 segment_type 列
ALTER TABLE "source_segments" ADD COLUMN IF NOT EXISTS "segment_type" text DEFAULT 'paragraph' NOT NULL;
--> statement-breakpoint

-- 3. learning_cards 表增加 superseded_by_card_id 和 updated_at 列
ALTER TABLE "learning_cards" ADD COLUMN IF NOT EXISTS "superseded_by_card_id" uuid;
--> statement-breakpoint
ALTER TABLE "learning_cards" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint

-- 4. card_key_points 表增加 created_at 列
ALTER TABLE "card_key_points" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint

-- 5. evidences 表增加 workspace_id 索引
CREATE INDEX IF NOT EXISTS "evidences_workspace_idx" ON "evidences" ("workspace_id");
--> statement-breakpoint

-- 6. validation_events 表增加 key_point_id 索引
CREATE INDEX IF NOT EXISTS "validation_events_key_point_idx" ON "validation_events" ("key_point_id");
--> statement-breakpoint

-- 7. understanding_events 替换索引（含 workspace_id 前缀 + created_at 排序）
DROP INDEX IF EXISTS "understanding_events_subject_idx";
--> statement-breakpoint
CREATE INDEX "understanding_events_subject_idx" ON "understanding_events" ("workspace_id", "subject_type", "subject_id", "created_at");
--> statement-breakpoint

-- 8. pg_trgm 扩展（用于中文全文搜索）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- 9. search_documents 表
CREATE TABLE IF NOT EXISTS "search_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "object_type" text NOT NULL,
  "object_id" uuid NOT NULL,
  "title" text,
  "body" text,
  "metadata" jsonb DEFAULT '{}',
  "indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_documents_workspace_type_idx" ON "search_documents" ("workspace_id", "object_type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_documents_object_idx" ON "search_documents" ("workspace_id", "object_type", "object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_documents_body_trgm_idx" ON "search_documents" USING GIN (body gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_documents_title_trgm_idx" ON "search_documents" USING GIN (title gin_trgm_ops);
