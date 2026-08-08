# 阶段 05（W4）：Structured Scene Runtime 与静音 mastery profile qualification

> **第一层执行顺序第 5 步**
> 前置：阶段 04（W3）与阶段 02（W1 动画引擎 spike）
> 后置：阶段 06（W5 单 Key Point 纵切）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W4」；规范依据：§6.1~§6.6（多模态交互与 Scene DSL）、§7.4（SilentProofProfile）、§13.4（A11y）、§5.2（角色动画）、§5.3（spatial actions）、§5.4.2/§5.4.4/§5.5（Global Shell 基础设施）。

---

## 本阶段目标

实现 Structured Scene Runtime 与最小 `SilentProofProfile` registry，交付伴星基础角色动画和 Global Shell 前端基础设施，并在开发资格集上完成第一轮 blinded cross-modality qualification。

## 可并行执行的任务（第二层）

### 任务 05-1：最小 SilentProofProfile registry 与 eligibility matrix（§7.4）

**交付物**：按 W0 eligibility/coverage matrix 完成的最小 `SilentProofProfile` registry；每个合格 bundle 至少两个互补 Scene（从 Ordering、Relation Canvas、Repair、开放构建与条件情境中组合）。

**任务内容（原文 §7.4，W4 bullet）**：

- `SilentProofProfile` 是 versioned 资格模板，不是对所有知识通吃的小游戏；初始 family：procedure（排序 + 修复）、causal/boundary（关系重建 + 条件变式）、concept/application（开放构建 + 情境应用）；实际启用 family 由 W0 corpus audit 与 Gold 决定；
- 每个 `structuredProofEligibilityReport` 必须证明：全部 required facets 可由未泄漏答案的结构证据覆盖、公开 token 不覆盖所声称的 recall、任务具有足够区分度、A11y 等价操作不降低语义要求、该 profile 已通过独立 Gold；
- 公测 silent route 采用 Key Point 级激活：100% 被路由到 structured proof 的目标必须 eligibility=`eligible`；W0 冻结整体与各内容 family 最低覆盖率；
- Relation Canvas 只操作当前 Key Point 的冻结 Scene 结构，不创建共享 semantic relation；
- 开发资格集与 W8 冻结 RC 集不重叠。

**验收**：profile-eligible 目标清单与覆盖率门槛落实；无 eligible profile 的目标不展示 silent mastery 路线。

---

### 任务 05-2：Structured Scene Runtime（§6.3 + §6.4）

**交付物**：Scene schema 实现、public/private payload、deterministic scorer、response/action digest、锁定和恢复；`scene-safety-v1` 与 `Scene Activation Service`。

**任务内容（原文 §6.3/§6.4，W4 bullet）**：

- Scene 类型：`VoiceTeachbackScene / OrderingScene / RelationCanvasScene / RepairScene / MultiStepScenarioScene / CounterexampleScene / OptionalTextScene`；
- 每个 Scene 冻结：scene/template/version、target IDs、source fingerprint、capability facet、public/secret 独立 hash/version、allowed token/node/edge/option IDs、`disclosureProfile`、逐 rubric evidence binding、assistance policy、template trust ceiling、反馈时点、distractor/branch/最大操作次数、A11y 等价路径；
- 物理拆分三对象：`PublicSceneContract`（可返回客户端）/ `PrivateSceneSolution`（仅服务端）/ `PrivateLearningEpisodeContract`（仅服务端）；客户端只得到净化 Session/Scene view；
- 每个动态 formal Scene 激活前执行 `scene-safety-v1`：schema、public/secret 分离、allowlisted IDs、答案泄漏、可评估性、唯一解或有效多解、distractor 区分度、事实支撑、prompt injection、语言和 A11y 检查，并 mandatory 调用独立 Rubric/Scene Critic；只有完全静态且带不可变 certification hash、内容槽位仍通过 deterministic allowlist 的模板可复用历史 approval；失败最多修复一次，仍失败则 `question_retryable/blocked`；
- 唯一激活权限属于 deterministic `Scene Activation Service`：事务内验证 Scene Author staging、`scene-safety-v1`、Critic=`approved` 或合法静态 certification、public/private/solution/disclosure hashes、planHash、epoch 与 BudgetEnvelope，写入一次 immutable active contract；Author、Supervisor、Critic 和 Companion 都没有 `activate_scene_contract` 权限；
- 无即时泄题的 formal mode 与可即时反馈的 practice mode 两态；
- 各模态最高可信资格（§6.4）：语音讲解 → `mastery_eligible`；无提示排序/拖拽连线/故障修复/多步情境单 Scene → 最高 `facet_eligible`；普通单选/判断/配对 → `diagnostic_only`；提示后 → `practice_only`；关键输入无法可靠解析 → `not_assessable`；等价 Gate 通过前所有结构 Scene 最高只为 `facet_eligible`。

**验收**：任意 UI/code 生成不可达；未审核 Scene 无法展示；public payload 零 private 字段。

---

### 任务 05-3：拖拽替代与 A11y 等价操作（§6.6 + §13.4）

**交付物**：tap-select-place、键盘、读屏和 reduced-motion 完整支持。

**任务内容（原文 §6.6/§13.4，W4 bullet）**：

- 所有拖拽提供：点选对象 → 选择动作 → 点选目标的等价路径；键盘移动、连接、撤销和锁定；screen reader 可理解的节点、关系和顺序描述；Switch Control/单手操作的足够大目标；reduced-motion 下无飞行动画的静态变化；无计时评分、无精确拖拽速度评分；
- 触控目标至少 44×44 CSS px；200% zoom 不丢功能；390/768/1440 三视口无主路径阻断；颜色、空间位置和动画不是唯一信息载体；
- 键盘、tap-select-place、screen-reader 和 reduced-motion 等价路径属于每个 Scene 的冻结项。

**验收**：全部 Scene 类型通过键盘/读屏/reduced-motion 验收；拖拽不是唯一操作方式。

---

### 任务 05-4：伴星基础角色与动画实现（§5.2/§5.3）

**交付物**：统一拟人化基础角色、`CompanionVisualStateV1`、必要状态动画、spatial actions、`assessment_handoff` 与移动端/静态降级。

**任务内容（原文 §5.2/§5.3，W4 bullet）**：

- 基础角色：年轻星际导航员（约 2.5~3 头身、发光星纹、短披风或围巾式彗尾、可变形的导航环）；二维动画造型、干净色块、柔和描边；公测只交付一个统一基础角色；使用可交互的二维骨骼/矢量状态机（W1 spike 选定引擎），静态 PNG/WebP fallback；
- `CompanionVisualStateV1` 状态（完整边界见阶段 01 任务 01-8）：`dormant / invite_once / navigate / present_evidence / listen / co_manipulate / explain / assessment_handoff / committed_change / uncertain_or_retry / exit_or_hidden`；动画只能表达已经发生的系统状态，不能伪装评估进度或 canonical 结果；
- `assessment_handoff`：收起提示工具、后退到场景边缘、独立"观测环"接管验证状态，通过可见退场表达"伴星导航员不参与判分"；
- 伴星优先使用 typed spatial actions（§5.3）：`focus_nodes`、`draw_route`、`stage_scene`、`read_prompt`、`offer_branch`、`show_change`、`return_to_origin`、`end_session`（`propose_curiosity_save` 为 Should）；模型不能返回任意 DOM、CSS、HTML 或脚本；
- `reduced-motion` 下取消飞行、弹性缩放、视差和持续漂浮；角色/动画/音频加载失败时通过静态角色立绘、图标化手势和标准控件继续可用。

**验收**：动画状态与真实 Session/assessment/commit 状态一致；静态降级下完整学习功能可用。

---

### 任务 05-5：Global Shell 前端基础设施（§5.4.2/§5.4.4/§5.5）

**交付物**：安静锚点、侧板/移动端底部面板、全部 versioned 控制状态、context-off/hidden/off 的 observer/context 零构造、焦点恢复和 `PageCompanionContextV1` adapter 基础设施。

**任务内容（原文 §5.4.2/§5.4.4/§5.5，W4 bullet）**：

- 全局呈现形态：安静锚点（静态中性图标/小立绘固定于应用导航区或内容安全边缘，只提供召唤入口；不播放 idle 动画、不闪烁、不发声、不显示未读红点）、就地提示、伴星侧板/移动端底部面板、共学舞台、静态降级；桌面端锚点不得覆盖内容主操作，移动端并入可收起的底部工具栏或面板；
- `PageCompanionContextV1` adapter 基础设施（类型见阶段 01 任务 01-3 / 原方案 §5.4.4）：`quiet` 未召唤、`page_context_off`、`temporary_hidden` 或 `global_off` 时 adapter 不挂载 entity/selection observer，也不构造或发送完整 context snapshot；`quiet` 下只有用户显式召唤、选择"和伴星看看"或进入 Session 后，才按当前 action 所需字段构造短 TTL 的 context，面板关闭/动作结束即销毁；`moderate/active` 只能用最小 `CompanionTriggerContextV1`，permit + 用户接受后才升级所需上下文；
- 控制状态（§5.5）：`page_muted`、`page_context_off`、`focus_until_task_end`、`suggestion_paused`、`temporary_hidden`、`global_off`、`animation_off / voice_output_off` 各自作用域与行为（完整表见原方案 §5.5）；`temporary_hidden/global_off` 在客户端接受操作后立即停渲染、observer 和 context，UI 不等待网络才隐藏；
- 关闭面板后焦点回到原触发位置，live region 只播报必要状态。

**验收**：context-off/hidden/off 后 observer/context 构造为 0；焦点恢复正确；全站锚点不阻塞页面主内容。

---

### 任务 05-6：第一轮 blinded cross-modality qualification（§16.2/§7.4）

**交付物**：在开发资格集上完成第一轮 blinded cross-modality qualification；该集合与 W8 冻结 RC 集不重叠。

**任务内容（原文 §16.2，W4 bullet）**：

- 相同 facet 的人工双标一致性和 Critic precision/recall 阈值 W0 已冻结，RC 后不得降低；
- voice 与 silent bundle 按相同 rubric/facet 分层报告 false-upgrade、false-downgrade、abstain 和 `not_assessable`；
- 模态间只比较相同 facet，不要求单个排序 Scene 与开放讲解提供相同信息量。

**验收**：profile-eligible 目标的无语音、无打字 bundle 在开发资格集达到预冻结集成阈值，可进入 W5；这不是 release qualification，不能用于调低 W8 阈值。

---

## 阶段退出 Gate（05 / W4）

- [x] profile-eligible 目标的无语音、无打字 bundle 在开发资格集达到预冻结集成阈值；
- [x] 任意 UI/code 生成不可达（scene-safety-v1 + Scene Activation Service 生效）；
- [x] 伴星基础角色、`assessment_handoff`、静态/reduced-motion fallback 交付；
- [x] Global Shell 锚点/侧板/控制状态/context adapter 基础设施交付；
- [x] 开发资格集 qualification 完成（与 W8 RC 集不重叠）。

通过后进入阶段 06（W5 单 Key Point 纵切）。

### 本阶段执行记录

- 执行日期：2026-08-08（分支 v1.0）
- 任务完成：05-1~05-6 全部实施并签署（契约/服务/测试/决策记录均落盘）
- 验证：apps/api 1766/1766、packages/shared 374/374、packages/db 5/5、apps/web 549/549、web/api typecheck、git diff --check 全部通过
- security_review：1 轮 warn（1 MEDIUM fail-open 端口 / 1 MEDIUM Gold 伪造 / 1 MEDIUM injection 纵深 / 2 LOW）→ 修复后复查 **pass**（writeActiveContract fail-closed、Gold 凭据外部签发、injection 黑名单增强、零宽字符剥离）
- 承接：阶段 06（W5 单 Key Point 纵切与 official scheduler）
