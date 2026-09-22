# 全项目逻辑闭环审计（2026-09-22）

> 署名：Asklins
>
> 这份文档只回答一个问题：**产品承诺的闭环，在代码里哪几处是断的**。
> 它不看视觉、不看性能、不看测试覆盖率。
> **本轮不动手实施**：所有条目只登记现象、证据与核实状态，修复方向只写一行，等拍板。
>
> 前作是 `docs/plans/learning-companion/26-systemwide-behavior-audit-and-fix-plan.md`（2026-08-25，32 条）。
> 那份的一个月里被后续工作吃掉不少，本轮逐条重验过其中几条，结论写在 §10。
>
> **并档说明**：L37–L40 来自并行会话（`docs/plans/learning-companion/32-workspace-dissolve-design-2026-09-22.md`，
> 空间生命周期/解散设计）本轮顺手交来的量测。**它们的所有数字我自己重跑过**（§10 记了两处与我原本写法不同的结果）。
> 解散的设计本身不在本文，只在这里登记"该归闭环审计"的部分，编号指回 doc 32。

## 0. 一句话结论

产品把自己定义成一条可追溯闭环（`PRODUCT.md:28`「材料 → 笔记 → 学习卡 → 证据对齐 → 验证 → 复习」、
Product Principle #1「任何功能设计不得断裂闭环」）。**这条链在四个方向上都是断的**：
删掉一篇笔记，它的卡还在队列里、而它永远删不掉（L16/L17）；答完一次验证，"还缺什么"从来不喂下一次
（L18）；证据引用指向一个不存在的对象、预览不复算哈希、删除也撤不掉证据（L21）。
比断链更贵的是**只有生产会坏的那一类，而且它的根只有一条**：dev 的 API 跑在 BYPASSRLS 角色上（L37），
于是笔记协同的握手（L2）、AI 外发审计读数恒空（L3）、30 天笔记清除从未清过东西（L37 症状 A）
这一整类缺陷在本地全绿——**开发库绕过 RLS，所以"dev 跑过了"这句话在这几条上一律不是证据**（§1.2）。
第三条主线是**装了门只看半条路**：空间级静音只挡念头（L10）、到点提醒不看任何账号开关（L11）、
那份"正式作答不许打扰"的策略函数全仓没有调用方（L12），AI 同意与外发政策则完全不覆盖语音（L13）
——用户能亲眼看见自己关掉了的东西还在动。

## 1. 怎么查的

- **拆分**：按 8 个互不重叠的域各派一路只读审计——身份与租户、学习闭环、伴星、数据层与迁移、桌面与
  IPC、语音、卡生成与 worker、文档/配置/CI。每路只许用 `Read`/`Grep`/`Glob`，禁改文件。
- **为什么禁跑**：这个工作树里有**并发会话的 251 个未提交文件**和一台共享的 dev Postgres。跑测试、
  跑 `apps/desktop-client/scripts/*`、跑迁移，都会污染别人或制造坏的中间态。所以**本轮没有一次真实
  运行**，所有结论都是静态取证；需要量才能定的条目一律标在 §9「要量才知道」。
- **判据（每路都给了同一张清单）**：① 一条边有写入方没读取方，或有读取方没写入方；② 状态进得去出不来，
  或压根进不去；③ 同一个用户可见事实有两个来源；④ 门只装在其中一条路径上；⑤ 合同声明在一侧、执行在
  另一侧。这套判据照出的第一个真缺陷是本项目自己抓过的 `boundaries.allowVoiceTags`（写了没人读），
  本轮就是在系统地找它的同类。
- **我对 agent 报告的处置**：**每条高危项我自己重跑了一遍取证**，重验不过的写进更正（§10），
  没重验的显式标【未核】。agent 报的数字我只在自己数过的范围内引用。

### 1.1 核实口径（全文标签）

| 标签 | 含义 |
|---|---|
| 【核过】 | 我在当前工作树里自己跑过 grep/读过代码，能复现该事实 |
| 【未核】 | 子审计报的，引用位置看起来成立，但我没有重跑；**引用它做决定前先复算** |
| 【推断】 | 缺失的那一半我核过，用户可见后果是从代码路径推的，没在真窗口量过 |

### 1.2 两条比任何单条发现都要紧的判据（并入本口径）

**① dev 绿不构成证据。** `docker-compose.dev.yml:10` 把 `DATABASE_URL_API` 指向
`postgres://ailearn@postgres:5432/ailearn`，而 `pg_roles` 实测（我跑的）：
`ailearn super=true bypass=true`、`ailearn_api super=false bypass=false`、`ailearn_worker super=false bypass=false`。
**同文件 `:13` 的 worker 早就换成受限角色了，API 没换。** 于是凡依赖 RLS 的行为，本地一律看不到真相（L37）。
验收口径必须是**显式以 `ailearn_api` 连**：`docker exec ailearn-dev-postgres-1 psql -U ailearn_api -d ailearn`
（socket 免密）；跑集测则把 `DATABASE_URL_API` 换成该角色 + `127.0.0.1`（宿主没有 `psql`、macOS 没有 `timeout`）。

**② 裸 `db` 读一张 FORCE 过的表，判"有没有事"只能逐表读 `pg_policy`，不能推。**
我自己在当前库上读了 RESTRICTIVE 守卫（`polpermissive=false`）的原文：

| 表 | 租户守卫 | 没设上下文时 |
|---|---|---|
| `notes` | `workspace_id = NULLIF(current_setting('app.workspace_id',true),'')::uuid` | **恒 0 行** |
| `workspaces` | `(NULLIF(...) IS NULL) OR (id = NULLIF(...)::uuid)` | 有 NULL 放行支，**照常工作**（实测 `ailearn_api` 裸查 = 1027 行） |

所以 `identity/routes.ts:243` 那句裸读 `workspaces` 是对的，而 `collaboration.ts:97` 那句裸读 `notes` 是死的。
`apps/api/src/modules` 里非测试的裸 `db` 用法约 21 处（这个数是并行会话报的，**我没逐条核**）——
把它们逐条判成"有事/无事"是本轮最大的一块未完成的活。

## 2. 真断链：按了没反应，或者只有生产会坏

### L1 笔记库改名整条是死的 【核过】

- **证据**：契约 `packages/shared/src/desktop-ipc-contracts.ts:337`、preload
  `src/preload/index.ts:271`、渲染层调用 `surfaces/note-library-surface.tsx:360`、主进程实现
  `src/main/desktop-gateway.ts:4015` — 四样齐备；`grep noteDocSyncTitle` 在 `src/main/desktop-ipc.ts`
  **零命中**，也就是没有 `installHandler`。`ipcRenderer.invoke` 直接 reject「No handler registered」。
- **为什么它没被发现**：唯一的"调用方"是 `note-library-surface.test.tsx:117` 的 `vi.fn()` 替身。
  和这个项目已经栽过一次的同款：**假 mock 盖住真断链**。
- **方向**：补注册；测试改成断言"渠道有 handler"而不是替身。

### L2 笔记实时协同在生产数据库角色下连不上 【核过】

- **证据**：`apps/api/src/modules/note/collaboration.ts:97` 握手用裸 `db.query.notes.findFirst`；
  `0257_sec01_rls_reopen_core_tables.sql:219-220` 对 `notes` 做了 `ENABLE + FORCE ROW LEVEL SECURITY`；
  它的 RESTRICTIVE 租户守卫是 `workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid`
  （`0039_sec01_policy_catalog_repair.sql:144`），**没有 NULL 放行分支**（0257 只给 `workspaces` /
  `workspace_members` 补了那条分支，并且自己的注释写明了理由）；`infra/postgres/roles.sql` 无 role 级
  GUC 默认值。`ailearn_api` 下该条件恒为 NULL → 0 行 → 抛 `note_not_found`。
- **为什么 dev 看不出来**：开发库与集测连的是绕过 RLS 的角色（`0258` 的注释自己承认过同一件事）。
  `withWorkspaceTransaction` 才是设 GUC 的唯一入口，而握手在它外面。
- **方向**：握手那次读挪进带上下文的事务，或给这张表的守卫补一条与 0257 同形态的 actor 分支。
  **根因与复现方法在 L37**（dev 的 API 角色绕过 RLS，所以本地看不见这条）。

### L3 同一条根因的第二处症状：AI 外发审计恒空 【核过】

- `identity/service.ts:1262+` 的 `listAIAuditLog` 同样是裸 `db` 查已 FORCE 的 `ai_audit_log`
  （0257:254-255），rows 与 count 两次查询都恒 0。
- 设置页写的是"每次外发都留下可追溯的记录，供你回看"（`settings-surface.tsx:214`）。
  桌面端连一个读它的调用点都没有（`grep ai-audit-log` 在 `apps/desktop-client`、`packages/shared`
  零命中，只有一条只断状态码的集测）。
- **这条与 L2 是同一颗雷的两个引信**，该一起修，别分两批。

### L37 【根因，B 批】dev 的 API 跑在 BYPASSRLS 角色上：L2/L3 这一整类"只在生产炸"的缺陷，本地永远绿 【核过（含我自己重跑的数）】

- **根因**：见 §1.2 ①——`docker-compose.dev.yml:10` 用 `ailearn`（`rolsuper=t, rolbypassrls=t`），
  CI 与生产形状用 `ailearn_api`（`NOBYPASSRLS`）。worker 在 `:13` 已是受限角色，**只有 API 没换**。
- **症状 A：30 天笔记物理清除从未清过任何东西**（受限角色下）。
  `note/maintenance.ts:34-41` 的**外层候选扫描**用的是裸 `db`（我读过，确认在
  `withWorkspaceTransaction` 外面），而 `notes` 的守卫没有 NULL 分支 → 以 `ailearn_api` 跑恒 0 行。
  我自己在当前库上以 `ailearn_api` 跑那句 `deleted_at is not null and deleted_at < now()-interval '30 days'`
  = **0 行**；同一句以 `ailearn` 跑也是 0 行，但**原因是另一个**：全库 `notes` 879 行、软删 10 行、
  最早一条 `deleted_at = 2026-09-16`，第一篇越过保留期是 **2026-10-16**。
  → 所以**今天无实害**；10-16 之后，"用户以为 30 天会清、实际在受限角色下永远不清"才成立。
  CLI 那份更糟：`apps/api/src/scripts/cleanup-soft-deleted-notes.ts:74` 裸扫描、`:118` 又是裸
  `db.transaction`，**上下两半都瞎**；而 `maintenance.ts:20-25` 那段自称"RLS 修复"的注释只修了内层
  `physicalDeleteNote`，外层从没修过。**这条也修正了本文 L17 的报法**（见下）。
- **症状 B：实时协同在受限角色下连不上**（并行会话 A/B 对跑，**我没有重跑**——跑它会往共享 dev 库写数据）：
  同一份 `apps/api/src/integration-tests/note-collaboration-postgres.integration.ts`，只换连库角色，
  `ailearn` = 16 tests 全过；`ailearn_api` = 17 tests、4 过 13 红，日志 17 次 `note_not_found`。
  红的全是"该接受/该落库"那一半（`collaboration.ts:97` 裸读 → `undefined` → `:103` 抛错），
  过的 4 条恰好全是"该被拒"的用例（无凭据、token 无效、陌生空间、非法增量）。
  两轮 tests 计数差 1（17 vs 16）他们也没逐字追。
  **这条最可怕的地方**：拒绝类断言在"什么都读不到"时照样绿，所以这套测试看起来永远健康。
- `gh run list --limit 6` 我跑了：最近 6 次全部 `failure`。**但"是不是同一条因"我没核**，
  也不该假设——里面可能混着 L31 那条引用不存在文件的。

### L4 长连接不复查凭据：被移出空间后仍能写共享笔记 【核过】

- 服务端删会话做得很干净（`identity/invite-service.ts:598-605` 按 (user, workspace) 删 `sessions`），
  但协同只在 `collaboration.ts:111` 的 `onAuthenticate` 判一次 `readOnly`，之后 `onStoreDocument`
  （`:150+`）用的是握手时捕获的 `{workspaceId, userId}` 开事务落盘，全程不再解 token。
- 于是 `PRODUCT.md:69`「被移出工作区都会立即失效」只对 REST 路径成立。同族：inbox SSE 的 pump
  `companion-conversation/inbox-routes.ts:126-164`、`companion-shell/account-events.ts`【未核】。

### L5 恢复历史版本 / 删除笔记，从不作废本机那份 CRDT 文档 【推断：缺失效已核，后果未量】

- **核过的部分**：`noteVersionRestore` handler（`src/main/desktop-ipc.ts:2502`）只调
  `gateway.restoreNoteVersion`，不碰任何本机副本；`dropNoteDocLocalSessions()` 全仓唯一调用点在
  `desktop-ipc.ts:1368`（切空间/退空间那条流回收）；而 `desktop-gateway.ts:3978` 的 `seeded` 闩一旦
  立起，`4036`/`4173` 都是 `if (session.seeded) return`，服务端起点不再并进来。
- **推的部分**：同一进程里恢复后编辑器仍显示恢复前正文、版本列表已更新、下一次自动保存把旧内容差回去。
  个人空间连纠正的帧都不会来（流只在 collaborative 才建）。**这条要在真窗口量一遍再定性**。
- **配套的死口子**：按篇作废的 `clearNote()` 三处实现齐备（`note-doc-cache-store.ts:130,204,292`），
  生产零调用【核过】——笔记删进回收站后其正文与未提交草稿仍按 uuid 躺在盘上，同账号同空间再登录可读回，
  与 `desktop-ipc.ts:1757` 给切空间立的理由（"分键只解决串读，不解决残留"）自相矛盾。

### L6 空间所有权没有出口 【核过】

- `transferWorkspaceOwnership` 有实现有路由（`identity/routes.ts:373`、`service.ts:877`），
  但**客户端零消费**：`desktop-gateway.ts` 只有 join / leave / rename / create / list / switch / export。
- `leaveWorkspace` 对 owner 返回 `owner_cannot_leave`（`identity/service.ts:1028`）；
  全仓**没有删除空间的端点**。
- `0264_workspace_orphans_and_transfer.sql` 开头写它存在的理由正是"owner 完全没有出口：既不能退，
  也不能交"。出口做在了 service 层，产品层仍然没有。
- **重叠提示**：并行会话正在写 `docs/plans/learning-companion/32-workspace-dissolve-design-2026-09-22.md`。
  这条以那份为准，别在这里另起一版。

### L7 来源可以永久卡在 `processing`，界面还教用户走一条不存在的路 【核过】

- `SourceStatus.PROCESSING` 全仓唯一写入点 `workers/ai-worker/src/handlers/parse-source.ts:1419`；
  `FAILED` 只由该 handler 自己的 catch 写（`:1769`），而它先要求租约仍有效。
- job 被 reaper 判 `dead` 时 `0221_reap_preserve_last_error.sql` 只 `UPDATE public.jobs`；
  `grep "UPDATE public.sources"` 在 268 支迁移里零命中。于是那一行 `sources` 永远停在 processing，
  没有任何东西再动它。
- 同时 `activity/service.ts:436` 与 `today-log.ts:185` 都告诉用户"打开来源后可以重新解析"，
  而 `source/routes.ts` 只有 POST/PATCH/DELETE/create-note——**没有重新解析这个端点**
  （`schema.ts:22-25` 还把 status 从 PATCH 里移掉了）。用户唯一出路是删掉重传。

### L8 跨空间记忆的函数会被角色重建收回权限，而失败只有一行 warn 【核过】

- `0267_cross_space_global_memories.sql:142` 授 `ailearn_worker` EXECUTE；
  `infra/postgres/roles.sql:613` 有一条批量 `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM PUBLIC, ailearn_api, ailearn_worker;`，之后是逐支显式白名单——
  **`grep fanout infra/postgres/roles.sql` = 0 命中**，即 `ailearn_fanout_global_companion_memory`
  不在名单里。角色一重建，权限就没了。
- 唯一调用方 `companion-memory-extractor.ts:478-494` 把它 catch 成 `logger.warn`，
  注释还写着"不能静默：否则'另一个空间怎么不记得'会查无实据"——现在的结果正是只有那一行日志。
- 那份"预期权限清单"断言只抓**多出来的**授权、抓不到**缺失的**，所以 role bootstrap 也不报。
  这正是 `0246` 注释自己警告过的形状（白名单有三处，只改迁移＝下次重启容器才炸）。

### L9 `global_key` 根本不在 Drizzle 表定义里 【核过】

- `assistant_memory_items` 定义在 `packages/shared/src/db-schema/assistant-memory.ts`（22 列）。
  `global_key` / `globalKey` 在 `packages/shared/src`、`apps/api/src/modules`、`workers/ai-worker/src`
  的**非测试代码里零命中**，唯一命中是 `workers/ai-worker/src/integration-tests/companion-memory-cross-space.integration.ts`。
- `POST /companion/memory` 允许 `scope:"global"`（`memory-routes.ts:81`）并直接走 Drizzle 插入
  （`memory-service.ts:172-190`，字段表里没有它）→ 这批行 `global_key IS NULL`；
  而 0268 的同步触发器条件是 `WHEN (OLD.global_key IS NOT NULL OR NEW.global_key IS NOT NULL)`
  → 删除、纠正、固定**永不扩散**。`correctMemory`（`memory-service.ts:355`）还会再产一条同样 NULL 的行。
- **影响面我今天量过了，比原报法小**：当前 dev 库里 `scope='global' AND global_key IS NULL` 是
  **0 行**，而且渲染层建记忆时把 scope 写死成 `"workspace"`
  （`companion-center-surface.tsx:534`）——**所以今天没有一条真数据处在这个坏形状里**。
  这条因此是**潜伏缺陷而不是在跑的故障**：谁哪天把 UI 的 scope 放开、或直接调 API 建一条 global 记忆，
  它就立刻成立。修法也很轻（Drizzle 补列 + 插入时带上），但**别按"正在损坏数据"的优先级排它**。
- **L8 与 L9 是同一件事的两半**：一半没有钥匙（权限），一半没有门（列）。
  9-22 那条"与空间关联不强的记忆跨空间同步"的裁决，目前只有 worker 提取那一条路真在动。
- **措辞修正（我自己重跑后收窄）**：不能说"dev 里已经没有在铺"。当前 dev 库实测
  `assistant_memory_items` 共 **162** 行，其中 **102 行带 `global_key`**（= `scope='global'` 那 102 行，
  一个不差），按 `global_key` 分组有 **35 组存在 >1 份副本**，铺在 **26** 个空间里。
  **extractor 这条路眼下确实在铺**，EXECUTE 还没被收回。所以本条只能写成"**角色重建之后会断**"，
  不能写成"已经断了"。

## 3. 门禁只装在半条路上

### L10 空间级静音只挡"念头"，不挡提醒与主动钩子 【核过】

- `proactive_muted` / `proactiveMuted` 全仓非测试命中 **16 处**：迁移自己 4、
  `home-projection-service.ts` 2（透传给客户端）、`HomeV2Experience.tsx` 3（那个静音按钮自己）、
  `companion-home-contracts.ts` 2、`db-schema/companion-home.ts` 1、`companion-thought.ts` 4。
- `0238_companion_reminders.sql` 与 `companion-conversation/proactive-hook.ts:239-291` 插
  `assistant_deliveries` 前都不看它；渲染层也不过滤（`CompanionPresence.tsx:388-411`、cue 效果
  `:596-651`）【后者未核】。**被静音的房间里她照样开口**，而提醒气泡还会走 `speakHomeV2Cue`
  （`CompanionPresence.tsx:639-641`）——用户能亲眼看见。

### L11 到点提醒不看任何账号级开关 【核过】

- `ailearn_fire_due_companion_reminders()`（`0238`）只在取时区时读 `user_companion_account_state`
  （该文件第 11 行的注释就是这件事），不看 `global_enabled`、不看勿扰、不看静默时段。
- `grep user_companion_account_state` 在 migrations 里命中 0171/0198/0217/0236/0243/0251/0254/0259，
  **0238 里没有**。

### L12 那份"正式作答不许打扰"的策略函数没有调用方 【核过】

- `evaluateProactivePolicy`（`packages/shared/src/companion-proactive-policy.ts:133`）是
  `formal_answer_in_progress` / `dedupe_recent` / routine `expired` 三条的**唯一实现**；
  全仓命中只有它自己和 `companion-proactive-policy.test.ts`。生产只 import
  `evaluateTriggeredPush`、`routineCadenceBlocked`、`proactiveAvailabilityBlocked`、`isWithinQuietHours`。
- 也就是说：合同写了、测了、绿的，**执行者不存在**。

### L13 AI 同意与外发政策完全不覆盖语音 【核过】

- `sendToExternal` / `enforcePrivacyGovernance` 在 `apps/api` 里只出现在 `identity/`
  （capability-projection / routes / service 共 6 处），`learning-sessions/` 零命中；
  文字路径的门在 worker 侧 `workers/ai-worker/src/lib/governance.ts:563-568`。
- `/voice/tts` 与 `/voice/transcribe` 只有 `requireSession` + 限流（`voice-routes.ts:317,454`【行号未核】），
  而 ASR 是把原始麦克风音频发给外部供应商。更尴尬的是"你还没同意"这句话**本身也用 TTS 念出来**
  （`companion-consent-gate.ts:22`【未核】）。
- `PRODUCT.md:50` 把账号级同意写成外发的唯一闸门。要么补门，要么这句话是假的。

### L14 伴星记忆"忽略"不产生任何效果 【核过消费侧】

- `dismissMemory` 写 `dismissed_at`（`memory-service.ts:326-342`，路由与 IPC 与界面都接上了）。
- `grep dismissed_at|dismissedAt` 的全部非测试命中：迁移 0076/0088/0170/0268、`memory-service.ts` 3 处
  （其中一处就是写入）、`companion-memory-desktop-contracts.ts` 1、db-schema 3。**没有一处是
  `WHERE dismissed_at IS NULL`**——召回与提示注入都不排除它。
- 0256 那条 3 天冷却也没有"已忽略"守卫 → 用户明确忽略过的候选照样被升成真记忆并进提示词。
  这条就是 doc 26 的 B-4/B-1，登记于 2026-08-25，**今天仍然成立**。

### L15 正式测评的语音闸门是死的；账号"作答模态偏好"改了什么都没变 【混合】

- 【核过】`authorizeCompanionDelivery` / `allowsCompanionDelivery`（`main/formal-assessment-guard.ts:40,49`）
  的生产命中只有 `desktop-ipc.ts:1001-1006` 那一处暴露，渲染层**零引用**；真在挡的是渲染层页面状态
  `CompanionPresence.tsx:1540` 的 `voiceEnabled={!assessmentMode}`。服务端仍在造
  `voice.segment.ready`，`/voice/tts` 仍照合成——**门在客户端，源没关**。
- 【核过】`getAnswerModePreference` 只有 `companion-shell/routes.ts:30` 和一条集测读它；
  `grep answer_mode|answerMode` 在 `learning-runs/`、`review/` 零命中，
  而 `learning-objectives/action-resolver.ts:39,85` 两处硬写 `responsePreference: "adaptive"`。
  设置页那个 语音/静默/文字 的三选，**目前是一个纯展示控件**。

## 4. 写了没人读 / 读了没人写 / 一个数两个口径

### L16 删掉的笔记，它的卡还活着 【核过】

- `note/service.ts:744` 的注释直接写着"V2 卡片经 objectiveId 关联，其生命周期不在 note 模块管理"，
  而卡片那一侧没有任何反应（`grep learningCardsV2|learning_cards` 在 `modules/note/**` 只有
  `visibility.ts` 的判据）。
- 共用的可见性判据 `noteVisibleSqlText` 展开就是
  `(share_scope = 'shared' OR created_by = viewer)`——**不含 `deleted_at IS NULL`**。
  全文件唯一那处 `deleted_at IS NULL` 在 `visibility.ts:80`，是给 search 单独补的。
- 后果：复习队列、仪表盘计数、星图继续含这些卡，而点开证据来源是 404
  （`GET /notes/:id` 用 `isNull(deletedAt)`，`service.ts:512,572`【行号未核】）。
  **产品承诺的"每条理解都有来源"在这里静默变成一条死链。**

### L17 同一个笔记永远删不掉 【核过】

- `learning_cards_v2.note_version_id` → `note_versions` 是 `onDelete: "restrict"`
  （`db-schema/card-generation-v2.ts:252`），`note_versions` → `notes` 是 `cascade`
  （`db-schema/note.ts:104`），而 `physicalDeleteNote` 对卡**一个字节都不动**
  （函数体里只有 `tx.delete(notes)` 与图片资产）。
- 手动 `DELETE /notes/:id/permanent`（`note/routes.ts:248`）与每 6 小时的
  `purgeSoftDeletedNotes`（`server.ts:485` → `maintenance.ts:48`）走同一个函数 → 两条路都被 FK 挡住。
- purge 逐条 `catch` 成 `logger.error` 后继续（`maintenance.ts:66-68`）：不崩、**但也永远清不完**；
  而它是 `LIMIT 50` 且**无 ORDER BY**——清不掉的行会把每轮配额占满，饿死后面的笔记。
- **但这条的"每 6 小时撞一次 FK"只在扫描能选出行的地方成立**（见 L37 症状 A）：外层候选扫描是裸 `db`，
  在生产形状的 `ailearn_api` 下**一行都选不出**，所以 FK 那一步压根走不到；能走到的是 dev（BYPASSRLS）
  和那个上下两半都瞎的 CLI。**两半都要修，顺序是先角色/上下文、后 FK。**
- 卡上带 `note_version_id` 的比例不是边角案例：`visibility.ts:134` 自己记着实测——
  214/214 条 active 目标都有卡且卡都带 `note_version_id`。

### L18 "还缺什么"从来不喂下一次 【核过】

- 每次提交都写 `gapFacets`（`learning-runs/run-processing-tick.ts:1470-1502`）、投影出去
  （`run-service.ts:1295`）、界面还会说"先补上「X」"（`learning-run-surface.tsx:2359`、
  `objective-quest-presentation.ts:101`）。
- `grep gap|priorResult|lastResult` 在 `learning-runs/run-planner.ts` **零命中**。
  排期只在 demonstrated / unable 上分叉，部分正确走 `facet_only` 直接短路不动排期
  （`run-processing-tick.ts:1716-1720`【未核】）。
- **闭环合同里"还缺什么 → 下一步做什么"这条边，目前只存在于结果面板的文案里。**

### L19 "稍后再复习"只被一个读者尊重 【核过】

- `user_deferred_until` 的读者：`learning-dashboard/service.ts:104`、`review/service.ts:175-178`、
  `review/routes.ts:44,74`、`review-defer-service.ts`、伴星三处。
- **不看它的**：`surface-service.ts:131-151` 的 `loadReview`、`understanding-v3/topology-repository.ts:286-303`
  【未核】、以及 `learning-objectives/action-resolver.ts:72-87` 签发的 `create_review_run`；
  run-start（`run-service.ts:548-561`【未核】）只判 status/due。
- 于是用户点了"稍后"，下一次进书房拿到的下一步动作还是它。

### L20 语音合成结果是只写不读的表 【核过】

- `companion_tts_outcomes` / `companionTtsOutcomes` 的非迁移命中只有：
  `companion-voice-service.ts` 3（两处 INSERT + 一处）、`voice-routes.ts` 1（上报端点）、
  contracts 1、集测 4。**没有任何 SELECT 在生产代码里**——没有报表路由、没有 worker 授权、没有重试。
- 而 `0246:63-64` 的注释自己写着"只有 api 写、也只有 api 读……报表也走 api"。
  一条失败或被跳过的音频段，永远不会被再驱动一次。

### L21 证据链的三个洞 【核过】

1. **引用不指向任何东西**：`protectedQuoteRef` 写成 `evidence://snapshot/<新随机 uuid>`
   （`card-generation-v2-pipeline/evidence-seal-core.ts:214`）并存库，而 `grep "evidence://"` 全仓只有
   这个写入方、contracts 里那句"正文封装在不可变 protectedQuoteRef…经 protected ref 访问"
   （`card-quality-v2-contracts.ts:167`【未核】）和一个测试字面量。**没有解析器**。
   所以所有"复算哈希发现漂移"的路径只能失败关闭，永远拿不回原文。
2. **审核预览不复算哈希**：`card-generation-v2/reveal-service.ts` 里 `hashCanonicalV2` 只出现在
   `:161` 的 `contextHash`，`loadEvidencePreviews`（`:233-276`【未核】）直接切活
   `note_blocks.content[start:end]`。而自动保存就地重写 `note_blocks`——审核员看到的"原文依据"
   可能已经不是这张卡当初对齐的那段文字，keep/reject 就是照它定的。
   其余三个读点都复算并抛错：worker handler `:1163/1172`、`run-critic.ts:364/368`、
   `companion-grounded-evidence.ts:44/48`【未核】。
3. **撤销证据这件事没有生产者**：`recordEvidenceRedactionV2/InTx`
   （`evidence-redaction-service.ts:71,174`）是 `evidence_eligibility_states_v2.status='revoked'` 的
   唯一写入方，全仓命中只有实现 + `card-generation-v2-redaction-quota.integration.ts`；消费端
   （`activation-service.ts:408` 的 `evidence_revoked`、`binding-plan-core.ts:297`）齐备。
   → 删笔记、删来源，**永远撤不掉一张已激活卡的证据**。

### L22 五条账号开关存了没人读 【核过消费侧】

- `suggestionPause`、`suppression`、`notificationBoundary`、`voiceOff`、`animationOff` 的**全部**非测试
  命中只在 `companion-shell/service.ts`（读写与序列化）+ `companion-shell-contracts.ts` +
  `db-schema/companion.ts`：**没有门、没有 UI 控件、渲染层一次都不读**。
- 与当初 `allowVoiceTags` 同一个形状。注意 `voiceOff`/`animationOff` 的"看起来有效"来自另两套本地状态，
  即同一件事两个来源、其中一个是摆设。

### L23 "待复习"有四个谓词，其中一个没人读 【未核】

- 首页"N 项待复习" = `dashboard.counts.reviewsDue`（due + defer + consumable，
  `room-projection.ts:137`、`HomeV2Experience.tsx:660`）；
  StudySurface 的"待复习" = `stats.pendingReviewCount`（**全部 pending**，不判 due、不判 defer，
  `stats/service.ts:150-169`）；另有 `objectiveReviewDueCount`（`stats/service.ts:85-103`）算出来发出去
  但渲染无处用，其路由注释还写"桌面端在读它"（`stats/routes.ts:10`），而 gateway 只调
  `/stats/overview/all`（`desktop-gateway.ts:1561`）。
- 同族：伴星"已规划复习路线"接受后存 `resultRef=routePlanId`
  （`learning-action-bridge.ts:1162`），计划行 30 分钟过期，`grep routePlanId` 在桌面端零生产命中【未核】。
- 这一组是本项目已经认过的规矩：**一句用户可见的读数只许一个来源**。`stats` 与 `note/visibility`
  正被并行会话改（工作树里），修之前先看他们改到哪。

### L24 两个相反的说法贴在同一个旋钮上 【未核】

- `companion-center-surface.tsx:1064` 把"活跃度"写成"控制伴星主动出现的频率"；
  而 `activeness` 实际只被用于回复长度（`companion-dialogue-content.ts:734`、
  `companion-agent-runtime.ts:2662`）与日记段数（`companion-daily-summary.ts:593`）；
  频率真正来自 `intervention_level`。相邻面板（`companion-account-presence.ts:40-49`）给的是另一种说法。

### L38 【D 批】成员退出/被移出之后的数据归属没有定义 【核过（数字我重跑过）】

- **先说清边界，这条不是"没有退出功能"**：member 自退 = `identity/service.ts:1009-1060`
  （入口 `POST /auth/leave-workspace`，`routes.ts:179`【路由行号未核】），要求有可落回的个人空间、
  `FOR UPDATE` 锁成员行、拒绝 owner，然后打 `left_at` + 删该空间 sessions + 把他消费的邀请码标 revoked；
  被移出 = `invite-service.ts:565-600`（带"最后一个 owner 不能被移"）；转让后退出也通。
  **三条路都齐，缺的是退出之后**。
- 退出**不碰任何用户数据**：笔记、卡、记忆、日记、`pet_profiles` 的亲密度一律不动。
  于是"留在原地、没人认领的那批数据"的归属规则不存在。
- **证据是判据的散布方式**：`grep -rl 'left_at IS NULL' apps/api/src/db/migrations/` 命中
  **9 支迁移**（我数的，名单：0028 / 0171 / 0198 / 0243 / 0251 / 0259 / 0261 / 0264 / 0267），
  TS 侧另有约 10 处站点各自把这句学了一遍【这个 10 是并行会话报的数，我没重数】。
  日记调度器为同一件事改了四版：`0171` → `0198`（修活动判定）→ `0243`（改成按 (user,workspace) 对）
  → `0251`（放宽 tick）。`0259:52-53` 的注释自己写着"已退出的空间不再生成念头（与 0243 的日记调度同一判据）"
  ——**这是逐个消费者追出来的补丁，不是一条立住的规则**；漏一个消费者就多一条 L7 那种"卡在没人管的状态"。
  `docs/workspace-isolation-permission-audit-2026-09-20.md:175` 早已把这条列为"本次完全没审"的第一项【未核】。
- **建议的收口判据（D 批就按它拍）**：离开（自退／被移／被解散牵连）一律**不删数据**；
  数据算**这个空间**的资产；"谁产生的"这一位必须留得住；只有空间解散到期的物理清除才销毁它。
  这句够用是因为退出本来就什么都不删、重新加入是原样回来的（`service.ts:797-807` 把 `left_at` 清空），
  所以真问题从来不是"东西还在不在"，而是"**谁还能看见它、谁对它负责、再进来算谁的**"。
- **要补的口径**：`notes.created_by` 有了，但整张归属矩阵（每项数据 → 账号级/空间级/空间内私有 →
  谁可写 → 换空间是否保留 → **退出是否销毁**）在 doc 20 §3B 被点名缺，缺的正是最后一列。
  设计细节见 `32-workspace-dissolve-design-2026-09-22.md`，别在这里另起一版。

### L39 孤儿清理是装了引擎没接启动键的机器，而且它的判据和解散方案不兼容 【核过】

- `ailearn_purge_workspace_orphans` 的 `dry_run=false` 分支全仓无调用方：两条迁移里的调用
  （`0264:129`、`0265:183`）都传 `true`，函数又只授给 `ailearn_migrator`（`0265:169`），`migrate.ts` 不调它。
  `0264` 自己实测 dev 库 5,577 行孤儿、18 张表 —— **没有任何代码路径会清**。
- **修复顺序的坑（这条是并行会话补的，我核过判据原文）**：它筛的是
  `NOT EXISTS (SELECT 1 FROM workspaces WHERE id = x.workspace_id)`，也就是"**空间行已经不在了**"。
  而解散要留墓碑（不删空间行）→ 这条判据对解散过的空间**永远不成立**；解散需要的是它的
  `$1 = workspace_id` 变体。所以"接个 timer"不是完整修法。
- 另注：全仓没有删除空间的端点（L6），所以今天产生孤儿的只有集测与手工 SQL。

### L40 审计只接了一半：定时清除物理删笔记不留一行痕迹 【核过】

- `WorkspaceAuditAction` 声明 5 个动作，`grep recordWorkspaceAudit` 全仓只有 **3 个调用点**；
  `workspace.member_removed`（`invite-service.ts:544`，`routes.ts:576` 调用）与 `export.note`
  （`export/routes.ts:43` 的 `GET /export/notes/:id`，与已审计的整空间导出是同一类外发动作）**零留痕**。
- `physicalDeleteNote` 自己不写审计；`note.permanent_delete` 只在 `note/routes.ts:260` 那条手动路径写。
  每 6 小时的 `purgeSoftDeletedNotes`（`server.ts:485` → `maintenance.ts:48`）直接调它，
  每轮上限 50 篇、一天 4 轮，删了多少库里看不出来 —— 而 `0263` 声称回答的正是"谁物理删掉了哪篇笔记"。
- **叠上 L37 症状 A**：在受限角色下那批候选**根本没被选中过**，所以现在不是"删了不留痕"，
  而是"**这条路一次都没跑过**"。两半都得修；只修审计，是给一段永远不执行的代码加日志。

## 5. 状态进得去出不来，或者根本进不去

### L25 进不去的状态一簇 【未核，形状与我核过的同类一致】

- 候选 `publishState` 的 `activating` / `activation_failed` / `expired`
  （`card-generation-v2-contracts.ts:913-920`）零写入方（激活只写 `activated`/`superseded`），
  却驱动渲染层文案"激活没成功"（`CardGenerationSurface.tsx:82`）。
- 生成状态 `stale` 有人读（`desktop-projection.ts:31-34`、activity）无人写。
- run phase `cancelled` / `stale` 被当终态读（`run-service.ts:1444,2913`）无写入方。
- `blocked_content_upgrade`（`action-resolver.ts:61`，界面"等待内容更新"
  `WorkspaceLibrarySurface.tsx:172`）**被 DB CHECK `lo_v2_lifecycle_chk` 排除**
  （`db-schema/card-generation-v2.ts:189`）——界面那行字永远不出现。
- tick 只传 `correct` / `unable`，且两个 guard 硬写 true
  （`run-processing-tick.ts:1724-1731,1763-1770,1819-1826`），于是 `partial` / `incorrect` /
  `source_viewed` / `later` 与 `question_invalid` / `evidence_insufficient` 全是死分支。
- delivery `state='suppressed'` 无写入方（`delivery-service.ts:39,102,190`）→ **"被门挡住"这件事
  不留任何痕迹**，于是 L10/L11 这类漏门在库里查不出来。

### L26 没有账号行 = 调度器当关、界面当开 【未核】

- 0243/0251/0254/0259 对 `user_companion_account_state` 用内连接，而这行只在用户 PATCH 时才建
  （`companion-shell/service.ts:617-629`）；其余读点缺失即视为启用（`service.ts:168-177`、
  `companion-thought.ts:724-731`）。
- 结果：从没碰过伴星面板的人收不到念头和日记，而面板显示"开启 / 适中"。
  doc 26 第 781 行登记过同型问题。

### L27 念头的 `expired` 是死状态，TTL 只用于去重 【未核】

- `expires_at` 送达时写（`companion-thought.ts:992`），全仓只有 `:671` 的去重探测读它；
  `status` 的 CHECK 含 `expired`，写入方只有 `delivered`/`suppressed`/`spent`；
  开念头只看 `status === "delivered"`（`thought-service.ts:43`）。
- 于是过期念头永远停在 `delivered`，只要 id 还拿得到，几天前的念头照样能点开。

### L28 deck gate（成组质量门）拒了不回写候选，激活还照样放行 【未核】

- `runDeterministicFinalGates` 返回 `passed=false` 时（codes `count_out_of_plan` /
  `candidate_revision_mismatch` / `semantic_duplicate`，`critic-service.ts:357`），
  worker 只把 run 落成 `needs_attention` + `quality_gate_failed`
  （`card-generation-v2-handler.ts:2665-2699`），**一个候选都不标**，幸存者仍写着 `quality_state='passed'`。
- 而激活显式允许 `needs_attention`（`activation-service.ts:262-263`）、审核就绪谓词
  `isCandidateReviewReadyV2` 也说"可激活" → **一组被判不合格的东西可以一张张被激活**。
  这就是 `0255` 迁移注释警告过的"写侧一套、读侧另一套"，修在了 dedup 上，deck gate 本身还开着。

### L29 `jobs` 的 per-job 重试列与 `failed` 状态没有生产者 【未核】

- `0052` §12 加的 `max_attempts` / `retry_policy_json` / `retry_after_at` 三列，`0200` 清别列时留下了它们
  （也不在 `db-schema/job.ts`）；现行三支队列函数一律用调用方传进来的 `p_max_attempts`
  （`queue.ts:12` 的常量 3）。
- `job_status` 枚举含 `failed`，而 SQL 只写 `pending/running/succeeded/dead` →
  `activity/service.ts:270,410` 那两处判 `failed` 永不命中。

## 6. 仓库和承诺对不上

### L30 一个被 git 跟踪的 env 备份里有真密钥 【核过】

- `git ls-files` 命中 `.env.bak-p6-streaming-20260812`（且 `git check-ignore` 判"未被忽略"）。
  其中非占位符长度的有：`OPENAI_COMPAT_API_KEY`(67)、`DASHSCOPE_API_KEY`(117)、
  `SILICONFLOW_API_KEY`(51)、`BIGMODEL_API_KEY`(49)、`TOKENRHYTHM_API_KEY`(49)、
  `AI_CREDENTIAL_ENCRYPTION_KEY`、`EDGE_TTS_AUTH_TOKEN`、`S3_ACCESS_KEY`、`OWNER_PASSWORD`(13)。
  **我没有打印任何值**，它们也不匹配 `.gitleaks.toml` 的 placeholder 白名单。
- CI 的 gitleaks 只扫 push 区段（`.github/workflows/ci.yml:54`），已入库文件不再复扫 → 长期漏检。
- 按 `AGENTS.md`（未用的旧物直接删）这是该删的死文件；但**轮换这些 key 影响外部服务，我不会自己动手**，
  需要你确认哪些 key 还在用。

### L31 CI 引用了不存在的测试文件 【核过】

- `apps/api/package.json:21` 的 `test:companion-integration:postgres` 列 24 个文件，我逐个 `existsSync`
  数过：**1 个不存在** —— `assistant-deliveries-kind-constraint-postgres.integration.ts`
  （盘上真名少了 `-postgres`）。HEAD 与工作树都不存在。
- `.github/workflows/ci.yml:460` 又引用 `src/integration-tests/db-commit-port.integration.ts`，同样不存在。
- 前者被 `ci.yml:604/618` 执行、且 `ci.yml:592` 的注释称它"锁死代码 kind 集合 == 库约束"；
  该 job 是 `production-compose` 的依赖。**这道锁现在要么红、要么根本没在跑。**

### L32 `VITE_HOME_SCENE_VARIANT` 是个不存在的开关 【核过】

- `grep SCENE_VARIANT` 在整个 `apps/desktop-client` 源码里**零读取**（唯一命中是
  `package.json:19` 的一条 capture 脚本给它赋值），`HomeV2Provider` 在 `App.tsx:145` 无条件包裹房间树。
- `PRODUCT.md:54` 的"Home V2 预览覆盖合同"、`DESIGN.md:16` 的"V1 运行分支继续保留作回退"、
  `docs/feature-flag-inventory.md` §5 承诺的构建期旗标与发布门禁，**没有实现载体**。

### L33 `feature-flag-inventory.md` 报的生产姿态与 compose 相反 【核过】

- 文档 `:118-119` 说"prod 栈全部 false fail-closed"；实际 `docker-compose.yml:226-233` 把
  `COMPANION_JOURNEY_V2` / `COMPANION_BRIDGE_V2` / `COMPANION_MEMORY_VECTOR_V1` /
  `COMPANION_PROACTIVE_PERSONALIZED_V1` 全设成 `${...:-true}`。
- 附带：`CARD_GENERATION_V2_ENABLED` 是 api 路由门（`server.ts:328/331`【未核】），
  `.env.example` 只列了 worker 的 `CARD_GENERATION_V2_LLM`。
- 谁按文档判断"生产伴星默认关"，就会做错决定。**以 `PRODUCT.md` + 门禁脚本为准。**

### L34 第二套"能力/旗标"系统没人可达 【未核】

- `packages/shared/src/capability-bundle.ts` 声明 13 个 bundle + 6 个内部原子 + 依赖图，
  `01-7-feature-flags-capability-bundles.md` 称它是单一事实来源；但
  `createCapabilityConfig` / `CAPABILITY_DEPENDENCY_EDGES` / `CapabilityApiViewV1` 在三端源码零消费
  （只有自身测试与 barrel 再导出）。真正门控路由的是 15 支 `COMPANION_*` / `CARD_*` env 旗标，
  与 bundle id 无映射。`task-router.ts` 的 `TASK_CAPABILITY_MAP` / `TASK_COMPLEXITY` 同形。
- `.env.alpha.example` 还在配一个已废弃的 web 层：`WEB_PORT` / `WEB_BIND_ADDRESS` 无任何消费者，
  `SOURCE_MIGRATION=0039` 相对当前 0268 落后 229。
- 渲染进程 CSP 无条件含 `'unsafe-eval'`（`main/index.ts:214`：`script-src 'self'
  'wasm-unsafe-eval' 'unsafe-eval'`，dev 源只是附加项），而 `PRODUCT.md:56` 写的是"严格 CSP"。
  **这条我只看到了字符串，没追它是打包后哪条链路必需**（Live2D runtime / GSAP / 还是历史遗留）。

### L35 首页"诚实 pending"整条机制已失效 【核过，我自己找的】

- `home-feature-registry.ts:73` 的 `WIRED_HOME_FEATURE_IDS` 覆盖了全部 9 个用 `pending()` 声明的功能
  → `availability` 恒为 `"native"`；`HomeV2Experience.runFeature`（`:381-433`）对全部 11 个 id 提前
  return，`:434` 的 `openFeatureNotice` 不可达；它另一入口 `ailearn:home-unavailable`
  **全仓只有监听、没有派发**。
- 于是 `HomeFeatureNoticeDialog`（`:512`）、6 组"尚未接入新版页面"文案、
  `homeFeatureRegistryIssues()` 里"pending 必须有完整说明"那条自校验、测试里那句
  "for (每个 pending 功能)"的循环，**全部空转**（后者迭代的是空数组）。
- 而 `PRODUCT.md:54` 与 `DESIGN.md:124` 仍把它写成现行合同。留着不等于无害：它描述的是已经不存在的缺口。

### L36 桌面端还有一套没人用的第二内核与一批死渠道 【部分核过】

- 【核过】按篇作废的 `clearNote()` 零调用（见 L5 附）。【未核】
  `navigation.go` 每次进任务面 push 一条、`revision++`，`navigationBack` / `navigationRestore`
  无调用方，而返回键实际走渲染层 `room-store` → 主进程那套导航栈是第二个内核 + 单调增长的数组
  （`desktop-ipc.ts:1616-1636`）。
- 【未核】`runtime.getHealth`、`runtime.cancel`（主进程真能 abort 在途请求，界面没有任何地方按得动）、
  `workspace.getCurrent`、`companion.room.getProfile`、`window.getState/focus/setTitlebarTheme`。

## 7. 修的话，我建议这么排（等拍板，本轮一条都不动）

**批次 A｜纯接线，改完能当场验**
L1 补 IPC handler、L7 补重新解析端点、L8 把 fanout 加进 roles.sql 白名单、
L9 给 Drizzle 补 `global_key`（**按今天的量它是潜伏项，排在 L8 后面即可**，见 L9 第二条）、
L40 补上缺的两个审计写入方（`workspace.member_removed`、`export.note`）。
验收：每条写一个"缺它时会红"的断言（L1 用"渠道 → handler 一一对应"的表驱动测试，不许再用 `vi.fn()` 替身；
L8 用一条以 `ailearn_worker` 身份执行的 `EXECUTE` 冒烟），而不是只加日志。

**批次 B｜只有生产会坏的那一类，先修角色这一根，再修症状**
**L37 是本批的根，L2/L3/L17 的一半都是它的症状。** 顺序：
① 让 dev 的 API 也用 `ailearn_api`（`docker-compose.dev.yml:10`）——**这一步要用户点头**，
因为换角色会让所有人当前的 dev 当场变红（那是好事，但共享环境不该被审计会话单方面改）；
② 把 §1.2 ② 那张表跑成一份**清单**：`apps/api/src/modules` 里约 21 处非测试裸 `db`，
逐条对照所在表的 `pg_policy` 判"恒 0 行 / 照常工作"，**这条本身就是本批的主要工作量**，
我只确认了 `notes`（死）与 `workspaces`（活）两个端点，中间那一片还没翻；
③ 修 L2/L3 两个已知引信 + L37 症状 A（外层扫描与 CLI）。
**验收口径**：凡依赖 RLS 的断言，必须显式以 `ailearn_api` 连；且**红绿要按断言方向分开报**——
"该被拒"的用例在读不到东西时全绿，这不是通过（L37 症状 B 那 4 条就是）。

**批次 C｜门禁补齐**
L10/L11/L12：把"能触达用户的每一条路"列成矩阵（回答 / 念头 / 日记 / 提醒 / 气泡 / SSE / 系统通知 / 语音），
行是七个开关，逐格填"谁在哪一行判的"；L12 那个没人调用的 `evaluateProactivePolicy` 应当成为矩阵的唯一实现。
L13 要么补语音门，要么把 `PRODUCT.md:50` 那句话改小。
**同批带上 L14 与 L15**：它们不是漏了一个分支，而是**整条开关没有执行者**——
L14（记忆"忽略"没人据此排除）缺的是召回查询里那一句 `IS NULL`；
L15 的两个症状（正式测评语音门是死的、作答模态偏好纯展示）缺的是服务端那一半
——客户端挡显示不算门，`action-resolver.ts:39,85` 那两处硬写的 `"adaptive"` 要改成读真值。
**矩阵里任何一格填不满，就别宣称这个开关存在。**

**批次 D｜需要你定产品口径，代码动不了**
L16/L17（笔记删除的双向断链，且 L17 卡住的是"用户能不能真正删掉自己的数据"）、
L18/L19（"还缺什么"和"稍后"到底算不算承诺）、L23（一个读数的唯一来源）、
L30（删文件 + 轮换哪些 key）、L6（以 `32-workspace-dissolve-design` 为准）、
L21（证据链三洞：预览复算哈希与"删除即撤销证据"是补调用点的活，但 `protectedQuoteRef` 到底要不要真做成
可解析的不可变副本，是一个产品决定——现在它写着"不可变副本"却指向一个随机 uuid，**要么实现、要么把
合同里那句话删掉**）、L38（退出/被移出之后的数据归属：收口判据与归属矩阵缺的那一列都写在条目里，
设计本体在 doc 32。这条不定，那 9 支迁移 + 十来处站点会继续一个个长出来）。

**批次 E｜登记为"要么删掉、要么补上"，不许停在中间态**
这一批全都是"合同里存在、代码里没有执行者"或"进不去的状态"，处置只有两个方向：
按 `AGENTS.md` 把整条死链路删净，或者补上缺的那一端。**不允许留着**——留着就是本轮这些条目本身。

- L4 长连接不复查（补：流循环里定期重解 token / 或订阅成员变更事件）· L22 五条账号开关（补门或删控件与列）
- L24 活跃度两种说法（改一句文案，成本极低）· L35 首页 pending 整条（删 `HomeFeatureNoticeDialog` 与 6 组文案
  及那条自校验，或把旗标真做出来）· L36 `clearNote` 与主进程第二套导航栈（删，或接上）
- L25 / L27 / L28 / L29 死状态簇（`suppressed` 与 `expired` 属"该有生产者而没有"：它们恰好是唯一能证明
  "门挡过谁"的痕迹，**建议补而不删**；`activating`/`activation_failed`/`stale`/`cancelled` 与 `jobs` 那三列
  属"没人写得出来"：删枚举值与列，并把 CHECK 收紧，让"写不出来的状态"以后写不进去）
- L26 无账号行的默认语义（一行判据的事，但它决定新用户第一天看不看得到她）· L33 与 L31 同属文档/CI 说假话，
  改文档与改脚本一起做，别只改一边。
- L39 孤儿清理：要么接上触发者（且**先把它"空间行不存在"的判据换成带 workspace_id 的变体**，
  否则对留墓碑的解散永远不成立），要么承认它是一次性运维工具、把它从"机制"降级成"手册里的一条命令"。
  现在这样最坏：迁移注释写得像已经有了解决方案。
- L20（`companion_tts_outcomes` 只写不读）要么补那条读数/重试、要么把表和上报端点一起删；
  L32（`VITE_HOME_SCENE_VARIANT`）要么真做旗标、要么删掉 `PRODUCT.md:54`/`DESIGN.md:16` 里那套
  "预览 + V1 回退 + 发布门禁"的说法；L34（`capability-bundle` / `task-router` 第二套能力系统）
  按 `AGENTS.md` 属"没有调用方的旧实现"，建议整条删，连带 `01-7` 那份"单一事实来源"的声明。
- L5（恢复版本/删除不作废本机 CRDT 副本）先按 §8 量一次定性，量完它就是 A 批那种接线活
  （恢复与删除两处调 `dropNoteDocLocalSessions` 或按篇的 `clearNote` —— 后者本来就写好没人调）。

## 8. 要量才知道的（静态取证到此为止）

- L5：恢复历史版本后编辑器与磁盘缓存的实际内容 —— 要真窗口，个人空间 + 协作空间各一次。
- L10：被静音空间里提醒是否真的出声 —— 要一条真实 reminder + 真窗口。
- L15/L20：语音在正式作答期是否仍可被服务端合成并送达 —— 要一次真实测评。
- L17：purge 的 `LIMIT 50` 是否已经被不可删的行占满 —— 要一次只读 SQL 统计（本轮没跑任何 DB 命令）。
- L31/L32：CI 那道锁到底是红着还是不执行 —— 要一次真实 workflow 运行记录。
- L34 的 `'unsafe-eval'`：要确认打包后是哪条链路依赖它。
- L37 症状 B 那组 A/B（16 全过 vs 4 过 13 红）**我没有重跑**——跑它要往共享 dev 库写数据，
  而这里正有并发会话在跑集测。数字算"他们量过、方法我认可"，收录为【未核】。
  谁要复跑：同一份 `note-collaboration-postgres.integration.ts`，只换 `DATABASE_URL_API` 的角色
  （`ailearn` ↔ `ailearn_api`，宿主侧连 `127.0.0.1`），**并且把"该拒的"和"该收的"两类断言分开报**。
- L37/B 批真正欠的那张表：约 21 处裸 `db` × 各自表的 `pg_policy`，**逐条判完才是这一轮的终点**，
  我只钉了两个端点。

## 9. 明确没算作缺陷的东西

- 4 张迁移建的表没有 Drizzle 定义（`assistant_thoughts` / `companion_reminders` /
  `companion_memory_maintenance_runs` / `companion_tts_outcomes`）：都走裸 SQL 且有真实读写两端，
  属可接受漂移。
- `note-doc-conformance` 只被测试消费：两份内核无法共享源码，设计如此。
- `model.int8.onnx`(239MB) 与 `tokens.txt`：已 gitignore，且 `git log --all` 0 次命中 —— **不在历史里**，
  不污染 clone（这条我专门查过，是好消息）。但仓库里没有任何代码读它们。
- `apps/desktop-client/scripts/tmp-*.mjs` 131 个里只有 10 个被跟踪、0 个被构建/CI/Make 引用；
  `outputs/` 是 CI 真读写的覆盖率暂存目录，不是死物。
- 锁文件双轨（root / apps/api / ai-worker 各同时有 `pnpm-lock.yaml` + `package-lock.json`，共 6 个），
  而 CI/Make 全程 `npm ci`：属可清理项，不影响当前构建。

## 10. 更正、假警报与仍然有效的旧账

**我对 agent 报告的更正（也是对我上一条汇报的更正）**

1. **TTS 音色是 4 条不是 5 条**：3 个 qwen + 1 条 edge（`tts-voice-catalog.ts:47-80`），试听 mp3 四条齐。
   我记忆里"按五个交付"那句已过期。
2. **instruction 那句仍然老 —— 我上一轮说"不老"是错的**。agent 做的是**一致性**检查
   （`config/ai-platforms.json:95` 与 `tts-config.ts:41` 的 fallback 同值，确实没有分叉），
   我拿它当成了"问题不存在"。你原来的担心是这句话写着"可爱的年轻女性声音、25 岁左右、甜美温柔"
   而默认音色已是龙华，会把五个音色往同一方向拧 —— **这条仍然待你拍板**。
3. **CSP 那条已经定了，不是未决**：`main/index.ts` 的 `media-src 'self' blob:` 已落地，注释记了实测理由
   （不放开时 `<audio>` metadata 永不加载、点了没声也不报错）。记忆里"待你否决"的措辞我已改掉。
   同一处新出现的问题是 L34 那条 `'unsafe-eval'`。

**并行会话（doc 32）交来的数字，我逐条重跑了 —— 两处改了我的原写法**

| 他们的读数（当时刻） | 我的复跑 | 结论 |
|---|---|---|
| `notes` 877 行、软删 10、最早 2026-09-16 | **879 / 10 / 2026-09-16** | 一致（+2 是这两小时的漂移） |
| `ailearn_api` 裸查 `workspaces` = 1027 行 | **1027** | 一致 |
| `assistant_memory_items` 142 行、87 带 `global_key`、30 组多副本、26 空间 | **162 / 102 / 35 组 / 26 空间** | 一致，量在长（说明铺仍在跑） |
| `grep -rl 'left_at IS NULL'` = 9 支迁移 | **9 支**（名单已列在 L38） | 一致 |
| `grep -c fanout roles.sql` = 0 | **0** | 一致 |
| L8 "dev 里眼下是否已断" | 我量到 **102/102 条 global 都带 key**、35 组有副本 | **他们的校正成立**：L8 只能写"角色重建之后会断"，不能写"已经断了" |
| L9 "API 直写的 global 记忆 `global_key IS NULL`" | 当前库该形状 **0 行**，且 UI 建记忆写死 `scope:"workspace"`（`companion-center-surface.tsx:534`） | **我的原报法偏重**：降为潜伏项（L9 已改），但结论保留 |
| CI 最近 5 次全 `failure` | `gh run list --limit 6` → **6/6 failure** | 成立；**成因未核**，别当同一条 |

**本轮重验后排除的假警报**（doc 26 登记、今天已不成立）

- **A-5 `preferredStrategies` 是死字段**：已接进规划器（`card-generation-v2-pipeline/planner-service.ts:352,620`），
  注释还记着它曾经无效。
- **N-21 removeMember 可驱逐属主**：`invite-service.ts:544-560` 已加 `self_remove_owner` 与 `last_owner` 两道。
  （但我记下一处**新的不一致**：那段 owner 计数没跟着 `leftAt IS NULL` 收窄，而 `identity/service.ts`
  有 12 处都收窄了 —— `invite-service.ts:573`。可达性我没算清，所以不列进正式条目，
  只提示：如果 L6 解散空间的设计要把 `left_at` 当唯一鉴权收口，这里得一起看。）
- 迁移漏 journal：**没有漏**。268 支 `.sql` 与 `_journal.json` 的 268 条 entry 严格 1:1，
  两侧零缺失、idx 连续 0–267（我自己数的，不信 agent 的数）。

**仍然有效的旧账**：doc 26 的 B-1/B-4（本轮 L14，"忽略 30 天不弹"从未实现）、C-1（"不再提醒这类"，
本轮 `grep cue_class` 仍零命中）、C-2（日记调度漏跑无补救）、C-3（多用户工作区计数串味，本轮 L23 的
同族）、D-3（失败结算 UPDATE 仅按 id 可与用户 end 竞态翻转终态，本轮未重验）。

## 11. 已核对且确实闭环的部分

不是一片坏消息，下面这些是两端都查到人的。**一句口径说明**：本节里 268/268 journal、
`proactive_muted` 16 处、`dismissed_at` 无排除、CI 那 1 个缺失文件、裸 `db` 三处、
音色 3+1、`SCENE_VARIANT` 零读取，是我自己重跑的；`157 个 handler`、`107 张表`、`131 个 tmp 脚本`、
`JobType 7/7` 这几个数是数据层/桌面/配置三路 agent 报的，**我没有逐个数过**，引用前先复算。

- **迁移与合同层**：268/268 journal 对齐；`migrate.ts` 按 `entry.tag` 解析 `<tag>.sql` 并逐条比 sha256
  （0240 那个编号跳过不会静默漏跑）；Drizzle 侧 107 张表没有多出迁移里不存在的表或列；
  `0253` 唯一索引列序与 `card-generation-v2-handler.ts:3594` 的 `ON CONFLICT` 目标逐字一致。
- **任务生命周期**：`JobType` 7 值与 worker `HANDLERS` 7 键完全对齐；主队列
  `pending→running→succeeded/dead` 收敛，`ailearn_fail_job`/`claim`/`reap` 三支都保证 attempts 触顶
  落到 `dead`，没有"pending 且不可领"的死角；V2 制卡 outbox 有 30 分钟租约 + CAS + 退避 + 回收时把
  run 落 `needs_attention`，**不会出现"永远在生成"**（注意：`sources` 那一类是 L7，两条路不齐）。
- **桌面 IPC**：157 个 handler 全部带输出 schema，无一处只校验单边；`companionVoicePreview` 那套
  双内核已三方删净；定时器与订阅都有成对释放；`session-credential-store` 无加密后端时不写盘的
  fail-closed，与 401 → 清凭据 → 回登录门这条链成立，登出/改密/换空间都落 `credentials.clear()`。
- **伴星节奏**：quiet hours 与 DND/offline 在念头路径共用同一份实现（没有第二套），
  间隔已单源到 `PROACTIVE_CADENCE_MS`，客户端那 90s 只是展示过滤；`globalEnabled` 判在
  念头 / 日记 / 提案 SQL / agent runtime / 主进程生命周期 / 渲染层 presence 上；
  提醒的 fired/missed 与 run 对账、提案过期、记忆维护都有认领者和出口；日记 `failure_reason`
  有展示也有清除路径；**注册表里每个工具都有实现**；方案 29 §14.10 那条"正在死的 companion_thought"
  （笔记归属边界把 uuid 当 SQL 字面量）在当前树里确实是修了的
  （`companion-here-and-now.ts:370,376,415`、`companion-agent-runtime.ts:964`【未核】）。
- **视觉契约类**：CSS 自定义属性 8 处"未定义"全部带 fallback；`.button` 修饰类没有脱基类用法；
  渲染层没用到 `Buffer`。

## 12. 怎么复算

高危项我都留了单条可复算命令，形态是"把这个符号在全仓 grep 一遍、按文件数命中"。
最短的一批：

```bash
# L1：渠道声明了但主进程没注册
grep -rn noteDocSyncTitle apps/desktop-client/src packages/shared/src

# L2/L3：裸 db 读一张被 FORCE 的表
grep -n "FORCE ROW LEVEL" apps/api/src/db/migrations/0257_sec01_rls_reopen_core_tables.sql
grep -rn "db.query.notes\|from(aiAuditLog)" apps/api/src/modules/note/collaboration.ts apps/api/src/modules/identity/service.ts

# L10：静音到底谁在看
grep -rn "proactive_muted\|proactiveMuted" --include=*.ts --include=*.tsx --include=*.sql \
  apps/api/src workers/ai-worker/src packages/shared/src apps/desktop-client/src | grep -v "\.test\."

# L14：忽略之后有没有人据此排除
grep -rn "dismissed_at\|dismissedAt" --include=*.ts --include=*.sql apps/api/src workers packages/shared/src | grep -v "\.test\."

# L30/L31：被跟踪的 env 备份、CI 引用的文件是否存在
git ls-files | grep -i '^\.env'
node -e 'const p=require("./apps/api/package.json");const fs=require("fs");
p.scripts["test:companion-integration:postgres"].split(/\s+/).filter(t=>t.endsWith(".integration.ts"))
 .filter(f=>!fs.existsSync("apps/api/"+f)).forEach(f=>console.log("MISSING",f))'
```

**复算口径**：测试文件与 `tmp-*.mjs` 探针**不算生产消费方**——如果某个符号唯一的读取点是它们，
那正是本文要找的东西，不是反证。
