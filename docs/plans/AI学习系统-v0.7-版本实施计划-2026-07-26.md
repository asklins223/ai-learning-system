# AI 学习系统 v0.7 版本实施计划：游戏化掌握旅程

> 状态：Superseded（2026-08-07 由 [AI 学习伴侣驱动的多模态理解宇宙](learning-companion-multimodal-understanding-universe.md) 替代：阶段 00 Owner 决策批准采用 AI 学习伴侣驱动的多模态理解宇宙，本 v0.7 游戏化掌握旅程不再并行实施）<br>
> 文档版本：0.4<br>
> 计划日期：2026-07-26<br>
> 目标版本：`v0.7.0`<br>
> 产品阶段：Private Alpha 深化<br>
> 基线版本：`v0.6.0`（尚未发布；当前正式版本仍为 `0.5.0`）<br>
> 基线分支：`v0.6-implementation`（v0.6 主链迁移末端 `0043`；Card Generation v2 已占用 `0044–0049`，分支迁移末端以 M0 冻结为准）<br>
> v0.7 Base SHA：M0 冻结<br>
> v0.7 迁移序列：M0 时点的下一可用编号起（撰写时为 `0050+`）<br>
> 关联决策：ADR-0004、ADR-0006、ADR-0010；本版需新立两份 ADR：「激励派生层与单向数据流边界」（下文暂记 ADR-0011）与「概念聚合切片：候选-确认模型与血缘保护」（下文暂记 ADR-0012），编号以 ADR 索引实际顺延为准<br>
> 候选池来源：[AI 学习系统 v0.7 方向性预期](AI学习系统-v0.7-方向性预期-2026-07-22.md)<br>
> 决策来源：repository owner `@asklins223` 于 2026-07-26 选择主方向「游戏化学习旅程」，并纳入流式交互与学习会话体验重塑为范围内增强，定位为「直接可开发计划」；同日补充决策：星图交互升级与「相同概念跨笔记聚合」切片纳入 Must（详见 0.2）<br>
> 文档 Owner：repository owner `@asklins223`<br>
> 容量假设：单实施流 Must 约 8～10 周，含 Should 约 10～13 周；随后至少 14 日受控观察<br>
> 一句话目标：在不触碰可信判定与调度事实的前提下，把 v0.6 建立的掌握闭环包装成一段有真实进度、即时反馈和持续动力的学习旅程——并把星图从只读展示升级为可探索、可行动、能跨笔记聚合概念的知识宇宙，让「坚持学习」这件事本身变得有趣。

> **重要声明**：本文只定义 v0.7 的目标、边界、依赖和验收门槛，不代表任何条目已经实现，也不授权跳过评审直接修改代码、数据库或发布环境。所有 checkbox 初始均为未完成；已有代码只有在绑定 clean SHA 与验收证据后才能计入完成度。

## 0. 文档治理、基线与版本边界

### 0.1 Canonical 计划

本文件是唯一 canonical v0.7 活动计划，固定路径为：

`docs/plans/AI学习系统-v0.7-版本实施计划-2026-07-26.md`

发现入口为 `docs/plans/README.md`。本文批准后状态从 `Draft` 进入 `Approved`，并另建精简的实施登记册（`v0.7-implementation-register.md`）和证据索引（`docs/evidence/v0.7/`）；不得把逐次实施日志不断堆入本文。

[AI 学习系统 v0.7 方向性预期](AI学习系统-v0.7-方向性预期-2026-07-22.md) 保留为候选池记录：未入选本版的候选能力（自适应题库、Vision、多模型路由、完整反馈闭环、FSRS 转正，以及 Concept Graph 中「相同概念聚合」切片之外的其余能力）继续留在候选池，不因本计划成立而作废，也不自动进入本版范围。

### 0.2 决策依据与治理修订

Repository owner 于 2026-07-26 做出以下决策：

1. **主方向**：v0.7 产品主方向为候选池外新增的「游戏化学习旅程」——以掌握进度系统、每日学习旅程、成就与 streak 激励、会话结算体验为核心，让学习过程本身产生乐趣与动力；
2. **范围内增强**（Should/Could 级）：轻量游戏化激励、流式交互（候选池 2.5）、学习会话体验重塑；
3. **文档定位**：直接可开发计划——弱化对 v0.6 十四日观察数据的立项依赖，批准后即可开发，v0.6 收尾与 v0.7 实施受控并行；
4. **星图升级（同日补充，Must）**：星图从只读血缘展示升级为可操作的知识宇宙（交互导航、行动入口、透镜视图、搜索定位、布局重构），并纳入候选池 2.1 的**单一垂直切片**「相同概念跨笔记聚合」——AI 只提出候选概念与链接，人工确认后生效；完整 Concept Graph 的其余能力（prerequisite/supports/contradicts 关系、学习路径、缺口分析）仍留候选池。

本决策构成对方向性预期第 3 节「v0.6 退出复盘后再选择主方向」规则的**一次性显式 owner 修订**，理由如下，须连同边界一并记入 ADR-0011：

- 游戏化主线不新增任何 AI 判定能力：激励层全部由**确定性规则**从 v0.6 已有可信事件派生，验收门槛不依赖 v0.6 的 AI 质量观察数据即可完整定义；
- 唯一新增的 AI 能力是范围明确的概念聚合切片：其输出**仅为候选**、必须人工确认、不影响掌握态/调度/outcome，携带独立 Gold 集与 RC 门禁（4.3），失败时可通过 flag 整体关闭，边界记入 ADR-0012；
- 激励层与 v0.6 可信掌握主链**单向解耦**（见 3.3），可通过 feature flag 完全隔离，出现问题时关闭 flag 即回到 v0.6 体验；
- v0.6 观察数据仍被使用，但只用于**参数校准**而非立项依据（见 0.4）。

一条硬边界不因本修订放松：**`v0.7.0` 的正式发布仍以 `v0.6.0` 完成 M7（RC、灰度、14 日观察）并正式发布为前置**。允许并行开发，不允许跳过 v0.6 发布顺序，也不允许把两个版本合并成一次发布。

### 0.3 基线策略与分支纪律

当前仓库版本声明仍为 `0.5.0`，v0.6 处于「M0-M6 代码候选、M7 未开始」状态。v0.7 采用**堆叠基线**策略：

1. `v0.7-implementation` 分支基于 `v0.6-implementation` 创建，M0 冻结 base SHA 并记入证据；
2. v0.6 后续修复（M7 期间产生）通过 cherry-pick 或定期 rebase 吸收，M0 冻结同步纪律（频率、责任人、冲突处理规则），每次同步记入实施登记册；
3. v0.7 迁移从 M0 时点的下一可用编号开始顺序编号（撰写时为 `0050`，Card Generation v2 已占用 `0044–0049`），不得修改任何既有迁移；
4. 本计划不授权修改 `release/version.json`、package 版本或 README 的版本声明；版本号只能按 v0.5.0 → v0.6.0 → v0.7.0 顺序在各自发布 Gate 通过后推进；
5. 若 v0.6 M7 观察暴露出必须返工的主链缺陷，v0.7 实施暂停吸收变更，先修 v0.6——主链正确性永远优先于激励层进度。

### 0.4 与 v0.6 数据的关系

| 依赖类型 | 内容 | 处理方式 |
| --- | --- | --- |
| 不依赖 | 掌握态状态机、XP/streak/成就规则的**结构**定义与全部安全门禁 | M0 直接冻结 v1 规则 |
| 弱依赖（校准） | XP 数额、等级曲线、每日目标条数、streak 里程碑与激励文案 | M0 冻结保守默认值；M6 用 v0.6/v0.7 Alpha 真实数据**一次性**校准并递增参数版本，不得在观察期内反复调参 |
| 硬前置（发布） | v0.7.0 RC 与发布 | v0.6.0 已正式发布 |
| 独立轨道 | FSRS shadow 数据积累与转正 go/no-go | 继续独立运行，不属于本版范围，v0.7 不得中断 shadow 写入 |

## 1. 当前事实与核心缺口

v0.6 建成了「可信」，但没有回答「为什么想每天回来」。当前事实与本版缺口：

| 领域 | 当前事实（v0.6 代码候选） | v0.7 缺口 |
| --- | --- | --- |
| 理解事实 | `understanding_events`、canonical validation outcome、`review_attempts` 完整、可审计、可重算 | 事实只沉淀在数据库里，用户几乎感知不到积累——没有「我在进步」的可见回馈 |
| 掌握表达 | 卡片与星图展示证据覆盖率、最近验证状态 | 没有 key point 级掌握等级，没有跨时间的成长叙事；理解账户仍是原始流水而非「账户」 |
| 复习入口 | 到期队列 + Review Focus 会话，安全可信 | 是待办清单不是旅程：无每日目标、无节奏、无完成仪式，做完即散场 |
| 会话反馈 | 逐点评估结果页可解释、可回溯 | 结果页是「审计报告」式呈现，缺少即时反馈与值得庆祝的时刻；多题连续作答后没有整体结算 |
| 激励 | 无任何 streak、成就、积分 | 中断学习的成本为零，持续性完全依赖用户自律 |
| 等待体验 | job 异步 + 会话恢复，5 秒后可后台化 | 评估等待是黑盒进度状态，无阶段流式反馈、无部分结果呈现、无显式取消 |
| 学习统计 | Prometheus 运维指标完善（去内容化） | 面向用户的学习统计（热力图、趋势、掌握分布）为零 |
| 星图 | Canvas 星图（~2,300 行）已有缩放/平移/悬停/选中/LOD 分级渲染与聚类布局，节点携带证据覆盖与理解状态 | 只能看不能做：无行动入口（不能从节点直接去验证/复习）、无透镜视图、无搜索定位；只有血缘边，跨笔记知识彼此割裂；低缩放下按 hash 随机采样隐藏节点，「看到什么」不受重要性控制 |
| 用户偏好 | BYOK、主题等设置已有 | 无时区、无游戏化开关、无动效偏好，无法支撑跨天判定与温和性要求 |

关键实现基线（v0.7 读取或扩展，不重写）：

- `apps/api/src/db/schema/validation-v2.ts` — v0.6 八张新表（rubric、submission、逐点 assessment 等）
- `packages/shared/src/rubric-reducer.ts` — 确定性 outcome reducer
- `packages/shared/src/scheduling-policy-v2.ts` / `scheduling-unified.ts` — discrete-v2 统一调度
- `packages/shared/src/feature-flags.ts` + `apps/web/lib/feature-flags.ts` — flag 门禁模式
- `apps/api/src/modules/review/attempt-service.ts` — attempt 审计行
- `apps/web/app/(workspace)/(focus)/` — Focus 会话路由与防泄漏边界
- `workers/ai-worker/src/handlers/index.ts` — job handler、AbortSignal、幂等模式
- `apps/api/src/lib/search-index.ts` — 投影表同步 + drift/reindex 补偿模式（本版投影层的参照实现）
- `apps/web/components/study/UnderstandingUniverse.tsx` — Canvas 星图（缩放/LOD/选中/聚类已有，本版**扩展而非重写**）
- `apps/api/src/modules/understanding/graph.ts` — 理解图构建 API（本版扩展透镜数据与概念边）
- FSRS shadow 回放（M6）——「相同历史重放产生相同 hash」的确定性门禁模式，本版直接复用到激励投影

## 2. 目标用户与关键旅程

### 2.1 目标用户

1. **个人学习者**（主要）：已经会用验证与复习，但坚持两周后动力下滑；需要看得见的进步、每日明确的目标和完成后的满足感；
2. **严肃学习者**：反感游戏化打扰，只要干净的工具；游戏化层必须可整体关闭且关闭后体验完整；
3. **协作空间中的学习者**：进度、XP、streak、成就全部按 user 隔离，任何成员不可见他人激励数据；概念层是 workspace 共享的知识结构，裁决动作带个人审计；
4. **版本维护者**：需要证明激励层没有污染可信判定——每个投影都可从事实重放验证。

### 2.2 旅程 A：每日学习之旅

```text
打开学习主页
→ 看到 streak 状态、掌握进度环与「今日关卡」（到期复习 + 建议验证的有界组合）
→ 点击开始，进入连续 Focus 会话流
→ 逐条完成（question-first 防泄漏边界与 v0.6 完全一致）
→ 全部完成或主动结束 → 结算页
→ 看到本次成果摘要、XP 明细、掌握升级、解锁的成就、streak 延续
→ 看到明日预告（「明天有 3 张卡到期」）与下一里程碑提示
→ 关闭页面，今日活动写入热力图
```

### 2.3 旅程 B：一次作答的节奏

```text
进入单条验证/复习 Focus 会话
→ 未作答阶段：只有净化题面（不变式与 v0.6 相同）
→ 提交答案，答案锁定
→ 等待期呈现阶段式流式状态（排队 → 评估中 → 完成）
→ [Should] 评估反馈按句级流式揭示
→ 结果揭示采用逐点展开节奏：先覆盖点、再待补点、后误解点
→ 连续正确触发连击提示（不遮挡内容、可关闭）
→ 答错时温和呈现 + 「知错能改」指引（修复后有额外认可）
→ 下一条或进入结算
```

### 2.4 旅程 C：掌握升级与成长回顾

```text
某 key point 首次独立验证通过 → 掌握态 provisional（初步掌握）
→ 3 天后复习正确 → consolidating（巩固中）
→ 7 天以上间隔连续正确 → mastered（掌握）
→ 30 天以上间隔再次正确 → proficient（精通）
→ 期间答错 → needs_repair（待修复），保留历史最高等级
→ 修复成功 → 回到 provisional 并获得「知错能改」认可
→ 用户在统计页看到热力图、掌握漏斗与趋势
→ 星图节点按掌握态着色，知识版图随学习「点亮」
```

### 2.5 旅程 D：等待、取消与中断恢复

```text
提交答案后评估耗时较长
→ 流式状态显示当前阶段，提供「后台完成」与「取消」
→ 取消：job 中止，答案与 submission 保留，无任何评估副作用，可稍后重试
→ 断线/刷新：凭 last-seq 恢复流式进度，不重复调用 Provider
→ 后台完成 [Should]：回到会话或结算页时看到完成通知
```

### 2.6 旅程 E：知识宇宙探索与概念聚合

```text
打开知识宇宙（星图）
→ 默认血缘视图；切换「掌握」透镜，看到已点亮与未点亮的星域
→ 切换「到期」透镜，发现 3 个待复习节点被高亮标记
→ 点击节点 → 行动面板 → 直接进入 Review Focus（同一 question-first 防泄漏会话）
→ 完成后回到星图，节点状态与掌握着色即时更新
→ 切换「概念」透镜：两篇不同笔记的 key point 因「幂等性」聚合在同一概念星座
→ 注意到一条虚线（AI 候选链接）→ 查看两侧 claim 证据 → 确认或拒绝
→ 确认后星座实线相连，跨笔记的同一知识第一次被连起来
→ 搜索「事务」→ 视图飞行定位到对应星域
```

### 2.7 旅程 F：激励层失效时的安全降级

```text
投影 job 积压 / 激励 flag 关闭 / 用户关闭游戏化
→ 验证、复习、调度、结果页全部照常工作（v0.6 体验）
→ 仅不显示 XP/streak/成就/关卡包装
→ 投影恢复后自动追平，不丢失任何应得的 XP 或成就（幂等补算）
```

## 3. 版本目标与非目标

### 3.1 目标一：真实进度可见

- 每个 key point 有确定性掌握态，由版本化纯函数从既有可信事件派生；
- 卡片、笔记、星图、统计页共享同一掌握态语义；
- 拒绝以模型 confidence、模糊「掌握百分比」或自报感受充当进度（延续 v0.6 非目标）；
- 任何掌握态都能回溯到产生它的具体事件序列。

### 3.2 目标二：每日学习像一段旅程而不是待办清单

- 学习主页给出有界的「今日关卡」：到期复习优先，辅以少量建议验证；
- 关卡组合是纯函数的**展示层排序**，绝不改写任何 `next_review_at`；
- 会话有开始、节奏与结算：完成时刻值得停留三秒；
- 空状态（无到期项）有建设性替代（建议验证 / 明日预告），而不是空白页。

### 3.3 目标三：激励不腐化可信性（单向数据流）

本版最重要的架构不变量：

```text
事实层（v0.6 canonical 表：validation/attempt/understanding/schedule）
  → 派生层（掌握投影、XP ledger、streak、活动日历、成就）
  → 展示层（主页、结算、统计、星图着色）
```

- 派生层与展示层对事实层**只读**：0 次写入 `review_schedules`、`validation_*`、`understanding_events`、rubric/assessment；
- XP、streak、成就永不影响 outcome、调度间隔或题目选择；
- 掌握态升级仅由 trusted（未辅助、非 stale、canonical）结果触发，与 v0.6 assistance 门禁语义完全一致；
- 该边界以契约测试与代码模块边界双重固定，写入 ADR-0011。

### 3.4 目标四：等待变成流动

- 提交后的等待从黑盒变为阶段式流式状态，支持显式取消与断线恢复；
- [Should] 评估反馈句级流式呈现；
- 流式只改善感知，不改变判定语义：业务副作用仍只能由通过完整 Zod schema 的最终结构化结果产生（延续候选池 2.5 边界）；
- partial 内容与 final 不一致时以 final 为准并显式替换。

### 3.5 目标五：一切派生可重算

- 相同事件流重放必须产生相同的投影结果（逐用户投影 hash 一致）；
- backfill 幂等：历史用户开启功能时一次性补算全部掌握态、XP、活动日历，重复执行结果不变；
- 投影漂移可检测、可一键重建（对齐 `search_documents` 的 drift/reindex 模式）；
- 纯函数不读时钟、不产生随机数；时间一律来自事件记录。

### 3.6 目标六：星图从展示品变成知识宇宙

- 星图可操作：任何 key point/card 节点可直接发起验证或复习，行动走与既有入口完全相同的会话门禁；
- 星图可解读：掌握/到期/薄弱点/概念四种透镜让「看什么」由学习意图决定，LOD 采样从随机改为重要性优先；
- 星图可聚合：跨笔记相同概念通过「AI 候选 + 人工确认」聚合为概念星座，割裂的知识第一次连起来；
- 概念关系永远是血缘之外的**附加层**：不覆盖、不替代 source → note → card → key point 真实血缘（延续候选池 2.1 可信边界）。

### 3.7 明确非目标

本版本不做：

- 排行榜、好友对比、任何跨用户可见的激励数据或社交竞争机制；
- 虚拟货币、抽卡、开箱、付费加速、能量/体力墙等变现型机制；
- 任何可变比率随机奖励（拒绝赌博式强化设计）；
- 惩罚性机制：掉级羞辱、损失厌恶倒计时、公开失败记录；streak 中断只安静归零；
- 用 XP/streak/成就修改 `next_review_at`、outcome、题目选择或任何事实层数据；
- 自适应题库、新题型、多题变体（留在候选池 2.8）；
- Concept Graph 完整形态：prerequisite / supports / contradicts 关系、`concept_edges`、概念合并与拆分、学习路径推荐、知识缺口 AI 分析（留在候选池 2.1）——本版只做「相同概念跨笔记聚合」单一切片，语义等价于 related 聚合，不建概念间关系边；
- Embedding 语义候选（候选池 2.3）：本版概念候选由生成式抽取产生，不引入向量索引；
- AI 自动确认概念或链接：candidate → confirmed 只能由人完成，无任何置信度阈值自动转正；
- 图片视觉理解、PDF/OCR 摄取、多模型路由、FSRS 转正（各自留在候选池独立轨道）；
- token 级打字机输出作为硬承诺（句级/阶段级为准，token 级仅 Could）；
- 把游戏化参与度指标包装成学习效果证明；
- 自动把旧 key point 的掌握历史迁移到重新生成的相似 key point（延续 v0.6 非目标）。

## 4. 成功指标与硬门禁

### 4.1 安全与业务不变量

以下任一失败均阻断 RC：

- [ ] 0 次跨 workspace/user 的掌握态、XP、streak、成就、会话或统计数据泄漏；
- [ ] 派生层与展示层对事实层写入为 0（契约测试 + 模块边界检查覆盖全部写路径）；
- [ ] 0 次 assisted、stale fingerprint 或非 canonical outcome 产生掌握态升级或掌握类成就；
- [ ] XP ledger 0 重复入账：相同 `(rule_code, source_type, source_id)` 幂等，job 重试、网络重试、重放均不增行；
- [ ] 全量事件重放产生的逐用户投影 hash 与线上投影一致（determinism replay gate）；
- [ ] v0.6 全部泄漏边界与安全不变量 0 回归：结算页、流式通道、主页、统计不得携带任何未作答题目的题面、claim、quote、expected points 或 rubric；
- [ ] 流式通道只传输净化题面与 `answer_locked_at` 之后的反馈内容；rubric 与逐点标准答案永不进入流；
- [ ] 取消后 0 业务副作用；恢复不重复调用 Provider、不产生重复评估；
- [ ] 关闭任一游戏化 flag 后主链（验证/复习/调度/结果）功能完整；
- [ ] 0 次 AI 概念或链接未经人工确认进入 `confirmed` 状态；候选不参与任何聚合展示之外的业务逻辑；
- [ ] 0 次概念关系覆盖、替代或伪装为血缘边；概念透镜关闭后星图完整回退为血缘视图；
- [ ] 概念/链接的确认、拒绝、归档、重命名全部可撤销且带 `decided_by` 审计；
- [ ] 0 个概念链接引用不存在或已 superseded 的 key point（引用完整性 fail closed）；
- [ ] 星图行动入口不绕过任何 v0.6 会话门禁：从星图发起的验证/复习走同一 question-first 流程与 assistance 记录；
- [ ] telemetry、日志、metrics 不含题面、答案、claim、quote、概念名、反馈正文；成就仅以低基数 code 出现，XP/streak 数值不进入日志正文。

### 4.2 派生确定性门禁

- [ ] `mastery-policy-v1`、`xp-rules-v1`、`streak-policy-v1`、`achievement-catalog-v1`、`daily-quest-v1`、`level-curve-v1` 全部为版本化纯函数，表驱动测试全绿；
- [ ] 时区边界 property 测试：跨天、跨月、时区变更、闰年、同秒并发事件；
- [ ] streak 与热力图从 `learning_activity_days` 可完整重算，重算结果与增量维护结果一致；
- [ ] backfill 在含 v0.4/v0.5/v0.6 各期历史数据的数据库上执行成功且幂等（两次执行零差异）；
- [ ] 成就目录 v1 中每个成就存在可触发路径的自动化测试（无「死成就」）；
- [ ] `concept-normalize-v1` 归一化纯函数表驱动测试（Unicode/全半角/大小写/空白边界）；相同 normalized name 的候选必须复用既有概念而非新建。

### 4.3 AI 质量门禁

游戏化主线（激励/投影/旅程）不新增 AI 判定能力；本版唯一新增的 AI 能力是概念抽取，为其建立独立 Gold 集。M0 冻结数据集、标注规则与阈值，阈值不得在 RC 失败后降低。

**不回归约束：**

- [ ] v0.6 各 Gold 集（Question/Rubric、Evaluation、Repair）与 90/85/85 卡片指标在 v0.7 RC 上 0 回归；
- [ ] STRM-01 不改变任何 Provider 请求/响应契约与 final schema 语义（契约测试证明流式开关两态下 final 结果 byte 级等价）；
- [ ] 若 M6 参数校准触碰任何 prompt 或判定逻辑——不允许，发现即回退（激励参数与 AI 判定参数物理隔离）。

**Concept Gold v1（新增）：**

| 项 | 要求 |
| --- | --- |
| 数据集 | ≥ 40 个跨领域 key point（优先复用既有黄金集笔记），人工标注期望概念名与跨笔记同概念对，含「不应聚合的近似对」负样本 |
| schema/引用完整性 | 100%；幻觉 key point 引用为 0 |
| 链接精确率（人工判定确为同概念） | ≥ 85% |
| 跨笔记应聚合对召回 | ≥ 70% |
| 概念命名人工接受率 | ≥ 80% |
| 概念数量约束 | 单卡候选 ≤ 5；违反上限即 fail |
| 门禁形式 | PR 用 Mock（固定输出）跑 schema 与评分器；RC 用真实 Provider 两轮均达标（对齐 ADR-0005 模式，规模按切片缩小） |

样本不足或标注分歧未解决时记 `insufficient_data`，概念切片按删减线降级（5.4），不得包装为通过。

### 4.4 产品观察指标

以下用于 14 日 Alpha 观察，全部报告分子、分母与观察周期，不单独替代硬门禁：

- 今日关卡展示 → 开始 → 完成的漏斗；
- 结算页到达率、停留时长与跳过率；
- D1/D7 回访率；streak ≥ 3 与 ≥ 7 的用户比例；
- 到期复习按时完成率相对 v0.6 基线（或 v0.5 数据）的变化；
- 掌握态漏斗分布（unseen → seen → attempted → provisional → consolidating → mastered → proficient）与 needs_repair 修复率；
- 流式取消率、恢复成功率、后台完成使用率；
- 游戏化关闭开关使用率与关闭后回访（反向信号：装饰是否打扰严肃用户）；
- 星图周打开率、透镜使用分布、从星图发起会话的次数与占比；
- 概念候选确认率 / 拒绝率 / 积压量；概念透镜使用率；
- 投影延迟 p95 与 drift 检出次数。

### 4.5 体验与运行 SLO

- 流式首个状态事件 p95 < 1 秒（连接已建立）；Provider 冷启动分桶报告，样本不足只报告不达标判定；
- 结算页数据计算 p95 < 500ms（纯投影读取，无 Provider 调用）；
- 投影更新落后事实层 p95 < 5 秒；积压可观测、可告警；
- 主页（今日关卡）首屏可交互 p95 < 2 秒；
- 星图：1,000 节点下平移/缩放不低于既有帧率基线（M0 记录基线，交互不回退）；选中 → 行动面板呈现 < 100ms；图数据接口 p95 < 800ms；
- 动效全部遵守 `prefers-reduced-motion`（提供淡入替代方案）；无每秒 3 次以上闪烁；庆祝动画可跳过、可在偏好中关闭；
- 音效默认关闭；
- 390 / 768 / 1440 三视口、200% zoom、键盘主路径、WCAG 2.2 AA serious/critical 为 0；XP/成就通知使用 `aria-live` 且不打断作答焦点。

## 5. 版本范围

### 5.1 Must

| 工作包 | 核心结果 |
| --- | --- |
| FDN-07 | 冻结 base SHA、分支同步纪律、ADR-0011、全部规则/参数 v1、feature flags 与观察指标口径 |
| PROG-01 | 掌握投影 + XP ledger + streak + 活动日历数据层：迁移、RLS、纯策略、投影 job、backfill、重放与漂移检测 |
| JRNY-01 | 学习主页与「今日关卡」、卡片掌握态呈现 |
| SESS-01 | 会话节奏重塑与结算页：逐点揭示、阶段式等待状态、recap、下一步指引 |
| INCV-01 | 成就目录 v1、解锁流程、streak 呈现、统计页（热力图 + 掌握漏斗） |
| MAP-01 | 星图交互升级（确定性）：透镜视图、节点行动入口、搜索定位、重要性优先 LOD、稳定聚类布局 |
| CONC-01 | 概念聚合切片：`concepts`/`concept_links` 数据层、`extract_concepts` AI 契约、候选-确认流程、概念透镜、Concept Gold v1 门禁 |
| QLT-07 / REL-07 | RLS、迁移、E2E、三视口、无障碍、灰度与发布证据（含 v0.6 门禁 0 回归） |

### 5.2 Should

- STRM-01：评估反馈句级流式 + 全阶段事件流 + 显式取消 + 断线恢复（question 生成为阶段事件流，不流式题面生成过程）；
- 连击（combo）与节奏微交互深化：连续正确的视觉连击、结算页连击回放；
- 每周回顾：本周巩固 X 个知识点、纠正 Y 个误解、最长连续 Z 天（纯投影读取）；
- streak 宽限：每 30 日最多 1 次自动补 1 天，温和文案；
- 评估后台完成通知（会话内/结算页内到达）；
- 统计页趋势图（周/月维度掌握态迁移曲线）。

### 5.3 Could

- token 级打字机流式效果；
- 纯装饰性主题/外观解锁（不影响任何功能可用性）；
- 成就分享卡片：本地生成图片，仅含成就名称与日期，0 学习内容正文；
- 内部运营参数面板（只读展示当前 rule/curve 版本与数值）；
- 声音反馈包（默认关闭，偏好中开启）。

### 5.4 删减线

如容量不足，按以下顺序裁剪：

1. 所有 Could；
2. 每周回顾与统计页趋势图（保留热力图与掌握漏斗）；
3. streak 宽限与后台完成通知；
4. STRM-01 降级：去掉句级反馈流，只保留阶段事件流与取消/恢复；
5. 连击层：只保留结算页，去掉会话内连击提示；
6. CONC-01 降级（第一档）：AI 候选缓一版，只保留确定性聚合——`concept-normalize-v1` 同名/归一化匹配 + 用户手工建概念与链接（数据层、确认流程、概念透镜全部保留，只去掉 `extract_concepts` job 与 Gold 集）；
7. CONC-01 降级（第二档）：概念切片整体后延至 v0.8，星图保留 MAP-01 确定性升级。

PROG-01 数据层、单向数据流边界、今日关卡、结算页、MAP-01 星图交互升级、确定性重放门禁与安全/迁移门禁**不可裁剪**。若 PROG-01 无法按期完成，正确动作是推迟整版，而不是把投影改成「先写个大概」。CONC-01 的两档降级让 AI 概念抽取质量不达标时星图升级仍能完整交付。

## 6. 领域模型与数据设计

### 6.1 设计原则

1. **事实层零改动**：不修改 v0.6 任何 canonical 表结构与写入路径；
2. 激励/投影层新表按 `user-private-in-workspace` 分类执行 RLS（`workspace_id` + `user_id` 双条件）；概念层两表（6.10）为 **workspace-owned**（知识结构随内容共享），确认动作带 user 级审计；
3. append-only 优先：ledger 与 unlock 只增不改；投影表可整表重建；概念确认可撤销；
4. 迁移（编号自 M0 冻结起点，撰写时为 `0050+`）遵循既有 expand → verify → enforce 模式，fresh/upgrade/repeat/restore 全部纳入 PostgreSQL 集成测试。

### 6.2 `key_point_mastery`（投影表，可重建）

| 字段 | 说明 |
| --- | --- |
| `workspace_id` / `user_id` / `key_point_id` | 复合唯一维度 |
| `card_id` / `note_id` | 冗余定位列（加速聚合，重建时校验） |
| `state` | `unseen / seen / attempted / provisional / consolidating / mastered / proficient / needs_repair` |
| `highest_state` | 历史最高等级（needs_repair 时保留「重回巅峰」叙事依据） |
| `trusted_correct_run` | 当前连续 trusted 正确次数（partial 中断、incorrect/misunderstanding 重置，见 7.1） |
| `longest_trusted_interval_days` | 已通过的最长复习间隔 |
| `policy_version` | 产生该行的 `mastery-policy` 版本 |
| `last_event_at` / `last_event_ref` | 最后一次驱动事件的时间与引用 |
| `archived_at` | key point superseded 时冻结（不迁移、不删除） |

卡片级与笔记级掌握**不落表**：读时聚合（key point 状态分布 → 卡片进度），M2 若性能不达标再评估物化，决策记入登记册。

### 6.3 `xp_ledger`（append-only）与 `user_progress`（投影）

```text
xp_ledger:
  id, workspace_id, user_id,
  rule_code, rule_version, amount (正整数，无扣分),
  source_type ('validation_event' | 'review_attempt' | 'achievement' | 'daily_quest' | 'streak_milestone'),
  source_id, day_bucket (用户时区日期), created_at
  UNIQUE (workspace_id, user_id, rule_code, source_type, source_id)

user_progress:
  workspace_id, user_id (唯一), total_xp, level,
  curve_version, updated_at   —— 全部可从 ledger 重算
```

- `day_bucket` 由事件时刻 + 事件时用户时区快照计算，写入后不随时区变更回溯改写；
- 反刷分上限（如同一 key point 每日最多 1 次复习计分）通过部分唯一索引落到数据库层，不只靠应用逻辑。

### 6.4 `learning_activity_days` 与 `user_streaks`

```text
learning_activity_days:
  workspace_id, user_id, activity_date (用户时区日期),
  validation_count, review_count, tz_snapshot, created_at, updated_at
  UNIQUE (workspace_id, user_id, activity_date)

user_streaks (投影):
  workspace_id, user_id (唯一), current_streak, longest_streak,
  last_activity_date, grace_used_at, policy_version, updated_at
```

热力图直接读 `learning_activity_days`；streak 可从活动日历完整重算，增量维护结果必须与重算一致（4.2 门禁）。

### 6.5 `achievement_unlocks`

```text
achievement_unlocks:
  workspace_id, user_id, achievement_code, catalog_version,
  source_refs (jsonb：触发事件 id 列表), unlocked_at
  UNIQUE (workspace_id, user_id, achievement_code)
```

成就目录本身**定义在代码中**（`achievement-catalog-v1`，见 7.4），不建目录表——目录变更走代码评审与版本递增，杜绝线上手改。

### 6.6 `learning_sessions`

```text
learning_sessions:
  id, workspace_id, user_id,
  origin ('daily_quest' | 'card' | 'review_queue'),
  status ('active' | 'completed' | 'abandoned'),
  started_at, ended_at,
  item_total, item_completed,
  outcome_counts (jsonb：展示层聚合口径 correct/partial/needs_work 计数，
    needs_work = incorrect + misunderstanding 归并，非新增 outcome 枚举；0 题面/答案正文),
  xp_total, recap_snapshot (jsonb：仅派生数据与低基数 code 引用),
  UNIQUE 活跃约束：同 user 同时最多 1 个 active session（部分唯一索引）
```

- 新 session 开始时自动 abandon 旧 active session（对齐 attempt 的既有模式）；
- 超时（如 6 小时无活动）由既有定时任务路径收敛为 abandoned；
- `recap_snapshot` 在 complete 时同事务落库，保证结算页可重访且不重复计算。

### 6.7 用户学习偏好

`user_learning_prefs`（或扩展 users，M1 定）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `timezone` | 首次登录时浏览器时区，兜底 `Asia/Shanghai` | 跨天判定唯一依据；变更只影响未来 `day_bucket` |
| `gamification_enabled` | `true` | 用户级总开关；关闭后隐藏全部激励层展示，投影仍在后台维护（重开不丢进度） |
| `reduced_motion` | `follow_system` | `follow_system / force_reduced` |
| `sound_enabled` | `false` | 默认静音 |

### 6.8 流式进度事件

优先复用 Card Generation v2 的 run 事件模式。M0 技术选型记录二选一：

- A（默认）：新增 `job_progress_events`（`job_id, seq 单调, event_type, payload 净化, created_at`；TTL 清理任务）；
- B：扩展既有 generation run 事件表使其通用化。

SSE 以 `Last-Event-ID`（= seq）恢复；payload 经过与 DOM 泄漏检查同源的净化函数（复用 v0.6 `question-safety` 思路），schema 上不存在放置 rubric/expected points 的字段。

### 6.9 RLS 与角色

- 激励/投影层新表 `user-private-in-workspace` 策略：`workspace_id = current_setting('app.workspace_id')::uuid AND user_id = current_setting('app.user_id')::uuid`；
- 概念层两表 workspace-owned 策略（对齐 notes/cards）：`workspace_id = current_setting('app.workspace_id')::uuid`；
- 投影与概念写入由 Worker/API 在既有受限角色下执行，不新增任何 BYPASSRLS 路径；
- RLS 矩阵测试扩展 v0.6 的多 workspace/多 user 用例覆盖全部新表；
- 新表纳入数据导出与删除边界：用户导出含本人投影与 ledger；workspace 导出含概念层；删除时按归属级联清除。

### 6.10 `concepts` 与 `concept_links`（概念聚合切片，workspace-owned）

```text
concepts:
  id, workspace_id,
  name (2~24 字符), normalized_name (concept-normalize-v1 输出),
  status ('candidate' | 'confirmed' | 'archived'),
  created_from ('ai' | 'user'),
  model_id / prompt_version (AI 创建时必填),
  created_by, decided_by, decided_at, created_at, updated_at
  UNIQUE (workspace_id, normalized_name) WHERE status != 'archived'

concept_links:
  id, workspace_id, concept_id, key_point_id,
  card_id / note_id (冗余定位列),
  status ('candidate' | 'confirmed' | 'rejected'),
  confidence (AI 提出时必填), proposed_by ('ai' | 'user'),
  model_id / prompt_version (AI 提出时必填),
  decided_by, decided_at, archived_at (key point superseded 时冻结),
  created_at, updated_at
  UNIQUE (workspace_id, concept_id, key_point_id)
```

- **证据即 claim**：链接的证据载体就是 key point 的 claim 与其既有 quote 血缘，不另造证据字段——满足候选池 2.1「每条边必须带来源、证据、模型版本和 confidence」的可信边界；
- 概念是聚合标签，不是节点间关系：v1 不建 `concept_edges`，概念之间没有边；
- key point superseded 时链接随之 `archived_at` 冻结（对齐掌握投影 6.2 的处理），不自动迁移；
- 重命名保留 id 与链接；归档可恢复；v1 不做概念合并（留给完整 Concept Graph）；
- 总量约束：workspace 内 active 概念上限（初值 2,000）、每 key point 链接上限（初值 3），超出 fail closed。

## 7. 派生规则与纯策略

全部策略位于 `packages/shared/src/`，与 `rubric-reducer` / `scheduling-policy-v2` 同级：版本化、纯函数、不读时钟、表驱动测试。

### 7.1 `mastery-policy-v1` 状态机

输入：按时间排序的完整判定流（元素含 canonical outcome、assistance 标记、fingerprint 有效性、事件时刻、复习间隔）；trusted = 未辅助、非 stale、canonical。

| 当前态 | 事件 | 次态 | 说明 |
| --- | --- | --- | --- |
| `unseen` | 卡片首次查看（seen 事件） | `seen` | |
| `seen` | 任意 submitted 作答 | `attempted` | 无论对错，先承认「开始尝试」 |
| `attempted` | trusted `preliminary_understanding` | `provisional` | 首次独立验证通过 |
| `provisional` | trusted review `correct` 且间隔 ≥ 3 天 | `consolidating` | |
| `consolidating` | 连续第 2 次 trusted `correct` 且间隔 ≥ 7 天 | `mastered` | |
| `mastered` | trusted `correct` 且间隔 ≥ 30 天 | `proficient` | |
| 任意 ≥ `attempted` | `misunderstanding` 或 trusted `incorrect` | `needs_repair` | `highest_state` 保留；重置连续计数。首次作答即误解同样进入待修复，薄弱点透镜才不漏掉最需要帮助的点 |
| `needs_repair` | trusted `preliminary_understanding` 或 `correct` | `provisional` | 触发「知错能改」奖励路径 |
| 任意 | `unclear_expression` / `unknown` | 原态 | 无法判定：不升级、不降级、不中断连续计数 |
| 任意 | `later` / `unable` / assisted / stale | 原态 | 不升级；活动仍计入活动日历 |
| 任意 | key point superseded | 冻结 `archived_at` | 不迁移到新 key point（对齐 v0.6 非目标） |

- `partial` 复习结果：计入活动与 XP（低额），不推进、不降级，但**中断** `trusted_correct_run` 连续计数（掌握态推进只认 correct/preliminary_understanding）；`incorrect`/`misunderstanding` 重置计数并按上表降级；
- 状态机对全部 outcome 枚举**全覆盖**：未在上表命中的（状态, 事件）组合一律保持原态，纯函数不得存在未定义分支；
- 全部阈值（3/7/30 天）为 v1 冻结值，改动必须递增 policy version 并全量重算。

### 7.2 `xp-rules-v1` 与 `level-curve-v1`

| rule_code | 触发 | 金额 | 频控 |
| --- | --- | ---: | --- |
| `kp_first_validation` | key point 首次 trusted 验证通过 | +10 | 每 key point 一次 |
| `review_correct` | trusted 复习 correct | +6 | 同一 key point 每 `day_bucket` 最多 1 次 |
| `review_partial` | trusted 复习 partial | +3 | 同上，与 correct 互斥 |
| `misconception_fixed` | needs_repair → provisional | +8 | 每次修复 |
| `daily_quest_complete` | 完成今日关卡 | +15 | 每日一次 |
| `streak_milestone_7/30/100` | streak 达到里程碑 | +20/+50/+100 | 每里程碑一次 |
| `achievement_*` | 成就解锁 | 目录定义 | 每成就一次 |

- 无扣分规则；无随机金额；
- `streak_milestone_*` 终身每档一次（source_id = 档位值），断签后重新达到不重复发放；
- `kp_first_validation` 与 `misconception_fixed` 允许先后叠发：首验证即误解、修复后通过的用户两者都得——走过更完整学习路径的人不应比一次通过者得到更少认可；
- 单日 XP 软上限（初值 120）：超出后继续入账但结算页不再放大呈现，避免鼓励刷夜；
- `level-curve-v1` 初值：L1=0 / L2=50 / L3=150 / L4=400 / L5=800，此后每级 +600；
- 所有数额为 M0 冻结初值，M6 允许**一次性**校准并递增 `xp-rules-v2` / `level-curve-v2`，历史 ledger 不重写，等级按新曲线从 total_xp 重算。

### 7.3 `streak-policy-v1`

- 计入条件：当日（用户时区）至少 1 次 submitted validation 或 review attempt——**结果无关**。奖励出勤而非正确率，从机制上消除「为保 streak 而乱答/作弊」的动机；
- 断档：安静归零，无惩罚文案；`longest_streak` 永久保留；
- 宽限 [Should]：每 30 日最多 1 次自动补 1 天，事后在结算页温和告知；
- 时区变更：以事件时刻的 tz 快照判定历史归属，不回溯改写；property 测试覆盖跨天/跨时区边界。

### 7.4 `achievement-catalog-v1`（首发 14 项）

| code | 名称 | 触发（全部来自持久化事件） |
| --- | --- | --- |
| `first_validation` | 首战告捷 | 首次 trusted 验证通过 |
| `first_unassisted_review` | 独立思考 | 首次未辅助复习 correct |
| `first_repair` | 知错能改 | 首次 needs_repair → provisional |
| `streak_7` | 七日之约 | streak 达 7 |
| `streak_30` | 三十而立 | streak 达 30 |
| `reviews_100` | 百炼成钢 | 累计 100 次 trusted 复习 |
| `first_mastered` | 初窥门径 | 首个 key point 达 mastered |
| `first_proficient` | 融会贯通 | 首个 key point 达 proficient |
| `card_fully_mastered` | 一卡通关 | 首张卡片全部 active key point ≥ mastered |
| `repairs_10` | 越挫越勇 | 累计 10 次修复成功 |
| `daily_quest_7` | 稳扎稳打 | 累计完成 7 次今日关卡 |
| `validations_50` | 求知若渴 | 累计 50 次 trusted 验证 |
| `all_due_clear` | 今日无欠账 | 首次在当日完成 ≥ 1 条到期复习后到期队列清空（当日 0 到期不自动达成） |
| `comeback` | 王者归来 | 中断 ≥ 14 天后回归并完成一次会话 |

- 全部显式可见（未解锁灰态展示条件），无隐藏成就、无限时成就；
- 掌握类成就仅由 trusted 结果触发；`comeback` 的存在让「断签」有回头路而非羞耻感；
- 每个成就有自动化可达性测试（4.2 门禁）。

### 7.5 `daily-quest-v1`

- 输入：当前用户到期 `review_schedules`（只读）+ 无有效验证记录的 active key points（只读）+ 配置上限；
- 输出：有界展示列表——到期复习优先（上限 10，超出分批），建议验证补位（上限 3）；
- 排序确定性：到期项按 `next_review_at` 升序（最早到期优先），同刻按 schedule id 定序；建议验证按卡片最近活动时间降序；
- 完成定义：清空当日到期项，或达到会话上限；
- **纯展示层**：不写任何调度字段、不改变到期语义；到期项永远可从常规复习队列访问，关卡只是取景框。

### 7.6 反滥用与温和性规则

- 掌握类成就与掌握态升级仅由 trusted outcome 触发（与 4.1 门禁一一对应）；
- 无随机奖励、无限时压力、无损失厌恶倒计时；
- 激励文案禁用羞辱与焦虑措辞，M4 冻结文案清单并过「焦虑测试」检查表（不出现「再不复习就」「你已落后」句式）；
- 单日 XP 软上限 + 同 key point 日频控（7.2）；
- 用户级 `gamification_enabled` 一键关闭，关闭率进入观察指标（4.4）。

### 7.7 流式契约

```text
事件类型（seq 单调递增）：
  queued → claimed → provider_called
    → partial (仅 evaluation feedback，answer_locked_at 之后，句级缓冲，可多次)
    → finalizing → final | failed | cancelled

规则：
  - final 必须是完整通过既有 Zod schema 的结构化结果；
  - partial 与 final 不一致时，客户端以 final 为准并显式整体替换；
  - question 生成 job 只发阶段事件，不流式题面拼装过程（防半成品泄漏）；
  - cancel 幂等：POST cancel → AbortSignal → job 终态 cancelled，0 业务副作用；
  - 恢复：SSE Last-Event-ID = seq，服务端从持久化事件补发，不重放 Provider 调用。
```

### 7.8 概念抽取契约（`extract_concepts`）

```text
触发：card publish 成功后按卡入队（幂等：同 card version 只抽取一次）；
     历史卡片由一次性 backfill 命令补抽（可分批、可中断续跑）。

输入：card 的 active key points（ordinal + claim + quote）
     + workspace 既有非 archived 概念的 (id, name, normalized_name) 清单（复用优先）。

输出（Zod 契约）：
  concepts: [{
    name: string (2~24 字符),
    existing_concept_id?: string (匹配既有概念时必须复用，不得新建同义项),
    key_point_ordinals: number[] (≥1，必须存在于输入),
    confidence: number (0~1)
  }]  // 单卡 ≤ 5 项，超出 fail closed

规则：
  - 输出全部落为 candidate：新概念 status=candidate，链接 status=candidate；0 自动确认；
  - existing_concept_id 未提供但 normalized_name 命中既有概念 → 服务端强制复用（reuse-first 兜底在代码层，不信任模型）；
  - 未知 ordinal、幻觉 concept_id、超上限、schema 不合 → job fail，不产生部分写入；
  - 隐私治理与 PII 脱敏走既有五层管线；AI 治理上下文（Provider/BYOK/consent）沿用触发该卡片
    生成的同一 owner 上下文，consent 不满足则跳过抽取而非报错；
  - Mock Provider 提供确定性抽取实现供 PR 门禁；
  - 抽取失败不影响卡片可用性：CONC-01 整体是增强层，job dead 只减少候选，不阻塞任何主链。
```

## 8. Job、API 与事务设计

### 8.1 投影更新管道

```text
canonical 事务（v0.6 既有，不改）
  → 完成路径追加入队 update_learning_projection job（携带 source refs）
  → Worker 消费（既有 lease/幂等/退避/超时框架）：
      1. 读取 source 事件与当前投影
      2. 运行纯策略（mastery/xp/streak/achievement）
      3. 事务写入：ledger 插入（UNIQUE 兜底）→ 掌握投影 upsert
         → 活动日历 upsert → streak 投影 → 成就 unlock
      4. 同 source 重复消费：全部 UNIQUE 命中，零副作用
```

- 入队失败不阻塞 canonical 事务（savepoint 保护，对齐搜索索引容错模式）；漏投影由 drift 检测兜底；
- 新增维护命令：`recompute_learning_projection`（全量/单用户重算）与 `learning_projection_drift`（对照重放 hash）；
- 新增 job 类型 `extract_concepts`（7.8）：card publish 后入队，走既有 lease/退避/超时/不可重试错误框架，成本与延迟进既有 Provider 分桶观测；
- 投影积压暴露 Prometheus 指标（队列深度、落后秒数），接入既有告警。

### 8.2 API 端点

| 端点 | 说明 |
| --- | --- |
| `GET /journey/today` | 今日关卡：due 列表引用 + 建议验证引用 + streak/进度摘要（0 题面内容，泄漏边界同 Review 队列） |
| `POST /learning-sessions` / `POST /learning-sessions/:id/complete` | 开始/结算会话；complete 同事务生成 recap snapshot 并结算 `daily_quest_complete` |
| `GET /learning-sessions/:id/recap` | 重访结算页（读 snapshot） |
| `GET /progress/summary` | 等级、XP、掌握漏斗聚合 |
| `GET /progress/heatmap?from&to` | 活动日历区间 |
| `GET /achievements` | 目录（代码内） + 本人解锁状态合并视图 |
| `GET /jobs/:id/stream` (SSE) / `POST /jobs/:id/cancel` | 流式进度与取消 [STRM-01] |
| `GET /understanding/graph?lens=lineage\|mastery\|due\|weak\|concepts` | 星图数据（透镜参数化；mastery/due/weak 合并本人投影，concepts 合并确认与候选链接） |
| `GET /concepts?status=` / `PATCH /concepts/:id` | 概念清单；重命名/归档/恢复 |
| `POST /concepts` / `POST /concept-links` | 用户手工建概念与链接（直接 confirmed，proposed_by=user） |
| `POST /concept-links/:id/confirm` / `POST /concept-links/:id/reject` | 候选裁决（幂等、可撤销、记 decided_by） |
| `PATCH /me/learning-prefs` | 时区、游戏化开关、动效、声音 |

全部端点走既有认证、CSRF、RLS 租户事务模式；SSE 连接设并发上限与最长保持时间，断开由客户端重连恢复。

### 8.3 事务与锁序

- 会话结算使用 user 维度 advisory lock 序列化（`hashtextextended('learning-session:' || user_id, 0)`），防并发双结算；
- 固定锁序：`learning_sessions → xp_ledger → achievement_unlocks → 投影表`，M1 用锁序契约测试固定（对齐 v0.6 lock ordering contract 模式）；
- 所有解锁与入账以 UNIQUE 约束为最终兜底，advisory lock 只是减少冲突噪音。

### 8.4 取消与恢复

- 复用既有 `AbortSignal` + `throwIfJobAborted`：cancel 将 job 置终态 `cancelled`，answer/submission 保留，可用同一 submission 幂等重试（对齐 v0.6 evaluation_retryable 语义）；
- 流式恢复只读持久化事件，不触发任何 Provider 重调用；
- 会话中断（关页/断网）：active session 保留，回来即恢复；超时自动 abandoned，已完成条目的 XP 不回收（已入 ledger 的事实不撤销）。

## 9. UX 方案

### 9.1 学习主页（今日关卡）

- 信息层级：streak 火焰与进度环 → 今日关卡卡片（N 条到期 + M 条建议）→ 开始 CTA → 次要入口（统计/成就/全部队列）；
- 空状态：无到期项时给出建议验证或「今日已清，明日预告」，不出现空白页；
- 超载状态：到期 > 上限时明确「先做最重要的 10 条」，剩余在常规队列可见；
- 主页数据全部来自投影与引用，0 题面正文（防预取泄漏，延续 v0.6 Review 队列的安全语义）。

### 9.2 Focus 会话节奏

- question-first 防泄漏边界与 v0.6 完全一致，本版只改「答完之后」的体验；
- 提交后：阶段式等待状态（复用流式事件）；
- 结果揭示：逐点展开（覆盖点 → 待补点 → 误解点），间隔 150–250ms 的柔和进入动效；
- 连击 [Should]：连续 trusted correct 显示低调计数徽标，不遮挡内容、错误时安静消失；
- 错误呈现：温和红 + 具体缺口 + 「修复后有额外认可」的正向指引，不使用惩罚性语言。

### 9.3 结算页（recap）

- 结构：本次成果（完成数/正确分布）→ XP 明细（逐条规则可展开）→ 掌握升级时刻 → 新解锁成就 → streak 状态 → 明日预告与下一里程碑；
- 庆祝动效一次性播放、可跳过、`prefers-reduced-motion` 下替换为静态呈现；
- recap 只含派生数据与低基数 code，0 未作答题目内容；
- 可通过 `GET /learning-sessions/:id/recap` 重访，刷新不重复计 XP。

### 9.4 统计与成就页

- 热力图：GitHub 风格年视图 + 近 12 周细视图，按用户时区渲染；
- 掌握漏斗：各掌握态 key point 计数与迁移；
- 趋势 [Should]：周/月掌握态迁移曲线；
- 成就墙：已解锁彩色、未解锁灰态并显式展示条件——拒绝赌博式悬念。

### 9.5 星图：知识宇宙（MAP-01 + CONC-01）

在既有 Canvas 星图（缩放/平移/选中/LOD/聚类）上**扩展而非重写**：

- **透镜切换**（顶部分段控件）：
  - 血缘（默认，等于现状视图）；
  - 掌握：节点按掌握态渐进着色（unseen 灰 → proficient 高亮），图例常驻，色盲安全配色；
  - 到期：仅高亮 `next_review_at` 已到/临近节点，其余压暗；
  - 薄弱点：高亮 needs_repair 与 misunderstandingCount > 0 节点；
  - 概念 [CONC-01]：按确认概念聚合成「概念星座」，候选链接以虚线呈现，其余透镜下概念层完全隐藏；
- **行动面板**：选中 key point/card 后在侧栏提供「去验证 / 去复习（到期时）/ 打开卡片 / 概念裁决」，全部复用既有路由与会话门禁；从星图进入会话，完成后返回并恢复视口与选中态；
- **搜索定位**：即时过滤 + 飞行定位（`prefers-reduced-motion` 下直接跳转），支持笔记/卡片/概念名；
- **重要性优先 LOD**：低缩放采样从 hash 随机改为优先保留到期、薄弱、近期变化与当前透镜相关节点；
- **布局稳定性**：同一数据集重复渲染位置稳定（seeded 布局），避免每次打开「星星大搬家」；
- **概念裁决就地完成**：点击虚线候选 → 弹出两侧 claim 证据对照 → 确认/拒绝，不离开星图；
- 空状态、`meta.truncated` 提示与性能预算见 4.5。

### 9.6 动效与无障碍

- M4 冻结「Must 动效清单」：逐点揭示、掌握升级、成就解锁、streak 延续、星图定位飞行五类，此外一律 Could；
- 全部动效有 `prefers-reduced-motion` 替代（淡入/静态）；无闪烁陷阱；
- 键盘完整主路径：主页 → 会话 → 结算 → 统计 → 星图全程可键盘操作；
- XP/成就通知走 `aria-live=polite`，绝不打断作答焦点；
- 三视口断点在 M3/M4 各 Gate 逐页验收。

### 9.7 文案基调

鼓励、具体、不施压。M4 冻结文案表并逐条过「焦虑测试」：不出现催逼句式（「再不……就」）、不羞辱中断（「你已经 X 天没来了」→「欢迎回来」）、不夸大（「精通」仅用于 proficient 态）。

## 10. 核心工作包与 DoD

### 10.1 FDN-07：基线与规则冻结

- [ ] `v0.7-implementation` 分支创建，base SHA 与 v0.6 同步纪律记入证据；
- [ ] ADR-0011（激励派生层与单向数据流边界，含 0.2 治理修订）获批；
- [ ] ADR-0012（概念聚合切片：候选-确认模型与血缘保护）获批；
- [ ] `mastery-policy-v1` / `xp-rules-v1` / `streak-policy-v1` / `achievement-catalog-v1` / `daily-quest-v1` / `level-curve-v1` / `concept-normalize-v1` 参数冻结；
- [ ] Concept Gold v1 数据集、标注规则与阈值冻结（4.3）；
- [ ] feature flags 清单与默认态（全关）冻结：`journey_home / mastery_display / xp_incentives / achievements / session_recap / map_explorer / concept_lens / streaming_feedback`；
- [ ] 观察指标口径（4.4 分子分母）、SLO 基线与星图帧率基线冻结；
- [ ] 流式事件存储选型（6.8 A/B）决策记录。

### 10.2 PROG-01：进度与激励数据层

- [ ] 迁移（M0 冻结起点编号）：六组新表 + RLS + 索引，fresh/upgrade/repeat/restore 集成测试全绿；
- [ ] 六个纯策略模块表驱动测试全绿（含时区 property 测试）；
- [ ] `update_learning_projection` job：幂等、重试安全、锁序契约测试通过；
- [ ] backfill 命令在含历史数据库上幂等执行，两次运行零差异；
- [ ] determinism replay gate：全量事件重放 hash 与增量投影一致；
- [ ] drift 检测与 recompute 命令可用；
- [ ] RLS 矩阵扩展用例全绿；导出/删除边界覆盖新表。

### 10.3 JRNY-01：学习主页与掌握呈现

- [ ] 今日关卡组合正确性（表驱动：空/常规/超载/无建议四态）；
- [ ] 主页网络响应、RSC/hydration、预取与 DOM 0 题面正文（源码级验证，对齐 v0.6 M4 方法）；
- [ ] 卡片掌握态徽标与图例，色盲安全（星图侧见 MAP-01）；
- [ ] 三视口 + 键盘 + WCAG 通过；
- [ ] flag 关闭时主页回退为既有入口，无死链。

### 10.4 SESS-01：会话节奏与结算

- [ ] session 生命周期（active/completed/abandoned）与并发约束测试全绿；
- [ ] 结算同事务：recap snapshot + `daily_quest_complete` 入账原子完成，重访不重复计分；
- [ ] 逐点揭示与阶段等待状态实现，`prefers-reduced-motion` 替代验证；
- [ ] v0.6 泄漏边界 E2E 0 回归（未作答阶段与 recap 页均验证）；
- [ ] 中断恢复：关页重进恢复 active session；超时 abandoned 不回收已入账 XP。

### 10.5 INCV-01：成就、streak 与统计

- [ ] 成就目录 14 项全部有可达性自动化测试；
- [ ] 解锁幂等（UNIQUE 兜底）与 `aria-live` 通知；
- [ ] streak 增量维护与重算一致性测试；宽限 [Should] 规则测试；
- [ ] 热力图时区正确性（含时区变更用例）；掌握漏斗与投影一致；
- [ ] 文案表冻结并过焦虑测试清单。

### 10.6 MAP-01：星图交互升级

- [ ] 五种透镜（血缘/掌握/到期/薄弱/概念占位）数据正确性表驱动测试；透镜间切换无状态残留；
- [ ] 行动面板：验证/复习入口走既有会话门禁（E2E 证明与常规入口行为一致）；会话返回恢复视口与选中态；
- [ ] 搜索定位：即时过滤正确性；`prefers-reduced-motion` 替代路径；
- [ ] 重要性优先 LOD：到期/薄弱/透镜相关节点在低缩放下保留（表驱动优先级测试）；
- [ ] 布局稳定性：同一数据集两次渲染节点位移为 0（seeded 布局回归测试）；
- [ ] 1,000 节点性能不低于 M0 帧率基线；选中响应 < 100ms；
- [ ] 三视口 + 键盘可达（节点遍历有键盘路径）+ WCAG 通过；
- [ ] `map_explorer` 关闭时回退现状星图。

### 10.7 CONC-01：概念聚合切片

- [ ] 迁移：`concepts` / `concept_links` 两表 + workspace-owned RLS + 上限约束，四态集成测试全绿；
- [ ] `concept-normalize-v1` 表驱动测试；reuse-first 服务端兜底测试（模型不给 existing_concept_id 时仍复用）；
- [ ] `extract_concepts` job：幂等（同 card version 一次）、schema fail closed、不可重试错误处理、成本进 Provider 观测；
- [ ] 候选-确认流程：confirm/reject/撤销幂等，decided_by 审计完整；0 自动确认（代码路径审查 + 测试）；
- [ ] key point superseded → 链接冻结的级联测试；
- [ ] 概念透镜与就地裁决 UI：候选虚线/确认实线、证据对照、三视口 + WCAG；
- [ ] Concept Gold v1：PR Mock 门禁全绿；RC 真实 Provider 两轮达标（4.3 阈值）；
- [ ] 历史卡片 backfill 抽取命令：分批、可续跑、幂等；
- [ ] `concept_lens` 关闭时概念层完全隐藏，星图回退 MAP-01 四透镜。

### 10.8 STRM-01：流式交互 [Should]

- [ ] 流式契约（7.7）schema 与净化测试：rubric/expected points 字段级不可达；
- [ ] 取消：0 业务副作用，幂等；恢复：Last-Event-ID 补发，不重调 Provider；
- [ ] 流式开关两态下 final 结果 byte 级等价（4.3 门禁）；
- [ ] 首事件延迟、完成率、取消率指标上报（去内容化）；
- [ ] SSE 连接上限与超时保护。

### 10.9 QLT-07 / REL-07：质量与发布

- [ ] v0.6 全量测试套件 + v0.7 新增套件全绿；v0.6 Gold 集 0 回归；
- [ ] 迁移 fresh/upgrade/restore 演练绑定证据；
- [ ] Playwright E2E：主页/会话/结算/统计/星图主路径 × 三视口 × axe-core；
- [ ] 备份恢复演练覆盖新表；
- [ ] 灰度方案：flag 逐面开启顺序（mastery_display → journey_home → map_explorer → session_recap → xp_incentives → achievements → concept_lens → streaming_feedback）与回滚脚本；
- [ ] 发布证据链：clean SHA、release-check、观察报告。

## 11. 里程碑与 Gate

每个里程碑的 Gate 证据写入 `docs/evidence/v0.7/mN-gate.md`，包含通过项、命令输出摘要、执行人、时间与 commit 绑定。不以「代码存在」替代 DoD。

### M0：基线与决策冻结
- [ ] FDN-07 全部完成；ADR-0011 与 ADR-0012 获批；本计划状态 Draft → Approved。

### M1：Schema、RLS 与纯策略
- [ ] PROG-01 六组新表迁移四态集成测试全绿；RLS 矩阵全绿（概念两表迁移随 CONC-01 于 M6 验收）；
- [ ] 六个纯策略模块表驱动 + property 测试全绿。

### M2：投影管道与确定性重放
- [ ] projection job 幂等/锁序/退避测试全绿；
- [ ] backfill 幂等 + replay hash 门禁通过；drift 检测可用。

### M3：学习主页、星图交互升级与掌握呈现
- [ ] JRNY-01 DoD 全部完成；泄漏源码级验证通过；
- [ ] MAP-01 DoD 全部完成（概念透镜留占位，CONC-01 于 M6 点亮）。

### M4：会话节奏与结算页
- [ ] SESS-01 DoD 全部完成；v0.6 泄漏边界 E2E 0 回归；动效清单与文案表冻结。

### M5：成就、streak 与统计页
- [ ] INCV-01 DoD 全部完成。

### M6：概念聚合切片、流式与参数校准
- [ ] CONC-01 DoD 全部完成（含 Concept Gold RC 两轮），或按删减线第 6/7 条降级并记录；
- [ ] STRM-01 DoD 完成或按删减线降级并记录；
- [ ] 运营参数一次性校准（如有）并递增版本；性能与 a11y 收口。

### M7：RC、灰度与 14 日观察
- [ ] **前置：`v0.6.0` 已正式发布**；
- [ ] 全量 release-check、E2E、迁移/恢复演练全绿并绑定 clean SHA；
- [ ] 48 小时无安全不变量违例、无投影漂移、无重复入账；
- [ ] flag 按灰度顺序分批开启（相邻低风险面可合并为一批），每批 ≥ 48 小时观察，总灰度节奏与 14 日观察窗口在 M7 排期时对齐；
- [ ] 14 日产品/体验/关闭率复盘完成；
- [ ] v0.8 只选择一个主方向，或明确暂不立项（回归方向性预期选择规则）。

## 12. 迁移、兼容与灰度

- v0.7 全部新迁移支持 fresh/upgrade/repeat/restore；新表不被任何 v0.6 代码路径依赖，v0.6 分支可独立发布；
- 八个 feature flag 独立控制、默认全关；任何 flag 关闭即回到 v0.6 体验，无数据风险（`concept_lens` 关闭时既有候选/确认数据保留，仅不展示）；
- backfill 在对应 flag 开启前执行并通过 replay hash 验证：从全部历史事件补算掌握态、XP、活动日历与成就（老用户不从零开始）；backfill 产生的成就解锁**静默入账、不推通知**，避免开启瞬间的通知轰炸；概念历史抽取属 CONC-01 backfill，受 `concept_lens` flag 与成本预算控制；
- 回滚：关 flag（秒级）→ 如需彻底回滚，投影/激励表可整表清空重建，事实层零影响；
- 用户数据导出新增投影与 ledger 段；删除用户级联清除全部激励数据；
- FSRS shadow、search 投影等既有派生管道不受影响（各自独立 job 类型与表）。

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 激励腐化学习动机（Goodhart） | 用户为 XP 而非理解学习 | 出勤型 streak（结果无关）、修复奖励 > 连对奖励梯度、无排行榜、单日软上限、无随机奖励 |
| 游戏化打扰严肃用户 | 反感、流失 | 用户级总开关 + 关闭率进观察指标；文案焦虑测试；默认静音 |
| 投影一致性 bug | 进度显示错误、信任受损 | 纯函数 + replay hash 门禁 + drift 检测 + 一键重算；投影错误不影响事实层 |
| 单向数据流被无意破坏 | 激励污染调度/判定 | ADR-0011 固定边界；契约测试覆盖全部写路径；code review checklist |
| v0.6 未发布的叠加风险 | 两版互相拖累 | 发布顺序硬前置；分支同步纪律；主链缺陷优先修复规则（0.3 第 5 条） |
| 动效/装饰范围蔓延 | 工期失控 | Must 动效清单 M4 冻结，超出即 Could；删减线明确 |
| 时区与跨天边界错误 | streak/热力图错乱 | tz 快照落库 + property 测试 + 可重算 |
| streak 引发焦虑（暗黑模式化） | 与产品价值观冲突 | 安静归零、宽限、comeback 成就、温和文案清单 |
| 概念候选噪音/概念膨胀 | 星图变垃圾场、确认疲劳 | reuse-first 强制复用、单卡 ≤5、workspace 上限、确认率进观察指标、`concept_lens` 可随时关闭 |
| 概念抽取质量不达标 | Must 卡在 Gold RC | 删减线两档降级：先去 AI 保确定性聚合，再整体后延——星图升级不受牵连 |
| Canvas 星图性能回退 | 透镜/搜索叠加拖慢交互 | M0 冻结帧率基线、扩展而非重写、保留既有 LOD、性能预算进 Gate |
| 协作空间概念确认权冲突 | 误确认/误拒绝争议 | v1 全员可裁决 + decided_by 审计 + 可撤销；Alpha 以单人空间为主，细粒度权限留后续版本 |
| 单人维护容量不足 | 延期 | Should 全可裁；CONC-01 有两档降级；PROG-01/MAP-01 不可裁则整版顺延，不牺牲质量门禁 |
| SSE 连接资源耗尽 | API 稳定性 | 连接上限、最长保持时间、断线重连由客户端负责 |

## 14. 与候选池及后续版本的关系

- 未入选候选**继续保留**：自适应题库与新题型（2.8）、Embedding（2.3）、Vision（2.4）、多模型路由（2.6）、完整反馈闭环（2.7）；
- Concept Graph（2.1）**部分进入**：本版只交付「相同概念跨笔记聚合」切片；关系类型（prerequisite/supports/contradicts）、`concept_edges`、概念合并拆分、学习路径与缺口分析仍留候选池——若观察显示概念确认率高、概念透镜高频使用，完整 Concept Graph 在 v0.8 的优先级自然上升，且已有真实确认率/撤销率数据支撑立项（正好回答方向性预期第 5 节的问题）；
- FSRS shadow（2.2）继续独立积累，转正仍是独立 go/no-go 决策，任何时点样本充分即可单独评审，不占用 v0.7/v0.8 主方向名额；
- v0.8 方向选择**回归方向性预期第 3 节规则**（由真实阻断与数据决定）；本版的 owner 直接决策是一次性修订，不成为惯例。观察信号指引：
  - 若 14 日观察显示「题目重复、新鲜感不足」是留存主要阻断 → 自适应题库（2.8）优先级上升；
  - 若显示「知识割裂、缺乏关联」→ Concept Graph（2.1）上升；
  - 若显示 Provider 成本/延迟成为体验瓶颈 → 多模型路由（2.6）上升；
- 持续门禁（方向性预期第 4 节：RLS、迁移、遥测隐私、Worker 幂等、三视口/WCAG、成本上限、备份恢复）在本版与后续每一版持续满足，不作为「未来功能」。

---

**批准记录**

| 日期 | 动作 | 说明 |
| --- | --- | --- |
| 2026-07-26 | Draft 0.1 创建 | 主方向、范围与定位由 repository owner 决策 |
| 2026-07-26 | Draft 0.2 修订 | 补充星图交互升级（MAP-01）与概念聚合切片（CONC-01）为 Must；新增 Concept Gold v1 门禁与 ADR-0012；容量假设上调 |
| 2026-07-26 | Draft 0.3 审查修订 | 状态机全覆盖（补 unclear_expression/unknown、partial 中断语义、needs_repair 覆盖首错）；XP 幂等语义补全（streak 里程碑终身一次、叠发规则）；今日关卡确定性排序；概念抽取治理上下文归属；M0/M1 Gate 与灰度批次一致性修复；backfill 成就静默入账 |
| 2026-07-27 | Draft 0.4 基线校正 | 迁移序列自 `0044+` 校正为 `0050+`：2026-07-26 外部审计确认 Card Generation v2 已占用 `0044–0049`；编号以 M0 冻结为准 |
| 2026-08-07 | Superseded | 本文被 [AI 学习伴侣驱动的多模态理解宇宙](learning-companion-multimodal-understanding-universe.md) 替代（阶段 00 Owner 决策 2026-08-07 批准 §21 13 条），不再进入 Approved，不再并行实施；计划索引同步见 `project-archive/plans/README.md` |


