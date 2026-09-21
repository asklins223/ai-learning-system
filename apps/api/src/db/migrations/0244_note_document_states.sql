-- 0244: 笔记正文的 CRDT 文档状态表（批次 4 协同内核的落盘处）。
--
-- 一行 = 一篇笔记的当前 Y.Doc 快照。从这张表起，正文的**事实源是 Y.Doc**，
-- `note_blocks` 降级成从它派生的投影关系表（搜索索引、卡片证据链、导出、列表预览
-- 四个下游继续读行，但不再有第二条写路）。这是审查里"两个人/两扇窗口持同一个 OCC
-- 令牌双双通过检查、后写原地覆盖前写且无从恢复"的根治点：覆盖不再可能，因为写入是
-- 对同一文档的增量操作，不是对一行的整篇替换。
--
-- 为什么只有一张状态表、没有 update log：计划锁定的决定 6 是 snapshot-on-idle
-- （无人编辑时把整份快照落盘）。再加一张 append-only 的 update 表就会有两个事实源，
-- 而"谁覆盖谁"的问题正是从多写路来的——不该在新表里重犯。崩溃窗口内最多丢失
-- 一段空闲前的增量，客户端本机按 `(workspaceId, epoch, noteId)` 另有缓存兜底（决定 7）。
--
-- `revision` 是给客户端判断"我手里的状态落后多少"用的单调计数，不承载内容语义。
--
-- 归属与隔离：这张表按决定 8 的要求**第一天就 ENABLE + FORCE**，并带
-- `workspace_id` 外键——它是 `schema-isolation-gate` 棘轮的第二个样板（第一个是
-- `user_ai_settings`）。新表不再进"缺外键/缺 RLS"的基线，而是反过来：谁想把它
-- 挪回基线，棘轮就红。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.note_document_states (
  note_id uuid PRIMARY KEY REFERENCES public.notes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  state bytea NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 组合外键：挡住"note_id 是 A 空间的、workspace_id 写成 B 空间"的行。
  -- 单列外键各自都成立，那种错行照样能写进来，而它一旦存在就会让 RLS 的
  -- workspace 判定形同虚设。`notes (id, workspace_id)` 上有唯一约束可供引用。
  CONSTRAINT note_document_states_note_workspace_fk
    FOREIGN KEY (note_id, workspace_id)
    REFERENCES public.notes (id, workspace_id) ON DELETE CASCADE
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS note_document_states_workspace_idx
  ON public.note_document_states (workspace_id);

--> statement-breakpoint

ALTER TABLE public.note_document_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_document_states FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- 先 DROP 再 CREATE：本文件若在已应用过的库上重跑，缺这一行会停在
-- "policy already exists"（与 0237/0238 同一处理）。
DROP POLICY IF EXISTS note_document_states_workspace_isolation
  ON public.note_document_states;
CREATE POLICY note_document_states_workspace_isolation
  ON public.note_document_states FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

-- 只授 API：文档快照的读写都在 API 进程内（Hocuspocus 也是内嵌进 API 的决定 4）。
-- worker 不碰这张表，就不给它权限——多一张表能写的角色，就多一处绕过 RLS 上下文的可能。
-- 不依赖 ALTER DEFAULT PRIVILEGES：dev 栈没有跑 compose 里那个一次性的 role-grants
-- 服务，缺这一行的症状是"读写静默失败"。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_document_states TO ailearn_api;
