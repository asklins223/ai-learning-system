# 笔记 → 学习卡 → 作答 全链路问题修复方案（2026-09-20 实走记录）

## 0. 文档定位

来源：2026-09-20 用户以真实账号走完「来源资料 → 笔记 → 生成学习卡 → 审核激活 → 列表 → 作答」全流程，提出 18 条问题。本文按「现象 / 根因 / 改法 / 验收」逐条落到具体文件与函数，并给出批次划分。

行号均为 2026-09-20 在 `v1.0` 分支上逐个打开核实过的，不是推测。开工时若已漂移，以函数名与注释定位为准。

严重度标记：`[阻断]` 用户被卡住或结果本身就是错的；`[误导]` 界面说了假话或藏了真相；`[体验]` 能用但难用、看不懂。

## 1. 已确认的产品决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | **候选卡「保留」即排队激活，去掉「加入待激活」勾选框** | 数据模型两个字段都保留，只收束 UI 语义：点「保留」= 我要这张 = 进激活队列；不再要求用户做两次决定。 |
| D2 | **专注计时改成纯秒表 + 60 分钟绝对超时** | 界面不显示上限、不显示进度条；本地逐秒推进，服务端值只作校准；60 分钟内未终止则自动结束并落「未终止」结果。 |
| D3 | **先改阻断性 bug，再改 UI 与文案；每批完在活应用里验证再进下一批** | 见 §3 批次表。 |

---

## 2. 逐条诊断

### 生成链路（批次 A）

#### #1 `[误导]` 同意了为什么还要激活

- 现象：审核页点了「保留」，仍要求再勾选 + 点「激活 N 个目标」。
- 根因：`cardGenerationCandidatesV2` 有两个正交字段 `reviewDecision`（undecided/keep/reject/merged，`packages/shared/src/db-schema/card-generation-v2.ts:140`）与 `publishState`（unpublished→activating→activated，`:141`）。设计上分开没错（留 12 张只放 3 张进队列），但当前实现把它变成陷阱：
  - `components/CardGenerationSurface.tsx:604` 的 `selectedCount` 只统计 `reviewDecision === "keep"` 的勾选，**先勾后不点保留 = 静默激活 0 张**；
  - `modules/card-generation-v2/activation-service.ts:457-467` 激活时把所有仍 `undecided` 的候选批量打成 `reject / not_selected_at_activation`。两个动作不是独立的，是一条隐藏序列。
- 改法（D1，已实施）：
  1. 删除「加入待激活」勾选框整条链路：`selectedIds` state、`toggleSelection`、`activeCandidateSelectable/Selected`、`isLiveGenerationForNote` 无关的 `.candidate-activation-choice` CSS 三处规则全部移除；激活集合 = `isActivatableCandidate`（= 已保留 + 未发布 + 有证据绑定计划）。
  2. 保留按钮改为「保留（进入激活队列）」，状态标签「已保留 · 待激活」改为「已保留 · 在激活队列里」，让"保留即排队"在界面上自解释。
  3. 把隐藏后果写出来：仍有未决候选时，动作区显式说明「点激活只提交已保留的 N 张，其余会被记为未选中并丢弃」（对应 `activation-service.ts:457-467` 的批量 `not_selected_at_activation`）。
  4. 服务端两个字段与批量丢弃语义**保持不变**——问题出在 UI 要求用户做两次决定并让其中一次静默失效，不在数据模型。
- 验收：组件测试改成"保留后直接出现『激活 1 个目标』、DOM 里不再有勾选框"，并新增断言：未决时警告可见、保留后警告消失。desktop-client 982 例全绿。

#### #2 `[误导]` 进度从第 2 步直接跳到完成

- 根因（两处叠加）：
  - `components/surfaces/card-generation-status.ts:34-39` `cardGenerationStage()` 把 14 个 run 状态折成 4 桶，`checking` 之后的一切（含 `review_ready`/`activating`/`failed`）返回 3 → `progressDone = min(3,3)` → 恒 75%，且四条 stage 行（`CardGenerationSurface.tsx:607-611, 862`）全部点亮「已完成」；
  - `src/main/desktop-gateway.ts:3503-3560` 的 SSE 客户端只用 `parseSseSequence()` 取 `id:` 行，**eventType 被整个丢弃**，所以服务端明明发了 `card_candidate.authored` / `grounding_passed` / `dropped_semantic_duplicate` / pedagogy 事件（`modules/card-generation-v2/routes.ts:264-353`），渲染层只能重读粗粒度 `run.status`；
  - `planning` 状态自创建后从未被再次 set。
- 改法（已实施，选了"不把原始事件推过 IPC"的那条路）：
  1. `getGenerationRunV2` 随 run 详情下发逐候选计数 `progress = { plannedCards, authored, gatePassed, gateFailed }`（`helpers.readGenerationProgressV2`，按每个 candidate 的**最新修订**分组计数——同一候选会被改写多次，按行数会虚高）；列表接口不聚合，避免每次房间刷新多打一遍候选表。
  2. 契约：`cardGenerationProgressV1Schema` + 挂到 server view 与 snapshot 两处（`card-generation-desktop-contracts.ts`），投影函数原样透传，并加了一条断言钉住这点——投影层正是这次进度丢掉的的位置。
  3. 事件驱动链**本来就是通的**（SSE 序号变化 → 主进程重读 run 详情 → 通知渲染层重读），缺的只是详情里没有可数的东西，所以没有改动 SSE 解析，也就没有把原始事件内容送过 IPC（`desktop-ipc.ts` 明文写着 raw payloads stay main-only）。
  4. `cardGenerationStage` 改为完整枚举 14 个状态 + 返回 `number | null`，删掉 `return 3` 兜底：说不出走到哪一步就不说。新增 `cardGenerationProgressView(status, progress)` 统一给出档位/百分比/计数文案，阶段内部按计数走一小段（`authoring` 用 authored/planned，`checking` 用 passed/total），并被 0.95 上限钉住**不会提前越到下一阶段**。
  5. 被取代的 `cardGenerationShowsProgress` 直接删除；进度块与四段轨道都改为 `progressView !== null` 才渲染，并补一条"既不推进、服务端也没签发恢复动作"的兜底视图（此前这条路径会点亮一条假装走完的轨道）。
- 验收：既有的 `["failed", 3]` 断言被换成显式 null（那条断言本身就是在锁住 bug）；新增 4 例（阶段映射逐项枚举 / 进度只在能说的状态出现 / 阶段内按计数推进且文案同源 / 组件层渲染出"已过质量门 2 / 8"并把百分比推过 50）。shared 312 / api 1433 / desktop-client 982 全绿。真实生成时仍需肉眼确认一次：一次生成过程中百分比单调不回退、不出现"从第 2 步跳到完成"。

#### #3 `[阻断]` 生成的卡全是主观题，题型设置完全无效

- 根因（三层）：
  - 用户勾的 `preferredStrategies` 被存库（`generation-run-service.ts:194` → 语义 spec，`packages/shared/src/card-generation-v2-contracts.ts:199,266`）后**从未被读取**——`grep preferredStrategies` 在 `packages/shared/src/card-generation-v2-pipeline/*` 与 `workers/ai-worker/src/card-generation-v2/*` 里零命中；
  - `buildAuthorSystemPrompt()`（`prompts.ts:398`）**无参数**，`presentation.strategy` 在输出模板里写死 `"recall"`（`:541`），唯一的完整示例也是 `"strategy": "recall"`（`:573`）。没有枚举清单、没有「必须变化」的指令 → 模型照抄示例；
  - LLM 关闭时的确定性兜底必然是 recall：`inferKnowledgeForm` 默认 `"fact"`（`planner-service.ts:422-431`）→ `mapKnowledgeFormToStrategy` 把 `fact|definition → recall`（`author-service.ts:325-338`），题面模板固定 `请回忆并说明「…」`（`:303-307`），`cloze` 在映射表里不可达。
- 顺带的术语问题：七种 strategy 是 `recall|cloze|compare|sequence|why|boundary|application`（`card-generation-v2-contracts.ts:46-56`），UI 列名叫「题型」但从不解释；用户口中的「主观题」对应 `recall`（主动回忆）。
- **实施中新发现的三个共犯**（不修就等于把「全 recall」换成「交付 0 张卡」）：
  - `strategy` 在下游是**死字段**：`grep strategy apps/api/src/modules/learning-runs/*.ts` 零命中，作答通道由 `objective.preferredTaskIntents` 构造。只放宽题面会让「填空题」配上一个「解释」任务；
  - 默认勾选是 `["recall", "why"]`（`notebook-surface.tsx:108`）——即便题型真正生效，事实类知识也会被压成回忆题；
  - §13.1 的泄题判定是 **hard 闸门**（`deterministic-gates.ts:329` 走「压缩标点后 ≥12 连续字符照抄」），且激活与正面编辑侧各有一份同源后闸（`activation-service.ts:780`、`card-service.ts:345`）。中文 12 字符很容易命中，`cloze`（题面本就是原句挖一处）与 `sequence`（题面本就列出各步骤名）会被整批否决。
- 改法（已实施）：
  1. `plannedObjectiveV2Schema` 增 `strategy` 字段（`card-generation-v2-contracts.ts:381`）——题型由 planner 决定，author 只执行；
  2. 新增 `allocateStrategies(forms, preferredStrategies)`（`planner-service.ts`）：形态适配表 `STRATEGIES_FOR_KNOWLEDGE_FORM` 是硬边界（`fact→[cloze,recall]` 让 `cloze` 首次可达）、偏好是**集合不是优先级**（chip 多选没有顺序语义，按适配度排）、单一题型 ≤⌈N/2⌉（只勾一种时不设限，明确的偏好就是要求），偏离最自然题型时写 `strategy_preference_applied` / `strategy_diversity_capped` 进 `reasonCodes` 供审计；
  3. `buildAuthorSystemPrompt(strategy)` 参数化：开头给出该题型的「练什么 + 题面写法 + 专属泄题边界」，输出模板与示例的 `strategy`/`transformationKind`/`preferredTaskIntents` 全部按分配值插值；prompt 版本 v20 → **v21**（`generation-run-service.ts:226-256` 四处种子同步，有 `card-generation-v2-prompt-version-sync.test.ts` 兜底）；
  4. `preferredTaskIntents` 改由 `taskIntentsForStrategy(strategy)` 单点派生（共享给 worker 提示与确定性兜底，`author-service.ts:288` 此前硬编码 `["recall"]`）；
  5. 泄题判定改为题型感知：`cloze`/`sequence` 用「整条答案单元被完整照搬」判定（`frontLeaksAnswerVerbatimV2` 第三参数改为必填，逼三处调用点一起对齐，不留「未知题型=免检」的缝）；
  6. pedagogy critic 的 `front_leaks_answer` 判据补「泄漏是相对题型而言的，判之前先读 presentation.strategy」——它已经能在 user prompt 里看到 presentation，无需改签名；
  7. `notebook-surface.tsx` 默认勾选改为全选 7 种（= 交给系统按内容分配），并在题型行下加一行说明勾选语义。
- 验证（已完成部分）：`packages/shared` 新增 `strategy-allocation.test.ts` 7 例；`card-generation-v2-deterministic-gates.test.ts` 补 2 例钉住 cloze 的放宽与「没真的挖空仍然拦住」；四包 typecheck 全绿，shared 312 / api 1431 / worker 642 / desktop-client 978 全通过。
- 待验证（需要跑真实生成，批次 A 收尾时一次覆盖 #3/#2/#5）：形态多样的笔记实际产出 ≥2 种题型且不再有 5 张全 recall；`cloze`/`sequence` 卡能通过 grounding + pedagogy 而不是被 hard 掉；生成设置里只勾一种题型时确实只出那种。
- **落地时发现的存储前提（决定 #4 走向）**：作答侧的任务行 `learning_tasks`（`db-schema/learning-runs.ts:192`）只有 `intent` / `prompt` / `hintLevels`，**没有任何服务端私有 jsonb**；`learning_task_variants.interaction` 是公开载荷，把提示放进去等于绕过 exposure ledger 白送提示（提示会永久把计分降到 `practice_only`，必须继续走按需下发）。所以"作者产出提示"必须先决定它存在哪：见 §5 待决事项 D4。
- **不在本次范围**：让作答**交互形态**（挖空输入、拖拽排序、连线）跟随题型。目前交互形态由 `canonicalAnswer.kind` 的五种结构决定（v20 刚开放），与 `strategy` 是两条独立轴。若要真正打通，需要 learning-runs 侧读 `strategy`，属批次 B/C 的独立决策点。

#### #5 `[阻断]` 没改动却能再次生成，且旧卡不会变成废弃版本

- 根因：
  - 服务端 `createGenerationRunV2` 无任何 per-note 守卫，只查 workspace 在途数与日配额（`generation-run-service.ts:121-145`）+ 幂等重放；
  - 客户端有守卫但拿不到数据：`isLiveGenerationForNote()` 要求 `generation.noteId === noteId`（`card-generation-status.ts:138-143`），而 `desktop-gateway.ts:1616-1617` 只把 `active.items[0]` 塞进 room projection。第二个 note 的在途 run 或更新的 run 一出现，笔记页按钮就退回「生成学习卡」（`notebook-surface.tsx:820-833`）；
  - 旧批次不废弃：`cardGenerationRunsV2.supersedesRunId`（`db-schema/card-generation-v2.ts:62`）**生产代码从未写入**，全仓库仅 schema/迁移/测试 fixture 命中。run 内重新规划会 supersede（`card-generation-v2-handler.ts:2469, 2605`，`WHERE run_id = ${runId}`），跨 run 什么都不做 → 候选卡重复堆积。旧卡退休只在激活时撞到同一 objective 才发生（`activation-service.ts:1638-1684`）。
- 改法（已实施）：
  1. `createGenerationRunV2` 增加 per-note 守卫（`generation-run-service.ts`）：同一篇笔记存在非终态 run 时抛 `note_generation_in_flight` / 409；
  2. 新建 run 时写入 `supersedesRunId` = 该笔记上一个 `activated` run（`supersedes_run_id` 列此前从未被写入）；
  3. 激活事务新增 `retireSupersededRun`（`activation-service.ts`）：按被替代 run 的 activation receipts 找出它发布过的 objective/card，跳过本次再次命中的（语义同一会被 `createOrUpdateObjectiveAndCard` 复用），其余 `lifecycle → 'superseded'`、关闭 pending 复习排程（复用 `closePendingSchedules`，已从 card-service 导出，保证归档与替代走同一套收尾）、取消初次验证提醒，并把旧批次候选 `publishState → 'superseded'`。`learning-runs/run-service.ts:1147` 与 `review/service.ts:229` 都按 `lifecycle='active'` 取数，所以这一步真正把它们移出了作答与复习队列。
  4. 渲染层改 projection 携带**全部**在制批次：`roomSectionSchema(cardGenerationActiveSummaryV1Schema)` → `z.array(...).max(20)`（`room-projection-contracts.ts:166`），`desktop-gateway.ts` 不再取 `items[0]`，`notebook-surface.tsx` 改为按 `noteId` 在数组里 `find`。`RunRecoveryNotice` / `CardGenerationSurface` 显式取 `[0]`（它们要的就是"最近推进的那一个"）。
  5. `startGeneration` 失败后调用 `reload()`：否则入口停在「生成学习卡」，用户点一次撞一次 409 且状态不变。
- 验证：`card-generation-v2-run-service.test.ts` 新增 2 例（守卫 409、`supersedesRunId` 落库）；`notebook-surface.generation-sync.test.tsx` 新增 2 例（另一篇笔记的 run 排在数组首位时本篇守卫仍生效；被拒后入口重读并翻到「审核学习卡」，`startCalls` 仍为 1）。既有替身修正 2 处：`sse-outbox` 的 runs 替身改为按表判定（原先用"有没有传 columns"区分 events，多篇在制时全部命中同一份返回），`run-service` 的 runs 替身补 `orderBy`。
- 说明：网关把上游 409 一律收敛成 `conflict`（`desktop-gateway.ts:4305`），域内错误码是否跨 IPC 边界是既有设计决定（只放行白名单 auth token），本批未改动；用户实际会先看到修正后的按钮状态，409 只是竞态兜底。

#### #10 `[阻断]` 提示是后端写死的常量，与卡片内容无关

- 根因：`buildDeterministicHint()`（`modules/learning-runs/run-planner.ts:746-761`）是 9 个 intent × 3 条文案的**常量表**，只按 `task.intent` 与 `level` 取值，卡片正文不参与；由 `run-service.ts:1787` 调用。`hintLevels` 是 variant 上的静态 1 或 2（`run-planner.ts:268, 346, 463`）。
- 附带缺陷：服务端返回 `resultingTrustCeiling: "practice_only"`（`run-routes.ts:513-515`），看过提示会**永久降级该卡计分上限**（`run-processing-tick.ts:611-648`），而客户端只读 `.text` 把这个字段丢弃（`learning-run-surface.tsx:1382`）。用户被扣分且不知情。
- 改法（已实施，落点按决策 D4 = 新增私有列）：
  1. 迁移 `0234_card_hint_pair.sql` 给 `card_generation_candidates_v2` 与 `learning_objective_revisions_v2` 各加 `hints jsonb NOT NULL DEFAULT '{}'`。
  2. **为什么不进审计链**（本次的硬约束）：`computeCandidateRevisionHashV2` 对**整个候选对象**取哈希，所以提示不能塞进 `objective_draft` / `presentation_draft`；`learning_support` 受 R30「必须基于证据」并由 Grounding Critic 逐字段核对，提示是教学引导不是事实断言，塞进去会被误杀；`learning_task_variants.interaction` 是公开载荷，放进去等于绕过 exposure ledger 白送提示。因此提示全程走**兄弟列 / 兄弟返回值**：`AuthorResult.hintsByCandidateRevisionId`、`AuthoringProviderOutput.hints`、入库 SQL 的 `hints` 列。测试直接断言 `"hints" in candidate === false`。
  3. 作者产出：`buildAuthorSystemPrompt` 要求同批交出 `hints.level1/level2`，规则含「两级都不许出现判分要点术语」与「不许写再想想/看看原文这类无信息量的话」；模板与示例的提示按题型查 `exampleHintsForStrategy`。prompt 版本 v21 → **v22**（api 四处种子同步）。
  4. 缺提示**不重跑也不淘汰候选**（提示不是判分内容，为它牺牲一张卡不值得）：worker 侧解析失败即退回 `fallbackCardHints`——按本卡概念标签、知识形态、答案单元数与题型派生，仍与卡片内容相关；`buildDeterministicHint` 常量表退到最后一步。
  5. 读取侧：`request_hint` 经 `run.origin.objectiveId → 目标**当前修订** → hints` 取值（答案被改写后旧提示不再下发），没有才退回派生表；`level > hintLevels` 的既有门禁不变。
  6. 副作用不再静默：`resultingTrustCeiling: "practice_only"` 此前被客户端丢弃（只读 `.text`），现在提示框同屏显示「看过提示之后这张卡本轮只计练习分」。
- 验收：新增 1 例钉住「两张不同内容的卡提示不同」+「提示不进候选哈希输入」；shared 312 / worker card-generation 33 / api 本批用例全绿。
- **未验到的一跳**：api 里没有任何 `request_hint` 既有用例，从零搭一套 `applyAction` 事务替身不划算，所以「提示真的从卡片读到」留到批次收尾那一次真实生成 + 真实作答里确认。

### 作答会话（批次 B）

> 注：#10 的根因虽在 `learning-runs`，但修法要求作者产出提示，故归入批次 A 一并完成（见上）。

#### #6 `[误导]` 提交后迟迟不出结果，且几乎没有反馈

- 根因：`submit()`（`learning-run-surface.tsx:1271-1333`）不阻塞——POST 返回回执后设 `{kind:"pending", phase:"assessing"}`（`:1319`），再按 `components/result-polling.ts:9-14` 的 1s/2s/4s/8s/10s、最多 8 次 / 60s 轮询。真实延迟来自打分 outbox **每 10 秒才 tick 一次**（`apps/api/src/server.ts:521-533`，`processingIntervalMs = 10 * 1000`，失败还指数退避到 60s）+ 一次在线 LLM critic 调用（`run-processing-tick.ts:534-568`）。等待期界面只有一个 `<div role="status">回答已锁定，正在评估` （`:1689-1694`），无 spinner、无已等时长，提交按钮立刻变成「返回」。
- 改法：(a) 提交后保留不可逆的答卷快照在页面上，让用户看得见自己答了什么；(b) 加真实进度语义（已提交 → 正在核对证据 → 正在评分）与「已等待 N 秒」计时，复用现有 SSE 订阅（`:955-981`）做结果推送；(c) 把提交后的 outbox tick 从 10s 降到入队即触发一次即时处理，10s 只作兜底轮询；(d) 60s 预算耗尽时的 `resultQueryBudgetExhausted` 要给「结果还在路上，稍后自动回填」而不是失败口气。
- 验收：从提交到出结果，页面全程有可见状态变化；空转不超过一个 tick；等待超过 5 秒时用户能看到已等待时长。

#### #8 `[阻断]` 没有麦克风时整个作答流程卡死

- 根因：能力探测是恒真式。`nativeCapabilities()`（`desktop-gateway.ts:495-512`）里 `asr` 的值来自 `new Set(Object.values(DESKTOP_IPC_CHANNELS)).has(companionVoiceTranscribe)` ——通道名永远在这个静态集合里，所以**永远「可用」**，跟硬件、权限、设备枚举无关。渲染层据此在 `learning-run-surface.tsx:767-778` 设 `voiceAvailable = true`。全仓库唯一真探针是 `components/companion/voice-recorder.ts:116-120` 的 `isSupported()`，只有伴星 HUD 用过。
  更糟：`switch_variant`（`run-service.ts:1801-1845`）切过去后把原 active variant 翻成 `superseded`（`:1820-1824`），而可选列表只列 `status === "standby"`（`run-view.ts:262-269`）→ **没有任何回头入口**，`voice_teachback` 的编辑器只剩一句死路文案「当前设备没有可用的语音输入」（`learning-run-surface.tsx:563-570`，该 surface 内根本没有录音器 UI）。
- 改法：
  1. 主进程做真探测：`navigator.mediaDevices.enumerateDevices()` 查 `audioinput` + `permissions.query('microphone')`，结果作为 `asr` 的真实值；缓存并在权限变化时失效；
  2. `换一种方式作答` 在不可用时**不出现**或出现但禁用，点击前置检查失败时给明确弹窗：不能切换 + 原因（无输入设备 / 未授权 / 授权被拒绝）+ 下一步怎么修；
  3. 已切换后必须留退路：`switch_variant` 不销毁回退能力，`availableAlternatives` 允许切回 `superseded` 的原 variant（记录切换历史即可），或在语音分支内始终提供「改用文本作答」。
- 验收：拔掉麦克风（或拒绝权限）后，切换按钮不可点或给出原因；任何路径下用户都能回到文本作答，不需要靠「跳过」脱身。

#### #9 `[误导]` 「待验证」看不懂，而且直接停止作答

- 根因：`unvalidated` 表示该 objective 还没有过一次正式（canonical）作答结果（`learning-objectives/surface-service.ts:74-82`：`lastCanonicalAt ? "stable" : "unvalidated"`）——所以新激活的卡 100% 是待验证，这也正是 #4 列表为空的直接原因。
  卡住用户的不是这个状态，而是一个隐藏的 24 小时冷却：查看答案会写 `qualificationNotBefore = now + 24h`（`card-generation-v2/card-service.ts:60, 971-1046`，另见 `activation-service.ts:1954-1971`），reminder 转 `deferred`（`surface-service.ts:113-121`）→ `action-resolver.ts:98-106` 给出 `wait_for_initial_validation` → CTA 被 disabled（`WorkspaceLibrarySurface.tsx:221-228, 591-594`，标签 `等待首次验证`）。用户看一眼答案就被锁一天，界面上没有任何解释。
- 改法：(a) 状态词换成人话，`unvalidated` → 「还没正式答过」；(b) disabled 必须同屏给出原因与时间点，不可只留一个灰色按钮；(c) 重新评估 24h 冷却是否是必要产品约束——若是，就在「查看答案」这个动作**之前**就告知代价；(d) 全站三套近义 vocabulary（`WorkspaceLibrarySurface.tsx:138-148` 状态名 / `:413-415` pulse 分类 / `graph-surface.tsx:93-99` 需关注-已理解）统一成一套。
- 验收：新用户第一次见到「待验证」卡，不需要问人就知道它是什么、为什么现在不能答、什么时候能答。
- **已落地（2026-09-20，含一处比原诊断更深的根因）**：
  1. **重查发现真正的"停止作答"来自优先级写错，不是冷却本身**。`resolvePrimaryActionV3` 里 `initialDeferred` 排在 `practiceOnly` 之前，于是看过答案的卡在 24 小时里**连练习入口都没有**，只剩一个灰色按钮。而冷却要保护的东西并不靠这个按钮实现：近期 reveal 会让冻结快照的 `publishedTargetEligibility = "practice_only"`（`target-snapshot-adapter.ts:288-336`，窗口同样是 24 小时），planner 据此把 purpose 钳成 practice、trust ceiling 钳成 practice_only（`run-planner.ts:445-454`），答案已看过的题**拿不到掌握证据**。审核阶段看过候选答案也已由 `mapCandidateExposuresToObjective`（`activation-service.ts:1996`）映射进 `learning_exposures_v2`，所以 `practiceOnly` 同样成立。
     改法：`practiceOnly` 上移到 `initialDeferred` 之前 → 签发「带着参考答案练一下」；`wait_for_initial_validation` 保留为"没有练习证据"时的兜底分支。新增用例钉住三件事：冷却中 + 曝光 = 给练习且带时间点；冷却到期（`initialReady`）= 正式验证重新压过练习；单纯 deferred = 仍然只等。
  2. **`practice_only` 动作现在自带 `formalValidationNotBefore`**（契约新增必填 nullable 字段，`learning-objective-surface-contracts.ts`）：练习不推进正式验证，所以"那什么时候能正式算"由服务端一起下发，客户端不许自己拼时间。契约测试补了反向断言——**漏掉这个字段的 practice_only 必须解析失败**，避免"看起来永远等不到"的等待。
  3. **代价说在点之前**：审核页「查看答案与证据」按钮的 title 与看后说明都改成写清 24 小时后果（`CardGenerationSurface.tsx`），测试同时断言**点击前** title 里已有「24 小时」。跑完一轮作答后的「看这次的答案与解释」不需要警告：那次 reveal 落在已 completed 的 reminder 上，`deferReminderOnReveal` 不重开。
  4. **一套状态词，五处共用**：新增 `components/surfaces/objective-state-copy.ts`（纯模块），`unvalidated → 「还没正式答过」` 并为 10 个状态各配一句解释；`WorkspaceLibrarySurface`（原本自己抄了一份 label + tone + action 标签 + 日期格式化）、`surface-data.tsx`（两份**没有任何调用方**的重复实现，直接删除）、`graph-sky.ts`（第四份状态表 + 自己的 attention 集合）、`graph-surface.tsx`（第五份 action switch）、`room-primary-action-presentation.ts`（房间页自己按 activeRun/review/initialValidation 推出「服务端已确认」，违反合同里"必须直接展示服务端签发的 personalState"）全部改为引用同一份。「要处理 / 进行中 / 答对过」三个桶由一张表同时驱动概览数字与筛选按钮，`objectiveStateNeedsAttention()` 收编了散在调用方 if 里的 `unvalidated` 例外。宇宙图那条更粗的状态轴（`unseen` 等）保持独立，但把撞车的「待验证」换成「没见过」，一个词不再指两件事。
  5. 详情页把状态解释渲染在动作按钮上方，「首次验证」一行在 deferred 时直说「答案看过了 + 几点开放 + 期间可以练」；`formatObjectiveDateTime` 不用 `Intl`（zh-CN `month:"numeric"` 在 Electron full-icu 出「9月21日」、在 vitest 的 Node 出「9/21」，等待终点不能随 ICU 变），并由测试钉住。
- 验收状态：`unvalidated` 的说明、disabled 的原因与时间点、reveal 前的代价告知、词汇统一都已落地；「第一次见到就懂」这句需要活应用复核（见 §5）。

#### #11 提示按钮套娃

- 根因：`run-action-availability.ts:31-33` 每一级各发一个 `request_hint`；`learning-run-surface.tsx:1533-1541` 只把 level 1 放进 `quickActions`（标签 `给我一点提示`，`:327`），level 2 变成 `查看第 2 级提示` 落进 `<details class="learning-run-more"><summary>更多选择>` 里（`:1736-1751`）。
- 改法（按用户指定）：合并成**一个**提示按钮——点一次出第一级并把按钮文案换成「再看一层提示」，点第二次出第二级，之后按钮禁用。两级都在同一个提示框内展示，不折叠、不套 menu。
- 验收：作答主界面不存在「更多选择」里的提示项；提示层数在 DOM 里就是同一个按钮的三次状态。

#### #12 `[体验]` 稍后再做 / 安全退出 / 跳过这一步 / 暂时不会 四个按钮

- 根因：`skip_run`（`run-service.ts:1671-1691`）与 `skip_task`（`:1692-1719`）在 P2 单任务 run 下产生**逐字节相同**的终态（代码注释 `:1700` 自己承认），`end`（`:1720-1772`）什么都不写，`暂时不会` 才是真提交（`submit({kind:"declared_unable", reasonCode:"cannot_recall"})`，`learning-run-surface.tsx:1744-1748`）。四个都在 `moreActions` 里，且前三者 `confirmationRequired: true`（`run-action-availability.ts:26,30,27`），每个还要再开一次 alertdialog（`:1774-1785`）。
- 改法（按用户指定）：只留两个——**稍后再做**（离开，不产生评分记录）与**暂时不会**（作为一种真实作答结果，走 `declared_unable`，会记录为需要复习）。`skip_task` 与 `end` 的链路按 AGENTS.md 的清理原则整条删除，不留双轨。
- 验收：作答界面退出类动作只有两个，语义分别对应「不做了」和「我确实不会」；不存在两个产生相同终态的按钮。

#### #13 `[体验]` 计时不动、无上限、无进度条（见 D2）

- 根因：显示值恒为服务端 `snapshot.activeSecondsUsed`（`run-view.ts:327`），只在 activity lease 里每 15 秒 flush 一次（`components/learning-run-activity-lease.ts` 的 `ACTIVITY_LEASE_INTERVAL_MS = 15_000`，循环在 `learning-run-surface.tsx:983-1105`，`:1024` 再重读服务端值），且 `:1022-1023` 注释明确「故意不在本地推算流逝时间」→ 每 15 秒跳一格；`visibilityState !== "visible" || !document.hasFocus()` 时完全冻结（`learning-run-activity-lease.ts:15-19`）。进度条其实存在（`learning-run-surface.tsx:1542`，CSS `hud-surface.css:4662-4675`），但上限从不显示，`aria-label` 只有「已使用 …」（`:1663`）。服务端已有 180 秒软预算（`packages/shared/src/learning-run-v2-contracts.ts:84,86`，`clampTimeBudget` at `run-service.ts:723,1960`），计分侧仍在使用。
- 改法（D2）：本地 `performance.now()` 起点 + 逐秒推进显示，服务端值只做漂移校准；移除上限与进度条的可见性（按用户要求），保留 180 秒预算的服务端语义不动；新增 60 分钟绝对超时——到点自动结束 run 并落「未终止」结果，避免 60 分钟无终止。
- 验收：秒表逐秒跳动；失焦再回来不出现 15 秒跳变；挂机 60 分钟得到一次自动结束且有明确说明的终态。

### 列表 / 笔记 / 来源（批次 C）

#### #4 `[误导]` 生成完跳到理解目标页，筛选项是错的「已稳定」且列表空白

- 根因：「已稳定」不是硬编码默认，而是一个跨组件卸载存活的**模块级内存缓存**（`WorkspaceLibrarySurface.tsx:243-253` `objectiveLibraryViewState`，`:268` `useState(() => objectiveLibraryViewState.filter)` 重新读上次选择，`:353-356` 写回，仅 `workspaceId` 变化时重置 `:280-284`）。`open-objectives` 意图（`app/room-machine.ts:58,97-98`）不携带任何筛选参数。叠加两点：筛选是**已加载 ≤60 条的前端本地过滤**（`:287` `limit: 60`），API 只支持 `lifecycle/cursor/limit`（`learning-objectives/routes.ts:30-32`）；而新卡状态是 `unvalidated`，被归进「待处理」桶（`:374-376`），永远不会出现在「已稳定」里。
- 改法：跳转时显式带筛选意图（生成完 → 「刚加入」视图）；筛选改成服务端参数而不是本地过滤已加载 60 条；新增「本次新增 N 张」入口并在行上标出；模块级缓存改为随导航意图重置。
- 验收：从审核页点「查看理解目标」，落地即可看到刚生成的那几张卡；不出现空列表 + 一个看似有结果的筛选。
- **已落地（2026-09-21）**：
  1. 那份跨挂载存活的视图态从 `WorkspaceLibrarySurface.tsx` 里搬进独立模块 `components/surfaces/objective-library-view-state.ts`，读写都走 `readObjectiveLibraryView` / `writeObjectiveLibraryView` / `retargetObjectiveLibraryView` / `resetObjectiveLibraryView`——之前它是一块裸 `let`，别的组件没有办法"带着意图"进来。
  2. 激活回执上的「查看理解目标」先 `resetObjectiveLibraryView()` 再 `invoke("open-objectives")`：清搜索词、清筛选、滚回顶部，但**保留当前工作区标识**（否则下一次 load 会误判成换空间）。列表服务端按 `createdAt DESC` 排（`surface-service.ts:546-555` 的 cursor 条件即证），新激活的卡天然在「全部」最前面。
  3. 状态词与桶口径已随 #9 统一到 `objective-state-copy.ts`：`unvalidated` 现在叫「还没正式答过」，且被 `objectiveStateNeedsAttention()` 明确算进「要处理」桶——旧代码里它落在 `default: "neutral"`，既不在 attention 也不在 progress，只有那句硬编码的 `|| state === "unvalidated"` 记得它。
  4. **有意没做**：把筛选/搜索下沉到服务端。症状由残留筛选造成，而 `limit: 60` 的本地过滤在超出时本来就如实写「已载入范围内没有匹配目标」并给「继续读取」按钮；加 `?q=` / `?bucket=` 要动 `learning-objectives` 的 SQL 与契约，等 #7 真要往行上带作答数据时一起做，不在这里分两次改同一条查询。

#### #7 `[体验]` 列表里看不出每张卡的状态变化

- 根因：行组件只渲染 tone 圆点、标题、摘要和一行 meta「状态 · 知识形态 · createdAt」（`WorkspaceLibrarySurface.tsx:447-459`）。而 `unvalidated`/`archived`/`superseded` 三种状态都落到 `objectiveStateTone` 的 `default: "neutral"`（`:152-163`）→ 共用一个灰点，状态词只是小号内联文字。数据侧：`practiceTrailCount`（作答次数）、`lastCanonicalAt`（上次作答）、`review.status/dueAt`、`initialValidation.status`、`activeRun.phase` **只存在于详情契约**（`packages/shared/src/learning-objective-surface-contracts.ts:198-222`），列表契约 `ObjectiveListItemV3`（`:245-262`）根本没有这些字段，全站也没有「掌握度」字段（只有内部的 `mastery_eligible` 上限，`learning-runs/run-planner.ts:130`）。另有两套 tone 映射表打架（`surface-data.tsx:329-336`）。
- 改法：扩展 `objectiveListItemV3Schema` 带上 `practiceTrailCount`/`lastCanonicalAt`/`review.dueAt`；行上给**显式状态 tag**（色 + 文字 + 图标，不靠圆点）；答完一张卡后该行状态 tag 立即变化（含「今日已作答」）；统一 tone 映射为一张表。
- 验收：作答一张卡返回列表，不点进去就能看出哪张刚答过、结果如何、下次何时复习。
- **已落地（2026-09-21）**：
  1. 数据侧不需要新查询——`objectiveListItemV3Schema` 只是**没把已经装配好的事实带出来**（列表 DTO 是 `toObjectiveListItemV3(surface)` 的投影，而 `batchAssembleObjectiveSurfacesV3` 本来就一次查好 `practiceTrailCount / lastCanonicalAt / review.dueAt / initialValidation`）。列表契约新增 `progress`（这五个字段，`idle` 映射成 `null` 而不是把服务端内部枚举透给客户端），投影同步补齐，并由新的 `learning-objectives/list-item-projection.test.ts` 钉住——防止以后又被"顺手精简"回去。
  2. 行改为 tag 行（复用 `.v3-objective-tags` / `.v3-objective-state--{tone}` 现有样式与 @media 缩放，不新增 CSS）：**状态 chip 带色调图标 + 人话标签 + hover 出解释**，再跟知识形态、`正式答过 · 今天` / `练过 N 次`、`复习 5 天后`；看过答案的卡直接写 `9月21日 22:30 后才能正式答`。旧实现把这三件事挤成一行 8px 灰字，且 `unvalidated/archived/superseded` 共用一个灰点。
  3. 相对日期由 `formatObjectiveDay()` 统一（今天 / 昨天 / 明天 / N 天后 / N 天前 / 月日），同样不走 `Intl`，理由见 #9 第 5 条。
  4. 列表页**此前没有任何组件测试**，新增 `WorkspaceLibrarySurface.rows.test.tsx`（3 条：状态词是人话且不露 `unvalidated`；答过的卡在行上看得见；冷却时间点渲染成本地日期而非 ISO 串）。写这条测试时踩到一个真实陷阱：焦点卡片与列表行渲染同一个状态标签，按文本全局查会撞重，所以断言只读 `.v3-goal-row` 的 `textContent`。
  5. 服务端筛选/搜索仍按 #4 的结论推迟：现在行的信息密度已经够回答"哪张刚答过"，`limit: 60` 之外由「继续读取」兜住。

#### #14 `[体验]` 文案对普通用户不友好

- 重灾区（`WorkspaceLibrarySurface.tsx` 为主）：`:392` 每一条可验证的理解 / `:423` 目标口袋 / `:630` 证据口袋 / `:599` 理解足迹 / `:587` 现在最值得做 / `:214` 等待首次验证开放 / `:213` 不会改变正式理解状态 / `:201` 链路已核对·旧链路待复核 / `:205` 主要依据·补充依据 / `:648` 保留来源快照 / `:640` 来源血缘缺失 / `:619-624` 目标修订·生命周期版本·学习卡修订·发布修订 / `:654-655` 桌面渲染边界 / `:424` 已载入 X / Y 条；`CardGenerationSurface.tsx:1052-1056` 曝光·证据闭包·首次验证；`room-primary-action-presentation.ts:38,53,66` 资格时间。另有三份重复且互相冲突的标签表（`surface-data.tsx:313-327` 与 `:273-282`、`graph-surface.tsx:93-99`）。
- 改法：建一份状态/动作术语表（单一来源），全站从表取词；内部实现词汇（血缘、闭包、修订、资格、曝光、口袋）一律不出现在用户可见文本里；每个状态词自检「一句话能否向第一次使用者解释」。
- 验收：全站 grep 上述内部词，用户可见字符串命中为 0；状态标签只有一套来源。
- **已落地（2026-09-21，走查范围内的部分）**：状态词与动作词由 `objective-state-copy.ts` 单点提供（见 #9）。此外把这一晚实走过的界面上 **~75 条系统口吻文案**改成人话，覆盖 `CardGenerationSurface`、`learning-run-surface`、`card-generation-status`、`notebook-surface`、`WorkspaceLibrarySurface`、`note-library-surface`、`source-detail-surface`、`source-library-surface`、`ActionRail`。典型改法：
  - 「操作未确认 / 保存未确认 / 激活未确认」→「这次提交没成功 / 保存没成功 / 激活没成功」——「未确认」是这套系统里最典型的内部词，它表达的其实是"没收到成功回音"，用户要的是"成没成"。
  - 「已同步服务端草稿」→「草稿已存好」；「已读取服务端草稿；当前新输入仍待保存」→「已取回草稿；你刚写的还没存上」。**没有把不同状态压成同一句话**：草稿在不在服务器上、本机有没有未保存内容，仍然分开说，否则又变成一个看不懂的状态。
  - 「服务端」作主语的地方基本换成「后台」或直接省掉主语（「正在准备下一步。」）。
  - `ActionRail` 里那批"尚未接入桌面合同"的说明改成「这一版还没接上…」——它面对的是真实用户点了一个还没有功能的入口，不该读到路由/合同/投影。
- **还剩**：`settings-surface.tsx`（23 条，且此刻有别的 agent 在改这个文件，未代为修改）、`ReviewSurface.tsx`（9）、`companion-center-surface.tsx`（6）、`home-v2`（5）等，按同一口径继续扫。当前渲染层用户可见串里仍命中内部词的约 50 行（扫描脚本见本仓库历史提交记录里的一次性统计，未落盘）。
- **收口（同一晚稍后）**：上面"还剩"的四个文件也扫完了（settings 23 条含 `requireOwner`/`capability 投影`/`收口` 这类代码名直接进文案的、companion-center 6 条、ReviewSurface 9 条、home-v2 的"服务端确认/真实投影"若干，外加 `search-surface` 里那条还在用旧词「待验证」的说明、`graph-surface` 截断提示、`hud-pages`、`HotspotLayer`、`SourceIntake`、`source-segments`）。按同一份扫描脚本复核：**渲染层用户可见字符串里命中内部词的行数从 149 降到 0**（脚本是内联跑的一次性统计，不落盘）。改法上守住两条：
  - 不把不同状态压成同一句话。「草稿已存好 / 已取回草稿；你刚写的还没存上 / 这次提交没成功」是三个不同的事实，原来分别是"已同步服务端草稿 / 已读取服务端草稿；当前新输入仍待保存 / 提交未确认"，一一对照改，不合并。
  - 涉及同意与数据外发的披露语句（"消息内容可能离开这台电脑，交给服务器处理"）只换词不换信息量，不软化。
  - 断言被改动文案打挂的地方逐条改断言（`ReviewSurface`、`graph-surface`、`card-generation-status`、`CardGenerationSurface`×2、`notebook-surface`×2 等），没有为了绿而放宽匹配。

#### #15 `[体验]` 编辑页没有生成配置/版本历史，也回不到详情

- 根因：`notebook-surface.tsx:255` 一个组件两种 mode（`read | edit`，`:265`）。read 分支渲染 `编辑这篇笔记`（`:1094`）、`查看关联来源`（`:1098`）、**版本历史** 开关（`:1101-1112` → `:917-960`，含 `恢复这一版` `:944`）、**生成设置** 开关（`:1103-1123` → `:964-1086`）。edit 分支（`editChrome` `:1135-1199`、`editPageActions` `:1256-1272`）只有 `只读查看`、工具栏、`插入图片`、`立即保存` —— **没有**任何触达 `historyOpen` / `optionsOpen` 的入口，尽管这两个 state 就在同一个组件里。回详情页只有全局 pill `返回笔记库`（`:365-373`，`App.tsx:172` 的 `HudReturn`）。
- 改法：edit 模式补上「版本历史」「生成设置」两个入口（复用已存在 state）；「查看这篇笔记」的显式返回控件加进 editor head；`components/surfaces/SurfaceReturnControl.tsx` 目前只被 `WorkspaceLibrarySurface.tsx:66` 用过，可在此复用。
- 验收：编辑态能看版本历史、能改生成设置、能一步回到详情。
- **已落地（2026-09-21）**：把两个面板从 `readPageBody` 里提出来成 `historyAndOptionsPapers`，把两个开关提出来成 `versionAndOptionsToggles`，阅读页与编辑页各引用同一份（不复制第二份 JSX，否则下一次改设置又要改两处）。编辑态的动作行因此是 立即保存 / 重试保存 / 版本历史 / 生成设置 / 生成学习卡。
  - 「回到详情」没有新增按钮：编辑页钉在纸面顶部的 chrome 里本来就有一个 `只读查看`，它就是回详情；再放一个是重复。
  - 编辑态打开版本历史时，`恢复这一版` 仍被按钮自己的 `dirty` 判断挡住（原有逻辑），所以不会把未提交的草稿冲掉。
  - 测试：`notebook-surface.generation-options.test.tsx` 增加一条，直接以 `mode: "edit"` 进入并展开两个面板。
  - 落地过程中的一个真实教训：用脚本把 178 行 JSX 往上搬时，插入点算错，`const` 落进了 `onEditorKeyDown` 的函数体里——**TS 只报 "Cannot find name"，不报"你放错了作用域"**，因为放进去之后语法仍然平衡。靠 typecheck 发现，但真正救回来的是搬完立刻读了一遍原函数。

#### #16 `[体验]` 笔记库最左侧大卡片点主体没反应

- 根因：`note-library-surface.tsx:516` 的 `<section class="current-note">` 没有 onClick，可点的只有 `h2 > button.note-open`（`:519`）、`全部笔记`（`:543`）、`继续写`（`:550`）；预览段落 `.serif`（`:533`）、`.rule`、meta（`:534-541`）全是死的。对比右侧四张封面卡（`:559-570`）整张就是 `<button>`。
- 改法：整个 section 走 `openNote`（`:211-215`）语义——用覆盖式按钮或把 section 提升为 button，保留内部子按钮各自的 stopPropagation 行为与键盘可达性。
- 验收：点击大卡片任意空白区域都能进详情；Tab + Enter 行为不变。
- **已落地（2026-09-21）**：卡片里铺一层覆盖整卡的透明按钮 `.current-note__open`（可访问名「打开笔记：<标题>」），标题里的 `button.note-open` 退化为纯文本，避免同一目标两个按钮。选覆盖层而不是把 `<section>` 变成 button，是因为卡里还有「全部笔记」「新建」「继续写」三个真按钮，button 不能嵌套 button；覆盖层排在第一个子元素，后面两个绝对定位动作区按 DOM 绘制顺序落在它之上，所以照常可点。hover/焦点给卡片内侧描一圈。
- **待活应用复核**：上面那句"绘制顺序保证按钮不被盖住"是按 CSS 位置规则推的，jsdom 不跑 CSS，所以测试只能证明两个处理器互相独立（`note-library-surface.test.tsx` 新增一条），证不了视觉层不吞点击。

#### #17 `[体验]` 笔记库卡片希望展示正文首图

- 根因：笔记正文是 block 而不是 markdown：`note_blocks {ordinal, type, content}`，`type` 含 `"image"`（`apps/api/src/modules/note/schema.ts:5,15`），图片块的 `content` 就是一行 `![alt](url)`（`note-blocks.ts:20,36,43-47,153`）。来源派生的 URL 是内部 `/api/uploads/{objectKey}`（`notebook-surface.tsx:1380-1384`）；编辑器粘贴的图片有 `note_image_assets`（`sha256` + `thumbnail_object_key`，`migrations/0046_*.sql:23-40`），且 `note_blocks.image_asset_id` 已存在（`:52-55`）。**但列表接口什么都不带**：`listNotes` 只 select `id,title,titleSource,createdAt,updatedAt,deletedAt,currentVersionId,workspaceId,createdBy`（`note/service.ts:721-743`），渲染契约同样没有 `sourceId`/blocks（`packages/shared/src/desktop-surface-contracts.ts:140-155`）。目前唯一的取图逻辑是客户端在已加载详情上做（`notebook-surface.tsx:423-437`）。
- 改法：服务端为列表补一次「首图」投影——按 `currentVersionId` 上 `type='image'` 的最小 ordinal 取，优先用已有 `thumbnail_object_key`；一次批量 join，不给每行发单独请求。若走客户端则需对每行 `note.get`，明确否决。顺带修：`previewOf`（`:750-755`）→ `noteBodyText`（`surface-data.tsx:255-266`）直接 join 原始 content，导致 `![alt](url)` 泄漏进摘要行。
- 验收：有图笔记的卡片显示首图缩略图；摘要行不再出现 markdown 图片语法。
- **已落地（2026-09-21）**：
  1. `listNotes` 增加一次批量首图投影 `firstImageBlockByVersion`：按本页 `currentVersionId` 用 `inArray` 一次查 `note_blocks` 里 `type='image'` 的块，`ORDER BY version_id, ordinal, id` 后在内存里每版取第一块。走的是已有的 `note_blocks_version_idx`，不给每行发请求。
  2. 列表 DTO 加 `firstImageBlock: string | null`，**内容是那一行原文 `![alt](url)`**：解析规则全仓库只留渲染层一份，服务端不再写第二个 markdown 图片解析器（`lib/markdown-image.ts` 那个是抽 objectKey 做清理用的，语义不同，没拿来当显示用解析器）。
  3. 渲染层 `NoteCoverPhoto`：走正文图片同一条字节通道与同一份 blob 缓存（`useSourceImage`），取不到或还在读就**不画**——纯色书皮不是坏状态，摆灰块反而像出错。CSS 把照片铺在书皮底下（`object-fit: cover` + 底部渐变压深），并把 `h3` 显式 `position:relative; z-index:1` 抬起来，否则静态元素会被定位层盖住。
  4. 摘要泄漏修在 `noteBodyText`：图片块只取 `alt`，没有 alt 就是空串，`![...]` 不再进预览。
  5. `parseImageBlock` 从 `note-blocks.ts` 搬到 `surface-data.tsx`：`note-blocks` 本来就依赖 `surface-data` 的 `noteBlockText`，反向引用会形成循环依赖，而这两个函数是同一族（"存的东西怎么变成给人看的"）。同步改了 3 处 import 与测试归属。
  6. 书架**主卡**（那张"纸"）不画封面图，只有右边四格书皮画；测试要按这个事实摆数据（主卡取的是列表第一条）。
  7. 测试：`note-service-db-extra.test.ts` 一条（每版只取 ordinal 最小的块、无图的显式 null）、`note-library-surface.test.tsx` 一条（站内相对地址必须被换成 blob src 才能上屏）。
- **待活应用复核**：封面照片与书皮文字/书脊线的层次与可读性（`object-fit`、渐变量、`small` 的对比度）只按 CSS 规则推过，没看过真实渲染。

#### #18 `[体验]` 来源资料目录状态不反映「已生成笔记」

- 根因：那一列只有解析状态 `SourceStatus`（`packages/shared/src/enums.ts:2-9`：draft/processing/ready/failed/archived，标签表 `surface-data.tsx:273-292`，tabs `source-index.ts:164-201`，chip `source-library-surface.tsx:374-379`）。笔记关联只是第二行小字 `关联 N 篇笔记 / 尚未建立笔记`（`source-library-surface.tsx:371`），来自服务端算好的 `noteCount`（`source/service.ts:231-255`，类型见 `desktop-surface-contracts.ts:25`）。来源行上**没有任何**卡片生成状态字段。
- 改法：把「已生成笔记」做成可辨识的状态（独立 chip 或 tab 筛选项），而不是靠第二行文字；来源行增补「学习卡：无 / 待审核 / N 张已激活」，数据在 `cardGenerationRuns` / `learningObjectives` 上按 sourceId 聚合即可。
- 验收：来源目录一眼能区分「解析完但没成笔记」「已出笔记」「笔记已出卡」。
- **已落地（2026-09-21，做了一半，另两半要看）**：`noteCount` 服务端早就算好，此前被塞在小字第四段（`关联 N 篇笔记 / 尚未建立笔记`）。改成状态列里的第二枚 chip：`已生成 2 篇笔记`（green）/ `还没生成笔记`（默认色），并从行首那句里删掉，同一件事不说两遍。新增 `source-library-surface.rows.test.tsx`（该 surface 此前零测试）。
- **有意没做**：「笔记已出卡」这一档还需要来源行上有卡片生成状态（`cardGenerationRuns` / `learningObjectives` 按 sourceId 聚合）——那是又一次列表投影扩展，且用户第 18 条原话只到"生成了笔记就改变状态"。加筛选项「还没出笔记」同理留下次。

---

## 3. 批次与验证

| 批次 | 内容 | 为什么先做 |
|---|---|---|
| **A 生成链路正确性** | #3 题型失效、#5 重复生成与旧卡不废弃、#2 假进度、#10 提示改为卡片自带、#1 保留即排队（D1） | 全在 `api/card-generation-v2` + `ai-worker` + `desktop-gateway`，必须跑真实生成才能验，一起跑一次生成可覆盖全部断言 |
| **B 作答会话** | #8 语音卡死、#6 打分等待、#9 待验证与 24h 锁、#11 单提示按钮、#12 两按钮、#13 秒表（D2） | 集中在 `learning-runs` + `learning-run-surface.tsx`，改完需实走一张卡的完整作答 |
| **C 列表 / 笔记 / 来源 UI 与文案** | #4 跳转筛选、#7 状态 tag、#14 文案、#15 编辑页入口、#16 卡片可点、#17 首图、#18 来源状态 | 纯展示层与少量列表投影扩展，风险最低、体感提升最直接，放最后统一做一遍视觉核对 |

每批验证方式（按既有工作方式）：

1. 受影响模块的类型检查与测试；
2. 批次 A 对同一篇笔记跑真实生成（含关闭 LLM 的兜底路径各一次），核对 strategy 分布、stage 推进、二次生成的 supersede；
3. 桌面客户端已在 `--remote-debugging-port=9222` 上运行，UI 类改动写 `apps/desktop-client/scripts/` 下的临时 CDP 探针，用 `getBoundingClientRect` / `getComputedStyle` 量真实渲染并截图确认，而不是只读样式表推断；改完复跑对比，收尾删除探针脚本与 `.impeccable/` 产物；
4. 交付说明里列出删除的旧链路（按 AGENTS.md：`skip_task` / `end` 双轨、`加入待激活` 勾选链路、`cardGenerationStage` 兜底分支等直接删除，不留兼容层）。

## 3.5 实施进度（滚动更新）

| 条目 | 状态 | 说明 |
|---|---|---|
| #3 题型、#5 重复生成/旧卡、#2 假进度、#10 提示来源、#1 保留即排队 | 真实生成已跑通（#2 的阶梯仍待长笔记复测） | 批次 A；§7 那次真跑实测：题型 3 种零 recall、8 条提示全非空且张张不同、2 张被门禁判失败且界面说得出。**顺带修掉在制守卫的一处漏洞**（`.limit(1)` 任取一行判死活 → 新旧两批 review_ready 并存），见 §7 |
| 审核卡面两处文案缺陷 | 代码完成 | §7：「还有 N 张未决」改成整批口径的「N 张还没决定」；卡面 `front.cue` 不再占用「提示」这个词，改标「线索」。先补 2 条断言（改前红）再改，活应用复测过 |
| #12 退出按钮、#11 提示阶梯、#13 计时 | 代码完成 | 批次 B 部分；见下节 |
| #8 语音作答 | 代码完成 | 见 §3.6：语音输入从无到有 + 真能力探测 + 切换可回转 |
| #6 提交后的评估反馈 | 代码完成 | 见下节「#6」；等结果这一跳只跑真实 critic 一次验收 |
| #9 待验证与 24h 锁 | 代码完成 | 见 §2 #9「已落地」：优先级纠正 + 一套状态词五处共用；活应用与真实 HTTP 都已验证（§5） |
| #4 跳转筛选 / 列表空白 | 代码完成 | 见 §2 #4「已落地」；服务端筛选有意推迟到与 #7 同一条查询一起改 |
| #7 列表状态 tag | 代码完成 | 见 §2 #7「已落地」：列表 DTO 补 `progress` + 行改 tag + 列表页首次有组件测试；活应用已量行高/tag/窄窗（§5） |
| #16 大卡片可点 | 代码完成 | 见 §2 #16「已落地」；活应用已实测：点卡片主体跳转 08，两个内部按钮未被覆盖层吃掉（§5） |
| #15 编辑页入口 | 代码完成 | 见 §2 #15「已落地」：两个面板与两个开关提到阅读/编辑共用的位置 |
| #17 书皮首图 | 代码完成 | 见 §2 #17「已落地」；活应用已实测首图与文字层次（§5），并与 Postgres 对账 |
| #14 全站文案 | 代码完成 | 见 §2 #14「已落地」：渲染层用户可见串里内部词命中 149 → 0 |
| #18 来源「已生成笔记」 | 代码完成（一半） | 见 §2 #18「已落地」；「笔记已出卡」那一档有意留下次 |

### 批次 B 已落地部分（#11 / #12 / #13 / #6）

- **#13（决策 D2）**：新增 `useLocalActiveClock` —— 本地 1 秒一跳；服务端读数**只在更大时**抬高本地值，绝不倒退；失焦/隐藏时与 activity lease 同规则停走，避免本地钟与服务端甩开；撤掉进度条与上限展示（`.learning-run-clock__track` 三处 CSS 一并删除）；到 `FOCUS_SESSION_LIMIT_SECONDS = 3600` 自动派发退出动作并**绕过确认**（那一刻可能没人看着），`autoEndedRef` 保证只发一次。
  - 边界事实：契约里 `activeSecondsUsed` 上限是 180 秒（服务端只按专注租约计时），所以「满 60 分钟」**只能**由本地秒表判断；服务端 180 秒预算的计分语义未动。
- **#12**：active 阶段的退出动作提升进快捷区，不再落在折叠菜单里；`skip_task` 整条链路删除（V1/V2 动作联合类型、run-routes 签发匹配、run-service 分支、界面 wire 映射与标签、metrics 注释），原契约测试改成**断言被拒绝**——陈旧客户端不能静默把「无痕跳过」当合法动作送进来；`end` 仍是 paused / checkpoint / recoverable_error / assessing / committing / preparing 的唯一出口。
- **#11**：`request_hint` 一律由那**一个**阶梯按钮代表（`moreActions` 显式排除该 kind）；提示状态按层级累积、两级同框按序展示，文案在「给我一点提示 → 再看一层提示 → 提示已经给完（禁用）」之间切换；`resultingTrustCeiling: "practice_only"` 不再被客户端丢弃。
- **#6（提交后等结果）**：
  1. **让等待不再由轮询节奏决定**：`run-processing-tick.ts` 新增 `setLearningRunProcessingWaker` / `wakeLearningRunProcessing`，`server.ts` 的循环把 10 秒 `setInterval` 改成可重排的 `scheduleProcessingTick(delayMs)`——喊一声即清定时器立刻跑下一轮；若那一轮正在执行中无法重排，则置 `processingWakeRequested`，本轮结束立刻续跑。10 秒轮询退化成兜底（进程重启、漏喊、失败退避时仍自愈）。调用点两处：提交路由与通用动作路由（`retry_assessment` / `retry_commit` / `retry_prepare` 都在这条链上重新入队），**都在事务外**调用，否则唤醒的那轮看不到刚提交的 outbox 行。通用动作路由不按 action 类型枚举清单——多喊一轮只是一条 `FOR UPDATE SKIP LOCKED` 的空 claim，而清单会随 service 新增入队分支失真。
  2. **看得见自己答了什么**：提交后界面换成只读的评估面板，把刚交上去的答案原样引用出来（`answerPreview`，文本/语音/选项各有形态），而不是只剩一行小字。
  3. **等得明白**：spinner + 「已等待 N 秒」本地秒表（复用 #13 的逐秒 hook，评估态不读服务端）；预算耗尽的口气从失败改成「结果还在服务端处理，会自动回到这一页」，并提供显式重试（`retry_assessment` 由服务端签发，客户端不自造）。
  4. **不能再交一次**：`canAnswerNow` 收敛编辑器渲染条件（`phase === "active"` 且非评估中），评估期间输入框与提交按钮都不存在——答案已在服务端锁定，重复提交只会撞 409。这是新测试里钉住的那条不变量。


### 作答界面补上了测试（决定：先补测试再改剩下几项）

`learning-run-surface.actions.test.tsx`：一套 gateway / SSE / 草稿 stub（`learningRun.get/getDraft/saveDraft/submit/action/getResult/revealTarget/getReturnContract/recordActivityLease` + `subscriptions` + `navigation` + `capabilities`），5 条用例：

1. 退出只有两个且都在明面上 —— `getByRole` 查不到折叠 `details` 里的按钮，这条断言本身就是「藏在菜单里」的检测器；
2. 提示只有一个按钮：点一次放一层、文案切换、到顶禁用，服务端只收到两次 `request_hint`；
3. 专注时间逐秒推进；**更小的服务端读数不能把钟拨回去**，更大的才校准；进度条不存在；
4. 满 60 分钟自动结束：只发一次退出动作、不弹确认框；
5. 看过提示当场说明计分降级。

搭建过程中这套测试立刻抓到两个真问题：(a) 第一版只把「下一个」提示放进快捷区，第二级仍作为独立按钮残留；(b) 秒表 hook 被放在 `if (!snapshot) return null` 之后，React 直接报 hook 顺序变化。两处都是测试暴露后才修掉的，不是读代码读出来的。

## 3.6 #8 重查后的结论（比原始报告更严重）
### #8 语音作答（已实施）

1. **把语音输入真正做出来**：新增 `surfaces/run-voice-input.tsx`，替掉那段写死的「当前设备没有可用的语音输入」。流程是 点开始 → 点说完（或到点自动收尾）→ 转写（`transcribeRecording`：本地 SenseVoice 优先，云 `companion.voice.transcribe` 兜底）→ 转写文本落在**可编辑**的框里 → 按 `{kind:"voice", confirmedTranscript, voiceArtifactRef}` 提交。刻意不用伴星那套 VAD 自动收尾：复述中途停顿是正常节奏。太短（<0.2s）、没录到声音、转写失败各有各自的文案。
   - 录音器内部有 60 秒硬上限且会**自行停止**。UI 必须跟着收尾，否则用户以为还在录、点「说完了」只拿回 null 并被误报成"没录到声音"。现在 `seconds >= min(maxSeconds, 60)` 自动转写，合同里 120 秒与录音器 60 秒的不一致因此对用户不可见（文案诚实显示单段上限）。
2. **真能力探测**：新增 `components/voice-capability.ts`。旧检查是恒真式（只判断 IPC 通道名在不在静态常量集合里，永远"可用"）。新探测用 `enumerateDevices()` 区分四种情况并各给一句话原因：无录音 API / 一个输入设备都没有 / 有设备但 label 全空（= 权限未授予）/ 启动失败。**不调 `getUserMedia` 做探测** —— 那会真开麦克风（系统亮橙灯），用隐私副作用换一个提示不值得。窗口重新获得焦点时自动重探，用户在系统设置里授权后回来不需要重开这一题。
3. **不藏入口，给原因**：语音替代项在麦克风不可用时**保留但禁用**，旁边写明「现在还不能改用语音作答：<原因>」。直接藏起来会让用户以为根本没有这个能力，也不知道自己少了什么。
4. **切换不再是单程票**：`run-service.ts` 的 `switch_variant` 原先把被换下的 variant 置为 `superseded`，而 `run-view.ts` 的备选只列 `standby`，于是切过去就再也回不来（只能靠跳过/退出脱身）。改为退回 `standby`。提交安全不受影响 —— `submitArtifact` 只接受 `status = 'active'` 的 variant，FOR UPDATE 行锁也照旧挡住 stale-submit 竞态。
5. 测试：`learning-run-surface.actions.test.tsx` 增加一条 —— 没有可用麦克风时语音切换按钮存在、被禁用、且原因可见（jsdom 无 `navigator.mediaDevices`，探测结论是"不支持录音"，正好覆盖这条路径）。


- 原始报告：没有麦克风 → 切换后卡死、无法回到文本、缺前置检测。
- 实况：`learning-run-surface.tsx` 的 `InteractionEditor` 对 `voice_teachback` **只渲染一段"当前设备没有可用的语音输入"的阻塞文案，整个界面没有任何录音组件**（`voice` payload 类型与 `emptyEditor` 分支存在，但没有人往里填）。也就是说「换一种方式 → 语音作答」对**所有**用户都是死路，跟有没有麦克风无关；原始报告只是这条死路的一个偶发入口。
- 另外 `run-planner.ts:258` 允许 `responsePreference === "voice"` 时把语音直接作为主 variant，那种情况下用户不点任何按钮也会落进死路。
- 因此这不是"补个前置检测"能了结的，需要选一条路：

| 方案 | 内容 | 代价 |
|---|---|---|
| A. 补齐语音作答 | 复用已有 `CompanionVoiceRecorder`（含 `isSupported()` 与 getUserMedia）+ 现成的 `companionVoiceTranscribe` 通道，在本界面实现录音→转写→确认→提交；同时做切换前的能力探测与不可用原因提示 | 一个完整交互特性的工作量 |
| B. 先不供给不起的模态 | 本 build 没有录音能力时**根本不签发**语音替代项（`switch_variant` 不下发，语音也不能成为主 variant），切换不可用时给出原因；死路从"必然"变成"不存在" | 小；但语音作答继续缺席 |

两条都必须一起做的：主进程/渲染层的真能力探测（`enumerateDevices` 的 audioinput + 麦克风权限态），以及"已切走后能回到文本"——目前切换会把原 variant 翻成 `superseded` 且 `availableAlternatives` 只列 `standby`（`run-service.ts:1820-1824`、`run-view.ts:262-269`），结构上没有回头路。

## 4. 两条会影响验证的环境事实（2026-09-20 记录）

1. **AI 调用有计费限额**：调试期先用确定性路径跑通逻辑（单测、关掉 LLM 的兜底 provider、typecheck），真实生成留到一批改动收尾时**只跑一次**并同时覆盖 #3/#2/#5 的断言，不要每改一次就调模型。
2. **`@ailearn/shared` 对消费方是 pnpm 安装期快照**：`pnpm install` 不会因源码变化重新拷贝（"Already up to date"）。`apps/api` 与 `workers/ai-worker` 已用 tsconfig `paths` 指向实时源码（2026-09-15 的修复，见 `apps/api/tsconfig.json:16-20` 注释），**`apps/desktop-client` 没有**——它仍读快照，所以对 `packages/shared` 的契约改动在 desktop client 的 typecheck / 打包里默认不可见。本批用「按内容比对、原地覆写三份快照」临时同步了解除阻塞；正解是给 desktop-client 补 `paths`（typecheck）+ vite alias（运行时），属独立的基建改动，需要单独确认后再做。

另：`workers/ai-worker` 当前 typecheck 报错来自并行进行中的伴星改动（`companion-agent-runtime.test.ts` 新增的「坍缩闸 holdUntilChars」用例未对 `AgentTurnResult.content`（`string | null`）收窄），与本批次无关，未代为修改。

## 4.1 批次 B 收尾时的仓库状态（2026-09-21 00:15 记录）

- 本批次验证结果：`packages/shared` 312/312、`apps/api` 1396（1395 pass / 1 skip / 0 fail）+ typecheck 干净、`apps/desktop-client` 1006/1011 pass + renderer typecheck 只剩下述他人文件。
- **剩余 5 条失败与 3 条 typecheck 报错全部属于并行的「AI 数据同意」改动**（`desktop-ipc-contracts.ts` 删掉 `canManage` / `workspaceId`，`settings-surface.tsx`、`desktop-gateway.test.ts` 仍在迁移中）。我未代为修改。为让 renderer 看到最新的 `@ailearn/shared` 契约，本轮把 `packages/shared/src` 用 `rsync -a --delete` 同步进 `apps/desktop-client` 的 pnpm 快照（§4 第 2 条的既有做法），这也是那批报错此刻才在 desktop 侧显形的原因——它们与快照新旧无关，重新 `pnpm install` 一样会显形。
- 顺手修掉一条与批次无关的**测试自身缺陷**：`surface-data.test.tsx` 用"多少小时前"断言「昨天 / 前天」这类日历词，凌晨 00:00–02:00 之间必然红。改为 `vi.setSystemTime` 钉在正午。
- 顺手清掉 `room-projection-contracts.ts` 里与 `objectivePersonalStateV3Schema` 重复的 10 值内联枚举（合同注释本身就要求"直接展示服务端签发的值"，重复定义正是词汇漂移的入口）。

## 4.2 此刻仓库里的"红"（01:55 复核，不是本批次改的）

- 并行的伴星改动正在把 `agent.tool` 扩成一个 skill 体系：`packages/shared/src/companion-conversation-contracts.ts` 引用了 `companionAgentSkillEventV1Schema`、`companion-agent-registry.ts` 引用了 `companionAgentSkillManifestV1Schema`，而 `companion-agent-contracts.ts` 里这两个导出**还不存在**。
- 连带结果：`apps/desktop-client` 的 main 侧测试（6 个文件、11 条，全是 `undefined.parse`）、`apps/api` 与 `workers/ai-worker` 的 typecheck 目前是红的。因为 desktop 读的是 pnpm 安装期快照（§4 第 2 条），我把快照按实时源码镜像过，所以他们的中间状态同步显形——**这不是快照坏了，是源码本身在这一刻不自洽**。
- 我没有替他们补这个重命名。本批次自己的范围重新跑过：api `learning-objectives` + `learning-runs` + `card-generation-v2` 共 308/308 通过，desktop renderer 876/876 通过。
- 另记一条实测到的测试基础设施噪声：一次并发跑 500 个 api 测试文件时出现过 12 条"文件级失败、无输出"，单跑与重跑全绿 —— 是并发资源竞争下子进程被压掉，不是断言失败。看结果时以复跑为准。

## 5. 活应用与真实 HTTP 实测（2026-09-21 02:15）

前面所有"代码完成"的条目里，界面那半一直没看过真实渲染。这次把 dev 客户端连 CDP（:9222）量了一遍，并用真实登录态直接打 API 与 Postgres 对账。

**HTTP + DB 对账（api 容器 healthy，未依赖 LLM）**
- `GET /v2/learning-objectives?limit=60`：10 条全带 `progress`；动作分布 `resume_run 5 / create_review_run 2 / create_run 2 / practice_only 1`；那条 `practice_only` 实返回 `label=带着参考答案练一下`、`formalValidationNotBefore=2026-09-21T08:43:49.772Z`。
- `GET /notes?limit=100`：9 条里 2 条带 `firstImageBlock`；与 Postgres `distinct on (version_id) … order by ordinal asc` 的结果逐条对上（ordinal 22 与 18 两块，URL 前缀一致）—— 首图取的是**真·第一块**，不是随便一块。

**CDP 量到的界面（一次点进真实数据）**
- #16：`.current-note__open` 覆盖 582×654，卡片中心 `elementFromPoint` 命中该按钮；在卡片上部 50%/28% 处真鼠标点下去，页面从 07 跳到 08「笔记详情」；同时 `新建笔记` / `继续写` 两处中心点 `elementFromPoint` 仍是按钮自身（`coveredByOverlay: false`）——**覆盖层不吃按钮，之前只能靠 CSS 绘制顺序推断的那条现在是有数的**。
- #17：2 张书皮有 `.book-cover__photo`（203×315 铺满），`.book-cover h3` 的中心点命中的是 `h3` 本身 → 文字没被照片盖住（`z-index` 那步起作用了）。
- #7：目标库 10 行，行 621×92 无裁切，tag 行 511×20；900×600 窄窗下 tag 收成 231×14 仍不裁切。筛选器与概览数字实读为 `全部10 / 要处理4 / 进行中5 / 答对过1`，两处同一张表。
- #9：详情动作区实读「现在最值得做 / 开始首次验证 / 这张卡还没有一次正式作答。答一次才知道你到底会不会。/ 开始首次验证，完成后会写回这一题的真实状态。」；足迹第一行「首次验证 · 现在就能正式答」。列表里看过答案的那张卡整行是「还没正式答过 / 应用规则 / 9月21日 16:43 后才能正式答 / 带着参考答案练一下」——**这就是 #9 的验收句，且是实测文本**。
- #18：来源行实读「已就绪 / 已生成 1 篇笔记」「已就绪 / 还没生成笔记」。
- #14：首页入口实读「今天的主目标已经定下」（原「等待服务端确认主目标」）。

**量出来才看到的两个问题，已改**
1. `复习 11 天前` 被读成"11 天前复习过"（chip 本意是"下次复习"）。改成 `复习已到期 N 天` / `今天复习` / `复习 N 天后` / 超过 30 天才给日期；补了断言，并在活应用里复测为 `复习已到期 20 天`。
2. 追踪脚本 `scripts/verify-cardgen-flow.mjs:46` 仍点 `.note-open`——#16 之后书架主卡上这个类名已经不存在，脚本会在书架视图里超时。

**那一次真实生成的尝试（02:24）**：按 §4 第 1 条的约定只跑一次，走 HTTP + Postgres 对账。
- 已经验到：**#5 的 `supersedes_run_id` 真的写进去了** —— 新 run 指向上一次 activated 的 `596b3537`（这一列此前生产代码从不写入）；**#5 的在制守卫** 对同一篇笔记再发起返回 `409 note_generation_in_flight`，消息是人话（「这篇笔记已经有一批学习卡在生成或等待审核，请先处理完那一批」）。这两条都不花模型。
- 顺带拿到 #3/#10 的**改动前基线**：那篇笔记的旧 run 在库里就是 `题型=recall`（一批 4 张全同一型）且 `带提示=0`，正是用户报的现象。
- 没验到的：阶段推进到 review_ready、新批的题型分布、真正由作者产出的提示。原因是 **worker 此刻被并行的伴星改动打进 crash loop**（`ERR_PACKAGE_PATH_NOT_EXPORTED`），run 一直停在 `planning` —— **模型一次都没被调用，配额没花**。我把这条孤儿 run 取消了（`cancelled`），没有把工作区留在在制状态。
- 补一条脚本自身的事实：`scripts/verify-cardgen-flow.mjs:46` 仍点 `.note-open`——#16 之后书架主卡上这个类名已经不存在，脚本会在书架视图里超时；已改成 `.current-note__open:visible, .note-open:visible`。
**第二次尝试（02:42，worker 已恢复）拿到了确定原因，但不是模型的问题。** run 起来后 planner 阶段每次 0–1ms 失败，日志只给 `category: unknown`；真正的错误落在 `card_generation_runs_v2.error_message`：

> `card-generation-v2/v22/planner: Workspace policy forbids sending data to external AI providers (sendToExternal=false). Owner must enable this in workspace settings.`

即 **数据外发同意闸门**挡住了（`user_ai_settings.data_policy.sendToExternal = false`，owner 这一行就是 false）。这条闸门是并行进行中的「AI 数据同意」改动的一部分，行为本身是对的——它没有让未同意的外发溜过去，所以 **#2/#3/#10 的这一次真实生成被合规地挡住了，模型一次都没调用，没有产生费用**。
- **设置页里那个开关是打开的**（「允许发送到外部模型服务」aria-checked=true），但生成仍被拒 —— 查下来是并行的同意迁移只落了一半：`0237_user_ai_settings.sql` 把同意从工作区迁到账号并**删掉 workspaces 上那四列**，而 `workers/ai-worker/src/lib/governance.ts:347/372` 还在读 `ws.aiDataPolicy`。列已不存在 → `normalizeWorkspaceAIPolicy(undefined)` 回落到 `DEFAULT_AI_DATA_POLICY.sendToExternal = false` → **所有工作区的所有非 mock 调用一律被拒**（伴星同理）。这就是为什么 provider 侧 0ms 失败、模型一次没调。
- 结论：#2/#3/#10 的那一次真实生成现在**卡在别人的半成品迁移上**，翻同意位、重跑脚本都没用，得先把 worker 的 policy 读取改到 `user_ai_settings`（并且按 0237 注释的提醒，读它必须走 `withWorkspaceTransaction`，否则 RLS 会静默返回 0 行，表现成"永远没同意"）。我没有替他们改这块。
- 顺带量到 `user_ai_settings` 全部 852 行的 `updated_at` 都是 `2026-09-20 16:00:31`（621 行为 true、231 行为 false）——像是一次性回填，回填是谁做的、按什么规则分 true/false，值得负责该功能的人确认。
- 孤儿 run 自己收敛在 `needs_attention` + `error_code=generation_failed`，没有继续重放，我不需要额外取消；但要注意 `needs_attention` 属于在制名单，这篇笔记在被处理掉之前会一直被在制守卫挡着。
- **仍然待跑**（同一条脚本，等同意位打开）：轮询 `planning → authoring → checking → review_ready` 的**逐步**变化（#2，含 `progress.candidates` 从 0 往上走）、新批候选的 `presentation_draft->>'strategy'` 是否真的铺开多种（#3）、以及 `hints->>'level1'/'level2'` 非空且不是兜底常量（#10）。（含 `verify-cardgen-flow.mjs` 那条主线）。worker 现在 healthy，跑它的前提是先把上面那个脚本的入口修好；`OPENAI_COMPAT_API_KEY` 的配额约束照 §4 第 1 条，只跑一次。

## 6. 07:05 复核：唯一剩下的红，正是挡住那一次真实生成的东西

四个半小时后再看，本批次自己的范围全绿，仓库里只剩一处不自洽，而且它比"运行时不一致"更硬 —— 编译期就断。

| 范围 | typecheck | 测试 |
|---|---|---|
| `packages/shared` | 干净 | 328/328 |
| `apps/api` | 干净 | 1394（1393 pass / 1 skip / 0 fail） |
| `apps/desktop-client`（web + node 两个 project） | 干净 | 1028/1028 |
| `workers/ai-worker` | **4 条错误，全在一个文件** | 未跑（同文件编译不过） |

- 错误位置：`workers/ai-worker/src/lib/governance.ts:347 / 350 / 372` —— `Property 'aiDataPolicy' / 'aiConsentVersion' / 'aiConsentAt' does not exist on type '{ name; id; createdAt; workspaceType; ownerId }'`。同意迁到账号级（0237）之后 `workspaces` 行类型里这三样已经不存在，worker 这一路还在按老地方读。
- 运行时后果与 02:42 实测一致：`normalizeWorkspaceAIPolicy(undefined)` → `DEFAULT_AI_DATA_POLICY.sendToExternal = false` → 所有非 mock 调用在发出请求前就被拒（`elapsedMs: 0`、`category unknown`）。api 侧已经改读 `user_ai_settings`（`identity/service.ts`、`identity/invite-service.ts`），worker 侧还没有对应读取。
- 结论：#2/#3/#10 那一次真实生成的验收**只卡在这半截迁移**，与配额、与 v22 prompt 无关。接手时要注意 0237 注释里的坑：读 `user_ai_settings` 必须走 `withWorkspaceTransaction`，否则 RLS 静默返回 0 行，又会变成"永远没同意"。

## 7. 08:40 那一次真实生成终于跑通了

治理改到账号级、并把它挪出管道事务（方案 A）之后，挡了几小时的那道墙消失了。

**先确认治理解析（不花模型）**
- `workers/ai-worker`：typecheck 干净，测试 673/673。
- 在 worker 容器里实调 `resolveAIGovernanceContext(97550966…, f6c4a80e…)` → `consentOk=true`、`sendToExternal=true`、`provider=openai_compatible`、`embeddingProvider=siliconflow`。
- 一条踩坑记录：同一句脚本在**宿主**上跑会给出 `provider=mock` + 「agent_turn 平台未配置」告警，看着像 bug。实际是宿主没带 `AI_PLATFORMS_CONFIG`（容器里是 `/app/config/ai-platforms.json`）。测治理要在容器里测。

**第一次真跑（00:10，笔记 97df7ac9）：终态 `no_cards_recommended`，判定是对的**
`pipeline.route.standard` 给出 `evidenceCount=0 / sourceTextLength=0 / reasons=[non_text_block]`；查库这篇笔记 `content_json` 里只有 1 个块、`type=code`。没有正文就没有可学分目标，planner 这么报没问题（1 次 planner 调用，`ai_audit_log` 00:10:10 可对上）。
- 留一条**产品问题**（未改）：整篇只有代码块的笔记点「生成学习卡」，用户看到的是"不推荐出卡"，拿不到"因为这篇没有正文"这句话。

**第二次真跑（00:21，笔记 f01c70ec《消防疏散与灭火器使用》，6 个文本块，此前挂着两条 `generation_failed` 死批次）**
- 中途被并行改动打断过一次：00:22:38 `companion-agent-runtime.ts` 变化 → tsx watch 杀掉在跑的 job，而 job 仍占着 30 分钟租约挂在 `processing`。我把这条 job 手动回队（`status=pending, lease_token=NULL`）后一分钟内跑完。**并行改动会真金白银地打断生成，这不只是日志噪音。**
- 终态 `review_ready`，真实调用 **11 次** `card_generation_v2:chat_completion`（00:21:41 planner，00:23:42–00:24:22 十次），模型 `qwen3.8-flash`。
- **#5 死批次能重新生成**：同一篇笔记挂着 needs_attention 死批次，POST 没返回 409，批次建起来了。
- **#3 题型真的铺开**（库与界面双向对上）：`sequence 2 / application 1 / boundary 1`，零 recall；界面「题型」实读 `顺序重建 / 情境应用 / 边界判断 / 顺序重建`。
- **#10 提示确实由作者产出**：4 张 8 条 `hints.level1/level2` 全非空、张张不同（sequence 卡「回忆这四个字在物理操作上分别对应什么动作对象…」／boundary 卡「思考在极端危险下，什么价值高于物质财富」）。不是常量表。
- **门禁在真拒东西**：2 张 `quality_state=failed`，事件给了原因码 `front_leaks_answer`、`grounding_hard`；界面「质量状态」实读「质量检查未通过」；`activation-service.ts:396` 只允许 passed 进激活。
- **#2 只验到"计数是真数"**：`progress` 实返回 `{plannedCards:4, authored:4, gatePassed:2, gateFailed:2}`，四个数自洽（4=4、2+2=4）。但这次整条管道 <1 分钟，HTTP 3 秒采样只抓到 `planning → review_ready` 两个值，**中间阶梯没被观测到**；`card_generation_events_v2` 的时间戳是同事务 `now()`（全 23:35），也还原不出阶段时序。这条仍算"机制对、现场没看到"，要看到阶梯得换一篇长笔记再跑一次。
- 顺手纠正我脚本里的两个错断言：`progress` 的字段是 `plannedCards/authored/gatePassed/gateFailed`，**没有 `candidates`**；run 详情里也**没有 `currentStage`**。

**界面实测抓到两条真实缺陷，已改（按惯例先补测试）**
1. 「候选 1/4 · 还有 4 张未决」——停在最后一张仍写"还有 4 张"。这个数是**整批**未决数，"还有"把它读成了"这张之后还剩几张"。改成 `N 张还没决定`。
2. 卡面 `front.cue` 的标签占用了「提示」这个词（实测渲染成「提示灭火器使用口诀"提、拔、握、压"」），而系统现在**真有**两级提示，两者混用会让人以为已经给了提示。改成「线索」。
- 新增 2 条断言在 `CardGenerationSurface.review.test.tsx`（改前红、改后绿）；desktop 127 files / 1033 tests 全绿，`tsconfig.web` typecheck 干净；活应用复测实读「候选 1 / 4 · 4 张还没决定」「线索高层建筑火灾逃生路径选择」。

**还抓到一条我自己写的守卫的漏洞（阻断级，已修）**
在制守卫原先 `.limit(1)` 只取**一行**判死活，而这一行是 Postgres 任意给的。同一篇笔记既有已死批次、又有一批还没审完时，只要先摸到已死那行就放行 —— 结果新旧两批 `review_ready` 并存。这次真实数据就是证据：`f01c70ec` 上 `dcc809e2`（09-18，4 张）和 `e87dc46f`（09-21，4 张）都在，`superseded=0`。
改成遍历**全部**在制行，只要有一行还活着就挡住；补断言「在审的旧批次和已死的批次并存时，仍然算在制」（改前 `Missing expected rejection`）。`apps/api` 1404 tests / 0 fail。
- 存量没动：那两条并存的 review_ready 批次仍在库里。修完之后新发起会被挡，但已存在的两批要有人处理（关一批或各自审完）。
- 遗留的 5 条 `needs_attention` + `generation_failed`（eb35b1eb / 5589acf6 / 6b32745e / ed5c9084 / 926788f1）我没有强行清理：按我自己的判据，它们正是"retry 拒、cancel 也拒、只剩重新生成"那一类，deadBatch 这条豁免就是为它们存在的。

**此刻仓库里唯一不自洽的地方（不是本批次改的）**
`apps/api/src/modules/note/document-state.ts` 是并行 agent 的**未跟踪新文件**（`git status` = `??`），`npx tsc` 在它上报 3 组错（`Uint8Array` 不能赋给 `Buffer`、`PgColumn + number`）。api 测试不受影响（1403 pass / 0 fail），但 `apps/api` 的 typecheck 现在因它不干净——我只改了 `card-generation-v2/generation-run-service.ts` 和它的测试，报错文件列表里只有这一个。

## 7.1 #6 的线上实证（补 §3.5 里挂着的最后一跳）

真卡 `5c8ae1f4`（run 406b213c 那批）→ 文本作答 → 走真 `assessment_critic`：
`learning_assessments.source=assessment_critic / status=completed`，api 日志
`critic verdicts=3 … write-back done`，`rubric_results` 三条反馈**全部非空且各自指出一处缺失**：

- `recall → missing | 未提及语言模型生成语义token这一步骤`
- `recall → missing | 未提及流匹配模块还原声学细节这一步骤`
- `recall → missing | 未提及声码器输出波形这一步骤`

答案是我故意写偏的（只讲基础声学模型/继续预训练/对齐器），三条判 missing 是对的，
所以这不是"总能拿到一句泛泛反馈"，而是**判分内容与作答内容对得上**。
（另记一次自己的错：脚本轮询 120 秒就报了 `pending`，实际判分在那之后立刻完成——
读结果要用库里的终态，别信一次轮询窗口。）

至此 18 条里最后一处"只有单测、没在线上验过"补齐。

## 7.2 提示框竖排字（用户截图，2026-09-21 已修）

用户实机截图里，要过提示之后左侧那块黄油提示纸上的字是**一列竖排单字**，
右侧大片空白，底部「只计练习分」那句还被纸边裁掉。

根因不在文字，在网格自动排布：`.learning-run-hint` 是 `auto minmax(0, 1fr)` 两列网格
（图标占第一列），而提示层 `<ol>` 与「看过提示之后…只计练习分」那句是**并列的两个网格项**。
第三项被自动放进第二行**第一列**，那一列是 `auto`，按它的 max-content 撑满整块面板 →
正文列（`minmax(0, 1fr)` 的最小值是 0）被压到十几像素，于是每个字各占一行。

改法：正文与那句说明一起包进 `.learning-run-hint__body`，网格恒定两个子项，第三行内容
再怎么加也挤不到正文列（顺带修掉纸边裁字——正文不再有二十几行高）。

钉法：`learning-run-surface.actions.test.tsx` 新增一条断言"面板的直接子项恰好两个、
说明在正文容器里"。jsdom 不跑 CSS，所以这条钉的是 CSS 依赖的那个结构不变量，
**改前红**（`expected 2, received 3`）——正是这次真机上发生的事。真机视觉复核仍待做。

