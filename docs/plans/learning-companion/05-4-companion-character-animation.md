# 决策记录 05-4：伴星基础角色与动画实现（§5.2/§5.3）

> 状态：**Frozen（已冻结）**
> 执行：阶段 05（W4）任务 05-4
> 日期：2026-08-08
> 来源：`05-w4-scene-runtime-silent-profile.md` 任务 05-4（§5.2 角色动画 + §5.3 typed spatial actions）+ 冻结记录 01-8（`CompanionVisualStateV1` 完整边界）+ 02-10 动画引擎 spike（Rive 主引擎 + CSS/SVG 降级层）
> 约束级别：**动画状态与真实 Session 状态一致**；`assessment_handoff` 表达伴星不参与判分；模型不能返回任意 DOM/CSS/HTML/脚本；reduced-motion 取消飞行/弹性缩放/视差/持续漂浮；加载失败时静态立绘/图标化手势/标准控件继续可用。

---

## 1. 交付物

| 文件 | 职责 |
| --- | --- |
| `apps/web/lib/learning-companion/companion-visual-state.ts` | `CompanionVisualStateV1` 11 状态枚举/守卫/读屏标签；9 个 typed spatial actions 白名单与「拒绝任意 DOM/CSS/HTML/脚本」校验；系统事件 → 视觉状态权威映射（动画只表达已发生状态）；`assessment_handoff` 语义（handoffViewFor）；reduced-motion/加载失败/hidden/quiet 降级（resolveCompanionPresentation）；状态 → 展示姿态（companionPoseForState） |
| `apps/web/lib/learning-companion/companion-visual-state.test.ts` | 状态合法性、只表达已发生状态、assessment_handoff 语义、降级、spatial action 白名单单测（24 项） |
| `apps/web/components/learning-companion/CompanionAvatar.tsx` | 统一基础角色（年轻星际导航员）CSS/SVG 呈现层：11 状态 props 驱动、`assessment_handoff` 可见退场（收起工具/退到边缘/观测环接管）、reduced-motion 静态呈现、资产加载失败静态立绘 fallback、读屏标签 |
| 本决策记录 | 冻结语义、状态机与 typed-action 映射、降级契约 |

## 2. 冻结语义与实现映射

### 2.1 统一基础角色（§5.2 / 01-8 §3）

- **角色设定**：年轻星际导航员，约 2.5~3 头身（头部 r=17/总高≈93 的 SVG 画布比例），发光星纹、短披风/围巾式彗尾、可变形的导航环（full / partial / hidden）；
- 二维动画造型、干净色块、柔和描边；**公测只交付一个统一基础角色**；
- 不做写实 3D、不做大范围持续粒子、不通过 XP/付费解锁身体表情（01-8 §4）。

### 2.2 CompanionVisualStateV1 完整边界（01-8 §7）

11 个状态冻结为：

```
dormant / invite_once / navigate / present_evidence / listen / co_manipulate /
explain / assessment_handoff / committed_change / uncertain_or_retry / exit_or_hidden
```

- `isCompanionVisualState` fail-closed：未知字符串不是合法状态；
- 每个状态有读屏/语义标签（`COMPANION_STATE_LABEL`）—— 颜色/空间/动画不是唯一信息载体（§13.4）。

### 2.3 动画只表达已发生的系统状态（01-8 §7）

- `visualStateForSystemEvent` 是**权威映射**：任何视觉状态都必须由已发生的系统事件（16 种 `CompanionSystemEventKind`）映射而来；
- `eventAllowsVisualState` 诚实守卫：事件 A 想展示状态 B 且映射不一致 → 拒绝（fail-closed）；
- 不伪装评估进度或 canonical 结果：`assessment_started` 事件期间不允许展示 `committed_change` / `uncertain_or_retry` 等未发生结果；
- `committed_change` 是弱化短确认：无烟花、无连胜、无夸张庆功（pose 中手下垂、无观测环、无工具）。

### 2.4 assessment_handoff：伴星不参与判分（01-8 §7）

- 仅当系统事件为 `assessment_started` 且状态为 `assessment_handoff` 时，`handoffViewFor` 返回完整退场视图：
  - **收起提示工具**（pose.toolVisible=false）；
  - **退到场景边缘**（角色组向左平移，`retreatToEdge`）；
  - **独立「观测环」接管验证状态**（`observerRingActive`，与导航环不同色的独立小环 + 状态点）。
- 任何其他事件/状态组合返回全 false：动画不得自行推进或伪装评估阶段。

### 2.5 typed spatial actions（§5.3 / 01-8 §6）

- 白名单 9 个动作：`focus_nodes / draw_route / stage_scene / read_prompt / offer_branch / show_change / return_to_origin / end_session / propose_curiosity_save`（与 `workers/ai-worker` 工具 manifest 同名同语义）；
- 模型不能返回任意 DOM/CSS/HTML/脚本：`isCompanionSpatialAction` 只认白名单；`containsNonSpatialMarkup` 拒绝 `<script>/<style>/<svg>/<img>、javascript:、data:text/html、onerror=、onclick=` 等形态（fail-closed）；
- 八动作语义映射（01-8 §6）：`focus_nodes/draw_route/return_to_origin → navigate`、`stage_scene → present_evidence`、`read_prompt → listen`、`offer_branch → explain`、`show_change → co_manipulate`、`end_session → exit_or_hidden`、`propose_curiosity_save → invite_once`。

### 2.6 reduced-motion / 静态降级（01-8 §9 / 02-10 §8）

`resolveCompanionPresentation` 按优先级降级：

| 输入 | 呈现 |
| --- | --- |
| `hidden`（temporary_hidden/global_off，§5.5） | 立即停渲染（hidden） |
| `exit_or_hidden` + reduced-motion | 直接消失（01-8 §7） |
| 资产加载失败（assetLoaded=false） | 静态立绘 + 图标化手势（`gestureIcon`），标准控件继续可用 |
| reduced-motion（或 animation_off） | 静态呈现；取消飞行 / 弹性缩放 / 视差 / 持续漂浮（`cancelledEffects = [fly, elastic_scale, parallax, float]`） |
| `quiet` + `dormant` | 静态中性锚点，不进入 idle 动画 |
| 其余 | 动画呈现（仅当资产已加载且非 reduced-motion） |

- 02-10 spike 结论：Rive 为主引擎、CSS/SVG 为**必交付的降级层**；`CompanionAvatar` 即该 CSS/SVG 呈现层，props 接口（state/systemEvent/prefersReducedMotion/assetLoaded）可在未来换成 Rive 渲染实现而不改契约；
- 组件内动画仅限完整模式下轻量动作（navigate/present_evidence 漂浮、invite_once 挥手、导航环缓转、星纹呼吸），reduced-motion 下全部不应用（`motionEnabled=false` 不加动画 class）。

## 3. 组件约束

- `CompanionAvatar` 为纯展示组件：`state` 由上层按系统事件权威映射驱动（props 驱动，动画只表达已发生状态），`systemEvent` 为防御性入参（handoff 只对 `assessment_started` 放行）；
- 无 `styled-components`；颜色用组件内联 SVG 调色板常量（干净色块 + 柔和描边），不新增 CSS 文件（`<style>` 仅注入 `lc-*` keyframes）；
- 加载失败不阻断学习功能：静态立绘 + 读屏标签 + 宿主标准控件保持可用。

## 4. 验证

- `cd apps/web && npx tsc --noEmit --incremental false` 通过；
- `cd apps/web && npm test` 通过：`companion-visual-state.test.ts` 24 项（状态冻结边界、事件权威映射与守卫、assessment_handoff 语义、11 状态 pose、reduced-motion 取消清单、hidden/quiet/资产失败降级、spatial action 拒绝脚本形态）全部通过；
- 动画状态与真实 Session/assessment/commit 状态的一致性（`eventAllowsVisualState`）与静态降级下完整学习功能由本任务纯逻辑单测覆盖；真实 Rive 资产与 `.riv` 接入由 W4 资产制作任务在保持本 props 契约的前提下实施。

## 5. 待后续任务接入

- Rive `.riv` 主资产（矢量/骨骼 + 状态机）接入：渲染实现可替换为 `@rive-app/canvas`，`CompanionVisualStateV1` 11 状态、typed-action 映射、静态 fallback 语义不绑定供应商私有语义（02-10 R3）；
- 宿主在 Global Shell（05-5）把 `PageCompanionContextV1` 的系统事件流接到 `CompanionAvatar` 的 `systemEvent`；
- 静态 PNG/WebP fallback 资产与统一画布/脚底锚点/安全边界（01-8 §5）在资产制作任务交付。
