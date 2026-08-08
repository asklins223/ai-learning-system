# 决策记录 07-7：当前 target Tutor 与 Grounded Answer Critic（§5.7）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-7
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-7（原方案 §5.7）+ 冻结记录 01-2 §10（assistance/exposure 与同锁域竞态）、01-2 §9（逐项 evidence binding 模式）、03-4 Tool Gateway actor 矩阵、01-3 §4 禁止清单
> 约束级别：Tutor 直接写掌握/卡片/关系为 0；Grounded Answer Critic mandatory；unsupported segment 只能 abstain；不存在独立无限 message API。

---

## 1. 交付物

- `workers/ai-worker/src/learning-agent/roles/grounded-tutor.ts`：从 03-1 骨架扩展为完整实现——
  有界 detour 状态机（绑定 `sessionId+episodeId+targetId+questionId`、一次一问题、
  最多两次澄清、固定结束动作）、Must/Should 动作白名单、支持层级拆分、
  `buildGroundedTutorSystemPolicy`、`buildTutorAnswer` 结构校验、保留
  `createGroundedTutorRole`（网关依赖）。
- `workers/ai-worker/src/learning-agent/roles/grounded-tutor.test.ts`：15 个单测。
- `workers/ai-worker/src/learning-agent/roles/grounded-answer-critic.ts`：从 03-1 骨架扩展为
  完整实现——逐段 `supported / partial / unsupported`、`derived_from_current_target`
  绑定 premise refs + 推导类型、引用完整 ≠ 语义支撑通过、partial/unsupported 降级或
  abstain、`buildGroundedAnswerCriticSystemPolicy`、保留 `createGroundedAnswerCriticRole`。
- `workers/ai-worker/src/learning-agent/roles/grounded-answer-critic.test.ts`：20 个单测。
- `apps/api/src/modules/learning-sessions/tutor-detour.ts`：Tutor detour 编排——
  trusted → practice 原子切换（先记录 assistance/exposure 再开放 Tutor 权限）、
  有界 detour 创建/结束、Session 外提问 gate、不建第二套无限 message API。
- `apps/api/src/modules/learning-sessions/tutor-detour.test.ts`：18 个单测。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 有界 detour（§5.7 / W6 bullet 1）

- `TutorDetourBinding = { sessionId, episodeId, targetId, questionId }`：每个 detour 必绑四元组；
- `TutorDetourState.questionCount: 1` 字面量 + 状态机无「再问第二个问题 / 换题」动作：
  一次一个问题由**类型面**保证（`TutorDetourAction` 枚举不含 ask/change 动作）；
- `MAX_TUTOR_CLARIFICATIONS = 2`：公测 v1 最多两次澄清，第 3 次 `allowed=false`；
- 固定结束动作只有 `return_to_origin`（返回原航程）/ `end_session`（结束）；
  `save_question_marker` 是 Should 动作，`shouldFlag=false` 一律拒绝；
- 前台不保留无限滚动聊天历史：`TutorDetourRecord` / `TutorDetourState` **没有
  messages 数组**（单测显式断言 `!("messages" in record)`）。

### 2.2 支持层级拆分（§5.7 / W6 bullet 3）

每个事实性 segment 携带 `supportMode`：

| supportMode | Must/Should | 约束 |
| --- | --- | --- |
| `current_target` | Must（公测只开放本层） | canonical evidence 直接支持或有界推导；推导段必须带 `derivedFromCurrentTarget.{premiseRefs, derivationType}`（`direct_evidence` / `bounded_derivation`） |
| `workspace_knowledge` | Should | 工作区知识；展示前同样须经 Critic 检查 |
| `extended_explanation` | Should | 必须 `extendedExplanation: true` 明确标注，不进共享知识真值 / 正式验证 |
| `unknown` | — | 必须 `unknownDeclaration: true` 明确不知道、不编造来源 |

`buildTutorAnswer` 结构校验 fail-closed：current_target 段必须绑定 `evidenceRefs`
或 `derivedFromCurrentTarget`；unknown / extended 段必须显式声明；任一失败抛
`GroundedTutorError`（不产出半成品答案）。

### 2.3 Must 动作白名单（§5.7 / W6 bullet 4）

- `TUTOR_MUST_ACTIONS`（固定 5 个）：`re_explain`（当前 target 边界内换一种解释）、
  `view_evidence`（查看对应证据）、`render_practice_scene`（生成当前 target practice
  Scene）、`return_to_origin`、`end_session`；
- `TUTOR_SHOULD_ACTIONS`（6 个）：`compare_across_targets`、`workspace_search`、
  `extended_explanation`、`propose_new_card`、`propose_relation_candidate`、
  `save_question_marker`；
- `resolveTutorVisibleActions(shouldFlag)`：flag 未开时 `should` 为空数组（动作本身
  不可见，不是"可见但禁用"）；固定结束动作始终是 Must 子集。

### 2.4 只能提议（§5.7 / W6 bullet 5）

- `TutorProposal` 带 `requiresUserConfirmation: true` **字面量**（与
  `LearningStagingResult.canonicalWrite: false` 同一 fail-closed 手法）：类型层面
  防止把 Tutor 提议当 canonical Card / published semantic relation 消费；
- 新卡 / 关系 candidate / 笔记必须由用户确认后**重新**经过 Generation Supervisor /
  Relationship Governance（Relationship Governance 见 07-6 §10.5）；
- `buildGroundedTutorSystemPolicy.forbiddenOutputs` 显式列出 `mastery`、`canonical_card`、
  `published_semantic_relation`、`schedule`、`personal_understanding_state`、
  `overall_outcome`——Tutor 直接写掌握/卡片/关系为 0。

### 2.5 Grounded Answer Critic 逐段 verdict（§5.7 / W6 bullet 6）

- **mandatory**：标记为 `current_target` 或 `workspace_knowledge` 的 segment 在展示前
  必须经独立 Critic 逐段检查；`criticizeAnswer` 对需要检查的段缺失 claimed support
  直接抛 `GroundedAnswerCriticError("missing_claimed_support")`（不能跳过检查）；
- `derived_from_current_target` 必须绑定非空 `premiseRefs` + 合法 `derivationType`；
  缺失 / 非法 → fail-closed 抛错；
- **引用完整 ≠ 语义支撑通过**：所有 refs ⊆ allowlisted 集合（结构通过）但
  claimed semantic support = none → 仍判 `unsupported`；refs 不在 allowlist → 抛
  `forged_premise_ref`（Critic 只读 allowlisted evidence/premises，不扩大检索）；
- 只有 `supported` 可使用对应来源标签（`sourceLabelAllowed`）；
- 处置：`supported → present_as_is`；`partial / unsupported →
  shouldFlag ? downgrade_to_extended_explanation : abstain`。

### 2.6 trusted → practice 原子切换（§5.7 / W6 bullet 7）

- 用户在当前 Card/Episode 提问时：若前台是「让我试试」（trusted challenge），
  `resolveKnowledgeHelpGate` 返回 `require_switch_to_together` → 只能呈现「切换到一起
  学习」确认动作（Agent 不能代点）；
- 用户确认后 `createScopedTutorDetour` 在同一事务内：先 `enterPractice`
  （presence-control.enterPracticeMode：记录 assistance/exposure → 开放 Grounded
  Tutor 权限）→ 再 `detourRepo.saveDetour`；任一步抛错整体回滚（assistance 不残留、
  权限不开放、detour 不创建）；
- 顺序由单测断言：`assistance_and_exposure → tutor_permission → saveDetour` 全部在
  同一 `transaction:begin/commit` 内。

### 2.7 Session 外提问（§5.7 / W6 bullet 1）

`resolveOutsideSessionEntry`：只有用户明确选定一个 **published** Key Point 才返回
`create_scoped_exploration`（创建 scoped exploration Session）；未选定 / 空 / 不在
published 集合 → `ask_select_material`（先请用户选择材料，不提供通用无限消息流）。

## 3. 决策点与收口

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 一次一问题的保证方式 | `questionCount: 1` 字面量 + 状态机无换题动作 | 类型面防呆，运行期无法构造第二个问题 |
| 澄清上限 | `MAX_TUTOR_CLARIFICATIONS = 2` | 公测 v1 冻结；超出 `allowed=false` 且状态不变 |
| Should 动作展示 | flag 未开时 `should` 为空数组（不可见） | §5.7：flag 未开时动作本身不可见 |
| 提议 vs 直接写 | `TutorProposal.requiresUserConfirmation: true` 字面量 | 与 staging `canonicalWrite: false` 同手法，类型层面防止越权消费 |
| Critic 检查范围 | 仅 `current_target` / `workspace_knowledge` 段 | §5.7：扩展说明与未知段不进入共享真值，直接呈现 |
| 引用完整 ≠ 语义支撑 | 结构通过 + claimed=none → `unsupported` | §5.7 硬性要求，引用完整不能作为支撑通过的充分条件 |
| partial/unsupported 处置 | Should 开 → 降级扩展说明；关 → abstain | §5.7：不能带来源标签呈现 |
| trusted→practice 原子性 | 复用 presence-control.enterPracticeMode，同事务先记录后开放 | 01-2 §10.2「assistance 先赢」；Agent 不能代点 |
| 无独立 message API | detour 记录无 messages 数组，生命周期为有限状态机 | §5.7：前台不保留无限滚动聊天历史 |

## 4. 验收映射

- [x] Tutor 直接写掌握/卡片/关系为 0（类型面 + `forbiddenOutputs` + 单测断言
  `!("mastery" in answer)` 等）；
- [x] Grounded Answer Critic mandatory（`criticizeAnswer` 缺 claimed support 抛错）；
- [x] unsupported segment 只能 abstain（Should 未开）或降级扩展说明（Should 开）；
- [x] 不存在独立无限 message API（detour 记录无 messages 字段，单测断言）；
- [x] 有界 detour 绑定四元组、一次一问题、最多两次澄清、固定结束动作（单测）；
- [x] 逐段 supported/partial/unsupported；`derived_from_current_target` 绑定
  premise refs + 推导类型；引用完整 ≠ 语义支撑通过（单测）；
- [x] trusted → practice 原子切换：先记录 assistance/exposure 再开放 Tutor 权限
  （顺序断言 + 失败整体回滚）。

## 5. 后续衔接

- 前台渲染层消费 `resolveTutorVisibleActions` / `SegmentCritique.disposition`：
  supported 段带来源标签；降级段明确标注「扩展说明，不进共享知识真值/正式验证」；
  abstain 段不渲染；
- `save_question_marker` 的持久化（问题标记进星图「问题」透镜）实现于后续任务，
  本模块只在 detour 记录上落 `questionMarkerSaved` 标志；
- 新卡/关系候选提议经用户确认后重新走 Generation Supervisor / Relationship
  Governance（07-6 §10.5），本模块 0 直接 canonical 写；
- 阶段 08（W7）跨模块审计将重查：detour 记录无第二套消息流、Tutor 提议无绕过
  治理路径、Critic 调用点 mandatory。
