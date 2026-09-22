# 32 · 解散空间：方案、量测与执行顺序

日期：2026-09-22（v2，整理版）｜ 状态：**待拍板，未动代码** ｜ 署名：Asklins

这份文档是这件事唯一的方案文档。对话里散过的量测、被推翻的判断、改过的顺序，都以这里为准；前面那版写错的两处（"跟人走的记忆还不存在"、"抄笔记清除那个形状"）已经在正文里改对，并标了它们错在哪。

---

## 1. 结论：三步，以及为什么是这个顺序

**第一步（最推荐先做，且它不属于解散）**：不改共享 dev 配置，先按 `ailearn_api` 角色把受影响的几套集测各跑一遍，产出一张"在生产形状下哪些链路是死的"清单。理由见 §6——我已经抓到两条，而且它们和解散共用同一个权限面。

**第二步**：解散功能，**只做不删数据的那一半**——发起、释放名额、同事务审计、30 天可恢复、`workspaces` 两列墓碑。这一批就已经解决用户真正受伤害的那件事（误建的空间永久占掉 3 个名额里的 1 个，owner 既退不出也无处可交），而且它不销毁任何东西，所以做错也没有不可逆后果。

**第三步**：物理清除 + 跨空间记忆的抑制断言。这条最难也最危险（89 张无 FK 的表、0268 的连带删除、5 张不可变表），要等第一步把权限面弄对之后再动，否则我写的每一条清除都会"本地绿、上线死"。

顺序可以推翻，但有一点不建议动：**第二步不掺物理清除**。

## 2. 两个缺口咬成了一个死局

上限**已经有了**，之前有人以为没有是错的：`MAX_COLLABORATIVE_WORKSPACES = 3`（`apps/api/src/modules/identity/service.ts:659`），创建侧（`:587`）和邀请码加入侧（`:779`）都过这道门，且都夹在 `users` 行锁里，并发不能双双越过；`__tests__/adr0009-workspace-management.test.ts:92` 在断言它。退出也有：成员自退（`POST /auth/leave-workspace`）和 owner 移除成员（`identity/invite-service.ts:591`，带"最后一个 owner 不能被移除"保护），都走 `left_at` 软删、支持重新加入。

缺的是空间本身：`workspaces` 只有 `id / owner_id / name / created_at` 加类型和 epoch，**没有 `deleted_at`、没有 `status`**，也没有任何解散入口（全仓 `deleteWorkspace` / `DELETE FROM workspaces` 只出现在测试夹具里）。

于是：`owner_cannot_leave`（`identity/routes.ts:186`）＋ 没有解散入口 ⇒ **owner 误建一个协作空间，永远拿不掉它，并永久占掉 3 个名额里的 1 个**。建空间只要填一个名字。

转让已经存在（`identity/service.ts:877-955`，入口 `routes.ts:371-377`，由未提交的 0264 那批带来），所以"owner 毫无出口"这句说过头了。但转让要求**新 owner 必须是这个空间的活跃成员**（`0264:30-31` 明写这条不变量）——一个**只有 owner 自己**的空间，既没人可以转让、owner 又退不出去。死局仍然成立，只是精确说法变成"必须先把别人拉进来再把空间给他"这种荒谬出路；而且转让只解决"归谁"，不解决"里面的数据怎么办"。

## 3. 为什么解散便宜、归档贵

**`workspace_members.left_at` 就是唯一收口。** `decodeToken`（`identity/service.ts:394-397`）：成员行不存在**或** `left_at` 非空 → 当场删掉会话行、返回 null。每一个带凭据的请求都过这一道。而且配额谓词（`:587`、`:779`）和 `listUserWorkspaces`（`:626-631`）全都只认 `isNull(leftAt)`。

所以"给全体成员打 `left_at`"一步之内同时解决：鉴权失效、名额回来、列表隐藏——**101 张带 `workspace_id` 的表一张都不用加状态判断**。归档之所以贵，是因为它要"人还在但数据看不见"，那才需要给每条读路径加判断，几十个投影里漏一处就是"归档了还在眼前"。真实场景"这个空间早就不用了"和"我不想再维护它"，解散都覆盖；"暂时收起来"目前没人提过需求。

## 4. 核心决定：留墓碑，永不 `DELETE FROM workspaces`

```sql
ALTER TABLE public.workspaces
  ADD COLUMN dissolve_requested_at timestamptz,  -- 非空 = 进入宽限期
  ADD COLUMN purged_at             timestamptz;  -- 非空 = 数据已销毁
```

不另设 `status` 文本列：状态和时间戳会各自漂移，判据从这两列派生就够。

三条理由，都是量过的：

| 事实 | 证据 |
|---|---|
| `workspace_audit_log` 对 `workspaces` 是 **CASCADE**，注释还明说"删除空间时整表会随 FK 一起走" → 真删那一行等于销毁"谁解散的"这条证据 | `0263_workspace_audit_log.sql:26` |
| `companion_conversations` 建 FK 时没写 `ON DELETE` → NO ACTION，**它本身就会挡住删除** | `0088_companion_conversation_foundation.sql:12` |
| `users.personal_workspace_id → workspaces(id) ON DELETE RESTRICT`：个人空间那行结构性删不掉 | `0028_adr0009_personal_workspace_backfill.sql:105-109` |

另有一条收益：`decodeToken:418` 在空间行读不到时把 `workspace_epoch` 退回 1（注释承认那是"空间刚被删"的退化），留墓碑就不会走到这条退化。

**要付的代价**：CASCADE 一个都不触发，所以今天靠它自动清的 11 张表也要显式清。这反而统一——只有一套清除机制（§5），不依赖 FK 语义。

**个人空间不给解散入口**：`workspace_type='personal'` → 400，与既有的 `personal_workspace_cannot_leave`（`routes.ts:187`）同形；那条 RESTRICT 外键在库侧再兜一道。

### 状态机

```
active ──owner 发起──> dissolving（宽限期 30 天，数据原地不动）
                          │                            │
                       恢复（owner）                  到期物理清除
                          │                            │
                          v                            v
                        active                    purged（墓碑，不可恢复）
```

宽限期内**什么都不删**，这让"可恢复"是句真话：恢复只是复位两个时间戳和成员行的 `left_at`，不必从备份捞数据。

## 5. 数据终局：四类处置

101 张带 `workspace_id` 的表按**处置**分四组。（计数口径：`schema-isolation-gate-postgres.integration.ts:27-59` 把"有 `workspace_id` 但没有 FK"的 89 张当棘轮基线钉住，并断言与实际集合完全相等 `:114-129`；有 FK 的 12 张里 11 张 CASCADE，加上 `notes` 一类共 89+12=101。）

### A 类：空间私有内容 → 随空间销毁
`learning_*`(29)、`card_*`(15)、`note*`(5)、`source*`(2)、`evidence_*`(3)、`understanding_*`(3)、`assistant_page_contexts`、`assistant_deliveries`、`review_schedules`、`search_documents`、`onboarding_states`、`invite_codes`、`jobs`、`sessions`。
这些行只因"这个空间里的那门课/那批卡/那份材料"才存在，换个空间没有对应物——0268 把旅程判成空间级用的正是这条理由（`:149-156`）。**没有争议。**

### B 类：跟人走的记忆 → **必须不随空间销毁**
`assistant_memory_items` 的形状：一条跨空间记忆**在每个空间各存一行副本**，靠 `global_key` 认亲（`0267:36`，取最初那条的 id）。判据在服务端按 `kind` 定，不由模型定：**只有 `preference` 可能跨空间**，且还要过一道确定性否决（内容里提到具体科目/考试/项目就按本地）——`workers/ai-worker/src/handlers/companion-memory-extractor.ts:74` `CROSS_SPACE_KINDS = new Set(["preference"])`。

坑在 0268 装的触发器：

```sql
-- 0268_sync_global_memory_mutations.sql:119-125
CREATE TRIGGER assistant_memory_items_sync_deletes
  AFTER DELETE ON public.assistant_memory_items
  FOR EACH ROW WHEN (OLD.global_key IS NOT NULL)
```
函数体（`:91-116`）按 `user_id + global_key` 删掉该用户**所有其他空间**的副本。它的本意是"用户清掉一条旧记忆，别处别留孤儿"，**没考虑"整个空间被销毁"**。

**这不是假想，是已经成量的**（09-22 真库实测，`assistant_memory_items`）：共 142 条，其中 **87 条** `scope='global'` 且带 `global_key`；按 `global_key` 分 **30 组，30 组全部有 >1 份副本**（最多 3 份），铺在 **26** 个空间里。另有 **14** 条软删记忆。

**处置**：清除事务里 `set_config('app.memory_sync','on',true)`（`:100-102` 本来就是它的递归闸门，事务局部、不泄漏），只摘 W 自己的副本行、不传播。因为 0268 的 UPDATE 孪生触发器同样跨空间传播，**对这些行连"顺手标个删除"都不行**：只能整行摘掉并抑制，或原地不动交给清扫。

两个边界：解散协作空间后用户必然仍有自己的个人空间，而 fanout 本来就是"铺到该用户所有活跃空间"（`0267:107-113`，按 `workspace_members … left_at IS NULL`），所以偏好早有一份躺在个人空间里；`global_key IS NULL` 的老记忆本来就被当空间级读写，随空间销毁，无需特殊处理。

### C 类：空间 × 人的伴星状态 → 见 D2，第一批不动
`pet_profiles` 是唯一一张同时存了两类东西的表：

| 里面的东西 | 性质 | 判断 |
|---|---|---|
| `familiarity`、`interaction_count`、`last_active_at`（`0170:105-108`） | 她跟你有多熟 | 不该因为解散一个空间就归零 |
| `preset_id`、`personality_tags`、`speaking_style`、`boundaries`、`activeness`（`0170:98-111`） | 她的性格与边界 | 按 09-22 裁决方向应是账号级，但现在按 `(workspace_id,user_id)` 存（`0170:116-117`） |
| 日记 `companion_daily_summaries`、`companion_room_profiles`、对话/消息/念头/提醒/投递/旅程 | 空间里发生过的关系与记录 | 随空间销毁说得通，与 A 类同 |

搬成账号级正是**另一个会话在做的事**——`docs/plans/learning-companion/29-...md:3195-3212` §9.63 记着同一个设置在三层里各写一份（`pet_profiles.activeness` 与 `user_companion_account_state.intervention_level` 互不影响）。**所以解散不去顺手做画像账号化，也不为它新造表**（那违背 0267 "不新造机制"那条）。第一批按现状销毁，恢复那批之后再补。

顺带两条读侧事实，免得再被旧说法带偏：作答模态与 TTS 引擎/音色偏好**不是**空间级，它们写在 `user_learning_preferences` 的账号行（`workspace_id IS NULL`）里，判据只有一处 `resolveTtsSelection`（`companion-shell/service.ts:916-946`、`:993`、`:1005-1080`）；`companion_room_profiles` 才是 `(ws,user)`，0266 那个空间级打扰开关刻意落在它上面（`0266:12-13`）。

### D 类：证据与账 → 要活得比空间久
`workspace_audit_log`、`ai_audit_log`、`companion_audit`。留墓碑 + 清除时**跳过**这三张。它们的价值恰恰是"事后追责"，空间不在了才更需要。

## 6. 前置缺陷：dev 看不见生产权限面

**这一条独立于解散，而且比解散严重。** 机制：`notes` 的 RESTRICTIVE 守卫实测只有一个分支

```
sec01_v1_notes_tenant_guard (RESTRICTIVE, FOR ALL)
  USING (workspace_id = (NULLIF(current_setting('app.workspace_id', true), ''))::uuid)
```
**没有**"没设上下文就放行"那一支（对比：`workspaces` 的守卫是 `(NULLIF(...) IS NULL) OR (id = ...)`，带那一支；`users` 干脆没启用 RLS）。所以不带上下文、以受限角色跑的裸读恒为 0 行。

**量到的两条症状：**

1. **笔记 30 天物理清除从未清过任何东西。** `note/maintenance.ts:34-41` 的外层候选扫描用裸 `db` 句柄：以 `ailearn_api` 跑，`notes` 里 **877** 行一篇都选不出来；把 `app.workspace_id` 设成一个真实空间，立刻读到 **22** 行；`has_table_privilege('ailearn_api','notes','SELECT')` = **t**，所以不是授权问题。CLI 那份更糟：`:74` 裸扫描没上下文，`:118` 又是裸 `db.transaction`，**上下两半都瞎**（定时器那条只修了下半，`maintenance.ts:20-25` 的注释记的就是这件事）。
2. **实时协同编辑在受限角色下连不上。** 同一套 `note-collaboration-postgres.integration.ts`、同一份代码、同一个 dev 库，只换连库角色：

| 连库角色 | 结果 |
|---|---|
| `ailearn`（BYPASSRLS，**dev 用的就是它**，`docker-compose.dev.yml:10`；`pg_roles`: `rolsuper=t, rolbypassrls=t`） | 16 tests / **16 过 / 0 红** |
| `ailearn_api`（NOBYPASSRLS，`ci.yml:386` 等，也是 `client.ts:24-36` 在生产下强制要求的那个） | 17 tests / **4 过 / 13 红**，日志打出 17 次 `note_not_found` |

红的全是"连接该被接受 / 写入该落库"的那半（`collaboration.ts:97` 裸读 `notes` → `undefined` → `:103` 抛 `note_not_found`）；过的 4 条正好全是"该被拒"的用例——**拒绝类断言在"什么都读不到"时照样绿**，所以这套测试看起来永远健康。（两轮 tests 计数差 1，那条多出来的我没逐字追，记在这里不当已知。）

worker 早在 `compose:13` 换成受限角色了，**API 没换**。`gh run list` 最近 5 次 CI 全 `failure`，是不是同一条因我还没核。`apps/api/src/modules` 里非测试的裸 `db` 用法共 **21 处**，**我没有逐条核**它们各自命中哪张表的哪种守卫。

**今天漏掉的量**：库里 10 篇软删笔记，最早一篇 `deleted_at = 2026-09-16`，`deleted_at < now()-30d` 的行数 = **0**，第一篇越过保留期在 **2026-10-16**。所以清除那条目前无实害；协同那条不一样，它是上线第一天就没人能用。

**对本方案的后果**：§5 的清除**不要**沿用"外层裸扫描选候选"这个形状——我第一版写的是"抄笔记清除，这是库里已有的正确模式"，那句是错的，它正是坏的那半。两条出路：候选选择也做成 `SECURITY DEFINER`（owner = `ailearn_migrator`，正是 `learning-sessions/ttl-maintenance.ts:11-15` 已经写下的理由），或先枚举空间再逐空间带上下文。**前者与 §5 那个执行器同形，我选前者。** 并且清除相关的一切验收必须**显式用 `ailearn_api` 连接跑**，dev 绿不构成证据。

## 7. 物理清除：复用，不新造

`0265_orphan_purge_respects_immutability.sql` 里已经有一个能用的执行器（`ailearn_purge_workspace_orphans`，前身 `0264:34-84`）：表清单**动态枚举** `pg_attribute` 里带 `workspace_id` 的所有表、不写死名单（`0264:17-18` 的理由：写死就意味着下次新增表又漏了）；最多 10 轮、跳过带非内部 `BEFORE DELETE` 触发器的表、按表捕获 FK 冲突推迟到下一轮；结束后**重数并如实报告**残留及原因（`:124-128`：静默跳过会让人下次问"清干净了吗"拿到假 yes）；默认 dry-run；EXECUTE 只授 `ailearn_migrator`，HTTP 侧碰不到。

**唯一要改的是判据**：它现在跑在"空间行已经没了"之后，谓词是 `NOT EXISTS (SELECT 1 FROM workspaces …)`。留墓碑之后这条永远不成立，要加一个 `$1 = workspace_id` 的变体。

每个清除事务里设两个局部 GUC：`app.memory_sync='on'`（B 类抑制）、`app.allow_history_mutation='on'`（放行 5 张不可变表，见 D3；今天只有测试在用，`integration-tests/helpers/v2-card-fixture.ts:173`）。

## 8. 恢复：一个不显然的细节

恢复**不能**简单"把所有 `left_at` 清掉"——`left_at` 非空有两种来源：解散时被打上的，和解散前就自己退出的。混在一起会把早已退出的人塞回空间。

所以发起解散时要在同一事务里快照当时的活跃成员名单。不需要新列：`workspace_audit_log.detail` 就是为此存在的 jsonb（`0263:35-36`），记 `action='workspace.dissolve_requested'` + `detail={memberUserIds:[…]}`，恢复时按这份名单精确复位。这依赖 §4 的留墓碑决定——空间行删了，这条审计行就 CASCADE 走了。

恢复还要重新过配额：宽限期内名额是释放的，可能已被新空间占满。**必须如实失败**（返回 `workspace_limit_reached`，提示先解散另一个），不能默默恢复成功让人超限。

发起时同事务内还要做的：全员 `left_at`、按 `(workspace,user)` 吊销会话（复用 `invite-service.ts:598` 那段）、`recordWorkspaceAudit`（`audit/service.ts:40-52`，动作枚举是闭集 `:26-31`，要加 `workspace.dissolve_requested` / `workspace.dissolved`）。epoch **不用手写**：成员行的 `left_at` 变化会被 `0261:86-90` 那个 `AFTER UPDATE … WHEN (left_at IS DISTINCT FROM …)` 触发器自动 +1。

## 9. 要你拍板的四个（含我的建议）

- **D1 留墓碑、永不 `DELETE FROM workspaces`** → **建议：是**。代价：11 张今天靠 CASCADE 的表要显式清（本来也只有一套清扫在跑）。
- **D2 `pet_profiles` 的亲密度与人格随空间死还是跟人走** → **建议：跟人走，但第一批不做**，等画像账号化那批先落地，别两边同改一张表。
- **D3 那 5 张有"不可变"触发器的表**（`card_candidate_quality_reports_v2`、`evidence_snapshots_v2`、`learning_exposures_v2`、`learning_objective_equivalence_reports_v2`、`semantic_support_reports_v2`）**能不能随空间销毁** → **建议：能**。`0265:18-21` 已明说这是产品决定、不是清理脚本能替它做的。理由：不可变是为了让卡生成链的因果可追，不该比产生它的空间活得久。
- **D4 成员侧看到什么** → **建议：只有 owner 能恢复**；被牵连的成员下次进应用看到"某某空间已解散"（他们自己的副本也一起没了，不该只用一次 401 糊过去）。解散前的通知窗口我倾向**不做**（没有推送通道），只在列表里留一条可见痕迹。这条我拿不准，是唯一一条我认为可能改的。
- **D5 成员退出/被移出后的数据归属（已移交，不在本方案内做）**：退出链路本身是完整的（`identity/service.ts:1009-1060` 只做四件事、**不碰任何用户数据**），缺的是"留下那批东西归谁管"的规则——证据是 9 支迁移 + 10 处 TS 各自学了一遍 `left_at IS NULL`、日记调度器为此改了四版、`0259:52-53` 的补法。我建议的判据是一句话：**离开（自退／被移／被解散牵连）一律不删数据，数据算这个空间的资产，"谁产生的"必须留得住，只有解散到期的物理清除才销毁它**（因为退出本来什么都不删、重新加入即原样回来，所以真问题不是"还在不在"而是"谁看得见、谁负责、再进来算谁的"）。2026-09-22 已连同 §6 的两条量测一起交给 `docs/plans/34-systemwide-loop-closure-audit-2026-09-22.md` 那条会话收口，本方案不再持有这条。

## 10. 批次与验收判据

| 批 | 内容 | 判据 |
|---|---|---|
| **P0** | 第一步的清单：以 `ailearn_api` 跑笔记协同/笔记/其余裸读相关集测，只量不改 | 一张"哪些链路在受限角色下是红的"表，带复跑命令。**不碰 `compose:10`**（那会让 dev 一起变红，需你点头） |
| **P0b** | 协同编辑那一条（`collaboration.ts:97`）要不要单独立刻修 | 等 P0 的量出来再定；它是"上线第一天没人能用"级别，比"30 天后没清干净"重 |
| B1 | `0269`：`workspaces` 两列 + 审计动作枚举 + 成员快照写点 | 迁移进 `_journal.json` **并应用**；`schema-isolation-gate` 棘轮仍绿 |
| B2 | owner-only 发起：全员 `left_at` + 会话吊销 + 同事务审计 + 名额释放 | 真库集测：解散后该空间任何请求 401；名额从 3 变 2；`/auth/me` 与列表都读不到它 |
| B3 | 解散中列表 + 恢复 + 恢复超限如实失败 | 用例覆盖"解散前已退出的人不会被塞回来" |
| B4 | `0265` 的 `$1=workspace_id` 变体 + 到期清除接入 `server.ts:506-525` 那条 6h 定时器 | dry-run 与实跑一致；残留如实报告；**候选选择走 SECURITY DEFINER** |
| B5 | **B 类抑制断言**：解散 W，同一用户在 P 空间的 `global_key` 副本必须还在 | 这条断言**先看到它红**（不做抑制必红）再绿；验收显式用 `ailearn_api` 连接 |
| B6 | 桌面端：列表分区、输入空间名的二次确认、落回个人空间的文案 | 真窗口点一遍，两账号各验一次 |

B1–B3 = 第二步（不删数据）。B4–B6 = 第三步。

## 11. 与并行会话的撞车（实测）

`git status` 实测：`0257`–`0268` **12 支迁移全部未提交**（`??`），`meta/_journal.json` 有改动。其中 `0264/0265`（孤儿清理＋所有权转让）、`0266`（空间级打扰开关）、`0267/0268`（跨空间记忆）都和本方案直接相关，而 0267/0268 **已经应用到 dev 库**（所以 §5 B 类的数字是真的）。

迁移编号从 `0269` 起。`_journal.json` 上别人的条目不是我不写不应用的理由——照写、照登记、照应用，冲突留到提交时报。

## 12. 有意不做的

- **归档／暂停**：见 §3。要"人还在但数据看不见"，就得给每条读路径加判断，101 张表几十个投影，漏一处就失效。
- **账号注销／"删掉我的全部数据"**：同一片数据终局问题，但那是跨所有空间的另一条边界，别混进这次。
- **导出补伴星表**：现在 `export/service.ts` 只导 `notes / note_versions / note_blocks / sources / source_segments / review_schedules / validation_assistance_exposures / onboarding_states / users / workspace_members`，**伴星表一张都不导**——这和 doc 22 `:1230`/`:1617`（"导出包含记忆""删除时级联删除"）互相矛盾，那份文档的假设在库里不成立。这是独立的一条缺口，不该由解散顺带解决。
- **0267 迁移头与代码不一致**（头里还写着 `interaction_note` 跟人走，代码已改回本地，`companion-memory-extractor.ts:60-63`）：归 0267 那批一起收，我不在这里改。
