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

核实强度：亲验 25 / 部分 4 / 待核 30（含义见 §2）。

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
| H2 | High | worker | `card-generation-v2-handler.ts` | 2233,3786-3787 | 长事务 | LLM 调用在事务内，一 job 一个最长 20 分钟事务 + `FOR UPDATE`；代码自陈长期正解未实施 | 亲验 |
| H3 | High | db-index | `workspace_members` | 仅 `pk(workspace_id,user_id)` | Missing index | "我属于哪些空间"无 user_id 前导索引，实测 `Seq Scan`；在登录与每个已认证请求上 | 亲验 |
| H4 | High | api | `identity/service.ts` | 365-410 | Per-request cost | 每个已认证请求一个专用事务 + 4 次读，全 API 无跨请求缓存 | 亲验 |
| H5 | High | api | `generation-run-service.ts` / `helpers.ts` | 469-476 / 106-124 | DB-N+1 | 20 个 run 扇出，每个无 LIMIT 读全部 `note_blocks` 重算 hash，run 之间还重复 | 亲验 |
| H6 | High | assets | `sherpa/asr-worker.js` | 37-48 | Memory | 228 MB 模型 fetch→arrayBuffer→**整份拷贝**→MEMFS，双份驻留；worker 单例成功后永不 terminate | 亲验 |
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
| M13 | Medium | renderer | 渲染层全局 + `App.tsx` | 171-178 | Re-render | 全仓库 0 个 `React.memo`，且 `windowState` 挂在根组件 → 一次失焦全树重渲染 | 部分 |
| M14 | Medium | renderer | `companion-chat-session.tsx` | 1285 | Algorithmic | `slice(0,appendFrom) + delta` 全缓冲复制两遍，O(n²) | 亲验 |
| M15 | Medium | renderer | `companion-markdown.tsx` | 56 | Algorithmic | 十趟正则跑在全量累积文本上、写在渲染体里无 memo | 待核 |
| M16 | Medium | desktop-main | `desktop-ipc.ts` / `desktop-gateway.ts` | 1158 / 2158 | Power | 心跳与 2 条 SSE 不看窗口可见性，最小化后仍 6 请求/分钟 | 待核 |
| M17 | Medium | desktop-main | `desktop-gateway.ts` | 5 处 SSE | Reconnect | 断线固定 1000 ms 重连，无退避无抖动，且每次重连重跑整套 HMAC+health 握手 | 部分 |
| M18 | Medium | desktop-main | `desktop-gateway.ts` | 1767-1838 | Redundant work | `getRoomProjection` 3 次串行 HTTP + 4 次深度 zod，**304 命中仍全量重投影** | 待核 |
| M19 | Medium | desktop-main | `desktop-ipc.ts` | 902-920, 1417-1432 | Redundant work | 每个 IPC 响应在 main 里再校验一次（zod 深拷贝）；广播在订阅者循环内逐份 parse + 同步 `randomBytes` | 部分 |
| M20 | Medium | desktop-main | `desktop-ipc.ts` / contracts | base64 段 | Payload | 图片/音频以 base64 过桥，契约只有 `z.string().min(1)` 无上限（10 MB 音频→13.4 MB 字符串） | 待核 |
| M21 | Medium | desktop-main | `index.ts` | 140-148, 263-278 | Startup | 每个资源请求 2 次 `realpath` + 1 次 `stat`；`onBeforeRequest` 挂 `<all_urls>` | 待核 |
| M22 | Medium | renderer | `CompanionPresence.tsx` | 1059-1142 | Layout thrash | 拖动 pointermove 里读写交替 + `querySelector`，60–125 Hz 下必掉帧 | 待核 |
| M23 | Medium | renderer | `CompanionHud.tsx` / `CompanionChatRecord.tsx` | 2213-2218 / 27 | Virtualization | 聊天历史无虚拟化，`renderArticle` 依赖 `[chat]` 每 token 新建，每条消息每渲染 `new Intl.DateTimeFormat` | 待核 |
| M24 | Medium | renderer | `use-note-doc-live-view.ts` | 43-59 | Algorithmic | 手写 base64 用 `+=` 逐字节拼（O(n²)）；每个远端帧解码再编码一遍只为校验 | 待核 |
| M25 | Medium | renderer | `hud-surface.css` / `home-v2.css` | 2592 等 / 113 | Compositing | 18 处 `backdrop-filter: blur(20px)` 叠在每帧变化的场景上，还有一处挂在正在 transform 的伪元素上 | 待核 |
| M26 | Medium | build | `electron.vite.config.ts` | renderer 段无 `build` | Bundle | 4.66 MB 单个 eager chunk，无 manualChunks、全仓无 `React.lazy`；pixi/milkdown/gsap 首屏全解析 | 亲验 |
| M27 | Medium | queue | `companion-thought.ts` | 907-941 | Serial | ≤3 个候选串行、每个 75 s 预算 vs 110 s handler 超时 → 第 1 个慢就整单失败重投、重付已计费调用 | 待核 |
| M28 | Medium | queue | `index.ts` | 482-487 | Scheduling | V2 outbox 轮询排在主队列槽位检查之后，主队列满时最长 110 s 不领取也不续约 | 待核 |
| M29 | Medium | queue | `queue.ts` / `handler-timeout-config.ts` | 21 / 18-19 | Duplicate work | 租约 120 s vs handler 110 s 只剩 10 s 收尾余量，且租约只在提交时续 → 越界被 reaper 重投 = 重复付费执行 | 待核 |
| M30 | Medium | api | `stats/service.ts` | 126-147 | Aggregate-in-JS | 拉全部 binding 行到 JS 里数 DISTINCT，号称的 2000 上限并不限制这条查询 | 待核 |
| M31 | Medium | api | `review/service.ts` | 424-429, 226-247 | DB-unbounded | 读用户全部 exposure 历史再在 TS 筛给 50 条；同一事务同一谓词全行查两遍 | 待核 |
| M32 | Medium | api | `learning-objectives/surface-service.ts` | 345-437 | DB-unbounded | runIds 无上限收集后喂给两个 `inArray` | 待核 |
| M33 | Medium | api | `source/service.ts` → `note/service.ts` | 574 → 171 | IO-in-tx | 单篇保存路径在事务内从 MinIO 拉图（批量导入路径已修，这条没修） | 待核 |
| M34 | Medium | api | `card-generation-v2/routes.ts` | 317-338 | SSE poll | 每 2 s 开一个完整事务且**没有** in-flight 守卫（隔壁 `inbox-routes.ts` 专门加了） | 待核 |
| M35 | Medium | rls | 全库策略 | `pg_policies` | RLS | 策略普遍是 `(CURRENT_USER='ailearn_worker' OR workspace_id = current_setting(...))`，因那个 `OR`，空间等值只能落在 `Filter` 上，逐行 `current_setting`+cast | 待核 |
| M36 | Medium | rls | `ai_audit_log` / `workspace_audit_log` | owner-read 策略 | RLS | 唯二带子查询的策略，逐行 `EXISTS` 探查 workspaces | 待核 |
| M37 | Medium | trigger | `0267` / `0261` | 186 / 88,123 | Write amplification | 加入空间触发 `1 + M × (W-1)` 条 insert；改一次 AI 同意对每个空间各发一条 `UPDATE workspaces`（而该行每个请求都读） | 待核 |
| M38 | Medium | trigger | `0044` | 358-361 | Write amplification | `note_blocks_sealed_guard` 每行 block 多一次 `note_versions` 查询，配合 M4 放大 | 待核 |
| M39 | Medium | retention | `jobs` / `card_generation_events_v2` 等 | — | Unbounded growth | `jobs` 与多张追加表无任何 DELETE/TTL；`jobs_status_idx` 非部分索引，认领索引随历史永久增长 | 部分 |
| L1 | Low | api | `search/routes.ts` | 12 | Pagination | 深 OFFSET（旧轮 8 月已报，未修） | 待核 |
| L2 | Low | api | `companion-events.ts` | 636-648 | SSE poll | 2.5 s 定频不退避（同文件其余实现有退避） | 待核 |
| L3 | Low | api | `identity/service.ts` | 270-272 | CPU | 纯 JS bcrypt 在主线程，注释自陈 50–150 ms | 待核 |
| L4 | Low | api | `qwen-tts.ts` | 259-304 | Latency | 连接池复用门只看 `alive` 而监听器已摘除 → 上游关闭不被察觉，白等 30 s | 待核 |
| L5 | Low | api | `learning-runs/run-processing-tick.ts` | 1059 | Delete-on-read | 循环内每轮执行一次 DELETE | 待核 |
| L6 | Low | queue | `0115` + `index.ts` | — | Wake-up | NOTIFY 只在 INSERT 触发，重试是 UPDATE 不叫醒，空闲已退到 5 s → 重试白等 ~4.5 s | 待核 |
| L7 | Low | queue | 各 scheduler | — | Duplicate work | 每个 worker 实例都跑同一批 30 s 清扫（注释承认多副本重复扫） | 待核 |
| L8 | Low | desktop-main | `note-doc-cache-store.ts` | 252 | Disk | 临时文件名带 `randomUUID()`，崩溃残留永不清理 | 亲验 |
| L9 | Low | desktop-main | `desktop-ipc.ts` | 1031,1260-1262,2801 | Leak-ish | `trackedLearningRunIds` 只增不减，subscribe 为每个历史 run 重开一条 SSE | 待核 |
| L10 | Low | desktop-main | `preload/index.ts` | 49-51 | Startup | `sendSync` 同步取 contract，会排在 main 的忙活后面 | 待核 |
| L11 | Low | renderer | `components/scene/**` | — | Dead code | 整条 Pixi 场景链无人引用（`RoomSceneCanvas` 无导入方，`RoomStage.tsx:248-249` 硬编码 active=false）却仍在图里 | 亲验 |
| L12 | Low | assets | `electron-builder.yml` | `files: out/**/*` | Package size | 只排除 3d，228 MB 模型 + 138 MB 资产全进 asar（单张 PNG 最大 7.8 MB、单段 mp4 12 MB） | 亲验 |

## 4. 重点详述（只展开需要上下文的）

### H1 流式回包是一条完整的掉帧链（三段都亲验过）

1. `companion-chat-session.tsx:1287` 每个 delta `setDraft({ runId, text })` 给一个新对象，而 `:1817` 把 `draft` 放进了 context 的 `useMemo` 依赖 → **每个 token 换掉整个 context 值**；4 个消费者（含从不读 `draft` 的 `CompanionPresence`）全部重渲染。
2. `CompanionHud.tsx:718` 的气泡几何 effect **没有依赖数组**（`:843` 就是 `});`）→ 每次渲染重建 3 个 observer + resize 监听，并跑一遍约 15 次"读→写→再读"的测量链（`:752`→`:753`→`:755`→`:762`→…），每一笔写都在下一次读之前失效样式与布局。
3. `:1285` 的 `slice(0,appendFrom) + delta` 让全缓冲被复制两遍，长度上是 O(n²)。

结论：每个 token = 一次全树样式重写 + 多次强制回流。这是本轮我认为**用户感知第一**的一条。

### H2 事务里做分钟级 LLM 调用（项目自己写着"仍未实施"）

`card-generation-v2-handler.ts:2233` 与 `:3786-3787` 两处注释明说长期正解是把 LLM 调用移出事务、**未在本轮实施**。我核实了后果：一个 job = 一个事务，最长 `V2_PIPELINE_BUDGET_MS` 20 分钟、内含最多 96 次 LLM 调用，还对 run 行持 `FOR UPDATE`；`db.ts:49-53` **故意不设** `idle_in_transaction_session_timeout`（理由正是这条链路），所以 60 s 的 `statement_timeout` 管不到它。池子：worker `clamp(concurrency*4,15,64)`=15、API 25、PG `max_connections=100`。这正是 `client.ts:41-49` 记录的那个"DB 侧无慢查询但 API 偶发 20–207 s"——今天没复现（实测 API 只用 7/25），因为开发库里没人真跑批量制卡。

### H3 / H8 两个索引缺口，实测比报告更差

`workspace_members` 全表只有 `pk (workspace_id, user_id)`，269 个迁移里没有第二个。我跑 `EXPLAIN SELECT 1 FROM workspace_members WHERE user_id=$1 AND left_at IS NULL` 得到的是**纯 Seq Scan**（比子代理报的"走主键扫"更差）。这条读既在登录路径（`identity/service.ts:197-202`、`:626-631`），也在每个已认证请求的 `decodeToken` 里，还被两个 `SECURITY DEFINER` 触发函数以同样谓词调用（`0261:123`、`0267:186`）。缺的就是 `(user_id) WHERE left_at IS NULL`。

`card_generation_runs_v2` 我查到的 4 个二级索引全是 `workspace_id` 开头，`user_id` 一个都不在——而"我的运行"谓词（含每次点击制卡都跑的 in-flight 守卫 `generation-run-service.ts:187-192`）都带 `user_id`。

### M2 一个"以为加了其实没用上"的索引

`markdown-import-service.ts:354` 用 `content_json->>'importId' = $1` 做幂等检查，还在 `pg_advisory_xact_lock` 里。我查了线上：只有 `note_versions_content_json_gin_idx ... USING gin (content_json)`——**`jsonb_ops` 的 GIN 按定义不支持 `->>` 等值**，只支持 `@> ? ?| ?&`；迁移 0164 的注释以为它管住了这个查询。同类 6 处我逐个对过：`learning_runs.origin->>'objectiveId'` 有 0222 的表达式索引（4 个调用点都是好的），`job/service.ts:148` 按 `payload->>` 动态字段查重没有任何可用索引。

### H6 / L12 本地语音那条 228 MB 的账

`asr-worker.js:37-48`：`fetch().arrayBuffer()` → `new Uint8Array(modelBytes)`（这是**一次整份拷贝**）→ `FS.writeFile` 进 Emscripten MEMFS，同一份 228 MB 至少两份同时在内存，之后 onnxruntime 还要再从 MEMFS 载入一次。`local-speech-recognition.ts:24` 的 worker 是模块级单例、**成功路径上永不 terminate** → 用户说过一次话，这几百 MB 就常驻整个会话。加上 `electron-builder.yml` 把 `out/**/*`（除 3d）全打进 asar。

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

1. **H1**（改依赖数组 + 拆流式字段到独立小 context）——改动小，用户感知最直接。
2. **H3 + H8**（两个索引）——一条 migration 的事，且在每个请求的路径上。
3. **H2**（把 LLM 调用移出事务）——结构性、唯一能把 API 抖到 200 s 的一条；代码已经给出正解方向（authoring 阶段的 `commitAuthoredCandidateV2` 就是正确形态，照它改剩下的阶段）。
4. **H5 / M1 / M2**（三个 DB 形状问题）——同一个端点上可以顺带一起量。
5. **H7**（本地缓存按条目落盘 + 合并 flush）与 **H6**（ASR 模型加载与释放）。
6. 其余 `Medium` 按分区批量清，`待核` 项先复现再动。

在开工前值得先做一次**带真实数据量的复测**：本文凡"现在不痛、形状不对"的判断，现在都还没有数字能定拐点。

---

## 附：本轮方法记录（供后来者复核）

- 真实测量：`curl :4000/metrics` 取直方图后自己解析求均值；`docker exec ailearn-dev-postgres-1 psql` 读 `pg_stat_user_tables` / `pg_stat_user_indexes` / `pg_indexes` / `pg_policies` / `pg_proc` / `pg_constraint`，`EXPLAIN`（未用 `ANALYZE`，未执行任何写入或迁移），以及 `octet_length` 直接量行宽。
- 体积：`du` / `sips` 量 `out/renderer`、`public/assets` 与单个 JS chunk。
- 读码：六个并行子代理分别扫 DB 访问、schema/索引/RLS、API 运行时、Electron main、renderer、worker/队列；**两份被整份否决**（理由见 §2），其余逐条重开文件或重跑查询后才进本文。
- 基线：确认 `docs/performance-scan-2026-08-16*.md` 的扫描对象目录已不存在，故未沿用其任何"已修"结论。
