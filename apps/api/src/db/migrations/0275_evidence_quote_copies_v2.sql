-- 0275 —— 证据原文的不可变副本，"当初那段话"要取回来（doc 34 L21 §1，用户口径：真冻一份进去）。
--
-- 改之前的事实：`evidence_snapshots_v2.protected_quote_ref` 写的是
-- `evidence://snapshot/<新随机 uuid>`（`evidence-seal-core.ts:214`），而全仓**没有任何解析器**——
-- 合同里那句"正文封装在不可变 protectedQuoteRef…经 protected ref 访问"
-- （`card-quality-v2-contracts.ts:167`）从来没有落地。文本只活在 `note_blocks.content`（可就地改写、
-- 可被 stale 清理删掉），所以"复算哈希发现漂移"这条路只能失败关闭，永远说不出**原来是什么**。
--
-- 这张表就是那份副本：密封时把切片原文写一次，之后只读。
--  - 唯一键 (workspace_id, evidence_snapshot_id)：一条证据一份副本，重复密封走 ON CONFLICT DO NOTHING。
--  - 外键 workspaces CASCADE：`schema-isolation-gate` 那道棘轮要求新表带 FK（它明确写着
--    "请补 FK，不要加进基线绕过"），而 `evidence_snapshots_v2` 自己还在缺 FK 的基线里。
--  - RLS ENABLE + FORCE + 与 `es_v2_ws_isolation` 同形状的守卫。
--  - **权限在迁移里直接 GRANT**：`roles.sql` 是按 `ALL TABLES` 授的，只覆盖"建表在它之前"的库；
--    增量迁移建的表如果没有这一句，症状是运行期 `permission denied`（doc 34 L8 那一课）。
--
-- 存量：**不回填**。老快照的原文已经无从确定（`note_blocks` 现在的内容可能就是被改过之后的），
-- 拿今天的文本去"补一份副本"是把伪造写成证据。所以读侧一律按"没有副本"处理
-- （`originalPreview: null`），漂移时只显示现在这段 + "原文已改动"。

CREATE TABLE public.evidence_quote_copies_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  evidence_snapshot_id uuid NOT NULL,
  quote_text text NOT NULL,
  quote_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT eqc_v2_ws_snapshot_unique UNIQUE (workspace_id, evidence_snapshot_id),
  CONSTRAINT eqc_v2_quote_hash_matches_length CHECK (char_length(quote_hash) = 64)
);

--> statement-breakpoint

CREATE INDEX eqc_v2_ws_snapshot_idx ON public.evidence_quote_copies_v2
  USING hash (evidence_snapshot_id);

--> statement-breakpoint

ALTER TABLE public.evidence_quote_copies_v2 ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.evidence_quote_copies_v2 FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY eqc_v2_ws_isolation ON public.evidence_quote_copies_v2
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ((CURRENT_USER = 'ailearn_worker' OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid))
  WITH CHECK ((CURRENT_USER = 'ailearn_worker' OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid));

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.evidence_quote_copies_v2 TO ailearn_api;
GRANT SELECT, INSERT ON public.evidence_quote_copies_v2 TO ailearn_worker;
GRANT ALL PRIVILEGES ON public.evidence_quote_copies_v2 TO ailearn_migrator;

--> statement-breakpoint

-- "只写一次、只读"不能只是一句注释：沿用 V2 那套既有不可变触发器（0138/0180），
-- 集测清理走 `app.allow_history_mutation` 那道既有的绕行口子（与其他 V2 表同形）。
CREATE TRIGGER eqc_v2_immutable BEFORE UPDATE OR DELETE ON public.evidence_quote_copies_v2
  FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_v2_row_mutation();

--> statement-breakpoint

COMMENT ON TABLE public.evidence_quote_copies_v2 IS
  '密封时冻结的证据原文副本（0275 / doc 34 L21 §1）。只写一次、只读；protected_quote_ref 由它解析。存量快照没有副本，读侧必须能区分"没有副本"与"副本为空"。';
