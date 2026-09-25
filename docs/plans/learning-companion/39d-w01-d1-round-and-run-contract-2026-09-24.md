# D1 · 轮次与运行的关系合同

> 日期：2026-09-24
>
> 状态：**W0-1 交付的设计件（39d §5）。本文件不写产品代码、不改数据库、不改产品合同。**
>
> 它是什么：39 §15.3 第 17 条那三个"必须先落定"的问题的答案，写成 W3–W7 调用方可以直接引用的形状——含实体职责、状态转换、数据约束与逐条处置结论。
>
> 谁在用它：W3-4（无卡目标进冻结/评估链）、W3-1/W3-3（公共运行基础的调用方形状）、W4-2/W4-3/W4-4/W4-5（笔记页主动作、轻量定向、一致快照、轮次状态机）、W5-4（单次提醒落在一轮上）、W7-x（跨轮聚合与调度）。**这些任务不得自行发明第二套轮次语义**；发现本文件不够用时回来改本文件，不在任务里就地扩。
>
> 依据：39 §3.2、§3.4、§4.2–4.3、§5.5、§10.3、§15.2、§15.3-1/-17、§17；坐标实测于提交 `e7cea900` + 干净树。

---

## 0. 一句话结论

**一轮笔记学习不是 `learning_runs` 的一个 goal，也不是与它平行的第二套状态机：它是 `learning_runs` 的外层容器。**

- **轮次**（round）承载：身份、归属、本轮问题、计划与修订、实际路径、暂停恢复、终态、跨轮聚合的归属点。
- **`learning_runs` 不动**：它仍然是"一道题从冻结到提交"的那台单任务机器——锁答、暴露、评估、提交、唯一调度写入，语义一字不改。
- 两者的关系是**一对多且单向**：一轮里跑若干个 LearningRun；LearningRun 不认识轮次以外的东西，只知道自己的 origin 多了一种。

这条分工同时满足 39 §15.1 那一行（"复用合适的单目标任务内核，扩展来自笔记的目标来源 | 整篇旅程不受单次 180 秒限制；**不把教学全过程塞进旧单题状态机**"）与 §2.1 的警告（不许长出第三套并行状态机）。

---

## 1. 三条硬边界：实测坐标与逐条处置

| # | 硬边界 | 实测坐标（提交 `e7cea900`） | 现值 | **处置** |
| --- | --- | --- | --- | --- |
| ① | 单次时长预算 30..180 秒 | `packages/shared/src/learning-run-contracts.ts:355`（`timeBudgetSeconds: number; // 30..180，默认 180`）、`:358`（`planningClosesAtActiveSecond: 150`）、`:756`（`requestedTimeBudgetSeconds?: number; // 服务端 clamp 30..180`）、`:1428` 与 `:1595` 两处 `z.number().int().min(30).max(180)` | 墙在 schema 上，服务端 clamp | **对轮次：不适用。对 LearningRun：原样保留。** 见 §4.1 |
| ② | 五值 goal 枚举 | `:331`、`:755`、`:1397`、`:1594`（`"stabilize" \| "clarify" \| "repair" \| "transfer" \| "explore"`） | 描述"这一道题想干嘛" | **对轮次：不适用。对 LearningRun：原样保留。** 见 §4.2 |
| ③ | 冻结链要求 active Objective ＋ active Card | `apps/api/src/modules/card-generation-v2/target-snapshot-adapter.ts:370-417`：先 workspace-scoped 查 `learning_objectives_v2.lifecycle = 'active'`（查不到 `objective_not_found_or_inactive`），再查 `learning_cards_v2.lifecycle = 'active'`（查不到 `card_not_found_or_inactive`，注释写明"禁静默用 revision 1"），两处均 fail closed | 无卡 = 无法进入正式教学与观察 | **扩展**（不是废弃，也不是照旧）：Objective 仍是硬前置，**Card 从必备降为可选**。见 §4.3 与 §3.5 |

**处置结论一句话**：前两条是"单题微旅程"的合同，笔记旅程**不继承**它们，所以既不需要放宽也不需要绕开；第三条是真正要动的，而且改动量比预期小——**表已经准备好了，卡住的是适配器代码**（见 §4.3 的第一行）。

---

## 2. 实体与职责

原则（39 §15.2）：下面是**职责划分**，不是要求逐行新建表；技术设计可以复用现有实体。

| 实体 | 承载 | **不承载** | 现状 |
| --- | --- | --- | --- |
| **学习线** `note_learning_journey`（新） | 每 `(workspaceId, userId, noteId)` 一条，持久。承载：完整路线的范围与纳入/未纳入清单、未解决缺口、跨轮聚合的归属点、持续授权与"暂不安排"的引用点 | 单题锁答状态、模型执行进度、任何"当前正在做什么" | 无。可由 `notes` 侧按需创建，**不为每篇笔记预建空行**（与 39 §8.5"保存第一张卡才建可见组"同一个取向） |
| **轮次** `note_learning_round`（新） | 一次可恢复活动。承载：本轮问题（自由文本 + 可选用例引用）、计划与修订历史、实际路径、内容快照引用、暂停/恢复点、终态与终态原因 | 聚合出来的能力结论（那是投影）、日程（唯一调度的事） | 无 |
| `learning_runs`（复用，**不改**） | 单任务的冻结→作答锁定→评估→提交→调度交接 | 跨多题的活动；"本轮问题"；跨轮聚合 | 已有 190 条（`origin.kind`：card 170 / review 20） |
| `learning_objectives_v2`（复用） | 目标及其修订、rubric、canonical answer | 是否"值得学"（那是教学决策） | 208 条（active 194 / archived 10 / superseded 4） |
| `learning_target_snapshots_v2`（复用） | 冻结输入 | — | **`card_id` / `card_revision` 本来就是可空列**（见 §4.3） |
| `learning_exposures_v2`（复用） | 跨入口暴露事实 | — | `card_id` / `card_revision` 可空；`objective_id` / `objective_revision` 必填（44 行） |

**轮次与学习线的关系**：轮次属于学习线；学习线**不**缓存轮次的派生状态——"这轮学到哪了""还有哪些缺口"都从轮次与观察现算（39 §15.2 末句："星图、首页、卡组数和笔记状态是投影，不成为新事实源"）。

---

## 3. 逐条回答 39 §15.3-17

### 3.1 一轮的身份与归属

- **身份**：`roundId`（uuid）唯一标识一轮。轮次**不复用** `learning_runs.id`，也不复用 `learning_runs.revision`：两者是两个不同粒度的版本号，混用会让"改一轮的计划"看起来像"改了一道题的答案"。
- **归属**：`(workspaceId, userId, noteId)`。归属三件套是不可变的；轮次被"取代"时新建一条，不迁移归属。
- **并发约束（数据层，不是 UI 约定）**：同一 `(workspaceId, userId, noteId)` 至多一条 `phase IN ('active','paused')` 的轮次。用**部分唯一索引**表达，不靠应用层先查后写。
  - 这条直接实现 39 §3.2 的"同一用户在同一工作区、同一笔记默认只有一个进行中或暂停的笔记旅程"。
  - 需要另开一轮时，旧轮必须先落到终态（`superseded`），新轮才建得出来——即"明确封存旧轮并新建，不能静默覆盖"由索引兜住。
- **多端**：轮次是服务端的，不是本机的。两个窗口看到同一条轮次与同一个 `revision`；首次提交（首个作答锁定）只有一次成功（CAS on `revision` + `runtimeEpoch`，复用 LearningRun 既有形状），另一份草稿保留并提示冲突（39 §16.39）。

### 3.2 时长与预算

- **没有 30..180 的墙。** 轮次的时长由"本轮约定的活动"决定，不设倒计时、不把停留时间当考核（39 §3.3 末句）。§4.1 说明为什么这不是"把 180 放宽成 3600"，而是**根本不适用**。
- 但**必须有界**（39 §6.2："自动扩展受每轮时间/调用预算约束"）。轮次预算三件，缺一不可：

  | 预算项 | 形状 | 触顶时的行为（39 §6.2） |
  | --- | --- | --- |
  | `maxModelCalls` | 非负整数 | 保留已完成内容，说明可继续阅读/稍后再试/结束；**不把资源限制说成用户能力不足** |
  | `maxWallClockSeconds` | 非负整数 | 同上 |
  | `maxTasks` | 非负整数 | 本轮不再自动加题（与 39 §5.3 的"连续两次帮助后仍没有改善"是两个独立刹车，都要有） |

- **默认值不在本文件定**：本文件只钉"必须有三项、必须有界、触顶行为是什么"。具体数值属于 39 §18.4 的试用前冻结项（与等待时间预算同批），W4-5 实施时以当时的冻结值为准。
- 单次 LearningRun 的 `timeBudgetSeconds`（30..180）**继续有效**：它管的是"一道题从准备到提交"的墙，与"一轮学习"不是同一件事。轮次里的一道题仍然有它自己的 180 秒上限——这是特性，不是遗漏。
- **模型预算与业务提交分开限额**（39 §15.3-16）：`maxModelCalls` 耗尽只停模型调用；已经拿到的评估报告、已经提交的作答、待重试的业务提交**不受它阻断**（39 §8.7 末段）。

### 3.3 暂停与恢复

轮次的 `phase` 只有三个值，刻度刻意粗：

| phase | 含义 | 进入条件 | 退出 |
| --- | --- | --- | --- |
| `active` | 有过实际教学活动，且当前可以继续 | 首次进入教学/回忆/作答（仅打开推荐页不算，39 §5.5 末段） | 关闭窗口且**没有其他活跃端** → `paused`；走完或用户收尾 → `closed` |
| `paused` | 可恢复暂停 | 39 §5.5："没有其他活跃端时标记可恢复暂停，**不新增轮次**" | 用户回来 → `active`（`resumedAt` 记账）；用户收尾 → `closed` |
| `closed` | 终态，只读 | 见下方 `outcome` | — |

- **关闭一个窗口不暂停另一个仍活跃的窗口**（39 §3.2）：`paused` 由"最后一个活跃端也离开"触发，不由任意一端离开触发。
- **`closed` 之后不可恢复**。"继续学习"只恢复 `active`/`paused`（39 §3.2）；昨天已经收尾的轮次**保留未解决问题**作为下一轮的起点，但**不会重新打开原轮**（39 §16.39）。
- 终态原因与结果分开记（39 §5.5 的表）：

  | `outcome` | 含义 | 与"能力"的关系 |
  | --- | --- | --- |
  | `completed` | 走完本轮约定的活动，或已有证据满足本轮目标 | **不是**对整篇能力的认证（39 §5.5 末段） |
  | `partial` | 用户在计划未结束时主动收尾 | 已做目标分别结算；未做目标不产生完成事实 |
  | `superseded` | 被主动重开或被内容变化取代 | 旧回答不覆盖；旧轮次只读 |
  | `system_failure` | 连续系统故障 | 允许结束为"部分完成／系统未能判断"，**不作为"不会"的终态** |

- **评分待返回不是终态**：用户提交后可以直接收尾，轮次进 `closed(outcome=completed|partial)`；迟到的判定作为**带时间的补充回执**挂回原轮，不重开、不改写当时结算、不重播奖励（39 §5.5、§16.19）。若判定最终失败，明确补充失败结果，**不能永久显示处理中**。
- 三个命令**互不代替**（39 §5.5 末段，W5-1 的交付门槛）：「先到这里」（结束活动，默认让已受理评估跑完）、「停止本次评估」（该任务不再产生有效判定与调度依据）、「撤销未来复习授权」（停订，不删除已保留的观察）。
  - **数据约束**：这三个是三个不同的 action，落在轮次/LearningRun/调度三处，**不许合成一个"结束"**。轮次的 `closed` 不蕴含后两者；LearningRun 的 `ended` 不蕴含轮次关闭。

### 3.4 跨轮聚合

- **聚合键**：`(workspaceId, userId, objectiveId, objectiveRevision, dimension)`。首期与 39 §4.2 对齐：**默认去重范围＝同工作区、同笔记、同一可确认的目标及能力维度**；跨笔记仅有相似关系时分别记录，不自动抵扣（39 §4.2 末段、§16.17）。
- **聚合是投影，不是事实源**：轮次与学习线都**不存**"某目标当前掌握度"这类字段。要展示时从观察与证据现算（39 §15.2："星图、首页、卡组数和笔记状态是投影"）。
  - 这条是为了防"同一件事存两份、其中一份忘了更新"这一类已经在本仓库反复出现过的缺陷。
- **跨轮推进完整路线**（39 §4.4）：学习线持有"纳入的核心问题"清单与每个问题的覆盖状态（覆盖状态本身仍由证据现算，学习线只持有**清单与范围**）。判"已走完这份核心路线"的条件见 39 §4.4，本文件不重述。
- **内容新增不制造债务**：笔记实质修改后，"原路线已完成，有新内容可学"——新增内容**不自动变成到期义务**（39 §4.4 末段、§16.23）。

### 3.5 无卡目标的来源、资格、公开题面与评分依据如何进冻结/评估链

这是 §15.3-17 里唯一需要动代码的一条，逐段给出形状。

**（a）来源。** 目标不再只能由制卡管线生产。

| 来源 | 现状 | 扩展后 |
| --- | --- | --- |
| 制卡 V2 管线 | 唯一来源 | 保留 |
| 笔记轮次 | 无 | **新增**：轮次在计划阶段提出的目标，经保留动作落成正式目标 |

- 已有的 `learning_objective_origins_v2` **已经带 note 溯源**（实测：`origin_kind` 全为 `note`，22 行全部带 `note_id`）。无卡目标的溯源沿用同一张表，不新建事实类别；需要确认的是 `origin_kind` 是否需要新增取值来区分"由轮次提出"与"由制卡提出"——**倾向不新增**：`origin_kind='note'` + `note_version_id` 已经足够表达，区分留给轮次侧的引用。
- **目标不必先有卡**（39 §4.2）：`learning_objectives_v2` 与卡的关联本来就是可选的；要改的是"创建路径"和"冻结前置"，不是数据模型。

**（b）资格（谁能进教学内容与观察）。** 首期只有两类内容可以形成可观察目标（39 §4.2 正例）：

1. 需要观察表现的内容（"区分两个概念""说明某个因果环节""在给定条件下作出选择"）；
2. 需要长期回访的内容。

**不可形成正式目标**的（39 §4.1、§14.3）：已标"待核对"的可疑主张——它可以讨论、可以回顾，但**不能成为标准答案、正式能力判定或可开启复习的卡片依据**（§16.26）。

**（c）公开题面。** 完全复用：`LearningTaskPublicV1` 已经是通用形状，不含卡片假设。要求在**呈现之前**就固定目标、题面、评分条件与初始证据资格（39 §4.3 末段）——这一条是 LearningRun 现有合同，原样继承。

**（d）评分依据。** 完全复用：评分依据挂在 objective revision 的 `scoringRubric` / `canonicalAnswer`，随 `learning_target_snapshots_v2` 冻结。**无卡不改变评分链。**

**（e）冻结链的连接点。** 见 §4.3 —— `freezeTargetSnapshotV2` 的卡前置是唯一要改的地方，改动量比预期小。

**（f）暴露链的连接点。** `learning_exposures_v2` 的 `objective_id` / `objective_revision` 必填、`card_id` / `card_revision` **可空**（实测 44 行，列可空）。所以无卡目标的暴露记录**零 schema 变更**即可写入，与 39b §9.7 的结论一致。

---

## 4. 三条边界的处置：逐条展开

### 4.1 边界①（30..180 秒）：**对轮次不适用，对 LearningRun 保留**

- **为什么不适用，而不是"放宽"**：放宽会把"一轮学习"和"一道题"变成同一个量纲，于是每一步都要回答"这 3600 秒里哪些属于哪道题"，而 §15.3-17 要的正是这个问题的反面。
- **改法**：`note_learning_round` 不引用 `timeBudgetSeconds`，改用 §3.2 的三项预算。`learning_runs` 的 30..180 与 `planningClosesAtActiveSecond: 150` 一个字不改，W3-5 的迁移也不得为轮次动它。
- **红线**：不许为了让轮次"跑得久"去改 `learning-run-contracts.ts` 的 min/max。若将来某条真实链路确实需要更长的单题预算，那是一次**独立的**、带读数的决定，不在本文件授权范围内。

### 4.2 边界②（五值 goal）：**对轮次不适用，对 LearningRun 保留**

- **为什么保留**：五值描述的是"这一道题想干嘛"（稳定/澄清/修补/迁移/探索），它服务的是单题的准备与题目选择；实测 190 条 run 正在用（`origin.kind` 为 card/review），没有废弃的理由。
- **轮次的本轮问题不复用这个枚举**：39 §3.3 的"本轮问题"是一句可以被用户改写、可以被否定、可以从结构另选的**自然语言问题**（"判断为什么有索引，查询仍然可能慢"）。把它压成 5 个值就丢掉了"可改写"这一条产品要求。轮次的形状：

  ```
  drivingQuestion: { text: string, source: "suggested" | "user_rewritten" | "user_authored", revision: number }
  ```
  加可选的 `scopeRefs`（引用到的 note 块/目标/选区），**不加**枚举 goal。
- **轮次内部某一道题的 goal 仍取五值**：由轮次的教学决策在**创建 LearningRun 时**决定（39 §3.3"我完全不熟" → `clarify`；"先让我试一下" → `explore` 等）。映射规则属于 W4-3 的教学决策，本文件只钉"映射发生在创建 LearningRun 那一刻，并且写进 `LearningRunOriginV1`"。

### 4.3 边界③（active Objective ＋ active Card）：**扩展**

三条实测事实改变了这条的处置成本：

1. **`learning_target_snapshots_v2.card_id` 与 `card_revision` 本来就是可空列**（`packages/shared/src/db-schema/card-generation-v2.ts:501,503`，没有 `.notNull()`）。表不需要动。
2. **`learning_exposures_v2.card_id` / `card_revision` 可空**，`objective_id` / `objective_revision` 必填。暴露链不需要动。
3. 卡住的是**适配器代码**：`target-snapshot-adapter.ts` 的第二步"active Card（查不到 fail closed）"。

**扩展后的冻结规则**（替换现有第二步）：

| 情况 | active Card | 依据来源要求 | 结果 |
| --- | --- | --- | --- |
| 有卡（现状） | 有 | 现状不变 | 照旧冻结 |
| 无卡，有笔记依据（新） | 无 | evidence bindings **必须全部**指向该 objective revision 冻结的笔记内容（经 `note_version_id`），且非空 | 冻结，`card_id = NULL`、`card_revision = NULL` |
| 无卡，也无笔记依据 | 无 | 空 | **fail closed**（`target_evidence_missing`）：不允许"既没卡也没依据"的空快照 |

**必须一并钉住的三条约束：**

- `active Objective` 依然**必需且 fail closed**，一个字不放宽。无卡 ≠ 无目标：轮次提出的目标必须先经保留动作落成正式目标（§3.5a），才有资格进冻结链。**不许用临时前端状态或假卡绕过**（39 §17 交付门槛原话）。
- `cardContentEpoch` 是 `notNull`（`card-generation-v2.ts:499`）：无卡路径必须给它一个**确定且有语义**的值（用 objective 的 lifecycle epoch 派生，不用 0 蒙混），否则"卡内容变过没有"这个比较就会静默失真。
- 冻结前仍要核对 objective 的 `lifecycle = 'active'` 与目标修订未变（现状语义）；无卡路径不降低这一检查。

> **实现记录（2026-09-25，39d W3-4 第一步）**：上表三分支已落在 `apps/api/src/modules/card-generation-v2/target-snapshot-adapter.ts`（evidence closure 提到卡判定之前，新函数 `requireNoteBackedEvidence`），有卡那一条行为逐字未变。
> **一处字面偏离记下**：原文写「evidence bindings 必须全部指向该 objective revision 冻结的笔记内容（经 `note_version_id`）」——实测 **`evidence_snapshots_v2` 上没有 `note_version_id`**（只有可空的 `note_id`），版本锚唯一存在 `learning_objective_origins_v2` 的 note 来源行上。因此实现成两条：**该修订有笔记版本锚** ＋ **每条依据的 `note_id` 都等于那篇笔记**。这比原文更严不更松（原文那条字面判据读不通）；要改判据前先读这两张表。
> **仍未做**：下面这一档 `note_round` origin 需要 W4 的轮次实体才有 `roundId` 可填，本步未加（`run-view.ts` 与渲染层 `returnTargetLabel` 对新 kind 都会当场报错，那是加它时的护栏）。

**新增的 origin**：`LearningRunOriginV1` 增加一种（现有 5 种不动）：

```ts
| { kind: "note_round"; roundId: string; noteId: string; objectiveId?: string }
```

`learning_runs.origin` 是 jsonb、`return_target` 同形状 —— **零 schema 变更**。`returnTarget` 对应增加 `{ kind: "note_round"; roundId: string; noteId: string }`，用于"回轮次"和"回笔记"的落点。

---

## 5. 状态转换（可引用的转移表）

### 5.1 轮次

| 当前 | 事件 | 下一 | 附带写入 | 禁止 |
| --- | --- | --- | --- | --- |
| （无） | 开始学习（且已有正文快照） | `active` | 本轮问题、计划 v1、内容快照引用、预算三项 | 保存/一致读取失败时**不建轮次**（39 §3.4 末段） |
| （无） | 只打开推荐页就取消 | （不建轮次） | — | 不计为一次学习轮次（39 §5.5 末段） |
| `active` | 用户关闭窗口，且无其他活跃端 | `paused` | `pausedAt` | 其他窗口仍活跃时不得暂停 |
| `active`/`paused` | 用户收尾 / 走完约定活动 | `closed` | `outcome`、收获与未做清单 | 不得顺手写"整篇掌握" |
| `active`/`paused` | 用户主动重开 | `closed(superseded)` + 新轮 `active` | 旧轮只读 | 不得覆盖旧轮的回答 |
| `active`/`paused` | 内容实质修改且用户选择按当前内容继续 | `closed(superseded)` + 新轮 | 保留未变目标的适用记录 | 不得静默搬迁 |
| `active`/`paused` | 连续系统故障 | `closed(system_failure)` | 提供可用材料与恢复入口 | 不得记为"不会" |
| `closed` | 任何 | — | 只读；迟到判定作为补充回执挂回本轮的**子记录** | 不得重新打开（39 §16.39） |

### 5.2 轮次内的一次 LearningRun（现有合同，摘录备查，不改）

`preparing → active → assessing → checkpoint → committing →（completed | ended | skipped | cancelled | stale | recoverable_error）`，`paused` 可从中途进入（`learning-run-contracts.ts:341-353`，12 值）。轮次侧的三个 phase **不与之同构**，也不做逐值映射——两者粒度不同（§7 的第 2 条反例检验）。

---

## 6. 数据约束（实施时的最小集合）

1. **部分唯一索引**：`note_learning_round (workspace_id, user_id, note_id) WHERE phase IN ('active','paused')` —— 唯一。
2. **归属不可变**：`workspace_id` / `user_id` / `note_id` 建后不改；需要换笔记 = 新建轮次。
3. **`revision` 单调递增**：轮次的状态与计划修订共用一个 `revision`（与 LearningRun 同形状），所有写动作走 CAS。
4. **快照引用不可变**：轮次只**引用**内容快照（`note_version_id` 或冻结正文＋引用摘录＋哈希，形状由 D3/W0-3 定），不内联正文副本。
5. **RLS**：与 `learning_runs` 同形状（workspace + user）；**轮次与学习线都不给 `ailearn_worker` 开跨租户读**，除非确有一条 worker 侧读需求——到那时按 39b §14 的规矩在集测里钉"换 user 什么都读不到"。
6. **不建空行**：不为笔记预建学习线；学习线在第一次产生轮次时创建（39 §8.5 的取向一致）。
7. **轮次不存聚合结论**：见 §3.4。任何"当前掌握度/亮度/百分比"字段都不许加在这两张表上。

---

## 7. 反例检验：为什么不会长出第三套状态机（39 §2.1 的警告）

按"如果我们这样做会怎样"逐条验，三条路都堵死：

1. **把轮次做成 `learning_runs.goal = "journey"`。** 会撞 ①（30..180 的墙写死在 `z.number().int().min(30).max(180)`，要绕就得放宽全局 clamp，影响 190 条现有 run）与 ②（五值枚举要加第六个值，而它描述的不是同一件事）；还会撞 12 值 phase 与 `checkpoint` 的单题语义。**否决。**
2. **轮次另建一张表，但复制一套 phase 枚举 + 一套作答/评估状态。** 这就是第三套状态机本身：`preparing/assessing/committing` 会在两处各有一份，某天必然分叉。**否决**：轮次只允许三个值（§3.3），且它与 LearningRun 之间**不做逐值映射**——判断依据是"有没有活跃的 LearningRun 与未消费的待处理"，不是枚举对齐。
3. **不做轮次，用多个 LearningRun 拼出一轮。** 会丢掉"本轮问题""计划与修订""本轮之外的未涉及清单""跨轮聚合的归属点"；39 §3.3 的"可改写的一句话"和 §4.3 的"计划调整保留理由与版本"就没有落点。**否决。**

**正面判据**（一条就能查）：轮次表上**没有** `assessing` / `committing` / `checkpoint` 这类值，也**没有**任何指向模型的执行进度字段。谁想加，谁就先把本文件改了。

---

## 8. 迁移顺序与删除清单

- **零 schema 删除**。本轮涉及的表改动只有两张新表 + 一个部分唯一索引；`learning_target_snapshots_v2` 与 `learning_exposures_v2` 不动（§4.3 的三条实测）。
- **代码侧改动点（交给后续任务，不在本文件实施）**：
  1. `target-snapshot-adapter.ts` 的第二步卡前置 → §4.3 的三分支规则（W3-4）。
  2. `LearningRunOriginV1` / `LearningRunReturnTargetV1` 各加一种 kind（W3-4）。
  3. `run-service.ts` 的 origin 处理分支加 `note_round`（W3-4）。核对方式：全仓搜 `origin.kind` 的 switch/if 分支，逐个补；漏一个的症状是创建 run 时报未知 origin。
  4. 轮次与学习线的读写模块（W4-5）。
- **删除清单**：**本文件不授权删除任何现有链路**。特别是 `origin.kind` 的 card/review 两种、五值 goal、30..180 clamp **都保留**——它们在旧入口下仍是正确的合同。等 W7 切换完调用方、按 AGENTS.md 核对无调用方之后再谈删。
- **数据库**：新增迁移按仓库规矩登记 journal；集成测试若新增，同时登记 `ci.yml` 点名列（接入 ≠ 会被跑，见 39d §5.1）。

---

## 9. 未决项与落点

| 未决项 | 为什么本文件不定 | 落点 |
| --- | --- | --- |
| 轮次三项预算的默认值 | 属试用前冻结项，不能凭设计拍 | 39 §18.4；W4-5 实施时以当时冻结值为准 |
| `note_learning_journey` 是否真需要独立表（而非由轮次的归属键聚合出来） | 取决于"完整路线范围"是否需要跨轮持久化；W4-4/W4-5 会给出真实读写形状 | W4-5 开工时回头改本文件 §2 |
| 多端首次提交冲突的具体 CAS 字段组合 | 现有 LearningRun 已有 `revision` + `runtimeEpoch` 形状，轮次是否直接复用要等真实实现 | W4-5 |
| `origin_kind` 是否需要区分"轮次提出"与"制卡提出" | 倾向不新增（§3.5a）；真正的判据是 W3-4 落地时的查询需求 | W3-4 |
| 无卡快照的 `cardContentEpoch` 派生规则 | 需要 objective epoch 与卡内容 epoch 的语义对齐核对 | W3-4（与 §4.3 的第三条约束一起） |

---

## 附：本文件用到的实测读数（命令与结果）

```
# 轮次/快照/暴露的表形状
information_schema.columns → learning_target_snapshots_v2: card_id nullable, card_revision nullable,
  card_content_epoch NOT NULL, objective_id/objective_revision NOT NULL
information_schema.columns → learning_exposures_v2: objective_id/objective_revision NOT NULL,
  card_id/card_revision nullable（44 行）

# 目标的既有 note 溯源
learning_objective_origins_v2: origin_kind='note' 22 行，全部带 note_id
learning_objectives_v2: active 194 / archived 10 / superseded 4
learning_runs: origin.kind = card 170 / review 20

# 调度侧的既有混存（供 D2 用，本文件不改它）
review_schedules: 32 行，subject_type 全为 'card'；subject_id 命中 learning_objectives_v2 26 条、
  命中 learning_cards_v2 4 条、两者都不命中 2 条；status pending 21 / cancelled 1 / completed 10；
  28 行带 policy_version
```

> 复算方式：`docker exec ailearn-dev-postgres-1 psql -U ailearn -d ailearn -c "<上列查询>"`。
> 39 §15.3-18 记的"23 条里 19 条为 objective"是更早时刻的读数；本文件记的是 2026-09-24 的现量，两者不矛盾——存量在长。
