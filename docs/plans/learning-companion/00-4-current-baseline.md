# 决策记录 00-4：现状基线确认（§1）

> 状态：**Confirmed（已确认）**
> 批准人：Repository Owner（阶段 00 执行指令）
> 日期：2026-08-04
> 来源：`00-decision-and-scope.md` 任务 00-4（原方案 §1.1/1.2）
> 用途：当前实现事实与缺口清单，供 W0 基线与 W8 对比。

## 任务信息

- **任务编号**：00-4
- **名称**：现状基线确认（§1）
- **交付物**：当前实现事实与缺口清单（供 W0 基线与 W8 对比）
- **任务内容来源**：`docs/plans/learning-companion/00-decision-and-scope.md` 任务 00-4（原方案 §1.1/1.2）

## 当前事实 / 核心缺口

下表为源文档任务 00-4 表格的原文逐行转录，未做改写。七行覆盖七个领域：学习卡生成、验证题型、Rubric 评估、复习、理解星图、前台 AI、游戏化。

| 领域 | 当前事实 | 核心缺口 |
| --- | --- | --- |
| 学习卡生成 | Generation Supervisor 方案将输出 canonical candidate、exact evidence、semantic support、semantic grouping 和 relation hints | 生成结果尚未被设计成可操作的学习对象，消费端仍主要展示文字 |
| 验证题型 | 现有契约主要是 `explain / example / apply`，前台以自由文本回答为主 | 默认要求打字，未覆盖语音、结构重建、关系连接和多步情境 |
| Rubric 评估 | rubric 持久化 expected concept 与 evidence，但当前评估 Provider 输入只含 criterion/weight/required | 尚未形成"用户回答片段—冻结 rubric target—canonical evidence"的逐项语义复核 |
| 复习 | 到期项按 `nextReviewAt` 升序进入队列，具备可信 attempt、assistance 和调度事实 | 产品形态仍像必须清理的任务队列，缺少按用户意图组织的有界路线 |
| 理解星图 | Canvas 已有缩放、平移、聚类、LOD、选择和详情；服务端只有 `source → note → card → key_point` 外键血缘 | 只能看，尚未成为学习入口，也不能展示个人学习事实的真实闭环 |
| 前台 AI | AI 主要在生成、评估等后台工作；注册、登录、首次进入和普通页面没有统一助手壳 | 用户没有一个从进入系统起就可找到、并能在文章、卡片、星图、历史和错误状态间连续工作的前台学习伴侣 |
| 游戏化 | 旧 v0.7 以 XP、streak、每日关卡、成就和 combo 为主 | 与"自愿、非强迫、按个人偏好学习"的产品价值冲突 |

## 不改的后果

源文档「不改的后果（§1.2）」原文，逐条列出：

1. 不喜欢打字的用户无法完成核心验证；
2. 新用户无法建立"材料—卡片—航程—星图"心智；
3. 纯选择题不能可靠证明理解；
4. 传统问答套动画无游戏感；
5. 另加聊天框无差异化；
6. 伴侣既辅导又判卷会泄题/标准漂移/assistance 污染；
7. Agent 直接点亮星图会失去可信边界；
8. 把生成关系全画进图会变成幻觉关系网。

## 验收标准

- **Owner 确认缺口清单与现状一致。**

本记录的状态标记为 **Confirmed（已确认）**，批准人 Repository Owner（阶段 00 执行指令）确认后，本基线即作为 W0 基线（阶段 01）与 W8 对比（阶段 09）的起点。

## 代码库现状核对

本小节为本次核对时基于 `apps/`、`packages/`、`workers/` 目录下实际观察到的文件/目录路径与关键符号证据，与上表「当前事实」列逐条对应。核对方式为 `ls`/`glob`/`grep` 快速抽样，不构成深度实现审查。

### 1. 学习卡生成 —— 已定位

| 当前事实 | 观察证据 |
| --- | --- |
| Generation Supervisor 方案输出 canonical candidate、exact evidence、semantic support、semantic grouping、relation hints | 见下 |

实际观察到的证据路径：

- `apps/api/src/modules/card-generation/`（`service.ts` 约 55 KB、`schema.ts`、`routes.ts`）
- `packages/db/src/schema/card-generation.ts`（约 36 KB，含 `relation_hints` jsonb 列，行 406/699）
- `packages/shared/src/card-agent-contracts.ts`
- `workers/ai-worker/src/agent/`（`supervisor.ts`、`critic.ts`、`candidate-ledger.ts`、`publish.ts`、`roles/supervisor-loop.ts`、`roles/grounding-critic.ts` 等）
- `workers/ai-worker/src/handlers/card-supervisor-agent.ts`

关键符号证据：

- `service.ts` 中 `candidates` 的 `candidateKind` ∈ `{extracted, canonical}`、`semanticIndex.mode`（embedding profile version）、`relation_hints`
- `packages/db/src/schema/card-generation.ts` 行 406：`relationHints: jsonb("relation_hints")`

> 注：`semantic support` / `semantic grouping` 的具体持久化形态未在本轮抽样中单独核实，relation hints 与 candidate/semanticIndex 已有直接证据；生成结果作为「可操作学习对象」的消费端形态未定位到对应实现（与表中缺口一致）。

### 2. 验证题型 —— 已定位

| 当前事实 | 观察证据 |
| --- | --- |
| 契约主要是 `explain / example / apply`，前台以自由文本回答为主 | 见下 |

实际观察到的证据路径：

- `packages/shared/src/enums.ts` 行 213-215：`EXPLAIN: "explain"`、`EXAMPLE: "example"`、`APPLY: "apply"`
- `packages/shared/src/schemas.ts` 行 242：`questionType: z.enum(["explain", "example", "apply"])`
- `packages/shared/src/deterministic-question.ts`（题型选择逻辑）
- `packages/shared/src/prompts.ts`（explain/example/apply 三种题型的 prompt 契约）
- `apps/web/components/ValidationFocus.tsx`（约 74 KB，作答页）

关键符号证据：

- `apps/web/components/ValidationFocus.tsx` 行 1662：`<textarea id="vf-answer" className="validation-focus-textarea">`、`已输入 {draftAnswer.length} 字` —— 确认前台以自由文本输入为主
- 语音、结构重建、关系连接、多步情境等输入形态未定位到实现（与缺口一致）

### 3. Rubric 评估 —— 已定位

| 当前事实 | 观察证据 |
| --- | --- |
| rubric 持久化 expected concept 与 evidence，当前评估 Provider 输入只含 criterion/weight/required | 见下 |

实际观察到的证据路径：

- `packages/db/src/schema/validation-v2.ts` 行 49：`expectedConcept: text("expected_concept").notNull()`；行 39 注释「expected_concept 提交前不返回客户端」
- `apps/api/src/modules/validation/`（`service.ts`、`session-service.ts` 约 116 KB、`session-schema.ts`、`routes.ts`）
- `workers/ai-worker/src/handlers/evaluate-rubric.ts`

关键符号证据：

- `apps/api/src/modules/validation/session-service.ts`：`rubricItems` 含 `criterion`/`required`（行 2101 `required: item.required`）、`rubricItemId`/`evidenceId`、`RubricItemInput`
- `workers/ai-worker/src/lib/`（`business-ai-ops.ts` 中 `evaluateRubricViaChat`）与 `packages/shared`（`evaluateRubricOutputSchema`、`rubric_bad` 枚举见 `session-schema.ts` 行 102）
- Provider 输入为 criterion/weight/required 的直接证据：`apps/api/src/modules/validation/session-service.ts` 行 2098-2101 构造 `RubricItemInput[]`
- 「用户回答片段—冻结 rubric target—canonical evidence」逐项语义复核未定位到完整实现（与缺口一致）

### 4. 复习 —— 已定位

| 当前事实 | 观察证据 |
| --- | --- |
| 到期项按 `nextReviewAt` 升序进入队列，具备可信 attempt、assistance 和调度事实 | 见下 |

实际观察到的证据路径：

- `apps/api/src/modules/review/`（`attempt-service.ts` 约 38 KB、`service.ts` 约 23 KB、`scheduling-policy.ts`、`consumer-eligibility.ts`、`routes.ts`）

关键符号证据：

- `service.ts` 行 153：`orderBy: (r, { asc: a }) => [a(r.nextReviewAt), a(r.id)]`
- `attempt-service.ts` 行 464：`orderBy: (s, { asc }) => [asc(s.nextReviewAt)]`
- assistance 事实：`service.ts` 行 22-37 `ReviewBlockedReason = "not_yet_due" | "assistance_cooldown"`、`unassistedEligibleAfter`
- 可信 attempt：`attempt-service.ts`（attempt 生命周期与决策写入）
- 「按用户意图组织的有界路线」产品形态未定位到实现（与缺口一致）

### 5. 理解星图 —— 已定位

| 当前事实 | 观察证据 |
| --- | --- |
| Canvas 已有缩放、平移、聚类、LOD、选择和详情；服务端只有 `source → note → card → key_point` 外键血缘 | 见下 |

实际观察到的证据路径：

- `apps/web/components/study/UnderstandingUniverse.tsx`（约 79 KB，Canvas 渲染）
- `apps/api/src/modules/understanding/`（`graph.ts`、`service.ts` 约 21 KB、`routes.ts`）

关键符号证据（Canvas 能力）：

- 缩放/平移：`zoomAround`、`viewport.zoom/offsetX/offsetY`、滚轮与 pinch 缩放（行 1519-1522、1412-1420）
- 聚类：`clusterModel`、`UniverseCluster`、`nodeToCluster`、`representativeIds`（行 976-1058）
- LOD：`nodeIsVisibleAtLod`、`renderQuality`（overview/balanced/detail/interaction，行 436-452）
- 选择：`selectedId`、`drawSelectionOrbit`（行 903）
- 详情：`hoverId`/`tooltip`、选中后详情面板与 `selectedAnnouncement`（行 2251-2331）

关键符号证据（服务端血缘）：

- `graph.ts` 行 1：`UnderstandingGraphNodeType = "source" | "note" | "card" | "key_point"`
- `graph.ts` 行 129-130 注释：`source <- notes.sourceId、note <- noteVersions.noteId <- cards.noteVersionId、card <- cardKeyPoints.cardId`
- `service.ts` 行 309-311 注释：`source -> note (notes.source_id)`、`note -> card (learning_cards.note_version_id -> note_versions.note_id)`、`card -> keyPoint (card_key_points.card_id)`
- 服务端仅输出「外键血缘」图（source/note/card/key_point 节点与 from→to 边），未发现个人学习事实（作答、复习、理解事件）参与构图的关系数据（与缺口一致）

### 6. 前台 AI —— 未定位

| 当前事实 | 观察证据 |
| --- | --- |
| AI 主要在生成、评估等后台工作；注册、登录、首次进入和普通页面没有统一助手壳 | 见下 |

实际观察到的证据路径（后台 AI 存在）：

- `workers/ai-worker/src/`（`parse-source`、`evaluate-rubric`、`generate-validation-question`、`card-supervisor-agent` 等 handler；`agent/`、`lib/` 等）
- `apps/api/src/modules/`（`card-generation/`、`validation/`、`benchmark/` 等）

关键符号证据（前台 AI 缺位）：

- `apps/web` 全目录 grep `assistant|chat|聊天|伴侣|助手`：**无匹配**
- `apps/desktop` 全目录 grep `assistant|chat|聊天|伴侣|助手`：**无匹配**
- `apps/api/src/modules` 全目录 grep `companion|navigator|assistant|chat`：**无匹配**
- `apps/web/app/(workspace)/(default)/` 页面（`page.tsx`、`cards/`、`graph/`、`notes/`、`review/`、`search/`、`settings/`、`sources/`、`today/`）与 `(focus)/`（作答页）中均未发现统一助手壳组件

> 结论：注册、登录、首次进入与普通页面不存在统一前台学习伴侣壳，如实标注为**未定位**（与表中缺口一致）。

### 7. 游戏化 —— 旧方案已定位（计划层），代码层未实现

| 当前事实 | 观察证据 |
| --- | --- |
| 旧 v0.7 以 XP、streak、每日关卡、成就和 combo 为主 | 见下 |

实际观察到的证据路径：

- `docs/plans/AI学习系统-v0.7-版本实施计划-2026-07-26.md`（旧 v0.7「游戏化掌握旅程」版本实施计划；行 37 主方向、行 80「无任何 streak、成就、积分」）
- `docs/plans/AI学习系统-v0.7-方向性预期-2026-07-22.md`（候选池）

关键符号证据（代码层无实现）：

- `apps/web/components/study/` 全目录 grep `streak|XP|成就|等级|combo|金币|经验值`：**无匹配**
- 旧 v0.7 计划（行 80）本身声明 v0.6/v0.7 代码候选「无任何 streak、成就、积分」，即游戏化只存在于计划层，未落入当前代码

> 结论：表中「旧 v0.7 以 XP、streak、每日关卡、成就和 combo 为主」指的是已废弃的计划方案；当前代码中未发现游戏化实现，与其「与产品价值冲突、应弃用」的判断一致。

## 基线用途

本基线记录阶段 00 决策时点的当前实现事实与缺口清单，供两个对比点使用：

- **W0 基线（阶段 01）**：`01-w0-contracts-and-baseline.md` 冻结集成 Gate 与 W0 合同工作时，以上表「当前事实」列作为实现的起点参照，缺口列作为 W0 及后续周要填补的方向。
- **W8 对比（阶段 09）**：在阶段 09 逐条复查本表，比对「当前事实」列的每一项是否变化、缺口是否被关闭；未变化的缺口、未闭合的项即为未完成证明。

对比纪律：

- 以本表 7 个领域逐行核对，不合并、不遗漏；新增能力不替代既有行的核对。
- 代码层证据以 commit 绑定为准（本核对为快照式抽样，仅作方向性确认）；正式对比时以阶段 09 复查时的实测为准。
