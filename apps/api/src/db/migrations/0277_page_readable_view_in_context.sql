-- 0277 —— 页面可读视图落库：伴星第一次能读"用户此刻这一屏"（doc 37 §3）。
--
-- 改之前的事实：她**没有任何**读页面的途径，而且是三层同时缺——
--  1. 30 个工具里没有一个读界面；最接近的 `companion_read_context`
--     （`companion-agent-runtime.ts:699-723`）只回 pageKind/groundedTutor/活跃运行，
--     且 pageKind 取自**上一轮落库的那一行**，不是实时状态；
--  2. 回合的 pageContext 是 5 个枚举的 discriminatedUnion
--     （`companion-conversation-contracts.ts:323-361`），渲染层只映射 today/queue/graph
--     （`companion-chat-session.tsx:575-580`），其余一律 null → 连"我在哪页"都不发；
--  3. 唯一携带实时页面身份的通道是 bridge context（每页变更 publish 一次到
--     `assistant_page_contexts`，含 `interaction_state`），但 worker 侧对这张表的读取
--     只有日报（`companion-daily-summary.ts:407,574`），对话链路一次都不读它。
--
-- 后果不是"她少说一句"，而是**她说错**：实机用户问"为啥第四张学习卡这么慢"，她调了
-- `list_due_reviews` 与 `list_task_queue`——后者查 `learning_tasks JOIN learning_runs`
-- （`:1204-1225`），与卡片生成那套 `card_generation_*` 表毫无关系，于是"队列是空的"
-- 字面全真、方向全错，她据此推出"慢在模型/网络，不是你的卡排到第四号"。
--
-- 这一列存的是**页面自己登记的、屏幕上正在显示的那份视图**（标题/状态行/计数器/
-- **带序号的条目**/空态/当前筛选，合同见 `pageReadableV1Schema`）。带序号的条目是
-- 这张表存在的理由：没有它，"第四张""第二个星体"这类指法在任何列表页都落不了地，
-- 这个能力又会退化成"每页各写一个查询工具"。
--
-- 为什么不建新表：这份视图的生命周期与 context 行**完全同构**——同一个 pageInstance、
-- 同一次 revoke、同一个 30s lease。另起一张表只会多出一个"两边不一致"的状态。
--
-- 存量不回填：旧行对应的窗口状态早就没了，补一份"当时屏上是什么"是伪造。
-- 读侧一律按"这一页没有可读内容"处理，并且要**明说**读不到——这是这个工具最重要
-- 的性质：宁可她说"你截个图/告诉我在哪"，也不要她再拿真而无关的证据编一个结论。
--
-- 权限无需变更：`assistant_page_contexts` 已在 roles.sql 的 worker 只读清单里
-- （`infra/postgres/roles.sql:1068`），迁移侧 GRANT 在 0122 也已给到 api 全权。
-- 列上不放任何时间戳："多久之前"由服务端从 `issued_at` 算（同一读数只准一个来源）。

-- 共享 dev 库上这条会被反复跑到（0275/0276 的 hash 记账与对象状态不一致时，
-- migrate 会停在 0275 并把后面几条重新过一遍），所以两处 DDL 都写成可重入：
-- ADD COLUMN 用 IF NOT EXISTS，约束用 drop-then-add（与 0122 的 DROP POLICY IF EXISTS 同形）。
ALTER TABLE public.assistant_page_contexts
  ADD COLUMN IF NOT EXISTS readable_view jsonb;

--> statement-breakpoint

ALTER TABLE public.assistant_page_contexts
  DROP CONSTRAINT IF EXISTS assistant_page_contexts_readable_view_shape_chk;

--> statement-breakpoint

ALTER TABLE public.assistant_page_contexts
  ADD CONSTRAINT assistant_page_contexts_readable_view_shape_chk
  CHECK (readable_view IS NULL OR jsonb_typeof(readable_view) = 'object');

--> statement-breakpoint

COMMENT ON COLUMN public.assistant_page_contexts.readable_view IS
  '页面自登记的屏上可读视图（0277 / doc 37）。不可信提示：正文按 sensitivity 由服务端二次裁剪；无时间戳字段。';
