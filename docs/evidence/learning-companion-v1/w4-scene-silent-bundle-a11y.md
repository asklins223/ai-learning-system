# W4 证据：Structured Scene Runtime、静音 bundle 与 A11y

> 对应任务 11-2 证据文件 6。佐证 DoD 15、32。
> 决策记录：`docs/plans/learning-companion/05-w4-scene-runtime-silent-profile.md`（任务 05-1~05-6）与 `05-1-silent-proof-profile.md` ~ `05-6-blinded-qualification.md`。
> 状态：**Frozen** ｜ 执行：阶段 11 / W11 任务 11-2 ｜ 日期：2026-08-08

## 1. 实现文件核验（路径存在）

| 单元 | 路径 | 对应任务 |
| --- | --- | --- |
| silent-profile-registry | `apps/api/src/modules/learning-sessions/silent-profile-registry.ts`（+ `silent-profile-registry.test.ts`） | 05-1 |
| silent-proof 契约 | `packages/shared/src/silent-proof-profile-contracts.ts` | 05-1 |
| scene-contracts | `packages/shared/src/scene-contracts.ts` | 05-2 |
| scene-safety | `apps/api/src/modules/learning-sessions/scene-safety.ts`（+ `scene-safety.test.ts`） | 05-2 |
| scene-activation | `apps/api/src/modules/learning-sessions/scene-activation.ts`（+ `scene-activation.test.ts`） | 05-2 |
| tap-select-place | `apps/web/lib/learning-companion/tap-select-place.ts`（+ `tap-select-place.test.ts`）+ `apps/web/components/learning-companion/TapSelectPlaceLayer.tsx` | 05-3 |
| CompanionAvatar | `apps/web/components/learning-companion/CompanionAvatar.tsx` | 05-4 |
| Global Shell 组件 | `apps/web/components/learning-companion/`（QuietAnchor、CompanionSidePanel、StaticCardFallback、VoiceInputPanel、TextOrMixedInput、ModalSwitcher）+ `apps/web/components/layout/AppShell.tsx` | 05-5 |
| Global Shell 状态 | `apps/web/lib/learning-companion/`（companion-control-state、companion-visual-state、page-companion-context，均带 `*.test.ts`） | 05-5 |

## 2. SilentProofProfile 与静音 bundle（05-1，佐证 DoD 15）

- `silent-profile-registry.ts` 实现最小 `SilentProofProfile` registry：versioned 资格模板（procedure / causal+boundary / concept+application 三 family），每个合格 bundle 至少两个互补 Scene；`structuredProofEligibilityReport` 证明 required facets 覆盖、公开 token 不泄漏答案、任务区分度与 A11y 等价路径。
- 只有 `eligible` 目标才展示零语音、零打字 structured mastery 路线；无 eligible profile 的目标不展示 silent mastery（不以选择题换皮冒充等价）；公测 silent route 按 Key Point 级激活，覆盖率如实发布（佐证 DoD 15；qualification 数值见 `w8` 证据 RC 集）。

## 3. Structured Scene Runtime（05-2，佐证 DoD 15）

- `scene-contracts.ts`：七类 Scene（VoiceTeachback/Ordering/RelationCanvas/Repair/MultiStepScenario/Counterexample/OptionalText）契约，冻结 scene/template/version、target IDs、source fingerprint、capability facet、public/secret 独立 hash、allowlisted token/node/edge/option IDs、disclosureProfile、assistance policy、template trust ceiling、A11y 等价路径。
- `scene-safety.ts`（`scene-safety-v1`）：schema、public/secret 分离、allowlisted IDs、答案泄漏、可评估性、唯一解/有效多解、distractor 区分度、事实支撑、prompt injection、语言与 A11y 检查；mandatory 独立 Rubric/Scene Critic；静态模板复用需不可变 certification hash；失败最多修复一次，仍失败 `question_retryable/blocked`。
- `scene-activation.ts`（Scene Activation Service）：唯一激活权限，事务内验证 staging、scene-safety、Critic approved、public/private/solution/disclosure hashes、planHash、epoch 与 BudgetEnvelope 后写一次 immutable active contract；Author/Supervisor/Critic/Companion 均无 `activate_scene_contract` 权限。
- 物理拆分三对象（`PublicSceneContract` / `PrivateSceneSolution` / `PrivateLearningEpisodeContract`）；客户端只得到净化 Session/Scene view；formal 前 network/RSC/prefetch/cache/DOM 零隐藏答案（佐证 DoD 15，DoD 5 详见 `release-manifest.json` 核验）。

## 4. 拖拽替代与 A11y 等价操作（05-3，佐证 DoD 32）

- `tap-select-place.ts` + `TapSelectPlaceLayer.tsx`：点选对象 → 选择动作 → 点选目标 的等价路径；键盘移动/连接/撤销/锁定；屏幕阅读器可理解的节点、关系与顺序描述；reduced-motion 下无飞行/弹性/视差/持续漂浮动画。
- 触控目标 ≥44×44 CSS px；200% zoom 不丢功能；390/768/1440 三视口无主路径阻断；颜色/空间位置/动画不是唯一信息载体；无计时评分、无拖拽速度评分；麦克风拒绝后无操作死路（与 `w3` 证据 04-6 交叉）。

## 5. 伴星角色与 Global Shell 基础设施（05-4/05-5）

- `CompanionAvatar.tsx`：统一基础角色（星际导航员造型），`CompanionVisualStateV1` 状态（dormant/invite_once/navigate/present_evidence/listen/co_manipulate/explain/assessment_handoff/committed_change/uncertain_or_retry/exit_or_hidden）；动画只表达已发生的系统状态，`assessment_handoff` 通过可见退场表达"伴星导航员不参与判分"；静态 PNG/WebP fallback 下完整学习功能可用。
- Global Shell 组件：`QuietAnchor.tsx`（安静锚点：静态中性入口，无 idle 动画/闪烁/发声/未读红点）、`CompanionSidePanel.tsx`（侧板/移动端底部面板）、`StaticCardFallback.tsx`（无 Canvas 静态卡 fallback）、`VoiceInputPanel.tsx`/`TextOrMixedInput.tsx`（输入模态）；`companion-control-state.ts` 落实 page_muted/page_context_off/focus_until_task_end/suggestion_paused/temporary_hidden/global_off/animation_off/voice_output_off 各作用域；`page-companion-context.ts` 为 `PageCompanionContextV1` adapter（quiet/page_context_off/hidden/off 时不挂载 entity/selection observer、不构造完整 context snapshot）；关闭面板后焦点回原触发位置（佐证 DoD 30 侧，完整验收见 `w6` 证据）。

## 6. 判定层证据

- 决策记录 `05-1`~`05-6` 头部状态均为 **Frozen（已冻结）**；阶段 05 退出 Gate 5 项全部勾选（开发资格集达标、UI/code 生成不可达、角色与 assessment_handoff 交付、Global Shell 基础设施交付、qualification 完成且与 W8 RC 集不重叠）。
- 阶段 05 执行记录：apps/api 1766/1766、packages/shared 374/374、packages/db 5/5、apps/web 549/549、web/api typecheck 与 git diff --check 通过；security_review 1 轮 warn（1 MEDIUM fail-open 端口 / 1 MEDIUM Gold 伪造 / 1 MEDIUM injection 纵深 / 2 LOW）→ 修复后复查 **pass**。
- 05-6 开发资格集为 blinded qualification 第一轮（与 W8 冻结 RC 集不重叠），不构成 release qualification；真实运行样本由 W8 采集，见 `w8` 证据。
