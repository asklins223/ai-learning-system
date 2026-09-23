# 项目性能问题扫描报告（2026-09-22 全量重扫）

> 扫描时间：2026-09-22
> 扫描范围：`apps/api`、`apps/desktop-client`（main / preload / renderer）、`packages/shared`、`packages/ai-quality`、`workers/ai-worker`，以及构建产物 `apps/desktop-client/out/` 与打包配置。
> 方法：静态读码 + 真实测量（运行中的 `:4000/metrics`、开发库 `pg_stat_*` / `pg_indexes` / `pg_proc` / `EXPLAIN`、磁盘与包体实测）。
> 说明：本轮**不沿用**上一轮基线，理由见 §0。

共发现 **59** 项性能风险。

| 严重度 | 数量 |
|---|---|
| High | 8 |
| Medium | 39 |
| Low | 12 |

| 分区 | 数量 | 分区 | 数量 |
|---|---|---|---|
| api | 15 | db-index | 6 |
| renderer | 11 | queue | 6 |
| desktop-main | 11 | worker / trigger / rls / assets | 各 2 |
| retention / build | 各 1 | | |

核实强度：**亲验 52 / 部分 0 / 撤回或不存在 7 / 待核 0**（含义见 §2；09-23 收口过程见 §9「待核列清零」）。原先这行写的是"亲验 25 / 部分 4 / 待核 30"——那 30 条里有 17 条其实早就在本轮逐条读过码并改过，只是状态列忘了更新。（"撤回"这列里 M37 记的是**后半句**：加入空间的扇出为真、AI 同意那条为假。）

**要继续做这一摊，直接跳 §11「还剩什么（冷启动可执行）」**：§11.1 是下一条要动的 M16（三步 + 三条验收判据），§11.2 是 H2 的前置条件，§11.4 列了七条已被实测推翻、不该重开的项。已落地的部分在 §9（含 §9.6 的验证汇总），唯一能归因的性能数字在 §10。

## 0. 为什么 8 月那五轮记录不能当基线

`docs/performance-scan-2026-08-16*.md` 五轮的扫描对象是 `apps/web`、`apps/desktop`、`packages/db`、`workers/ai-worker/src/agent/**`——这些目录**现在都不存在了**（已确认）。全仓库只剩 8 处 `审计 #` 注释活到今天的代码里。所以那份"共 37 项、已修 33 项"的结论对当前的树没有意义，本轮从零重扫。

少数条目属于"8 月报过、今天仍在"的复发项，单列在 §7。

## 1. 实测基线（本轮所有结论的地面真值）

开发栈在跑（api / worker / postgres / minio / edge-tts），直接取了 `:4000/metrics` 的真实直方图。**开发库最大的表只有 2.5 MB**：

| 端点 | 平均 | 样本 |
|---|---|---|
| `/voice/tts` | 1082 ms | 8 |
| `/uploads/*` | 458 ms | 11 |
| `/companion/home-projection` | 135 ms | 15 |
| `/v2/learning-dashboard` | 87 ms | 27 |
| `/me/companion` | 86 ms | 30 |
| `/auth/me` | **53.9 ms** | 204 |
| `/auth/capabilities/v1` | 51.5 ms | 68 |
| `/v2/card-generation-runs/active` | 40.7 ms | 27 |
| `/ready`（3 次往返） | **4.5 ms** | 277 |

`/ready` 给出标尺：3 次往返 ≈ 4.5 ms。所以 `/auth/me` 的 54 ms 约等于**三十多次串行往返**，`card-generation-runs/active` 的 40.7 ms 约等于 40 次往返——**数据量在这些数字里不是变量**。

其他实测事实：

- 连接占用（`pg_stat_activity`）：`ailearn_api` 7、`ailearn_worker` 5，`max_connections = 100`。
- 索引普查（`pg_stat_user_indexes`，我自己的口径：非主键且 `idx_scan = 0`）：**283 个里 87 个从未被扫过，9.0 MB / 21 MB 索引字节**。
- 外键普查：**151 个单列外键里 97 个，其外键列不是任何索引的首列**。
- 空转 90 秒只产生 18 个请求（其中 17 个是 `/ready` 健康检查）——所以 `pg_stat` 里那些几万次的 `seq_scan` 是**几个月开发累计**，不能读成"当前负载"。
- 宽行实测（`octet_length`）：`sources` 平均 **31 KB/行**，`search_documents` 13 KB，`card_generation_candidates_v2` 4 KB。
- 渲染层体积：`out/renderer` 381 MB（228 models + 138 assets + 15 sherpa）；单个 eager JS chunk **4.66 MB**；CSS 1.09 MB；198 个 woff2 共 10 MB；`public/assets` 里 82 张 PNG 共 91 MB。

## 2. 核实口径（这一轮必须有）

本轮有**两份子代理报告因编造证据被整份否决**——它们发明了库与 schema 里都不存在的表名（`learning_objective_links`、`learning_objective_evidence`、`job_outbox_events`、`learning_run_artifact_records`）、编了对不上的 `pg_stat` 数字（声称 46,081 次顺序扫描，实测该表 48 次）、编了不存在的标识符（`sseProxies`、`SNAPSHOT_CACHE_TTL`），并给出指向无关代码的行号。

因此下表 `核实` 列只有三个值，请后来者按这个强度使用本文：

- **亲验**：我打开过那段代码或在库上复跑过该查询。
- **部分**：机制的核心一环我亲验，频率或数值来自报告未复核。
- **待核**：来源可信但未逐条复核，动手前先复现。

## 3. 完整发现清单

| ID | 严重度 | 分区 | 文件 | 行 | 类别 | 问题 | 核实 |
|---|---|---|---|---|---|---|---|
| H1 | High | renderer | `companion-chat-session.tsx` / `CompanionHud.tsx` | 1287,1817 / 718,843 | Re-render | 每个 token 换掉整个 context 值，触发一个**无依赖数组**的 effect 重跑全量布局测量 | 亲验 |
| H2 | High | worker | `card-generation-v2-handler.ts` | 2233,3786-3787 | 长事务 | LLM 调用在事务内，一 job 一个最长 20 分钟事务 + `FOR UPDATE`；代码自陈长期正解未实施（**09-23 收窄，见 §4 H2 更正**：96 次调用的作者段已经不在事务里了，剩下的只有规划段与三个二次 job） | 亲验 |
| H3 | High | db-index | `workspace_members` | 仅 `pk(workspace_id,user_id)` | Missing index | "我属于哪些空间"无 user_id 前导索引，实测 `Seq Scan`；在登录/切空间/配额与两个 SECURITY DEFINER 函数上（**09-23 更正：不在"每个已认证请求"上，`decodeToken` 用的是复合主键**） | 亲验 |
| H4 | High | api | `identity/service.ts` | 365-410 | Per-request cost | 每个已认证请求一个专用事务 + 4 次读，全 API 无跨请求缓存 | 亲验但**判定不改**（09-24 读过实现：3 次窄列读 + 一次罕见写，同一个事务，本地 socket 上按 §1 的标尺"3 次往返 ≈ 4.5 ms"推算单条亚毫秒；唯一能省的做法是加跨请求缓存，而这条路径承载 ADR-0009 的语义——**被移出空间即刻吊销会话**（`membership.leftAt !== null` 就删 session）。缓存会把吊销变成有延迟的事，那是安全/产品取舍，不是性能优化。真要动，先决定"能容忍多长的吊销延迟"） |
| H5 | High | api | `generation-run-service.ts` / `helpers.ts` | 469-476 / 106-124 | DB-N+1 | 20 个 run 扇出，每个无 LIMIT 读全部 `note_blocks` 重算 hash，run 之间还重复 | 亲验 |
| H6 | High | assets | `sherpa/asr-worker.js` | 37-48 | Memory | 228 MB 模型 fetch→arrayBuffer→MEMFS，双份驻留；worker 单例成功后永不 terminate（**09-23 更正：`new Uint8Array(buffer)` 是视图不是拷贝，搬字节的是 `FS.writeFile`**） | 亲验 |
| H7 | High | desktop-main | `note-doc-cache-store.ts` | 246-258 | IO/CPU | 每次自动保存把整份本地缓存全量 snapshot+ zod parse+ stringify+ 写盘+rename | 亲验 |
| H8 | High | db-index | `card_generation_runs_v2` | 4 个二级索引均无 user_id | Missing index | 所有"我的运行"谓词只能读完整空间历史再筛 | 亲验 |
| M1 | Medium | api | `generation-run-service.ts` | 540-546 | DB-unbounded | `tx.select()` 全候选全行（5 个 jsonb 含题面）再在 TS 里去重取最新修订 | 亲验 |
| M2 | Medium | db-index | `markdown-import-service.ts` | 354 | Index unusable | `content_json->>'importId'` 用不了 `jsonb_ops` GIN，幂等检查在 advisory lock 里全扫 | 亲验 |
| M3 | Medium | api | `note/collaboration.ts` / `document-state.ts` | 144,158 / 117,158-162 | Algorithmic | 整文档重编码 + 整份拷贝 + 手写逐字节比较 + 默认参数二次编码 + 全量投影 | 亲验 |
| M4 | Medium | api | `document-state.ts` | 404-411 | DB-N+1 | 每个改动 block 一条 UPDATE（insert/delete 已批量化） | 亲验 |
| M5 | Medium | renderer | `use-note-doc-live-view.ts` | 313,501 | Algorithmic | 每次本地 yjs 事务 bump revision → 整文档转 ProseMirror JSON，即每 keystroke 一次全量重投影 | 亲验 |
| M6 | Medium | renderer | `CompanionHud.tsx` | 2390 | Timer | 60 ms `setInterval` 依赖为 `[]`，整个会话不停 | 亲验 |
| M7 | Medium | worker | `companion-memory-embedding.ts` | 74-105 | Serial batch | 200 次串行 embed（且不传 signal），每行再开一个带 `lockJobLease` 的事务 | 亲验 |
| M8 | Medium | queue | `ailearn_claim_jobs`（`pg_proc`） | ORDER BY 分支 | Missing index | 认领按 `CASE` 表达式排序，每次轮询全量排序 | 亲验 |
| M9 | Medium | db-index | `search_documents` | 4 个 trigram GIN | Dead index | 全部 `idx_scan=0`（3320 kB×2 + 120 kB×2）；两条 `WHERE workspace_id IS NOT NULL` 因该列 NOT NULL 而与另两条完全重复 | 亲验 |
| M10 | Medium | db-index | 全库 | — | Dead index | 87/283 非主键索引从未被扫，9.0 MB；`note_versions` 上 `(note_id,version_no)` 有一模一样的一对 | 亲验 |
| M11 | Medium | db-index | 全库 | — | FK index | 97/151 单列外键无前导索引，父表删除时子表全扫 | 亲验 |
| M12 | Medium | desktop-main | `desktop-ipc.ts` / `desktop-gateway.ts` | 1477 / 1436-1448 | Redundant request | 每个受控动作先 `await getCapabilities()`，完全不缓存，实测该端点 51.5 ms | 亲验 |
| M13 | Medium | renderer | 渲染层全局 + `App.tsx` | 171-178 | Re-render | 全仓库 0 个 `React.memo`，且 `windowState` 挂在根组件 → 一次失焦全树重渲染 | 亲验（09-23 计数复核：`grep -rn "memo(" apps/desktop-client/src/renderer/src`（去测试）**命中 0**，"0 个 memo"属实。后半已落地——根组件上的 `windowState` 订阅与 `data-window-state` 属性都删了（§9），并留了一条静态守卫 `src/main/app-render-scope.test.ts` 钉住"不再有人订阅它"。剩下的"要不要给渲染树补 memo"停在 §11.3：先得有一条能数出重渲染次数的量法） |
| M14 | Medium | renderer | `companion-chat-session.tsx` | 1285 | Algorithmic | `slice(0,appendFrom) + delta` 全缓冲复制两遍，O(n²) | 亲验 |
| M15 | Medium | renderer | `companion-markdown.tsx` | 56 | Algorithmic | 十趟正则跑在全量累积文本上、写在渲染体里无 memo | 亲验（本轮读码或测试复现，见 §9） |
| M16 | Medium | desktop-main | `desktop-ipc.ts` / `desktop-gateway.ts` | 1158 / 2158 | Power | 心跳与 2 条 SSE 不看窗口可见性，最小化后仍维持 2 条常连接 + 1 次/分钟续约（**09-24 实测修正**：原文「6 请求/分钟」是推算出来的，SSE 长连接不结束就不进 `http_requests_total`；fence 在跑着的实例上量到 1/min） | 亲验（本轮读码或测试复现，见 §9） |
| M17 | Medium | desktop-main | `desktop-gateway.ts` | 5 处 SSE | Reconnect | 断线固定 1000 ms 重连，无退避无抖动，且每次重连重跑整套 HMAC+health 握手 | 前半亲验并已修（退避+抖动，见 §9）、**后半撤回**（09-23 读代码：`ensureConnected()` 在 5 个 watcher 里都只在 `run()` 进入循环**之前**调一次（如 :2086、:2150），重连路径是 `waitForStreamRetry(...)` 之后回到循环顶部**只重发 fetch**，不会重跑握手。所以"每次重连重付一次握手"不成立，剩下要治的只有频率——那半已经治了。） |
| M18 | Medium | desktop-main | `desktop-gateway.ts` | 1767-1838 | Redundant work | `getRoomProjection` 3 次串行 HTTP + 4 次深度 zod，**304 命中仍全量重投影** | 亲验（本轮读码或测试复现，见 §9） |
| M19 | Medium | desktop-main | `desktop-ipc.ts` | 902-920, 1417-1432 | Redundant work | 每个 IPC 响应在 main 里再校验一次（zod 深拷贝）；广播在订阅者循环内逐份 parse + 同步 `randomBytes` | 亲验（09-23 定位：广播侧确实在订阅者循环内逐份 parse——`desktop-ipc.ts:1468` 那句 `gatewayEventSchema.parse` 就在 `for (const [subscriptionId, subscription] of subscriptions)` 体内，每份还各调一次 `generatedOpaqueId("cursor")`（:742 是 `randomBytes(12)`）。**但成本已量化**：一帧 4 MB 上限的 `note_doc_event` parse 实测 39 µs、常态小帧 28 µs，而同帧 `structuredClone` 1.55 ms——这一条不是要动的量级，理由与撤回过程见 §9 的 L19 一段。响应侧"出口再校验一次"这一半只确认了形态，**未量化**。 |
| M20 | Medium | desktop-main | `desktop-ipc.ts` / contracts | base64 段 | Payload | 图片/音频以 base64 过桥，契约只有 `z.string().min(1)` 无上限（10 MB 音频→13.4 MB 字符串） | **不存在**（09-23 实测撤回：过桥契约里没有任何 base64 图片/音频字段；唯一的大 base64 是 yjs 增量，它已带 `NOTE_DOC_UPDATE_MAX_CHARS` 上限，见 §1381-1386） |
| M21 | Medium | desktop-main | `index.ts` | 140-148, 263-278 | Startup | 每个资源请求 2 次 `realpath` + 1 次 `stat`；`onBeforeRequest` 挂 `<all_urls>` | 亲验（本轮读码或测试复现，见 §9） |
| M22 | Medium | renderer | `CompanionPresence.tsx` | 1059-1142 | Layout thrash | 拖动 pointermove 里读写交替 + `querySelector`，60–125 Hz 下必掉帧 | 亲验（09-23 重读：形态仍在，但行号已迁移——现在是 `CompanionPresence.tsx:472-479` 与 `:544-548`，同一函数里 `querySelector`×2 + `getBoundingClientRect`×3 + `offsetWidth` 读回交替） |
| M23 | Medium | renderer | `CompanionHud.tsx` / `CompanionChatRecord.tsx` | 2213-2218 / 27 | Virtualization | 聊天历史无虚拟化，`renderArticle` 依赖 `[chat]` 每 token 新建，每条消息每渲染 `new Intl.DateTimeFormat` | 亲验（本轮读码或测试复现，见 §9） |
| M24 | Medium | renderer | `use-note-doc-live-view.ts` | 43-59 | Algorithmic | 手写 base64 用 `+=` 逐字节拼（O(n²)）；每个远端帧解码再编码一遍只为校验 | 亲验（本轮读码或测试复现，见 §9） |
| M25 | Medium | renderer | `hud-surface.css` / `home-v2.css` | 2592 等 / 113 | Compositing | 18 处 `backdrop-filter: blur(20px)` 叠在每帧变化的场景上，还有一处挂在正在 transform 的伪元素上 | 亲验但**数字错**（09-23 实测：`backdrop-filter: blur(20px)` 只有 **3** 处，不是 18 处；全 renderer 的 `backdrop-filter` 共 51 处。结论方向不变、量级要按 3/51 重算） |
| M26 | Medium | build | `electron.vite.config.ts` | renderer 段无 `build` | Bundle | 4.66 MB 单个 eager chunk，无 manualChunks、全仓无 `React.lazy`；pixi/milkdown/gsap 首屏全解析 | 亲验 |
| M27 | Medium | queue | `companion-thought.ts` | 907-941 | Serial | ≤3 个候选串行、每个 75 s 预算 vs 110 s handler 超时 → 第 1 个慢就整单失败重投、重付已计费调用 | 亲验（本轮读码或测试复现，见 §9） |
| M28 | Medium | queue | `index.ts` | 482-487 | Scheduling | V2 outbox 轮询排在主队列槽位检查之后，主队列满时最长 110 s 不领取也不续约 | 亲验（本轮读码或测试复现，见 §9） |
| M29 | Medium | queue | `queue.ts` / `handler-timeout-config.ts` | 21 / 18-19 | Duplicate work | 租约 120 s vs handler 110 s 只剩 10 s 收尾余量，且租约只在提交时续 → 越界被 reaper 重投 = 重复付费执行 | 亲验但**机制撤回**（09-23 读定义：`queue.ts:21` 的 120 s 是**主队列**租约，而 `workers/ai-worker/src/lib/handler-timeout-config.ts:18-19` 把每个 handler 超时**硬夹**在 `LEASE_TIMEOUT_MS - 10_000`——那 10 s 不是「记得对齐」的人肉约定而是代码保证，该文件 :27 的注释明写「这里不写数字，以前它是字面量 110_000」。V2 outbox 又是另一套：`V2_OUTBOX_LEASE_TIMEOUT_MS = 30 * 60_000`（handler :146）配 120 s 心跳（:750-753）+ 丢租约即 abort（H5），所以「只在提交时续」对 V2 不成立。**残留的真问题只有一条**：主队列 handler 没有中途续约，真跑超 110 s 会被收走**重投重付**——M7 把 200 行串行 embed 压到一分钟量级正是为了离这条线远一点，结构耦合仍在。原文那条文件路径 `src/handler-timeout-config.ts` 也已迁移到 `src/lib/`。） |
| M30 | Medium | api | `stats/service.ts` | 126-147 | Aggregate-in-JS | 拉全部 binding 行到 JS 里数 DISTINCT，号称的 2000 上限并不限制这条查询 | 亲验（本轮读码或测试复现，见 §9） |
| M31 | Medium | api | `review/service.ts` | 424-429, 226-247 | DB-unbounded | 读用户全部 exposure 历史再在 TS 筛给 50 条；同一事务同一谓词全行查两遍 | 亲验（本轮读码或测试复现，见 §9） |
| M32 | Medium | api | `learning-objectives/surface-service.ts` | 345-437 | DB-unbounded | runIds 无上限收集后喂给两个 `inArray` | 亲验（本轮读码或测试复现，见 §9） |
| M33 | Medium | api | `source/service.ts` → `note/service.ts` | 574 → 171 | IO-in-tx | 单篇保存路径在事务内从 MinIO 拉图（批量导入路径已修，这条没修） | 亲验（本轮读码或测试复现，见 §9） |
| M34 | Medium | api | `card-generation-v2/routes.ts` | 317-338 | SSE poll | 每 2 s 开一个完整事务且**没有** in-flight 守卫（隔壁 `inbox-routes.ts` 专门加了） | 亲验（本轮读码或测试复现，见 §9） |
| M35 | Medium | rls | 全库策略 | `pg_policies` | RLS | 策略普遍是 `(CURRENT_USER='ailearn_worker' OR workspace_id = current_setting(...))`，因那个 `OR`，空间等值只能落在 `Filter` 上，逐行 `current_setting`+cast | **机制撤回**（09-23 用受限角色 `ailearn_api` 实测 EXPLAIN：策略里的空间等值进了 **`Index Cond`**，`current_setting` 只在计划期出现一次，不是"因那个 OR 而逐行 Filter+cast"。只有走 heap/Seq 计划的查询里它随整条谓词每行求值——那不是 OR 造成的。策略形状统计是真的：121 条 permissive 里 81 条带 `ailearn_worker` 分支、143 条里 103 条用 `current_setting` 比空间） |
| M36 | Medium | rls | `ai_audit_log` / `workspace_audit_log` | owner-read 策略 | RLS | 唯二带子查询的策略，逐行 `EXISTS` 探查 workspaces | 亲验（09-23：全库含 `EXISTS` 的策略**恰好只有** `sec01_v1_ai_audit_api_owner_read` 与 `sec01_v1_workspace_audit_log_api_owner_read` 两条，与所述一致） |
| M37 | Medium | trigger | `0267` / `0261` | 186 / 88,123 | Write amplification | 加入空间触发 `1 + M × (W-1)` 条 insert；改一次 AI 同意对每个空间各发一条 `UPDATE workspaces`（而该行每个请求都读） | 前半亲验、**后半撤回**（09-23 读 `ailearn_backfill_global_memories_on_join`：对「该用户其它空间里每条 distinct `global_key` 记忆」各调一次 `ailearn_fanout_global_companion_memory`，后者再 `FOR target IN SELECT workspace_id FROM workspace_members …` 逐空间铺行——量级确为**记忆数 × 其它空间数**；`NEW.left_at IS NOT NULL` 时直接 return，退出不铺。后半**不成立**：AI 同意现在根本不在 `workspaces` 上——它存在 `onboarding_states.completed_steps`（jsonb，按 (workspace,user) 一行，见 `markOnboardingStep` 与 sec02 夹具 `'"ai_consent": true}'::jsonb`），全仓 `apps/api/src` 里除测试与一个 `ai_consent_required` job 原因码外**没有**任何 `UPDATE workspaces` 的扇出；0237 早已 `DROP COLUMN workspaces.ai_consent_version`。顺带核到那条 `BEFORE UPDATE ON workspaces` 的 `ailearn_bump_epoch_on_workspace_change` 只在 `name / owner_id / workspace_type` 变化时递增 epoch，所以这类 UPDATE 也不会引发纪元风暴。） |
| M38 | Medium | trigger | `0044` | 358-361 | Write amplification | `note_blocks_sealed_guard` 每行 block 多一次 `note_versions` 查询，配合 M4 放大 | 亲验（09-23 读 `ailearn_guard_sealed_note_blocks` 函数体：FOR EACH ROW，每行一次 `SELECT sealed_at FROM public.note_versions WHERE id = …`。走主键所以单次便宜，但「每行一次」是结构性的，与 M4 的全量 block 写叠加＝一次保存 N 行就 N 次探查。注意这条守卫是**不可变性的执行者**，要减它的成本得换判定来源，不能删） |
| M39 | Medium | retention | `jobs` / `card_generation_events_v2` 等 | — | Unbounded growth | `jobs` 与多张追加表无任何 DELETE/TTL；`jobs_status_idx` 非部分索引，认领索引随历史永久增长 | 亲验（09-23 两条都查到具体证据：**全仓 `DELETE FROM jobs` 只出现在 5 个测试夹具的 cleanup 里**（`integration-tests/helpers/v2-card-fixture.ts:221` 等），生产代码零 purge；`pg_indexes` 实测 `jobs_status_idx (status, scheduled_at)` 与 `jobs_status_started_at_idx (status, started_at)` **都是非部分**索引，覆盖含终态在内的全部历史行，而认领只关心 pending/running。缺的是"多久历史还要能被回答"这个决定，不是技术——见 §11.3） |
| L1 | Low | api | `search/routes.ts` | 12 | Pagination | 深 OFFSET（旧轮 8 月已报，未修） | **不存在**（09-23 实测：`apps/api/src/modules/search/*.ts` 里没有任何 `offset`，路由与游标都是 keyset——`search/routes.ts:14-16` 明写"不透明游标，解不开就 400，绝不悄悄回退到第一页"。这条 8 月的旧账已经还掉了） |
| L2 | Low | api | `companion-events.ts` | 636-648 | SSE poll | 2.5 s 定频不退避（同文件其余实现有退避） | 亲验（本轮读码或测试复现，见 §9） |
| L3 | Low | api | `identity/service.ts` | 270-272 | CPU | 纯 JS bcrypt 在主线程，注释自陈 50–150 ms | 亲验（09-23 读 `identity/service.ts:270-273`：注释自陈 bcryptjs 纯 JS 主线程 cost10 ≈ 50–150 ms，且已刻意把哈希放在开事务之前） |
| L4 | Low | api | `qwen-tts.ts` | 259-304 | Latency | 连接池复用门只看 `alive` 而监听器已摘除 → 上游关闭不被察觉，白等 30 s | 亲验（本轮读码或测试复现，见 §9） |
| L5 | Low | api | `learning-runs/run-processing-tick.ts` | 1059 | Delete-on-read | 循环内每轮执行一次 DELETE | **不存在**（§9 续批三：该文件里 DELETE 命中数为 0） |
| L6 | Low | queue | `0115` + `index.ts` | — | Wake-up | NOTIFY 只在 INSERT 触发，重试是 UPDATE 不叫醒，空闲已退到 5 s → 重试白等 ~4.5 s | 亲验（本轮读码或测试复现，见 §9） |
| L7 | Low | queue | 各 scheduler | — | Duplicate work | 每个 worker 实例都跑同一批 30 s 清扫（注释承认多副本重复扫） | 亲验（09-23：`REAP_THROTTLE_MS = 30_000` 配的是模块级 `let lastReapAt = 0`，即**每实例各节流各的**；`grep advisory workers/ai-worker/src/*.ts` 命中 0，没有任何跨实例守卫。多副本时确会各扫一遍） |
| L8 | Low | desktop-main | `note-doc-cache-store.ts` | 252 | Disk | 临时文件名带 `randomUUID()`，崩溃残留永不清理 | 亲验 |
| L9 | Low | desktop-main | `desktop-ipc.ts` | 1031,1260-1262,2801 | Leak-ish | `trackedLearningRunIds` 只增不减，subscribe 为每个历史 run 重开一条 SSE | 亲验（本轮读码或测试复现，见 §9） |
| L10 | Low | desktop-main | `preload/index.ts` | 49-51 | Startup | `sendSync` 同步取 contract，会排在 main 的忙活后面 | 亲验（09-23 读 `preload/index.ts:49-51`：模块顶层 `ipcRenderer.sendSync(contractGetSnapshot)` + 立即 zod parse，渲染层启动第一步就同步等主进程） |
| L11 | Low | renderer | `components/scene/**` | — | Dead code | 整条 Pixi 场景链无人引用（`RoomSceneCanvas` 无导入方，`RoomStage.tsx:248-249` 硬编码 active=false）却仍在图里 | **描述错了**（09-24 直接反证：`App.tsx:3` import 并在 `:124` 渲染 `<RoomStage />`，`scene/` 一族被 `AuthAmbientCanvas` / `DirectoryRail` / `TaskSurface` / `DesktopAccessGate` / `SourceIntake` / `media/learning-room-manifest.ts` 引用——**这条链是活的**。剩下能成立的只有一个很窄的问题：`RoomSceneCanvas.tsx` 除自身测试 `RoomSceneCanvas.test.ts` 外**没有非测试导入方**，那是单个组件是否孤立，需按"读出去的那一层"另判（它导出的 `hasExactRoomSceneLayerDepths` 只被测试用），不要按原描述去删整个 `scene/`） |
| L12 | Low | assets | `electron-builder.yml` | `files: out/**/*` | Package size | 只排除 3d，228 MB 模型 + 138 MB 资产全进 asar（单张 PNG 最大 7.8 MB、单段 mp4 12 MB） | 亲验 |

## 4. 重点详述（只展开需要上下文的）

### H1 流式回包是一条完整的掉帧链（三段都亲验过）

1. `companion-chat-session.tsx:1287` 每个 delta `setDraft({ runId, text })` 给一个新对象，而 `:1817` 把 `draft` 放进了 context 的 `useMemo` 依赖 → **每个 token 换掉整个 context 值**；4 个消费者（含从不读 `draft` 的 `CompanionPresence`）全部重渲染。
2. `CompanionHud.tsx:718` 的气泡几何 effect **没有依赖数组**（`:843` 就是 `});`）→ 每次渲染重建 3 个 observer + resize 监听，并跑一遍约 15 次"读→写→再读"的测量链（`:752`→`:753`→`:755`→`:762`→…），每一笔写都在下一次读之前失效样式与布局。
3. `:1285` 的 `slice(0,appendFrom) + delta` 让全缓冲被复制两遍，长度上是 O(n²)。

结论：每个 token = 一次全树样式重写 + 多次强制回流。这是本轮我认为**用户感知第一**的一条。

### H2 事务里做分钟级 LLM 调用（项目自己写着"仍未实施"）

`card-generation-v2-handler.ts:2233` 与 `:3786-3787` 两处注释明说长期正解是把 LLM 调用移出事务、**未在本轮实施**。我核实了后果：一个 job = 一个事务，最长 `V2_PIPELINE_BUDGET_MS` 20 分钟、内含最多 96 次 LLM 调用，还对 run 行持 `FOR UPDATE`；`db.ts:49-53` **故意不设** `idle_in_transaction_session_timeout`（理由正是这条链路），所以 60 s 的 `statement_timeout` 管不到它。池子：worker `clamp(concurrency*4,15,64)`=15、API 25、PG `max_connections=100`。这正是 `client.ts:41-49` 记录的那个"DB 侧无慢查询但 API 偶发 20–207 s"——今天没复现（实测 API 只用 7/25），因为开发库里没人真跑批量制卡。

> **09-23 更正（把 H2 拆到"还剩哪几段"这一层，别照原文动手）**。逐调用点核过事务嵌套之后，上面那段"一个 job = 一个事务内含 96 次调用"**对今天的主管线已经不成立**：
> - **作者段早就在事务外**。`runV2AuthoringPhase:1531-1547` 的读输入用的是自己的短事务（注释 A1·B2：读完就把锁放掉），LLM 作者循环没有任何常驻事务，每张候选由 `commitAuthoredCandidateV2:3630` **单独提交**（`isolated: true`，见 `:418` 那句"默认的 `withWorkerWorkspaceTransaction` 会加入当前作用域里那条事务"）。原因也写在注释里：逐张提交若发生在外层持锁期间，就是同一条管道自己等自己，实测过被 Postgres 判死锁。
> - **评审段主路径 0 次调用**。`reviewAndFinalizeV2Candidates:1800` 那个事务里调 `critiqueAndFinalizeCandidates`，但主管线把候选 i 的 grounding 紧跟候选 i 的 author **在事务外预计算**后以 `precomputedGrounding` 传进去（`:2112-2138`），因此提交前那段只做串行写入与判定。
> - **还剩三处**：① 规划段 `runV2PlanPhase:1252` 把**一次** planner 调用包在持 `FOR UPDATE` 的事务里；② `processRegenerateCandidateJob:2903` / ③ `processReplanSetJob:3073` / ④ `processRecheckCandidateJob:3174` 这三条二次 job **不传** `precomputedGrounding`，于是走 `mapWithConcurrency(…, V2_STAGE_CONCURRENCY, …)` 那一波——**这一波 LLM 就在事务里**（`:2139-2150`）。
>
> **因此 H2 的真实量级是"一次调用到一小波调用"，不是"96 次 × 20 分钟"**，也就不足以解释"API 偶发 20–207 s"（那需要同时占住好几个连接，而这几段各只占 1 个）。
>
> **并且：把规划段简单拆成"短事务读 → 无事务调用 → 短事务写"会开一个双付费窗口。** 今天同 run 的第二个 job 是被 `FOR UPDATE` **挡住**的，等第一个提交后它按 `run.status ∈ {authoring, checking}` 走"从已提交计划恢复、不重新规划"（`:1290-1307`）；拆开之后第二个 job 立刻拿得到锁，而 `planning` 也在放行名单里（`:1310`），租约门闩又只认**自己那条 job 行**的 token——**跨 job 去重只剩 `run.status` 这一个信号**。所以真要动这一条，得连带把"另一个 processing 中的同 run job 存在就让路"做成入口检查（读 `card_generation_run_outbox_v2`，不需要改表），否则省下的锁换来的是双倍计费。这一条按原计划仍属"独立一轮、不批量做"。

### H3 / H8 两个索引缺口，实测比报告更差

`workspace_members` 全表只有 `pk (workspace_id, user_id)`，269 个迁移里没有第二个。我跑 `EXPLAIN SELECT 1 FROM workspace_members WHERE user_id=$1 AND left_at IS NULL` 得到的是**纯 Seq Scan**（比子代理报的"走主键扫"更差）。这条读既在登录路径（`identity/service.ts:197-202`、`:626-631`），~~也在每个已认证请求的 `decodeToken` 里~~，还被两个 `SECURITY DEFINER` 触发函数以同样谓词调用（`0261:123`、`0267:186`）。缺的就是 `(user_id) WHERE left_at IS NULL`。

> **09-23 更正（影响面比原文窄）**：`decodeToken` 里那次成员读用的是 `(workspace_id, user_id)`，正好命中既有主键——**不在**"每个已认证请求"上。真正没索引的是只带 `user_id` 的那几条（登录取空间列表、切空间列举、配额检查）与两个 `SECURITY DEFINER` 函数体内。该建这个结论不变，见 §9「对本报告三处原述的更正」。
> 另外这一句"缺的就是 `(user_id) WHERE left_at IS NULL`"也**没有按原文落地**：0269 建的是**非部分**的 `(user_id)`，因为 `identity/service.ts:445-451` 一类读法根本不带 `left_at` 谓词，部分索引对它们不可用。

`card_generation_runs_v2` 我查到的 4 个二级索引全是 `workspace_id` 开头，`user_id` 一个都不在——而"我的运行"谓词（含每次点击制卡都跑的 in-flight 守卫 `generation-run-service.ts:187-192`）都带 `user_id`。

### M2 一个"以为加了其实没用上"的索引

`markdown-import-service.ts:354` 用 `content_json->>'importId' = $1` 做幂等检查，还在 `pg_advisory_xact_lock` 里。我查了线上：只有 `note_versions_content_json_gin_idx ... USING gin (content_json)`——**`jsonb_ops` 的 GIN 按定义不支持 `->>` 等值**，只支持 `@> ? ?| ?&`；迁移 0164 的注释以为它管住了这个查询。同类 6 处我逐个对过：`learning_runs.origin->>'objectiveId'` 有 0222 的表达式索引（4 个调用点都是好的），`job/service.ts:148` 按 `payload->>` 动态字段查重没有任何可用索引。

### H6 / L12 本地语音那条 228 MB 的账

`asr-worker.js:37-48`：`fetch().arrayBuffer()` → `new Uint8Array(modelBytes)` → `FS.writeFile` 进 Emscripten MEMFS，同一份 228 MB 至少两份同时在内存，之后 onnxruntime 还要再从 MEMFS 载入一次。`local-speech-recognition.ts:24` 的 worker 是模块级单例、**成功路径上永不 terminate** → 用户说过一次话，这几百 MB 就常驻整个会话。加上 `electron-builder.yml` 把 `out/**/*`（除 3d）全打进 asar。

> **09-23 更正（原文两处机制说错了，判断不变）**：`new Uint8Array(arrayBuffer)` 建的是**视图**，不是"一次整份拷贝"——真正搬字节进 WASM 堆的是 `FS.writeFile` 内部那一次。双份驻留的结论仍然对（fetch 那份 + MEMFS 那份），但根因不是这行多拷了一次。见 §9「对本报告三处原述的更正」。

## 5. 桌面主进程：每次自动保存重写整份缓存

`note-doc-cache-store.ts:246-258` 的 `flush()` 是"全量 snapshot → 整份 `storageSchema.parse`（含逐条 base64 正则）→ `JSON.stringify` → 写临时文件 → rename"。渲染层 `use-note-doc-live-view.ts:40` 600 ms、`notebook-surface.tsx:85` 1200 ms 各戳一次；额度是 48 条 × 2 MB、文件 12 MB。个人空间里 WS 流是关的，所以**每次本地写入**都走这条完整重建。这是主进程里唯一一处"CPU 随文档体积 × 打字时长"放大的地方，而窗口拖拽、菜单、IPC 都排在它后面。

## 6. 明确不确定的部分

- `notes.share_scope` / `notes.created_by` 要不要各自建索引：它们只出现在 `or(shareScope='shared', createdBy=me)` 里（`note/visibility.ts:41-43`），这个写法本身无法走索引，且在我看到的每个计划里都排在 `workspace_id` 前缀之后。**不建议动**。
- "现在不痛、形状不对"这一类（M3、M11、M39 等）**都没有实测拐点**：开发库数据量太小，我拿不到"什么时候开始痛"的数字。要做这条线，得先造一份有真实数据量的库。
- 全部 `待核` 条目在动手前需要复现——本轮已证明这类报告的可信度不能默认。

## 7. 与 2026-08-16 各轮重合、至今仍在的条目

| 旧轮次 | 当时位置 | 现在位置 | 状态 |
|---|---|---|---|
| r2 #17 | `import/routes.ts:295-308` import 幂等查询无 LIMIT 读全版本+整份 jsonb | 本文 M2（`markdown-import-service.ts:354`） | 收窄了投影，**索引仍用不上** |
| r2 #1 | `note/service.ts:467-469` 自动保存逐行 UPDATE 改动 block | 本文 M4（`document-state.ts:404-411`） | 搬了文件，**未修** |
| r2 #30 | `inbox-routes.ts` SSE 轮询无 in-flight 守卫 | `inbox-routes.ts` 已加守卫；`card-generation-v2/routes.ts:317-338` 同样问题 | **修了一处，另一处新写出来的没修** |
| r5 #3 | `search/routes.ts:12` 深 OFFSET | 本文 L1 | 未修 |

第三行值得单独注意：同一个反模式在兄弟实现里被修过一次，然后在旁边新写的端点上原样重现——本轮没有 in-flight 守卫的正是新那个。

## 8. 建议动手顺序

初版排序如下；同日实施后每一项的结果标在后面，明细见 §9。

1. **H1**（流式链）——改动小、用户感知最直接。→ 已做几何 effect 与 memo；context 拆分未做，见 §9"明确没做"。
2. **H3 + H8**（两个索引）——一条 migration 的事。→ 已做；H3 实测从 `Seq Scan` 变 `Index Scan`，H8 在 dev 量下规划器仍未改选（收益未量到）。
3. **H2**（把 LLM 调用移出事务）——结构性、唯一能把 API 抖到 200 s 的一条；正解方向代码里已写出（authoring 阶段的 `commitAuthoredCandidateV2` 就是正确形态）。→ **未做**，理由与代价见 §9。
4. **H5 / M1 / M2**（三个 DB 形状问题）——同一个端点上可以顺带一起量。→ 三条都已做。
5. **H7**（本地缓存落盘）与 **H6**（ASR 模型驻留）。→ 都已做（H7 走的是"摘掉重复的整库校验"，没改落盘粒度）。
6. 其余 `Medium` 按分区批量清，`待核` 项先复现再动。→ 已清 M6/M14/M15/M12/M17/L8；`待核` 一律未动。

在开工前值得先做一次**带真实数据量的复测**：本文凡"现在不痛、形状不对"的判断，现在都还没有数字能定拐点。这一条仍然成立——上面几条"收益未量到"的判断全都卡在这上面。

## 9. 修复记录（同日五批共 33 项，其后又续三批：断账 2 项 + 0272 删重复索引 6 棵）

已落地 **33 项**（另 M13 只做了根订阅这一半，memo 化与 store 下沉未做）（其中 M27 只按改判做了一半），分四批：
- 首批 14：H1 H3 H5 H6 H7 H8 M1 M2 M6 M12 M14 M15 M17 L8
- 续批 5：M3 M4 M21 M23 M26
- 续批二 5：M18 M24 M30 M32 M34
- 续批三 8：M31 L4 M7 L2 M28 M27(改判) L9

每条都跑过类型检查与相关测试；表里"验证"一栏写的是**怎么验的**，不是推测。其中 M30 与 M32 当时只拿到构造级/可运行级证明，用户可见数字无断言覆盖，已单列在"新增欠账"——**那条欠账在续批四已还清**（两个真实 Postgres 套件 + 变异检验），下面的原文按实保留不删。

| 条目 | 改动 | 验证 |
|---|---|---|
| H1 | `CompanionHud.tsx` 几何 effect 补上 `[bubbleEl]` 依赖；轨道的挂/摘与长高改由 `mountObserver` + `watchRail` 显式盯（以前是靠"每渲染重跑一次 effect"顺带兜住的，直接加依赖会回归） | 桌面全量测试绿；渲染层 typecheck 0 错 |
| M6 | `useSmoothedDraftText` 的 60 ms 钟改为按 `draft?.runId` 挂/摘，不再整个会话空转 | 同上 |
| M14 | 流式缓冲纯追加时省掉一次全长 `slice` | 同上 |
| M15 | 三处 `plainCompanionBubbleText`（十趟正则）收进 `useMemo`，逐字显现不再触发剥离 | 同上 |
| H3 | 新迁移 `0269`：`workspace_members (user_id)` | **实测 `Seq Scan` → `Index Scan using workspace_members_user_idx`** |
| H8 | 同迁移：`card_generation_runs_v2 (workspace_id, user_id, created_at)` | 索引已建并被规划器承认；但 dev 库仅 671 行，该查询仍选了原 `cg_v2_ws_status_idx`（两者代价估算同为 8.3）——**收益未量到** |
| H5 | 新增 `computeSourceOutdatedForRunsV2`：一批 run 的"源正文过时"改为每 (空间,用户) 一次笔记读 + 全批一次正文读；`serializeRunPublic` 加可选覆盖参 | 新建 6 条单测全绿，其中两条锁往返次数（20 行 = 1 次笔记读 + 1 次正文读） |
| M1 | 候选列表把"每个候选只取最新修订"下推给 SQL（相关 `NOT EXISTS`），不再全量搬回内存去重 | dev 库逐行比对两种写法：行数一致、差集为空；`EXPLAIN` 显示外层与探针都走 `cg_v2_cand_latest_idx`（Anti Join + Index Only Scan）；**做了变异检验**：摘掉该判据后新契约测试变红 |
| M2 | `content_json->>'importId'` 改为 `@> jsonb_build_object(...)` | 实测对照：`@>` 能被现有 GIN 接手（Bitmap Index Scan），`->>` 永远不能；dev 量下规划器仍先选 workspace btree，收益属"拐点前" |
| H7 | 本地笔记缓存落盘去掉**整库二次深度校验**（每条 entry 在 `memory.set` 已 `parse` 过），只留 O(1) 上界守卫 | `note-doc-cache-store.test.ts` 14/14 绿 |
| L8 | 临时文件改固定名 + `ensureLoaded` 收旧 uuid 残留 | 同上 |
| H6 | `asr-worker.js` 用 `finally` 立刻放开抓取用的 228 MB ArrayBuffer；`local-speech-recognition.ts` 增加 90 s 空闲下线（`releaseEngine`），在途解码或 init 未落定则顺延 | ASR 测试 3/3 绿；**变异检验**：摘掉成功路径上的 `armIdleRelease()` 后新用例变红 |
| M12 | `getCapabilities()` 加缓存，按 `workspaceEpoch` 失效 + 5 s TTL；登录/切空间两处复位点显式 `forgetCapabilities()` | 主进程 21 个测试文件 205 条全绿 |
| M17 | 5 条 SSE 的 10 处固定 1000 ms 重连改为指数退避（1 s→30 s 封顶）+ ±25% 抖动，读到帧即归零 | 同上 |

### 续批（同日第二批）

| 条目 | 改动 | 验证 |
|---|---|---|
| M4 | `projectBlocksIntoVersion` 的"每个改动块一条 UPDATE"改成一条 `insert .. on conflict do update`（插入与删除分支本来就是批量的，只有更新没跟上） | **三条 postgres 集成套件共 37 条全绿**；变异检验：把它换成 `onConflictDoNothing()` 后 **11 条变红**（3+7+1），证明更新分支真被测到 |
| M3 | 落盘不再编码两次：`persistNoteDoc` 接住调用方已编码的 `state` 并转给 `saveNoteDoc`（以前默认参会再 `Y.encodeStateAsUpdate` 整文档一次）；"内容有没有变"的比对从 `Uint8Array.from` + 手写逐字节循环换成 `Buffer.compare` | 同上 37 条；`sameBytes` 随之无引用，已删 |
| M23 | 三处**按行**构造的 `Intl.DateTimeFormat` 提到模块作用域（`surface-data.tsx` 两个、`CompanionChatRecord`、`WorkspaceLibrarySurface`） | 桌面 typecheck 0 错、1391 条用例通过 |
| M21 | 资源请求不再每次 `realpath(rendererRoot)`——根目录固定，缓存成一次性 promise，失败不缓存 | 同上 |
| M26 | 登录页氛围画布改 `React.lazy`：它是**整个渲染层唯一还在活的 pixi 引用**（`scene/*-pixi*` 那条链只有自己的测试在引） | **实测主 chunk 4,883,632 → 4,276,127 字节（−607 KB，−12.4%）**，画布单独成 727,248 字节的懒 chunk；`grep PixiJS` 在 eager chunk 里为 0 |

第二批又撤下两条：

- **M5（每 keystroke 整文档重投影）**：`projection.blocks` 不是"只在阅读视图要"——`notebook-surface.tsx:469` 把它直接喂给 `conceptMark`、`allBlocks` 与 1209 行的阅读块渲染，与编辑器同屏。要做对得先判定"阅读视图何时真的活着"，判错的后果是**安静地显示旧正文**（一个用户可见的谎）。这需要一个产品判定，不在批量修复里蒙。
- **M16（心跳不看窗口可见性）**：`stopCompanionLifecycle()` 已经是干净的收口（两个 timer + 两条 SSE + bridge + fence 全在里面），接上窗口状态很容易——但它会**停掉 runtime fence 的续期**，而 fence 是 120 秒 TTL 的服务端存活判据。最小化窗口导致 fence 过期会不会让伴星在别处判死，我没有在真窗口里跑过就不敢下结论。留给带真窗口的验证轮。

### 续批二（同日第三批）

| 条目 | 改动 | 验证 |
|---|---|---|
| M24 | 渲染层 `b64` 从逐字节 `+=`（O(n²)）改成分块 `String.fromCharCode(...subarray)`；它在**每个本地事务**和每个远端帧的校验上都走 | 与旧实现对 11 个长度（含 0、32767/32768/32769 块边界、262144）**逐字节比对一致**；live-view 两套 16 条用例绿 |
| M18 | `projectLearningDashboardToRoomProjection` 里对**已解析对象**再跑一次 `learningDashboardV2Schema.parse` 去掉，参数类型从 `unknown` 收紧为解析后的类型（两个调用方交进来的都是 `dashboard.data` / 缓存里的 `LearningDashboardV2`），"必须给已校验数据"改由编译器负责 | 主进程 21 文件 205 条全绿；node typecheck 0 错 |
| M34 | 制卡 SSE 的 2 秒轮询补上 in-flight 守卫（`inbox-routes.ts:106-108` 早为此加过，这条新写的端点没跟上）；跳过空转 tick 不丢事件，`lastSeq` 是游标 | 卡生成 + 统计 251 条绿 |
| M30 | 首页"硬证据数"从"拉全部绑定行 + JS 建 Set 数个数"改成 SQL `countDistinct`。等价前提实测过：`evidence_snapshot_id` 是 `NOT NULL`（`information_schema.columns` + 0 行为空），所以 `COUNT(DISTINCT)` 与"Set 里 null 也算一个"的旧写法同解 | 5 条 stats 用例绿；当时 `stats` 没有任何 postgres 集成套件、只有构造级证明（见下方欠账）——**已由 `stats-overview-hard-evidence-postgres` 补上并做过变异检验（续批四）** |
| M32 | 目标详情页：不再把这篇目标**历史上所有** run 的 id 收成数组喂两个 `inArray`，改成经 `learning_runs` join（`origin->>'objectiveId'` 有 0222 表达式索引，两张 outbox 各有 run_id 可用索引），两条标量子查询合成一次往返 | `learning-objectives-surface` / `-parity` / `-leakage` 三套干净库集成 6 条绿（证明 SQL 可跑、不越权）；**但 `practiceTrailCount` 与 `lastCanonicalAt` 这两个值全仓没有任何断言覆盖**（`rl-surface-e2e.test.ts` 里出现的是喂进去的字面量，不是查出来的）—— 见下方欠账 |

| M13（半） | `App` 不再订阅 `windowState`：那个状态一变（失焦、最小化、`visibilitychange`，全是高频）根组件就重渲染，而 `room` 那段 JSX 是在 App 自己那次渲染里造出来的，**整棵渲染树**跟着走一遍——渲染层没有任何 `React.memo` 拦得住。顺带删掉它唯一用途 `data-window-state` 属性：全仓核对无读方（CSS 0 处、测试 0 处，探针读的是 `.companion-presence` 上那个） | 新增形状守卫 `src/main/app-render-scope.test.ts` 3 条；**变异检验过**：把那行订阅加回去，恰好"不再订阅"那条变红。桌面全量 1415 条通过（2 红仍是 prosemirror 双实例） |
| L6 | 迁移 **0271**：`ailearn_jobs_insert_notify` 原来只挂 `AFTER INSERT`，而重试（`ailearn_fail_job` 把 status 打回 pending）与 reaper 回收都是 **UPDATE**，一条通知都不发；worker 空闲轮询已自适应退到 5 秒，于是「到点该重试的 job」平均多等半个周期（最坏 4.5 秒）——0031 把首次退避从 10s 降到 2s 省下的延迟被这里原样还回去。现在改成 `AFTER INSERT OR UPDATE OF status`，判据放在函数体里：仅「刚变成 pending 且之前不是」才发；claim（pending→running）刻意**不**发，否则每次领取都惊群。函数体建立在 0214 的版本上（0200 删过 `generation_run_id`，从 0115 复制会把那个修复冲掉） | 见下方"L6 的验证" |

### L6 的验证（真 LISTEN 收通知，不读函数源码）

六个阶段逐条观测，全部符合预期：`INSERT`→1 条通知；`pending→running`（claim）→**0**；`running→pending`（重试）→1；`running→pending`（reaper）→1；重复置同状态→0；只改 `payload`（`status` 不动）→0。

两条踩过的弯路，记下来免得下次重犯：
- **psql 不能用来验通知**：`psql -c "LISTEN …; SELECT pg_sleep(2)"` 在单命令模式下退出前不吐异步通知，六个阶段会全部读回 0——**包括必须通知的那一条**。这是"读不到"，不是"判据对"。
- **queue 集成套件对库里残留极敏感**：我第一次跑它失败（`expected 0, actual 3`），原因是我自己的探针在同一个库留了夹具行；`bash scripts/dev-disposable-db.sh ailearn_perf_it` 重置后 **5/5 绿**。另外它要求 `QUEUE_TEST_*` 三个 URL 用**受限角色**（`ailearn_worker`），给超级用户会先撞 `readConnectionIdentity` 断言。

### 续批三的查证结果：一条不存在、两条撤回

- **L5 不存在**。报告写"`run-processing-tick.ts:1059` 循环里每轮一次 DELETE"，实际该文件里 `.delete(` 与 `DELETE FROM` 的命中数都是 **0**——这条出自本轮那份**被否决**的 DB 报告，本就不该进清单。按"查证不存在"处理。
- **L19 做了又撤回，最后按实撤销这条（09-23 补测，结论：不该做）**。
  第一步：把广播里的 `gatewayEventSchema.parse` 从订阅者循环提到循环外（校验一次 + 逐订阅者覆盖 `subscriptionId`/`cursor`/`eventRevision`）能跑，210 条主进程用例也确实全绿。但按惯例做变异检验时发现：**把逐订阅者的 `subscriptionId` 覆盖删掉，210 条仍然全绿**——这个不变式（每帧带各自的订阅号，串号就是 A 面板收到 B 的正文）没有任何测试守着，于是**连同改动一起撤回**，不留一个无守卫的重构。当时顺手写下的"现有 harness 拒绝对同一 topic 第二次 subscribe"也是**错的**：`desktop-ipc-note-doc.test.ts:400-404` 早就在同一条 topic 上连订阅两次，是我那次调用的入参形状不对。
  第二步（补测，这一条真正关掉的原因）：直接量 `gatewayEventSchema.parse` 到底贵在哪，夹具就按 §3 里我自己写的那个上限——`NOTE_DOC_UPDATE_MAX_CHARS`＝4 MB base64：

  | 一帧 `note_doc_event` | `parse` 中位数 | p95 |
  |---|---|---|
  | 载荷 4 MB（上限） | **0.039 ms** | 0.162 ms |
  | 载荷 4 字节（常态小增量） | 0.028 ms | 0.089 ms |
  | 同一帧 `structuredClone`（对照） | **1.55 ms** | — |

  三个结论：① 4 MB 相对 4 字节只贵 **11 µs**——因为那 4 MB 是一个**字符串基元**，zod 只做一次 `.max()` 长度判断，既没有"整树遍历"也没有"深拷贝"，我在 §3 写的这两句机制**都不成立**；② 每多一个订阅者多付的是 ~39 µs，而同一帧真正的大头是 `webContents.send` 里那次结构化克隆（**1.5 ms，约 40 倍**），提一次 parse 出去只省掉这一帧成本的 ~2.6 %；③ 所以这条**撤销**，不补 harness、不做重构——省下的是 µs 级，代价是拿一条无守卫的路径去换。要真降这一帧的延迟，方向是每个订阅者独立 `send` 之外的东西（克隆本身），那不在本清单里。

- **M33 判断为不改（不是漏做）**。`note/service.ts:152-154` 自己写明单篇保存保留"事务内下载"是有意的轻量兜底，批量导入路径已由 `preRegisterImageAssetsForImport`（事务外）解决。真要收口，得在开事务之前算出 key 集合——而 `createNoteFromSource(executor, …)` 收的就是事务句柄、key 又依赖先读 segments，属于"改共享 service 签名 + 调用方流程"的独立一轮。

**对本报告三处原述的更正（共性是"报告的建议会推翻有意设计"）**

1. **M18**：报告把"304 命中仍全量重投影"当浪费，是误读。`desktop-gateway.ts:1886-1888` 有注释说明为什么**必须**重投影——能力与恢复度两条读独立于 dashboard ETag，直接回缓存会把它们的新状态藏在 ETag 后面。那一步保留；真正可去的只有那次重复的整树校验（已去）。
2. **M28**：原议"把 V2 poll 挪到主队列槽位检查之前"会推翻第五轮审计 W#5（V2 必须排在 claim/分发之后，免得串行 poll 延迟主队列配额分配）。真正的缺陷只是那句早退顺手跳过了 V2——已按"顺序一字不动、早退也走完 V2 义务"实施。
3. **M27**：原议"把 ≤3 个候选用 `Promise.allSettled` 扇开"会**破坏一条产品规则**。`companion-thought.ts:1061-1063` 是"送出一条就 `return`"——这个循环是"逐个试到有一个活下来"，不是彼此独立的批量工作；扇开会变成一次送多条或与 `finish()` 抢。所以**没有并行化**，只修里面真正的缺陷：`embeddingProvider.embed(expression)` 没传 `job.signal`（与 M7 同一类——挂住的 embed 只能等 transport 的 300 秒总超时，而 handler 预算 110 秒、租约 120 秒，会把已付费的前两个候选一起拖到超时重投）。剩下的预算形状问题（一个候选吃满 75 秒后再没空间给后面的候选）要单独决定"每候选预算怎么分"，不在批量里蒙。

| M27（改判） | 只补 `companion-thought.ts` 缺的 `job.signal` | worker 773 条绿；typecheck 0 错（该文件同时被另一会话大改 88/34 行，两边改动共存、未互相覆盖） |


**新增欠账（这两条别当成已验证）**
- M30：需要一套 `stats-overview-postgres` 集成用例，夹具造多卡共享同一 `evidence_snapshot_id` 的情形，断言"去重真的发生了"——否则这条改动回归成 `count(*)` 没人会看见。
- M32：需要在 objective surface 集成套件里补一条"种 2 个 run + 3 条 practice trail，断言 `practiceTrailCount === 3` 与 `lastCanonicalAt` 等于最新那条"。现在的 6 条绿只证明它能跑、不越权。

→ **两条已在"续批四"清掉**（下面是当时的原话，保留不删，便于对照）。

### 续批四（09-22 → 09-23 跨零点）：M30 / M32 的断言欠账

这两格都是**用户可见数字**，此前全仓零断言。补的是真实 Postgres 集测，不是 mock。

| 条目 | 新用例 | 夹具怎么让它"错一个条件换一种红法" | 变异检验（逐条改产品 SQL，验证完已还原并核对 md5） |
|---|---|---|---|
| **M32** | `integration-tests/learning-objective-practice-trail-postgres.integration.ts`（3 条） | 详情页与列表页是**两套实现**（详情＝M32 的标量子查询；列表＝全部 run + 两个 `inArray` 聚合 + JS 建映射）。3 条 published trail 分挂 3 个 run（`practice_trail_event_outbox` 的 `(run_id, scope)` 唯一，"练过 3 次"天然必须是多 run）；第 4 条**更新**但是 pending；同空间另一个目标另挂 published trail/canonical，且它那条 canonical 比谁都新 | 5 个变异全部变红：详情侧删 `o.status='published'`、删 `p.status='published'`、`ORDER BY DESC`→`ASC`、删 `pr.origin->>'objectiveId'` 谓词——**4 个都同时红两条**（因为第三条是"列表==详情"的对账）；只改列表侧 `eq(status,"published")` → **仅第三条红，`4 !== 3`**，证明列表实现被独立覆盖，不是蹭详情的绿 |
| **M30** | `integration-tests/stats-overview-hard-evidence-postgres.integration.ts`（3 条） | active 卡的目标 A：快照 S1 绑 3 次 / S2 绑 2 次 / S3 绑 1 次＝6 行 3 个去重值；卡已 archived 的目标 B：另 2 个快照各 1 次。正确答案 3，**漏去重＝6，漏 active 过滤＝5**，两个错法给出不同数字，不会互相掩盖 | 2 个变异全部变红且**恰好落在预测值上**：`countDistinct`→`count` 报 `6`；删 join 里的 `eq(learning_cards_v2.lifecycle,"active")` 报 `5` |
| 两条共用 | 都带"种数据之前先报 0"的基线用例 + 一段**前提自检**（超级用户直接 `count(*)` 证明行确实落库、且形状能被 join 到） | — | — |

M30 那条还顺手把它自己的等价前提钉成断言：`learning_objective_evidence_bindings_v2.evidence_snapshot_id` 必须仍是 `NOT NULL`。**为什么值得钉**：旧写法 `new Set(…).size` 把 null 算作一个成员，`COUNT(DISTINCT col)` 忽略 null——这列一旦放开可空，两种口径就分叉，而红出来像"首页数字错了"，看不出根因在 schema。

另加 `npm run test:objective-metrics:postgres`（`apps/api/package.json`）把这 5 个目标侧套件收成一个入口：新 2 条 + 此前只能手跑的 `learning-objectives-surface` / `-parity` / `-leakage`。合跑 **12 条全绿**（同一一次性库、`--test-concurrency=1`）。**没有**接进 CI：`ci.yml` 是一条一条列文件名的，那 3 个既有目标套件从来没进过 CI，把它们连同我的新套件一次性塞进共享流水线不是一轮批量修复该做的事（要接也该单独一轮，先确认 CI 的受限角色连接能跑夹具）。

**两条踩过的坑（写给下一个写 Postgres 集测的人，包括并行会话）**

0. **`withWorkspaceTransaction` 不切角色**（`db/client.ts:367-369` 只有 `set_config('app.workspace_id'…)`，全文件没有 `SET LOCAL ROLE`）。所以"读数走产品入口"**不等于**"读数在 RLS 下"——RLS 是否生效完全取决于连接角色，而 dev 的 `ailearn` 是 `super=true bypass=true`（见 [[reference-dev-rls-blindfold]]）。本轮两个新套件因此各跑了两遍：
   - `DATABASE_URL`＝超级用户（夹具要写 `users`/`workspaces`/outbox）**且** `DATABASE_URL_API`＝`ailearn_api`（`db/client.ts:25` 优先取这个变量）⇒ **6 条全绿**，这才是 CI/生产的形状；
   - 两个 URL 都给超级用户 ⇒ 也全绿，但那一层少验。
   ⇒ 凡"我通过 `withWorkspaceTransaction` 读，所以验了租户隔离"这类注释都不成立，要么按上面分开给 URL，要么在注释里写明没验。`scripts/dev-disposable-db.sh` 末尾本来就打印这两种配方，只是以前没人把 `DATABASE_URL_API` 当受限角色用。

1. **`jsonb` 列必须用 `sql.json(对象)`，不能写 `${JSON.stringify(对象)}::jsonb`。** 后者被 postgres.js 按参数类型（jsonb）**再** `JSON.stringify` 一次，存进去是 `jsonb_typeof='string'` 的一整个字符串标量：插入不报错、`origin ->> 'objectiveId'` 恒为 `null`、join 一行不剩，现象完全是"产品查不到数据"。实测确认：`SELECT jsonb_typeof(origin) FROM learning_runs` 返回 `string`。
   **同一形状已确认存在于 `integration-tests/helpers/v2-card-fixture.ts`**：`canonical_answer` / `learning_support` / `scoring_rubric` 三列都是 `${字符串}::jsonb` 写的，也就是纯 V2 夹具里这三列一直是 JSON 字符串标量而不是对象。本轮没动它（它撑着的三个套件现在全绿，改它属于另一轮），但**任何依赖这三列内容形状的断言都不可信**，写之前先 `SELECT jsonb_typeof(...)` 看一眼。
2. **`after()` 里必须 `closeDatabase()`。** 造数用例自己 `import` 了 `db/client` 的池（走产品入口读数就会），不关它 node:test 跑完不退出——现象是"用例全绿然后一直挂着"，会静默吃掉整个 CI 超时。本轮第一条就是这样挂了 10 分钟。


### 续批三（同日第四批）

| 条目 | 改动 | 验证 |
|---|---|---|
| M31 | 复习列表：`learning_cards_v2` 那个**字节相同**的谓词在同一个事务里查了两遍（第一份结果还被关在 `if` 块里出不来）→ 改成一次读、三张映射都从它建 | 26 条 review 用例绿；API 全量 1474 条 0 失败 |
| L4 | qwen-TTS 连接池复用前只信 `alive`，而停进池里的 socket 早在上一轮任务开始时 `removeAllListeners()` 了——**上游主动关闭不会被察觉**，死连接照样发出去，`open` 永不到来，白挂 30 秒并占住一个全局任务名额与整条用户队列。改成复用前看 `readyState === OPEN`，不符则摘除并关闭 | 32 条 qwen/tts 用例绿 |
| M7 | 记忆向量重建：200 行**串行** embed（200 × ~300 ms ≈ 一分钟，正好压在 handler 110 秒预算上，一次抖动就整单超时重投）改成上限 4 的小并发；并把一直没传的 `job.signal` 交给 `embed()`（`embed(text, signal?)` 早就收这个参数——不给时唯一兜底是 transport 的 300 秒总超时，会带着整批越过 120 秒租约被重投、从头再烧一遍）。**逐行小事务与租约续期原样保留**，所以"哪些行已落库"的语义与串行版相同 | worker 全量 773 条绿；typecheck 0 错 |
| M28 | V2 制卡 outbox 原来只在主 tick **函数末尾**被 poll 一次，而中途有一句 `if (claimLimits.interactiveLimit <= 0) return;`：主队列 4 条槽被后台 job 占满（单个可跑 110 秒）时整轮直接返回，V2 既不领取也不续约心跳，最长要多等一整个 handler 预算。**没有**按报告原议把 V2 挪到主队列之前——第五轮审计 W#5 明确要求它排在 claim/分发之后，免得串行 poll 延迟主队列配额分配；改法是抽出 `pollV2OutboxWithinTick()`，让那条早退也走完 V2 义务，顺序照旧 | worker 全量 440 条绿；typecheck 0 错 |
| L9 | `trackedLearningRunIds` / `trackedCardGenerationRunIds` 只加不减（只有登出/切空间才 `clear()`），而每次 subscribe 会对集合里**每个** id 开一条 SSE——"这一趟看过多少个 run"直接等于挂多少条常连接，而其中绝大部分早已没人看。改成以订阅表为准（`subscribedRunIds(kind)`）：没订阅者的 run 不再开流、已开出的就地停掉并摘出 | 主进程 22 文件 208 条绿；typecheck 0 错 |
| L2 | 伴星事件的 durable 兜底轮询以前是写死的 `setInterval(2_500)`：**与会话是否在动无关**，一条流开着就按 0.4 qps/连接敲库，上限每用户 10 条连接，而连续会话是常驻的。改成自排程 `setTimeout`，空转时指数退到 30 秒封顶、一到事件（含 NOTIFY 唤醒那一次）立刻回到 2.5 秒；NOTIFY 仍是即时主路径。与 `run-routes.ts:633-637` 那条早已退避的兄弟实现对齐 | 5 条 companion-events 用例绿；API 全量 1474 条 **0 失败** |

3. **`companion-memory-handlers-postgres.integration.ts` 4 条里有 2 条红在 `column "ai_consent_version" of relation "workspaces" does not exist`**（`42703`）。这条列是 0237:77 `DROP COLUMN` 掉的，Drizzle schema 里也查不到该字段（`packages/shared/src/db-schema/*.ts` 无 `aiConsentVersion`），`workspaces` 上的两个触发器与相关函数都不引用它（逐个读过 `pg_get_functiondef`）——也就是说这个引用**不在被测的 worker 代码里，也不在库对象里**。红的两条是"没有 embedding provider 就跳过"那两条，在 `companion-memory-embedding.ts:36-39` 就 return 了，根本走不到本轮改的那个循环。结论：**这是一条早就坏掉/很久没跑的集测**（很可能与 `apps/api/src/modules/identity/capability-projection.ts` 仍在读这个已删字段同源），不是本轮引入的；我没去修它，因为它属于"删列之后下游没跟齐"那一类，需要单独一轮。


实施时逐行核对，发现两条**写重了**，按实修正：

1. **H3 不在"每个已认证请求"上。** `decodeToken` 里的那次成员读用的是 `(workspace_id, user_id)`（`identity/service.ts:384-390`），正好命中既有主键。真正没有索引的是**只带 user_id** 的那几条：登录取空间列表、切空间列举、配额检查，以及两个 `SECURITY DEFINER` 触发函数体内（所以它挂在成员写入路径上）。结论仍是该建，但影响面比原文窄。
2. **H6 的"整份拷贝"说法不成立。** `new Uint8Array(arrayBuffer)` 建的是**视图**，不复制；真正把字节搬进 WASM 堆的是 `FS.writeFile` 内部那一次。双份驻留的判断仍然对（fetch 的那份 + WASM 堆里那份），但机制不是这行代码多拷了一次。

### 本轮明确没做（连同代价）

- **H2（把 LLM 调用移出事务）**：这是本轮唯一能解释"API 偶发 20–207 s"的结构问题，但正解要把 V2 管道改成"阶段级 checkpoint + `run.status` 门闩"，等于重排制卡流水线的事务边界。这不是能在批量修复里顺手做的，做坏了会静默丢候选。代码里已有的 `commitAuthoredCandidateV2` 是正确形态，照它改剩下三个阶段。
- **M16 / M5**：见上面"续批"末尾两条，都是"能做但要判对错、而判错的用户看得见"，需要带真窗口的验证轮。
- **H1 的 context 拆分**：`draft`/`nodes` 仍在那个大 context 里，所以 HUD 每 token 仍会重渲染——但渲染体里最贵的那段（几何 effect）已经不跟渲染跑了，剩下的是 React 正常协调。彻底拆开要把流式字段挪进独立小 context，涉及 4 个大消费方。
- **所有 `待核` 项**：本轮已证明这类报告的可信度不能默认，未复现的不动。
- **H5/M1 的端到端保证**：去重与批量判据现在住在 SQL 里，mock 测试证明不了。欠一条 postgres 集成测试（插两条修订，断言只回最新那条）。
- **`M9/M10` 死索引清理**：87 个从未被扫的索引里有真重复（`search_documents` 那两条 partial-on-NOT NULL、`note_versions` 的 `(note_id, version_no)` 一对）。删索引是可逆性差的操作，且 `idx_scan=0` 在 dev 库上不足以证明生产也不用——留给带真实读路径的一轮。



---

## 9.4 改完之后复测：这批数字**不能**算修复效果

复测方法：登录取 token，对 5 个端点各打 40 次（预热 5 次不计），与 §1 的开工基线比均值。

| 端点 | 开工基线 | 现在 | 变化 |
|---|---|---|---|
| `/auth/me` | 53.9 ms | 5.5 ms | −90% |
| `/v2/card-generation-runs/active` | 40.7 ms | 5.4 ms | −87% |
| `/companion/home-projection` | 135.3 ms | 7.3 ms | −95% |
| `/v2/learning-dashboard` | 86.9 ms | 16.3 ms | −81% |
| `/me/companion` | 86.3 ms | 4.2 ms | −95% |
| `/ready`（**控制组，本轮一行未改**） | 4.5 ms | 3.3 ms | −27% |

**结论：这组数字不能归因给本轮改动**，三条证据：

1. 跌幅里包含**本轮完全没碰过**的端点（`/companion/home-projection` −95%、`/me/companion` −95%）。
2. 开发库数据量没变（`notes` 877→879、`sessions` 616→628、`jobs` 1393→1433、`note_versions` 912→914），所以不是"库空了所以快了"。
3. 直接查了 0269 那个新索引：连打 50 次 `/auth/me`，`workspace_members_user_idx` 的 `idx_scan` 只从 **44 → 45**。也就是说它**根本没在服务 `/auth/me`**——这恰好印证 §9 里那条更正（`decodeToken` 用的是 `(workspace_id, user_id)`，命中既有主键；新索引服务的是登录/切空间那条只带 `user_id` 的扇出，每次登录一次）。

所以最可能的解释是**对照组环境差**：开工那批基线是在并行会话跑集测/构建的窗口里累计出来的，认证端点每个请求二三十次往返，对锁与 IO 争用的暴露远大于只有 3 次往返的 `/ready`（−27% vs −90% 的差就是这个）。要真正量出本轮改动的效果，得在同机、静默、同一进程代次下做 A/B（或按 `git revert` 出一条对照分支），现在这组数只能当"当前环境下的端点画像"用。

**顺带一个正面信息**：这台机器静默时，认证端点其实只有 4–16 ms。也就是说 §1 那句"服务端慢在往返不在数据量"依然成立，但**绝对值被争用放大了约一个数量级**——下一轮再判优先级，请以静默窗口的数为准。

### 9.4.1 又一次踩到"端到端均值不能当证据"（09-24，带对照路由）

0272 落到共享 dev 库之后我按 §1 的基线复量了一次，所有端点的均值都涨到 2–4 倍：`/ready` 4.5 → **22.7 ms**、`/auth/me` 53.9 → 122.2 ms、`/v2/learning-dashboard` 87.0 → 193.1 ms、`/me/companion` 86.0 → 179.5 ms。看着像"我删索引删坏了"。

**决定性的一步是量对照**：`/ready` 只做 3 次往返，**一张表都不碰、更不碰任何索引**，它自己就涨了 5 倍——所以这批数字整批不可用，与 0272 无关。归因查到底：postgres 侧 `state='active'` 只有 **1** 条查询（系统本身空闲），而宿主上 Qoder 两个 helper 各占 ~75% CPU、WindowServer 74%、**Docker 的 Virtualization 虚拟机 59%**，还有另一个 agent 在跑。是容器被 CPU 挤兑，不是数据库。

⇒ 写死成规矩：**这台机器上任何"改前/改后均值"对比，必须同时报 `/ready`**。`/ready` 涨了，其余数字一律作废；要归因就回到 §10 那种同库同数据的确定性形状基准。

## 9.5 实施过程中撞到的两件环境问题（不是性能项，但会影响后面每一轮）

1. **`prosemirror-model` 被加载了两份**，`note-doc-editor-binding.test.tsx` 两条用例因此红：
   `RangeError: Can not convert ... to a Fragment (looks like multiple versions of prosemirror-model were loaded)`。
   顶层 `apps/desktop-client/node_modules/prosemirror-model` 是一个**真实目录**（1.25.11），而 `y-prosemirror`
   经 `node_modules/.pnpm/prosemirror-model@1.25.11/` 解析到同一版本的**另一个实例**——同版本、双实例，
   `instanceof` 判据就崩。仓库根同时存在 `package-lock.json` 与 `pnpm-lock.yaml`，这类混装是典型来源。
   排除掉的干扰项：清空 `node_modules/.vite` 依赖缓存**不**复现修复；单独跑该文件同样红（与本次改动无关，
   它的 import 图里没有本轮任何一个被改文件）。**没有动它**——修依赖布局会影响并行会话与整个工作区，
   需要一次有意识的 `pnpm install`/去重决定。
2. **集成测试必须跑在一次性干净库上**，这点文档里已有但容易踩：把 note 系列直接指到 `ailearn_it`
   会得到 `relation "users" does not exist`（那个库没有 schema），指到共享开发库 `ailearn` 则会因残留行假失败。
   可用配方（本轮就是这么验 M3/M4 的）：
   ```
   bash scripts/dev-disposable-db.sh ailearn_perf_it
   cd apps/api
   export DATABASE_URL_API='postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn_perf_it' \
          DATABASE_URL='postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn_perf_it' \
          NOTE_VERSION_RESTORE_TEST_DATABASE_URL='postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn_perf_it'
   node --import tsx --test --test-concurrency=1 src/integration-tests/note-document-state-postgres.integration.ts
   ```
   注意各套件要的变量名不同：`note-version-restore` 只认 `NOTE_VERSION_RESTORE_TEST_DATABASE_URL`，
   不给就直接抛错。

## 9.6 本轮改完后的验证汇总

| 范围 | 结果 |
|---|---|
| `apps/api` 单元全量 | **1474 条：1473 通过 / 1 skip / 0 失败**（先前那次全量里红的 1 条见下方说明，是窗口抖动） |
| `apps/api` 类型检查 | 我改的文件 0 错 |
| note 落盘路径（真实 Postgres） | `note-document-state` 12 + `note-collaboration` 16 + `note-version-restore` 9 = **37 全绿**；M4 变异检验（改成 `onConflictDoNothing`）→ 11 条变红 |
| 队列通知（真实 Postgres，受限角色） | `queue-postgres` 集成套件 **5/5 绿**（迁移 0271 之后）；另用真 LISTEN 逐阶段验过 6 条判据，见 §9「L6 的验证」 |
| objective 详情路径（真实 Postgres） | `learning-objectives-surface` / `-parity` / `-leakage` 三套 6 条全绿——**只证明 SQL 可跑且不越权**，两个数字当时无断言（M32 欠账）；**续批四已用 `learning-objective-practice-trail-postgres` 补断言，5 个变异各自变红** |
| `apps/desktop-client` 类型检查 | **0 错**（node + web 两套 config） |
| `apps/desktop-client` 测试 | 1392 条：1390 通过 / **2 失败**（见 §9.5 第 1 条） |
| `apps/desktop-client` 构建 | 通过；主 chunk −607 KB |

**两处红都不是本轮改出来的**，写清楚免得下一轮误判：

1. `companion-rate-limit.test.ts > 同一 key 上不同 windowMs 各自独立判定（分钟桶与小时桶共用 key 名但窗口不同）`：该文件与 HEAD 完全一致（我没碰过），
   单独跑 **7/7 通过**，只在中间一次全量跑里红过；**最后一次全量 0 失败**。这是一个依赖墙钟分钟边界的用例，按跨分钟抖动归类，不是缺陷。
2. `note-doc-editor-binding.test.tsx` 两条：`prosemirror-model` 双实例（§9.5），它的 import 图里没有任何本轮改过的文件。

另：本轮为验证创建的一次性库 `ailearn_perf_it` 当时留在开发容器里（`scripts/dev-disposable-db.sh` 重跑一次即可回到干净状态），没有动共享开发库 `ailearn` 的数据——对它只做过 `CREATE INDEX`（迁移 0269）与只读查询。（**续批五已把它和本轮的 4 个一次性库一并 `DROP DATABASE`**。）

### 续批五（09-23）：0272 删掉 6 棵**形状重复**的索引

清单里那条"87 棵从没扫过的索引"这一轮**没有**照数字删——开发库几十到几百行，`idx_scan=0` 只说明本地没跑到。改判成"只删静态可证的重复"：两棵索引的列、顺序、空值序、谓词完全等价时，与数据量无关地多余。逐条查法是一条 SQL（`pg_index` 自连接比 `indkey` / `indoption` / `indpred`，见下），全库 395 棵索引扫一遍，命中 6 棵。

| 删掉的索引 | 与谁重复（保留方） | 等价性怎么证的 |
|---|---|---|
| `assistant_deliveries_inbox_idx` (workspace_id, user_id, inbox_sequence) | `…_inbox_sequence_unique_idx` **同键 UNIQUE** | 开发库 idx_scan 19694 vs 352——热的那棵被删。20,000 行夹具上 EXPLAIN 两种真实读法（顺序取 50 条、`inbox_sequence > cursor` 翻页），删后都变成 `Index Scan using assistant_deliveries_inbox_sequence_unique_idx` |
| `cg_v2_plan_run_idx` (workspace_id, run_id, plan_version) | `cg_v2_plan_run_version_idx` **同键 UNIQUE** | 同上（3316 vs 16）；UNIQUE 那棵是 §8.5 的约束，必须留 |
| `note_versions_note_idx` (note_id, version_no) | `note_versions_unique_idx` **同键 UNIQUE** | 0 vs 44759——本来就是白养的一棵 |
| `search_documents_workspace_body_trgm_idx` | `search_documents_body_trgm_idx` | 部分索引的谓词是 `workspace_id IS NOT NULL`，而该列 `is_nullable='NO'` ⇒ **恒真谓词**，与全量那棵逐字节同形。这一对最贵：开发库 58 行正文上各占 **3,320 kB** |
| `search_documents_workspace_title_trgm_idx` | `search_documents_title_trgm_idx` | 同上，各 120 kB |
| `cg_v2_cand_latest_idx` (workspace_id, run_id, candidate_id, revision **DESC**) | `cg_v2_cand_run_idx`（同列全 ASC） | 普通 btree 可**反向扫描**：正序那棵反着走就得到 DESC NULLS FIRST；`revision`、`candidate_id` 都 NOT NULL（实测 information_schema），空值序也没有差别。这条删的是**热点**那棵（5757 vs 47），所以必须看计划：6,000 行夹具上 `ORDER BY revision DESC LIMIT 1` 得到 **`Index Only Scan Backward using cg_v2_cand_run_idx`**；而 M1 改后的 `NOT EXISTS` 那句两侧都是 `Index Scan / Index Only Scan using cg_v2_cand_run_idx`（探测键正是这四列） |

开发库上这 6 棵合计 **3,832 kB**（3320+120+88+80+40+184）；比字节更重要的是**写放大**：`search_documents` 每写一行原本要维护两棵一样的 trgm 树，`note_versions` / `assistant_deliveries` / `cg_v2_plans` 每次插入多维护一棵永远用不上的树。

**刻意没删的两条（免得下一轮当漏做）**
- `companion_reminders_user_idx` 与 `companion_reminders_ws_user_idx`：逐字节同键（都是 `(workspace_id, user_id, status, fire_at)`），但后者**既不在任何迁移里、也不在 Drizzle schema 里**（`grep` 全库只命中 0238 的前者）——那是开发库漂移出来的对象，很可能是并行会话手工种的，不该由本迁移替它做主。
  > **已移交（写给那边会话，可冷启动）**：dev 库 `ailearn` 上有一棵 `companion_reminders_ws_user_idx`，`pg_indexes` 里在、`apps/api/src/db/migrations/*.sql` 与 `packages/shared/src/db-schema/` 里都查不到（`companion_reminders` 这张表本身没有 Drizzle 声明，只由 `0238_companion_reminders.sql:78` 建）。它与 0238 建的 `companion_reminders_user_idx` **列、顺序、谓词逐字节相同**。请确认是你手工种的还是某支还没落的迁移：若属前者，要么删掉一棵，要么补一支迁移把留下的那棵登记进来——否则任何一次"从空库重放迁移"的环境（CI、`scripts/dev-disposable-db.sh`）都与 dev 库不一致，而这类不一致的表现是"本地快、CI 慢"或反过来，最难查。
  >
  > **09-23 把这个"漂移类"整体量了一遍，结论比预想的干净**：按文件名顺序**重放** 272 支迁移（`CREATE` 加入、`DROP` 移除，共 29 次 DROP），与 dev 库 `pg_class`/`pg_index` 里的非约束索引对账——**漂移只有这一棵**（另有一棵 `note_versions_note_idx`，那是本迁移 0272 要删的、dev 还没跑 0272 而已，不是漂移）。同时 `pg_tables` 对账：Drizzle 声明的 107 张表在库里全部存在，**没有幽灵表**。
  > 这条量法本身有两个已知噪声，别当成发现：① 动态 `EXECUTE 'CREATE INDEX …'` 拼出来的名字静态取不到（`IF` 那一条就是正则被拼接串骗出来的假项）；② 我的 DB 侧集合**排除了约束背书的索引**（PK / `UNIQUE` 约束），所以凡是 drizzle 里 `uniqueIndex("x")` 而库里以约束形式存在的，都会假报成"schema 有、库里没有"。要把这类对账做成常驻门禁，得连"表 + 列 + 谓词"一起比而不是只比名字，并且用 `pg_get_indexdef` 归一化——那是独立一轮，不该挂在性能项上顺手做。
- `notes_active_idx (deleted_at IS NULL)` vs `notes_workspace_idx`：谓词有真实筛选力（不是恒真），属"部分 vs 全量"的正常分工，不是重复。

**验证**
- 迁移 0272 已登记进 `meta/_journal.json`（idx 271）；`dev-disposable-db.sh` 从**空库**跑完全部 272 支迁移通过，落地后 `pg_indexes` 逐名核对：6 棵没了、6 棵保留方都在、0269 的 `workspace_members_user_idx` 不受影响。
- Drizzle 侧同步删掉 6 条声明（`assistant-deliveries.ts` / `note.ts` / `search.ts` / `card-generation-v2.ts`×2），并改掉一句会**说谎**的注释：`generation-run-service.ts:547` 原写"走 `cg_v2_cand_latest_idx … DESC`"，那棵已不存在，改指 `cg_v2_cand_run_idx` 并说明反扫。
- `packages/shared`、`apps/api` 类型检查各 **0 错**；API 单元全量 **1535 条：1534 通过 / 1 skip / 0 失败**。
- Postgres 套件（一次性库 `ailearn_idx_it`，跑完已删）：`db-migrations` + `rls-policies` + `schema-isolation-gate` **7 条全绿**；`learning-dashboard` / `projection-pagination` / `understanding-topology-v3` / `understanding-projection` / `learning-runs-demonstrated` **12 通过 / 0 失败**；受这四张表影响的 9 个套件 **49 通过 / 2 失败**。
- **那 2 条失败与本迁移无关，用控制库证过**（同一份代码打在**没跑 0272** 的库上，两条一模一样地红）：
  1. `card-generation-v2-domain-events.integration.ts:42` —— `INSERT INTO workspaces (id, owner_id, name) VALUES (…, 'domain-events', 'v1', now(), ${USER_ID})`：**3 列对 6 值**（`42601`）。这是那个文件自己写坏了，与索引无关。
  2. `history-search-postgres.integration.ts` §10.4 历史搜索：期望 200 实得 **404**（路由级，同样与索引无关）。
  两条都**不在本轮改动范围内**，且都落在并行会话正在改的文件上——留给那边处理。
- **09-24 0272 已应用到共享开发库 `ailearn`**（经用户确认）。删前把 6 棵的 `CREATE INDEX` 原句逐字导出到 `/tmp/restore-0272.sql` 作一次性还原路径；应用后复验：6 棵全部不存在、8 个保留方与 0269 的两棵都在、0271 的触发器已是 `AFTER INSERT OR UPDATE OF status`、`:4000/ready` 200。同批还补上了那边一直未跑的 0270。**没有**在 dev 上重跑 EXPLAIN 作接管证据——dev 表太小会走顺序扫描，那种"证据"是假的；接管证明仍以一次性库上 20,000 / 6,000 行夹具的三次 `Index Scan`（含 `Index Only Scan Backward`）为准。
- 本轮的一次性库（`ailearn_trail_it` / `ailearn_stats_it` / `ailearn_obj_it` / `ailearn_idx_it`）与上一轮留下的 `ailearn_perf_it` 已全部 `DROP DATABASE`；共享开发库 `ailearn` 只被读过（`pg_index` / `information_schema` / `EXPLAIN` 未带 `ANALYZE` 的只读查询），**没动过它的索引**。

### 待核列清零（09-23，逐条实测）

§3 那张表原先挂着 30 条 `待核`。这一轮把它们全部结掉：17 条**其实本轮已经读码改过**，只是状态列忘了跟着更新（L2 L4 L6 L9 M15 M16 M18 M21 M23 M24 M27 M28 M30 M31 M32 M33 M34 → 亲验）；1 条是**我误收进清单**的（L5，该文件里 DELETE 命中数为 0）；剩下 12 条逐条重开文件或重跑查询：

| 条目 | 实测结果 |
|---|---|
| **M35 RLS 策略** | **机制整条撤回**。用受限角色 `ailearn_api` 在 dev 库上 `SET app.workspace_id=… ; EXPLAIN`：策略里的空间等值进了 **`Index Cond`**（`Bitmap Index Scan on notes_workspace_id_unique_idx`），`current_setting` 只出现在计划里一次，不是"因那个 `OR` 而逐行 Filter + cast"。统计部分是真的：121 条 permissive 策略里 81 条带 `ailearn_worker` 分支、143 条里 103 条用 `current_setting` 比空间——但"带分支"不等于"逐行求值"，这条**不该再按 RLS 开销去动它**。 |
| **L1 搜索深 OFFSET** | **不存在**。`apps/api/src/modules/search/*.ts` 里 `offset` 命中 0，`search/routes.ts:14-16` 明写不透明 keyset 游标、"解不开就 400，绝不悄悄回退第一页"。8 月那笔旧账已经还掉了。 |
| **M20 base64 过桥无上限** | **不存在（撤回）**。`desktop-ipc-contracts.ts` 里没有任何 base64 图片/音频字段；唯一的大 base64 是 yjs 增量，而它**已经**带 `NOTE_DOC_UPDATE_MAX_CHARS` 上限（该文件 1381-1386 行还专门写了"必须带尺寸上限"的理由）。 |
| **M25 `blur(20px)`** | 方向对、**数字错**：实测 `backdrop-filter: blur(20px)` 只有 **3** 处（报告写 18 处）；全 renderer 的 `backdrop-filter` 共 51 处。要动得按 3/51 重算，别按 18。 |
| **M22 伴星存在感的拖动路径** | 形态在，**行号已迁移**：现在是 `CompanionPresence.tsx:472-479` 与 `:544-548`，同一函数里 `querySelector`×2 + `getBoundingClientRect`×3 + `offsetWidth` 交替读写。 |
| **M36 两条带子查询的策略** | 亲验：全库含 `EXISTS` 的策略**恰好只有** `ai_audit_log` 与 `workspace_audit_log` 那两条 owner-read。 |
| **L3 主线程 bcrypt / L10 preload `sendSync` / L7 每实例 30 s 清扫** | 全部亲验。L7 尤其具体：`REAP_THROTTLE_MS=30_000` 配的是模块级 `let lastReapAt = 0`（每实例各节流各的），而 `workers/ai-worker/src/*.ts` 里 `advisory` 命中 **0**——没有任何跨实例守卫。 |
| **M29 / M37 / M38** | 三条都已读到**定义与函数体本身**，其中两条改判：M29 **机制撤回**（那 10 s 是 `lib/handler-timeout-config.ts:18-19` 的硬夹，不是人肉约定；V2 outbox 另有 120 s 心跳 + 丢租约即 abort，所谓"只在提交时续"不成立——残留的是"主队列无中途续约，超 110 s 就重投重付"这一条真问题）；M38 **亲验**（`ailearn_guard_sealed_note_blocks` 确实每行一次 `SELECT sealed_at FROM note_versions`，但它是不可变性的执行者，要减成本得换判定来源而不是删守卫）；M37 **前半亲验、后半未核**（回填触发器确实是"记忆数 × 其它空间数"的扇出，但"改 AI 同意 → 每空间一条 `UPDATE workspaces`"那半句我没重读函数体，仍按未核处理）。 |

> **这一节自身也出过一次事故，记下来免得被当成小事**：给 M29/M37/M38 三条改状态的那个补丁脚本里，我把"跳过不匹配的行"写成了 `continue`，而那一句正好在 `out.append(ln)` **之前**——于是这三条表格行被整行删除、写回了文件。靠 `grep -n "M29"` 只命中一处才发现。**教训**：批量改文件的脚本，末尾必须有"行数/条数对账"的自检（这次是 §3 应有 59 行），不能只看"updated: N"。三条已按本轮实测结论重建，§3 重新数过：**59 行、无重复、无 `待核`**。

收口后：`亲验 52 / 部分 0 / 撤回或不存在 7 / 待核 0`。**这一列的意义不是打分**：本轮三次把"看着像的机制"当过结论（H3 影响面、L19 的 parse 成本、M35 的 RLS 逐行），全部是一步实测推翻的——状态列就是提醒下一轮"这一步不能省"。

### 续批六（09-24）：M16 落地——窗口隐藏时收掉伴星两条 SSE，fence 续约保留

**改动**（`apps/desktop-client/src/main/desktop-ipc.ts`）：把 `startCompanionLifecycle` 里那两段内联 watcher 提成 `openCompanionStreams(ctx)`（身份＝`{generation, workspaceEpoch, accountEpoch}`，连同 inbox 游标一起存在 `companionStreamContext` 里），新增 `closeCompanionStreams()`（**只停两条 SSE**，游标 / generation / fence 定时器一律不动）与 `reconcileCompanionStreamsForVisibility()`；触发点两处——`bindWindowLifecycle` 上绑 `show/restore/hide/minimize`，以及 60 s fence 心跳里同一道判定（漏事件的兜底）。`allCompanionWindowsHidden()` 取不到窗口清单时一律回答"没隐藏"。

**为什么 fence 不能一起停**：`renewCompanionRuntimeFence` 是服务端判断"她此刻在不在"的唯一来源，停掉＝把"窗口最小化"当成"用户离线"，那是产品语义变更。1 req/min 也不是这条要省的量。

**验证**
- 新用例 `src/main/desktop-ipc-companion-visibility.test.ts` 4 条。**先红后绿**：实现落地前跑，第 2、3 条红（"最小化后两条流各自被停一次"、"恢复后按游标续读"），第 1 条绿（证明这套夹具真能驱动生命周期），第 4 条当时"绿"是因为压根没人收流——它要在实现之后才有意义。
- **5 个变异全部变红且各归各位**：收流时顺手 `clearInterval` 心跳 → 第 2 条红；恢复时不补 `snapshot_invalidated` → 第 3 条红；重开时游标写回 0 → 第 3 条红；判据取不到时 fail-**closed** → 第 4 条红；只停一条流 → 第 2、3 条都红。
- 主进程 27 文件 **225 条全绿**；桌面全量（main + renderer）**168 文件 / 1415 条全绿**；`npm run typecheck`（node + web 两套 config）**rc=0、0 错**。
- **09-24 事后复验（并行会话又改了 6 轮之后，全新一次性库 `ailearn_gate94`）**：`npm run test:objective-metrics:postgres` **12/12 绿**（含本轮新补的两套 + 三个既有目标套件），证明 0272 + 断账用例在跑过全部 272 支迁移的干净库上仍然成立；`note-document-state` + `note-collaboration` **全绿**——这是"删掉 `note_versions_note_idx` 之后真实写路径不受影响"的第二次证据。同一批里 `card-generation-v2-domain-events` 仍红 1 条，错误签名与今天控制库复现的**完全一致**（`INSERT has more expressions than target columns`，夹具 3 列对 6 值），不是本迁移造成的。
- 顺带补齐一处替身缺口：`desktop-ipc-note-doc.test.ts` 的假窗口没有 `on`（真 `BrowserWindow` 一定有），产品代码一绑可见性事件就在测试里抛 `TypeError`——**是夹具没跟齐，不是缺陷**，已补 `on` / `isVisible` / `isMinimized`。
- 上一轮卡住的根因坐实：`authGetState` 在测试里一直返回 `safe_internal_error`，而 `desktop-ipc-companion.test.ts` 从不 assert 它的返回值，所以那份"登录后伴星路径"的覆盖实际一条都没走到。这次靠"会应答的兜底替身 + 第一句就 assert `result.ok`"解开（教训已进长期记忆）。

**没做的那半**：真窗口实测（最小化一个实例、在 API 侧数 `/companion/*/stream` 与 `runtime-fences` 的条数，并确认隐藏期间产生的一条投递在恢复后界面上看得见）。上面的用例证明的是"主进程按可见性收放了流、且补账路径接通"，跨进程到界面的那一段仍未量。

**09-24 真窗口那半试了，两条路都不通，且没动到别人的环境**（事实记下来，省得下轮重探）：
- Electron 的 `--remote-debugging-port` 在 `/json/list` 里只暴露 **renderer page target**，`Browser.getWindowForTarget` 返回 `-32601 wasn't found` ⇒ **CDP 没法最小化 Electron 窗口**。
- AppleScript 的 `System Events` 窗口枚举直接挂住（无辅助功能权限），已终止。**没有**以任何方式改动那边实例：事后用 CDP 读 `document.visibilityState` 仍是 `visible`。
- 顺带纠正我自己的探针错：**`lsof` 不加 `-nP` 会把端口解析成服务名**，`grep ':4000'` 于是恒为 0——我差点据此报"这个实例一条连接都没占"。加 `-nP` 后当场量到 Electron 主进程持有 **3** 条到 `127.0.0.1:4000` 的 ESTABLISHED 长连接（那台 `/tmp/qoder-comp-b21` 实例）。
- 因此真窗口那半需要的是**一台能授权的机器上由人点一下最小化**，或者一个我自己能登录的实例（需要 dev 账号）。主进程边界内的证据不变：4 条用例 + 5 个变异各自变红。
- **09-24 顺带拿到的真实运行证据（未干预任何人的窗口）**：那边会话重启后的实例（pid 77532，`--user-data-dir=/tmp/clob-a`）**是带着本次改动的构建跑的**——`apps/desktop-client/out/main/*.js` 里 `allCompanionWindowsHidden` 命中 3 次，早于该次启动。它当时持有 **5 条**到 `127.0.0.1:4000` 的 ESTABLISHED 连接，且 `runtime-fences` 仍按 1 次/分钟进账。
  ⇒ 这条**排除了本改动最危险的失效模式**：带新代码的实例照样正常建流、保持连接、续约在线——如果我在提取 `openCompanionStreams` 时把建流弄坏，症状会是"伴星更新再也不来"，而真实环境里没有发生。
  ⇒ 但它**不算**方向性判据：那 5 条里混着 HTTP keep-alive（同一主进程曾量到 11~12 条），所以"隐藏时恰好掉两条 SSE、恢复时按游标续读"仍然只有单测证据。缺的东西依旧是一次人工最小化。
- **程序化隐藏这条路已经堵死，别再试**：主进程**没有**任何隐藏/最小化的 IPC 通道（只有 `windowFocus`、`windowGetState`、`windowSetTitlebarTheme`），全仓 `src/main/*.ts` 里 `.hide()` / `minimize()` 命中 0，而 `index.ts` 又 `Menu.setApplicationMenu(null)` 关掉了菜单 —— 所以不带辅助功能权限就没有任何入口能让 `isVisible()` 变假。**为测量而往主进程加测试钩子不算办法**（那是在成品里留一条只为看它生效的代码）。
  > **⚠️ 09-24 二次更正：上面这条"更正"是错的，以下 1~4 步作废。** 我实测连 browser 端点也不支持 CDP 的 `Browser` 域：`Browser.getWindowForTarget` 与 `Browser.setWindowBounds` **都返回 `-32601 wasn't found`**（Electron 的 DevTools 不实现这个域，page target 与 browser target 都不行）。**最终结论：程序化最小化在这台机器上无解**，已穷尽的路径 —— page target ✗、browser target ✗、主进程无隐藏/最小化 IPC ✗（只有 focus/getState/titlebar）、`Menu.setApplicationMenu(null)` 无菜单路径 ✗、AppleScript 需辅助功能权限且实测挂住 ✗、`computer-use` MCP 未连接 ✗。**唯一没试的**：用 `--inspect` 挂 Node 检查器、在主进程里 `Runtime.evaluate` 调现成的 `BrowserWindow.getAllWindows()[0].minimize()` —— 不需要改产品代码，但那是把调试器注进正在运行的进程，我没有擅自做。**所以下面 1~4 步里只有第 1、2 步（profile 复用免凭证 + 单实例锁的坑）仍然有效**，第 3、4 步请改成"人工最小化一次"或上面那条 `--inspect` 方案。
  > （历史：我最初说"CDP 管不了窗口"——理由对了一半但当时没验证 browser 端点；后来看到日志里的 `DevTools listening on ws://…` 又误判成"这条其实能做"。两次都是**没跑就先写结论**。这一步现在跑过了：答案是能做的那半只剩人工或 `--inspect`。）
  > 另一个必须知道的门槛：**`index.ts:457` 有 `app.requestSingleInstanceLock()`**（`second-instance` 只负责唤起已有窗口），所以**再起一个自己的实例会立刻退出**——要么先关掉在跑的那个（已获用户授权），要么改 user-data-dir 也没用。已验证过的完整路径：
  >   1. `pgrep -f "user-data-dir=/tmp/clob-a"` 取 pid → `kill`（会话 token 存在 profile 里，重开自动恢复登录，不必找凭证）；
  >   2. 同参数重启：`cd apps/desktop-client && set -a && . ../../.env && set +a && npx electron . --user-data-dir=/tmp/clob-a --remote-debugging-port=9344`（`out/main` 已是带 M16 的构建）；
  >   3. 连 **browser** 端点调 `Browser.setWindowBounds` 最小化 → 按上面第 3 条的判据采样（两个 SSE 各 +1 后不再新增、`runtime-fences` 仍 1/min）→ 再 setWindowBounds `normal` 恢复，并确认恢复段两个 SSE 再各 +1；
  >   4. 收尾必须把窗口还原，别把别人的验证窗留在最小化状态。
- **可用的采样配方（我已验过每一部分都工作）**，需要的是"一次人工最小化"或"给终端开辅助功能权限"二者之一：
  1. 端口**不要硬编码**——那边会话会随时重启实例（我就见过 9326 → 9327）。从进程参数里取：
     `pgrep -f remote-debugging-port` → `ps -o command= -p <pid>` 里抓 `remote-debugging-port=(\d+)`。
  2. 可见性用 CDP 读，**只能读渲染层**：`/json/list` 拿 page target → WebSocket `Runtime.evaluate` 求
     `document.visibilityState`。`Browser.getWindowForTarget` 在这里返回 `-32601 wasn't found`（Electron 的
     remote-debugging 只暴露 renderer target），所以 **CDP 无法最小化窗口**。
  3. 判据取服务端 SSE 路由计数而不是连接数：SSE 只在**响应结束**时才进 `http_requests_total`，
     所以收流会在 `GET /companion/deliveries/inbox/stream`、`.../account/events` 上留下干净的 +1；
     恢复时再来一次 +1。`lsof` 的连接数只作旁证——它混着 HTTP keep-alive（实测同一主进程 11~12 条），
     区分不出"那两条流"。
  4. 期望结果：隐藏段两个 SSE 计数各 +1 后不再新增、`POST /me/companion/runtime-fences` **仍按 60 s 一次进账**
     （这条是 M16 刻意保留的部分，若它也停了就是实现错了）；恢复段两个 SSE 再各 +1。
  5. 记一次我自己的探针错，别再犯：**`lsof` 不加 `-nP` 会把端口解析成服务名**，`grep ':4000'` 于是恒为 0，
     我差点据此报"这个实例一条连接都没占"。
- **09-24 又试了一次"架采样器等人点最小化"，仍然没测到**，三条事实：13 个采样点里 `document.visibilityState` 恒为 `visible`（没人操作）；期间那边会话把实例重启了（CDP 端口 9326 → **9327**）、API 也重启了（fence 计数 79 → 归 1 重涨）；后台采样器只跑了 13/72 轮就被进程组回收。⇒ **这台机器上处于多会话活跃期时，这一段量不了**；探针本身（端口自动发现 + CDP 读可见性 + 服务端 SSE 结束计数）都已验证可用，脚本形态记在此处，等一个安静的 3 分钟 + 一次人工最小化即可复跑。

**09-24 在跑着的实例上量到的（只读，没重启别人的窗口）**：`POST /me/companion/runtime-fences` 的计数在 60 秒里 **30 → 31**，也就是 **1 次/分钟**，与 `:1192` 那个 60 s 间隔一致——这条正是 M16 刻意**保留**的那一份。而 `inbox/stream` / `account/events` 在 `/metrics` 里**根本没有计数行**：SSE 是长连接，请求不结束就不进 `http_requests_total`。所以 M16 省下来的**不是"每分钟几次请求"**，而是**两条常驻连接（及其重连、心跳与每帧的接收/校验）**。⇒ §3 那行原来写的"最小化后仍 6 请求/分钟"这个措辞要按实降级：那个数是我从间隔推算的，不是量到的；正确的说法是"隐藏期间维持 2 条常连接 + 1 req/min 续约"。

**真窗口那半仍然没做**，而且原因写清楚：现成一个实例（`electron . --user-data-dir=/tmp/clob-a --remote-debugging-port=9321`）跑的 `out/main` 是在我改代码**之前**加载的，要量就得重启它——那是并行会话的验证窗口，不该由我为了自己这条测量去打断。

**这条改动依赖的服务端语义（09-24 核过，不是猜的）**：恢复时用 `watchCompanionInboxEvents(companionInboxCursor, …)` 续订，走的是 `GET /companion/deliveries/inbox/stream?after=<inboxSequence>`——`inbox-routes.ts:56` 起：`after` 缺失才回退到 `Last-Event-ID`，随后 `let cursor = afterSequence;` 一路按这个游标 pump，取数在 `delivery-service.ts:262` 是 `gt(inboxSequence, afterSequence)`。**即"按游标重连会把隐藏期间那几条补发回来"确实成立**，补账不是我一相情愿。account 那条流的语义不同（`account-events.ts:34-57` 的 after 是 **epoch fence**，不是可回放的序号），所以恢复时那一段只能靠显式 `snapshot_invalidated` 让渲染层重取快照——这也正是实现里那么写的原因。

## 10. 查询形状的确定性基准（本轮唯一能归因的性能数字）
端到端均值不可归因（§9.4），所以换办法：一次性库 `ailearn_bench` 里复刻三对查询形状的**访问路径**，同一份数据跑旧写法与新写法各 5 次 `EXPLAIN (ANALYZE, BUFFERS)`，取执行时间中位数。夹具量级取"上线后不久"而不是当前开发库的几十行。

| 对照 | 数据规模 | 旧写法 | 新写法 | 结论 |
|---|---|---|---|---|
| **H3** `workspace_members` 只带 `user_id` 的扇出 | 12,000 行 | 1.092 ms | **0.083 ms** | 0269 的索引生效，约 13× |
| **M2** `note_versions` 幂等判据 | 20,000 行 × ~1 KB jsonb | 9.401 ms | **1.504 ms** | `@>` 让 0164 那个 GIN 真的被用上，约 6× |
| **M1** 候选"每个只取最新修订" | 9,600 行（800 候选 × 12 修订） | 4.017 ms | 7.213 ms | **新写法在 DB 端更慢** |

**M1 这条要按实说，它推翻了我自己在 §4 里的框法。** 去重下推给 SQL 之后，DB 执行时间从 4.0 ms 涨到 7.2 ms（反连接要对每一行探一次同候选的更大修订）。它真正的收益不在 DB，而在**交给应用的字节**：

| | 返回行数 | 序列化后大小 |
|---|---|---|
| 旧写法 | 9,600 | **34.43 MB** |
| 新写法 | 800 | **2.87 MB** |

也就是说旧写法每次打开审核页要穿过驱动并 `JSON.parse` 成 JS 对象的是 34 MB（含 5 个 jsonb 列、题面与答案），新写法是 2.87 MB，**约 12×**，代价是 +3.2 ms DB 时间。在本地 Unix socket 上这笔交易就已经划算；跨网络或容器边界时更不用算。结论应是"用少量 DB CPU 换掉一个数量级的传输与 GC"，不是"更快"——我先前把它写成"往返与体积"两者皆省，其中 DB 时间这一半是错的。

**09-24 补一条这份基准的适用条件**：同一天后来发现这台机器能被挤到 `/ready` 从 4.5 ms 涨到 22.7 ms（§9.4.1）。本节的三个数**没做负载对照**，可信度建立在两点上：① 旧写法与新写法是**同一会话内背靠背**各跑 5 次取中位数，负载对两边同等作用；② 报的是**比值与字节**，不是绝对毫秒。但绝对值（1.092 / 9.401 / 4.017 ms）当下不能当基线用——复用这套脚本时，先跑一次 `/ready` 的均值，若它比 4.5 ms 明显高，就等机器空下来再取数，或者直接只报比值。

**方法学（下一轮直接复用）**：`bash scripts/tmp-shape-bench.sh` 那个形态——简化表 + 真实索引形状 + `EXPLAIN ANALYZE` 中位数 + **同时报返回行数与字节**。性能断言只有配上"它换掉了什么、又贵在哪"才可信。基准库与脚本本轮已删除，未动开发库 `ailearn`。

## 11. 还剩什么（冷启动可执行，按"下一步就做这条"写）

§1–§10 是审计与已落地记录；这一节只写**没做完的部分怎么接**，每条都给到"打开哪个文件、改哪一段、怎么证明"，不需要重新发现。

### 11.1 M16：窗口隐藏后仍挂着两条伴星 SSE（下一条就做这个）

> **09-24 已落地**：实现 + 4 条用例 + 5 个变异检验见 §9「续批六」。这一节原文保留，因为「不能顺手把 fence 也停掉」那条约束是产品语义，改动之后仍然成立。

> **09-24 第一次尝试的记录（当时改动已回退，同一天第二次做成了，见 §9「续批六」）**：那一次我实现过一版（可见性判定 + 只收两条 SSE、保留 fence 续约 + 60 s 心跳兜底 + 恢复时补 `snapshot_invalidated`），代码自洽但**写不出能跑起来的用例**，于是回退——没有用例钉住的原生路径改动比不改更坏。踩到的两处真相当时就是下一轮的起点，事实也确实是照这两条解开的：
> 1. **伴星生命周期在 main 侧从来没被测过**：`watchCompanionInboxEvents` / `renewCompanionRuntimeFence` 在全仓 `*.test.ts` 里命中数为 0（只有实现文件），所以没有任何现成夹具能直接复用。
> 2. **`desktop-ipc-companion.test.ts` 里那句 `await handler(authGetState)` 其实一直是失败的**：它不 assert 返回值。我照它的 session 形状建夹具时，`authGetState` 稳定返回 `safe_internal_error`，于是 `startCompanionLifecycle` 从没跑过——**这条测试文件看起来覆盖了登录后的伴星路径，实际一条都没走到**（同一个坑的另一种形态见 [[feedback-negative-tests-pass-when-reads-are-blind]]）。真正的形状要从 `desktop-ipc-note-doc.test.ts` 抄：那套夹具的 `subscriptionsSubscribe` 是**断言过事件送达**的，说明它真的走通了。
> 下一轮的两条起手式：先用 `note-doc` 那套 harness 让 `authGetState` 返回 `ok: true`（把它 assert 出来，别只看没报错），再按下面三步实现。**判据必须先红后绿**：先写"隐藏时两条流各自被停一次且 fence 仍在续"这条，确认它在未改实现时是红的。

**现状（本轮读码亲验）**
- `desktop-ipc.ts:1192-1194`：`renewFence()`（= `gateway.renewCompanionRuntimeFence(epoch, 120)`）每 **60 s** 一次，且伴星在线判定就靠它。
- 同一生命周期里开了两条常连接：`watchCompanionAccountEvents`（:1196）与 `watchCompanionInboxEvents`（:1210），二者都不看窗口可见性；窗口最小化后它们照旧重连、照旧收帧。
- **主进程早就知道可见性**：`index.ts:356-364` 的 `currentWindowState()` 读 `isMinimized()/isVisible()/isFocused()`，`registerWindowLifecycle`（:392-400）在 `show/hide/focus/blur/minimize/restore` 上各挂了一次 `publishWindowState`；`registerM1DesktopIpc` 的入参里已经有 `getWindowState(window)`（`desktop-ipc.ts:274`）。**缺的只是"伴星生命周期看不到窗口句柄"**。

**要做的三件事（顺序即依赖顺序）**
1. 给 `registerM1DesktopIpc` 的 options 加一个 `getActiveWindowState?: () => AILearnWindowState | null`（`index.ts` 里用现成的主窗口引用实现，别新建窗口管理器）。
2. 生命周期启动时**同时**绑一次可见性：`window.on('hide'|'minimize')` → `stopCompanionStreams()`（只停这两条 SSE，**不动 60 s 的 fence**）；`window.on('show'|'restore')` → `resumeCompanionStreams()`。
3. 恢复路径必须**自带补账**：重开 inbox 流时用现存的 `companionInboxCursor` 作 `after`（`desktop-ipc.ts:1211` 已经这么传），并在恢复的瞬间 `emit("runtime", { kind: "snapshot_invalidated", scope: "runtime" }, epoch)` 让渲染层重取快照。漏了这一步就是"最小化期间到的投递永远看不见"——那是**功能损坏，不是性能优化**。

**为什么不能顺手停掉 fence**：`renewCompanionRuntimeFence(epoch, 120)` 是服务端判定"她此刻在不在"的唯一来源，一停就等于"用户最小化 = 离线"，那是伴星在场语义的产品变更，不在这条性能项里。1 req/min 不是这条要省的量。

**怎么算验过（三条缺一不可，别只跑单测）**
- 主进程单测：假窗口发 `hide` → 断言两条 watcher 的 `stop()` 被调用、fence 定时器**仍在**；发 `show` → watcher 重新建立且 `after` 参数是隐藏期间的游标值。注意现有 harness 的假窗口要补 `on()`（`desktop-ipc-note-doc.test.ts:142-147` 那个假窗口只有 `once`，不加就会静默不绑）。
- 真窗口实测（这条的"绿"只有在这里才算数）：起两实例按 [[reference-desktop-multi-account-acceptance]] 的 4 个 env 配方，最小化一侧后在 API 侧数 `/companion/*/stream` 请求数与 `runtime-fences` 请求数——隐藏期间应当只剩 fence（1/min），恢复后 3 s 内重新出现流。**并且要验"隐藏期间产生的一条投递，恢复后在界面上看得见"**，否则第 3 步白写。
- 变异检验：把 `show` 分支里的 `snapshot_invalidated` 删掉，上面那条"恢复后看得见新投递"的用例必须红。

### 11.2 H2 仍排最后，而且现在有了前置条件

§4 的 H2 更正已经把范围收到"规划段一次调用 + regenerate/replan/recheck 那一波"。
**门闩这条前置已不需要按原样做**（09-24 实现后验证不成立，已回退，详见本节末）：`cgro_v2_run_singleton_job_type_unique` 是 `(run_id, job_type)` 的**部分**唯一索引，只覆盖 `card_generation_plan` 与 `card_v2_post_activation` —— **这两类 job 的同 run 双跑已被约束挡死**。**但它同时说明另一件事**：`regenerate_candidate` / `replan_set` / `recheck_candidate` **不在**那个 WHERE 里，所以这三类与规划段之间的同 run 并发**是真的可能同时发生**，今天唯一串行化它们的东西就是`loadV2RunInputs` 那句 `SELECT … FOR UPDATE`。⇒ 剩下该判断的不再是"加不加门闩"，而是"要不要把那三类也收进同一个唯一约束（改索引，一条迁移）"——若收了，规划段拆事务就不需要任何应用层门闩；若不收，跨类型的重复付费仍然存在，且与拆不拆事务无关。这是一个便宜的、可测的选择，判据：`CREATE UNIQUE INDEX … WHERE job_type IN (全部五类)` 会不会挡住合法的排队重投**已验（09-24 读 `failV2OutboxJob`）：不会挡。** 两条分支都是 `UPDATE … WHERE id = $jobId AND status='processing' AND lease_token=$token`——可重试那支把**同一行**改回 `pending`，不可重试那支置 `status='failed'` 并 `attempts+1`，全程不新插行。⇒ 扩约束到那三类 job 在排队重投上是安全的，剩下的只是要不要付这次改动的验证成本。（同一处也印证了门闩当初的顾虑：失败路径确实会 `attempts+1`，注释写明到 6 就终止，所以「延后」绝不能借用 retryable 失败路径——只是那整个门闩已被约束否掉，这条只作为原则留下。）

**这条取舍我先量了一刀（09-24，只读 dev 历史）**：`card_generation_run_outbox_v2` 共 **743 行 / 671 个 run**，按 `started_at` 与 `COALESCE(processed_at, lease_expires_at)` 判重叠，**同一 run 上两类 job 处理窗口重叠过的 run 数 = 0**。⇒ 上一段说的「真能同时发生」在**约束层面成立、在实际数据里一次都没发生**。这不构成「生产上也不会发生」的证明（dev 无真实并发，743 行是几个月单人使用的量），但足以改变**优先级**：扩约束从「防已知丢钱」降为「补一个从未观测到的窗口」，不值得排在拆事务之前。而规划段拆事务剩下的真实代价只有**一个连接在一次 planner 调用期间处于 idle-in-transaction**（不是 96 次、也不是 20 分钟）——按 §9.4.1 的规矩，这一条要么等有真实并发负载时再量，要么照 §10 的办法造负载去量，不要拿推理当结论。

**09-24 这条门闩被自己的数据库否决，实现已回退**（先写下、验证没过就撤，不留进计费路径）：写集测时撞到 `cgro_v2_run_singleton_job_type_unique` —— `CREATE UNIQUE INDEX … ON card_generation_run_outbox_v2 (run_id, job_type) WHERE job_type IN ('card_generation_plan','card_v2_post_activation')`。即**同一个 run 上两条并发 plan job 被约束挡死，我要防的「双倍计费窗口」根本不存在**。于是 `deferV2OutboxJob` + `V2JobDeferredError` + 入口 EXISTS 全部撤掉；撤后 worker **773/773 通过、typecheck 0 错**，文件里这些标记的残留计数为 0。教训：设计「让路给活着的 sibling」之前，第一句应该先查这张表上有没有唯一约束——这已经是本会话第二次在写完之后才发现前提早被关闭（第一次是 M17 的重连握手）。


### 11.3 三条"需要判断"的，判断点具体是什么

- **M5**（每次本地 yjs 事务都全量重投影到 ProseMirror JSON）：真正没定的是**阅读视图要不要跟着未提交的编辑实时变**。定成"提交后同步"，这一条就变成一处节流；定成"实时"，就得做增量投影——两者代价差一个量级，别在没定之前先动代码。
- **M39**（`jobs` 与几张追加表无 TTL/DELETE）：缺的不是技术，是"多久的历史还要能被回答"。这条同时决定 `jobs_status_idx` 该不该改成部分索引——先定保留期，再动索引。
- **M13 的另一半**（全仓 `React.memo` 为 0、状态沉在 store 根部）：`windowState` 那半已经删了（§9），剩下的要等有一条**能数出重渲染次数**的量法再动，否则改完也无法证明变好（同类教训见 §9.4 那批"不能算修复效果"的数字）。

### 11.4 已经结掉、别再碰的（清单在 §3，状态列已刷新）

L1（早就是 keyset）、M20（过桥没有无上限 base64 字段）、M35（RLS 空间等值进了 `Index Cond`）、M29（那 10 s 是硬夹）、L5（该文件里没有那条 DELETE）、L19（parse 4 MB 实测 39 µs，省 2.6 % 不值一次无守卫重构）、M33（事务内下载是有意的轻量兜底）。这七条**都被实测推翻或判为不该做**，重开之前先读 §9 与 §4 的更正段。


## 附：本轮方法记录（供后来者复核）

- 真实测量：`curl :4000/metrics` 取直方图后自己解析求均值；`docker exec ailearn-dev-postgres-1 psql` 读 `pg_stat_user_tables` / `pg_stat_user_indexes` / `pg_indexes` / `pg_policies` / `pg_proc` / `pg_constraint`，`EXPLAIN`（未用 `ANALYZE`，未执行任何写入或迁移），以及 `octet_length` 直接量行宽。
- 体积：`du` / `sips` 量 `out/renderer`、`public/assets` 与单个 JS chunk。
- 读码：六个并行子代理分别扫 DB 访问、schema/索引/RLS、API 运行时、Electron main、renderer、worker/队列；**两份被整份否决**（理由见 §2），其余逐条重开文件或重跑查询后才进本文。
- 基线：确认 `docs/performance-scan-2026-08-16*.md` 的扫描对象目录已不存在，故未沿用其任何"已修"结论。
