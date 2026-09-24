# 学习卡练习与复习多模态改版方案：从「敲字队列」到「伴星驱动的多样作答」

> **目标流程覆盖说明（2026-09-24）：**本文记录旧学习卡练习与复习接线方案。今后从笔记第一次学、复习整篇笔记和自愿加入长期复习，以[方案 38](./38-source-note-learning-journey-prd-2026-09-24.md)为准；卡片练习作为可选支线，多模态作答和可信评估中仍适用的约束继续有效。

> 状态：**Approved（Owner 已于 2026-08-12 确认 §7 四项决策，本方案据此定稿）**
> 文档版本：1.0（2026-08-12 审查修订：按文档复核落盘——①未提交改动数按复核时 `git status` 实测由 348 更新为 349，并注明为会话快照、实施开工前以当时状态为准（审计基线 / §1.1）；②§0 精确化交付状态为 `deliveryStatus.code = "rebuild_required"`（manifest 中为对象 `{code, label, detail}`，原 0.9 记 `deliveryStatus: rebuild_required` 为简化表述）；③§3.1 补注「练习页/复习页默认优先级不对称」为 Owner 决策 1/2 的刻意结果，并要求 `resolveAnswerMode` 单测锁定该语义；④§4 阶段 A 退出验收补「默认偏好 → 练习页 silent 优先、text 兜底」分支用例；⑤复核确认 ValidationVoiceEntry / VoiceInputPanel 全仓库无页面接线（仅组件互引 + 测试文件引用），「已存在未接线」复用判断成立）
> 文档版本 0.9 注：0.9（2026-08-12 核对修订：确认三态 Router 本体实现于 **worker 侧** `workers/ai-worker/src/handlers/`（companion-dialogue-router / companion-dialogue / companion-action），0.8 仅将其列于 api 模块——§1.1 / §3.4 / 附录 A 已补齐实现位置与核对范围；§0 的「36 项非 verified」标注出处 `11-1-dod-verification.md`）
> 文档版本 0.8 注：0.8（2026-08-12 现状重走查修订：桌宠 Dialogue Router 三态已在未提交工作区实现，§1.1 / §3.4 / §4 阶段 D / 附录 A 从「实现」改为「核对 + 接线」；阶段 A 补充复用已存在未接线的 ValidationVoiceEntry / VoiceInputPanel）
> 日期：2026-08-12
> 审计基线：`v1.0` / `c73f9ea` + 当前未提交工作区（349 个未提交改动——1.0 复核实测，会话快照、实施开工前以当时 git 状态为准；其中桌宠对话体系 `companion-conversation/` + `features/companion-pet/` 已实现——0.8 版已据此重走查）
> 关联方案：本文档是「AI 学习伴侣驱动的多模态理解宇宙」[`learning-companion-multimodal-understanding-universe.md`](../learning-companion-multimodal-understanding-universe.md) 的**实施接线补充方案**，只解决该方案族中「学习卡练习 + 复习」两个页面尚未接线的多模态落地缺口；不新增第二套 Session/Scene/reducer/scheduler，不改写既有 canonical validation/review/scheduler 业务真相
> 直接沿用（不再重复冻结）：[`00-2-core-decisions.md`](./00-2-core-decisions.md)（五个不可退让决策）、[`01-2-session-scene-artifact-trust-contracts.md`](./01-2-session-scene-artifact-trust-contracts.md)（Scene 三对象 / 六 facet / disposition 矩阵）、[`01-5-metrics-cost-gates.md`](./01-5-metrics-cost-gates.md)（指标/成本）、[`02-2-rls-matrix.md`](./02-2-rls-matrix.md)（RLS/权限）、[`03-2-prepare-session-lifecycle.md`](./03-2-prepare-session-lifecycle.md)（PREPARE 冻结与 journeyPlan）、[`03-6-budget-epoch-kill.md`](./03-6-budget-epoch-kill.md)（会话预算/epoch）、[`04-1-voice-pipeline.md`](./04-1-voice-pipeline.md)（语音作答）、[`04-2-voice-artifact-governance.md`](./04-2-voice-artifact-governance.md)（音频数据治理）、[`04-3-trust-reducer.md`](./04-3-trust-reducer.md) / [`04-4-assessment-critic.md`](./04-4-assessment-critic.md)（独立评估）、[`05-1-silent-proof-profile.md`](./05-1-silent-proof-profile.md)（静音结构化证明）、[`05-2-scene-runtime.md`](./05-2-scene-runtime.md)（Scene 运行时确定性 safety）、[`06-2-episode-commit-outbox.md`](./06-2-episode-commit-outbox.md)（commit/outbox）、[`06-6-transfer-minimal-slice.md`](./06-6-transfer-minimal-slice.md)（transfer 情境）、[`07-5-learning-card-four-entries.md`](./07-5-learning-card-four-entries.md)（四入口共享内核）、[`07-8-cross-device-recovery.md`](./07-8-cross-device-recovery.md)（跨设备恢复）、[`07-9-preferences-feedback.md`](./07-9-preferences-feedback.md)（偏好）、[`10-1-capability-deployment.md`](./10-1-capability-deployment.md)（capability/flag 门禁）、[`13-desktop-pet-ai-learning-companion-reconstruction.md`](./13-desktop-pet-ai-learning-companion-reconstruction.md) §7.2（Dialogue Router 三态）
> 范围：学习卡练习页（`/cards/[id]/companion`）、复习页（`/review` 与 `/review/[scheduleId]`）、桌宠 Dialogue Router 学习动作的核对与接线（三态已实现，未提交）、两者共用的作答模态运行时
> 不在本次范围：重写既有 validation/review/scheduler 业务真相；引入 XP/streak/排行榜式外在激励；新增第二套运行时模型

---

## 0. 结论先行

**问题**：当前学习卡练习和复习的**用户路径上只有一种作答方式——手动敲字**（练习页 `<textarea>` +「闭卷回忆」徽标，复习页 `ValidationFocus` 的 `<textarea>`）。这与 Owner 设计伴星时的原始意图（不敲字也能完成主路径、多种题型、AI 伴星推动复习与学习、不呆板）不符。

**根因**：不是没有蓝图，而是**蓝图停在合同层**。语音 Teach-back（04-1）、静音结构化证明（05-1）、transfer 情境（06-6）、练习级识别/拖拽（00-2 / 05-3）、Supervisor 编排（03）全部已冻结，但都没有接到这两个页面的真实 UI 上；桌宠 Dialogue Router（13 §7.2）三态已在未提交工作区实现（Router 本体 `workers/ai-worker/src/handlers/`：companion-dialogue-router / companion-dialogue / companion-action；api 侧 `apps/api/src/modules/companion-conversation/` 承载消息持久化与 action proposal/confirm bridge；前端 `features/companion-pet/`），但学习动作尚未与复习/卡片 typed route 完成核对与接线验收。学习伴侣 v1 交付状态 `rebuild_required`（`release-manifest.json` `deliveryStatus.code = "rebuild_required"`——manifest 中为对象 `{code, label, detail}`，1.0 精确化；36 项 DoD 中 14 项非 verified——口径出自 `11-1-dod-verification.md` 2026-08-11 审计）正是这一断层的硬证据。

**本方案做什么**：把已冻结的多模态构件**接成用户可见路径**——学习卡练习页和复习页各自扩展为一套「作答模态运行时」（voice teach-back / silent structured proof / transfer 情境 / 文字），由 Supervisor 按 Key Point 资格与用户偏好编排；核对并接线桌宠 Dialogue Router 的 `learning_question / learning_action` 三态（已实现，未提交），把学习动作引导进这两条路径。

**本方案不做什么**：不把练习级互动冒充理解；不引入 XP/streak；不新增运行时主链。所有正式 outcome 仍由独立 Assessment Critic + 确定性 reducer 决定，伴星只 propose 不直接写真相。

**决策速览（§7 详录）**：

| Owner 决策 | 结论 |
| --- | --- |
| 1 复习主模态 | **text 默认、voice 可选** |
| 2 silent 覆盖 | **三个 family 全部接入正式航程** |
| 3 learning_action 释放 | **web 端 typed route 先行**，桌面端 P5 门禁 |
| 4 模态偏好 | **全局**（设置 → 伴星，跨设备一致） |

**模态 × 页面**：练习页 = voice/silent（一等正式）＋ transfer（gate 通过）＋ text ＋ practice 徽标；复习页 = text（默认）＋ voice（可选）＋ facet-only（practice）。

---

## 1. 现状与缺口

### 1.1 用户路径现状（只读走查，2026-08-12；0.8 版重走查）

| 页面 | 当前用户路径 | 现状证据 |
| --- | --- | --- |
| 学习卡练习页 `/cards/[id]/companion` | `creating → ready → submitting → assessing → result/timeout/error`；作答只有 `<textarea>`「闭卷回忆」 | `apps/web/app/(workspace)/(focus)/cards/[id]/companion/page.tsx:474-481` |
| 复习队列 `/review` | v0.6 neutral queue：只展示到期顺序/原因/时间，内容在 question-first 流程内揭示 | `apps/web/app/(workspace)/(default)/review/page.tsx` 头部注释 |
| 复习作答 `/review/[scheduleId]` 与验证页 | 文字 `<textarea>` 提交 → 逐点评估 | `apps/web/components/ValidationFocus.tsx:1707` |
| 桌宠 Dialogue Router | **已实现、未提交**（casual_chat 对话 turn、learning_question grounded tutor grant、learning_action 候选提案/确认/导航映射均已落地）；尚未与复习/卡片 typed route 做合同核对与验收 | `workers/ai-worker/src/handlers/`（companion-dialogue-router 三态分类 / companion-dialogue / companion-action）、`apps/api/src/modules/companion-conversation/`（turn-service / conversations-service / learning-action-bridge / proactive-service / trigger-bridge）、`apps/web/features/companion-pet/`（PetMenu 候选菜单 / PetConfirmationCard 提案确认 / chat client / voice）；git 工作区 349 个未提交改动（2026-08-12 复核实测，会话快照） |

### 1.2 缺口分解

| Owner 诉求（原始意图） | 现状 | 缺口 |
| --- | --- | --- |
| 有些用户不想手动敲字 | 主路径强制文字 | 语音 Teach-back、静音结构化 proof 未接入作答 UI |
| 多种题型 | 只有「闭卷回忆」文字题面 | 已冻结的 Scene 种类（排序/修复、关系重建/条件变式、开放构建/情境应用、语音复述、识别型点击）没有 renderer 与入口 |
| AI 伴星引入学习卡/复习，帮助推动复习与学习 | 桌宠对话体系已实现（未提交），但学习动作未接到复习/卡片 typed route 并验收 | 三态 Router 已落地，需按 13 §7.2 合同核对；`learning_action` 的复习/卡片路由接线与验收未完成 |
| 不呆板（游戏感） | 队列 + 文字表单 | 内在反馈（facet 级反馈、模态多样、结果解释）未落地；且要**明确不走** XP/streak 式外在激励 |

### 1.3 为什么「文档没提及」

文档**有提及**，只是术语不同、且未接线：

- 「不想敲字」在 [`00-decision-and-scope.md`](./00-decision-and-scope.md) §1.2/§2.3 被列为必须解决的问题（「无打字是完整主路径」）；
- 「多种题型」在 [`01-2`](./01-2-session-scene-artifact-trust-contracts.md) §8 表现为**六 facet + SilentProofProfile 三个 family**，在 [`06-6`](./06-6-transfer-minimal-slice.md) 表现为 transfer 三种形态；
- 「游戏化」被明确**重新定义为内在反馈**（探索/操作/反馈/真实变化），XP/streak/每日关卡/成就/抽卡全部列入非目标（`00-decision-and-scope.md` §2.4、`00-2` 决策 3「不把小游戏成绩冒充理解」）；
- 「AI 伴星推动」在 [`07-5`](./07-5-learning-card-four-entries.md)（journeyHint/Supervisor 编排）与 [`07-7`](./07-7-grounded-tutor.md)（有界 Tutor detour）中已冻结。

因此本文档不发明新概念，只做**接线**：把这些已冻结构件接到学习卡练习页和复习页的用户路径上，并核对/接线桌宠 Dialogue Router 的学习动作侧（实现已在未提交工作区，13 §7.2 落地）。

---

## 2. 目标、不变量与边界

### 2.1 目标

1. **不敲字能完成主路径**：语音 Teach-back 与静音结构化 proof 成为与文字平级的正式作答模态；
2. **多种题型**：练习页与复习页按 Key Point 资格渲染不同 Scene（题型），不再只有单一文字题面；
3. **伴星推动复习与学习**：Supervisor 编排「本轮怎么学」（journeyHint 的实质内容），桌宠 Dialogue Router 把自然语言意图转成 typed 学习动作进入这两条路径；
4. **不呆板但诚实**：内在反馈（facet 徽标、模态切换、结果解释、真实变化投影）替代外在激励；练习级互动永远只记练习。

### 2.2 不变量（与 00-2 五决策 / 复杂度预算一致，只接线不松动）

| 不变量 | 在本方案中的落实 |
| --- | --- |
| 不以打字为默认前提 | 练习页正式航程以 silent/voice 为一等作答（决策 2）；复习页按 Owner 决策 1 以 text 为默认、voice 可选——「不强制打字」体现在各模态**可用**而非默认选择 |
| 不把学习伴侣做成聊天框 | 学习动作走 typed proposal + Scene，不走自由聊天；桌宠 `learning_action` 必须先 proposal + user confirmation |
| 不把小游戏成绩冒充理解 | 识别型点击/提示后完成/纯浏览只产生 practice 事件；结构化 proof 需 eligibility + 跨模态 Gold；voice 需覆盖全部 required rubric 才 `mastery_eligible` |
| 不让 Agent 直接写学习真相 | 正式 outcome 只由独立 Assessment Critic + 确定性 reducer/commit 写入；伴星/Supervisor 只 propose 与编排 |
| 全站可达不等于全站打扰 | 模态按资格与偏好提供，不强制、不默认全开；可整体关闭回纯文字 |
| 一条主链 / 一套模型 | 本方案只新增「前端 renderer + 入口接线」，不新增第二套 Session/Scene/Artifact/reducer/scheduler 写路径 |
| 上线门禁与回退 | 各模态与 `learning_action` 走既有 capability/flag 门禁（10-1）；关闭 capability 即整体回到现状 text 路径；成员权限沿用既有 RBAC（02-2，验证/复习授权面），不新增权限面 |

### 2.3 边界（非目标）

- 不引入 XP / 金币 / 等级 / 宝箱 / 抽卡 / 随机奖励 / 体力 / 内容锁 / streak / 断签惩罚 / 红色逾期债务 / 固定每日目标 / 排行榜；
- 不重写既有 canonical validation / review / scheduler 业务真相，不做数据迁移；
- 不把「选择题题库」作为正式理解判定的替代（纯选择题不能可靠证明理解，00-2）；选择题/识别型点击只用于练习与诊断；
- 不新增本地/端侧 ASR 或流式 TTS 实现（沿用既有 provider 管线 04-1 与 edge-tts/SiliconFlow 接线）；
- 不把桌宠学习动作做成「角色直接判卷」或「角色直接改卡片」。

---

## 3. 设计

### 3.1 作答模态矩阵（v1）

| 模态 | 用户交互 | 最大信任等级 | 依据（已冻结） | 落到哪个页面 |
| --- | --- | --- | --- | --- |
| `text`（文字，现状） | 闭卷文字回答 | 现状同构（rubric 覆盖 → mastery_eligible） | 01-2 | 练习页 + 复习页 |
| `voice`（语音 Teach-back） | 按住说话 20–60s → ASR 逐字 → 确认/重录/换模态 | 覆盖全部 required rubric/facets 才 `mastery_eligible`；关键术语低置信 → `not_assessable` | 04-1、01-2 §8.3 | 练习页（一等作答）；复习页（**可选模态，决策 1**） |
| `silent`（静音结构化 proof） | 排序/修复、关系重建/条件变式、开放构建/情境应用（≥2 互补 Scene，无中途反馈） | eligibility=eligible 且过跨模态 Gold 才与同级 canonical outcome 等价；否则 `facet_eligible` | 05-1、01-2 §8.2/§8.3 | 练习页（Key Point 级激活）、复习页 facet-only |
| `transfer`（情境应用） | 单 Key Point 情境题 / 故障修复 / 边界变式 | 默认 `record_only`（0 schedule 副作用）；official policy 签发才可影响 schedule | 06-6 | 练习页（rubricComplete+evidenceComplete 才开放） |
| `practice`（练习级互动） | 识别型点击、拖拽/tap-select（05-3）、提示后完成、Tutor 引导 | 只能 practice/diagnostic 事件；不升级、不延长 interval | 00-2 决策 3、05-3、07-7 | 练习页「练习模式」徽标入口 + 复习页 facet-only 交互 |

**编排规则**（Supervisor 侧，新增纯函数 `resolveAnswerMode`，不写真相）：

```
输入：keyPointId + rubricComplete + evidenceComplete + structuredProofEligibility
      + userPreference（voice/silent/text/任意）+ session 上下文（cooldown/exposure）
输出：{ mode: "voice"|"silent"|"text"|"transfer"|"practice", scenePlan, trustCeiling }
规则：
  1. cooldown 窗口内（内容工具暴露后）→ 一律 practice，trustCeiling=practice；
  2. 到期复习项：**默认 text**（Owner 决策 1）；仅当 userPreference=voice 或用户当次主动选择
     voice 时才走 voice，缺 provider/拒用/环境噪音 → 自动落回 text；
  3. 练习页正式航程：userPreference=voice → voice；userPreference=text → text
     （显式 text 偏好优先，不被 silent 抢跑，与决策 4「偏好=优先」语义一致）；否则
     silent（eligible 且过 Gold）；否则 transfer（gate 通过）；否则 text
     ——voice/silent 均为练习页一等正式模态；
  4. 任何模态不可用时 fail-open 到 text，不允许「无路可走」。
```

> 注（1.0）：练习页与复习页的默认优先级不对称是 Owner 决策 1/2 的刻意结果——练习页未设偏好时 silent 优先、text 兜底（「不以打字为默认前提」）；复习页 text 默认、voice 可选。`resolveAnswerMode` 单测须锁定该不对称语义（见 §4 阶段 A 退出验收）。

### 3.2 学习卡练习页改版（`/cards/[id]/companion`）

1. **主行动不变**：仍只有「开始/继续一小段航程」一个主按钮（07-5 §2），点击后不直接进文字题面，而是先 `PREPARE` 拿到 `journeyPlan`（模态 + Scene 序列 + 每步 trustCeiling）；
2. **Scene 渲染器 registry**（新增前端构件 `scene-renderer-registry.ts`）：按 `scene.kind` 分发渲染——现有文字题面 renderer + 语音 Teach-back renderer（04-1 管线：录音 → 逐字确认 → 提交）+ silent Scene renderer（复用 `05-1` 六个 Scene 结构与已存在的 `components/learning-companion/TapSelectPlaceLayer.tsx` 拖拽/tap-select 层）+ transfer renderer（06-6 三种形态）；
3. **阶段状态机扩展**：现有 `creating → ready → submitting → assessing → result/timeout/error` 增加 `modeSelect`（journeyPlan 呈现：本轮由伴星安排「语音复述 / 排序修复 / 情境应用」+ 可换模态）、`recording`、`transcriptConfirm`；result 页增加 **facet 级反馈**（六 facet 徽标：本 Scene 证明哪些、哪些未覆盖）与 **cooldown 明示**（内容工具暴露后进入冷却，显示「冷却后即可再独立验证」）；
4. **「练习模式」入口**（复用 07-5 内容工具区）：识别型点击/拖拽/引导练习一律带「练习模式 · 不影响进度」徽标（06-6 已有此约定），入口经 `resolveJourneyReadiness` 判定，冷却期内自动切 practice。

### 3.3 复习页改版（`/review`、`/review/[scheduleId]`）

1. **队列不变**：v0.6 neutral queue 保留（只展示顺序/原因/到期时间）；
2. **单条进入后由 Supervisor 选模态**：到期复习项进入 Focus 会话后，按 3.1 编排规则渲染作答——**text 为默认**（Owner 决策 1），voice 为可选模态（完整闭环：ASR → 确认 → 评估 → commit → schedule 更新），缺 provider 或用户拒用时自动落回 text；
3. **facet-only 复习**（01-2 §8.5 / §8.3）：复习中只完成 facet-only Scene 时，UI 明确显示「记录了这一项能力，本次复习时间未改变」，原 pending schedule 保持 active——不能因为换了题型就悄悄延长/完成间隔；
4. **复习结果页**：复用 completion summary 契约（07-5 §5），只接受 trusted 验证/复习事件进入能力/复习变化摘要；practice/contact 事件摘要为 0。

### 3.4 桌宠 Dialogue Router 学习动作核对与接线（13 §7.2 落地已存在，0.8 重走查）

> 0.8 修订：三态 Router 已在未提交工作区实现——**Router 本体在 worker 侧** `workers/ai-worker/src/handlers/companion-dialogue-router.ts`（casual_chat / learning_question 走 lexeme 预检不命中 → persona / grounded-tutor 分支；learning_action 预检命中 → classifier 只出 intent/confidence，另有 `companion-dialogue.ts` / `companion-action.ts` 承接），api 侧 `apps/api/src/modules/companion-conversation/`（turn-service / companion-conversations-service / learning-action-bridge / companion-proactive-service / companion-trigger-bridge / routes）承载消息持久化与 learning_action proposal/confirm bridge，前端 `apps/web/features/companion-pet/`（PetMenu 候选菜单、PetConfirmationCard 提案确认卡、companion-chat-client、PetRuntimeProvider、voice 全套）。`learning-action-bridge.ts` 已含 `NAVIGATION_KINDS` → `navigationRouteFor`（`review` / `card` / `star_map` 路由映射）、proposal 创建/确认与 `action_run` 落账。本小节从「实现」改为「**对照 13 §7.2 合同核对 + 接线验收**」（0.9 核对修订：0.8 仅将实现列于 api 模块，实际 Router 在 worker 侧，核对范围已补齐）。

1. **核对三态 Router**（`CompanionDialogueOrchestrator` 等价物，13 §7.2；**核对范围 = worker 侧三 handler `workers/ai-worker/src/handlers/`（companion-dialogue-router / companion-dialogue / companion-action）+ api 侧 `companion-conversation/` 的 bridge/持久化**）：逐项验证已实现代码满足合同——`casual_chat`（快回复）、`learning_question`（bounded/grounded 文字解释，无 mutation，对应 grounded tutor grant）、`learning_action`（typed proposal + user confirmation，无直接 mutation）；核对结果形成清单，缺项补实现。**web 端 `learning_action` 随本方案独立开放 typed route（Owner 决策 3）**——`bootstrap-service.ts` 的 `learningActions: dialogueEnabled && actionBridgeEnabled` 门禁已存在，核对开放条件即达；桌面端仍按 13 §7.2 P5 门禁释放；
2. **`learning_action` 候选集**（来自[`desktop-pet-handoff/03-conversation-api-data-proactive-contract.md`](./desktop-pet-handoff/03-conversation-api-data-proactive-contract.md) 03 合同；已实现候选 kind：`resume_session` / `start_session` / `review` / `card` / `star_map`）：「继续当前学习 / 开始一小段学习」「今日复习 / 回到当前卡片」——核对「点击只创建待确认 proposal、不直接 mutation、用户确认后走 typed route」三条约束：
   - 复习候选 → 打开复习队列/对应 schedule 的 Focus 会话（进入 3.3 模态运行时）；
   - 卡片候选 → 打开 `/cards/[id]` 主行动（进入 3.2 练习页）；
3. **proposal payload**（`companionProposalSnapshotV1Schema` / `ProposedLearningActionPayloadV1`）：核对 strict schema + 实时重新解析（13 §7.2），含 `route: "review"|"card"`、`targetId`、`origin`；确认菜单导航/本地开关绕过 LLM 直接走 typed IPC 或既有 account endpoint，自然语言不得直接执行系统命令；
4. **快回复与慢动作**（13 §7.3）：核对创建 Session/等待 Worker 时角色先「我来准备一下」，确认只代表已接收；完成后用真实结果生成展示话术，失败保留真实错误与重试入口。

### 3.5 关键旅程示例（验收场景，对应 00-6 旅程 A~F 的扩展）

**旅程 R（复习 · 语音可选）**：到期项进入 Focus 会话 → 默认文字题面（决策 1）；用户全局偏好为 voice 或当次点击「语音回答」→ 按住说话 20–60s → ASR 逐字 transcript → 确认/重录/换模态 → 独立评估 → commit → 结果页显示 schedule 结果；关键术语低置信 → `not_assessable`，无损重录不判为「不会」。

**旅程 P（练习 · silent 正式航程）**：学习卡「开始/继续一小段航程」→ PREPARE 返回 journeyPlan（本轮安排：排序+修复静音 proof）→ 无中途反馈完成两个互补 Scene → 跨模态 Gold 等价 → 结果页 facet 徽标（证明 procedure/boundary）→ 若此前用过内容工具，显示「冷却后可再独立验证」。

**旅程 T（练习 · transfer 情境）**：rubric 与 evidence 齐全的 Key Point → 主行动后 journeyPlan 安排「情境应用」→ 完成单 Key Point transfer Scene → 默认 `record_only`，结果页明示「本次未改变复习时间」；official policy 签发后才影响 schedule。

**旅程 D（桌宠 · learning_action）**：跟伴星说「帮我复习今天到期的」→ Dialogue Router 判定 `learning_action` → 展示待确认 proposal（今日复习）→ 用户确认 → typed route 打开复习 Focus 会话（进入旅程 R 模态运行时）→ 完成后角色用真实结果生成话术；全程无直接 mutation。

### 3.6 契约与数据流（沿用既有 frozen contract，不新增）

```text
PREPARE（03-2）──冻结 originRef / viewport / completion summary
   └─ journeyPlan：{ mode, scenePlan: SceneKind[], trustCeiling, journeyHint }
        ├─ text    → 现状文字 renderer（PublicSceneContract，01-2）
        ├─ voice   → 04-1 voice-service（TTS 净化题面 → ASR 逐字 → confirmTranscript）
        ├─ silent  → 05-1 registry 签发 eligibility → 无中途反馈 Scene（≥2 互补）
        ├─ transfer→ 06-6 transfer-gate（fail closed）
        └─ practice→ 00-2/05-3/07-7（只产生 practice 事件）
作答 → Response Artifact → 独立 Assessment Critic（04-4）→ 确定性 reducer（04-3）
     → disposition（01-2 §8.5）→ commit/outbox（06-2）→ 现有 canonical facts
exposure 落账（07-5 recordToolExposure）→ resolveJourneyReadiness 决定下一次 cooldown
```

任何模态都必须产出同一套 Response Artifact 并走同一条 reducer/commit 链——**多样性只在前端作答层，真相写入路径不变**。语音模态的音频原始数据按 04-2 数据治理生命周期管理（存储/TTL/删除/导出），canonical answer 是用户确认的逐字 transcript，原始音频不进入评估输入（04-1/04-2）；silent Scene 渲染遵守 05-2 确定性 safety（无任意生成 UI、禁止注入）。

### 3.7 关键失败路径（fail closed，不允许静默降级为「假通过」）

| 失败 | 行为 |
| --- | --- |
| ASR/TTS provider 不可用、录音权限被拒 | voice 入口禁用并提示，自动落回 text（决策 1） |
| ASR 关键术语低置信 | `not_assessable`，无损重录/换模态，不判为「不会」 |
| silent Scene 渲染失败或 eligibility 五证不全 | 该目标不展示 silent 路线（fail closed），可换 text/voice |
| transfer gate 未过（rubric/evidence 任一不全） | `unavailable`，0 学习/schedule 副作用（06-6） |
| 桌宠 learning_action proposal 超时/过期 | 丢弃并提示重新发起，不产生任何 mutation |
| 评估超时 | 沿用现有 assessing timeout 路径，保留重试入口，结果不落库 |
| 录音中离开/中断（切后台、锁屏、页面关闭） | 丢弃本次音频、不落库；会话状态按 07-8 跨设备恢复，可无损重录 |
| 会话预算/epoch 超限（03-6） | 按 budget/epoch 策略结束会话，不因模态切换重置预算导致无限续期；未提交结果不写真相 |
| 音频数据超过治理保留期（04-2） | 按 TTL/生命周期清理，删除与导出走既有审计路径；不因清理影响已 commit 的 transcript 事实 |

---

## 4. 实施顺序（阶段裁剪，每阶段有独立验收）

| 阶段 | 内容 | 依赖 | 退出验收 |
| --- | --- | --- | --- |
| A | 复习页接 voice Teach-back 纵切（**text 默认、voice 可选**：到期项 → 语音作答 → 确认 → 评估 → commit → schedule） | 04-1 已冻结 + ASR/TTS 真 provider（edge-tts 已接、SiliconFlow ASR 已接） | 真实浏览器走通一条语音复习且 text 路径行为不变；canonical write 与 schedule 落库可查；A11y 等价路径；`resolveAnswerMode` 单测覆盖：显式 text/voice 偏好分支（决策 4 语义）；默认偏好下「练习页 silent 优先、text 兜底 / 复习页 text 默认」的不对称语义（决策 1/2，见 §3.1 注） |
| B | 学习卡练习页接 silent structured proof（scene renderer registry + 六个 Scene UI + TapSelectPlaceLayer 复用）；**三个 family 全部接入正式航程（Owner 决策 2）** | 05-1 registry 三个 family 均 active + Gold hash | 三个 family 的 eligible 目标均能走 silent 正式航程；非 eligible 目标不展示该路线（fail closed） |
| C | transfer 情境题接入练习页 | 06-6 transfer-gate（rubric/evidence 双完才开放） | gate 未过 → unavailable 无副作用；gate 过后 record_only 默认不消费 schedule |
| D | Dialogue Router 三态**核对**（对照 13 §7.2/§7.3 合同验收已实现代码：casual_chat / learning_question / learning_action、proposal+confirm、无直接 mutation）+ `learning_action` → 复习/卡片 typed route 接线；**web 端 typed route 随本方案开放（Owner 决策 3）**，桌面端按 13 §7.2 P5 门禁 | 13 §7.2/§7.3、03 合同 | 核对清单全项通过（casual/learning_question 可用；web 端 learning_action 走 typed route、无直接 mutation），缺项已补实现；桌面端未达 P5 门禁不开放 |
| E | 偏好与收尾：**模态偏好全局设置（设置 → 伴星，跨设备一致，Owner 决策 4）**、cooldown 全链路、移动端布局、真实 E2E、A11y/故障审计 | A–D | 与 11-1 DoD 同口径证据（真实运行样本、非注入式验证） |

> 顺序原则：A 先行（复习是到期压力点，voice 闭环收益最大且依赖最完整）；B/C 并行于 A 之后；D 依赖前两者给出可引导的候选集；E 全程贯穿。

### 4.1 实施登记（2026-08-12 会话）

| 阶段 | 状态 | 落地内容 | 验证 | 遗留/依赖 |
| --- | --- | --- | --- | --- |
| A | ✅ 完成 | `resolveAnswerMode`（features/companion/answer-modes/）+ 25 单测；复习页 voice 可选模态（VoiceTeachBackScene 录音→ASR 逐字→确认→复用 submitValidationAnswer 链；`transcribePlain` 对齐真实 /voice/transcribe 契约）；门禁 `isReviewVoiceEntryEnabled`（fail-closed） | web 995/995、tsc 干净 | 真实浏览器 E2E 需 ASR provider 环境（本会话无浏览器/容器） |
| B | ✅ 完成（已真正接线） | `scene-renderer-registry.tsx` + `SilentProofScene.tsx`；**服务端 journeyPlan 下发**（`journey-plan.ts` buildJourneyPlan：silent/voice/transfer/facet/practice 编排 + scenes public 数据）；**确定性 Scene Author**（`silent-scene-author.ts`：从 canonical claim 拆句生成 ordering/repair，createSession 时冻结进 formalPlan）；练习页 modeSelect 直接消费 journeyPlan（SilentProofSceneList 渲染 + submitSilentProof 走既有 answer 链） | api 3035/3035（journey-plan 10 + silent-scene-author 7）、web 990/990、双端 tsc 干净 | W4 完整 Scene Author（LLM 场景生成）接入后替换确定性生成器 |
| C | ✅ 完成（已真正接线） | `TransferScene.tsx` 三形态 + record_only 明示；transfer gate 由服务端 journeyPlan 编排（rubric/evidence 双完才 mode=transfer）；前端 modeSelect 消费 | 同上 | rubric/evidence 真实判定需评估 critic 产出（当前 PREPARE 冻结为 pending 占位 → transfer 默认不激活；Scene Author/评估接入后由真实 rubric 驱动） |
| D | ✅ 核对通过 | 13 §7.2/§7.3 合同核对清单（`docs/evidence/learning-companion/14-dialogue-router-contract-check.md`，6 组 20+ 项全通过、无缺项）；web typed route 开放条件已具备（决策 3）；D2 的 learning-action-client 由既有 `companion-pet/learning-actions.ts` 覆盖且已接线 | worker 1058/1058、api 3008/3008、web 995/995 | 桌面端保持 P5 门禁未开放（符合 13 §7.2） |
| E | ✅ 完成 | 模态偏好全链路：shared schema + GET/PATCH `/me/companion/answer-mode-preference`（account 级跨设备，决策 4）+ 设置页「默认作答方式」radio + practice-mode-select 接入 userPreference | api 3016/3016（+8）、web 995/995（+6）、双端 tsc 干净 | 复习页 voice 偏好接入（读偏好 → resolveAnswerMode userPreference）可作后续增量 |

> 注（2026-08-12 接线修订）：B/C 的 silent/transfer 此前因服务端 journeyPlan/scene 数据未下发而保持 fail-closed 不展示（§3.7）；按用户要求「做完验证没问题就直接接进去，不留未接半成品」，已补服务端数据流——episode public view 下发 journeyPlan（含 scenes public 数据），silent 场景由确定性 Scene Author 从 canonical claim 生成，前端直接消费并提交（走既有 answer 链）。transfer 仍由服务端 rubric/evidence 完整度 gate（当前 PREPARE 冻结为 pending → 默认不激活，待真实评估产出后自动开放）。真实浏览器 E2E 需 ASR provider（SiliconFlow）环境，本会话以项目级单测 + typecheck + 真实端点契约核对替代。

---

## 5. 验收标准（与既有 Gate 同口径）

1. **真实性**：每条互动调用真实生产端点（04-1 voice-service / 05-1 registry / 06-6 transfer-gate），返回真实 public contract，前端呈现与后端状态一致，关键动作产生可检查的 database/canonical event 结果；
2. **不伪造理解**：练习级互动 0 条进入 mastery/schedule 写路径；`not_assessable`（如关键术语低置信）无损重试且不判为「不会」；
3. **诚实调度**：facet-only 复习不消费 schedule 且 UI 明示；`record_only` transfer 不缩短/延长 interval；
4. **A11y**：voice 有文字等价路径，silent Scene 有键盘/tap-select/读屏等价路径（05-3 约束），reduced-motion 可静态切换；
5. **桌宠边界**：learning_action 无直接 mutation（先 proposal + confirmation）；自然语言不执行系统命令；
6. **回归**：既有文字路径（现状 question-first）行为不变；web/worker/desktop typecheck、单测、真实浏览器 E2E、docker 环境验证全绿；
7. **文档同步**：本方案已 Approved；索引登记（`docs/plans/learning-companion-multimodal-understanding-universe.md` 文档地图与 `project-archive/plans/README.md`）待既有索引文档稳定后补充，状态变化必须同步（见治理规则）；
8. **隐私与数据治理**（04-2）：音频原始数据按生命周期管理（存储/TTL/删除/导出可审计），canonical transcript 与音频隔离；录音中断/离开页面不落库；语音数据不进入评估输入；重录/换模态不产生理解副作用；
9. **门禁与回退**：各模态与 `learning_action` 由 capability/flag 控制（10-1），关闭后回到现状 text 路径；不因新增模态改变既有 RLS/权限面（02-2）；成本增量在 01-5 预算内可监测。

---

## 6. 风险与依赖

| 风险/依赖 | 等级 | 缓解 |
| --- | --- | --- |
| ASR/TTS 真 provider 稳定性（voice 是复习**可选**模态） | 中 | 沿用 04-1 fail-closed 策略：provider 不可用 → 自动 fall-back text，不允许卡死 |
| Silent Scene UI 工作量（六个 Scene × 三视口 × A11y，三个 family 全上） | 中 | B 阶段按 family 分三条纵切依次交付（排序+修复 → 关系重建+条件变式 → 开放构建+情境应用），各自过 eligibility/Gold 后开放；Renderer 复用 TapSelectPlaceLayer |
| 桌宠 `learning_action` 的桌面端 P5 门禁未到 | 低 | web 端 typed route 随本方案先行交付（Owner 决策 3）；桌面端按 13 §7.2 门禁条件释放，不提前 |
| 模态编排复杂度侵入既有状态机 | 低 | `resolveAnswerMode` 为纯函数；现有 stage 状态机只增量扩展，不改既有 transition 语义 |
| 与并行桌宠实施冲突 | 低 | 桌宠侧三态 Router 已实现（未提交）；阶段 D 以核对 + 接线为主，不重复实现；实现位置 `companion-conversation/` + `features/companion-pet/` 已与 desktop-pet-handoff 对齐 |
| voice 上线后 ASR/TTS 调用成本上升 | 低 | 按 01-5 成本预算监测；voice 非默认（决策 1）增量受控；silent 模态无 LLM 成本 |

---

## 7. Owner 决策记录（2026-08-12 已确认，本方案据此定稿）

1. **复习主模态**：**text 默认、voice 可选**——voice 不作为复习默认模态；仅当用户全局偏好为 voice 或当次主动选择时启用，provider 不可用/拒用自动落回 text（§3.1 规则 2、§3.3 第 2 条）。
2. **silent 正式航程覆盖范围**：**三个 family 全部接入正式航程**（`procedure` / `causal-boundary` / `concept-application`，registry 均 active + Gold）；各自 eligibility 五证与跨模态 Gold 仍为硬门槛（§4 阶段 B）。
3. **桌宠 learning_action 释放时机**：**web 端独立开放 typed route**（随本方案交付，不绑桌面端 P5 门禁）；桌面端仍按 13 §7.2 P5 门禁释放（§3.4、§4 阶段 D）。
4. **偏好入口**：**全局**——模态偏好存「设置 → 伴星」，跨设备一致（对齐 00 阶段 §11 偏好）；页面内不提供持久化切换（§4 阶段 E）。

---

## 附录 A：本方案新增/改动文件清单（规划，按实施阶段归属）

| 文件 | 阶段 | 说明 |
| --- | --- | --- |
| `apps/web/features/companion/answer-modes/resolve-answer-mode.ts` | A | 编排纯函数（3.1 规则）+ 单测；后续阶段复用 |
| `apps/web/components/learning-companion/scenes/VoiceTeachBackScene.tsx` | A | 04-1 管线前端：录音 → 逐字确认 → 提交 |
| `apps/web/components/learning-companion/ValidationVoiceEntry.tsx` / `VoiceInputPanel.tsx`（**已存在未接线**） | A | 复用为复习页 voice 入口（voice ↔ text ↔ proof 接线层），不重复造轮子 |
| `apps/web/app/(workspace)/(focus)/review/[scheduleId]/page.tsx` | A | 模态接入（text 默认/voice 可选）+ facet-only 明示 |
| `apps/web/components/learning-companion/scene-renderer-registry.tsx` | B | 按 scene.kind 分发 renderer |
| `apps/web/components/learning-companion/scenes/SilentProofScene.tsx` | B | 复用 TapSelectPlaceLayer；三个 family 六 Scene |
| `apps/web/app/(workspace)/(focus)/cards/[id]/companion/page.tsx` | B | 状态机扩展：modeSelect/recording/transcriptConfirm + facet 反馈 |
| `apps/web/components/learning-companion/scenes/TransferScene.tsx` | C | 06-6 三种形态（情境/修复/边界变式） |
| ~~`apps/api/src/modules/learning-sessions/dialogue-router.ts`~~（**不新建**） | D | 三态 Router 已实现于 **worker 侧** `workers/ai-worker/src/handlers/`（companion-dialogue-router / companion-dialogue / companion-action）；api 侧 `apps/api/src/modules/companion-conversation/`（learning-action-bridge / turn-service / conversations-service）承载消息持久化与 proposal/confirm bridge；产出「13 §7.2 合同核对清单」+ 缺项补丁 + 单测 |
| `apps/web/features/companion/api/learning-action-client.ts` | D | proposal/confirm typed client（web 端先行） |
| 桌宠侧 Dialogue Router 核对与接线 | D | 核对 `companion-conversation/` 与 `features/companion-pet/` 已实现代码（未提交）＋ `apps/desktop` 接线；桌面端按 13 §7.2 P5 门禁；不重复实现 |
| `apps/web/app/(workspace)/(default)/settings/page.tsx` | E | 模态偏好全局设置（设置 → 伴星，跨设备一致） |

> 本清单为规划，不构成对任何文件当前状态的修改授权；每阶段开工前按对应文档的验收标准执行。
