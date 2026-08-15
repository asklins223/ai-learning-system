-- schema 漂移修复：db/schema/card.ts 声明 card_key_points.updated_at
-- （card/service archiveCard 等会写入），但历史迁移从未建列——真实 DB 上
-- 任何 ORDER BY k.updated_at / UPDATE updated_at 都 42703。
-- 对齐 schema：NOT NULL + DEFAULT now()，存量行以 created_at 回填。

ALTER TABLE public.card_key_points ADD COLUMN IF NOT EXISTS updated_at timestamptz;

--> statement-breakpoint

UPDATE public.card_key_points SET updated_at = created_at WHERE updated_at IS NULL;

--> statement-breakpoint

ALTER TABLE public.card_key_points ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.card_key_points ALTER COLUMN updated_at SET NOT NULL;
