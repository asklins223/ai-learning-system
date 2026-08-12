# 任务 14 阶段 D：桌宠 Dialogue Router 三态核对清单（13 §7.2/§7.3 + 03 合同）

> 核对日期：2026-08-12（14 方案实施，阶段 D）
> 核对对象：worker 侧三 handler + api 侧 companion-conversation bridge + web 端 companion-pet（均已在未提交工作区实现）
> 结论：**全项通过，无需补实现**（web 端 typed route 开放条件已具备，Owner 决策 3 满足）

## 1. 三态 Router（13 §7.2）

| # | 合同项 | 实现位置 | 核对结果 |
| --- | --- | --- | --- |
| 1.1 | `casual_chat`：快回复，persona 文字分支 | `workers/ai-worker/src/handlers/companion-dialogue.ts`（lexeme 预检不命中 → persona 分支；`companion-dialogue-router.ts` `shouldRunActionClassifier` 不触发 classifier） | ✅ 通过 |
| 1.2 | `learning_question`：bounded/grounded 文字解释，**无 mutation** | `companion-dialogue.ts` grounded-tutor 分支（`GROUNDED_TUTOR_PROMPT_ID` + `readGroundedTutorContext` 只读；grant 失败 fail-closed `ACTION_STALE`） | ✅ 通过（无 mutation：只读 context + 文字回复） |
| 1.3 | `learning_action`：typed proposal + user confirmation，**无直接 mutation** | `companion-dialogue-router.ts`（classifier 只出 intent/confidence，`confidence>=0.90` + `availableIntents` 检查）+ `companion-action.ts`（action run 才执行副作用） | ✅ 通过（router 不直接 mutation；执行在 action run） |
| 1.4 | classifier 失败/超时/非法 JSON → none，不影响正文 | `classifyDialogueAction` catch → none（router.test.ts 105/89/97 行用例） | ✅ 通过 |

## 2. learning_action 候选集（03 合同）

| # | 合同项 | 实现位置 | 核对结果 |
| --- | --- | --- | --- |
| 2.1 | 候选 kind：`resume_session` / `start_session` / `open_review` / `open_card` / `open_star_map` | `packages/shared/src/companion-conversation-contracts.ts` `proposedLearningActionPayloadV1Schema`（strict discriminatedUnion） | ✅ 通过 |
| 2.2 | 点击只创建待确认 proposal、不直接 mutation | `learning-action-bridge.ts` `createCompanionMenuProposal`（pending proposal + `action.proposed` 事件，无学习副作用） | ✅ 通过 |
| 2.3 | 用户确认后走 typed route | `decideCompanionProposal`：纯导航同步 succeeded；session/tutor 创建 action run → worker `companion-action.ts`（start_session 只读已 PREPARE 的真实 session，不伪造） | ✅ 通过 |
| 2.4 | 复习候选 → 复习 Focus 会话；卡片候选 → `/cards/[id]` | `learning-action-bridge.ts` `NAVIGATION_KINDS` + `navigationRouteFor`（`open_review`→review / `open_card`→card / `open_star_map`→star_map）；web 端 `desktop-pet-adapter.ts` `browserRoutePath`（`/review`、`/cards/{cardId}`、`/knowledge?keyPoint=`） | ✅ 通过 |
| 2.5 | 菜单导航/本地开关绕过 LLM 直接走 typed | web `PetMenu.tsx` `runLearningItem`（`createLearningMenuProposal` 直接调 typed API，不经 LLM）；`browserRoutePath` 纯映射 | ✅ 通过 |
| 2.6 | 自然语言不得直接执行系统命令 | classifier input 只含 `userText + availableIntents`（`buildActionClassifierInput` strict schema），模型不提供 ID/route/payload | ✅ 通过 |

## 3. proposal payload（13 §7.2 / 03 合同）

| # | 合同项 | 实现位置 | 核对结果 |
| --- | --- | --- | --- |
| 3.1 | strict schema（`companionProposalSnapshotV1Schema` / `ProposedLearningActionPayloadV1`） | `companion-conversation-contracts.ts`（z.strict discriminatedUnion + snapshot） | ✅ 通过 |
| 3.2 | 实时重新解析（不为过期 proposal 执行） | `decideCompanionProposal`：pending/TTL/无 active run 校验 + `expectedPayloadSha256` 精确匹配；过期 → 丢弃并提示重新发起 | ✅ 通过 |
| 3.3 | payload 含 `route`/`targetId`/`origin` 语义 | `proposedLearningActionPayloadV1Schema`（resume_session.sessionId / start_session.cardId+keyPointId+origin / open_* 导航） | ✅ 通过 |
| 3.4 | 单 pending fence：proposal 重复创建 → 409 | `createCompanionMenuProposal`（pending proposal exists → `IDEMPOTENCY_CONFLICT`） | ✅ 通过 |

## 4. 快回复与慢动作（13 §7.3）

| # | 合同项 | 实现位置 | 核对结果 |
| --- | --- | --- | --- |
| 4.1 | 创建 Session/等待 Worker 时角色先「我来准备一下」，只代表已接收 | `PetMenu.tsx`「正在确认当前学习状态…」→ proposal → `PetConfirmationCard.tsx`「已提交，等待学习动作完成…」（accepted/executing） | ✅ 通过（web 端等价语义：proposal 先行、确认后 action run） |
| 4.2 | 完成后用真实结果生成展示话术 | `companion-action.ts`：result 正文 = 确定性模板 + 服务端事实字段（title/targetSummary/impactSummary），不引用模型原话 | ✅ 通过 |
| 4.3 | 失败保留真实错误与重试入口 | `companion-action.ts` `action.failed`（含 errorCode + recoverable）；`PetConfirmationCard.tsx` 失败 → error 状态 + 完整对话页可查看；worker action 失败 → proposal failed + 事件 | ✅ 通过 |
| 4.4 | 角色 presentation 不修改 ID/状态/时间/置信度/失败事实 | `companion-action.ts` 头注：人设口吻不改变事实；result 只投影服务端字段 | ✅ 通过 |

## 5. 门禁与开放（14 方案 §7 决策 3）

| # | 合同项 | 实现位置 | 核对结果 |
| --- | --- | --- | --- |
| 5.1 | web 端 `learning_action` typed route 随本方案开放 | `bootstrap-service.ts` `learningActions: dialogueEnabled && actionBridgeEnabled` 门禁已存在；web `PetMenu.tsx` 按 `learningActionsEnabled` 渲染学习候选 | ✅ 通过（开放条件即达，无需补码） |
| 5.2 | 桌面端仍按 13 §7.2 P5 门禁释放 | `desktop-pet-adapter.ts`（pet surface 桌面端接 IPC） | ✅ 通过（未提前开放） |

## 6. web 端 typed client（14 方案附录 A D2 落点核对）

附录 A 规划的 `apps/web/features/companion/api/learning-action-client.ts` 由既有
`apps/web/features/companion-pet/learning-actions.ts` 覆盖（0.8 复核「已存在未接线」
判断更新为「已存在且已接线」），**不重复实现**：

| # | D2 要求 | 落点 | 核对结果 |
| --- | --- | --- | --- |
| 6.1 | proposal 创建 typed client | `createLearningMenuProposal`（`/api/companion/menu-proposals`，strict schema 校验 + idempotency key + clientMessageId） | ✅ 已存在且已接线 |
| 6.2 | confirm/reject typed client | `decideLearningProposal`（`/api/companion/proposals/:id/decision`，schema 校验） | ✅ 已存在且已接线 |
| 6.3 | 接线验收：PetMenu 候选 → proposal → confirmation → typed route | `PetMenu.tsx runLearningItem` → `PetConfirmationCard.tsx submitDecision` → `adapter.openMainRoute(response.route)`（`browserRoutePath`：review/card/star_map/learning_session） | ✅ 全链已接线 |
| 6.4 | 失败路径 | 网络失败 → `LearningActionClientError`（保留 status/code）；decision 失败 → error 状态 + 完整对话页可查看 | ✅ 通过 |

## 缺项结论

**无缺项**。所有核对项均通过；web 端 typed route 开放条件（`dialogueEnabled && actionBridgeEnabled`）已具备，符合 Owner 决策 3。桌面端保持 P5 门禁未开放，符合 13 §7.2。

## 验证

- `workers/ai-worker/src/handlers/companion-dialogue-router.test.ts`：classifier 三态/回落/构建用例齐全；
- `apps/api/src/modules/companion-conversation/learning-action-bridge.test.ts`：async action idempotent retry 用例；
- `apps/web/features/companion-pet/`：PetMenu 候选 → proposal → confirmation → typed route 全链在页面层接线（源码核对）。
