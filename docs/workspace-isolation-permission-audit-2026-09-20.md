# 多学习空间（workspace）隔离与权限审查报告

- 审查日期：2026-09-20
- 审查范围：学习空间的展示与切换、只读权限的表达与管控、跨空间数据隔离、并发编辑、行为数据归属
- 分支：`v1.0`（commit `b8226815`）
- 术语：产品「学习空间」= 代码 `workspace`；`workspaceId` 定位空间，`workspaceEpoch` 是客户端的空间边界令牌；「只读」= `workspace_members.role = 'member'`

---

## 0. 结论速览

**做对了的部分**：作用空间的派生与切换是干净的。空间只能来自 DB session 行，客户端无法通过 body/query/header 指定空间（全仓 0 命中）；被移出或软退出会即时吊销 session；切空间时主进程换 token、递增 epoch、清空投影缓存与幂等表、拆掉伴星所有流。这部分设计水准高于本报告的其它部分。

**核心问题**：「只读」在产品合同里是一句承诺（`PRODUCT.md:24`、`PRODUCT.md:127`），在代码里是十几处各自为政的局部判据；而本该作为兜底的数据库层隔离（SEC-01 RLS）**当前整体处于关闭态**，验证它的自动化测试**是源码字符串包含断言**。三层叠加的结果是：

> `workspace_id` 目前是一个纯约定。没有任何一层——DB 外键约束、DB 行级策略、自动化测试——在强制它。

量化支撑（均为本次实测）：

| 事实 | 数值 |
|---|---|
| 有 `workspace_id` 列的表 | 96 |
| 其中真的有指向 `workspaces` 外键的 | **7** |
| 开启 RLS 的表 / 全部表 | 86 / 105 |
| 关闭 RLS 的表中为核心内容的 | `notes` `note_versions` `note_blocks` `sources` `source_segments` `search_documents` `review_schedules` `ai_artifacts` `workspaces` `workspace_members` `invite_codes` `jobs` `users` `sessions` 等 19 张 |
| 表归属键分布 | 60 张 (ws,user) / 36 张仅 ws / 4 张仅 user / 5 张无归属键 |
| 写路由总数 | 94（`requireOwner` 30、仅 `requireSession` 63、无 guard 1） |
| dev 库成员角色分布 | `owner` 856 条、**`member` 0 条** |
| 属于 2 个以上空间的用户 | **0** |

**最后一行是本报告最重要的单条事实**：只读协作这条链路，从来没有被真实数据走过一次。全仓没有任何一个 `member → 403` 的行为断言，集成测试夹具只插 `role='owner'`（`route-contract-postgres.integration.ts:46-48`）。

---

## 1. 五个具体问题的审查结果

### 1.1 AI 伴星在多空间下会数据混淆吗？

**结论：内容检索链路不会串；调度器与"读资料"两处会。**

已验证隔离：

- 全仓唯一一处 pgvector 语义检索同时约束双键：`workers/ai-worker/src/handlers/companion-memory-vector.ts:202-203`（关键词降级 `:154-155`、探测 `:248-249` 同样带）。**未发现 A 空间笔记被带进 B 空间回答的路径。**
- grounded tutor 取笔记正文按 workspace+user+run+snapshot+hash 五重密封（`companion-dialogue-store.ts:217-243`）。
- 伴星代表用户执行的 action 只写调用者自己的行，且经 proposal 确认（`companion-agent-runtime.ts:483-514`）；grant 为 HMAC 且内嵌 scope 重校验（`turn-service.ts:153,166-173`）；跨空间 resume 明确拒绝（`companion-shell/service.ts:552-560`）。
- 桌宠不是独立 Electron 窗口（全仓仅 `src/main/index.ts:383` 一处 `new BrowserWindow`），与主窗共用同一 gateway 单例与 `activeWorkspaceEpoch`；47 个 companion IPC 通道全部过 epoch 校验；切空间显式拆流（`desktop-ipc.ts:1454-1468`）。

问题项：

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | 日记调度每人**只服务一个空间**，其余空间永无日记，"当天有无活动"也只查那一个空间 | `0198_fix_companion_daily_summary_activity.sql:37-43`：`ORDER BY wm.joined_at ASC LIMIT 1`（原文 `0171:41-45`） |
| 中 | 念头调度**不过滤 `left_at`**，已退出的空间仍持续生成念头并投进 inbox | `0227_assistant_thoughts.sql:99-101` 全文 `left_at` 出现 0 次（对比 0198 有） |
| 中 | 伴星读笔记标题/计数只按空间不按作者，共享空间里任一成员的伴星都能把他人笔记标题注入 prompt 并外发模型 | `companion-here-and-now.ts:144-149`；`notes` 为 workspace-owned（`0039:112-125`）；能力投影对 member 放开 `companion.read/sendMessage/decideProposal`（`capability-projection.ts:72-76`） |
| 低 | 一处 here-and-now 查询缺显式 `workspace_id`，目前只靠 RLS 兜住——而 RLS 正是关着的 | `companion-here-and-now.ts:105-109` |
| 低 | 念头语义去重/冷却键是 (ws,user)，同一想法会在多个空间各说一次 | `companion-thought.ts:391-427` |
| 低 | cue 时间戳与 `companionModelId` 未按空间分键，切空间后短暂显示旧空间形态 | `CompanionPresence.tsx:540`、`room-store.ts` persist |

### 1.2 切换空间的用户感知

**结论：几乎没有持续感知。空间名与角色只活在一个瞬态弹层里。**

运行时实测（CDP 连上正在运行的客户端，非代码推断）：整棵 DOM 中含"空间"二字的节点**只有 1 个**——`aria-label="打开学习空间菜单"` 的图标按钮，且默认态为 `opacity:0` + `inert`（药丸折叠时所有槽位不可交互）。展开药丸 → 点开菜单后才出现 `学习空间 / Personal Beta / 当前 · Personal / 已选择`；菜单一关即卸载（`HudRoomControl.tsx:325` 条件渲染）。顶栏 `HudControls.tsx`、侧栏 `DirectoryRail.tsx`、页面壳 `HudPage.tsx` 中搜不到任何 role 渲染。

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | 空间标识、角色标识均不常驻；个人空间的角色被 `roleLabel()` 直接返回 `"Personal"` 吞掉；协作空间显示英文 Owner/Member，与全站中文不一致 | `HudRoomControl.tsx:294`、`HudAccountMenu.tsx:17` |
| 高 | 切换**无任何成功回执**，且整个房间被门禁页顶替；设置页那条路径 `setNotice` 与组件卸载发生在同一 tick，提示必然消失 | `HudRoomControl.tsx:329-334`、`DesktopAccessGate.tsx:832-855`、`settings-surface.tsx:574-578` |
| 高 | **epoch 守卫是 fail-open**：不传就放行。全站 171 处带 epoch、34 处不带，其中确证写入点为批量 URL 采集（循环内）与笔记图片上传；网关只持一个可变 `this.token`，切空间后即新空间凭据 → **批量采集进行到一半切换，剩余条目静默落进新空间** | `desktop-ipc.ts:812-815`、`desktop-client.ts:25`、`SourceIntake.tsx:204,380`、`note-image-uploads.tsx:169`、`desktop-gateway.ts:607` |
| 中 | 邀请码失败提示**永远显示不出来**：字段声明为 `spaceNotice`，写入方返回 `{ notice }` | `DesktopAccessGate.tsx:110,841,1079,1256` |
| 中 | 8 个页面走 `useSurfaceProjection`，**完全没用** workspace-projection 的边界校验，只靠"门禁整棵卸载"隐式兜底；`CompanionChatProvider` 挂在门禁之上不会卸载，只能手清 | `surface-data.tsx:28-104`、`App.tsx:257` |
| 中 | 正式测评进行中切换空间无确认，直接拆流 | `HudAccountMenu.tsx:87-88`、`room-store.ts:362`、`desktop-ipc.ts:1456-1459` |
| 低 | 空间菜单打开时强改 hudPage 为 `"space"`，副标题仍是"首次进入时…"，与老用户切换用途不符 | `HudRoomControl.tsx:117-124`、`hud-pages.ts:99` |

已验证没问题：无硬编码默认空间；主进程换 token 时 `workspaceEpoch+1`、清投影缓存、清幂等表、清伴星运行时状态（`desktop-gateway.ts:1268-1284`）；服务端 `switchWorkspace` 校验活跃成员并在同事务撤销旧 token（`identity/service.ts:395-425`）。

### 1.3 只读权限的标识、按钮管控与越权

**先纠正一个前提：没有 `viewer` 角色。** 角色只有 `owner | member`，「只读」= member。权限合同在 `packages/shared/src/desktop-ipc-contracts.ts:958` 的 33 个动作位（三态 allowed/denied/conditional），由 `capability-projection.ts:56,78` 按角色批量放行。`capability-bundle.ts` 是发布回滚开关，与权限无关。

#### 标识：不存在持续提醒，且这是合同违约

`PRODUCT.md:127`：「成员只读模式：Member 界面**明确标注权限边界**，不伪装操作入口」。

实际只有三处一次性提示：单篇笔记的「只读」tag（`notebook-surface.tsx:1104`，只描述这一篇）、设置页 `Member · 只读协作`（`settings-surface.tsx:1123`）、空间菜单弹层内。

⚠️ 同名不同义的三处，极易误判：屏幕右上角确实有「只读查看」四个字，但那是编辑器的**版本预览切换**（`ribbon-action`）；`companion-account-presence.ts:35` 的 `read_only` 是**伴星工具执行档位**；`HudRoomControl` 的 `readOnly` prop 是**首次进入场景的装饰态**。

#### 按钮管控

做得不错的：笔记库新建/删除/恢复、来源采集（含粘贴与拖入）、来源详情三类写、导出、AI 政策、学习运行主按钮——都有判据且带解释文案。

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | **笔记重命名绕过同一道判据**：member 的输入框完全可编辑可提交，直到请求失败才回一句 forbidden。同文件对删除/新建都做了 capability 判断 | `note-library-surface.tsx:333,354` |
| 高 | **全员功能 bug**：`card_generation.retry` 全仓只有 3 处引用——合同声明、主进程硬校验、**服务端 owner 放行清单漏了它** → 任何人点"重试生成"永远 forbidden | `desktop-ipc-contracts.ts:962`、`desktop-ipc.ts:2305`、`capability-projection.ts:83` |
| 中 | 版本恢复按钮 disabled 但 title 只解释 dirty，与不可点矛盾；生成能力被权限挡时文案错误归因成"工作区没启用 Card Generation 能力" | `notebook-surface.tsx:953`、`:567` |
| 中 | 邀请/成员管理对 member **整块消失**且无解释，同页其它锁定项都有解释 | `settings-surface.tsx:1401` |
| 中 | 三套平行的只读事实源：capability 位、笔记详情自带 `permissions.canEdit/canSave`、AI 政策 `canManage` | `note-projection.ts:64`、`identity/routes.ts:395` |

#### 越权

已验证安全：作用空间只能来自 DB session 行，`decodeToken` 每次请求实时 LEFT JOIN membership，无 membership 行或 `left_at` 非空立即删 session（`identity/service.ts:306-309`）——`PRODUCT.md:69` 承诺的"被移出工作区立即失效"是真的。抽查 63 条仅 session 级写路由的服务层，全部带 (workspace,user) 谓词，**无确证的 member 改写空间数据点**。

| 严重度 | 问题 | 证据 |
|---|---|---|
| **阻断** | **RLS 整体关闭**：`0027_sec01_rls_expansion_failsafe.sql:20-90` 把 0024 全部回退，策略仍装着但表上 enforcement 是 DISABLE 的。实测 19 张表 `relrowsecurity=f`，含全部核心内容表 + `users` + `sessions` | 迁移 `0027`；实测 `pg_class` |
| **阻断** | **隔离测试不测隔离**：`sec01-cross-workspace-isolation.test.ts:88-91` 是 `content.includes("workspaceId")`；`permission-guard.test.ts:270-279` 只断言文件里含 `requireOwner` 字符串 + 路由路径字符串存在，**不校验 guard 是否绑在那条路由上**——摘掉某个路由的 guard，141 个用例仍全绿（本次实跑通过） | 两个测试文件 |
| 高 | **Owner 可导出全空间成员私有数据**：`review_schedules` 全量 dump 只按 workspace，连成员邮箱一起导出，门槛只有 `requireOwner`；而该表 RLS 恰好是关的。**直接违反 `PRODUCT.md:24` 的"用户私有操作"** | `export/service.ts:431-440,498-509`、`export/routes.ts:11` |
| 中 | 三处只读判定不一致：`requireOwner` 用 OR（role==='owner' **或** workspace.ownerId===me），能力投影与笔记投影只看 membership，`/auth/me` 又按 OR → 存在"服务端允许写、UI 判它只读"的人 | `middleware.ts:51`、`identity/routes.ts:240,262` |
| 中 | member 可通过伴星/记忆路径入队 job 消耗工作区级 provider 预算，无角色或预算闸门 | `memory-routes.ts:142,244,280,477`、`turn-service.ts:513` |
| 中 | `workspace_members.role` 是 free-text、**无 CHECK 约束**；dev 库实测存在 3 条把非 owner 用户写成 `role='owner'` 塞进他人**个人空间**的测试夹具行（`mem-http-*`，无对应 invite 记录） | `0000:29`；实测 `pg_constraint` 只有 2 条 FK |
| 中 | 邀请允许 `role='owner'` 且 UI 提供"所有者"选项（**有意设计**，可邀请 co-owner）；叠加导出即意味着任一 co-owner 能拿走全空间数据 | `invite-service.ts:74`、`identity/routes.ts:445`、`settings-surface.tsx:1413` |
| 中 | 多张表按 workspace 而非 (workspace,user) 隔离但表内有 actor 列：`note_image_assets(created_by)`、`card_generation_runs_v2(user_id)`、`learning_target_snapshots_v2(user_id)`；`/uploads/*` 读与 `POST /v2/cards/:id/reveal` 未拦角色 → 多 owner 空间可互改对方内容 | `0039`、`upload/routes.ts:230`、`card-generation-v2/routes.ts:536` |
| 低 | 服务端无 `workspaceEpoch` 概念（只有硬编码 `1`）→ 无法做"某空间全端强制下线" | `capability-projection.ts:104-107` |
| 低 | 33 张表 RLS enabled 但未 FORCE（表属主 `ailearn_migrator` 有 `rolbypassrls`），与 `rls-policies-postgres.integration.ts:384-390` 自称的不变量不一致 | 同上 |

### 1.4 多人同时编辑同一篇笔记

**结论：有竞态，且是最容易静默丢失用户内容的一条。**

| 严重度 | 问题 | 证据 |
|---|---|---|
| **阻断** | **静默 last-write-wins，被覆盖内容在版本历史里找不回来**。OCC 检查存在，但自动保存走 `updateVersionInPlace` **原地 UPDATE 版本行且令牌不推进**（代码注释自陈），A、B 持同一令牌双双通过检查，`FOR UPDATE` 只保证串行不保证不覆盖。场景：A 补 500 字 autosave 写进 v3；B 改一句话用自己那份整篇覆盖 v3，A 的 500 字永久消失而 UI 显示"已提交" | `note/service.ts:821`、`:480-483`、`:978-1000` |
| 高 | **唯一防线是死的**：`sealed_at` 全仓只有读、建列、schema 声明，**生产代码无任何写入点** → `canUpdateVersionInPlace` 恒 true，0044 的两个不可变 trigger 永不触发 | 实测 grep：`service.ts:358,365` + `db-schema/note.ts:91-92` |
| 高 | **409 之后是死循环**：catch 里不 reload，`currentVersionId` 停在旧值 → 重试保存永久 409、卸载 flush 也 409、草稿必丢；且 409 只映射成一句通用文案，无对比无 merge | `notebook-surface.tsx:505-510`、`desktop-client.ts:87-88` |
| 高 | **同窗口双写者**：笔记库重命名用列表缓存的 `currentVersionId` 并创建新版本、推进令牌 → 正打开的编辑器下一次 autosave 必 409 | `note-library-surface.tsx:342-346` |
| 高 | **连带污染卡片**：`checkSourceOutdated` 只比版本 id 不比 content_hash，叠加原地改写 → 卡片引用的正文已被换掉而系统判定"来源未过期" | `card-generation-v2/helpers.ts:96-108` |
| 中 | 无本地草稿持久化（只有 `useState`，刷新即丢）；无 `requestSingleInstanceLock`，可开两实例互相原地覆盖；切空间时卸载 flush 被 `stale_workspace` 拒且静默丢弃 | `notebook-surface.tsx:294-296,542`、`src/main/index.ts:383` |
| 中 | `source/service.ts:472-497` 建笔记的 duplicate 检查是无锁读后插（无唯一约束）→ 并发同源导入可产两篇重复笔记 | 同上 |

已验证安全：搜索投影有 `onConflictDoUpdate` 目标键 + savepoint 隔离；`(note_id, version_no)` 唯一 + `23505`→409 兜底，不会重复/乱序版本号；activity 纯派生不落库；卡片生成有 advisory lock + 幂等二查 + outbox `onConflictDoNothing`。

完全无测试：两事务并发 `updateNote`、客户端 409 后的 resync 路径、库面重命名顶掉编辑器令牌、多实例、切空间丢草稿、routes 层 409/23505 的 HTTP 级映射。

### 1.5 用别人空间时的练习/复习数据归属

**准绳**（`PRODUCT.md:24`）：「Member 只读工作区数据，但可进行验证、复习和查看理解状态等**用户私有操作**」。

主链路是对的：`review_schedules` 是 (ws,user) 双键（`0040:246-247` 唯一索引），取队列带 `eq(reviewSchedules.userId, userId)`（`review/service.ts:156,181`），卡池来自共享 `learning_cards_v2`（只按空间）——**资料共享、进度私有**。`learning_runs` 家族 15 张伴生表、`learning_metric_events`、`understanding_projection_*`、`card_exposure_ledger_v2` 全部 (ws,user) 双键且 RLS ENABLE+FORCE。写入永远落"我"的行（`run-processing-tick.ts:1702-1712`）。看板/统计/活动全部按当前 session 空间，**不会污染自己主空间**。

| 严重度 | 问题 | 证据 |
|---|---|---|
| 高 | **两个"到期复习数"口径不一致**：`objectiveReviewDueCount` 只按 workspace 数（数进了别人的排程），同文件 `pendingReviewCount` 才带 userId | `stats/service.ts:93-97` vs `:160` |
| 高 | **Owner 导出全成员复习排程**（同 1.3），且该表 RLS 关闭无兜底 | `export/service.ts:174,431-440,459` |
| 中 | **今日日志把别人的行为当成"我今天做了什么"**：notes/sources/objectives 三段查询只按 workspace 过滤，而 `notes.createdBy` 是 NOT NULL 且可用；同文件 runs/generation/jobs 都按 user → 同屏自相矛盾 | `activity/service.ts:165-197` vs `:205,218,231` |
| 中 | `closePendingSchedules` 的 UPDATE 条件只有 workspace+subject+status → **会替同空间其他人取消复习排程** | `card-service.ts:1057-1071` |
| 中 | `card_candidate_feedback_v2` 只有 workspace 键、**无 user_id** → 卡片审核反馈无法追溯是谁给的 | `0138:529-544` |
| 中 | `onboarding_states`、`validation_assistance_exposures` 有 (ws,user) 键但被导出按 workspace 全量取走 | `0027:78,90`、`export/service.ts:180,459` |
| 中 | **无任何全局统计视图**：个人进度被空间硬切分，切走就看不到（这是"不污染主空间"的代价） | `stats/routes.ts:10`、`learning-dashboard/routes.ts:16`、`activity/routes.ts:33` |
| 中 | `companion_journeys` 活跃唯一键是**账号全局** → 第二个空间的新手旅程永久起不来 | `0124:65-67`：`ON companion_journeys (user_id) WHERE status IN ('active','paused','recoverable_error')` |
| 低 | `getStatsOverview(workspaceId, userId?)` 的 userId 是可选参数，任何未来调用方漏传即静默按空间聚合（当前唯一生产调用方有传） | `stats/service.ts:38` |

关于「私有」的实现真相：真私有三层——ADR-0009 个人空间（`0025:4-13` + `users.personal_workspace_id`）、教学沙箱（`0129`/`0130`）、`*_workspace_user_isolation` 策略族。`0120_learning_task_variants_private_hashes.sql` **与隐私无关**（只是把 hash 冗余到 variant 行绕开权限契约）；`0110` 只是性能索引。主链路仍按"当前 workspace"落库，**没有**把行为数据固定回个人空间或跨空间归并——个人空间只是登录默认位，不是隔离边界。

---

## 2. 横切的三个结构性风险

这三个不是单点 bug，而是让上面所有单点 bug 得以存在、并会持续再生的条件。

1. **兜底层全空**：DB 无外键（89/96）、无行级策略生效（19 张核心表）、测试不测行为。隔离 100% 依赖开发者手写 `WHERE workspace_id`。
2. **权限判据没有单一事实源**：capability 位、`permissions.canEdit`、`canManage`、`currentRole === 'owner'`、`requireOwner` 的 OR 语义——五套并行，彼此可以不一致且没有校验它们一致性的测试。
3. **产品承诺与数据模型脱节**：`PRODUCT.md:24/127` 承诺的只读模式，在 UI 上没有任何常驻表达、在数据上没有任何真实样本、在测试里没有任何行为断言。

---

## 3. 延展审查维度（第二轮）

### A. 空间的生命周期与"数据终局"（最该优先看，本次完全没审）

- **退出/被移除之后**：`left_at` 有了，下游清理链路很薄（已抓到念头调度不过滤它）。要审：退出后你在这个空间产生的复习排程、活动、念头、投递、审计记录归谁？还看得见吗？再进来时算谁的？
- **owner 退出自己拥有的协作空间**：有没有拦？若没拦，空间变成无主孤儿，`requireOwner` 的 OR 语义会让所有 member 同时"非 owner"，**整个空间锁死**。
- **所有权转让**：identity 模块里未见任何 transfer 路径。没有它，"owner 离职/换号"就没有出口。
- **删除空间**：级联只到 `workspace_members`（`0000` 那条 FK 有 `ON DELETE cascade`），其余 89 张表靠什么？
- **空间的回收站语义**：笔记有 `deleted_at` + 30 天物理清除，空间有没有对应的软删除/可恢复？

### B. 缺一张「归属矩阵」——多个单点问题的同一个根

`user_companion_account_state`（含 `agent_settings`、`permission_level`、quiet hours、时区）**没有 workspace 列**，是账号级；而 `companion_room_profiles`、日记、记忆、作答模态偏好是 (ws,user)。也就是说：**换空间后，伴星的"性格设定"跟着你走，但她的"记忆和关系"重置。** 这不是 bug，是一个没人明说的设计。

建议一次性列清：每一项数据/偏好 → 账号级 / 空间级 / 空间内私有 → 谁可写 → 换空间是否保留 → 退出是否销毁。有了它，A、C、D、F 四片问题都能推演，不必逐个抓。

### C. 伴星作为"连续个体"的承诺 vs 按空间劈开的实现

`PRODUCT.md:52` 写的是"全应用内**持续存在的单一身份** Companion"，数据模型却是 (ws,user) 隔离。用户视角的裂缝很具体：在 A 空间说过的事，切到 B 空间她完全不记得；日记在一个空间有、另一个永远空白；活跃旅程全局只能有一个。**这是产品承诺问题，需要裁决而非修复。**

### D. 只读成员的"静默劣化"面

上一轮抓的是"点了报错"，另一类是**没人报错但功能悄悄坏掉**：

- `search/reindex` 与 `search/auto-fix` 是 owner-only（`search/routes.ts:53,62`）→ **member 看到的搜索索引永远不更新**，无任何提示。
- 同类待审：向量重建、卡片生成、笔记投影重算、记忆维护——凡是"运维型写"被 `requireOwner` 挡住的，在共享空间里都会退化成"只有 owner 的空间是新鲜的"。
- 反方向：member 能入队 job 消耗 provider 预算（已确认无闸门）→ **成本归属**是空间还是人？谁为只读成员触发的 AI 调用付钱？

### E. 会话、多设备与"epoch 只活在客户端"

服务端 `workspaceEpoch` 是硬编码 `1`，比较只在客户端。含义：**服务端没有"某空间即时全端失效"的能力**。目前靠"被移出就删 session"兜住，但"改 AI 外发政策""改空间名""撤销某台设备"无法即时生效。

- 一台设备一个当前 token → **同一账号不能在两个设备上同时待在不同空间**（一个登录挤掉另一个），这是有意的吗？
- 磁盘侧残留：导出的 JSON、下载的图片、`runtime-asset-containment` 那类资源目录，是否按空间分键？切空间后旧空间文件还在本机可读吗？

### F. 合规与法律（共享空间最尖锐、最易忽略）

`notes` 有 `created_by` 但**没有"内容归属"概念**——A 在 B 的空间写的笔记，A 删号后归谁？删除权与可携带权在共享空间天然冲突：B 要保留资料，A 要删干净。现有删除链路是按空间还是按人组织的？导出这条路径同时承载"可携带权义务"和"owner 拿走全成员数据"的风险，**需要拆开设计**。

### G. 流程性防线：怎么防止下一张表又漏掉隔离

性价比最高的一件事。现状：新增一张表，只要开发者记得写 `where workspace_id` 就没事，没有任何机制拦住忘了写的情况——`0014_n007_workspace_fk_completion.sql` 这个文件名本身就证明历史上漏过一次。可建的方向：

- CI 真跑一次双空间跨读断言（而不是 `content.includes`）；
- 新表强制清单：workspace_id 加 FK、RLS enable+force、GRANT、一条 member→403 用例；
- 把 `0027` 那份"expansion mode"变成有明确退出条件的待办，而不是长期态。

  > **2026-09-20 实施期更正**：本报告初稿把 CI 的 `REQUIRE_RLS_DISABLED=true` 说成"把临时状态制度化"，这是误读。`infra/postgres/roles.sql:1275-1305` 的注释写明该变量语义在 2026-08-11 已改：它**不要求 RLS 关闭**，而是"**凡是启用了 RLS 的表都必须至少有一条策略**"的 fail-closed 检查（原语义会在 0111 给六张表启用 RLS 后必然 RAISE，把部署挂死）。所以这条检查是有效的防线，不该改成白名单；真正处于关闭态的是 `0027` 本身，需要的是带退出条件的待办。

### H. 极端态与空态

只有一个空间（实测：菜单里就一行"已选择"+ 一个 disabled 的加入框）、零空间（`workspace_required` gate）、被移出最后一个空间、个人空间被误加入、空间名超长/重名、成员数上限。不难，但需要逐个人工点一遍。

### I. 术语与心智一致性

代码与 UI 里「学习空间 / 空间 / 房间 / 书房 / room / workspace」混用：`room-control`、"返回理解书房"、"房间控制"、"学习空间菜单"。用户很难判断"房间"和"空间"是不是同一个东西。

---

## 4. 第三轮发散：从"隔离对不对"转向"这个功能成不成立"

前三节问的都是"边界守住了没有"。这一轮问的是另外几类问题。

### 4.1 能力缺口：空间是"一次性容器"

- **无搬运能力**：笔记能否从一个空间移到另一个？卡片/复习进度能否带走？两个空间能否合并？导出后 import 到另一空间会不会丢 `created_by` 归属？**只要没有搬运，空间就是不可逆的决定，用户会因此不敢建空间，或者建一堆垃圾空间。**
- **无临时授权 / 建议模式**：现在只有 owner(全权) / member(全不能写) 两档。协作产品常见的第三档是 **read + suggest**：member 提交修改请求，owner 批准。项目里**已经有现成的 proposal 机制**（伴星动作提案），复用它能同时解决"只读成员只能干看"和"重命名点了才报错"两类问题。
- **实时协同要不要做，需要一次性决定**：上一轮抓到 last-write-wins。真要协作需要 CRDT/Yjs（项目已用 Milkdown，有 yjs 插件）。**可以决定不做，但不能两边都不做**——现在的代码既没有 CRDT，也没有可用的冲突提示。

### 4.2 语义与心智：「当前空间」是全局单例，但 UI 说的是"我"

整个 app 只有一个当前空间，没有跨空间视图。由此产生一类必然的用户投诉：

> "今天明明只学了 10 分钟，统计说 2 小时。"（其实是整个空间的）

任何"我的总览"——今日、统计、看板、伴星日记——在语义上都是"**当前空间的**总览"，但文案用的是"我"。配合已确认的 today-log 按 workspace 过滤，这不是 bug 触发才会出现，是**默认就会误导**。需要审的是：每一个"我"字样的数字，背后到底是哪个口径。

相关的时间维度：空间是分时使用的（早上个人空间、晚上班级空间）。跨空间的时间轴（今日日志、连续学习、活动流）如何合并？"我在 A 空间的 10 分钟"和"B 空间的 10 分钟"可比吗？现在的答案是"不可比且没有合并视图"。

### 4.3 信任与内容可信度

共享空间的笔记/卡片**不显示作者**。member 读到 owner 生成的卡片，不知道是谁生成的、该不该信。项目里已有 effective Trust Class 的概念，但**空间维度的信任是空白**。同时"空间"这个隐喻本身也不一致：UI 里同时存在「学习空间 / 房间 / 书房 / 星图 / 旅程 / 沙箱」，多空间到底是"多个书房"还是"多个房间"？隐喻冲突会直接决定 C 类 bug 会不会反复出现。

### 4.4 规模：现在的 UI 是按"1-2 个空间"设计的

dev 库实测 855 空间 / 856 用户（一人一空间）。真实协作后一个用户可能有 5-20 个空间，而**当前空间切换器是一个扁平弹层列表**（实测），没有搜索、分组、收藏、最近使用；`listUserWorkspaces` 全量返回。**这个组件在 20 个空间下会直接失效。**

同类规模问题：主动触达（proactive hook、念头、delivery）按 (ws,user) 各自产生，用户在一个屏幕上会收到来自多个空间的"她想跟你说话"。现在只有账号级 `global_enabled` + quiet hours，**没有"哪个空间可以打扰我"这一层**。

### 4.5 治理：AI 同意的授权链断裂（本次发散里我认为最尖锐的一条）

`PRODUCT.md:50`：AI 使用同意与数据外发政策是**工作区级、由 Owner 签署**。

推论：**我加入你的空间，等于被你的同意决定了我的数据会被外发到哪个模型、哪个政策下。** 授权链在"加入"这一步断裂——签署人不是我，被影响的人是我。需要审：加入时是否明示"此空间已开启外发"？是否可拒绝（加入即视为同意，还是必须单独签）？只读成员能不能看到自己正被外发？这在合规上比导出更根本，因为它影响的是**每一次 AI 调用**而不是一个导出动作。

### 4.6 运维与可观测

- 日志/trace/metrics 是否都带 workspace 维度？如果一个用户投诉"数据串了"，运维有没有工具能按空间查清"谁在哪个空间做了什么"？
- `ai_audit_log`、`companion_audit` 的 workspace 维度与 RLS 状态需专项核实；导出/删除这类高危动作**是否留痕**（导出目前是一个 owner-only 的 GET，未见审计写入）。
- 无归属键且无策略的 3 张表待核实：`auth_rate_limits`、`interaction_qualifications`、`companion_memory_maintenance_runs`——限流键到底落在什么维度？会不会出现**一个空间的流量掐断另一个空间**（noisy neighbor）？
- 测试夹具污染：dev 库实测有 `mem-http-*` 夹具把第二个用户写成 `role='owner'` 塞进他人**个人空间**，且无 invite 记录（绕过全部业务校验）。这类夹具会让"看起来像 bug 的现象"和"真实产品行为"无法区分，也让 `left_at`/`role` 约束的缺失被掩盖。需要审：测试是否直接写生产形态的库、夹具是否走真实 API。
- 离线/弱网：桌面端有本机缓存与凭据，多空间时离线可用的是哪个空间的数据？切空间时缓存如何换入换出？

### 4.7 战略层：先确认这个问题现在是否存在

最后一个、也是最该先回答的发散问题：

> **855 个空间对应 856 个用户，`member` 角色 0 条，没有任何用户属于 2 个以上空间。**

也就是说，**共享学习空间这个功能事实上从未被使用过一次**。本报告里所有隔离与权限问题的当前实际发生概率都是 0。

这既是好消息也是陷阱：好消息是没有存量用户会被伤害；陷阱是**在这种状态下继续"修隔离洞"，修的是想象中的场景**——上一轮已经出现证据：日记调度 `LIMIT 1`、念头调度漏 `left_at`、导出无 user 过滤，这三个 bug 无论怎么测都测不出来，因为没有任何测试数据里有第二个成员。

因此更合理的顺序可能是：**先造出那个真实场景**（两个账号、一个协作空间、一次真实切换、一次真实并发编辑、一次真实复习），让问题从"代码里推出来"变成"屏幕上看得见"，再决定哪些洞值得现在堵。

---

## 5. 建议处理顺序

| 阶段 | 事项 | 理由 | 严重度 |
|---|---|---|---|
| 0 | 搭出真实协作场景：2 账号 + 1 协作空间 + member 角色数据，跑通切换/并发/复习/导出 | 后续每一项都需要它来验收；当前所有只读链路 0 真实覆盖 | — |
| 1 | 笔记 autosave：原地更新也推进令牌；409 后强制 reload 并保留草稿做并排提示；`sealed_at` 补真实写入点或整条删除 | 唯一会静默销毁用户内容且不可恢复的路径 | 阻断 |
| 2 | 导出按 user 收口（或明确"导出=全空间含成员私有"并要求二次确认）；`review_schedules` 恢复 RLS | 隐私外泄，且 owner 一键即可触发 | 阻断 |
| 3 | 隔离测试从"字符串包含"改成真 Postgres 双空间 + member→403 行为断言；建 G 节的新表 CI gate | 一次覆盖未来所有新增表；是重开 RLS 的前置条件 | 阻断 |
| 4 | 空间名 + 角色 + 只读态提升为 HUD 常驻槽位（兑现 `PRODUCT.md:127`）；切换给可发现回执；修 `spaceNotice` 键名 | 合同违约，且是用户最容易感知的缺陷 | 高 |
| 5 | 写入类 IPC 强制带 epoch（`assertEpoch` 改 fail-closed，复用 `requireWorkspaceEpoch`） | 唯一会造成"数据落错空间"的客户端路径 | 高 |
| 6 | 日记调度按每个未退出空间入队；念头调度补 `left_at IS NULL` | 已确认的功能性错误 | 高 |
| 7 | 补 `card_generation.retry` 放行；重命名补 capability 判据；禁用态统一给原因 | 全员 bug + 点了才报错 | 高 |
| 8 | 统一 stats 到期口径与 today-log 的 `created_by` 过滤；`closePendingSchedules` 补 user；`card_candidate_feedback_v2` 补 user_id | 数字口径混乱与跨用户写 | 中 |
| 9 | 五套只读判据收敛成单一事实源（`requireOwner` OR / 能力投影 / 笔记投影 / `canManage` / `currentRole`） | 防止不一致再生 | 中 |
| 10 | 裁决：伴星跨空间连续性、AI 同意的授权链、journey 全局唯一、实时协同做不做、只读成员是否给 suggest 档 | 产品决定，不是代码决定 | 中 |
| 11 | 空间切换器的多空间规模设计（搜索/分组/最近使用）、跨空间汇总视图、空间级打扰开关、术语统一 | 在真实协作发生前完成即可 | 低 |

---

## 附录 A：审查方法

1. **6 路并行代码审计**：切换感知、只读 UI 管控、服务端越权、伴星跨空间、笔记并发、行为数据归属。
2. **实测运行中的客户端**：通过 CDP（`:9222`）连上 dev Electron 实例，遍历 DOM 与 computed style 确认"屏幕上到底画了什么"，并截图核对。所有"标识不常驻"的结论来自这一步，不是从样式表推断。
3. **实测数据库**：连 dev Postgres 查 `pg_class.relrowsecurity`、`pg_policies`、`pg_constraint`、`workspace_members` 真实分布、表归属键分布。
4. **实跑测试**：`permission-guard` + `sec01-cross-workspace-isolation` + `adr0009-workspace-management` 共 141 用例全绿——并逐个读了断言实现，确认其为源码字符串匹配。

## 附录 B：本文中标记为"一手验证"的事实

以下均由本次直接读取代码/SQL/运行时确认，非转述：

- `assertEpoch` 的 `!== undefined` fail-open（`desktop-ipc.ts:812-815`）与 `createRequestMeta()` 无参即不带 epoch（`desktop-client.ts:25`）
- `SourceIntake.tsx:204,380`、`note-image-uploads.tsx:169` 三处写入不带 epoch；网关单 token（`desktop-gateway.ts:607`）
- 笔记 OCC 检查存在（`note/service.ts:821`）+ 原地更新不推进令牌（`:480-483`、`:978-1000` 注释自陈）
- `sealed_at` 生产代码零写入点（全仓 grep 仅读 + schema 声明）
- `card_generation.retry` 全仓 3 处引用，服务端 owner 清单漏放（`capability-projection.ts:83`）
- `export/service.ts:431-440` 的 `review_schedules` dump 无 user 过滤；`:498-509` 含成员邮箱
- `stats/service.ts:93-97` 与 `:160` 口径不一致
- `activity/service.ts:165-197` 无 `created_by` 过滤，而 `notes.createdBy` NOT NULL 可用（`db-schema/note.ts:16`）
- `0198:37-43` 的 `ORDER BY joined_at ASC LIMIT 1`；`0227:99-101` 全文无 `left_at`；`0124:65-67` 的 `user_id` 全局唯一活跃索引
- RLS 实测 86/105 开启、19 张关闭清单、`workspace_id` 有列 96 张仅 7 张有 FK、归属键分布 60/36/4/5
- dev 库 856 条成员全为 `owner`、0 条 `member`、0 个用户跨 2+ 空间、3 条 `mem-http-*` 夹具把非 owner 写成 owner
- `workspace_members.role` 无 CHECK 约束（实测 `pg_constraint` 仅 2 条 FK）
- 运行时 DOM：全页仅 1 个含"空间"的节点且 `opacity:0`+`inert`；空间菜单内显示"当前 · Personal"；「只读查看」实为编辑器版本预览按钮（`.ribbon-action`）
- 141 个权限/隔离测试全绿，且断言实现为 `content.includes(...)`

## 附录 C：待核实清单（本次未展开）

- `auth_rate_limits` / `interaction_qualifications` / `companion_memory_maintenance_runs` 的实际限流与归属维度
- 导出、删除等高危动作是否有审计留痕
- 磁盘侧（导出文件、图片缓存、资源目录）是否按空间分键
- 空间删除/成员删除时 89 张无 FK 表的孤儿数据处理路径
- owner 退出自己空间、所有权转让是否有任何拦截或出口
- 新表加入 workspace 列时的既有流程约定（除人工记忆外是否有文档/脚本）

## 附录 D：实施期新增发现（2026-09-20 批次 0）

写双角色行为测试时顺带挖出一个本报告初稿漏掉的仓库级缺陷：

**`meta/_journal.json` 在 HEAD 上只登记到 `0231`，而 `0232`/`0233`/`0234` 三个 `.sql` 文件都在。** `apps/api/src/db/migrate.ts:34-53` 的 `readMigrationFilesLocal` 以 journal entries 为**唯一清单来源**（`journal.entries.map(...)` 再 `readFileSync(<tag>.sql)`），未登记的文件连被打开的机会都没有——迁移器报 "all applied"，实际 `0234` 要加的 `hints` 列根本不存在。后果：`GET /export/workspace` 对**任何**工作区都返回 500（drizzle schema 声明了 `hints`，全列 `select()` 时报 `column "hints" does not exist`），以及卡片提示特性静默缺失。已补登记并应用。

这条恰好印证第 2 节的判断：没有任何一层在强制结构性不变量。为此新增：

- `apps/api/src/__tests__/migration-journal-coverage.test.ts`：断言 `migrations/*.sql` 与 journal 条目双向一一对应、idx 连续、tag 不重复、执行顺序与文件名数字前缀一致。**它正好会在上述仓库状态下变红。**
- `apps/api/src/integration-tests/workspace-collab-postgres.integration.ts`：走真实 invite 流程产出 member 的守卫矩阵（20 条 owner-only 路由 × member 403 + 匿名 401，6 条用户级路由不得 403）。已验证敏感性：分别摘掉 `POST /notes` 与 `POST /invites` 的 `requireOwner`，矩阵均变红——而旧的 `permission-guard.test.ts` 正则计数对后者**不会**变红，因为 `requireOwner` 在同一文件里还出现十几次。
- `apps/api/src/integration-tests/schema-isolation-gate-postgres.integration.ts`：空间隔离 schema 棘轮，把"89 张带 `workspace_id` 却无外键 / 14 张未启用 RLS"如实登记为基线并要求完全相等，新增违规必红、修好必删基线。已用探针表验证有效。
- 删除 `permission-guard.test.ts` 中 4 组、`sec01-cross-workspace-isolation.test.ts` 中 3 组字符串断言（其中一组按 `.findMany(` 计数，而导出服务根本不用 findMany，条件恒成立）。净减 49 个"永远绿"用例。
- 更正：本报告与初版计划曾把 CI 的 `REQUIRE_RLS_DISABLED=true` 判为"把临时状态制度化"，属误读，见第 3 节 G 段的更正说明。

### 追加（同日批次 1.5）：协作空间根本无法被创建

搭双账号场景时发现的一条比本报告其余问题更基础的事实：

- 生产代码里**没有任何创建工作区的入口**（`createWorkspace` 零命中）。`workspaces` 行只在注册时以 `workspaceType: "personal"` 建出（`invite-service.ts:335-341`）与 `0028` 回填。
- dev 库实测：`workspace_type` 分布 = **personal 856、collaborative 0**。
- `workspaceType` 不是空间自身的属性，而是**按查看者派生**的：`identity/routes.ts:255`、`service.ts:161,526` 都写 `isPersonal ? "personal" : "collaborative"`，而 `isPersonal = ownerId === 查看者`。`routes.ts:252-254` 的注释甚至明说"别人加入我的个人空间后，对我投影成 collaborative"。

后果：所谓"共享学习空间"，实际是**把别人拉进自己的个人空间**。因此——

- 第 1.3 节讨论的"member 只读"全部建立在个人空间被共享这一异常状态上；
- 任何以 `workspace_type` 为依据的权限或协同判据都不成立（类型会随查看者变）；
- `PRODUCT.md:22-24` 写的"工作区支持两种模式"只有一种是真实存在的。

已修：新增 `POST /workspaces` 创建 `collaborative` 空间；`workspaceType` 改读 `workspaces.workspace_type` 列；`createInvite` 拒绝 `personal` 目标（409 `personal_workspace_not_shareable`）——在有了创建入口之后，这道校验不再等于删掉唯一共享路径。客户端补 `workspace.create` 通道与空间菜单里的「新建」入口，创建即进入（因为 `POST /invites` 认的是当前 session 所在空间，不进去就永远邀请不了人）。

### 追加：另两处自我更正

- 初稿称 `settings-surface.tsx:574` 的切换提示会因同 tick 卸载而消失——**错**。该文件 566-573 的注释写明设置页切换时会自己重开、并不卸载，提示本来就看得见。缺回执的只有房间控制药丸那条路径。
- 初稿建议"把 CI 的 `REQUIRE_RLS_DISABLED` 改成按表白名单"——**错**，见上文 G 段更正。



---

## 附录 E — 落地后的复核（2026-09-21 凌晨）

审查之后的三条结构性补充，都是实施期才发现的，不在本报告前文：

1. **`0027` 的关 RLS 是无条件批量关**。它按名单循环 `NO FORCE` + `DISABLE`，后续任何迁移给这些表
   加的 `ENABLE` 都会在按顺序重放时被它抹掉。CI 的 `REQUIRE_RLS_DISABLED` 只检查"启用了 RLS 的
   表必须有 policy"，对"该启用的没启用"完全无感——所以这不是漏检，是**方向相反的检查**。
   真正执法的是 `schema-isolation-gate-postgres.integration.ts` 的棘轮基线，它会把"悄悄关回去"
   变成红。
2. **`review_schedules` 的 `actor_guard` 与"系统级到期行"互斥**。策略是 RESTRICTIVE 的
   `user_id = app.user_id`，`user_id IS NULL` 的行在 RLS 下对所有人不可见。所以到期投影必须
   按人展开成行；否则生产静默消失，而 dev 因为连的是 `ailearn`（superuser + BYPASSRLS）永远
   测不出来。验证只能用 `SET LOCAL ROLE ailearn_api`，并且要带一条**正向对照**（自己的行读得到
   =1），否则"读到 0"分不清是被策略挡住还是策略根本不存在——0027 的批量 DISABLE 能同时骗过
   两条负向断言。
3. **改已应用的迁移文件 = 让它在已应用库上重跑**。`migrate.ts` 以 `sha256(文件内容)` 判断是否
   应用过。所以修 `0198`/`0227` 里调度函数只能写新的前向迁移，不能就地改。

### 界面验收（真实窗口，1440×810，CDP 实量）

顶栏常驻空间胶囊：折叠态（`.room-control` 无 `data-expanded`）下 rect `1022,28 103×36`、
`opacity:1`、`pointer-events:auto`、文案 `Personal Beta / 个人空间 · 所有者`，同时相邻槽位
`opacity:0`（证明确实在折叠态）。点它 → `data-expanded=true`、空间菜单打开、
`aria-expanded=true`、菜单行文案 `当前 · 个人空间 · 所有者`（角色口径已与顶栏同源）。

这条**单测抓不出来**：jsdom 不加载样式表，级联赢没赢只有真实渲染知道。第一版把豁免写成
"在后面补一条更高优先级的声明"，被文件后半段 `@media` 里的同名折叠规则赢回去，实量
`opacity:0`。正确做法是把胶囊从折叠选择器里排除（`:not(.room-control-trigger):not(.room-control-space)`，
15 处），而不是叠加覆盖。

### 事故记录（问责在我）

修 `companion-agent-registry.ts` 里 4 条 `tool()` 描述的内层引号未转义（那 4 行是别人未提交的
工作，HEAD 里没有这个文件）时，我用脚本批量处理，对"字符串分隔引号"和"内容引号"的判断错误，
把 27 行的引号位置弄乱、1 行描述内容丢失，并且一度 `git checkout HEAD -- ` 该文件——那会把旧版
放回工作区，让下游 `companion-agent-skills.ts` 报出 14 个"字段不存在"的假错。文件最终由 owner
自己修好；被弄坏前的快照与 96-99 行原文留在仓库外
`../.batch0-backup-20260921/companion-agent-registry*.txt|ts` 供对照。
教训：**别人未提交的文件没有第二份副本，任何批量文本处理都等于在没有备份的情况下改数据**；
纯标点也不能免俗。

### 实测到的跨空间混淆（回答原始问题 1 的那一类，已修）

`companion-here-and-now.ts` 里算"多久没理我了"的那条 SQL 只按 `user_id` 过滤、不带
`workspace_id`。同一个用户、同一时刻，在开发库上 Rolled-back 夹具里量出来：

| 写法 | 她拿到的 gap |
|---|---|
| 只按人（原样） | **5 分钟** |
| 本空间内（修复后） | **41756 分钟 ≈ 29 天** |

也就是说：用户在这个空间快一个月没跟她说话，界面却会说"你刚才不是还说过话"——那句话是
**另一个空间**的发言喂出来的。这正是审查开头问题 1 问的"数据混淆"，之前只能靠读代码判断，
现在有数了。

调度器同批修掉的另一条：`ailearn_enqueue_companion_daily_summaries`（`0198` 里的）在判断
"昨天有没有动静"之前先 `ORDER BY wm.joined_at ASC LIMIT 1` 代替用户挑了一个空间。造 3 个空间
（1 个已退出、2 个在用）实测：旧写法命中 **1** 个空间、新写法命中 **2** 个 (user, space) 对。
所以加入 3 个空间的人，每日小结永远只围绕最早加入的那一个。
