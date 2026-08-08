# 决策记录 05-3：拖拽替代与 A11y 等价操作（§6.6 + §13.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 05（W4）任务 05-3
> 日期：2026-08-08
> 来源：`05-w4-scene-runtime-silent-profile.md` 任务 05-3（§6.6 多模态交互 + §13.4 A11y 硬门禁）+ 冻结记录 01-4 §13.4
> 约束级别：**拖拽不是唯一操作方式**；键盘/tap-select-place/读屏/reduced-motion 等价路径属于每个 Scene 冻结项；无计时评分、无操作速度评分；颜色/空间位置/动画不是唯一信息载体。

---

## 1. 交付物

| 文件 | 职责 |
| --- | --- |
| `apps/web/lib/learning-companion/tap-select-place.ts` | tap-select-place 状态机（纯逻辑）：idle → select_object → choose_action → select_target → done；转移校验 / 撤销 / 锁定 / 键盘方向键导航 / canPlace 约束 / 进度与完成判断；状态不含任何计时与速度字段 |
| `apps/web/lib/learning-companion/tap-select-place.test.ts` | 状态机单测（转移序列、非法转移拒绝、撤销、锁定、动作序列、键盘移动、reduced-motion 友好） |
| `apps/web/components/learning-companion/TapSelectPlaceLayer.tsx` | 拖拽替代 UI 层：键盘（方向键/回车/U 撤销/L 锁定/Esc 取消）、读屏描述（aria-live/aria-label/roving tabindex）、≥44×44 CSS px 触控目标、三视口与 200% zoom 适配、reduced-motion 静态切换 |
| 本决策记录 | 冻结语义、A11y 硬门禁映射、Scene 冻结项说明 |

## 2. 冻结语义与实现映射

### 2.1 等价路径：点选对象 → 选择动作 → 点选目标（§6.6 / §13.4）

所有拖拽操作必须提供 tap-select-place 等价路径，本记录将其冻结为三步状态机：

```
idle → select_object（点选对象）
     → choose_action（选择动作：连接/放置/高亮…）
     → select_target（点选目标）
     →（放置成功）→ 回到 select_object 继续，或全部完成 → done
```

- `scene.canPlace(objectId, actionId, targetId)` 为放置约束单一来源（默认：对象存在、动作属于该对象、目标存在）；
- 非法转移 **fail-closed**：错误阶段操作 / 已放置对象 / 不属于对象的动作 / 不可放置目标一律拒绝并置 `lastError`，状态不改变；
- 每个 Scene 冻结项（§6.4 逐 rubric 冻结）必须同时冻结其 tap-select-place 场景定义（objects/actions/targets/canPlace），本组件只渲染宿主传入的 `scene`。

### 2.2 撤销 / 锁定 / 取消

- **撤销**：回退一步进行中的选择（select_target→choose_action→select_object），或撤销最近一次完整放置（回到 select_target 可重选目标）；动作序列即 `placements` 放置顺序；
- **锁定**：全部 `requiredObjectIds` 放置完成后才允许锁定（无强制项场景可随时锁定）；锁定后 pick/undo/begin/cancel/move_focus 全部拒绝；`unlock` 解除；
- **取消**：取消当前选择会话，已完成的放置保留。

### 2.3 键盘、读屏与 Switch Control（§13.4）

- **键盘**：方向键在对象/动作/目标间移动焦点（按屏幕坐标找同方向最近项）、Enter/Space 选择当前项、U 撤销、L 锁定、Esc 取消；
- **读屏**：`role="region"` + 顶部 `role="status" aria-live="polite"` 只播报必要阶段与进度；错误走 `role="alert"`；每个对象/动作/目标都有语义 `aria-label`（节点/关系/顺序描述，如「目标 第一个位置：放置 恒星 的 连接」）；roving tabindex 让 Tab 只聚焦当前项；
- **Switch Control / 单手操作**：全部触控目标 ≥ 44×44 CSS px（`min-h-11` / `min-w-11`，44px 无歧义）；无精确拖拽、无指针捕获依赖。

### 2.4 触控目标 / 视口 / zoom（§13.4）

- 触控目标统一 ≥ 44×44 CSS px；
- 200% zoom 不丢功能：网格用 `repeat(auto-fill, minmax(11rem, 1fr))` + `flex-wrap`，无固定像素宽度，缩放后自动换行不丢按钮；
- 390/768/1440 三视口无主路径阻断：窄屏网格自动收列，操作栏换行堆叠，不出现横向溢出导致的操作死路。

### 2.5 reduced-motion（§13.4 / 01-4）

- 状态切换为**即时 DOM 重渲染**：无飞行、无位移动画（拖拽"飞行"被禁止替代）；
- 过渡统一附加 `motion-reduce:transition-none`；全局 `prefers-reduced-motion: reduce`（`app/styles/motion.css`）兜底；
- 无计时评分、无精确拖拽速度评分：状态机不含任何 duration/timer/speed/elapsed/velocity 字段，判定与操作速度无关。

### 2.6 颜色 / 空间位置 / 动画不是唯一信息载体（§13.4）

- 对象/动作/目标始终有文字标签与读屏描述；已放置状态既有视觉（GripVertical 图标）也有 `aria-label` 后缀与阶段文字；
- 键盘/tap-select-place/screen-reader/reduced-motion 四条等价路径**全部属于每个 Scene 的冻结项**（§6.4 A11y 等价路径字段），本层组件为各 Scene 共用的渲染实现。

## 3. 组件约束

- `TapSelectPlaceLayer` 为**纯 UI + props 回调**：`onPlace` / `onUndo` / `onLock` 只在对应状态**实际变化后**触发（副作用经 effect 观察，非法/被拒转移不误报）；组件内不直接调用服务端；
- 宿主在每个 Scene 内嵌本层组件，并把回调接到该 Scene 的确定性动作执行；
- 无 `styled-components`；样式跟随项目 tailwind token 体系，不新增 CSS 文件。

## 4. 验证

- `cd apps/web && npx tsc --noEmit --incremental false` 通过（tsconfig `include: ["**/*.ts", "**/*.tsx"]` 覆盖 `components/learning-companion/` 与 `lib/learning-companion/`）；
- `cd apps/web && npm test` 通过：`tap-select-place.test.ts` 23 项 + `companion-visual-state.test.ts` 24 项（含 tap-select-place 全部状态机断言）在内完整套件 510 项全部通过；
- 组件级键盘/读屏行为断言依赖宿主 Scene 集成与 Playwright 阶段验证（05-W4 阶段验收、08-w7 reduced-motion E2E），不在本任务范围内。

## 5. 待后续任务接入

- 各 Scene 类型（Ordering / Relation Canvas / Repair / 多步场景…）在冻结项中提供自身 `TapSelectPlaceScene` 定义并内嵌 `TapSelectPlaceLayer`；
- 宿主页面把 `onPlace/onUndo/onLock` 接到 Scene Activation Service 侧确定性动作（拖拽与 tap-select 走同一动作执行路径，只换触发方式）；
- 阶段验收中全部 Scene 类型通过键盘/读屏/reduced-motion 验收，确认"拖拽不是唯一操作方式"。
