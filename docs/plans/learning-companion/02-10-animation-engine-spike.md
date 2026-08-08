# 决策记录 02-10：二维角色状态机引擎 spike（§5.2）

> 状态：**评估完成（待 Owner 确认选型）**
> 执行：阶段 02（W1）任务 02-10
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-10（原方案 §5.2）
> 约束：`CompanionVisualStateV1`、typed-action 映射和静态 fallback 不绑定供应商私有语义。

---

## 1. 任务范围与方法

本任务在 **W1（阶段 02）** 并行完成二维角色动画引擎 spike：为冻结记录 `01-8-visual-animation-contract.md` 的首版动画资产（可交互的二维骨骼/矢量状态机）完成**引擎选型桌面评估**。W4（阶段 05 任务 05-4「伴星基础角色与动画实现」）将按本记录选定的引擎落地。

**方法**：基于规范约束与公开技术信息做**桌面评估**，不安装任何依赖、不写代码、不做性能基准；包体/帧率为公开资料的工程量级估计，W4 实现时须以真实构建测量复核。本记录为决策记录，不是实现规格。

**技术栈上下文**（供集成面评估）：Web 前端为 Next.js 15 + React 19 + Tailwind CSS（`apps/web`），E2E/无障碍用 Playwright + axe-core；桌面端复用同一 Web bundle（Electron 打包 `web/.next/standalone`）。因此引擎评估以**浏览器运行时**为基准。

---

## 2. 需求重述（从规范提取的硬约束）

| 编号 | 约束 | 来源 |
| --- | --- | --- |
| R1 | 首版动画资产是**可交互的二维骨骼/矢量状态机**；**非** GIF、长视频、LLM 实时生成的角色动作 | 02-10 / 01-8 §9 |
| R2 | 引擎在**许可证、包体、帧率、离线缓存、Canvas 叠加、读屏、静态降级**七个维度评估 | 02-10 / 01-8 §9 |
| R3 | `CompanionVisualStateV1`、typed-action 映射、静态 fallback **不得绑定供应商私有语义**；引擎选择不得反向修改视觉合同 | 02-10 / 01-8 §9 |
| R4 | `reduced-motion` 下取消**飞行、弹性缩放、视差、持续漂浮**，改用**姿态切换、短淡入、描边、静态路线** | 02-10 / 01-8 §9 |
| R5 | 读屏路径必须提供**等价状态文本** | 02-10 / 01-8 §9 |
| R6 | 动画只能表达**已经发生的系统状态**，不伪装评估进度或 canonical 结果；`quiet` 未召唤不进入 idle 动画，只显示**静态中性锚点**；`assessment_handoff` 用可见退场表达「不参与判分」；`committed_change` 不做烟花/连胜/夸张庆功 | 01-8 §7 |
| R7 | 角色/动画/音频加载失败时，通过**静态立绘、图标化手势和标准控件**继续可用 | 01-8 §9 |
| R8 | 交付**二维骨骼/矢量主资产**及**静态 PNG/WebP fallback**（统一画布/脚底锚点/安全边界，透明背景） | 01-8 §5 |

---

## 3. 候选引擎清单与概览

| 候选 | 类别 | 定位 | 状态机能力 | 工作流依赖 |
| --- | --- | --- | --- | --- |
| **Rive**（`@rive-app/canvas` / webgl / webgpu） | 2D 矢量 + 骨骼 + **内建状态机**渲染引擎 | 交互式矢量动画/游戏 UI | **内建 State Machine**（input 驱动：bool/number/trigger + transitions） | Rive Editor（免费，含状态机编辑） |
| **Lottie**（`lottie-web` / `lottie-player` / dotLottie） | AE 补间动画导出格式 + 播放器 | 品牌/微交互动画回放 | **无内建状态机**（每 JSON 是 timeline；交互需外部 `lottie-interactivity`） | Adobe After Effects + Bodymovin 插件（AE 商业订阅） |
| **纯 CSS/SVG 动画** | Web 标准层 | DOM 动画、静态立绘、fallback 层 | 无（代码层 class/state 切换） | 手工制作或第三方导出器（无统一工具链） |
| **pixi.js**（+ pixi-spine/自建） | WebGL 2D 渲染器 | 游戏/高密度精灵 | 无（渲染器，非动画工具） | 需自建骨骼系统或接入 Spine 格式 |
| **motion-canvas** | 编程式动画库（React） | 导出视频/演示制作 | 无（面向录制导出，非运行时交互） | 代码绘制，面向视频输出 |
| **Spine** | 2D 骨骼动画专用 | 游戏角色骨骼 | 内建状态机（编辑器内） | **编辑器商业许可**（按席位收费）+ 运行时需适配 Web |

**速判**：真正的候选收敛在 **Rive** 与 **Lottie**；纯 CSS/SVG 是**必需保留的降级层**而非主引擎；pixi.js / motion-canvas / Spine 因工具链、许可证或定位不符而排除（详见 §6）。

---

## 4. 七维对比矩阵

评估维度按规范 02-10 原文顺序：许可证、包体、帧率、离线缓存、Canvas 叠加、读屏/无障碍、静态降级。

| 维度 | Rive | Lottie（lottie-web/player） | 纯 CSS/SVG | pixi.js / motion-canvas / Spine |
| --- | --- | --- | --- | --- |
| **许可证** | 运行时 `@rive-app/*` 为 **MIT**；编辑器免费；**商业条款**：公司年收入超过约 **100 万美元**需购买付费订阅（以官方最新条款为准） | **MIT**（lottie-web、lottie-player、dotlottie-web 均 MIT）；Bodymovin 插件开源；依赖 AE 商业订阅（Adobe 许可） | 无第三方许可（Web 标准） | pixi.js MIT；motion-canvas MIT（但定位不符）；Spine 编辑器**商业按席位收费** |
| **包体**（gzip 量级估计） | 运行时约 **200–300 KB**（`@rive-app/canvas`，可 tree-shake 按需）；`.riv` 二进制资产轻量 | `lottie-web` 完整版约 **200–300 KB**，`lottie-player`（web component）约 **130 KB+**；Lottie JSON 资产体积不定（矢量 path 冗余，dotLottie 压缩可减） | **0 KB** 运行时（随应用 bundle 的 SVG 资产） | pixi.js 核心约 150–250 KB；Spine 运行时另计 |
| **帧率** | **GPU 加速**（Canvas2D/WebGL/WebGPU），矢量骨骼动画高帧率（60 fps 无压力）；渲染时间无关、可暂停/定帧 | SVG renderer 在复杂路径下可能掉帧，Canvas renderer 较好；按 timeline 播放，运行时无帧级控制 | CSS transform/opacity 走合成器，简单动画 60 fps；复杂骨骼动画难做到 | pixi WebGL 高帧率；motion-canvas 面向录制；Spine 运行时帧率可控 |
| **离线缓存** | `.riv` 二进制可随应用打包 / service worker / HTTP cache；运行时支持从 ArrayBuffer 加载并离线播放 | JSON/dotLottie 可缓存；离线播放可行 | 随应用 bundle，天然离线 | pixi 资产可缓存；Spine 二进制可缓存 |
| **Canvas 叠加** | **原生 Canvas 渲染**，天然支持与 DOM 层（证据卡、标准控件、空间路线 SVG overlay）按 z-index 叠加 | 支持 SVG / Canvas / HTML 三 renderer，可叠加 | 是 DOM 层，叠加最自然 | pixi 独占 WebGL canvas，overlay 需自行分层 |
| **读屏/无障碍** | **无内建语义**；Canvas 内容对读屏不可见，必须由宿主 DOM 提供 `role="img"`/`aria-label` 与 live region 等价文本 | 同左，无内建语义，宿主 DOM 负责 | SVG 可内嵌 `<title>/<desc>` 与 aria；仍建议 live region 播报状态变化 | 同左，宿主 DOM 负责 |
| **静态降级** | 支持停在首帧/暂停（静止姿态）；加载失败由宿主 fallback 到静态 PNG/WebP | 可导出一帧静态图；加载失败由宿主 fallback | 静态 SVG/PNG 即降级态，零成本 | pixi/Spine 加载失败同样需宿主 fallback |

> 包体与帧率为公开资料工程量级，W4 实现时以真实构建与 Lighthouse/Playwright 测量复核（对应 08-w7 的 reduced-motion E2E）。

---

## 5. 分引擎评估详情

### 5.1 Rive

- **符合度最高**：Rive 是**唯一一个同时具备「矢量图形 + 骨骼/网格变形 + 编辑器内状态机 + 浏览器 Canvas 运行时」**的候选，正好覆盖 R1 的「可交互二维骨骼/矢量状态机」。
- 状态机模型：Editor 内可建 Animation State、Any State、Input State，用 **bool/number/trigger input** 驱动 transitions，支持混合过渡（blend）。这与 `CompanionVisualStateV1` 的「状态 + 转换」模型天然同构（详见 §7）。
- 运行时：`@rive-app/canvas`（Canvas2D）、`@rive-app/webgl`、`@rive-app/webgpu`；React 有官方 hook 封装；`Rive` 对象支持从 ArrayBuffer 加载（利于离线缓存与版本化资产）。
- **许可证风险点**：运行时 MIT 但**商业条款有收入门槛**（年收入约 >100 万美元需订阅）。本项目公测阶段大概率低于门槛，但需在 W4 落地前复核官方最新条款，并在收入预期接近门槛时预留替换空间（三层架构 §8 已内置该可替换性）。
- 读屏与静态降级均需宿主代码完成（R5/R7 由我们代码保证，不依赖引擎），符合 R3「不绑定供应商私有语义」。

### 5.2 Lottie

- **许可最宽松（MIT）**、生态成熟、设计师熟悉的 AE 工作流，适合品牌/微交互回放。
- **关键短板**：
  1. **无内建状态机**——一个 Lottie JSON 是一条补间 timeline；11 个视觉状态的切换、过渡编排必须在代码层手写（或用 `lottie-interactivity` 做有限的 scroller/hover 交互），交互状态机能力远弱于 Rive；
  2. **骨骼支持弱**——Bodymovin 对 AE Puppet Pin/IK 的导出支持有限，角色骨骼动画（表情、四肢）要么逐帧 pose 要么转 shape 动画，制作成本高、资产冗余大；
  3. 帧级控制弱、复杂矢量路径在 SVG renderer 下易掉帧。
- **结论**：可作为**备选**（若团队后期以 AE 工作流为主），但不满足「交互式状态机 + 骨骼」的核心要求。

### 5.3 纯 CSS/SVG

- 零依赖、零许可、DOM 无障碍最自然、叠加最容易、离线天然。
- 短板：**没有骨骼/矢量状态机工具链**；复杂角色动画（表情、手臂、披风摆动）需手工调 SVG 或依赖弱工具，且无内建状态机。
- **定位**：不是主引擎，而是**降级层的标准实现**（reduced-motion 姿态切换、短淡入、描边、静态路线、失败 fallback 静态立绘全部可用 CSS/SVG 完成），也是保证 R3「静态 fallback 不绑定供应商私有语义」的锚点。

### 5.4 其他（pixi.js、motion-canvas、Spine）

- **pixi.js**：MIT、高性能 WebGL，但**只是渲染器不是动画工具**——骨骼、状态机、工具链全部自建，开发与维护成本最高，且与「设计师可协作的资产管线」目标相悖。排除（可作为极端性能兜底，不进入选型）。
- **motion-canvas**：MIT、React 友好，但定位是**录制/导出演示视频**，非运行时交互引擎，与「离线、交互、常驻 Companion」目标不符。排除。
- **Spine**：2D 骨骼动画行业标准、内建状态机，但**编辑器按席位商业收费**，许可证评估不占优；且其资产/运行时主要为游戏工作流，与本项目 Web 应用 + 合同约束契合度低于 Rive。排除（若未来需要最高阶骨骼形变可作为外部参考）。

---

## 6. 关键结论

### 6.1 推荐选型

> **主引擎：Rive（`@rive-app/canvas`，Canvas2D 后端，WebGL 按需升级）**
> **降级层：纯 CSS/SVG（reduced-motion + 静态 fallback）——不是备选，是必须交付的同一套合同的一部分**
> **备选：Lottie（若 W4 前 Rive 商业条款变化或收入预期逼近门槛）**

**理由**（对照 02-10 七维度与 R1）：

1. **状态机能力**：Rive 是唯一自带「矢量 + 骨骼 + 内建状态机 + 浏览器运行时」四要素的候选，直接命中 R1「可交互的二维骨骼/矢量状态机」，且「非 GIF/长视频/LLM 实时生成」的约束天然成立（`.riv` 是确定性静态资产）。
2. **集成面**：官方 React 封装 + Canvas 叠加（可与其他 DOM overlay 分层）+ 从 ArrayBuffer 加载（版本化离线缓存），契合 Next.js/Electron 技术栈与 R2 的离线/叠加维度。
3. **许可证**：运行时 MIT；商业条款（收入门槛约 >100 万美元）对公测阶段风险低，且三层架构（§8）保证引擎可替换，不构成供应商锁定。
4. **读屏与降级**：Rive 不提供内建无障碍语义，但这恰符合 R3——等价状态文本、静态 fallback 全部由宿主代码与 CSS/SVG 层负责，视觉合同与引擎解耦。

### 6.2 明确的架构原则（防供应商绑定，R3）

```
CompanionVisualStateV1（权威状态机，代码层，typed-action 驱动）
        │  render(state) → 纯渲染指令（枚举/参数，与引擎无关）
        ▼
Rive 渲染后端（input 驱动播放对应动画）  ←→  静态降级层（CSS/SVG/PNG/WebP）
        │
        ▼
DOM 无障碍层（role="img" + aria-live 等价状态文本，reduced-motion 生效）
```

- `CompanionVisualStateV1` 的 11 个枚举、typed-action 映射表、静态 fallback 语义**均存在于代码层合同**；Rive 内的 State Machine 只是「每个视觉状态 → 一个动画」的**实现细节**，不进合同、不进 schema、不进导出/审计。
- 引擎替换（Rive → Lottie → 纯 CSS/SVG）只需换 `render(state)` 的渲染实现，状态机与读屏文本零改动。
- **此原则即 02-10 验收「`CompanionVisualStateV1` 不因引擎改变」的实现保证。**

---

## 7. 11 状态 → Rive 状态机模型映射可行性

| CompanionVisualStateV1 | 引擎内呈现 | Rive 状态机表达 | 语义限制（01-8 §7） |
| --- | --- | --- | --- |
| `dormant` | 静态中性锚点，无 idle 动画 | 不播放动画：停在静止帧，或直接使用 CSS/SVG 静态立绘 | `quiet` 未召唤**不得进入 idle 动画** |
| `invite_once` | 一次性邀请姿态（短入场，非循环） | 单次 trigger input → 入场动画（非 looping），播完静止 | 一次性展示预算由代码层控制 |
| `navigate` | 导航姿态（指向/聚焦） | Animation State + 空间路线 overlay（Canvas/DOM 分层） | 动画只表达已发生状态 |
| `present_evidence` | 展示证据姿态 + 指向证据卡 | Animation State（loop 或静止 + 指示手势） | 不伪装评估进度 |
| `listen` | 倾听姿态 | Animation State，轻量循环或静止；**避免持续漂浮**（reduced-motion 必停） | 轻声倾听，不夸张 |
| `co_manipulate` | 共学工作台姿态 | Animation State（桌面共同操作手势） | 只表达「共同操作中」 |
| `explain` | 讲解姿态（含 06_思考短过渡灵感） | Animation State + 短过渡（trigger） | 思考过渡仅作短衔接 |
| `assessment_handoff` | 可见退场（收起工具、退到边缘、观测环接管） | 一次性退场动画（trigger），播完静止/缩小 | 表达「伴星不参与判分」 |
| `committed_change` | 弱化短确认 | 短促一次动画（非循环、无粒子/烟花） | **不做烟花/连胜/夸张庆功** |
| `uncertain_or_retry` | 思考短过渡 | 短过渡动画（trigger），播完回业务状态 | 不推断情绪、不暗中换表情 |
| `exit_or_hidden` | 直接消失 | 离场/隐藏（reduced-motion 下**直接消失**） | `temporary_hidden/global_off` 不留任何渲染痕迹 |

**可行性结论**：

1. **同构成立**：11 个状态中 10 个可表达为 Rive 的 Animation State / 静止帧，`dormant` 与 `exit_or_hidden` 以「不播放/直接卸载」实现，与引擎无关。Rive 内建状态机可直接承载全部状态与过渡（transition）。
2. **权威状态机在代码层**：Rive 的 input（bool/trigger）由代码层 `render(state)` 驱动；引擎内状态机不成为第二套业务状态，杜绝 R3 的私有语义绑定。
3. **过渡语义**：`uncertain_or_retry`、`invite_once`、`assessment_handoff`、`committed_change` 四个「一次性/短过渡」状态用 trigger input + 播完静止，避免循环动画；其余表达「进行中」的状态可用 loop 或静止帧（reduced-motion 统一降级）。
4. **`dormant` 特例**：即使主引擎为 Rive，`dormant` 建议直接落到 CSS/SVG 静态锚点层，从根上保证「quiet 无 idle 动画」。

---

## 8. 明确约束与实现守则

### 8.1 不反向修改视觉状态合同（R3）

- `CompanionVisualStateV1` 的 11 个枚举名、typed-action 映射（八动作语义映射表，01-8 §6）、静态 fallback 语义**冻结不动**，不因引擎增删改。
- 引擎资产命名、input 语义、状态机内部节点**不进入**任何 schema、DTO、审计、导出或读屏文本。
- 静态 fallback 是**一等公民**（合同层），不是引擎的附属特性。

### 8.2 reduced-motion 规则（R4）

检测：CSS `@media (prefers-reduced-motion: reduce)` + `matchMedia`（运行时），与系统/偏好设置一致（01-9 §47 提及 `follow_system / force_reduced`）。

| 被取消的动效 | 替代（合同要求） | 实现位置 |
| --- | --- | --- |
| 飞行（入场/离场/转移位移） | 姿态切换（状态直切，无位移动画）+ 短淡入（opacity 过渡 ≤0.3s 量级） | CSS 层优先，或 Rive 定帧切换 |
| 弹性缩放（bounce/spring） | 无缩放或一次性 1→1 淡入 | CSS 层 |
| 视差（多层位移） | 静态布局 | CSS 层 |
| 持续漂浮（idle loop 浮动） | 静止姿态（含 `dormant` 静态锚点） | CSS/SVG 静态帧 |
| `exit_or_hidden` | **直接消失**（无离场动画） | 代码层即时卸载 |
| `draw_route` 等空间动画 | **静态路线**（无描边生长动画的静态虚线路径） | SVG overlay |

- reduced-motion 下**不加载/不启动** Rive 实例的循环动画；可仅用静态 PNG/WebP/SVG 立绘完成全部状态（性能与无障碍双赢）。
- 播放控制：所有动画（含普通模式）遵守「一次性播放可跳过、celebrate 可跳过、偏好中可关闭」（原方案 A11y 要求）。

### 8.3 读屏路径（R5）

- 无论引擎如何渲染，Companion 容器 DOM 提供：
  - `role="img"` + `aria-label`（静态角色语义）或等价文本节点；
  - `aria-live="polite"` live region，在 `CompanionVisualStateV1` 切换时播报**等价状态文本**（如「伴星正在展示证据」「伴星已把评估交给系统」），文本来自代码层合同映射，**不读引擎内部状态**；
  - 状态切换有语义锚点（如"退出面板后焦点回原触发位置"，01-8 / 05-5 要求）。
- 读屏文本与 reduced-motion 是**同一份合同映射的两个消费端**：视觉状态 → 静态姿态/文本，均不依赖供应商。

### 8.4 加载失败降级（R7）

- Rive 资产（`.riv`）加载/解析失败、或 `matchMedia` 判定 reduced-motion、或用户关闭动画（`animation_off` 偏好）→ 走静态层：静态立绘（PNG/WebP，01-8 §5 要求）或图标化手势 + 标准控件；学习功能完整可用。
- 降级判定**先于**引擎实例化（fail-fast），避免闪现后回退。

---

## 9. 静态 fallback 方案（02-10 验收项之一）

| 层 | 内容 | 资产 | 用途 |
| --- | --- | --- | --- |
| L1 主动画 | `.riv`（矢量 + 骨骼 + 状态机，输入驱动） | Rive Editor 制作；统一画布/脚底锚点/安全边界；透明背景 | 默认模式 11 状态动画 |
| L2 静态姿态 | 每状态静态 PNG/WebP（或对应 SVG） | 与主资产同源导出；统一画布/锚点/边界 | reduced-motion、`animation_off`、`.riv` 加载失败 |
| L3 图标化手势 | 图标化手势 + 标准控件 | SVG 图标集 | 角色/动画/音频均失败时的极端降级 |
| L4 文本 | 等价状态文本（live region） | 代码层合同映射 | 读屏路径 |

- L2–L4 全部由代码层/CSS/SVG 承载，**不依赖 Rive 私有格式** → 满足 R3。
- L1 资产在 W4（05-4）制作，W0 参考图 `docs/image/learning-companion-character-action-reference.png` 仅作方向参考，需拆分为透明资产（01-8 §5）。

---

## 10. 验收项对照：W1（本 spike）↔ W4（实现）

| 引用点 | W1（本文档/阶段 02 任务 02-10） | W4（阶段 05 任务 05-4 实现） |
| --- | --- | --- |
| 选型 | 本文档 §6：**Rive 主引擎 + CSS/SVG 降级层**，Lottie 备选 | 05-4 按「W1 spike 选定引擎」落地：`CompanionVisualStateV1` 状态动画、spatial actions、`assessment_handoff` |
| 合同不变 | 本文档 §7/§8：11 状态映射可行性 + 不反向修改合同守则 | 05-4 验收「动画状态与真实 Session/assessment/commit 状态一致」：状态机权威在代码层 |
| reduced-motion / 静态降级 | 本文档 §8.2/§8.3/§9：规则 + 读屏文本 + 静态 fallback 方案 | 05-4 验收「静态降级下完整学习功能可用」；05-3/08-w7 的 reduced-motion E2E |
| 退出 Gate | 02-W1 退出 Gate：「角色动画引擎 spike 完成且不反向修改视觉合同」 | 05-W4 退出 Gate：「伴星基础角色、`assessment_handoff`、静态/reduced-motion fallback 交付」 |

**本 spike 交付的验收满足**（对应 02-10 验收）：

- [x] 引擎选型结论（§6）——Rive + 静态 fallback 方案（§9）；
- [x] 许可证/包体/帧率/离线缓存/Canvas 叠加/读屏/静态降级七维评估（§4/§5）；
- [x] `CompanionVisualStateV1` 不因引擎改变（§7/§8.1）。

---

## 11. 风险与待 Owner 确认项

| # | 风险/待确认 | 缓解/建议 | 责任 |
| --- | --- | --- | --- |
| 1 | Rive 商业条款收入门槛（约 >100 万美元）可能随版本变化 | W4 落地前复核官方最新条款；三层架构保证可替换；收入预期接近门槛时切换 Lottie 备选 | Owner + W4 执行 |
| 2 | `.riv` 资产工具链（Rive Editor 免费版能力边界） | W4 制作时验证骨骼/网格/状态机在免费层的上限；超限部分用形状动画替代 | W4 执行 |
| 3 | 包体/帧率估计基于公开资料，非实测 | W4 用真实构建 + Lighthouse/Playwright 复核，必要时按需加载（`dormant` 静态、reduced-motion 静态） | W4 执行 |
| 4 | 读屏文本与状态映射需与 05-5 Global Shell 焦点/播报约定对齐 | §8.3 已预留 live region 与焦点恢复约定；W4/W7 E2E 覆盖 | W4 + W7 执行 |
| 5 | 静态 fallback 资产（L2）与主动画资产的一致性 | 同一源文件导出双格式；统一画布/锚点/边界验收（01-8 §5） | W4 执行 |

**待 Owner 确认**：① Rive 作为主引擎（§6.1）是否批准；② 是否允许 W4 以 Rive 免费版工具链为上限制作资产；③ Lottie 备选是否需要同步出 W4 对照实现（默认不需要）。

---

## 12. 结论摘要

- **选型**：主引擎 **Rive**（`@rive-app/canvas`），降级层 **纯 CSS/SVG**（reduced-motion 与静态 fallback 的标准实现），备选 **Lottie**。
- **理由**：Rive 是唯一同时具备矢量图形、骨骼、编辑器内状态机与浏览器 Canvas 运行时的候选，直接命中「可交互二维骨骼/矢量状态机」；运行时 MIT、商业条款（收入门槛）对公测风险低；离线缓存与 Canvas 叠加自然契合 Next.js/Electron 栈。
- **合同**：`CompanionVisualStateV1` 11 状态与 typed-action 映射、静态 fallback 全部留在代码层，引擎仅作渲染后端；reduced-motion 规则（取消飞行/弹性缩放/视差/持续漂浮，改姿态切换/短淡入/描边/静态路线）与读屏等价文本由宿主层保证，**不反向修改视觉状态合同**。
- **状态**：评估完成，**待 Owner 确认选型**后进入 W4（05-4）实现。
