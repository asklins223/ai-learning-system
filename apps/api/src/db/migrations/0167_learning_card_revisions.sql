-- 0167_learning_card_revisions.sql
-- 方案 20 §18.2（R36）：learning_card_revisions_v2 不可变 Card revision 表。
-- learning_cards_v2 只保留 current 去规范化行（front/strategy/presentationHash）；
-- 每次 bump cardRevision 必须原子写入一条不可变 revision 行（front/strategy/
-- presentation hash），杜绝“前端被原地覆盖、历史丢失”问题。
-- 与 learning_card_publication_revisions_v2 的 (card_id, cardRevision) 对齐。

CREATE TABLE IF NOT EXISTS learning_card_revisions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  card_revision_id uuid NOT NULL,
  card_id uuid NOT NULL,
  revision integer NOT NULL,
  front jsonb NOT NULL,
  strategy text NOT NULL,
  presentation_hash text NOT NULL,
  supersedes_card_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lcr_v2_ws_revision_unique
  ON learning_card_revisions_v2 (workspace_id, card_revision_id);

CREATE UNIQUE INDEX IF NOT EXISTS lcr_v2_ws_card_rev_unique
  ON learning_card_revisions_v2 (workspace_id, card_id, revision);

CREATE INDEX IF NOT EXISTS lcr_v2_ws_card_idx
  ON learning_card_revisions_v2 (workspace_id, card_id, created_at);

ALTER TABLE learning_card_revisions_v2
  ADD CONSTRAINT lcr_v2_revision_chk CHECK (revision >= 1);

-- 防止自引用/循环 lineage。
ALTER TABLE learning_card_revisions_v2
  ADD CONSTRAINT lcr_v2_no_self_ref_chk
  CHECK (supersedes_card_revision_id IS NULL OR supersedes_card_revision_id <> card_revision_id);

-- RLS 与角色授权（0162 模式）：api 写、worker/读侧角色可读；workspace 单条件隔离。
ALTER TABLE learning_card_revisions_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY lcr_v2_ws_isolation ON learning_card_revisions_v2
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON learning_card_revisions_v2 TO ailearn_api, ailearn_worker;
