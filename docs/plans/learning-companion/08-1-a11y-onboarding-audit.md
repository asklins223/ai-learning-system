# 决策记录 08-1：A11y 与 onboarding 审计（§13.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 08（W7）任务 08-1
> 日期：2026-08-08
> 来源：`08-w7-audit-observability.md` 任务 08-1（§13.4 A11y 硬门禁）+ 冻结记录 01-4 §13.4、01-8 §7（动画契约）、05-3/05-4/05-5/07-1 前置交付
> 约束级别：**WCAG 2.2 AA serious/critical 为 0**；**硬偏好违反为 0**；审计规则与组件分离、DOM 经视图模型注入、纯函数可测。

---

## 1. 交付物

| 文件 | 职责 |
| --- | --- |
| `apps/web/lib/learning-companion/a11y-audit.ts` | A11y 审计纯逻辑：WCAG 2.2 AA 规则清单 + §13.4 产品硬门禁清单，每规则一个检查函数（注入 DOM 视图模型）；onboarding 跳过同级性；角色状态一致性（动画状态 ↔ 真实 Session/assessment/commit 状态映射校验）；`runA11yAudit` 聚合 gate |
| `apps/web/lib/learning-companion/a11y-audit.test.ts` | 单测：每规则通过/失败样本、focus trap 检测、焦点返回、onboarding 跳过同级、角色一致性违规检测、聚合 gate、零副作用源码断言 |
| 本决策记录 | 冻结语义、规则清单、视图模型注入设计、验证 |

## 2. 设计约束（任务要求）

- **TypeScript 严格模式**（apps/web tsconfig `strict: true` + `noUnusedLocals/Parameters`）；
- **纯函数可测**：本模块无 React / 无 DOM / 无网络 / 无随机源，测试含源码零副作用断言
  （不含 `document.`/`window.`/`fetch(`/`navigator.`/`setTimeout(` 等）；
- **DOM 经视图模型注入**：`DomElementView` / `OverlayView` / `RoleStateView` 等描述
  渲染后 DOM 状态快照，由审计运行器（Playwright 钩子 / E2E）构建注入；检查函数离线可测；
- **审计规则与组件分离**：本模块只依赖同目录纯逻辑（`companion-visual-state.ts`、
  `companion-control-state.ts`）与 `@ailearn/shared` 类型契约，不 import 任何组件/JSX。

## 3. WCAG 2.2 AA 规则清单（serious）

| 规则 ID | 检查函数 | 覆盖（§13.4 验收） |
| --- | --- | --- |
| `wcag-1.1.1-non-text-content` | `auditNonTextContent` | 非文本内容有替代文本 |
| `wcag-1.3.1-info-relationships` | `auditSemanticLabels` | 伴星锚点/当前上下文/建议原因/忙碌退场/页面 action 均有语义标签 |
| `wcag-1.4.3-contrast-minimum` | `auditTextContrast` | 文本对比度：普通 4.5:1 / 大文本 3:1（WCAG 公式） |
| `wcag-1.4.4-resize-text` | `auditZoom200` | 200% zoom 不丢功能（320px 视口关键操作可见、可换行） |
| `wcag-1.4.10-reflow` | `auditReflow320` | 320px 重排无横向滚动、无固定宽度溢出 |
| `wcag-1.4.11-non-text-contrast` | `auditNonTextContrast` | 非文本图形对比度 ≥ 3:1 |
| `wcag-2.1.1-keyboard` | `auditKeyboardAccessible` | 全部操作键盘可达（可聚焦、非负 tabIndex） |
| `wcag-2.1.2-no-keyboard-trap` | `auditNoKeyboardTrap` | 无键盘陷阱：模态浮层强制 trap 必须有逃逸路径 |
| `wcag-2.4.3-focus-order` | `auditFocusReturn` | 焦点顺序与关闭后焦点返回（含全部浮层） |
| `wcag-2.4.7-focus-visible` | `auditFocusVisible` | 焦点可见（focus-visible 描边） |
| `wcag-2.5.8-target-size` | `auditTouchTargetSize` | 触控目标 ≥ 44×44 CSS px（内联文本链接豁免） |
| `wcag-2.2.1-timing-adjustable` | `auditNoCountdownScoring` | 无倒计时评分、无操作速度评分 |
| `wcag-2.3.3-animation-from-interactions` | `auditReducedMotion` | reduced-motion 完整支持（动画静态化检查） |
| `wcag-4.1.2-name-role-value` | `auditNameRoleValue` | 交互控件有可访问名称/角色/值 |

## 4. §13.4 产品硬门禁规则清单（critical）

| 规则 ID | 检查函数 | 覆盖（任务 08-1 bullet） |
| --- | --- | --- |
| `onboarding-skip-parity` | `auditOnboardingSkipParity` | 跳过在每一步都是视觉、键盘和读屏同级动作 |
| `onboarding-navigability` | `auditOnboardingNavigability` | 引导可返回、暂停、恢复和主动重播 |
| `onboarding-no-focus-trap` | `auditOnboardingNoFocusTrap` | onboarding tooltip/侧板焦点不陷阱（guide/tooltip/panel 必须 focusTrap=none，不用会困住焦点的 tooltip 链） |
| `focus-return-on-close` | `auditFocusReturnOnClose` | 关闭面板后焦点回到原触发位置 |
| `live-region-minimal` | `auditLiveRegionMinimal` | live region 只播报必要状态（数量 ≤2、不重复播报面板内容、有 aria-live） |
| `drag-equivalents` | `auditDragEquivalents` | 所有拖拽有 tap-select-place、键盘和 Switch 等价操作 |
| `screen-reader-comprehension` | `auditScreenReaderComprehension` | screen reader 可理解节点/关系/路线/Scene/结果 |
| `not-color-only` | `auditNotColorOnly` | 颜色、空间位置和动画不是唯一信息载体 |
| `voice-autoplay-off` | `auditVoiceAutoplay` | 语音输出默认不自动播放；可暂停、重听、确认 transcript、切换模态 |
| `no-timed-scoring` | `auditNoCountdownScoring` | 无倒计时评分、无操作速度评分（硬门禁） |
| `viewport-390-768-1440` | `auditViewportNoBlock` | 390/768/1440 三视口无主路径阻断 |
| `role-state-consistency` | `auditRoleStateConsistency` | 角色状态与真实 Session/assessment/commit 状态一致 |
| `hard-preference-zero` | `auditHardPreference` | 硬偏好违反为 0（§16.4 硬 Gate） |

## 5. 视图模型注入设计

审计运行器（阶段 08-5 E2E / Playwright 钩子）从渲染 DOM 构建以下视图模型注入
`runA11yAudit(input)`；检查函数不接触真实 DOM：

- `DomElementView`：tag/role/aria-* / tabIndex / 几何（widthPx/heightPx）/
  color/backgroundColor/fontSizePx/fontWeight / animationName+motionReduceSafe /
  autoplay / wrapable / scrollsHorizontally；
- `OverlayView`：kind（dialog/tooltip/guide/panel/toast）、focusTrap
  （enforced/none）、ariaModal、triggerId、closeButtonId、escCloses、
  focusAfterCloseId、liveRegionIds、contentText；
- `OnboardingSkipActionView` / `OnboardingNavigabilityView` / `DragSceneView` /
  `GraphicStructureView` / `StatusIndicatorView` / `VoiceOutputView` /
  `ScoringView` / `RoleStateView` / `LearningCardStateView` / `HardPreferenceView`。

聚合入口 `runA11yAudit` 对全部规则执行并汇总 gate：

```
gate.passed = (WCAG 2.2 AA serious/critical 计数 === 0) && (硬偏好违反 === 0)
```

## 6. 角色状态一致性（§13.4「动画不得伪装评估进度或 canonical 结果」）

`auditRoleStateConsistency` 的判定（复用 05-4 `eventAllowsVisualState` 权威映射）：

1. 视觉状态与已发生的系统事件不匹配（`eventAllowsVisualState` 为 false）→ 违规；
2. 展示 `assessment_handoff` 但真实 assessment 未开始 → 违规（动画伪装评估进度）；
3. 展示 `committed_change` 但真实 commit 未记录 → 违规（动画伪装 canonical 结果）；
4. LearningCard 徽标宣称「理解变化」（trusted）但真实 trusted 事件数为 0
   → 违规（活动量伪装成知识成长，§8/07-5）。

`auditHardPreference` 复用 05-5 `resolveControlEffects` 解析权威效果集，与视图
「实际渲染/活动」对照：temporary_hidden/global_off 下角色动画、语音、主动建议、
邀请、observer、context 必须为 0；voice_output_off / animation_off /
page_muted / suggestion_paused / quiet 未召唤 各自抑制项必须为 0。

## 7. 验证

- `cd apps/web && npx tsc --noEmit --incremental false` 通过（tsconfig
  `include: ["**/*.ts", "**/*.tsx"]` 覆盖 `lib/learning-companion/`）；
  `npm run typecheck --prefix apps/web` 裸命令在本环境因既有
  `tsconfig.tsbuildinfo` 缓存文件的写保护（Operation not permitted，
  与新交付物无关）报 TS5033，与 05-3 决策记录同一处理方式（`--incremental false`）；
- `cd apps/web && npm test` 通过：完整套件 750 项全部通过
  （含新增 `a11y-audit.test.ts` 全部用例）；
- 组件级（OnboardingGuide / CompanionSidePanel / TapSelectPlaceLayer / QuietAnchor /
  CompanionAvatar / LearningCardActions）的键盘/读屏行为断言与 200% zoom、
  390/768/1440 三视口实测、语音/键盘/读屏/reduced-motion E2E 由阶段 08-5
  全链路 E2E 与 Playwright axe 接入本审计模块的视图模型构建器完成（不在本任务范围）。

## 8. 待后续任务接入

- 阶段 08-5 E2E 实现 `runA11yAudit` 的 DOM 视图模型构建器（Playwright 遍历
  `data-ui="lc-*"` / role / 几何 / computed style），把规则落到真实页面断言；
- 组件新增交互元素时保持本清单的语义标签与几何约束（§13.4 硬门禁回归）。
