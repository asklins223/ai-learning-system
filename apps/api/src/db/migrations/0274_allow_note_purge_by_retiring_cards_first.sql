-- 0274 —— 让"她删掉的笔记"真的删得掉（doc 34 L17，用户口径：卡留着但退役）。
--
-- 今天的事实（我在 dev 真库读 `pg_constraint` 核过）：全库唯一一条指向 `note_versions` 的
-- RESTRICT 就是 `learning_cards_v2_note_version_id_fkey`，其余全是 CASCADE / SET NULL。
-- 于是 `notes` → `note_versions` 那一路 CASCADE 走不动：一篇生成过卡的笔记
-- **永远删不掉**，30 天清除与手动"永久删除"两条路都只能在 FK 上撞一次然后跳过。
--
-- 改成 SET NULL 是这次决定的一半，**单独改它会出事**：`visibleCardsCondition`
-- （apps/api/src/modules/note/visibility.ts）的第一支是 `note_version_id IS NULL`
-- ——语义是"这张卡没有可追溯的私有来源，不受笔记可见性约束"。
-- 只断线不退役，那张卡就会在笔记被删之后**重新回到复习队列**，
-- 比现在（永远删不掉）更糟。所以顺序是硬的：
--   ① `physicalDeleteNote` 先把该笔记各版本产出的卡与其目标置为 archived（退役，不再被服务）
--   ② 再删笔记 → 版本 CASCADE → 指针 SET NULL
-- 退役后的卡 lifecycle 不是 'active'，到期队列与卡列表两条判据都进不来。
--
-- 卡的正文/发布版本/她练过的历史**全部保留**（`learning_card_publication_revisions_v2`、
-- `learning_exposures_v2` 都不动），这是"卡留着"那半句话的意思。

ALTER TABLE public.learning_cards_v2
  DROP CONSTRAINT learning_cards_v2_note_version_id_fkey;

--> statement-breakpoint

ALTER TABLE public.learning_cards_v2
  ADD CONSTRAINT learning_cards_v2_note_version_id_fkey
  FOREIGN KEY (note_version_id) REFERENCES public.note_versions(id) ON DELETE SET NULL;

--> statement-breakpoint

-- 反向守卫：留一条"退役必须发生在删除之前"的静态证据。这里不抛错（会让清除任务整轮失败），
-- 而是把约束形状钉在注释里，由 note-purge-soft-deleted 那份集测在真库上守行为。
COMMENT ON CONSTRAINT learning_cards_v2_note_version_id_fkey ON public.learning_cards_v2 IS
  'L17：笔记物理删除时指针置空，但置空只允许发生在调用方已经把该卡退役（lifecycle<>active）之后——见 0274 头部与 physicalDeleteNote。IS NULL 那一支在可见性判据里是"无来源、不受约束"，漏退役会让卡回队列。';
