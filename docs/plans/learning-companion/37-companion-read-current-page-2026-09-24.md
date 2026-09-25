# 37 伴星通用读页面（2026-09-24）

## 1. 起因

用户在真窗口里问伴星「为啥第四张学习卡这么慢」，当时她正停在「学习卡生成中」这一页
（屏上：`正在编写候选`、`已写出 3 / 4 张候选`、`最后更新 6 分钟前`、下面三条已落地的卡）。
她的两次工具调用是 `list_due_reviews`（2 项到期）与 `list_task_queue`（当前没有排着的任务），
然后推出：「慢大概率不是卡在系统这边……是网络或者上游响应的问题，不是你的卡排到第四号了」。

两个读数都是真的，结论是错的。追问「你不能看到页面实时状态元素吗」之后，她改口去问用户
「进度条停在第几步、有没有报错文字」。

## 2. 四段断点（为什么她读不到，而不只是"没去读"）

1. **30 个工具里没有一个读界面。** 最接近的 `companion_read_context` 只回
   `pageKind` / `groundedTutorAvailable` / 活跃学习运行，且 `pageKind` 取自**上一轮落库的行**，
   不是实时状态（`workers/ai-worker/src/handlers/companion-agent-runtime.ts`）。
2. **回合的页面上下文是 5 个枚举，"生成中"不在里面。** 渲染层只映射 today/queue/graph，
   其余 `return null` → 连 `context` 字段都不发
   （`apps/desktop-client/src/renderer/src/app/companion-chat-session.tsx`）；
   合同 `companionPageContextV1Schema` 是 5 个 `.strict()` 变体，没有承载它的形状。
   于是 `<page_context>` 块不注入、`<here_and_now>` 里那句「用户正在看…」整行消失。
3. **唯一带实时页面身份的通道她从不读。** `bridgePageContext` 认得 `generating`
   （→ `interactionState: "processing"`），每页变更 publish 一次到 `assistant_page_contexts`
   （表里有 `interaction_state` 列）。但 worker 侧对这张表的读取只有日报，对话链路一次都不读；
   而且这条合同只带 route/entity 引用，故意不带任何计数器。
4. **推送的 memo 依赖里没有进度。** 依赖是
   `[activeNoteId, activeReviewScheduleId, activeRunId, activeSourceId, hudPage, settingsSection]`
   ——`已写出 3/4` 变成 `4/4` 不会触发第二次 publish。

`list_task_queue` 查的是 `learning_tasks JOIN learning_runs`，与卡片生成那套
`card_generation_*` 表毫无关系。"队列是空的"是一个真答案，回答的是无关的问题。

> **上面四段的现状（2026-09-25 逐条按源码复核；本文是历史记录，取数请以下面为准）**
>
> 1. **"30 个工具里没有一个读界面"已不成立**：注册表现读仍是 **30 条**，但这一条已经是其中之一
>    （`companion_read_current_page`，`packages/shared/src/companion-agent-registry.ts:80`）。
>    数字没变是因为同一批里删了 0 调用的 `plan_route`（−1）＋加了这条（＋1）——
>    **别把"30"当成同一个盘子**。
> 2. **两个通道分开了，别混着读**：对话链落库那份 `companionPageContextV1Schema` **仍是 5 个变体**
>    （`companion-conversation-contracts.ts:323`，`generating` 至今不在里面）；但**读侧**
>    `mainPageContextInputV2Schema.pageKind` 已是 **11 档**（`companion-bridge-contracts.ts:481-484`），
>    渲染层也**不再只映射 today/queue/graph**——现读 **8 个组件发 11 个 `pageId`**
>    （`home`、`card_generation_review`、`card_generation_progress`、`today`、`review_queue`、
>    `note_library`、`note_read`/`note_edit`、`star_map`、`assessment`、`result`）。
> 3. **"她从不读那条实时通道"已被 39 系列的 W2-2 做掉**：`companion-here-and-now.ts` 的
>    `resolveCurrentPage` 现在每轮先读 `assistant_page_contexts` 的实时行，把 `readable_view`
>    折进「用户正在看…」并多渲染一行「这一屏：{statusLine}」；`run.page_context` 退为兜底。
>    W2-6 又用同一次读出的 `interaction_state`／`entity_refs` 判"在不在作答页"。
>    ⇒ 本节的"四段断点"里**只有第 4 段仍然是待办**（本文自己 §4 那句"每页约 10 行"指的是登记，
>    剩 9 页见 39d §7 W2-7）。
> 4. **未复核**：推送的 memo 依赖里有没有进度——`companion-chat-session.tsx` 此刻正被并行会话改，
>    在这里写读数会归因错。

## 3. 机制：一条通道加一种载荷，不是每页一个查询

服务端**没有任何**反向拉渲染层的途径（全仓唯一入站是 client-initiated GET SSE，单向；
worker 与 api 之间只有共享 Postgres 行 + `pg_notify`）。所以实时页面状态只能渲染层推。
而渲染层**已经在推了**——这次是给那条已有通道加一种通用载荷，不新建链路。

- **合同**：`packages/shared/src/companion-bridge-contracts.ts` 的 `pageReadableV1Schema`。
  形状与页面无关：`title` / `statusLine` / `metrics≤6` / **`items≤12` 带 `ordinal`** /
  `notice` / `filters≤6`，总字符预算 `PAGE_READABLE_TOTAL_CHAR_BUDGET = 1600`。
  `items[].ordinal` 是这个形状存在的理由：没有它，"第四张""第二个星体"这类指法
  在任何列表页都落不了地，这个能力又会退化成每页一个专用工具。
- **载荷里没有客户端时间戳**：每推一次都是新 `contextId` + 新 `pageInstanceId`、旧行当场
  revoke，一个每分钟变的相对时间会把推送打成自我撤销的洪水。"这份内容多久没变"
  由服务端从 `issued_at` 算（`contentAgeSeconds`），一个读数只准一个来源。
- **revision 纳入视图**（`companion-bridge-revision.ts`）：视图变了就是 context 变了，
  否则 renew 的 CAS 与"同一 publish 重试"的判定会把内容变化当重复请求吞掉。
- **落库**：迁移 `0277_page_readable_view_in_context.sql` 给 `assistant_page_contexts`
  加 nullable jsonb `readable_view`（不建新表：生命周期与 context 行完全同构）。
  两处 DDL 都写成可重入（`ADD COLUMN IF NOT EXISTS` + drop-then-add 约束）——共享 dev 库上
  这条会被反复跑到。权限无需变更：这张表已在 `infra/postgres/roles.sql:1068` 的
  worker 只读清单里。
- **发布**：`components/hud/use-page-readable-view.ts` 的 `usePageReadableView(view)`，
  与 `useHudPage` 同一套形状（页面自己登记、shell 统一消费）。store 槽位带**发布者令牌**：
  换页时前一页的 cleanup 可能晚于后一页的 setup，"卸载就清空"会把刚发布的新视图抹掉。
  超预算/形状不合在 hook 里挡下并 `console.error`——再往下每一层都是静默的
  （推送那句是 `.catch(() => undefined)`）。
- **工具**：`companion_read_current_page`（read / 免确认 / 零参数）。
  **读不到就明说读不到**：无活动 context → `available:false`，
  safeSummary「这一页现在没有可读的内容」。这是这个工具最重要的性质。
  裁剪在服务端做，不信客户端自报：`credential_surface` 整块拒，
  `formal_assessment` 丢 `items` 只报条数。
- **界面标签**：`companion-agent-nodes.ts` 里「正在看你这一页」原本挂在
  `companion_read_context` 上，而那个工具跟屏幕无关——现在这句话只属于真读屏的工具。

## 4. 首批接线的六个页面

`generating` / `candidate`（`CardGenerationSurface.tsx`）、`today`（`StudySurface.tsx`）、
`queue`（`ReviewSurface.tsx`）、`graph`（`graph-surface.tsx`）、`home`（`HomeV2ObjectLayer.tsx`）。

每个页面登记的数字**全部来自它自己已经在渲染的那个 view**
（`cardGenerationProgressView` 的 `detail`、`buildTodayVerdict` 的 `metrics`、
`reviewDeckPosition` / `deckTotal` / `readyCount`、星图的 `telemetry`、
`homePresentation` 的 `reviewLabel`），这一层一个都不重新计算。

首页那条必须按组件自己第 200 行的早退条件收口：它在业务页面上仍然挂载（只是渲染 null），
无条件发布会让首页和当前页抢同一个槽位。

其余 11 个页面（sources / source-detail / notes / note-read / note-edit / goals /
goal-detail / assessment / result / search / settings / companion / resumable / space /
login / register）尚未登记——她们那几页现在读到的是「这一页还没有登记可读内容」，
不是错的读数。每页约 10 行。

> **更正（2026-09-25，按现读名单逐项对过）**：上面那句"其余 11 个"**与实际列出的名单不符**——
> 那个括号里是 **16 个**名字。而且这份名单此后已经变动两次，别再从这里取数：
> `login` / `register` 两档在 W2-1 作为死分支删掉了（渲染层从不发布它们），
> `notes` / `note-read` / `note-edit` / `assessment` / `result` 五页已在 W2-2（P4-a）登记完。
> **16 − 2 − 5 = 9**，剩下的 9 页与 `39d-implementation-task-breakdown-2026-09-24.md` §7 的
> **W2-7** 名单逐项一致（sources / source-detail / goals / goal-detail / search / resumable /
> settings / companion / space）。§7「没做的」第 4 条同此更正。
> （另记一句口径：`HUD_PAGES` 的**页面键**与这里说的"页"不是同一套数——一个组件可以按状态
> 发两个 `pageId`（`CardGenerationSurface` 两条、`notebook-surface` 两条），别把两者混着减。）

## 5. 验收

### 确定性（先跑完这些，再花模型的钱）

| 层 | 位置 | 钉住什么 |
|---|---|---|
| 合同 | `packages/shared/src/companion-bridge-contracts.test.ts` | 条目数/序号起点/标签长度/总预算四道上限；不接受客户端自报时间与额外字段；只改视图也换 revision |
| 工具 | `workers/ai-worker/src/handlers/companion-agent-runtime.test.ts` | 三态（读不到 / 正常 / 不合合同）；正式作答页丢正文；凭证页拒读；工具在只读权限下仍下发 |
| 页面 | `components/CardGenerationSurface.page-readable.test.tsx` | 屏上 `已写出 3 / 4` 与逐张清单**同时**进视图，序号 `[1,2,3]`，标题与屏上 h2 逐字相同 |
| 发布 | `app/companion-chat-session.bridge-view.test.tsx` | 生成中这一页带着视图 publish；**只把 3/4 改成 4/4 会再发一次** |
| store | `app/room-store.test.ts` | 内容没说不换对象；后来者的发布不被前一页的撤销抹掉；不持久化 |
| 写入侧 | `apps/api/src/integration-tests/companion-bridge-postgres.integration.ts` | 视图真落进 `readable_view` 列；snapshot 带回；只改视图也换 revision |
| 读侧 | `workers/ai-worker/src/integration-tests/companion-agent-postgres.integration.ts` | 已撤销/已过期不算当前这一屏；**同 workspace 换 user 必须什么都读不到**（这张表的 RLS 对 `ailearn_worker` 是按用户名放行的，SQL 里那两个条件是唯一的闸） |

四条新断言各自做过变异检验：把服务端裁剪 items 改坏、把 `pageReadableView` 从 memo 依赖里
摘掉、把 SQL 的 `user_id` 条件删掉，对应用例都红过一遍再改回来。

`companion-bridge-postgres.integration.ts` 此前不在 CI 点名列里，本次接入
（`.github/workflows/ci.yml` 的 note-collaboration 那一组）。

### 一次真 LLM 回合（`scripts/companion-page-readable-turn-verify.py`）

不起新窗口、不碰并行会话在用的实例：为 `owner@ailearn.local` 造一条真表真列的
context 行（内容就是屏上那一份：`已写出 3 / 4 张候选` + 三条已落地候选），
把用户原话发进连续会话，读回工具调用与她的正文。

- **读不到的那一半**（夹具行被提前删掉时反而验到了）：她调了工具、拿到
  「这一页现在没有可读的内容」，然后说
  「这一页我这边现在读不到实时内容——所以『第四张卡慢成什么样』我确实没法替你判断……
  你瞄一眼那个进度条停在第几步、有没有红字报错，念给我听」。
  **没有拿别的数字编一个页面结论**，这正是这次事故要根除的形状。
- **读到的那一半**：工具回执 `正在看「把《IndexTTS 2.5 让声音跨越语言》整理成学习卡」· 屏上 3 项`，
  她的答复「现在写着 **3 / 4 张候选**了：GRPO 应用步骤、2.5 为何立项、多语言音色迁移。
  第四张还在编，写完一批会一次给齐，不是卡死」，并给了升级条件（停在 3/4 超过三五分钟再重试）。

这条链路上烧了三次模型调用：前两次是我这个探针脚本自己的错（把 `accepted` 当终态、
`finally` 在 worker 执行工具之前删掉了夹具行），不是产品行为。脚本里已把这条写进注释。

## 6. 全量结果

`packages/shared` 387/387、`workers/ai-worker` 815/815、`apps/desktop-client`
195 文件 / 1606 条、`apps/api` 1591（1590 pass / 0 fail / 1 既有 skip），
四个包 `typecheck` 均 0 错。真库两条集测各 1/1。

## 7. 没做的

1. **她读页面仍然是"问了才读"**。`<here_and_now>` 里那句「用户正在看…」仍只认
   `PAGE_KIND_LABELS` 那 9 个 pageKind，`generating` 不在其中——也就是说她不主动知道
   用户在哪一屏，只有调了这个工具才知道。要不要把视图也主动注入环境块，是下一个决定。
   **→ 这条已被 39 系列的 W2-2 做掉（2026-09-25 复核）**：`companion-here-and-now.ts` 的
   `resolveCurrentPage` 现在**先读 `assistant_page_contexts` 的实时行**，把 `readable_view`
   折进「用户正在看…」并多渲染一行「这一屏：{statusLine}」，`run.page_context` 退为兜底。
   顺带更正一个数：`PAGE_KIND_LABELS` 现读是 **10 档**（不是 9）。
2. **`open_page` 白名单里没有卡片生成页**（home/today/review/star_map/conversation/
   source/settings）。她现在读得到那一屏，却仍然跳不回去。（**仍未解决**，且已查明不是加一行能
   解决的：`allowedMainRouteV2Schema` 里根本没有 `card_generation` 这一档，而 `open_page` 只收
   **无参**落点 ⇒ 要接得先有路由 kind 或带参的打开动作，属设计决定。词表一处已收敛成
   `COMPANION_PAGE_DESTINATIONS_V2`，见 39d §7 W2-1）
3. **`TOOL_LABELS` 缺 5 个工具的中文标签**（`pause_learning` / `resume_learning` /
   `request_hint` / `switch_task_variant` / `plan_route`），落到界面上是「正在处理…」。
   **→ 已做掉（W2-1）**：补齐 26→31，并且**判据改成从注册表现读的集合相等断言**
   （`apps/desktop-client/src/renderer/src/app/companion-tool-labels.test.ts`）——不再手抄第二份名单；
   `plan_route` 随后整条删除（全窗口 0 次调用）。
4. 其余 11 个页面未登记可读视图（见 §4 末尾）。**→ 数字与去向见 §4 上方那条更正**：
   实为 16，P4-a 已登记 5 页，剩 9 页在 **W2-7**。
5. dev 库上 `0275` / `0276` 的 hash 记账与对象状态不一致（表已存在但 ledger 没记），
   `npm run db:migrate` 会停在 0275 并挡住后面每一条。本轮按语句单独把 0277 应用了，
   **没有替并行会话补那两条的账**——那是他们的在途工作。
