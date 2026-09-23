# 全项目逻辑闭环审计（2026-09-22）

> 署名：Asklins
>
> 这份文档只回答一个问题：**产品承诺的闭环，在代码里哪几处是断的**。
> 它不看视觉、不看性能、不看测试覆盖率。
>
> **本文写完之后已经实施了两天**（2026-09-22 起，用户令"一次性做完"）。下面 §2–§6 是审计原文，
> 逐条的**当前状态以 §7 开头的清单为准**，做完的每一手（落点、验到哪一层、反向复验做过没有、
> 下一手）都记在 §13。上下文被压缩后从 §13 冷启动。
> "等拍板"这个说法只在 §7 那张清单里还活着，正文里那些"本轮不动"是写下时的状态。
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

**这一段说的是"查出来时"的形状，不是现在。** 三条主线里门禁那条（L10–L15）与"只有生产会坏"那条的
症状侧（L2/L3/L37）已经闭上，"根"那一半（dev 让 API 用受限角色）还差一次共享环境的动作；
链断的那条（L16/L17/L18/L21）大部分仍欠，欠的理由写在 §7。逐条状态在 §7 开头的清单里。

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
**③ 全量清点已完成（实施轮，2026-09-22）**
`apps/api/src/modules` 里非测试的裸 `db` 用法共 **20 处**（并行会话报的"约 21"是含 `export/service.ts:268`
那句注释里的字样），逐条按"这条语句碰的那张表属于哪一种"判完：

| 站点 | 碰的表 | 判定 | 依据 |
|---|---|---|---|
| `note/collaboration.ts` 握手 | `notes` | **有事，已修** | RESTRICTIVE 守卫无 NULL 支 → 生产角色恒 0 行（L2） |
| `identity/service.ts:listAIAuditLog` | `ai_audit_log` | **有事，已修** | 同上（L3） |
| `note/maintenance.ts` 外层候选扫描 | `notes` | **有事，已修** | 先枚举 `workspaces`、再按空间各带上下文扫（L37 症状 A） |
| `scripts/cleanup-soft-deleted-notes.ts` 扫描+删除 | `notes` | **有事，已修** | 同一形状；键集分页改成"每空间一条游标"，翻页语义不变 |
| `identity/routes.ts:239/243`、`identity/service.ts:183/1092/1152/1400` | `users`、`workspaces` | 无事 | `pg_class` 实读：`users rls=false`；`workspaces` 守卫有 NULL 支 |
| `learning-sessions/ttl-maintenance.ts` ×7、`learning-runs/run-processing-tick.ts` ×3 | 队列/TTL 函数 | 无事 | 被点名的五支函数 `prosecdef=true`（SECURITY DEFINER，migrator 属主），且都在 roles.sql 白名单里 |
| `companion-conversation/companion-export.ts:57` | 伴星导出 | 无事 | 事务第一条语句就是 `setApiTransactionContext`，只是手写形式 |
| `upload/upload-service.ts:343` | `users` | 无事 | 同上 |

**结论**：这一类的根只有 L37 那一条（dev 的 API 角色绕过 RLS），症状四处已全部修完；
其余 16 处是**有依据的无事**，不是"看起来没事"。

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

**2026-09-23 复量，这一条的形状变了**（用户问"为什么没有空间管理功能"时我重数了四层）：
- 成员管理**已经端到端齐了**：`routes.ts:573 DELETE /members/:userId` + 网关 `listMembers`/`removeMember`
  + 通道 `ailearn.v1.member.list` / `ailearn.v1.member.remove` + 设置页那颗「移除成员」
  （`settings-surface.tsx:1740/1747`）。注意这份界面是**并行会话在途的未提交改动**
  （该文件对 HEAD 有 +116 行），所以它此刻不在 HEAD 里。
- 「退出空间」也齐（同文件 `:1396` 有按钮）——**但 owner 点了会被 `owner_cannot_leave` 挡**。
- 所以 L6 真正欠的只剩两件，而且都不是"少画一个按钮"：
  ① **转让所有权**：service 与路由都有（`routes.ts:373 /workspaces/:id/transfer-ownership`），
     客户端零消费 ⇒ owner 唯一的出路没人能按到；
  ② **删除/解散空间**：四层全都没有。它不能先做界面——空间级资产（笔记/卡/证据/排程）
     的连带处置就是 doc 32 那张归属矩阵，矩阵没定完就做一个不可逆的删数据按钮，
     是本轮 L16/L17 反复撞到的那类"先给出口再想后果"。
  今天能复用的两块料已经在了：`ailearn_retire_workspace_memories_on_departure`（离开收记忆）
  与 L17 的"卡退役再断线"判据（解散时同样要用，且顺序不能反）。
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
- ~~`/voice/tts` 与 `/voice/transcribe` 只有 `requireSession` + 限流~~ **已修（2026-09-22/23 两轮）**：
  三条真会外发内容的端点现在都挂 `requireAiConsent`（`voice-routes.ts:211` `/voice/tts/stream`、
  `:408` `/voice/tts`、`:552` `/voice/transcribe`），判据在 `identity/ai-consent-gate.ts`，
  门禁的用句与四包校验记在 §13；**下游那一半（专用错误码 + 界面那句人话）也已接**。
  **"用 TTS 念那句'你还没同意'"这一条原报法说对了方向，但要按量到的说**：
  `companion-consent-gate.ts:23` 那条固定台词由 `guideToConsent`（`companion-chat-session.tsx:1432`）
  写进 `liveReply.text`，而它的注释原话是"文本 + 语音共用 liveReply 同一条管线"——
  也就是**它确实会走 `/voice/tts`**，而目录里两套引擎（qwen / edge）都在本机之外。
  装上同意门之后的真实后果是：**那句引导从此只被显示、不被念出来**
  （播报侧的降级在 `companion-voice-playback.ts` 的 `PERMANENT_VOICE_REJECTIONS`：
  这个码不再退避重试，整轮按"没出声"走文字）。这是门应有的形状——把"请先同意"这句话发给外部合成服务
  本身就是那次未同意的同意；但**它是一处用户可感知的行为变化，必须写在这里而不是留在代码里**。
  `companion-consent-gate.ts:20` 那句"气泡与语音共用同一份文本"现在要说成
  "共用同一份文字，念不念由同意状态决定"——本轮没改它，因为改的是注释不是机制。
- ~~`PRODUCT.md:50` 把账号级同意写成外发的唯一闸门。要么补门，要么这句话是假的。~~ 门已补，`PRODUCT.md:50` 那句话现在是真的（见上面那条与 §13）。

### L14 伴星记忆"忽略"不产生任何效果 【核过消费侧】

- `dismissMemory` 写 `dismissed_at`（`memory-service.ts:326-342`，路由与 IPC 与界面都接上了）。
- `grep dismissed_at|dismissedAt` 的全部非测试命中：迁移 0076/0088/0170/0268、`memory-service.ts` 3 处
  （其中一处就是写入）、`companion-memory-desktop-contracts.ts` 1、db-schema 3。**没有一处是
  `WHERE dismissed_at IS NULL`**——召回与提示注入都不排除它。
- 0256 那条 3 天冷却也没有"已忽略"守卫 → 用户明确忽略过的候选照样被升成真记忆并进提示词。
  这条就是 doc 26 的 B-4/B-1，登记于 2026-08-25，**今天仍然成立**。

### L15 正式测评的语音闸门是死的；账号"作答模态偏好"改了什么都没变 【混合】

- 【核过，行号 2026-09-23 重核：`desktop-ipc.ts:992` 构造、`:1508` 被 run 快照喂、
  `:1016-1024` 是唯一出口，且那个出口挂在 `AILEARN_PACKAGED_EVIDENCE=1` 的**取证全局**上】
  `authorizeCompanionDelivery` / `allowsCompanionDelivery`（`main/formal-assessment-guard.ts:40,49`）
  在正常运行里**没有读者**（原报法写成"`:1001-1006` 那一处暴露，渲染层零引用"——位置对不上，
  而且把"有个出口"说成"有个读者"）；真在挡的是渲染层页面状态
  `CompanionPresence.tsx:1540` 的 `voiceEnabled={!assessmentMode}`。~~服务端仍在造
  `voice.segment.ready`——门在客户端，源没关。~~ **源已关上**（2026-09-23：worker 在投递源头
  按 `lib/formal-answer-signal.ts` 的判据决定发不发段事件，见 §13"L15 的第一症状已闭上"）。
  还开着的另一件：主进程那台 `FormalAssessmentGuard` **至今没有生产读者**（唯一出口是
  `AILEARN_PACKAGED_EVIDENCE` 的取证全局）——要么让投递走它，要么按 `AGENTS.md` 连取证钩子一起删；
  现在这样是"一台状态机在为一条不存在的通路记账"。
- 【核过】`getAnswerModePreference` 只有 `companion-shell/routes.ts:30` 和一条集测读它；
  `grep answer_mode|answerMode` 在 `learning-runs/`、`review/` 零命中，
  而 `learning-objectives/action-resolver.ts:39,85` 两处硬写 `responsePreference: "adaptive"`。
  设置页那个 语音/静默/文字 的三选，**目前是一个纯展示控件**。

## 4. 写了没人读 / 读了没人写 / 一个数两个口径

### L16 删掉的笔记，它的卡还活着 【核过→已修，2026-09-23：判据派生，见 §13】

- `note/service.ts:744` 的注释直接写着"V2 卡片经 objectiveId 关联，其生命周期不在 note 模块管理"，
  而卡片那一侧没有任何反应（`grep learningCardsV2|learning_cards` 在 `modules/note/**` 只有
  `visibility.ts` 的判据）。
- 共用的可见性判据 `noteVisibleSqlText` 展开就是
  `(share_scope = 'shared' OR created_by = viewer)`——**不含 `deleted_at IS NULL`**。
  全文件唯一那处 `deleted_at IS NULL` 在 `visibility.ts:80`，是给 search 单独补的。
- 后果：复习队列、仪表盘计数、星图继续含这些卡，而点开证据来源是 404
  （`GET /notes/:id` 用 `isNull(deletedAt)`，`service.ts:512,572`——行号已在 2026-09-23 复核）。
  **产品承诺的"每条理解都有来源"在这里静默变成一条死链。**

> **量过的数字（2026-09-23，dev 库只读）**：879 篇笔记里软删 10 篇，
> 其中 **8 篇有 V2 卡引用它的 `note_versions`**（任意 lifecycle）、**2 篇的卡还是 `active`**。
> 也就是说这不是假想场景：这 2 篇一到 30 天保留期，L16（卡活着、来源 404）与 L17（删不掉）会同时成立。


### L17 同一个笔记永远删不掉 【核过→删不动这一半今天有测试钉住；外键未动，理由在 §13 末段】

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

### L21 证据链的三个洞 【核过→§2 已修；§1 等产品口径；§3 量出来不是接线活（见 §13）】

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

### L23 "待复习"有四个谓词，其中一个没人读 【已核过（原文两个说法我更正见 §13）→用户可见那一半已修】

- 首页"N 项待复习" = `dashboard.counts.reviewsDue`（due + defer + consumable，
  `room-projection.ts:137`、`HomeV2Experience.tsx:660`）；
  StudySurface 的"待复习" = `stats.pendingReviewCount`（**全部 pending**，不判 due、不判 defer，
  `stats/service.ts:150-169`）；另有 `objectiveReviewDueCount`（`stats/service.ts:85-103`）算出来发出去
  但**只有两个集测读它**，渲染无处用。**我原文说"路由注释还写桌面端在读它"是不准确的，撤回**
  （`stats/routes.ts:10` 那句讲的是端点，不是这一列）；而 gateway 只调
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

### L41 桌面测试读的不是那份合同：`sharedAlias` 只装在构建里，没装进 vitest 【核过，本轮已修】

- 同一份 `@ailearn/shared` 契约，桌面端有**两条解析路**：
  `electron.vite.config.ts:74` 的 `sharedAlias` 把 main/preload/renderer 三条都指到
  `packages/shared/src`（实时源码），而 `vitest.config.ts` 只有 `prosemirror-model` 一条别名，
  `@ailearn/shared/*` 走 `node_modules` —— **pnpm 对 `file:` 依赖的安装期快照**。
  类型侧更怪：`tsconfig.web/node.json` 的 `paths` 指向源码，所以 `npm run typecheck` 读源码、
  `npm test` 读快照，两边可以各自都"对"，而绿的不是同一份代码。
- 机制要说准：没编辑过的文件是**硬链接**，内容跟着源码走；一旦某个文件被编辑过，
  编辑器写的是新 inode，快照里就留下编辑**之前**的那一份。所以漂移恰好落在
  "最后一次 `pnpm install` 之后动过的那几个文件"上——正是最需要被测到的那一份。
  实测：此刻 `packages/shared/src` 有 11 个改动文件，`diff -rq` 快照 vs 源码 = **4 个内容不同**
  （`capability-bundle`、`companion-proactive-policy`、`companion-shell-contracts`、
  `desktop-surface-contracts`），全部是本轮动过的。
- **这条比看起来更坏的一半**：`pnpm install` 一次，红就自己消失。一条会自己好了的红，
  比一条常红的更容易被归错因。
- 症状（当场量到的）：L15 新导出的 `answerModeToResponsePreference` 在快照里根本不存在，
  渲染层调用它抛 `TypeError`，异常被点击处理器的 `void` 吞掉，测试只报
  `learningRun.start 调用 0 次`。我第一次把它归给了"状态没 flush"，方向整个错了。
- 处置：别名抽到 `apps/desktop-client/shared-alias.ts` 一份，两个配置共用；
  接完桌面 **171 文件 / 1429 条全绿**（上一轮记的 1423/1425 那 2 条红不在了）。

### L42 候选交付有人读、却从不结账：`assistant_deliveries` 的四个终态在整库里是 0 行 【核过（我第一版把它写反了）】

**先记我自己那次误判**：这一条我最初写的是"worker 每天写没人读的交付行，建议按
`AGENTS.md` 删掉"。那句话说错了方向——判据我抓的是 `assistant_deliveries.kind` 这一列的
字面值，而**真正被读的是 `payload_ref.kind`**。桌面在
`desktop-gateway.ts:336-348` 按 `payload.kind === "memory_item"` 出文案
「有一条记忆候选等待查看」并把 target 指到那条记忆（`:346-348`），
而抽取器写的 `payload_ref` 正是 `{kind:"memory_item", memoryItemId, contentPreview}`；
读它的界面在 `companion-center-surface.tsx:332`（伴星中心的活动条）。
**这条路是通的。差点被我删掉的是唯一一个能让候选到达用户的东西。**

量过的数字（2026-09-23，dev 库只读）：`memory_candidate` 交付 **99 行**，
状态分布 `queued=42 / displayed=57`，**四个终态 `acted`/`dismissed`/`suppressed`/`expired` 整表 0 行**。
57 条 `displayed` 说明展示端在跑；0 条终态说明**没有人在用完之后结账**。

- 真正的断口在这里：用户在伴星中心看到那条候选，然后去记忆管理页确认或忽略它——
  `confirmMemory` / `dismissMemory`（`memory-service.ts`）**一个字节都不碰 `assistant_deliveries`**。
  那条候选交付于是永远停在 `displayed`，`acted`/`dismissed` 两个终态**语义早就定义好了
  （`delivery-service.ts:28`）却没有一个写入者**。
- 顺带两处说谎的文案：`memory-service.ts:343` "气泡内 30 天不重复弹出"、
  `memory-routes.ts:13` "忽略（30 天不弹）"。库里 `expires_at` 确实用作读侧窗口
  （`home-projection-service.ts:401` 的 `gt(expiresAt, now)`），但**忽略不影响这条交付**，
  所以"不重复弹出"不成立——被忽略的那条候选仍会在活动条里排到 30 天期满。
- 处置（本轮按这条做）：**把已有的两个终态接到已有的两个动作上**——记忆被确认 → 对应候选交付
  `acted`；被忽略 → `dismissed`。写状态这件事留在 `delivery-service.ts` 里（那张表的
  状态机归它），记忆侧只调用它，避免第二个写者。`suppressed`/`expired` 仍无人写，
  那是 L25–L29 那一簇的事，不在这里顺手改枚举。

### L43 四条 `DATABASE_URL*` 用的都是超户：所谓"以受限角色连"在这台机器上不成立 【核过（真角色量过）】

- **权威出处是 `docker-compose.dev.yml:9-15`，不是谁的本地 `.env`**（我第一版拿 `.env` 说事，
  那只是同一件事在宿主机上的倒影）：`DATABASE_URL`、`_MIGRATOR`、**`_API`** 三条全是
  `postgres://ailearn:…`（superuser + BYPASSRLS），只有 `DATABASE_URL_WORKER` 用的是
  `ailearn_worker`，而且那里写着注释："Worker must use the restricted role;
  learning-session outbox RLS grants queue-wide claim access only to ailearn_worker"。
- 于是 blindfold 是**不对称的**：同一个仓库、同一个 dev 栈里，worker 侧的 RLS 是真在生效的
  （它的每个断言都在受限角色下跑），API 侧不是。凡是"API 读得到/读不到"的结论，
  在换角色之前都不是证据——**而 `DATABASE_URL_API` 这个变量名本身在骗人**：它换的只是变量名，
  角色没换。doc 26/32 写的"验收一律用 `DATABASE_URL_API` 连"因此是一条**看着像做了、实际没做**的规矩。
- **边界要说准：这条只适用于 dev。**
- **顺手拿到的一条真角色证据**：`companion-memory-routes-http-postgres.integration.ts`
  （18 条 `/companion/memory*` 路由）在 `DATABASE_URL_API=ailearn_api` 下 **9/9 全绿**。
  这条以前只在超户下跑过，所以"记忆路由在受限角色下能用"此前是没证过的。
 CI 是真的在受限角色下跑
  （`.github/workflows/ci.yml:384-387` 四条 URL 分别是 `ailearn` / `ailearn_migrator` /
  `ailearn_api` / `ailearn_worker`），所以"这套代码在 `ailearn_api` 下能跑通"在 CI 里已经被证过一遍；
  dev 与 CI 的差别就是这一条 blindfold 的全部来源。
- 少数集测自己补了这一层（`workspace-collab-postgres.integration.ts:531`、
  `note-document-state-postgres.integration.ts:371` 用 `SET LOCAL ROLE ailearn_api`）——
  **只有那几条算真角色证据**，其余"用 _API 跑过"都要按 §1.2 判据打折。

**真角色下量到的东西（2026-09-23，只读：superuser 连接里 `SET LOCAL ROLE` + `ROLLBACK`，一条都不写）**

| 问的是什么 | 结果 |
|---|---|
| `ailearn_api` 有没有绕权限 | `rolbypassrls = false` |
| 不设上下文时五张 FORCE RLS 表能读几行 | notes / ai_audit_log / assistant_deliveries / assistant_memory_items / learning_objectives_v2 **全是 0** |
| 设了 `app.workspace_id`+`app.user_id` 之后 | 本空间 notes 12 行；**别的空间 0 行**；本空间 `ai_audit_log` 2168 行可读 |
| L42 的 jsonb 反查在真角色下挑中谁 | 该空间 99 条活跃候选交付（`displayed` 57 + `queued` 42），且只挑指向那条记忆的 |

三点结论：① L37 那一类"裸 `db` 读 FORCE 表"在生产角色下的读数是 **0 行**，不是"看起来没事"；
② L3 那条修好的审计读数在真角色下确实读得到东西（2168 行），不是只在超户下"能跑"；
③ **这条把"要先换 `compose:10` 才能做真角色验收"这个前提推翻了**——`SET LOCAL ROLE` 不需要
知道 api 角色的密码，也不需要动任何人在用的连接串。共享基础设施那一步（compose 换角色）
仍然是一个独立决定，但它不再是验收的前置条件。方法记在 §12。

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

## 7. 逐条状态与当初的排期（状态是 2026-09-23 重量的，排期原文留在下面）

### 7.0 现在到底做到哪一条了

43 条里：**已交 27 / 部分 4 / 未动 12**。未动的 12 条里：1 条等拍板（L6 空间所有权的出口）、
2 条必须真窗口量（L4 长连接凭据、L5 本机 CRDT 副本），其余 9 条按 `AGENTS.md` 属"要么删净要么补上"、只是排期在后面——不要把这张表读成"剩下的都要问用户"。
10 条是排期靠后——不要把这张表读成"剩下的都要问用户"。
（2026-09-23 这一天分两截：前一截交 L21 §2 + L16、L17 的"能确定的那一半"、L23 的用户可见那一格；
后一截按用户令"先改红的那些"，把"换角色会红"的 6 份套件逐个改绿、顺手抓出两条与角色无关的过期断言，
然后才换 `compose:10` ⇒ **L37 整条闭上**。见 §13 末两段。）

| 状态 | 条目 | 这一格的确切含义 |
|---|---|---|
| **已交**（27） | L1 L2 L3 L7 L8 L9 L10 L11 L12 L13 L14 L15 L16 L17 L24 L30 L31 L32 L33 L34 L35 L37 L38 L40 L41 L42 L43 | 修法落地，且每条都做过"抽掉修法它会红"的复验；细节与验收层在 §13。L10/L11 的迁移 `0270` **没有在共享 dev 库上执行过**（只读跑过那条候选 SELECT），这一条要留在账上。L16 走的是**派生判据**（来源笔记活着才服务），四个读点、真角色下两种断言方向各复验过。**L37 现在整条闭上**：症状侧（L2/L3/6 小时扫描/CLI）先修，环境侧（`compose:10` 的 API 串换成 `ailearn_api`）在这一轮换掉——换之前先把"换角色会红"的那批集测逐个改绿（红的根因是**夹具自己**连了受限角色、原生写不带 `app.workspace_id`），并量过 `ailearn_api` 对每张表都有 SELECT。**没有重启在跑的容器**，下一次 `docker compose up -d` 才落到新串 |
| **部分**（4） | **L21** **L23** L29 L36 | L14：召回过滤 + 抽取器同文守卫已交，"改写型重复算不算同一条"欠一句产品口径；**L17：候选扫描的 ORDER BY 与"删不动/删失败"分开计已交，还有一条新集测把"生成过卡的那一篇今天删不掉"钉成断言——外键那一步没动，理由写在 §13 末段（置空会把卡放回队列）**；**L21：§2（预览复算哈希 + 三态落点进合同与界面）已交，§1 欠产品口径，§3 量出来后不是接线活（redaction 没有服务侧读者）**；L29：读侧与词汇表门禁已交，删 `jobs` 那三个写不出来的枚举值/列没做；L30 整条已结（用户明确不强推、不管历史里的密钥）；L36：两个零消费者 env 键已删、一条误读已撤，`clearNote` 与主进程第二套导航栈待"删还是接"；**L23：用户可见那一格已闭上（"待复习"与复习列表同一条 predicate、集测断言写成等式），欠的只剩响应里那一列没人读的 `objectiveReviewDueCount`** |
| **未动·口径已定等实施**（1） | L38 | 用户 2026-09-23 拍了：笔记与卡留原空间、**记忆跟人走，退出时只收掉 `scope='workspace'` 那一份**（走 `deleted_at`）。缺的只是实施：一支 SECURITY DEFINER 迁移 + leave/remove 两个落点，前置约束写在 §13 末段。 |
| **未动·等拍板**（1） | L6 | 只剩这一处真是要人拍板：owner 既不能退也不能交（转让有 service 与路由、客户端零消费，也没有删除空间的端点）。仍归 `32-workspace-dissolve-design` 那条线，别在这里另起一版 |
| **未动·要量**（2） | L4 L5 | 都要真窗口：L4 是被移出空间后长连接还能不能写（改的是热路径 + 共享的协同栈），L5 是恢复/删除后本机那份 CRDT 副本还剩什么。没量之前修＝在猜 |
| **未动·欠接线或欠口径**（9） | L18 L19 L20 L22 L25 L26 L27 L28 L39 | 九条都按 `AGENTS.md` 属"要么删净要么补上"，删的代价是要不要留那些列/控件/表（L20 是一张只写不读的表 + 一个上报端点，L22 是五条账号开关 + 界面控件），所以仍列在这里而不是自己动手。L23 已核过并交了用户可见那一半，见上一行 |

### 7.1 写下时的排期（2026-09-22；保留原文，因为它解释了分批的理由）

**批次 A｜纯接线，改完能当场验**
L1 补 IPC handler、L7 补重新解析端点、L8 把 fanout 加进 roles.sql 白名单、
L9 给 Drizzle 补 `global_key`（**按今天的量它是潜伏项，排在 L8 后面即可**，见 L9 第二条）、
L40 补上缺的两个审计写入方（`workspace.member_removed`、`export.note`）。
验收：每条写一个"缺它时会红"的断言（L1 用"渠道 → handler 一一对应"的表驱动测试，不许再用 `vi.fn()` 替身；
L8 用一条以 `ailearn_worker` 身份执行的 `EXECUTE` 冒烟），而不是只加日志。

**批次 B｜只有生产会坏的那一类，先修角色这一根，再修症状**（症状侧已全部落地；
"先换 compose 再验收"这个顺序后来被 L43 推翻，见 §7.0 的 L37 那一格）
**L37 是本批的根，L2/L3/L17 的一半都是它的症状。** 顺序：
① 让 dev 的 API 也用 `ailearn_api`（`docker-compose.dev.yml:10`）——**这一步要用户点头**，
因为换角色会让所有人当前的 dev 当场变红（那是好事，但共享环境不该被审计会话单方面改）；
② ~~把约 21 处裸 `db` 逐条判~~ **已完成**，判定表在 §1.2 ③：三处真死的全修了，
   其余 16 处逐条给了"为什么无事"的依据。
③ 修 L2/L3 两个已知引信 + L37 症状 A（外层扫描与 CLI）。
**验收口径**：凡依赖 RLS 的断言，必须显式以 `ailearn_api` 连；且**红绿要按断言方向分开报**——
"该被拒"的用例在读不到东西时全绿，这不是通过（L37 症状 B 那 4 条就是）。

**批次 C｜门禁补齐**（已交：L10–L15 全部落地，矩阵那一格除外——`evaluateProactivePolicy` 现在是
唯一实现，但"8 条触达路 × 7 个开关"的逐格表我没产完，缺的格写在 §13 各条的"诚实的残余"里）
L10/L11/L12：把"能触达用户的每一条路"列成矩阵（回答 / 念头 / 日记 / 提醒 / 气泡 / SSE / 系统通知 / 语音），
行是七个开关，逐格填"谁在哪一行判的"；L12 那个没人调用的 `evaluateProactivePolicy` 应当成为矩阵的唯一实现。
L13 要么补语音门，要么把 `PRODUCT.md:50` 那句话改小。
**同批带上 L14 与 L15**：它们不是漏了一个分支，而是**整条开关没有执行者**——
L14（记忆"忽略"没人据此排除）缺的是召回查询里那一句 `IS NULL`；
L15 的两个症状（正式测评语音门是死的、作答模态偏好纯展示）缺的是服务端那一半
——客户端挡显示不算门，`action-resolver.ts:39,85` 那两处硬写的 `"adaptive"` 要改成读真值。
**矩阵里任何一格填不满，就别宣称这个开关存在。**

**批次 D｜需要你定产品口径，代码动不了**（**这句话当时就写重了**：L30 的一半、L21 的两处接线
都不需要口径；真正动不了的只有 L6/L16/L17/L38 那一组归属决定与 `protectedQuoteRef`。已交/未动见 §7.0）
L16/L17（笔记删除的双向断链，且 L17 卡住的是"用户能不能真正删掉自己的数据"）、
L18/L19（"还缺什么"和"稍后"到底算不算承诺）、L23（一个读数的唯一来源）、
L30（删文件 + 轮换哪些 key）、L6（以 `32-workspace-dissolve-design` 为准）、
L21（证据链三洞：预览复算哈希与"删除即撤销证据"是补调用点的活，但 `protectedQuoteRef` 到底要不要真做成
可解析的不可变副本，是一个产品决定——现在它写着"不可变副本"却指向一个随机 uuid，**要么实现、要么把
合同里那句话删掉**）、L38（退出/被移出之后的数据归属：收口判据与归属矩阵缺的那一列都写在条目里，
设计本体在 doc 32。这条不定，那 9 支迁移 + 十来处站点会继续一个个长出来）。

**批次 E｜登记为"要么删掉、要么补上"，不许停在中间态**（这一批里已交：L24 L29（读侧）L32 L33 L34 L35
（改定性 + 对账门禁）L36（一半）L41；未动：L4 L5 L20 L22 L25 L26 L27 L28 L39。
"不许停在中间态"这条现在也约束我自己：下面这几条我留在中间态是因为**量过之后发现两个方向都要动共享
基础设施或界面承诺**，不是因为没查）
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
- ~~L17：purge 的 `LIMIT 50` 是否已经被不可删的行占满 —— 要一次只读 SQL 统计（本轮没跑任何 DB 命令）。~~
  **已量（2026-09-23，dev 库只读，见 §13 末段的数字表）**：候选 0 条、`LIMIT 50` 没被占满，
  但**不是因为机制好**——是因为库里最老的软删笔记只有 6.0 天，30 天窗口到今天一次都没到期。
  已有 2 条软删笔记带着 `lifecycle='active'` 的 V2 卡：它们一到 30 天，L17 就从"推论"变成事实。
- L31/L32：CI 那道锁到底是红着还是不执行 —— 要一次真实 workflow 运行记录。
- L34 的 `'unsafe-eval'`：要确认打包后是哪条链路依赖它。
- L37 症状 B 那组 A/B（16 全过 vs 4 过 13 红）**我没有重跑**——跑它要往共享 dev 库写数据，
  而这里正有并发会话在跑集测。数字算"他们量过、方法我认可"，收录为【未核】。
  谁要复跑：同一份 `note-collaboration-postgres.integration.ts`，只换 `DATABASE_URL_API` 的角色
  （`ailearn` ↔ `ailearn_api`，宿主侧连 `127.0.0.1`），**并且把"该拒的"和"该收的"两类断言分开报**。
- ~~L37/B 批真正欠的那张表~~ **已交**：20 处裸 `db` 全部判完，见 §1.2 ③。

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
- 迁移漏 journal：**没有漏**（2026-09-23 重数：**272 支 `.sql` ↔ 272 条 entry**，`idx` 连续、
  `tag` 前缀与文件序逐位一致，双向零缺失）：
  两侧零缺失、idx 连续 0–267（我自己数的，不信 agent 的数）。

**仍然有效的旧账**：doc 26 的 B-1/B-4（本轮 L14，"忽略 30 天不弹"从未实现）、C-1（"不再提醒这类"，
本轮 `grep cue_class` 仍零命中）、C-2（日记调度漏跑无补救）、C-3（多用户工作区计数串味，本轮 L23 的
同族）、D-3（失败结算 UPDATE 仅按 id 可与用户 end 竞态翻转终态，本轮未重验）。

## 11. 已核对且确实闭环的部分

不是一片坏消息，下面这些是两端都查到人的。**一句口径说明**：本节里 272/272 journal（每有人加迁移都要重数一遍，
> 数法就是「文件列表 vs journal `tag` 列表」双向差集）、
`proactive_muted` 16 处、`dismissed_at` 无排除、CI 那 1 个缺失文件、裸 `db` 三处、
音色 3+1、`SCENE_VARIANT` 零读取，是我自己重跑的；`157 个 handler`、`107 张表`、`131 个 tmp 脚本`、
`JobType 7/7` 这几个数是数据层/桌面/配置三路 agent 报的，**我没有逐个数过**，引用前先复算。

- **迁移与合同层**：272/272 journal 对齐（2026-09-23 重数）；`migrate.ts` 按 `entry.tag` 解析 `<tag>.sql` 并逐条比 sha256
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


**只读 SQL 普查（L16/L17/L42 那些数字怎么复算的）**：一条都不写，宿主上跑
（`DATABASE_URL*` 里的主机名是 docker 内的，换成 `127.0.0.1` 才连得上）：

```bash
cd workers/ai-worker && node --env-file=../../.env <上面的只读脚本>
```

脚本只做这几问，逐条可以直接手敲：`notes` 总数与 `deleted_at IS NOT NULL` 的条数与最老年龄；
软删笔记里有多少被 `learning_cards_v2.note_version_id` 引用（任意/仅 `active`）；
`assistant_deliveries` 按 `state` 与按 `kind` 的分布；`assistant_memory_items.dismissed_at` 非空条数。
**跑法要点**：用 `DATABASE_URL_WORKER`（受限角色）而不是 migrator 那条，否则等于在
BYPASSRLS 下数东西；以及这类探针**必须带正面控制**（本轮是 `similarity(x,x)=1.000` 与
无关文本 `=0.000` 两个锚点），只报"跑通了"不算量到。


**真角色（受限角色）怎么验——不需要改 compose，也不需要 api 角色的密码**：以 superuser 连接开一个
事务，进去第一句 `SET LOCAL ROLE ailearn_api`，要测哪条路径就照那条路径的 `set_config` 形状设上下文，
最后 `ROLLBACK`。角色只在事务内切换，事务结束自动还原，**一条数据都不写**：

```sql
BEGIN;
SET LOCAL ROLE ailearn_api;                       -- rolbypassrls = false，RLS 从此生效
SELECT set_config('app.workspace_id', '<uuid>', true),
       set_config('app.user_id',      '<uuid>', true);
SELECT count(*) FROM notes;                        -- 与不带上下文时对照
ROLLBACK;
```

两问必量：① **不设**上下文时那张 FORCE RLS 表读到几行（应当 0；读到东西就是 fail-open）；
② 设了 A 空间上下文后读 B 空间的行（应当 0）。L43 那张表就是这么量出来的，
`workspace-collab-postgres.integration.ts:521-536` 是同一方法在集测里的既有写法。


**一条命令复跑这些"当时数过"的仓库不变量**：

```bash
node scripts/check-loop-closure-invariants.mjs   # 只读、不连库；非 0 = 至少一条不成立
```

它数这五件：迁移↔journal 双向对齐（现值 272/272）、JobType↔worker HANDERS 双向（7↔7）、
`purpose='formal'` 全仓只有一份 SQL、SQL 里的 `similarity()` 都引用共用阈值、
桌面 vitest 与构建共用 `sharedAlias`（L41 那条修法没人守着）。
**两条拆机制复验做过**：给 `JobType` 加一个没有处理器的成员 → 第 2 条红并点名它；
从 `vitest.config.ts` 摘掉 `...sharedAlias` → 第 5 条红。还原后 5/5 成立、shared 与 desktop typecheck 各 0 错。
（做这两处 mutation 时用的是"备份→改→跑→按备份还原"，跑完 `git diff --stat` 确认
`packages/shared/src/enums.ts` 已回到与 HEAD 一致、没有覆盖掉并行会话的改动。）

## 13. 实施日志（2026-09-22 起，用户令"一次性做完"）
**口径**：每子项做完必须同时满足 ①该包 typecheck 0 错 ②新增断言做过"抽掉修法它会红"的复验
③不跑共享 dev 库上的 postgres 集测（并发会话在跑），要跑只跑纯单测。

### 批次 A｜已完成

| 项 | 落点 | 验证 |
|---|---|---|
| L1 | `desktop-ipc.ts` 注册 `noteDocSyncTitle` handler（+ 输入 schema） | 新文件 `desktop-ipc-channel-coverage.test.ts`：表驱动断言"契约声明的每条通道要么注册、要么在写明理由的两条豁免名单里"。**已做反向复验**：注释掉注册 → 4 条全红且点名该通道 |
| L7 | 服务端 `POST /sources/:id/reparse`（`source/service.ts:reparseSource`）+ 网关 `reparseSource` + IPC 通道 + preload + 契约 + 来源详情那颗「重新解析」按钮 | `source-detail-reparse.test.tsx` 5/5：failed/processing 才出现、点下去真打到通道、409 回"已经有任务在跑"、成员只读不摆按钮。**过程中改掉一处我自己写的坏味**：本来用 `message.includes("conflict")` 判冲突，改成认 `RendererGatewayError.code` |
| L8 | `infra/postgres/roles.sql`：补 `ailearn_fanout_global_companion_memory` 的 GRANT + 进 worker 预期权限清单；**并新增反向断言**——22 条"应用显式调用的函数 × 角色"缺任一即 `RAISE EXCEPTION` | 那份必需清单先用脚本对过文件里实际的 GRANT 对：一开始我写错 1 条（`find_resumable_companion_journey` 授给 worker，实为 api），已改；现在 22/22 对得上 |
| L9 | `db-schema/assistant-memory.ts` 补 `globalKey`；`memory-service.ts` 三条路径都写它（新建 global 认领自身 id、改成 global 时补认领、纠正时**继承**旧 key） | `memory-service-global-key.test.ts` 4/4（纯替身，不连库）。**反向复验**：把 `globalKey:` 改成常量 null → 2 条红（expected id / expected oldKey） |
| L40 | `invite-service.ts:removeMember` 同事务写 `workspace.member_removed`；`export/routes.ts` 单篇导出包进事务并写 `export.note` | api 全套 1469/1470 pass、0 fail |
| 附带 | `content-workspace-transaction.test.ts` 的 source 计数 7→8 | 这是**我撞出来的红**：那条断言数"路由数 == 事务边界数"，两个数一起动正是它要的形状 |

**当前绿灯**：desktop `npx vitest run` 166 文件 / 1390 用例全过（另有 2 条 jsdom AudioContext 的
unhandled error，非用例失败）+ `npm run typecheck` exit 0；api `npm test` 1470 tests / 0 fail。
注：跑全量时见过一次 `learning-run-surface.result.test.tsx` 红，单独跑与重跑全量都绿——
判为跨文件顺序抖动，归给并行会话在改的那份文件，不记在我账上也不修它。

### 批次 B｜已完成（三处症状 + 20 处裸 `db` 判定表；环境侧那一手独立记在 L43）

| 项 | 落点 | 状态 |
|---|---|---|
| L2 | `note/collaboration.ts:97` 握手那次读改走 `withWorkspaceTransaction`（用 `decodeToken` 已给的 workspace/user），并删掉不再使用的 `db` import | 已改，api typecheck 0 错、1469/1470 单测 0 红。**写下这格时"没在真角色下验过"，2026-09-23 已补**：`SET LOCAL ROLE ailearn_api` 下带上下文/无上下文两种读法各量过，见 §13 的 L43 段 |
| L3 | `identity/service.ts:listAIAuditLog` 两条查询包进同一事务；签名多收一个 `userId`，`routes.ts:492` 已跟着传 | 同上，真角色证据同 L43 段（本空间审计 2168 行可读、跨空间 0 行）。**另一半也已接**：设置页那句"供你回看"现在走一条真 IPC 通道读服务端那一页，见 §13 末段 |
| L37 症状 A | `note/maintenance.ts` 的 6 小时外层候选扫描改成**按空间枚举后各自带上下文扫**（`workspaces` 的守卫有 NULL 分支所以能裸枚举，`notes` 没有所以必须进去扫），50 条上限保留 | 已改 + 补 `workspaces` import。CLI 那一半（`scripts/cleanup-soft-deleted-notes.ts`）**同一形状已补**：`loadStaleNoteBatch(cutoff, cursor, workspaceId)`，外层按空间各跑一条键集游标——见下面"已完成" |

**已完成（本轮）**：① CLI 那半——`loadStaleNoteBatch(cutoff, cursor, workspaceId)` 把 workspaceId
变成参数、外层按空间各跑一条键集游标，翻页语义不变；② 约 20 处裸 `db` 全部判完（表在 §1.2 ③）。

**仍欠一手**：④ `docker-compose.dev.yml:10` 换 `ailearn_api`——
**换之前必须先在真角色下跑一遍 postgres 集测**，那是共享环境，红了会影响所有人。

**③ 已落地（2026-09-23）**：桌面端那句"供你回看"现在真有一个读端了，四处一起接，
细节与验收记在 §13 末段（只补契约不注册 handler 就是 L1 那个失败形状，所以当时退回未落）。

### 批次 C｜已交（L10–L15 六条；下面这批 bullet 是当时的过程记录，最后落点以 §13 后面各条为准）

- **L14 召回过滤已修**：`companion-memory-vector.ts` 两条召回路径（向量检索 + 关键词降级）
  各补 `dismissed_at IS NULL`，判据与 `deleted_at` 同一句。worker typecheck 0 错、773/773 全过。
  **自己踩的坑记一笔**：注释里写了反引号，把 SQL 模板串当场截断——与
  `feedback-css-comment-slash-trap` 是同一族（注释里的定界符会吃掉后面的代码）。
  第一次跑出来的"5 红"也不是回归，是那份测试文件根本没被加载：
  **红要先问它是不是加载失败，再归因给谁**。
  **仍欠**：忽略过的候选下一轮仍会被重新抽出来（要新迁移 + 抽取器守卫）——
  这条不做成"可选参数默认旧行为"的假活。
- **L15 作答模态偏好已接线**（`silent` 那一格不用"等用户定"——代码里已经写了三遍它是什么，
  我上轮记的 `silent→text` **作废**，判据与剩余的一半见 §13）。这一条的坑不在映射表，
  在事务形状：`getAnswerModePreference` 自己开事务、三个装配点里两个在逐个目标的循环内，
  所以新抽了一个收执行器的 `readAnswerModePreference(tx, userId)`，各在循环外读一次。
  **过程中多找到一处第二来源**：`ReviewSurface.tsx:694` 也硬写着 `"adaptive"`，
  复习那条路不走目标表面，只修 resolver 会留下半条 L15。
  接这处的时候当场量出 **L41**：桌面 vitest 读的是 shared 的安装期快照，不是源码。
- **L13 已修**：新增 `identity/ai-consent-gate.ts`（`hasExternalAiConsent` + `requireAiConsent`），
  挂到三条真会外发内容的语音端点（`/voice/tts`、`/voice/tts/stream`、`/voice/transcribe`）；
  `/voice/preference` 与 `playback-outcome` 不外发内容，不挂。判据沿用
  `invite-service.ts:714` 那句 `consentAt && consentVersion`，**不另写第二份**。
  api typecheck 0 错、全套 1469 过 0 红；新测试 `voice-ai-consent-guard.test.ts` 4 条，
  **反向复验过**：把门从 transcribe 摘掉 → 恰好 1 红并报"可以在没签同意的情况下外发"，
  随后定点改回（不整份覆盖，那文件并发会话也在动）。
  **② 那句"你还没同意"会不会变成重试风暴：查了——不会**，重试本来就有上限
  （`SYNTH_MAX_ATTEMPTS = 3`）。顺手把永久拒绝（`forbidden`/`api_untrusted`/
  `unsupported_contract`）改成**当场放弃不再退避重试**。
  **L13 的下游那一半也已接**（2026-09-23）：403 上的 `ai_consent_required` 现在有专用码、
  专用那句人话，取字节那条路也开始读失败体——四步与那次被既有用例当场抓住的回归记在 §13 末段。
  **测试已补并复验会红**：`companion-voice-playback.test.ts` 新增一条，
  同一条用例里自带对照——"第二句。"瞬时失败必须被送去合成 **3 次**、
  带 `code:"forbidden"` 失败必须只 **1 次**；摘掉那句 `break` 之后它红
  （`expected […,…] to have a length of 1 but got 2`），装回去 30/30 绿。
  我第一版写的两条是假绿（在退避还没跑完时读计数、且第一段走预取），
  已删并重写——**教训记在这里**：观测点必须先证明"它看得见这件事"，再拿它做断言。
- **L12 未动，落点已定死**：`companion-proactive-policy.ts:133` 的 `evaluateProactivePolicy`
  是 `formal_answer_in_progress`/`dedupe_recent`/routine `expired` 的唯一实现，全仓只有它自己
  和它的测试引用它。要做的是把 `companion-thought.ts` 里手搓的那串判定
  （`evaluateRoutineCueTiming`，`:431-464`，它连"是否在正式作答"这个输入都没有）换成调用它，
  并把正式答题 in-progress 状态作为入参传进去。验收形状：矩阵每一格（8 条触达路 × 7 个开关）
  都能指到某一行代码，指不到就不许宣称那个开关存在。
- **L12 复核更正（重要，下轮照这个做）**：`evaluateRoutineCueTiming` **不是**整套规则的手抄副本——
  它已经在用共享的 `proactiveAvailabilityBlocked` / `routineCadenceBlocked` / `isWithinQuietHours`，
  而且顺序是有意排过的（空间静音最前，因为它比账号级时段更具体）。
  真正缺的只有两格：**`formal_answer_in_progress` 和 `dedupe_recent`**。
  所以别整函数替换（那会砸掉已排的序和三条它独有的门：`space_muted`、`quiet_hours`、
  `dismissal_feedback`——这三条 `evaluateProactivePolicy` 的入参里根本没有）。
  可执行的最小修法：① 在 `RoutineCueTimingInput` 上加 `recentShownCount` 与
  `formalAnswerInProgress` 两位；② 用共享的 `POLICY_LIMITS.dedupeWindowLimit`
  判 dedupe（计数别自己发明窗口，`recentDeliveryStates` 里已经有 `displayed` 这一状态）；
  ③ `formal_answer_in_progress` 需要"这个人此刻在不在正式作答"这个信号——
  **调用点在 `companion-thought.ts:782`，那里现在没有这个信号**，要先决定从哪读
  （`learning_runs` 的正式测评态？还是 turn 上的 mode 标记？），这是一个数据源决定，
  不是纯机械接线。
- **L12 已交一半：`dedupe_recent` 接进念头管线**（`companion-thought.ts:evaluateRoutineCueTiming`）。
  计数只认 `displayed`，上限直接取共享的 `POLICY_LIMITS.dedupeWindowLimit`——**没在 worker 里
  再写一个 2**。三条新断言 + 一条反向断言（只展示过一次不许挡、把 `spent/dismissed`
  算进来就是自创第二套判据），**反向复验成立**：摘掉那段 → `expected 'dedupe_recent' /
  actual 'allowed'` 红，装回 773/773 绿、typecheck 0 错。
  **剩最后一格 `formal_answer_in_progress`，数据源已经钉死**：
  `learningRunPrivateContracts.purpose`（取值 `formal | facet | diagnostic | practice`，
  `db-schema/learning-runs.ts:226`）联 `learningRuns.phase`（同一文件 `:118`）的非终态。
  也就是"这个人在这个空间里有一条 purpose=formal 且还没结束的运行"→ 挡。
  要写的就是料取阶段加这一问，喂进 `RoutineCueTimingInput`，其余顺序不动。
- **L12 的洞已闭上（两格都接上了）**：`evaluateRoutineCueTiming` 现在认
  `dedupe_recent`（计数只认 `displayed`，上限取共享 `POLICY_LIMITS`）与
  `formal_answer_in_progress`。后者的信号在料取阶段查：
  `learning_runs` join `learning_run_private_contracts` on `run_id`，
  `purpose='formal'` 且 `phase IN (preparing|active|assessing|checkpoint|committing|paused)`。
  `recoverable_error` **故意不算**——那一刻人不在答题，挡她只会让她更找不到北。
  字段做成**必填**：漏传在编译期就报错，不会退化成"忘了传=可以打扰"。
  worker typecheck 0 错、773/773 全过；两格各自都做过反向复验
  （摘掉对应分支 → 各自那条断言红，报 `expected '…' / actual 'allowed'`）。
  **诚实的残余**：我做的是"把缺的两格补进管线"，不是"让管线改调用
  `evaluateProactivePolicy`"。所以那个策略函数现在仍然没有生产调用方，
  而且 reason 码在两边各有一份（`formal_answer_in_progress`/`dedupe_recent` 同名不同处）。
  按 `AGENTS.md` 这是该处理的：**要么把管线整体改成走那个函数**（它得先接
  `space_muted`/`quiet_hours`/`dismissal_feedback` 三位——现在入参里没有），
  **要么把它的 routine 分支删掉**、只留 `evaluateTriggeredPush` 那一支真在用的。
  留成现在这样=本文批评的"策略写了、执行者在别处"换了个形态。
- **L12 收形完成（管线不再自己判任何一条）**：`space_muted` / `quiet_hours` /
  `dismissal_feedback` 三位进 `ProactivePolicyInput`（**必填**，缺省会在编译期报错，
  不会退化成"忘了传=可以打扰"），`evaluateProactivePolicy` 按那条刻意的顺序实现
  （房间静音 → 设备在不在 → 正式作答 → 过期 → 时段 → 划走反馈 → 去重 → 节奏），
  `companion-thought.ts:evaluateRoutineCueTiming` 降级成**薄适配器**：摆入参、
  把 reasonCode 翻回管线的词汇、detail 只用于那行 silent 日志。
  四条本来只服务于手搓判据的 import（`proactiveAvailabilityBlocked` /
  `isWithinQuietHours` / `routineCadenceBlocked` / `evaluateDismissalFeedback`）已删。
  **单一来源是量出来的，不是宣称的**：把 `space_muted` 在共享函数里的位置挪到
  `dnd` 之后 → **worker** 那条顺序断言红（`expected 'space_muted' / actual 'availability'`）；
  说明 worker 的测试真的在跑共享实现，而不是跑一份副本。
- **L24 已修**：人格页「活跃度」不再写"控制伴星主动出现的频率"，改成
  "她一次说多少、日记写多细。**多久主动开口一次不在这里**——那由账户页的「主动介入」决定"。
  守卫放在 `src/main/companion-center-copy-guard.test.ts`（照仓库既有先例：
  读文件要 `node:fs`，`tsconfig.web.json` 的编译图里没有 Node 类型——我第一版写在
  renderer 侧，typecheck 立刻报 `Cannot find module 'node:fs'`，就是这个原因）。
  三条断言含一条"读不到源文件就必须喊"，防止守卫退化成永远绿的空断言；
  **反向复验成立**：把文案改回原句 → 两条红（`不得再声称…` / `必须把…指回`）。
  desktop typecheck 0 错、相关两套 22 条全过。
  绿灯：shared 371/371 + typecheck 0 错（它的 `base()` 因为三位新必填被 tsc 抓过一次，
  已补并加了 4 条顺序/去重断言）、worker 773/773 + 0 错、api 1473/1474 过 0 红、
  desktop typecheck 0 错（全量仍只有并行会话那 2 条编辑器红）。做完的验收仍然是那张矩阵。
- **L10/L11 已修**：新迁移 `0270_gate_reminders_by_mute_and_account_switches.sql` 给
  `ailearn_fire_due_companion_reminders()` 装上三道门（账号总开关、勿扰/离线、这个空间的静音），
  已注册进 `meta/_journal.json`（重数：**270 个 .sql ↔ 270 条 entry，两侧零缺失**）。
  被挡下的提醒**保持 pending**（不标 fired/missed），所以"静音两小时后再打开"它还会响。
  **有意没装第四道门**：静默时段的窗口判定只在 TS 一侧
  （`companion-proactive-policy.ts:isWithinQuietHours`），SQL 里目前只有时区；
  在这儿重写一份窗口=同一规则两个来源。而且提醒是用户自己许下的约定，
  "夜里到点就吞掉"与"到点提醒"互相矛盾，要做的是"静默结束后补发"，那是产品决定——
  理由写进迁移文件头部，不当秘密欠着。
  **验证到哪一步**：迁移没在共享 dev 库上执行（那会改到并发会话的环境），
  但整条候选 SELECT 与 `presence` 表达式都**只读跑过**：
  `{"presence":"dnd"}`→挡、裸 `"offline"`→挡、jsonb `null`→放行、当前全部真实行→放行
  （即今天行为不变）；文件还做了一次 lint——我第一版把注释写成 `──` 开头（制表符不是 `--`），
  那会让整支迁移语法错，已修；`presence` 我最初当 text 比较，实为 **jsonb**，
  直接比字符串会在每次调用时炸，也已修。

**B 批当时的"下一手"清单（留在原处，勾掉用不上了）**：1–4 **全部已交**（1=L2、2=L3 两半、
3=外层扫描 + CLI、4=§1.2 ③ 那张 20 行判定表），5 与它耦合的那半已改判：第 3 手"修完才会暴露
`onDelete:'restrict'`"这个警告是**对的**，所以我这一轮先去做的那件事不是换角色，
而是去读那条清除路径**在真会撞上 FK 的时候到底怎么表现**（见 §13 末段 L17 那一手）。

1. `note/collaboration.ts:97` 握手那次裸 `db.query.notes.findFirst` 挪进带上下文的事务
   （`decodeToken` 已经给出 `session.workspaceId`，可用 `withWorkspaceTransaction` 包住这一次读；
   别改 `notes` 的 RESTRICTIVE 守卫去开 NULL 支——那等于把隔离拆掉）。
2. `identity/service.ts:listAIAuditLog` 同样裸读 → 包上下文；顺带补桌面端读它的入口
   （否则修的是没人看的数）。
3. `note/maintenance.ts:34-41` 外层候选扫描 + `scripts/cleanup-soft-deleted-notes.ts:74,118` 补上下文
   （L37 症状 A）。**注意**：这条修完才会真正暴露 L17 那个 `onDelete:"restrict"` 的 FK——
   两半要一起处理，否则从"永远不跑"变成"每 6 小时抛一次错"。
4. 剩余约 19 处裸 `db` 逐条按 §1.2 ② 的 `pg_policy` 判据过一遍，产出"有事/无事"清单写回本文。
5. 最后一步才动 `docker-compose.dev.yml:10`（用户已授权实施；这一条会改变所有人的 dev 行为）。

### L31 已修 + 变成仓库自带的门禁（2026-09-22 实施轮）

- `apps/api/package.json` 里 `assistant-deliveries-kind-constraint-postgres.integration.ts`
  改回盘上的真名（少了 `-postgres` 后缀）；`ci.yml` 里指向已不存在的
  `db-commit-port.integration.ts` 那行删掉，步骤名同步改成它真正验的东西
  （`Verify migration state against real PostgreSQL`），并在注释里写明
  "要恢复 commit-port 那道检查得先把测试写回来，这里是删死引用、不是降级检查"。
- 新增 `apps/api/src/__tests__/ci-test-file-references.test.ts`：把"CI 与 npm 脚本点名的
  集测文件必须存在"变成一条跟着 api 单元 job 一起跑的门禁（不新增 workflow 步骤，
  免得又一个没人看的 job）。51 条用例，含一条"清单不得少于 20 条"的反向断言——
  数错仓库层级时清单会是空的，空清单能一路绿到底。
  **反向复验**：把不存在的名字塞回 package.json → 1 条红并点名文件；还原后 51/51 绿。
  api 全套 1525 条 / 0 红，typecheck 0 错。
- **过程中的一次误报值得记**：我第一版检查器把 `queue-postgres.integration.ts` 报成死引用，
  实际它在 `workers/ai-worker/` 下——那一步有 `working-directory`。凡是"引用不存在"的结论，
  先证明你是按哪个目录解析的。

### L32 已修 + 一条新的文档门禁（2026-09-22 实施轮）

- 三处治理文档的假话改光：`PRODUCT.md:54`、`PRODUCT.md:84`、`DESIGN.md:23`、
  `docs/feature-flag-inventory.md:98`。事实是——全仓没有任何地方读
  `VITE_HOME_SCENE_VARIANT`（唯一命中是 `apps/desktop-client/package.json:19` 的截图脚本赋值），
  `HomeV2Provider` 在 `App.tsx:145` 无条件挂载，`apps/desktop-client` 下**没有任何 `.env*` 文件**
  （inventory 原先写的"dev 的 `.env.development` 为 v2"也是假的），`TaskSurface` 仍挂在 `App.tsx:139`。
  顺带把同段里与 L35 冲突的两处旧句一并对齐（"尚未迁入的能力显示 pending 说明"→ 改成原则保留、
  当前无入口处于该状态）。
- 新门禁 `src/main/docs-vite-vars-have-readers.test.ts`：文档点名的每个 `VITE_*` 变量，
  要么在桌面端源码里有**非测试**读取点，要么就在那一行明说它不存在。
  两条设计细节都是被自己的错误逼出来的：
  ① 读取点搜索必须排除 `*.test.ts` —— 第一版没排除，**守卫匹配到了它自己**，永远绿；
  ② 三个文档路径必须都读得到，少一个就报（第一版用 `existsSync` 静默跳过，
  `docs/feature-flag-inventory.md` 根本没解析到，元断言还是绿的）。
  **反向复验**：往 DESIGN.md 追加一行只提变量名、不声明不存在的句子 → 那条断言红；
  还原后 2/2 绿、`npm run typecheck` exit 0、`src/main` 两套 210/210 连过两次。
- **我自己制造又当场收拾掉的一处污染，记在这里不遮**：还原 DESIGN.md 时把 `cp` 的目标写成
  `../DESIGN.md`（从 `apps/desktop-client` 看是 `apps/DESIGN.md`），结果真文件里的临时行没删掉、
  还在 `apps/` 下多生成了一个未跟踪文件。已定点删除那一行并 `rm` 掉那个未跟踪文件，
  `git status` 现在只有 `M DESIGN.md`（本轮有意改动）。
- **一条没能定性的观察**：`src/main` 全量第一遍报 1 条红，随后两次复跑 210/210 全绿，
  第三次也没有 FAIL 行——**我没拿到那条红的名字**（没复现就没记下来），
  所以只能标成一次性抖动，不能断言它属于谁。要抓它得给 main 侧测试加 `--retry=0` 之外的
  失败清单落盘，这项记在待办里。

### L35 定性改了：不是"删掉死弹窗"，是"两份名单必须对账"（2026-09-22 实施轮）

原报法只说对了一半。查清之后：`HomeFeatureNoticeDialog` 与 `availability: "pending"`
这条路**是未来真·未接入功能唯一的落点**，删掉它才会让"诚实 pending"彻底没有实现；
今天它不可达，只是因为 11 个 id 恰好全部已接线。真正没人管的缺陷是——
注册表里的 `WIRED_HOME_FEATURE_IDS`（决定目录上写「小屋可用」还是「尚未接入」）与
`HomeV2Experience.runFeature` 的分支（决定按下去会不会发生事）**是两份手抄名单**。
所以这一条不再删东西，改为双向对账门禁：
`src/main/home-feature-wiring-guard.test.ts`——标 native 的必须有分支、有分支的不许还标 pending；
外加一条"四份清单都解析到了东西"的元断言，防解析空集伪装成全绿。
它当场逮到我一次过度简化（`catalog` 是直接写死 `availability: "native"`、不走 WIRED 名单，
第一版把它误报成"已接线却写着未接入"）。
**反向复验**：把 `runFeature` 里 `feature.id === "catalog"` 改成不存在的名字 →
红并点名 `这些功能写着「小屋可用」，按下去却没有任何分支处理：catalog`；还原后 4/4 绿。

### L29（jobs 状态词汇表）已修（2026-09-22 实施轮）

- 先证连接再下结论：`activity/service.ts:414` 那句 `row.status === "failed"` 属于
  **卡生成运行**那一支（`needs_attention|failed|stale` 是真写得出的），不是 jobs——
  原报法把两件事混成一条了。真正死的只有一处：`inArray(jobs.status, ["failed", "dead"])`
  里的 `failed`（三支队列函数 `0113`/`0221`/`0228` 只写 pending/running/succeeded/dead，
  我对着迁移 grep 出来确认过）。删掉那个不可写的值并就地写明原因。
- 新门禁 `apps/api/src/__tests__/job-status-vocabulary.test.ts`：全仓所有
  `inArray(jobs.status, [...])` / `eq(jobs.status, "...")` 用到的值必须写得出。
  **反向复验**：把 `"failed"` 塞回去 → 红并点名"没有任何写入者…这一半谓词永远为空"；
  还原后 api 1526 过 / 0 红、typecheck 0 错。
- 写这条门禁时又被自己的元断言救了一次：仓库根层级少数一层、以及拿仓库根去 grep `src`，
  两次都会让扫描零命中而"看起来全绿"——`扫到了引用点（空集不算通过）` 那条先喊了出来。
  另外第一版正则跨行贪婪，把 `cardGenerationRunsV2.status` 的数组吞了进来，误报一条，已收紧。
- **仍欠（需要动 DB，按 AGENTS.md 要先确认开发库可重建）**：`job_status` 枚举里那个
  没有写入者的 `failed` 本身。留着它=枚举在承诺一件写不出的事；删它是一次迁移。

### L30 我能负责的那一半已做（2026-09-22 实施轮）

- `.env.bak-p6-streaming-20260812` 已 `git rm --cached` 移出跟踪，工作树里的文件
  **没有销毁**，移到 `/tmp/` 备查（要恢复一次 `mv` 就够）；`.gitignore` 补了一行
  `.env.bak*`，防止下次又生成一个同类被跟踪。全仓 grep 过：没有任何脚本/构建/CI 读它。
- **仍在你手上的两件事**（我不擅自做）：① 那些 key 本身要不要轮换——历史提交里还在，
  删文件不等于失效；② 若要彻底从历史里清除，得跑 `git filter-repo` 并强推，
  这会影响所有协作方与那条 `v1.0` 分支。
- **本轮全仓校验矩阵（绿的可复算记录）**：`packages/shared` / `apps/api` /
  `workers/ai-worker` / `apps/desktop-client` 四包 typecheck 全部 exit 0；
  测试 shared 371/371、api 1526 过 0 红、worker 773/773。
  desktop 全量 1413 过、2 红仍在 `note-doc-editor-binding.test.tsx`（并发会话在改的
  编辑器块属性，不是我的文件）。

### L33 已修（文档写反了 prod 的安全姿态）（2026-09-22 实施轮）

`docs/feature-flag-inventory.md` §七.1 原写"prod 栈全部 `false` fail-closed"。
按 `docker-compose.yml` 逐条数过：真实姿态是**混合**——能力类默认开 **11 支**
（含我第一版漏掉的 `COMPANION_MEMORY_EXTRACTOR_V1`、`COMPANION_THOUGHTS_V1`）、
默认关 **4 支**（`LEARNING_RUN_ENABLED`、`CARD_GENERATION_V2_ENABLED`、
`COMPANION_VOICE_DIALOGUE_V1_ENABLED`、`COMPANION_STREAMING_VOICE_V1_ENABLED`）；
全文件 `:-true` 13 / `:-false` 7。文档改成实测清单，并把
"prod 应全 fail-closed"标成**一次待做的收敛决定**而不是已实现的合同。
第一版我只列了 9 个名字却写"11 支"——是 grep 被 `head -20` 截断导致的，
重数后才对齐（本审计一路在防的就是这个）。

### L34 已自证（删除留给能一次做完的轮次）（2026-09-22 实施轮）

原报法来自子审计，我这轮自己跑过消费者对账（排除 `*.test.*`、`node_modules`、`dist`，
并排除符号自己的定义文件）：

| 符号 | 消费者 |
|---|---|
| `createCapabilityConfig` | 无 |
| `CAPABILITY_DEPENDENCY_EDGES` | 无 |
| `CapabilityApiViewV1` | 无 |
| `CAPABILITY_ATOMIC_FEATURES` | 无 |
| `TASK_CAPABILITY_MAP` | 无 |
| `TASK_COMPLEXITY` | 无 |
| `resolveSystemProviderForCapability` | **有**：`identity/invite-service.ts`、`identity/service.ts` |

所以 L34 成立，但**别整文件删**：`task-router.ts` 里那一支 provider 解析是真在用的，
`capability-bundle.ts` 的 id 枚举/`isCapabilityId` 一类也可能被签名引用，删前逐个符号再跑同一套对账。
规模：`capability-bundle.ts` 322 行、`task-router.ts` 103 行、
`packages/shared/src/index.ts:52` 有 `export * from "./capability-bundle.ts"` 一处再导出要一起收，
`docs/plans/learning-companion/01-7-feature-flags-capability-bundles.md` 把它奉为
"单一事实来源"的那段声明也要同步改（否则文档又在描述一个被删掉的系统）。
**这一条不适合在上下文见底时动手**——它会一次跨 4 个文件，半做就是新增一条 L34 式的半截链路。

### L36 部分已修，且我原报法里有一条是误读（2026-09-22 实施轮）

- **真死的两个键已删**：`.env.alpha.example` 里的 `WEB_PORT`、`WEB_BIND_ADDRESS`——
  我跑过对账：排除 `node_modules`/`dist`/`.env*`/docs 后**引用文件数 = 0**。
  按 `PRODUCT.md:10`（"不再提供浏览器端产品"），这两个键描述的是已经不存在的 web 层。
  `CORS_ORIGIN` **不动**：它还有 4 个引用文件，是真的还在用。
- **我原本写错的一条，在这里更正而不是留着**：`SOURCE_MIGRATION=0039` 我报成
  "相对当前 0268 落后 229 步"。读了用法才知道它是 `infra/backup/rc-restore-verify.sh`
  的 `--migration` **入参**（"这次要验证的备份出自哪个迁移"），不是"当前迁移号"，
  0039 只是示例值——按最新号去"修"它反而会弄坏恢复校验。已在文件里就地加注说明，
  防止下一个人（包括我）再去"更新"它。
- **仍然欠的两件**（都在 alpha 部署链上，动手前要看 alpha 环境本身）：
  `.env.alpha.example` 里的 legacy `AI_PROVIDER_AGENT_TURN=mock` 之类是否还有意义；
  `docker-compose.alpha.yml` 是否还需要那一段 web service 定义（与刚删的两个键同源）。

#### L34 本轮**未交付**——我删到一半主动还原了（把过程留在这里，别让下一个人重踩）

做了的：按消费者对账把范围钉死（排除 `*.test.*`/`node_modules`/`dist`/定义文件本身）——
`capability-bundle.ts` 35 个导出里 **32 个对外零消费者**，只有
`CAPABILITY_IDS` / `CapabilityId` / `capabilityIdSchema` 是活的（真消费者是
`desktop-ipc-contracts.ts:1013` 用它们拼 IPC 功能名表）；
`task-router.ts` 除 `TaskComplexity` 外都活着，而 `TaskComplexity` 是
`getTaskComplexity` 的返回类型，**动不得**（我第一版对账把它误判成死导出——
只看外部文件、看不见文件内部引用，这类静态对账的盲区要记着）。

按那份清单删掉 32 个之后，编译器抓出真正的拦路石：**两个测试文件把它当夹具在用**——
`src/__tests__/rl-legacy-cleanup.test.ts`（RL-15，1 处 import + 1 处调用）与
`rl-shadow-read.test.ts`（RL-11，1 处 import + **2 处**调用，第一版我漏了一处）。
它们验的是"bundle 永久开启/OFF 后 Surface 合同不变"，也就是**在被删对象上写断言**。

正确解法已经想清楚、但没在剩下的预算里做完：这三个调用点各自要改的是"去掉能力门那半个断言、
保留 Surface 照常解析那半个"——**不能塞手搓夹具顶上**（那等于把测试对象换成我自己的对象）。
所以本次**主动 `git restore` 还原**，树回到尝试前的状态（api typecheck 0 错、1526 过 0 红），
不留半截删除。

下一次要交付它，按这四步一起做，缺一步都会红：
① 删 `capability-bundle.ts` 的 32 个导出、把 `CAPABILITY_IDS` 的 19 个 id **原序内联**
（MUST 9 → SHOULD 4 → INTERNAL 6，`featureNameSchema` 依赖这个集合）；
② 改 `rl-legacy-cleanup.test.ts` 与 `rl-shadow-read.test.ts` 共 3 处调用 + 2 处 import；
③ 同步 `docs/plans/learning-companion/01-7-…` 里"单一事实来源"那段声明；
④ 四包 typecheck + shared/api/worker/desktop 四套测试全绿才算完。

### L34 已交付（2026-09-22 实施轮，四步一次做完）

1. `capability-bundle.ts` 从 35 个导出收到 3 个（`CAPABILITY_IDS`/`CapabilityId`/
   `capabilityIdSchema`）。19 个 id 不是手打的：脚本从 `git show HEAD` 里按数组边界
   抽出 must(9)/should(4)/atomic(6) 拼接，再机器比对——**逐个等值且同序 `True`**。
   顺序保住是因为 `desktop-ipc-contracts.ts:1013` 用 `featureNameSchema` 吃这个集合。
   （中途我自己写的第一版比对工具越过了 `] as const`，把无关引号行当成 id，
   报出"应有 47"这种假数；换成严格边界后才看到真相。工具的错也会制造缺陷。）
2. 那三个把 `createCapabilityConfig` 当夹具用的调用点（`rl-legacy-cleanup` 1 处、
   `rl-shadow-read` 2 处）与 2 处 import 一起改掉：**不补手搓夹具**，只保留仍然成立的
   那半句（Surface 解析与能力状态无关），并在原地写明为什么删掉另一半。
   `rl-shadow-read` 里第三个 `it`（`countOff === countOn`）是同义反复、测不到东西，
   本轮没顺手删，**记为待办**。
3. `01-7-feature-flags-capability-bundles.md` 加状态横幅：那张依赖表**代码里没有实现**，
   本文件按历史决策记录读，不当现行机制说明书。
   顺带纠我自己一条：审计里"01-7 称它为单一事实来源"这句是子审计转述、**原文没有这几个字**，
   我已按实际文本（"bundle 依赖图冻结；W9 灰度按此执行"）改写报法。
4. 校验：四包 typecheck 全部 exit 0（shared/api/worker/desktop 各 0 错）；
   shared 371/371、api 1526 过 0 红、worker 773/773、desktop 1423/1425
   （那 2 条红仍在并行会话在改的 `note-doc-editor-binding.test.tsx`）。
   本轮的"砍到活物没有"由编译器判定，不靠眼看——它确实抓出过一次（那两个测试文件）。

### L15 已落地（2026-09-23 凌晨续做）：作答模态偏好接到了真值上，含一处我漏记的第二来源

**先改判我自己上一轮写的 `silent → text`。** 那条是"缺一个产品映射"的判断，
而映射其实代码里已经写了三遍，只是我上轮没去读它们：

1. 落库值就叫 `touch_structure`（`companion-shell/service.ts` 的 `default_input_priority`，
   读时折成 `silent`、写时把 `silent` 折回去）；
2. 设置页那一档的文案是**「静默结构」**（`settings-surface.tsx:233`）；
3. 产品表把它定义为「`silent`（静音结构化 proof）→ 排序/修复、关系重建」（doc 14 §作答模态那一行）。

所以 `silent → structured`。`text` 是把"不想出声"翻译成"换一种模态去打字"，
那不是这条偏好说的意思。同时记一句边界：`structured` 在 planner 里的既有语义不变
（能推出结构时该题降为练习、不产掌握证据，`run-planner.ts:445-462`）——
**偏好只决定怎么答，不决定这道题算不算验证**，所以这里不绕过那条规则。

**接线形状**（坑就是上轮量出来的那两条：嵌套事务 + 循环里 N+1）：

- 新增 `packages/shared/src/companion-shell-contracts.ts` 里的
  `answerModeToResponsePreferenceTable` + `answerModeToResponsePreference()` —— 唯一一处映射，
  表用 `as const satisfies Record<AnswerModePreferenceV1, string>` 写，加一档偏好忘了映射就是编译错。
- 新增 `apps/api/src/modules/companion-shell/answer-mode-preference.ts`：把 key、落库值折返、
  读、写四样从 `service.ts` 整块搬过来（**service.ts 里那两个函数删掉**，`routes.ts` 与
  `companion-answer-mode-preference-postgres.integration.ts` 的 import 一起改指），
  额外导出一个收执行器的 `readAnswerModePreference(tx, userId)`。
  `getAnswerModePreference` 现在只是"替调用方开事务"的一层，所以那条集测**就是在测这条读**。
- `ActionResolverInputV3` 加**必填** `answerModePreference`；`cardStart()`（三个调用点）与
  review 那一支都从映射取值。**必填这一手是有效的**：改完 api typecheck 只报一处缺字段，
  在 `action-resolver.test.ts` 的 `base()` 上——三个生产调用点一个都没漏，编译器替我数过了。
- 三个装配点各自在循环外读一次，用同一个 `tx`，不再开第二个事务：
  `surface-service.ts:466`（详情页只有一个目标，就地一次）、
  `surface-service.ts` 批装配的 `// 10.6` 那一段（**在 `// 11. 装配 Surface` 之前**，
  那句"内存组装，不再查 DB"注释才仍然为真）、`topology-repository.ts` 目标循环之前。

**第二来源是我这轮才发现的**：`ReviewSurface.tsx:694` 也硬写 `responsePreference: "adaptive"`。
从复习页点「开始复习」根本不走目标表面，所以只修 resolver 的话，
"选了语音的人在复习上仍然没选"这半条 L15 会留着。改成点下去时读真值
（`readAnswerMode`，读不到回 `any` → `adaptive`，**不因为偏好读失败而点不动开始**），
映射仍用 shared 那一张表。为什么在点击时读而不是加载时读：值更新，且界面上没有任何地方
显示它，加载时读要额外处理竞态却没有读者。

**先写测试再改**：4 条断言改动前红 3 条（voice/silent/text），第 4 条是兜底对照，
它红不红都不算证据，所以它设计成"读偏好失败也照常开始"。

**mutation 复验（每一条都是"把机制拆掉，看谁喊"）**：

| 拆掉的东西 | 红的断言 |
|---|---|
| 表里 `silent: "structured"` → `"text"` | 冻结表 + "四档四值" 两条红 |
| 表里某格写成合同不认的值 | 只有"两端合同都收"那条红（另两条绿 = 各自职责清楚） |
| 给偏好枚举加一档、不补映射 | tsc 报 `Property 'x' is missing`，且"表覆盖每一档"红 |
| resolver 两处硬写回 `"adaptive"` | 卡开跑 + 到期复习共 3 条红 |
| `ReviewSurface` 那行硬写回 `"adaptive"` | 复习那 3 条红、兜底那条仍绿 |

**顺带量出一条新缺陷（L41，已修）**：给 `ReviewSurface` 接完映射之后，那 4 条用例
"一次都没调用 start"，我第一次归因归成了状态没 flush。真因是桌面 `vitest.config.ts`
没有 `sharedAlias`，测试读的是 pnpm 对 `file:` 依赖的**安装期快照**——我新导出的那个函数
在快照里不存在，渲染层抛 TypeError 被点击处理器的 `void` 吞掉。修法是把别名抽成
`apps/desktop-client/shared-alias.ts` 一份，构建与测试共用。

**校验**：四包 typecheck 全 exit 0；shared 375/375（+4）、api 1535 中 1534 过 0 红
（+4，那 1 条 skipped 是原有的）、worker 773/773、desktop **171 文件 1429/1429**
（+4；上一轮记的那 2 条 `note-doc-editor-binding` 红已经不在了）。

**L15 还剩的一半没做**：正式测评期间语音闸门在服务端仍然不关
（状态机被喂得很勤、正常运行里没人按它做决定，唯一出口是取证全局；`/voice/tts` 照合成。
  行号与逐处读点已按 2026-09-23 的复量更正，见上面 L15 那条与下面"复量 L15 第一症状"一节）。
那是一条门禁矩阵的格子，不是这条偏好接线，别把它们混成一条"已修"。

### 顺手删掉一条永远绿的空断言

`rl-shadow-read.test.ts` 里那条 `列表项计数：OFF 与 ON 产生相同数量` 实际写的是
`const countOff = items.length; const countOn = items.length;` 再比两者相等——
同一表达式和自己比，**任何实现下都真**。bundle 删除之后它连"两侧"的语义前提都没了，
整条删掉。删后 api typecheck 0 错、1526 tests 中 1525 过 0 红（少 1 条就是它）。

### 批次 B 的最后一手（L3 的读端）：设置页那句"供你回看"现在真的能点开

四处一起接，一处不缺：

1. `packages/shared/src/desktop-surface-contracts.ts`：`desktopAiAuditItemV1Schema` +
   `desktopAiAuditPageV1Schema`。**字段逐条对着服务端读**（`listAIAuditLog` 的 select 与
   `db-schema/identity.ts:193` 的列），不是界面想要什么就声明什么：`provider/modelId/operation/status`
   在服务端是 notNull，这里就不放宽成可空；`createdAt` 是 JSON 化的 timestamp，所以是字符串。
   `status` 收 `success|failed|blocked` 三个字面量——这是 `PRODUCT.md` 那句"可追溯"唯一能被机器守住的地方。
2. `desktop-ipc-contracts.ts`：通道 `ailearn.v1.workspace.aiAuditLog` + typed surface 的
   `workspace.getAiAuditLog`。
3. `main/desktop-gateway.ts`：`getWorkspaceAiAuditLog(limit, offset, requestId)`，整数化后
   交给服务端 clamp（不自建第二套上限）；回执过 schema，不过就 `unsupported_contract`。
4. `main/desktop-ipc.ts` 的 `installHandler` + `preload/index.ts` 那一行 + 设置页那段列表。

**Owner 门留在服务端**（那条路由本来就挂 `requireOwner`），主进程与界面都不写第二份判据——
与整库导出同一口径。界面对成员说的是实话而不是藏起来：这一行照样在，写明"记录一直在写；
这份清单由这个空间的所有者回看"。

**三条刻意的设计**（都是以前这类界面会做错的地方）：

- 不点不读：`auditPage` 初值 null，读到之前那一行只有说明。读失败画"暂时读不到 + 重试"，
  **不画成"还没有外发记录"**——把失败演成空清单，是替系统撒了一个谎。
- 分页位置用 `第 offset+1–offset+n 条 · 共 total 条`，下一页 offset 按**已读到的条数**走
  （服务端一页可能少给），不假设页大小。
- `data_categories` 是内部枚举（`note_content`/`question`/…），上屏前翻成"笔记正文/题目/…"；
  认不出的**原样显示**，不编标签。`errorMessage` 是服务端原文，**不上屏**（里面可能有 URL 与内部名）。

**验收**：设置页 5 条新用例。先写用例这一步仍然没跳过——但这轮我把它写成了"改完就跑"，
所以补跑了五组拆机制复验：

| 拆掉的东西 | 红的用例 |
|---|---|
| 「查看」按钮不读（onClick 空转） | 4 条红（读路径共用），成员那条仍绿 |
| 成员也给入口 | 只成员那条红 |
| 类别不翻译直接上屏 | 只第一条红（它断言屏上找不到 `note_content`） |
| 「更早的记录」offset 恒 0 | 只分页那条红 |
| 失败时 `setAuditFailure(null)` | 只失败态那条红 |

四包复量：typecheck shared/api/worker/desktop 各 0 错；shared 375/375、api 1535 中 1534 过
0 红（1 条 skipped 是原有的）、worker 773/773、desktop **1434 条里 1433 过**。
那 1 条红是 `objective-flow-css-guard.test.ts` 读并行会话在改的 `objective-flow.css`
（那条 CSS 现在没有 `.v3-next-action__verb` 规则了），不记在我账上、也不去动那个文件。

**自己又踩到一次读数坑，记在这里**：上一轮我报"desktop 1429/1429 exit=0"，
而那份日志里其实写着 `Errors 2`——`settings-surface.tsx:1163` 的 `element.play().catch(...)`
在 jsdom 下炸（jsdom 的 `play()` 返回 undefined）。**exit=0 不等于没有未捕获异常**，
`grep 红` 也不等于读了尾部摘要。这两条错误与本轮无关（前后两轮都是 2 条），
但它们一直在的时候我把它当成了"全绿"。
这两条**本轮顺手收掉了**（`vitest.setup.ts` 给 `HTMLMediaElement.play/load` 补真浏览器语义、
一条试听用例的 `vi.fn()` 改成返回 Promise）：现在全量跑**没有 `Errors` 这一段**，
`exit=0` 才真的等于没有未捕获异常。没有任何用例断言 `play()` 会 reject，
所以这层补皮不掩盖东西。

### L13 的下游那一半：把"没签 AI 同意"从"没权限"里分出来（2026-09-23）

上一轮我只把门挂上了（`identity/ai-consent-gate.ts` 在三条语音外发端点回 403 +
`error: "ai_consent_required"`），但网关把**所有** 403 一律翻成 `forbidden`，
界面因此说的是"当前工作区或账号没有执行这个动作的权限"——那句话会让人去问管理员，
而这件事是他自己在设置页点一下就能解的。这条就是 L13 剩下的那一半。

四处改动：

1. `desktop-ipc-contracts.ts`：`gatewayErrorCodeValues` 加 `ai_consent_required`。
   `safeMessageKeyValues` 是**从这份列表派生**的，所以消息键跟着有，不用第二处登记。
2. `desktop-gateway.ts`：403 上只认这一个 token，其余一律还是 `forbidden`。
   登录/邀请那一族的表**没有**跟着扩到 403——那些 token 的意思是路由内的
   （`not_found` 在邀请路上是"邀请码无效"，在取图路上是"文件没了"）。
3. `requestBinaryBytes`（取字节那条路，`/voice/tts` 走它）**过去完全不读失败体**，
   所以任何 `error` token 在这条路上都到不了界面。现在只在 403 上读，上限 4 KB，
   读不到 / 超限 / 不是 JSON 一律退回"按状态码分类"。服务端那句原文仍然永不上屏：
   `DesktopGatewayFailure` 的 `message` 就是那个码。
4. 界面：`gatewayErrorMessage` 加那句人话；`PERMANENT_VOICE_REJECTIONS` 同步加这个码
   ——**这一步不是可选的**：拆分的那一刻，"不再退避重试"这件事正好会从这条路上丢掉，
   而只测老码的用例看不出来（重试环的测试现在两个码都跑，各断一次）。

**被自己抓回来的一次回归**：把 body 读进二进制那条路之后，`getSourceImage` 那条
"404 且服务端带了 `{error:"not_found"}`" 用例会红——它被登录那张表翻成了
`invite_invalid`。是既有用例当场报的，不是我看出来的。修法就是上面第 2 条那句
"403 上只认一个 token"，并在测试里加了一条**对照**：403 + `not_found` 仍然只是 `forbidden`。

**顺手补了一条同族门禁**（`src/main/gateway-error-codes-have-copy.test.ts`，3 条）：
`gatewayErrorMessage` 带 `default` 兜底，所以"加了码忘了配文案"既不红也不报错。
这条门禁按声明列表双向对账（缺文案红、死文案也红），并且它**立刻又抓到一条**：
`invalid_credentials` 也没有——查下来是它在 `desktop-gate.ts` 里另有专属文案，
所以判据从"只盯一个函数"改成"按读它的两处数"（门禁第一版差点报假缺口，这条也记着）。

**拆机制复验**：摘掉取字节那条路的 body 读取 → 主断言红；把 403 规则放宽成整张表 →
那条对照红；摘掉界面那句 → 门禁红并点名 `ai_consent_required`。
**这里又踩了一次自己写过的坑**：第三组 mutation 用 `cp /tmp/xxx.bak` 还原，
而那个备份当时没做成——文件就这么带着改动留了一会儿，是随后 `grep -c` 发现的。
**改完必须用同一把尺复量**（`feedback-verify-your-own-edits-land`），
还原之后要断言"该在的那行还在"，不能只看 `cp` 没报错。

**验收**：四包 typecheck 各 0 错；shared 375/375、api 1534 过 0 红、worker 773/773、
desktop 1438 条里 1437 过，唯一那条红仍是并行会话在改的 `objective-flow.css`
（`objective-flow-css-guard.test.ts` 读不到 `.v3-next-action__verb` 了）。
`Errors` 那一段已经没有了（前一轮的 2 条未捕获异常收掉，记在上面那节末尾）。

### 复量 L15 的第一症状（正式测评语音门）：原文那两句要按量到的改

原文写的是"`authorizeCompanionDelivery` / `allowsCompanionDelivery` 的生产命中只有
`desktop-ipc.ts:1001-1006` 那一处暴露，渲染层零引用"。逐行数过之后：

- 类是**活的**：`desktop-ipc.ts:992` 构造它，`:1508` 用 run 公共快照喂它，另有十几处
  `failClosed(...)`（断开、未知、导航变化）。所以它不是一个没接电的机器。
- 但它的**出口只有一个取证钩子**：`getSnapshot` / `authorizeCompanionDelivery` 被挂到
  `__ailearnFormalAssessmentGuardEvidence`（`desktop-ipc.ts:1016-1024`），而那段只在
  `AILEARN_PACKAGED_EVIDENCE=1` 时才装。正常运行里没有任何投递路径问过它一句。
- `getSnapshot` 在生产里的唯一读点是 `completeFormalReleaseAfterRendererCleanup`
  （`:1541`）——读它是为了**解开**闸门，不是为了挡谁。
- 渲染层那句 `voiceEnabled={!assessmentMode}` 也不算"页面自己瞎判"：
  `assessmentMode` 来自 `companionPolicy.mode === "assessment"`（`CompanionPresence.tsx:298`），
  是策略对象的值。

结论不变但要说准：**这台状态机维护得很认真，代价是没人在它上面做决定**；
真正被挡住的只有界面念不念，而"正文交给外部合成服务"这一件照旧发生。
下一轮要做的是一格而不是两条：把 worker/主进程那条 companion 语音投递在
`authorizeCompanionDelivery("voice")` 上过一次（或者按 `AGENTS.md` 把这台状态机和
它的取证钩子一起删掉，只留 `companionPolicy` 那一处真判据）。
`/voice/tts` 的**用户主动**试听与朗读不该被这格挡住——那是用户要的声音，不是打扰。

### L14 的后半（已落地一部分）+ 新登记 L42：「忽略」在数据库里是真的，在气泡上是空的

**先说我这次做了什么。** 抽取器写候选之前加了一道守卫：同一空间里如果已经有一条
**被本人忽略过**（`dismissed_at IS NOT NULL`、未删除）的同类内容，这条候选**整条跳过**——
不写行、不发交付、不铺跨空间，并且完成日志里带上 `dismissedTwinsSkipped` 的计数
（跳过必须是能读到的数，不然"守卫有没有跑"永远问不出答案）。判据没有新造：
`similarity(content, $n) > 0.85` 本来就是 api 侧冲突分组用的那一个数，
现在上收为 `MEMORY_CONTENT_SIMILARITY_THRESHOLD`（放在 `db-schema/assistant-memory.ts`，
两张表读同一处），并加了一条门禁（`apps/api/src/__tests__/memory-similarity-threshold.test.ts`）：
**任何在 SQL 里用 `similarity()` 的文件都必须引用这个常量**，写字面量阈值当场红
（复验：把抽取器改成 `> 0.86` → 恰好 1 红并点名文件与那串字面量）。
**没有加"可选参数默认旧行为"那种假活。**

**量完之后必须说清楚它挡不住什么。** 在 dev 库上只读数了 pg_trgm 对中文的行为
（正面控制都在，不是"跑通了"就算）：

| 两份文本的关系 | `similarity` | 0.85 判据 |
|---|---|---|
| 逐字相同 | 1.000 | 挡得住 |
| 末尾多一个句号 | 1.000 | 挡得住 |
| 换语序、词全同 | 1.000 | 挡得住 |
| 改一个数字（四十分钟→五十分钟） | 0.769 | **挡不住** |
| 同义改写（模型每轮都会这样） | 0.048 | **挡不住** |
| 无关内容 | 0.000 | 不误伤 |

所以这条守卫挡的是"**同一句话再说一遍**"的复活，挡不住"**换个措辞再说一遍**"。
后者要的是一个稳定的"什么算同一件事"的键（内容归一化键，或等 embedding 到位之后在
**提升为活记忆**那一步再挡一次），那是一个产品判据，不在这一格偷偷定。
另外量到一个事实：dev 库 177 条记忆里 `dismissed_at` 不为空的是 **0 条**——
这条路径在这套开发库里从来没被走过，所以"行为级"的证据只能等真角色集测。
静态那一半核过了：`has_function_privilege('ailearn_worker','similarity(text,text)','EXECUTE')` = true
（`roles.sql` 按 `pg_depend.deptype='e'` 把扩展函数整体发回给两个受限角色），
所以这道守卫不会在生产角色下变成 `permission denied`。

### L42 的复量与改判（2026-09-23 同日）：不是"没人读"，是"读了不结账"

上面 §4 的 L42 那一节把判据抓错了层（列值 vs `payload_ref.kind`），**结论随之改掉**：候选交付有完整读侧
（`desktop-gateway.ts:336-348` → `companion-center-surface.tsx:332`），库里 57 条 `displayed`
就是它在跑的凭证。真缺陷是**用完不结账**：`confirmMemory` / `dismissMemory` 不碰
`assistant_deliveries`，于是 `acted` / `dismissed` 这两个早已定义好的终态整表 0 行，
而被忽略的那条候选仍会在活动条里排到 30 天期满——`memory-service.ts:343` 与
`memory-routes.ts:13` 那句"不再弹出"因此不成立。

本轮的修法（一处、按状态的归属写）：`delivery-service.ts` 导出
`closeDeliveriesForMemoryItem(tx, scope, { memoryItemId, transition })`——按
`payload_ref->>'memoryItemId'` 反查该用户该空间里**尚未终态**的那条候选交付，走同一张
`TERMINAL_STATES` 词汇表写 `acted`/`dismissed` 并清掉展示租约；记忆侧的确认/忽略/归档各调一次。
状态机仍只有 `delivery-service.ts` 一个写者，`memory-service.ts` 不直接 UPDATE 那张表。

**本轮校验**：shared/api/worker typecheck 各 0 错（desktop 未动）；shared 375/375、
api 1536 过 0 红（+2 是那条新门禁）、worker 773/773。

### L42 结账已接（2026-09-23 同日续）：记忆侧的表态现在会把候选交付写成终态

改判之后剩下的活是一格，做完的形状如下：

- `delivery-service.ts` 导出 `closeDeliveriesForMemoryItem(tx, scope, {memoryItemId, transition})`：
  按 `payload_ref ->> 'memoryItemId'` 反查该人该空间里**仍在活跃状态**
  （`ACTIVE_STATES` 那一套，不是我新编的清单）的候选交付，写成 `acted`/`dismissed` 并
  **清掉展示租约**——与 `ackDelivery` 走同一张终态词汇表、同一个收尾形状。
  它不复用 `ackDelivery`，因为那条要校验设备租约，而**表态的人未必是当初领到租约的那台设备**
  （手机上看到气泡、在桌面上确认，是同一条记忆的两个端）。
- 调用点三处，全在 `memory-service.ts`：`confirmMemory → acted`、`dismissMemory → dismissed`、
  `deleteMemory → dismissed`（`correctMemory` 经由删除，一起结账）。
  **写这张表的只有 `delivery-service.ts` 一个模块**，记忆侧只调它。
- 界面那一侧一行都不用改：`companion-center-surface.tsx:901,977` 本来就按
  `state` 出"待处理/已处理/已忽略"和那两个按钮，并且 confirm/dismiss 之后已经会
  `projection.reload()`（`:520-527`）。**这也是我确认这格值得做的依据**——
  写下去有读者，不是给一张没人看的表补行。
- 顺手把两处说谎的注释改准：`memory-service.ts` 的"气泡内 30 天不重复弹出"、
  `memory-routes.ts:13` 的"忽略（30 天不弹）"，现在写的是实际发生的事
  （结账；`expires_at` 那道 30 天窗口只是读侧兜底，不是这条判据）。

**补的一小格**：结账成功之后随同一事务发一次 inbox `pg_notify`（与 `deliver` 同一形状）。
不带它的话，**别的设备**上那张卡片要等下一次 durable poll 才变成终态——用户已经表过态，
按钮还挂着。断言写在同一份用例里：结到账 → 必须有一次 execute；没结到账 → 一次都不许发
（撤掉那句 NOTIFY 复验：恰好第一条红并报"必须发一次 inbox NOTIFY"，其余三条不受影响）。

**验收**：新用例 `memory-delivery-closure.test.ts` 4 条（不连库，断"这三条路各把交付写成什么"）。
**两个方向都做过拆机制复验**：撤掉三处结账 → 前三条红、第四条（"记忆读不到就不许结账"）仍绿；
把结账挪到存在性检查**之前** → 恰好第四条红。这条对照不是装饰：第一版替身把读语句也当成写，
`select` 一律回空，于是第四条是**白过**的——是这次复验把它救回来的。
真库那一半写在 `companion-memory-routes-http-postgres.integration.ts` 里（确认 → 那条交付
`acted` 且租约为 NULL；**另一条指向别的记忆的交付必须原样不动**；确认在前忽略在后 → 仍是 `acted`，
即终态不被重写）。**这一段跑完了两次、第三次没跑完，所以它还记在"欠验证"里**：
第一次红在夹具——受限角色直接 `INSERT INTO assistant_deliveries` 被 RLS 拒
（`42501 new row violates row-level security policy`），第二次红在断言——同一角色**也读不到
自己刚插的那一行**，断言拿到 `undefined`，长得跟"结账逻辑没生效"一模一样；
两次都不是被测逻辑的问题，已把夹具与断言改走 migrator 那条连接（文件里写明了为什么）。
第三次起在 `before()` 之前就不出输出，我没拿到证据前**不归因**（当时共享 dev 正在被
并行会话用，且他们刚把 0272 落上去，连接池 socket 可能已经废——但这只是猜，没量）。
**卡在哪一步已经量出来了**：`SELECT 1` 三条连接都是毫秒级返回（超户 / migrator / `ailearn_api` 都通），
所以不是连接问题；`pg_stat_activity` 里同时看到 drizzle 的迁移内省
（`SELECT max(id) FROM drizzle.__drizzle_migrations`、`information_schema.tables`）与 worker 的
`UPDATE card_generation_run_outbox_v2`，说明**那一刻并行会话正在往共享库上迁 migration**，
我的进程在等锁。等他们跑完再单跑 `--test-name-pattern="候选确认"` 就是。

**这段夹具为什么先挂过一次，以及现在怎么跑绿的**：第一版我在同一个测试文件里**另开了第二条
postgres.js 池**（`admin`）做夹具读写，结果整份文件挂起，而且挂得毫无现场——那个进程在
`pg_stat_activity` 里根本不存在（没有连接、没有语句、没有锁），第一反应几乎必然去怪"并行会话在抢迁移锁"。
改成**用这份文件已经在用的那条连接 + 事务内 `set_config`**（也就是生产 `deliver()` 本来的写法）之后，
整份文件在 `DATABASE_URL_API=ailearn_api`（真受限角色）下 **9/9 全绿**，本条断言在内：

- 确认 → 那条候选交付 `state='acted'`、`display_lease` 为 NULL；
- **对照**：指向另一条记忆的那一份仍是 `displayed`（没有这条，谓词写成"这个人所有候选交付"也能全绿）；
- 确认在前、忽略在后 → 仍是 `acted`，终态不被后来的动作改写。

**在真库上做过拆机制复验**：把 `confirmMemory` 里那句结账撤掉 → 这条用例红并直接报
`expected 'acted' / actual 'displayed'`；装回去立刻绿。于是 §13 之前记的那条"路由级断言仍欠"
可以销掉——它已经跑过，且是在受限角色下跑的。

**但这段里最该量的一半已经量到了（只读，不需要那条集测）**：谓词选择性在真数据上核过——
库里 99 条候选交付对应 **99 个不同的 `memoryItemId`**，按其中一个去挑恰好命中 **1 行**，
同状态下其余 **98 行不受影响**（这个 98 就是对照：没有它，"只挑一条"可以是"挑了全部"的别名）。
剩下的欠项只有一个：走 HTTP 路由确认之后那一行真的变成 `acted`、租约清空
（重试了三次都在 `before()` 之后不再出输出；`SELECT 1` 三条连接都是毫秒级，
库里同时能看到 drizzle 的迁移内省与 worker 的 outbox `UPDATE`——**在等锁，不是连不上**，
但因果我只核到这一层，不再往下断言。等并行会话的迁移跑完单跑一次即可，命令就在上面）。

**顺手一条环境卫生**：这份集测的 `after()` 只在跑完时执行，**中途被 kill 就把夹具留在共享 dev 库里**
（三次中断留了 3 对 `mem-http-*` 用户 + 各自的个人空间/成员行/会话）。已逐条清回 0。
清的时候我自己先踩了一次假干净：Postgres 的 `LIKE` 不认 `[ab]` 字符类
（那是 `~` 的正则语法），第一条清理脚本匹配到 0 行却"顺利跑完"——
**脚本先打印"待清 = N"再看它删没删**，这一句就是那条"探针要有正面控制"的同族。
校验：shared/api/worker/desktop typecheck 各 0 错；shared 375/375、api 1540 过 0 红（1 skipped 原有）、
worker 773/773、desktop 172 文件 1442 条全绿、无 `Errors` 段。
（跑桌面全量时并行会话正在存盘：先一次 173 文件里 11 条红，随后那次就 172/1442 全绿了——
这种"红随对方落盘出现和消失"的读数不当结论。）

**仍留在 L42 名下没做的**：`suppressed` 这个终态仍然没有写入者——它该由"门挡下了这次触达"来写，
而目前所有门（0270 的提醒三道闸、L12 的正式作答、语音侧的永久拒绝）都只写日志。
那需要决定"被挡下要不要留下一行"，与 L25–L29 那一簇（写不出来的状态）是同一个决定，不在这格顺手做。

### L43 的处置：验收前置条件被推翻，共享环境那一步仍然单独等拍板（2026-09-23）

原报法（含我自己前几轮的说法）把"先换 `docker-compose.dev.yml:10` 才能在真角色下验收"当成顺序。
这条**不成立**：`SET LOCAL ROLE ailearn_api` 就能拿真证据，不需要密码、不需要换任何人在用的连接串，
量法与结果写在 §1.2 的 L43 与 §12 那段。于是两件事解耦：

- **验收侧（本轮做完）**：无上下文五张表全 0 行、带上下文跨空间 0 行、本空间审计 2168 行可读、
  L42 的 jsonb 谓词在真角色下挑中 99 条活跃候选交付。L2/L3/L37 的"修好了"这一句从此有了真角色证据，
  不再只是超户下的绿。
- **环境侧（仍等拍板，且我不建议由审计会话单方面做）**：把 dev 的 API 连接换成 `ailearn_api`。
  代价说清楚：换的那一刻 dev 会变成"谁漏了上下文谁当场红"——那是好事，但所有人的 dev 都会一起红，
  而 `.env` 里那四条 URL 现在还都写着 `ailearn`，换之前得先给两个受限角色定密码
  （`infra/postgres/apply-roles.sh` 会 **轮转** 它们，会打断任何已经在用旧口令的连接）。
  这一步需要用户点头，也需要挑一个没有别人在跑的时间。

### 把 L41 那类坑钉住：一份别名 + 一条会喊的门禁（2026-09-23）

L41 的修法本身（`shared-alias.ts` 一份，构建与 vitest 共用）没有守卫护着——
谁哪天在 `vitest.config.ts` 里把它摘掉，症状会退回"某处导出在测试里是 `undefined`、
测试只报 spy 调用 0 次"那种要排三轮的样子。所以补了一条
`src/main/shared-source-resolution.test.ts`（3 条，纯静态，不连库）：

1. 两个配置都从 `./shared-alias.ts` 导入，且 `electron.vite.config.ts` 里**不许再有第二份内联定义**；
2. 别名真的指向 `packages/shared/src`，且 barrel 与子路径两种 `find` 都在；
3. `vitest.config.ts` 的 alias 数组里两条都在（`prosemirrorResolve()` 是另一件事，注释里写明别顺手删）。

**三条都做过拆机制复验**：从 vitest 摘掉 `...sharedAlias` → 恰好第 3 条红；
在构建配置里内联一份指向 `node_modules` 的定义 → 恰好第 1 条红。还原后 3/3 绿、桌面 typecheck 0 错。
写这条门禁时又被自己的路径深度坑了一次：`import.meta.dirname` 在 `src/main/` 下，
少写一层 `..` 就去读 `src/vitest.config.ts` —— 这次是 **ENOENT 当场喊**，
不是静默零命中（同族教训见"静态门禁要先证明它读到了东西"）。

**全量**：桌面 175 文件 / 1472 条，唯一一条红是并行会话在改的语音降级用例
（`companion-voice-playback.test.ts` 单跑 30/30 全绿，是全量并行下的定时器抖动，不记在我账上）。

### L15 的第一症状（正式测评的语音门）已闭上：门现在装在源头（2026-09-23）

以前这格的形状是：桌面用 `companionPolicy.mode === "assessment"` 把播报按钮藏起来，
服务端**照样切句、照样把正文交给外部合成服务**——门只装在半条路上。现在 worker 在
`companion-dialogue.ts` 的投递源头判：`decideCompanionVoiceDelivery(...) !== "delivered"`
就**一个 `voice.segment.ready` 都不发**（文字照常流；语音是渐进增强，不该反过来判死一轮回复）。

- 判据**只有一份**：`lib/formal-answer-signal.ts` 的 `isFormalAnswerInProgress(tx, scope)`，
  念头管线（L12 的 `formal_answer_in_progress`）与语音这条共用同一个来源。
  取数放在读阶段的那个 RLS 事务里（多一次 `EXISTS`，不另开事务、不另开往返）。
- **一轮之内不中途放开**：决策在 claim 之后算一次并冻结。理由是那次 provider 调用远长于
  六个阶段的跃迁窗口，"进窗后放开"等于在用户正在答的那一题上开口。
- 阶段清单刻意的部分写进断言：`recoverable_error` **不算**正在作答（那一刻人不在答题，
  挡她只会让她更找不到北）。
- 顺序也有判据：旗标关闭报 `feature_disabled`（这条能力不存在），正式作答报
  `formal_answer_in_progress`（存在但这一刻不该打扰）——合成一个 reason 就把排查线索抹平了。
- 这一轮真的因为正式作答而不念时，留一行 `logger.info`：这是这条门唯一的可查痕迹。
- `voiceSegmentsEnabled` 那个可变开关**保留原样**（它是"这一段写失败之后本回合别再试"），
  和新门是两件事，注释里写清了两者的区别。

**拆机制复验**（三条都咬）：摘掉 `companion-dialogue.ts` 里那句 gate → "语音投递那条路上
确实问了这条判据"红；在别处再抄一份 `purpose='formal'` → "判据只有一份"红并报出两个文件；
把决策顺序反过来 → 优先级那条红。还原后 worker typecheck 0 错、**780/780**（+7 是新增的
`formal-answer-signal.test.ts`）。

写元断言时又纠了自己一次：第一版我写"扫到的源文件数要 > 300"，实测 228 个——
**文件数本身没有意义**，改成"该被扫到的三个文件在不在集合里"（判据自己、念头管线、api 侧服务）。

**没做的部分**：真窗口里"她在正式作答时是否还会开口念"没有实测（那是 §8 那条要真跑测评的量），
本轮只把服务端与判据这一侧接上；桌面上那个 `voiceEnabled` 的界面判断留着没动，
它现在和源头一致而不是唯一的防线。

### L21 §2 已修（2026-09-23）：证据预览现在复算哈希，并把"落点变了"这件事送到界面上

先量了一轮，两个数字把我原来的写法改掉了：

- **哈希域是对的**：把 dev 库 3004 条 `evidence_snapshots_v2` 全部取出，按
  `hashCanonicalV2("block", {content})` 与 `hashCanonicalV2("evidence-quote", {quote})` 复算，
  **能定位到块的 1816 条全部对上，0 条误判**。这条是这条修法的前提——
  如果我把域用错，装上之后每一张卡都会显示"原文已改动"。
- **今天真正指不到原文的是 1188 条，但其中 1131 条属于已经不存在的 workspace**
  （按 `workspaces.name` 归因：`<workspace gone>` 1129 条 + `Personal Beta` 2 条，日期横跨 08-19~09-22），
  那是集测夹具删行留下的残渣，**不是用户数据**。真正"笔记还在、块没了"的只有 **57 条**，
  其中 56 条在 `Pedagogy Stage IT`（听名字也是测试空间），落在真实空间 **1 条**。
  所以这条缺陷成立、但严重度按量过的说：**机制是活的（`note/document-state.ts:403` 会删 stale 块），
  今天只有 1 条真用户数据踩过**。

改了什么（四处一起，缺一个就是半条）：

1. `packages/shared/src/card-generation-v2-hashing.ts` 新增
   `classifyEvidencePreviewV2` + `EVIDENCE_PREVIEW_SOURCE_STATES_V2`（`located | drifted | missing`）。
   放在这里而不是新建一个 shared 文件：这个域必须和 `evidence-seal-core.ts:211-213` 挨着，
   而且**新 shared 文件要在 `packages/shared/package.json` 的 `exports` 登记**，
   漏登记是"typecheck 全绿、进程启动即 `ERR_PACKAGE_PATH_NOT_EXPORTED`"那一类（见那条记忆）。
2. `apps/api/src/modules/card-generation-v2/evidence-preview.ts` 新文件：
   **两遍副本合并成一个读点**。原来 `reveal-service.ts` 与 `card-service.ts` 各有一份
   "切 `note_blocks.content[start:end]`、空串就 `continue`"，两份都不复算哈希。
3. 两份合同（`card-generation-v2-contracts.ts`、`learning-card-v2-contracts.ts`）的预览项
   加 **必填** `sourceState`，并把 `preview` 从 `min(1)` 放宽成可空——
   `missing` 本来就没有正文，留 `min(1)` 会逼我在服务端塞一句占位文案（那句该归界面写）。
4. `CardGenerationSurface.tsx` 给 `drifted`/`missing` 各一句话，并挂 `data-source-state`；
   `missing` 不留空行，它显示"这段依据现在指不到笔记里的文字了"。

验证到哪一层：api 新文件 `card-generation-v2-evidence-preview.test.ts` **12/12**，
其中**正控制**是第一组：夹具由真的密封计划 `planEvidenceSnapshotsV2` 产出、再交给读端分类函数，
两边算出的哈希必须对上（不是我自己跟自己比）。桌面 `CardGenerationSurface.review.test.tsx` **21/21**
（+1 条新用例：一次给一条 drifted 一条 missing，断言**两条都还在列表里**——
少一条依据必须是看得见的少）。shared **375/375**、api **1554 条 1553 过 0 红 1 既有 skip**、
四包 typecheck 0 错。

**拆机制复验做了三次**：把 `if (state === "located" && !preview) continue;` 退回旧的
`if (!preview) continue;` → 恰好 1 红（那条"不许静默丢掉"）；把分类函数改成永远 `located` →
4 红（3 条判据 + 1 条读点）；把哈希域改名 `"block-content"` → 正控制那条红。
每次还原后都用 `grep -c` 确认那一行真的回来了（有一次我用 `cp` 还原，路径不存在，
 mutation 留在树里——那次教训已经记在别处）。

**仍然欠的 L21 另外两半，性质不同，不要混着写**：
§1 `protectedQuoteRef` 指向一个不存在的对象、没有解析器——那是产品口径
（要么真做不可变副本，要么把合同里那句话删掉）；
§3 `recordEvidenceRedaction*` 没有生产者——**这一条我原本写"消费端齐备"，量下来不准确**：
`evidence_eligibility_states_v2` 的读点不止我列的两处（还有
`learning-runs/run-processing-tick.ts:819`、`run-service.ts:2500`、
`card-generation-v2/target-snapshot-adapter.ts:203`、`companion-dialogue-store.ts:310`、
`export/service.ts:133,451` 等），**但它们全在"生成/激活/排程"这一侧，
没有一个是"已激活卡发给用户之前"的闸门**。所以把 redaction 接上删笔记这条线，
今天**不会**把那张卡从复习队列里拿掉——只做写入侧会造出新的"写了没人读"。
这条判据直接决定了 L16 怎么修，见下面那一手。

### L16 已交（2026-09-23）：软删笔记的卡不再被服务，判据是派生的、恢复自动放回

先说为什么**不是**给卡写状态：`archiveCardV2` 那套是真有的，但它是"用户主动退役一张卡"，
带 CAS、publication revision、幂等键，而且恢复笔记时没有反向操作——写状态等于再发明一套
"什么时候放回"的机器，那台机器漏一次，卡就永久丢了。所以走派生判据：
**"这张卡还能不能被服务"从"它的来源笔记还活着"推出来**，恢复笔记 = 卡自动回来。

改了四个读点（不是四处代码，是四条判据，每一条都是它那条链的唯一实现）：

1. `note/visibility.ts:visibleCardsCondition` 的 EXISTS 里加 `notes.deleted_at IS NULL`。
   这一句被 **9 个读点**共用（卡列表/读卡/重生成/导出/统计/星图/理解投影…）。
2. `visibleObjectivesCondition` 第二支同样加一句。它被 **24 个读点**共用。
   第一支（`NOT EXISTS 带笔记来源的卡`）不动——它说的是"没有可追溯来源"，与存活无关。
3. `searchDocumentsVisibleSql` 的 objective 那支补 `objective_note.deleted_at IS NULL`。
   **它的 note 那支本来就有这一句**，目标那支没有——正是"列表挡住了、搜索没挡"那一类。
4. `review/consumer-eligibility.ts` 那条 `reviewScheduleTargetsConsumableCardPredicate`
   补 LEFT JOIN 到 `notes` 并判 `deleted_at IS NULL`（`note_version_id IS NULL` 的卡照旧豁免）。
   到期队列与首页"N 项待复习"走的是这一条，不是 1/2——**这就是为什么改 1/2 不够**。

`ailearn_api` 下 `notes` 的守卫没有 NULL 支，所以第 4 条那两个 LEFT JOIN 只在
`app.workspace_id` 已设的上下文里成立；这些读点本来就都在带上下文的事务里（`stats/service.ts:35` 等）。

**验证**：新集测 `note-trash-card-serving-postgres.integration.ts` **4/4，两种角色各一遍**
（夹具写 `DATABASE_URL`=超级用户，读数 `DATABASE_URL_API=ailearn_api`），断言形状是
① 正控制：软删之前队列与卡列表都读得到；② 软删之后两处一起消失；
③ **恢复之后两处一起回来**；④ `note_version_id IS NULL` 的卡不受影响（
并且把它的笔记删掉也不该动它——证明豁免那一支没被我写反）。
**拆机制复验做了两次，而且是分开做的**：同时摘掉两处 → 恰好那条"还在到期队列里"红；
只摘 `visibleCardsCondition` 一处 → 红的是"队列挡住了、卡列表没挡——判据只装在半条路上"。
（第一次做这个细分时我的 python 锚点在文件里出现 2 次，`assert` 当场拦下、什么都没改，
那次跑出来的 4/4 绿是**未改动的树**的绿，不能算复验——已按 `feedback-diff-proofs-need-a-changed-input` 重做。）

接入 CI：两份新集测都加进 `.github/workflows/ci.yml` 的 note-collaboration 那一步
（不接就等于不存在，这是 L31 那条门禁教的事）。

### L17 交付的是"能确定的那一半"，删不动这件事今天有测试钉住了

`review_schedules` 的收口不等于笔记删得掉。**唯一的挡点是那一条 RESTRICT 外键**：
`learning_cards_v2.note_version_id -> note_versions`（`0168_learning_cards_v2_note_version.sql:4`，
全库唯一一条指向 `note_versions` 的 RESTRICT；我在真库读 `pg_constraint` 复核过，
其余指向 `notes`/`note_versions` 的全是 CASCADE 或 SET NULL）。

这一轮做了两件不需要产品口径的事：

1. **候选扫描加 `ORDER BY deleted_at ASC, id`**（`note/maintenance.ts`）。
   原来那里只有 `LIMIT 50` 无排序：清不掉的行会把每轮配额占满，饿死后面的笔记。
   CLI 那份本来就有排序 + 键集游标（上一轮补的），现在两条路形状一致。
2. **把"删不动"和"删失败"分开计**：`catch` 里认 `23503`（foreign_key_violation）单独计数、
   单独一行 warn 说清原因，别的失败照旧 error。日志里"清道夫在跑"与"清道夫删不动"以前长得一样。

**新集测 `note-purge-soft-deleted-postgres.integration.ts` 3/3，两种角色各一遍**，
这条承诺此前一层测试都没有：① 正控制——真的删掉了一篇过期且无卡引用的笔记；
② 刚删 5 天的不动（30 天窗口是承诺的一部分）；③ **生成过卡的那一篇删不掉、
它的卡还挂在它的版本上**——L17 的原症状现在是断言，不是注释。
顺带量到一个代价：`purgeSoftDeletedNotes` 按空间枚举之后，dev（1027 个空间）整轮扫描
**2.9 s（超级用户）/ 5.9 s（ailearn_api）**，每 6 小时一次，可以接受；
这一轮之前它只有 1 条查询——但那 1 条在生产形状下恒 0 行。
跑之前先量过 `count(*) where deleted_at < now()-30d` = **0**（库里最老的软删是 6 天 13 小时），
所以那条"真的删掉一篇"只可能删到我自己造的夹具，不会碰到并行会话的数据。

还加了第 6 条静态门禁（`scripts/check-loop-closure-invariants.mjs`）：
候选扫描必须有那行 ORDER BY、必须认 `"23503"`，摘掉 ORDER BY 它红。

**留给归属决定的那一半，理由要说准（这不是"我没查"）**：把外键改成 `SET NULL`
看起来最省事，而且 `learning_cards_v2.note_version_id` 本来就是可空列——
**但它会把卡放回队列**：`visibleCardsCondition` 的第一支就是 `IS NULL`（"没有可追溯来源的卡不受这条约束"），
清掉指针等于给这张卡发了一张"没有私有来源"的通行证。**这是我在做 L16 的过程中量出来的相互作用，
不是事后诸葛**：正因为今天服务判据已经跟着笔记走，"置空"和"删卡""归档"三种做法的后果才第一次变得可比。
另一条同时成立的事实：`evidence_eligibility_states_v2` 的读数全在生成/激活/排程那一侧，
**没有一个是"已激活卡发给用户之前"的闸门**，所以"撤销证据"也不是一条现成的出路。
真要动，得连同 `learning_objectives_v2`（一个目标可能有多篇来源笔记，归档会连带打死另一篇的来源）
一起判，所以它仍与 L6/L38 归在 doc 32 那条线上。

### 换角色这一步（L37/L43）今天为什么仍然没做：一次真实的 A/B

用户已经点头换 `docker-compose.dev.yml:10`，但"换之前先在真角色下把 postgres 集测跑一遍"
这个前置条件**今天量下来还不成立**：把 `DATABASE_URL_API` 指成 `ailearn_api` 跑
`workspace-collab-postgres.integration.ts`，**9 条红**（"member 必须能读共享资料，实际 404" 等）。
我做了归因复验：**摘掉我这一轮全部三处判据改动，同一份环境重跑，红的还是那 9 条、一条不差**
（`/tmp/wc-alone.log` vs `/tmp/wc-baseline.log`）⇒ 与我的改动无关，
是那份套件本身按"两个 URL 都是超级用户"写的。
所以换角色会先把**别人的 dev** 弄红，而那批红不是隔离缺陷、是测试写法。
顺序应当是：先把这类套件改成"夹具写 / 读数"两个 URL 分开（我这两份新集测就是这个形状），
再换 compose。这一步我停在这里，不是因为要用户再确认一次授权，是因为**代价量出来了**：
换下去会制造 9 条与我无关的红，把它们算到我头上或者让别人去查都是错的。

### L23 的用户可见那一半已闭上（2026-09-23）："待复习"现在与复习列表是同一个数

先把【未核】核了，四条谓词我逐条读过实现（原文那条"路由注释还写桌面端在读它"**不准确**，
我撤回：`stats/routes.ts:10` 那句说的是 `GET /stats/overview` 这个端点桌面端在读，
不是指 `objectiveReviewDueCount` 这一列——原文照此更正）：

- `review/service.ts` 的到期队列：pending + `next_review_at <= now` + 未被"稍后"挡住
  + `reviewScheduleTargetsConsumableCardPredicate()`。**这是用户点进去看到的那一份。**
- `stats/service.ts` 的 `pendingReviewCount`：**全部 pending**，三条都不判 ⇒ 恒大于上面那个数。
  它渲染在两处：`all-spaces-summary.ts:46` 的"待复习"与 StudySurface。
- `stats/service.ts` 的 `objectiveReviewDueCount`：判到点、判目标 active，但**不判卡**（另一套）。
- `learning-dashboard` 的 `counts.reviewsDue`：走的是队列那条 predicate（与第一个同源）。

修法不是"挑一个数写死"，而是**让第二份去调用第一份的那条 predicate**：
`pendingReviewCount` 现在带齐 pending + 到点 + 未延后 + 那条共享 predicate，
并顺手去掉一次 `learningCardsV2` 的 innerJoin——`lc_v2_ws_obj_active_idx` 是
(workspace, objective) 上 `lifecycle='active'` 的部分唯一索引，一个目标最多一张活卡，
join 不改变条数，而"活卡"那一半 predicate 里已经判了。
`subjectType='card'` 也不用再自己写（predicate 的第一句就是它）。

**验证**：新集测 `stats-pending-review-equals-queue-postgres.integration.ts` 2/2，
断言写成**等式**而不是我手算的数字——
`overview.pendingReviewCount === listReviews(...).total`，
夹具三条排程（到点的、没到点的、到点但说过"稍后"的）应当只剩 1。
第二条是边界对照：把到点那条推到 9 天之后，两个数一起变成 0
（只在有内容时相等的两句话，推到空集就会露馅）。
**拆机制复验**：摘掉 `lt(nextReviewAt, now)` 那一句 →
红的正是那句等式，报的是 `屏幕上的"待复习"(2) 与列表条数(1) 不是同一个数`。
还原时用绝对路径 `diff` 证过文件与备份逐字节相同
（第一次 `cp` 我写错了相对路径，`cp` 失败而 `grep -c` 因为**另一条查询里有一模一样的那一行**
差点把"没还原"蒙过去——所以还原的判据必须是整文件 diff，不是数某一行出现几次）。

接入 CI：同时进 `apps/api/package.json` 的 `test:objective-metrics:postgres`
（那条 npm 脚本此前没接进 CI，所以只加脚本等于没跑）与 `.github/workflows/ci.yml`
note-collaboration 那一步。

**仍然欠的那一半，如实留着**：`objectiveReviewDueCount` 这一列还在发，
全仓只有一个集测读它（`workspace-collab-postgres.integration.ts:511` 的
`?? reviewDueCount` 兜底写法）。按 `AGENTS.md` 该删的要连响应字段、schema、那个读点一起删，
而 `stats/service.ts` 正被并行会话改（同一函数里那处"去重挪进 SQL"是他们的），
所以这一格我没有动——它不再是"用户看见两个数"，只剩"响应里多一列没人看"。

### L37/L43 收尾（2026-09-23）：先把"换角色会红"的那批套件改绿，再换 `compose:10`

上一段留的话是"顺序应当是先改测试形状、再换 compose"。这一轮就把那个顺序走完了。
判据只有一条：**夹具写的池 = 超级用户，被测读数的池 = `ailearn_api`**（`db/client.ts`
优先 `DATABASE_URL_API`，所以只要夹具不跟着用那条串，被测侧就还在 NOBYPASSRLS 下）。

红的原因全部是同一个形状：那批套件的 `const CONN = process.env.DATABASE_URL_API ?? DATABASE_URL`
让**夹具自己**连到受限角色，而它们原生写 `notes`/`note_versions`/`user_companion_account_state`
时不带 `app.workspace_id`——那些表的 RESTRICTIVE 守卫没有 NULL 分支，
于是写被拒（`new row violates row-level security policy`）或被静默过滤成 0 行。

| 套件 | 换之前 | 换之后 | 动的是什么 |
|---|---|---|---|
| `workspace-collab-postgres` | 9 红 / 20 | **20/20** | 夹具池优先串（它本来就用 `SET LOCAL ROLE ailearn_api` 做 RLS 取证，那一句只有超级用户登录做得到） |
| `note-document-state-postgres` | 11 红 / 13 | **12/12** | 同上（它还要故意写"note 属于 A、workspace_id 写成 B"的行来证明是**组合外键**在挡，不是策略在挡） |
| `note-collaboration-postgres` | 13 红 / 17 | **16/16** | 同上（红的样子是 4 条"没有快照"+ 7 条"等待同步完成超时"） |
| `card-generation-run-ownership-postgres` | 5 红 / 9 | **8/8** | 同上（红出来的两句"`IS NULL` 那一支没写对"是夹具没落地，不是判据写错） |
| `companion-daily-summary-tick-window-postgres` | 整个文件炸 | **1/1** | 同上（`user_companion_account_state` 的原生写被策略拒） |
| `content-hash-consistency` + `note-version-restore`（CI 步骤） | CI 里就是红的 | **15/15** | `.github/workflows/ci.yml` 把 `SEC02_/CONTENT_HASH_/NOTE_VERSION_RESTORE_` 三条夹具串从 `DATABASE_URL_API` 换成 `DATABASE_URL`。A/B 做过：受限串下 13 红、超级串下 15 全过 |
| `sec02-invites-onboarding-postgres` | 3 红 / 11 | **11/11** | 上面那条 URL + **一句过期的姿态断言**：它写着 `invite_codes.relrowsecurity` 必须是 `false`（0027 的 expand phase 口径），而 0257 已经把两张表 `ENABLE + FORCE` 回来了。这条与角色无关，CI 也一样红——改完断言的是"开关别再被关掉"，逐条策略仍由上面那条用例守 |
| `companion-home-profile-rls-postgres` | 1 红 / 4 | **4/4** | 测试里**手抄的字段名单**在 `proactiveMuted` 进合同时就已经过期（也与角色无关）。改成从合同 shape 推 + 一条"读不到 shape 就喊"的守卫；**拆机制复验**：从响应里摘掉 `proactiveMuted` → 3 条红。`strictObject` 本来就在守"多字段"，手抄那份只会 rot |

绿了的其余部分：`rate-limit` 1/1、`schema-isolation-gate` 4/4、`learning-objective-search`、
`db-migrations` 2/2，以及 `test:companion-integration:postgres` 那 22 份在双角色下逐个跑完（`assistant-*`、
`tool-gateway`、`companion-*` 全绿）。

**没在本地跑的两份，理由是它们会改共享库**：`rls-policies-postgres`（4 处 `ALTER TABLE`）与
`queue-postgres`（要 migrator/worker 三条串并自己建角色）。CI 跑在一次性库 `ailearn_ci` 上，
本地这份是并行会话正在用的 dev 库——在那上面复现"红不红"不值那道风险。它们的夹具串本来就是
`RLS_TEST_MIGRATOR/API/WORKER` 三条分开的，形状是对的。

**然后才换 `docker-compose.dev.yml:10`**：`DATABASE_URL_API` 从 `ailearn` 换成 `ailearn_api`，
理由与验收写进文件注释里。换之前另量了一条此前没人核的前置：
`ailearn_api` 对 public 里**每一张表都有 SELECT**（缺授权 0 张），所以不会换完角色就撞 `permission denied`。
**我没有重启任何在跑的容器**——改了串之后，正在用的 dev API 仍按旧串跑，下一次
`docker compose up -d` 才会落到受限角色；那一步会把 4000 端口后面的进程换掉，
而现在有并行会话的窗口正连着它。要立刻生效请自己挑时间重启，或者让我在你说可以的时候重启。

### 2026-09-23：归属口径拍下来了（用户原话），L30 也一并结掉

**用户给的口径**：成员退出/被移之后——
- **笔记与卡：归属原空间**（就是今天的既有行为，不再改动；配合 L16 的派生判据，
  人走了、他写的笔记留在空间里，空间里其他人照常看得见）。
- **记忆不是空间资产，是跟人绑定的**："记忆归属于个人，如果涵盖了此空间的记忆，
  就再关联个空间"。所以**退出时把"跟这个空间相关的那一份"收掉**——归档也行，
  "干脆点直接删除即可"。
- **L30 结掉**：不用 `git filter-repo`、不强推、密钥备份那件事不用再管。
  被跟踪的那份文件此前已 `git rm --cached`（文件挪去 `/tmp` 备查、`.gitignore` 补了 `.env.bak*`），
  剩下的"轮换 key / 清历史"**用户明确不要做**，这条到此为止。

**库里已经有那个形状，不需要新列**：`assistant_memory_items.scope` 实测只有两个值
（`global` 105 行、全部带 `global_key`；`workspace` 73 行），另有 `workspace_id` + `user_id` +
`deleted_at` + `archived_at`。也就是说"跟人绑定的那一份"和"关联到某空间的那一份"
是同一张表里两种 `scope`，**要收的只有 `scope='workspace'` 且 `workspace_id=被退出的空间` 的那些**，
`global` 那一半跟着人走、不动。

**选 `deleted_at` 而不是 `archived_at`，理由要写死**：`archived_at` 有两个读者之外的性质——
`memory-service.ts:340` 有一条"取消归档"的路、列表还有 `includeArchived` 开关，
等于给"我自己翻回来"留了个 UI 出口；而 `deleted_at` 是全仓 **60 处**判据都认的那一个。
退出空间这件事不该留可翻回来的口子。（两边都有读者，所以这不是"写了没人读"的选择，是权限语义的选择。）

**实现的前置约束（这条是量出来的，别再重新发现一次）**：
`assistant_memory_items` 的策略只有一条 PERMISSIVE：
`workspace_id = current_setting('app.workspace_id') AND user_id = current_setting('app.user_id')`
（外加 `CURRENT_USER='ailearn_worker'` 那一支）。
⇒ **`removeMember` 那条路做不到**：事务上下文是 (这个空间, **owner**)，
按策略去 UPDATE 那位成员的记忆恒匹配 0 行（不报错，静默）。
所以收口必须走**跨 actor 边界的显式机制**，两条现成的形状：
① 新增一支 `SECURITY DEFINER` 迁移函数（先例：`ailearn_fanout_global_companion_memory`），
   按 L8 那课的规矩**三处一起改**——迁移里的 GRANT、`infra/postgres/roles.sql` 的 GRANT 块、
   roles.sql 里那份"预期权限"清单（它另有 22→23 条的反向断言，缺一条就红）；
   新 `.sql` 还要注册进 `db/migrations/meta/_journal.json`（漏了静默不跑）。
② 或在 leave/remove 两处把 `app.user_id` 临时设成当事人、做完立刻设回去——
   能省一支迁移，但"同一个事务里上下文被换过"这件事对后面每一条语句都成立，
   风险面比①大。**按①做。**
落点：`identity/service.ts:leaveWorkspace`（软退出那一段之后）与
`invite-service.ts:removeMember`（与那条 `workspace.member_removed` 审计同一事务）。
`memory_links` / `assistant_memory_embeddings` 对记忆是 CASCADE，删行不会留悬挂。

**这条口径同时把 L38 从"等拍板"变成"等实施"**：归属矩阵缺的那一列（退出是否销毁）
现在有答案了——笔记/卡：否；记忆：是（只销毁空间那一份）。
其余项（日记、`pet_profiles` 亲密度…）用户没单独点，**默认按"留在原空间"处理**，
那也正是今天的行为；真要改得再问一次，不要我自己外推。

### L38 已交（2026-09-23）+ L17 已交（同日）：按用户口径实施完

**L38 —— 退出时收掉"这个空间那一侧"的记忆**
- 新迁移 `0273_retire_workspace_memories_on_departure.sql`：`SECURITY DEFINER` 函数
  `ailearn_retire_workspace_memories_on_departure(workspace, user)`，只 UPDATE
  `scope='workspace' AND deleted_at IS NULL`，返回行数。理由写在文件头部：策略要求
  `app.user_id = 行的 user_id`，而 `removeMember` 的 actor 是 owner ⇒ 裸 UPDATE 恒 0 行。
  `REVOKE FROM PUBLIC` + `GRANT EXECUTE TO ailearn_api / ailearn_migrator`。
- `_journal.json` 已登记（重数 **274 ↔ 274**，两侧零缺失）。
- `infra/postgres/roles.sql` 按 L8 那课**三处一起改**：批量 REVOKE 之后的 GRANT 块、
  白名单扫描里跳过这一支、预期清单加 `('ailearn_api', '…(uuid,uuid)')`（反向缺一条就红）。
- 落点两处，同一事务：`identity/service.ts:leaveWorkspace`（自退）、
  `identity/invite-service.ts:removeMember`（与 `workspace.member_removed` 审计同一事务）。
- 新集测 `workspace-departure-memory-retirement-postgres.integration.ts` **4/4**（双角色），
  四条分别是：① 被移出 → 他的 workspace 记忆全收、global 不动、**别人的不动**；
  ② 再收一次 = 0 行且不推 `updated_at`（幂等）；③ 自退那条路同样收口；
  ④ **为什么必须有那支函数**：owner 上下文里裸 UPDATE 是静默 0 行（没设 `DATABASE_URL_API` 时这条显式 skip，不假红）。
- 拆机制复验：把两个落点的调用同时注释掉 → ①②③ 红、④ 照旧绿（它测的是策略，不是接线）。
- 已在 dev 库上真跑过该迁移（`CREATE FUNCTION` 幂等、`prosecdef=t`、`has_function_privilege(ailearn_api)=t`）。

**L17 —— 卡留着但退役**
- 新迁移 `0274_allow_note_purge_by_retiring_cards_first.sql`：
  `learning_cards_v2_note_version_id_fkey` 由 RESTRICT 改 **SET NULL**（全库唯一那条 RESTRICT 指向
  `note_versions` 的外键），并把"置空只允许发生在退役之后"写进约束注释。Drizzle 同步 `onDelete:"set null"`。
- `note/service.ts:physicalDeleteNote`：删笔记之前，把该笔记各版本产出的 **active 卡** 置 `archived`，
  连带它们的目标 `archived`（`lifecycleEpoch+1`，与 `archiveCardV2` 同形）。
  **顺序是硬的**：先断线后退役 = 那张卡经 `visibleCardsCondition` 的 `IS NULL` 那一支回到队列；
  先退役后断线 = 它已经不是 active，队列与卡列表两条判据都进不来。
- 集测 `note-purge-soft-deleted-postgres.integration.ts` 重写成 **2/2**：
  正控制改挂在**卡列表**那一路（第一版挂队列，红在我自己的前提上——fixture 的目标没过激活闸门，
  一开始就不该在到期队列里，这不是缺陷）；断言链是"删得掉 → 卡 archived 且指针为空 →
  目标不再 active → **不回队列也不回卡列表**"。
  过程中撞出一个测试自身的问题并已修：purge 只需要跑一次，两条用例各跑一次会让第二条拿到 0 篇。
- 拆机制复验：`if (versionIds.length > 0 && false)` 摘掉退役那一步 →
  红话术正是"卡没退役：physicalDeleteNote 里那一步没生效"。还原用绝对路径 + `diff` 证过逐字节相同。
- 0274 同样已在 dev 库真跑（`confdeltype` 现在是 `n`）。

**没做完的两条（口径已定，任务已列）**：L21 §1 冻结证据原文副本、L14 按语义相似度认定"同一件事"。

### L21 §1 已交（2026-09-23）：证据原文真的冻了一份，"当初那段"取回来了

- 新迁移 `0275_evidence_quote_copies_v2.sql`：表 `evidence_quote_copies_v2`
  (workspace_id **FK CASCADE** / evidence_snapshot_id 唯一 / quote_text / quote_hash)，
  ENABLE+FORCE RLS + 与 `es_v2_ws_isolation` 同形状的守卫，
  **权限写在迁移里**（`roles.sql` 那句 `GRANT … ON ALL TABLES` 只覆盖建表在它之前的库，
  增量迁移建的表不写这句就是运行期 `permission denied` —— L8 那一课）。
  还挂了 V2 那套现成的不可变触发器 `prevent_immutable_v2_row_mutation`：
  "只写一次、只读"不能只是注释（集测清理走既有 `app.allow_history_mutation` GUC，同 v2-card-fixture）。
- 写侧：`planEvidenceSnapshotsV2` 多产出 `quoteCopyRows`（同一批 evidenceSnapshotId），
  seal service 同事务 `ON CONFLICT DO NOTHING` 插入；
  **`protectedQuoteRef` 里那个号改成这条证据自己的 `evidence_snapshot_id`**
  （以前是另抽一个随机 uuid——"指向一个不存在的对象"就是它），并补上唯一解析器
  `parseProtectedQuoteRefV2`（合同那句"经 protected ref 访问"从此有实现）。
- 读侧：`loadEvidencePreviewItems` 第三查按 `(workspace, evidence_snapshot_id)` 取副本
  （**不按 ref 取**：0275 之前的存量 ref 格式对、指向的东西不存在），
  `sourceState != located` 时给出 `originalPreview`；两份合同 + 界面 `当初那段：…`。
- **存量不回填**，理由写进迁移头部：老快照的"当初那段"已无从确定，
  拿今天的 `note_blocks.content` 补一份副本等于伪造证据。集测最后一条专门钉住这点。
- 验证：新集测 `evidence-quote-copy-retrieval-postgres.integration.ts` **4/4**（真角色 + 真库）：
  密封→副本落库→ref 指向自己→等长改写后**同时**出现"现在的文字"与"当初那段"→
  副本行 UPDATE 被 `immutable_v2_row` 拒→存量行 `originalPreview` 为 null。
  单测另加 5 条（计划产出副本、有/无副本、located 时故意不给）。
  api 1564/1564、shared 376/376、worker 780/780、桌面该文件 21/21，四包 typecheck 0，静态门禁 6/6。
- 拆机制复验两处：摘掉 seal service 的副本插入 → 集测 3 条红（"副本行没落库"）；
  摘掉界面那句 → 桌面那条红（找不到"当初那段"）。还原都用了绝对路径 + `diff` 逐字节核对
  （这轮 `cd ../apps/...` 与相对 `cp` 各绊我一次，判据同旧）。
- 又踩一次自己写过的坑：JS/TS 字符串里嵌 ASCII 双引号（`"当初那段"`）直接把文件写成语法错；
  还有"grep 命中了自己刚写的注释"让我一度以为解析器已存在（`already present` 是注释里的名字）。
  判据：**存在性检查要查 `export function <名>`，不是查那个字符串**。

### L14 语义去重：阈值先量出来了（同一轮的最后一条待实施）

dev 库里 `assistant_memory_embeddings` 只有 **7 行 / 1 个用户**，两两 21 对
（内容我逐条看过，语义上互不相关：晚上写笔记 / 贝叶斯更新 / 熟悉 vs 理解 / 被追问先举例 /
三分钟微旅程 / 先看反例 / 一条日记）：
**cosine similarity min 0.428、median 0.517、max 0.663**。
⇒ 判据这么定：**语义阈值取 0.80**，明显高于"不同事情"的实测上界、留出一截余量；
方向也是有意的——**宁可漏挡也不能误挡**（误挡会把一条真的新记忆永久挡在门外，
而漏挡只是让她多点一次"不是我的情况"）。
n=21 的局限写进常量注释，不许被读成"已经校准过"。
实现形状（下一手）：抽取器的 `dismissedTwin` 与召回侧，在 trgm 之外**再加一条 embedding 判据**，
只在两边都有 `status='ready'` 向量时才生效；阈值与 `MEMORY_CONTENT_SIMILARITY_THRESHOLD` 同一处登记
（新增 `MEMORY_SEMANTIC_SIMILARITY_THRESHOLD`），"禁止在 SQL 里写字面量"那条守卫扩到它。
机制用例用**构造的向量**（明确标注是机制验证、不是阈值出处），阈值出处只有上面那一次实测。

### L14 语义去重：机制已闭上，第四例集测夹具还红着（2026-09-23 本轮收尾处）

已落地：
- 共享常量 `MEMORY_SEMANTIC_SIMILARITY_THRESHOLD = 0.8`，**注释里写死了唯一出处**
  （dev 库 7 行 embedding / 21 对互不相关记忆，cosine sim 实测 min 0.428 / median 0.517 / max 0.663）
  与方向（宁可漏挡不可误挡）+ `n=21` 的局限。**不许被读成"已校准"。**
- 判据装在 `companion-memory-embedding.ts` 里"向量刚落库"那一刻
  （抽取时那条候选还没有 embedding，所以那一刻是唯一能对两边比的时候），
  抽成可测函数 `dismissSemanticTwin(tx, {workspaceId, userId, memoryId, embedding})`：
  命中就把新那条**继承 `dismissed_at`**（不是删行——"她忽略过什么"的记录必须留全）。
  handler 里 `semanticDismissedCount` 进完成日志。
- 集测 `companion-memory-semantic-dismissal-postgres.integration.ts`：**前 3 条绿**
  （① 近义改写的候选继承已忽略且行还在；② 对照：语义不近的不许继承；③ 幂等：判过的第二次返回 false），
  **第 4 条（跨用户不成立）仍红**，报 `INSERT has more target columns than expressions` ——
  这是**我这份夹具的 SQL 写错了**，不是判据缺陷；未修完之前这份文件**没有**接进 CI（接进去只会让那条步骤常年红）。
- worker typecheck 0 错、worker 单测 780/780 不变（新函数不碰既有路径）。

本轮欠的三步（下一步就做这些，别重新查）：
1. 修第 4 条夹具 SQL（`assistant_memory_items` 那条 INSERT 列数/值数），跑绿再接 CI；
2. 召回侧同样判一遍（`companion-memory-vector.ts` 两条召回路径现在只按 `dismissed_at IS NULL`，
   继承之后天然挡住，但**已经入库、还没等到 embedding job 跑**的那批要有同样的判据）；
3. `apps/api/src/__tests__/memory-similarity-threshold.test.ts` 那条"禁止字面量"守卫扩到
   `MEMORY_SEMANTIC_SIMILARITY_THRESHOLD`（现在只看着 trgm 那个数）。

### L14 收口（2026-09-23 同日续）：召回侧那半边补上了，守卫改成"看调用形状"

- **第四例集测红的原因不是判据，是我那条夹具写错了**（跨用户那条）：我拿 `userId` 的记忆当"新那条"，
  而 `before()` 里已经有一条**她自己的**已忽略记忆带着 NEAR 向量 —— 那次命中是真阳性，
  `false` 才是错的。改正后 4/4 绿（`dismissedSemanticTwin` 的对照现在测的是它宣称的事：
  被判定的人自己没有任何已忽略记忆，只留别人的已忽略 + 向量）。
  上一版报的 `INSERT has more target columns than expressions` 来自这张表的同步触发器路径，
  与本判据无关——**错话术会把人引到错误的方向上，记一笔**。
- **召回/服务侧补上反方向**：worker 那一半只在"新向量刚落库"时比对；她**刚刚忽略**的那条
  对应的**老**候选可能早就有向量、永远等不到那次比对。所以在 `memory-service.dismissMemory`
  里，投递结账之后加一次同判据的清扫（把她自己已 embed、语义过阈、尚未忽略的其余记忆一起标 `dismissed_at`）。
  方向仍是"宁可漏挡不可误挡"，且**不删行**。
- **验证**：worker 该集测 4/4；api `assistant-memory-postgres` + `companion-memory-routes-http-postgres`
  **12/12**（这两份会真打 `dismissMemory`，扫清语句一跑错就是红）；
  worker typecheck 0 错 + 单测 784/784；api 单测 1567 过 0 红；门禁 5/5、静态不变式 6/6。
- **两个我自己的坑，都留下了证据**：
  ① `sql.raw(semanticTwinPredicateSql(...))` 嵌进 `sql\`\`` 之后 4 条集测当场全红
  （`Failed query: UPDATE ...`），两侧改回"引用共享常量 + 参数化比较"的写法才绿 ——
  共享表达式这一层要真被证明可用才留，否则宁可退成"阈值常量只有一处"这一条更弱的不变式；
  ② 守卫第一版用 `includes("semanticTwinPredicateSql")`，**被 import 语句那一行喂成永远绿**：
  变异（worker 里自己写 `> 0.79`）复验时它照样 5/5 过。判据升级：**静态门禁要匹配"调用形状"
  （`名字(`）而不是标识符出现**，否则一次 import 就能把门禁变成装饰品。
- 接入：worker 侧集测补进 `workers/ai-worker/package.json` 的 `test:companion-integration:postgres`
  （第一次我加错了脚本，加到 `test:companion-dialogue:postgres`，已撤回并核对两个脚本内容）。

### 解散空间（L6 的 ②）：先量清楚"删除"到底意味着什么，再动手（2026-09-23 起）

用户令"按你现在量的判据先做"。动手前先量了三件事，**这三条决定实现形状**：

1. 库里有 **102 张表带 `workspace_id`，其中只有 13 张真有指向 `workspaces` 的外键**
   （`relrowsecurity` 倒是 102 张全开）。⇒ 只删那一行 `workspaces` 会留下 **89 张表的孤儿**，
   这正是 L39 那句"装了引擎没接启动键"的机器要处理的东西，也是 `notes` 那段夹具注释里
   写过的"删空间不会带走笔记"。**结论：解散必须逐表删，不能指望 CASCADE。**
2. **记忆是唯一不能被"跟着空间一起删"的东西**（用户 2026-09-23 拍的口径：记忆跟人绑定）。
   实测 `scope='global'` 的 105 行里有 **92 行的 `workspace_id` 不是本人的个人空间**——
   也就是说"把空间里所有记忆行删掉"会连带杀掉这 92 条**属于人**的记忆。
   ⇒ 解散时必须先把 global 那批**改指到本人的个人空间**（re-home），
   然后才按 L38 那支 `ailearn_retire_workspace_memories_on_departure` 收 `scope='workspace'` 的那批。
   没有个人空间的用户不能静默丢记忆：计入返回值（`globalMemoriesOrphaned`），不许当成 0 处理。
3. **审计 tombstone 必须活过这次删除**：`ai_audit_log` / 审计那几张表也带 `workspace_id`，
   逐表删的清单必须显式排除它们，否则"我们 dissolved 过这个空间"这件事会连同证据一起消失——
   那是把 L40 刚补上的审计闭环反向拆掉。

**要实现的形状（一步一验，按这个做）**：
- 迁移 `0276`：`SECURITY DEFINER` 函数 `ailearn_dissolve_workspace(p_workspace, p_actor) RETURNS jsonb`：
  ① 门卫：空间存在、`workspace_type <> 'personal'`、actor 是该空间的 owner，否则 `RAISE`；
  ② 逐个成员跑 L38 那支收 `scope='workspace'`；③ re-home `global`（数出来放返回值）；
  ④ 写 `workspace.dissolved` 审计行（带 counts）；
  ⑤ **从 catalog 现生成**要清的表清单（`pg_attribute.attname='workspace_id'`），
     减去一个**有理由的排除名单**（`workspaces` 最后删 + 审计那几张 + `assistant_memory_items`/
     `embeddings` 由 ②③ 处理），动态逐表 `DELETE WHERE workspace_id = $1`；⑥ 删空间行；返回逐表计数。
- service 包一层 + 路由 `DELETE /workspaces/:id`（**这一轮不做界面按钮**：
  不可逆动作等用户看过判据与计数再决定露不露，这是我自己给 L6 定的顺序）。
- 验收必须有一台"残留对账"：解散后拿同一份 catalog 清单逐表数 `workspace_id = ws` 的行，
  **除了排除名单里的表，其余必须为 0**；这条断言本身就是那张归属矩阵的第一列，
  不是手抄名单（名单来自 catalog，测试另外断言它非空且 ≥ 90 张，防止清单退化）。

### 解散空间 0276 已落地并被集测钉住（2026-09-23 当日续）

`ailearn_dissolve_workspace(ws, actor)` 迁移 `0276`（已注册 journal，**276 ↔ 276**；
roles.sql 三处一起改；dev 库真跑）。集测 `workspace-dissolve-postgres.integration.ts`
**3/3**（夹具 = 超级用户，解散 = `ailearn_api`）：catalog 清单非空守卫、
个人空间与非 owner 两道门卫各自 `RAISE`、
解散后**逐表残留对账 = 0 行**（除排除名单，清单从 catalog 现生成、不手抄）。

实施中量出三个新事实，都写进了代码注释：
1. `jsonb` 拼接是 `||` 不是 `+`（第一次执行当场报 `operator does not exist: jsonb + jsonb`）。
2. **`workspace_audit_log.workspace_id` 对 `workspaces` 是 ON DELETE CASCADE** ——
   tombstone 写在被解散的空间名下会被自己删掉，"这个空间被解散过"查无实据。
   现在记在**发起者的个人空间**名下、`target_id` 才是消失的那个空间；
   并且 actor 没有可用个人空间时直接 `RAISE`（**宁可拒绝解散，也不能删完留不下证据**）。
   这条级联本身是 L40 那一族的另一个洞：任何删空间的路径都会连带吃掉它的审计。
3. 记忆不能跟着空间删：`scope='global'` 改指回本人个人空间（实测 92/105 挂和非本人个人空间上），
   `scope='workspace'` 按 L38 那支函数收；两件事都在同一个函数里做完，不留半状态。

**还没有的两件（下一步）**：`DELETE /workspaces/:id` 端点 + service 包装（含 counts 返回），
以及要不要把「解散空间」这颗按钮放出来——**按我自己给 L6 定的顺序，不可逆动作要用户看过
逐表计数与残留对账再决定露不露**，所以这一轮故意不做界面。

### 解散空间的端点与出口也接上了（2026-09-23 当日续）；只有按钮还故意留着

- `identity/service.ts:dissolveWorkspace(workspaceId, actorUserId)` + `routes.ts` 里
  `DELETE /workspaces/:id`（注册在 `authRoutes` 内——我第一版插到了文件末尾的顶格 `}` 之前，
  Fastify 报 `Route DELETE:/workspaces/<uuid> not found`，四条用例里三条红在"路由不存在"上，
  **这条红跟我自己的插入位置有关，不是判据**；挪进函数体后 4/4 绿）。
- 第二个自己造的坑：drizzle 把驱动错误包成 `Failed query: …`，`RAISE EXCEPTION` 的原文在
  **`err.cause`** 上。只读 `err.message` ⇒ 三种门卫（403/409/404）全掉进 `dissolve_failed`/500。
  判据：**从数据库函数往上抛错误名时，翻错误码要把 cause 链拼起来读**，
  并且要有"门卫各自返回它该有的状态码"这种**带方向的断言**——只测 happy path 会把它读成绿的。
- 集测 `workspace-dissolve-route-postgres.integration.ts` **4/4**：member→403、个人空间→409、
  不存在→404、owner→200 且空间与成员行消失、tombstone 留在发起者个人空间名下。
  加上 `workspace-dissolve-postgres.integration.ts` **3/3**（逐表残留对账 = 0 行）。
  两份都接进了 CI 的 note-collaboration 那一步。
- api typecheck 0 错、api 单测 1570 过 0 红、静态不变式 6/6（含 journal **276 ↔ 276**）、
  `workspace-collab` 20/20 未被我改坏。
- **仍然只到端点为止**：没有「解散空间」这颗按钮。理由写进上面第一段——不可逆动作要人先看过
  逐表计数与残留对账再决定露不露；这不是"等谁批准"的技术欠账，是这条出口该不该现在按得到的产品决定。

### 解散出口：五层已接通并编译通过，**最后一层（设置页那颗按钮）还没做**（2026-09-23）

已落地并验过：`desktop-ipc-contracts`（通道 `ailearn.v1.workspace.dissolve` +
`dissolveWorkspaceResultV1Schema` + typed surface 的 `workspace.dissolve`）→ 网关
`dissolveWorkspace(workspaceId)`（校验逐表计数、清本地缓存）→ `desktop-ipc.ts` 的
`installHandler`（带上与邻居同一对门：`requireM2Route("settings.section")` + `assertEpoch`）→
`preload` 暴露。**桌面 typecheck 0 错，两道既有门禁（通道↔handler 对账、错误码必须有文案）7/7 绿**
——对账那条会红正是因为新通道没注册，它绿就说明注册真的落地了。

**下一步只剩一件事**：`settings-surface.tsx` 的空间列表里，给 **owner 且 workspace_type='collaborative'**
的那一行加「解散空间」+ 二次确认（输入空间名才放行），成功后把返回的逐表计数显示出来
（`_rehomedGlobalMemories` / `_retiredWorkspaceMemories` 那几个摘要键也要翻成人话）。
补一条 renderer 用例：非 owner 不出现该按钮、确认没输对不发调用、失败时不把"没删成"画成"已删除"。

**本轮我自己的失误，记下来别再犯**：给 `desktop-ipc.ts` 插新 handler 时用
`u[:i] + new + u[end:]` 的下标拼接，**把紧邻的 `memberRemove` 处理器整块覆盖掉了**。
它不在 HEAD 之外的改动里（HEAD 有），所以我从 `git show HEAD` 读回原文逐字恢复，
并用 `grep -c "installHandler(DESKTOP_IPC_CHANNELS.memberRemove"` == 1 与门禁测试双重确认。
判据：**往已有块里插东西一律用"锚点字符串 replace"，不要用行号/下标切片**；
插完必须数一遍邻居块还在不在。

### 解散按钮已露出，桌面全量 1503/1503 绿（2026-09-23 当日续）

`settings-surface.tsx` 的「账户与空间」→ 空间台账：owner 的协作空间那一行多一个「解散空间」，
点开是**要输入空间名**才放行的确认面板（不是点两下）；成功后那句状态**只转述服务端逐表计数**
（`summaryOfDissolveCounts`：摘要键 `_rehomed/_retired` 单独成人话、不进总数），
失败则**保留确认面板**让她不必重打名字——并且绝口不提"已解散"。

新 renderer 用例 5 条（+1 条纯函数），桌面全量 **175 文件 / 1503 条全过**。
拆机制复验：把 `canDissolve` 的 owner 门摘掉 ⇒ "member 看不到"那条立刻红
（`expected <button …> to be null`），还原后 `diff` 证过逐字节相同。

过程里我自己的两次错，都留下证据：
1. 用 `u[:i] + new + u[end:]` 的下标切片往 `desktop-ipc.ts` 插 handler，**覆盖掉了紧邻的
   `memberRemove` 处理器**；从 `git show HEAD` 读回原文逐字恢复 + `grep -c` 与门禁双确认。
   判据：**插块只用锚点字符串 replace，插完数邻居**。
2. `export function` 被我插进了组件函数体（`Modifiers cannot appear here`）——
   锚点选在组件内部时不能假设那里是模块作用域。
3. 三个新用例连红两轮的真实原因都不是判据：一次是没点对分区（台账在「账户与空间」，不是「数据与维护」），
   一次是我断言"失败后入口按钮还在"，而实现刻意**保留确认面板**（更对的 UX）——
   判据：**先量"实现到底做了什么"，再决定断言写哪一面**；红的时候第一个怀疑对象包括我自己的前提。
   中途我加过一段 `console.log` 把这一屏的按钮名打出来，就是为把"靠猜"变成"看一眼"。
