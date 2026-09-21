-- 0248: 笔记的共享边界——新建默认个人，共享是一次显式动作。
--
-- 产品规则：共享学习空间只共享**学习资料**，而"一篇笔记"在作者决定拿出来之前不属于
-- 资料，属于作者自己。所以 `notes` 上必须有归属这一列，它不能从空间类型推出来
-- （协作空间里同样有私人草稿），也不能从 `created_by` 推出来（作者写的也可以共享出去）。
--
-- 这一列同时是协同长连接的门槛：只有 `shared` 的笔记建立实时连接；`private` 的笔记
-- 编辑走同一条 CRDT 增量口（HTTP 上送），只是不广播。归属判据在
-- `apps/api/src/modules/note/visibility.ts`，本文件只负责让那个判据有地方存。
--
-- ─── 存量一律回填成 `shared` ───
-- 那些笔记今天本来就对所有成员可见，把它们改成私人等于在用户没有做任何动作的情况下
-- 撤回内容可见性——迁移不该制造这种"东西忽然不见了"。新行的默认值是 `private`，所以
-- "默认个人"这个规则只对从现在起创建的笔记生效。
--
-- 撤回（`shared → private`）同样是作者的权利，但已经按这篇生成过的卡片不会因此失效：
-- 证据链存的是生成当时抄下来的正文摘录，不依赖这篇现在可见。撤回只是让**之后**别人
-- 不再能读到它。
--
-- ─── 有意不给新列加索引 ───
-- 读法的驱动条件仍然是 workspace + 排序游标，`notes_active_idx`
-- （workspace_id, partial on deleted_at IS NULL）已经把候选集收到一个空间的规模，
-- `share_scope OR created_by` 只是在这之后的一次行级过滤。多一个索引就多一份写放大，
-- 而笔记列表是热路径。
--
-- ─── 三张既有表的 RLS 策略要跟着这次改动看一遍，否则"重开 RLS"会白做 ───
-- `note_blocks` / `note_versions` 的行级策略只按 workspace_id 判，
-- `note_document_states` 也是（那张当前是 ENABLE + FORCE，API 角色真的受它约束）。
-- 它们的 `workspace_id` 是从 `notes` 继承来的冗余列，本身不带归属信息，所以光加这一列
-- 不会让这三张表变成按人可见——旧策略照样把私人笔记的子行发给同空间的其他人。
--
-- 本轮由应用层那一处判据承担，并且放在**加载正文的入口**而不是只放在路由里：协同落盘口
-- `onStoreDocument` 原来完全不读 `notes`，只按 noteId 就把快照写给任何开过这条连接的
-- 成员，那条链上的判据必须和路由是同一份。
--
-- 将来重开这三张表的 RLS 时，策略要一起改成带 created_by 的那一半，形如：
--   USING (EXISTS (SELECT 1 FROM public.notes n WHERE n.id = <本表>.note_id
--     AND (n.share_scope = 'shared' OR n.created_by = <app.user_id>)))
-- 只按 workspace_id 写的策略等于把这列当成不存在。

--> statement-breakpoint

-- 重跑要无害：本文件若在已应用过的库上再走一次，缺 `IF NOT EXISTS` 会停在
-- "column share_scope of relation notes already exists"。CHECK 没有 IF NOT EXISTS
-- 这种写法，所以先 DROP 再 ADD（与 0237/0238 的 DROP POLICY IF EXISTS 同一考虑）。
ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS share_scope text NOT NULL DEFAULT 'private';

--> statement-breakpoint

DO $$
BEGIN
  -- ADD CONSTRAINT 没有 IF NOT EXISTS 这种写法，所以判过一次再加：
  -- 已应用过的库上重跑本文件必须整文件无害。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notes_share_scope_check' AND conrelid = 'public.notes'::regclass
  ) THEN
    ALTER TABLE public.notes
      ADD CONSTRAINT notes_share_scope_check CHECK (share_scope IN ('private', 'shared'));
  END IF;
END
$$;

--> statement-breakpoint

UPDATE public.notes SET share_scope = 'shared';
