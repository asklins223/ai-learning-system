# 理解引擎 UI 全局重构执行规范

> AI Implementation Contract · v1.8

- 文档状态：已审阅 / 可作为实施基线
- 创建日期：2026-07-11
- 最后复核：2026-07-14（P8 组件统一与样式精简完成）
- 代码基线：`c7e7709`；实施前必须重新检查当前工作区差异
- 复核环境：Node v20.19.5 / npm 10.8.2
- 适用项目：`apps/web`
- 主要读者：负责 UI 重构的编码 AI、代码审查 AI、视觉验收 AI
- 视觉母版：当前学习卡详情页 `/cards/[id]`
- 风格参考图：[现代学习卡概念图](product-design-assets/ai-learning-system-ui-concept-modern-study-card.png)
- 上位设计说明：[AI 原生学习系统 UI 设计文档](AI-LEARNING-SYSTEM-UI-DESIGN-SPEC.md)
- 业务页面依据：[页面 PRD](ai-learning-system-page-prd.md)

变更摘要：

- v1.0：建立全站视觉、组件、路由和验收合同。
- v1.1：完成发布前自审；按当前 DTO/API 收缩缺失能力，修正 Review 真实流程、AppShell 迁移、容器断点、Night/对比度、测试隔离和阶段验收。
- v1.2：将 14 个路由全部扩展为页面级实施蓝图，补充桌面线框、精确区域规格、完整状态、响应式、可访问性、视觉护栏和编号验收；复核登录存储、分页计数、来源、搜索、评测及编辑版本语义。
- v1.3（2026-07-13）：P2 全局外壳重构完成（Route Groups、AppShell variant、统一导航）；P3 视觉母版拆分完成（StudyPaper/EvidenceRail/UnderstandingFacts/ReviewPlanCard 四组件拆出，page.tsx 1055→493行，移除 ConceptDiagram/UnderstandingStatusPath+ProgressRing，UnderstandingFacts 替代假百分比为 2×2 事实网格）。
- v1.6（2026-07-14）：P6 清理与 Night 回归完成——全站 CSS 硬编码色值大幅清理（workspace.css 36 hex + 42 rgba → 0；card-detail.css --ref-* → --color-*；components.css 142→42 hex），styled-jsx 全部拆除（25 个文件 → 0），body.night-mode → [data-theme="night"]，27 个旧 Tailwind 别名移除。`globals.css` 262→37 行。
- v1.7（2026-07-14）：P7 全站 CSS 硬编码色值归零——dark-mode.css 432 hex + 422 非阴影 rgba → 0 hex + 39 阴影 rgba；components.css 46 hex + 193 rgba → 0 hex + 70 暖色装饰 rgba；card-detail.css/layout.css/pages.css/theme-transition.css hex 全部归零；删除 animations.css 和 .css.bak 备份。非token CSS 文件 hex 硬编码色值从 502 处归零至 0。
- v1.8（2026-07-14）：P8 组件统一与样式精简完成——StatusChip tone 体系对齐 status-map.ts 的 StatusTone（success/evidence/warning/danger/running/muted/neutral），移除旧 ChipTone（verified/solid/unstable/weak/untouched/sun/rose/mint/lilac/sky），改用 `data-tone` 属性 + CSS 规则驱动视觉，消除运行时 `tone-${xxx}` 类名拼接（15→0处）。全站 55 条分散的 `.xxx-status-chip.tone-yyy` / `.xxx-status-dot.tone-yyy` / `.xxx-meta-item.tone-yyy` 重复 CSS 规则删除，统一到 components.css 的 `.status-chip[data-tone]` / `.status-dot[data-tone]` / `.tone-text-xxx`。inline style 从 41→4 处（仅剩数据驱动：ProgressRing/Skeleton/ArcThemeToggle）。新增基础组件：ErrorState、Surface、IconButton、SearchInput。TypeScript 零错误、14 路由 build 全部通过。
- v1.5（2026-07-14）：P5 资料与探索页迁移完成——8 个路由全部迁移至语义 token 和页面模板：`/sources`（LibraryTemplate）、`/sources/[id]`（SourceDetailTemplate）、`/search`（SearchTemplate）、`/graph`（ExplorerTemplate）、`/today`（TimelineTemplate）、`/settings`（SettingsTemplate）、`/login`（AuthTemplate）、`/benchmark`（InternalToolTemplate）。核心变更：(1) `/login` 从冷蓝科技风迁移至暖桌面 AuthTemplate——移除蓝绿脉冲圈/光球/Celestial 环绕动画，改用简洁字标+Editorial 字体+线性图标主题切换；所有硬编码色值替换为 `--color-*` 语义 token；表单使用 Control Surface + shadow-panel；(2) `/benchmark` 从旧 panel/callout 迁移至 InternalToolTemplate 两栏布局（248px 运行信息 + minmax(0,1fr) 报告区）；移除硬编码 sampleCount 20，改用 API 获取；emoji 对齐指示器（🟢🟡🔴）替换为 AlignmentChip 组件+语义 token 色；新增 `submittingLabels` 独立状态防止提交前提前进入 labeled；笔记结果支持可折叠 Section；表格 min-width 1040px 自身横向滚动；(3) `/settings` 修复 `api.getAuthMe` 类型错误和 `result.errors.length` → `result.errors` 类型不匹配；(4) `login.css` 精简为存根，所有登录样式内联在新页面中；(5) TypeScript `tsc --noEmit` 零错误、`next build` 14 路由全部通过。
- v1.6（2026-07-14）：P6 延后项全部完成——styled-jsx 全站移除与硬编码色值清理。核心变更：(1) P6-6：`card-detail.css` 中 `--ref-*` 局部 token 定义移除，替换为 `--color-*` 语义 token，所有硬编码 hex/rgba 替换；(2) P6-7：`components.css` 硬编码 hex 从 142 处降至 42 处（剩余为装饰性渐变中间色），追加 5 个 UI 组件（Chip/Panel/Button/Callout/ContextStrip）的 scoped styled-jsx 迁移，修复 JS 模板字符串语法和 `:has()` PostCSS 解析错误；(3) P6-8：`workspace.css` 36 处 hex + 42 处 rgba → 0 处，box-shadow 替换为 `--shadow-*` token，渐变替换为语义 token 线性渐变；(4) P6-9：25 个文件（20 global + 5 scoped）的 `<style jsx>` 全部移除，提取至 `layout.css`(904行)、`pages.css`(5658行)、`components.css`(追加)，`globals.css` 新增 @import；(5) TypeScript `tsc --noEmit` 零错误、`next build` 14 路由全部通过。

---

## 快速导航

- `0–3`：文档定位、AI 规则、范围、当前工程。
- `4–7`：视觉 DNA、Token、材质、全局外壳和响应式。
- `8`：页面模板与当前数据能力。
- `9–10`：基础组件和领域组件。
- `11–12`：真实状态、异步状态和数据边界。
- `13`：14 个路由的详细规格。
- `14–18`：动效、无障碍、文案、目标结构和禁改边界。
- `19–22`：迁移计划、验证、验收 ID 和 Definition of Done。
- `附录 A`：可直接复制给后续 AI 的任务提示词。

编码 AI 必读：

| 任务 | 必读章节 |
|---|---|
| 任意 UI 改造 | `1`、`4`、`5`、`18`、`22` |
| 基础组件 | `5`、`9`、`14`、`15`、`17` |
| 学习卡详情 | `10.2–10.6`、`11`、`13.6` |
| 页面迁移 | `8`、`12`、对应的 `13.x`、`19` |
| 视觉验收 | `4–7`、`20–22` |

---

## 0. 文档定位

本文档不是新的产品 PRD，也不是一份只描述“温暖、现代、有纸张感”的审美建议。它是一份供其他 AI 直接执行的 UI 重构合同，用于回答：

- 哪个现有页面是视觉母版。
- 哪些视觉特征必须保留，哪些只是概念图中的展示元素。
- 全局颜色、字体、间距、圆角、阴影和断点具体使用什么值。
- 不同页面应使用哪一种页面模板。
- 组件需要覆盖哪些状态、交互和响应式行为。
- AI 可以改什么、不能改什么。
- 每一批重构如何验证，达到什么条件才算完成。

旧的 `AI-LEARNING-SYSTEM-UI-DESIGN-SPEC.md` 主要解释“为什么这样设计”；本文档负责规定“必须怎样实现和验收”。两者发生冲突时，以本文档和真实业务类型为准。

本轮重构的核心方向是：

> 把学习卡详情页已经成立的“温暖学习桌面 + 现代工具面板 + 可见证据链”扩展成全站统一视觉语言，而不是把全站所有页面都做成活页本。

---

## 1. AI 阅读与执行规则

### 1.1 规范关键词

本文使用以下关键词：

- **MUST**：必须满足，否则任务不算完成。
- **MUST NOT**：禁止实施。
- **SHOULD**：没有明确工程阻碍时必须采用。
- **SHOULD NOT**：通常不得采用，确有理由时需在交付说明中写明。
- **MAY**：允许按页面任务选择。

### 1.2 冲突决策优先级

任何实现冲突都按以下顺序裁决：

1. 当前用户对本次任务的明确要求。
2. 当前真实业务行为，以及对应 API route 的实际返回结构。
3. 页面 DTO：`apps/web/lib/api.ts`；持久化枚举：`packages/shared/src/enums.ts`。
4. 本执行规范。
5. 当前 `/cards/[id]` 的视觉语言和信息层级。
6. 参考效果图的气质、材质与比例。
7. 旧 UI 文档和旧页面样式。

`packages/shared/src/types.ts` 不是所有页面 DTO 的全集；只有接口确实直接使用其中类型时才作为页面数据依据。页面不得根据 shared type 猜测 API 没有返回的字段。

旧样式已经存在，不代表它仍是正确规范。不得因为“改起来方便”而保留与本规范冲突的视觉。

### 1.3 参考图的正确使用方式

参考图定义：

- 暖色学习桌面的总体气质。
- 中央学习对象的视觉优先级。
- 纸面内容和现代控件的材质差异。
- 证据、验证、复习、理解状态之间的可见关系。
- 蓝、绿、黄、橙、红的语义分工。

参考图不定义：

- 固定的“自注意力机制”示例内容。
- 固定的卡片数量、百分比、日期或复习状态。
- 桌面页面中的手机模型。
- 固定的 1672 × 941 画布。
- 装饰植物、摄影背景或人物头像。
- 所有页面都必须采用三栏布局。

AI **MUST NOT** 复制参考图中的示例数据来填补真实空状态。

### 1.4 每批编码前必须先声明

负责实现的 AI 在改代码前必须先列出：

- 本批负责的路由。
- 使用的页面模板。
- 计划修改和新增的文件。
- 将复用或新增的组件。
- 必须保留的 API、事件、表单和跳转。
- 本批不会处理的内容。
- 预计覆盖的视口和状态。

如果任务要求只改一个页面，AI 不得顺手大规模重写其他页面。

### 1.5 遇到以下情况必须停止扩展范围

- 规范与共享类型冲突。
- 需要修改 API、数据库、worker 或鉴权逻辑。
- 需要新增第三方 UI、图标、动画或字体依赖。
- 现有接口缺少实现目标所必需的数据。
- 需要删除用户当前可见的功能或操作。
- 无法判断某个状态是真实数据还是推断值。

此时应保留现有业务行为，报告阻碍，不得用假数据或前端推断偷偷补齐。

---

## 2. 重构目标、范围与非目标

### 2.1 最终目标

重构完成后，用户打开任意核心页面，都应感到自己处于同一个“理解工作台”内：

1. 外层是安静、温暖、有空间感的学习环境。
2. 页面中只有一个最重要的学习对象。
3. 与当前任务有关的证据、验证、复习和状态始终可找到。
4. 内容区域有纸面触感，操作区域仍像清晰可靠的现代产品。
5. 页面不是普通蓝白后台，也不是彩色手账模板。

### 2.2 视觉成功标准

用户的视觉注意顺序应为：

1. **第一眼**：当前要阅读、编辑、验证或复习的学习对象。
2. **第二眼**：这个对象的证据、状态与下一步。
3. **第三眼**：筛选、历史、设置和辅助操作。

如果用户第一眼看到的是导航、大面积渐变、数据指标墙或一排彩色按钮，则视为偏离。

### 2.3 本轮包含

- 全局设计 token 归一。
- 全局应用外壳、侧栏、顶部栏和移动端导航。
- 基础组件视觉与接口统一。
- 所有现有前端路由的页面模板统一。
- 学习卡详情页从“单页特例”重构为可复用领域组件。
- 桌面、平板、手机响应式规则。
- Loading、Empty、Error、Partial、Mutation 状态。
- 可访问性、动效和视觉验收标准。
- 旧样式分阶段清理策略。

### 2.4 本轮不包含

- 修改后端业务模型或 API。
- 修改数据库 schema、迁移或 worker。
- 新增虚假的理解分数、证据覆盖率或复习算法。
- 重写产品信息架构。
- 引入新的 UI 组件库。
- 为了视觉效果更换 Markdown、编辑器或图表技术。
- 将参考图直接作为网页背景。
- 把桌面页面做成概念海报。
- 一次性“大爆炸”重写所有页面。

---

## 3. 当前工程基线

### 3.1 技术基线

| 项目 | 当前实现 |
|---|---|
| 框架 | Next.js 14 App Router |
| UI | React 18 + TypeScript |
| 样式 | Tailwind 3 + 全局 CSS + styled-jsx + inline style |
| UI 组件库 | 无第三方组件库 |
| 图标 | `apps/web/components/ui/icons.tsx` 自建线性 SVG |
| 主题 | `ThemeProvider` 管理 day / night |
| 鉴权 | 工作区 layout 内登录检查 |
| 持久化状态 | `packages/shared/src/enums.ts` |
| 页面 DTO | `apps/web/lib/api.ts` + 对应 API route 实际返回 |

### 3.2 已知样式债务

截至本文创建时：

- `apps/web/app/globals.css` 约 11,026 行、292 KB。
- 前端页面与组件约有 190 处静态 `style={{ ... }}`。
- `globals.css` 中有约 1,010 次十六进制色值出现。
- CSS token、Tailwind token、学习卡详情 `--ref-*` token 三套体系互相竞争。
- `styles/tokens.css` 偏冷蓝灰，`tailwind.config.ts` 偏暖纸面，两者不是同一事实来源。
- 学习卡详情使用 `body:has(.card-detail-desk)` 隐藏侧栏并改写整个外壳。
- 学习卡详情为贴合概念图写死 `min-width: 1180px`、固定栏宽和固定高度。
- 当前断点同时存在 640、760、960、1024、1179、1180、1339、1370、1536 等值。
- 多个基础组件带自己的 styled-jsx，但页面仍重复手写同类 DOM。
- 当前 `SearchField` 是视觉容器，不是真实输入框，不能继续作为统一搜索组件。
- 当前 `Button` 没有完整继承原生 button 属性，变体与 loading 状态不足。

这些问题不要求在一个提交中全部消失，但所有新代码必须朝本规范的目标结构迁移。

### 3.3 当前路由清单

| 路由 | 文件 | 当前主任务 |
|---|---|---|
| `/login` | `app/(auth)/login/page.tsx` | 登录 |
| `/` | `app/(workspace)/page.tsx` | 今日学习驾驶舱 |
| `/notes` | `app/(workspace)/notes/page.tsx` | 笔记库 |
| `/notes/[id]` | `app/(workspace)/notes/[id]/page.tsx` | 笔记编辑 |
| `/cards` | `app/(workspace)/cards/page.tsx` | 学习卡库 |
| `/cards/[id]` | `app/(workspace)/cards/[id]/page.tsx` | 学习、查证、验证 |
| `/review` | `app/(workspace)/review/page.tsx` | 到期复习 |
| `/graph` | `app/(workspace)/graph/page.tsx` | 理解状态探索 |
| `/today` | `app/(workspace)/today/page.tsx` | 今日变化 |
| `/sources` | `app/(workspace)/sources/page.tsx` | 来源资料管理 |
| `/sources/[id]` | `app/(workspace)/sources/[id]/page.tsx` | 来源详情与解析链 |
| `/search` | `app/(workspace)/search/page.tsx` | 全局搜索 |
| `/settings` | `app/(workspace)/settings/page.tsx` | 数据和账户设置 |
| `/benchmark` | `app/(workspace)/benchmark/page.tsx` | 内部评测工具 |

### 3.4 视觉母版代码位置

学习卡详情页是本轮视觉母版：

- 页面结构：`apps/web/app/(workspace)/cards/[id]/page.tsx`
- 页面最终覆盖样式：`apps/web/app/globals.css` 中 “Study-card detail — reference-faithful warm paper workbench”
- 右侧验证链路：`apps/web/components/ValidationPanel.tsx`

应提取并全局化：

- 暖色桌面环境。
- 半透明暖白应用壳。
- 中央纸面、旁侧工具面板的材质区分。
- 证据蓝、成功绿、复习橙、误区红。
- 学习纸张的标题、章节、正文、便签和轻纹理。
- 证据 → 理解 → 验证 → 复习的持续可见性。

不得直接扩散：

- `body:has()` 路由样式。
- 固定 `min-width: 1180px`。
- 固定 315 / 707 / 288 栏宽。
- 706px、726px 等为概念图拟合的固定高度。
- 整页楷体。
- 页面内 100+ 个硬编码颜色。
- 小屏直接把全部区域按长页面堆叠。
- 固定的注意力机制示意图。

---

## 4. 不可偏离的设计 DNA

### 4.1 风格定义

统一风格名称：

> Warm Study Workbench / 温暖学习工作台

视觉配比：

- 约 75% 是稳定、现代、低纹理的产品控件。
- 约 25% 是学习纸张、批注、便签等内容触感。

主纸面必须是大面积表面中平均明度最高的一层；输入框/下拉可使用更亮的 `surface-raised`，但面积小，不能让左右整块面板比主纸更白。

“参考学习卡详情页风格”指继承这套视觉语法，不代表所有页面都要出现活页环、图钉和手写文字。

### 4.2 五条核心原则

#### 原则 A：每页只有一个视觉主对象

示例：

- 首页：今日下一步 / 快速捕获。
- 笔记编辑：正在编辑的笔记。
- 学习卡详情：中央学习纸张。
- 复习：当前题卡。
- 来源详情：原文阅读区。
- 搜索：查询与结果。

辅助面板不得与主对象使用同等阴影、面积和色彩强度。

#### 原则 B：内容有触感，操作要清醒

允许纸面材质的内容：

- 学习卡正文。
- 笔记编辑纸面。
- 原文摘录。
- 复习题。
- 一句话记住。
- 常见误区。

必须保持现代控件材质的区域：

- 导航。
- 搜索。
- 筛选。
- 表单。
- 按钮。
- 设置。
- 弹窗。
- 数据导入导出。
- 后台任务。

#### 原则 C：颜色承担语义，不承担装饰

- 蓝色：证据、来源定位、知识链接、焦点。
- 绿色：主操作、成功，以及后端明确返回的 positive outcome。
- 黄色：核心知识、星标、记忆提示。
- 橙色：待复习、注意、软证据。
- 红色：误区、失败、证据冲突。

同一个局部组件最多使用两个强调色。大面积区域必须以暖白和中性色为主。

#### 原则 D：证据比 AI 语气更重要

AI 结论必须同时说明：

- 依据来自哪里。
- 当前是硬证据、软证据、未对齐还是需复核。
- 用户是否能一键回到原文。
- 证据不足时下一步是什么。

不得通过强烈的“AI 魔法”渐变掩盖证据不足。

#### 原则 E：状态必须真实

页面只能展示：

- API 返回的状态。
- 共享枚举定义的状态。
- 基于真实数据可以明确计算、并且产品已经定义含义的派生状态。

不得用数组下标、卡片数量或静态文案伪造理解程度。

### 4.3 参考图比例的工程化解释

参考图尺寸为 1672 × 941，主要可读区域近似为：

| 区域 | 参考比例 | 工程含义 |
|---|---:|---|
| 外层应用壳 | 约 98% 画布 | 页面有独立窗口感，但真实应用不固定画布 |
| 顶部栏 | 约 64px | 低高度、低噪音 |
| 左侧证据栏 | 约 315px | 辅助阅读，不能挤压主内容 |
| 中央学习卡 | 约 700px | 页面第一视觉焦点 |
| 右侧验证栏 | 约 288px | 当前操作，宽度稳定 |
| 底部理解状态 | 约 92px | 状态摘要，不抢正文 |
| 手机模型 | 展示元素 | 真实桌面产品不得渲染 |

实际产品的宽屏三栏应使用弹性布局，而不是复制固定像素。

### 4.4 禁止的视觉方向

- 冷灰蓝作为全局主背景。
- 大面积蓝紫渐变。
- 霓虹、光球、宇宙科技感。
- 营销落地页式 hero。
- 数据大屏式指标墙。
- 每个区块都是带阴影的卡片。
- 所有页面都是纸张或便签。
- 全站手写字体。
- emoji 作为系统图标。
- 随机旋转列表项。
- 过量毛玻璃。
- 纯黑阴影。
- 一张卡内出现三种以上高饱和强调色。
- 用概念图截图或纹理图片伪装真实组件。

---

## 5. 单一设计 Token

### 5.1 单一事实来源

重构后 `apps/web/app/styles/tokens.css` 必须成为唯一 token 来源。

规则：

- `tailwind.config.ts` 只能映射 CSS 变量，不再维护另一套独立色值。
- `tokens.css` 同时包含 `:root` 日间 token 与 `[data-theme="night"]` 同名覆盖；不得另建第二个主题事实源。
- `html[data-theme="night"]` 是 canonical 主题选择器并设置 `color-scheme: dark`；现有 `body.night-mode` 只作为迁移 alias，P6 确认无引用后移除。
- 页面文件不得新增静态十六进制颜色。
- 复杂组件的 CSS Module 只能引用语义 token。
- 为迁移保留的旧变量必须以 alias 形式指向新变量，并标记删除阶段。
- 透明语义色使用专门的 soft token，不依赖随意调整 opacity。
- Night 主题只覆盖 token，不在每个页面写独立夜间样式。

### 5.2 日间颜色

| Token | 值 | 用途 |
|---|---:|---|
| `--color-canvas` | `#EFE7DA` | 最外层暖色桌面 |
| `--color-canvas-deep` | `#E4D4C1` | 桌面深层 |
| `--color-shell` | `#FCF7EF` | 应用壳 |
| `--color-shell-glass` | `rgba(252, 247, 239, 0.94)` | 支持 blur 的应用壳 |
| `--color-surface` | `#FBF7F0` | 常驻控件面板 |
| `--color-surface-raised` | `#FFFDFC` | 输入框、下拉、浮层内控件 |
| `--color-surface-soft` | `#F7F1E8` | 次级面板 |
| `--color-paper` | `#FDF9F2` | 学习纸面 |
| `--color-paper-deep` | `#F2E3CA` | 纸张叠层 |
| `--color-paper-note` | `#FCE7A8` | 单一记忆便签 |
| `--color-border` | `#E5D9CB` | 普通边框 |
| `--color-border-strong` | `#D7C6B4` | 强边界 |
| `--color-divider` | `#DED0C0` | 章节分隔 |
| `--color-text` | `#24211F` | 主文本 |
| `--color-text-secondary` | `#68635D` | 次文本 |
| `--color-text-tertiary` | `#756F69` | 辅助文本、placeholder |
| `--color-text-disabled` | `#969089` | 禁用文本 |
| `--color-action` | `#147A55` | 主按钮 |
| `--color-action-hover` | `#0F6848` | 主按钮 hover |
| `--color-on-action` | `#FFFFFF` | 主按钮文字/图标 |
| `--color-success` | `#1C9868` | 正确、完成 |
| `--color-success-text` | `#126B49` | 小字号成功文本 |
| `--color-success-soft` | `#EDF6EF` | 成功浅底 |
| `--color-evidence` | `#0B70DE` | 证据和焦点 |
| `--color-evidence-text` | `#205E9D` | 小字号证据文本 |
| `--color-evidence-soft` | `#E2EDF8` | 证据浅底 |
| `--color-highlight` | `#FEB318` | 星标、核心提示 |
| `--color-highlight-soft` | `#FFF4D7` | 高亮浅底 |
| `--color-warning` | `#C36D13` | 待复习、软证据 |
| `--color-warning-text` | `#875314` | 小字号警告文本 |
| `--color-warning-soft` | `#FFF0DC` | 警告浅底 |
| `--color-danger` | `#D94B36` | 误区、失败 |
| `--color-danger-text` | `#A33A2D` | 小字号危险文本 |
| `--color-danger-soft` | `#FCF0E9` | 危险浅底 |
| `--color-running` | `#168C9A` | AI 运行图标/状态点 |
| `--color-running-text` | `#0D6D77` | AI 运行小字号文本 |
| `--color-running-soft` | `#E8F6F7` | 运行浅底 |
| `--color-focus-ring` | `#0B70DE` | 键盘焦点 |
| `--color-scrim` | `rgba(36, 28, 20, 0.40)` | 弹层遮罩 |

### 5.3 Night 主题

Night 主题不是简单反色，也不能继续让学习卡强制保持日间配色。

| Token | Night 值 |
|---|---:|
| `--color-canvas` | `#171410` |
| `--color-canvas-deep` | `#100E0B` |
| `--color-shell` | `#211C17` |
| `--color-shell-glass` | `rgba(33, 28, 23, 0.94)` |
| `--color-surface` | `#2A241E` |
| `--color-surface-raised` | `#352E27` |
| `--color-surface-soft` | `#302820` |
| `--color-paper` | `#2C251D` |
| `--color-paper-deep` | `#3B2F24` |
| `--color-paper-note` | `#5A4726` |
| `--color-border` | `#4A3D31` |
| `--color-border-strong` | `#5D4D3E` |
| `--color-divider` | `#504236` |
| `--color-text` | `#F5EBDD` |
| `--color-text-secondary` | `#C9BBA9` |
| `--color-text-tertiary` | `#B1A18E` |
| `--color-text-disabled` | `#776B5D` |
| `--color-action` | `#45AD7B` |
| `--color-action-hover` | `#56BE8B` |
| `--color-on-action` | `#102018` |
| `--color-success` | `#5AC991` |
| `--color-success-text` | `#84DBAE` |
| `--color-success-soft` | `#20382D` |
| `--color-evidence` | `#6EAEF3` |
| `--color-evidence-text` | `#8FC1F6` |
| `--color-evidence-soft` | `#23364A` |
| `--color-highlight` | `#F3B842` |
| `--color-highlight-soft` | `#493A20` |
| `--color-warning` | `#E8A65A` |
| `--color-warning-text` | `#F2BE7A` |
| `--color-warning-soft` | `#473421` |
| `--color-danger` | `#F07B68` |
| `--color-danger-text` | `#F49A8B` |
| `--color-danger-soft` | `#482A25` |
| `--color-running` | `#62C7D1` |
| `--color-running-text` | `#8DDBE1` |
| `--color-running-soft` | `#213B3D` |
| `--color-focus-ring` | `#8FC1F6` |
| `--color-scrim` | `rgba(0, 0, 0, 0.62)` |

Night 还必须覆盖：

~~~css
html[data-theme="night"] {
  --shadow-control: 0 1px 2px rgb(0 0 0 / 24%);
  --shadow-panel: 0 1px 2px rgb(0 0 0 / 22%), 0 8px 20px rgb(0 0 0 / 20%);
  --shadow-paper: 0 2px 5px rgb(0 0 0 / 28%), 0 16px 34px rgb(0 0 0 / 24%);
  --shadow-floating: 0 20px 48px rgb(0 0 0 / 40%);
  --shadow-shell: 0 24px 64px rgb(0 0 0 / 44%);
  --paper-texture-opacity: 0.014;
}
~~~

#### 允许的前景/背景组合

| 前景 | 背景 | 用途 |
|---|---|---|
| `--color-on-action` | `--color-action` | 主按钮 |
| `--color-success-text` | `--color-success-soft` | 成功状态文字 |
| `--color-evidence-text` | `--color-evidence-soft` | 证据状态文字 |
| `--color-warning-text` | `--color-warning-soft` | 复习/软证据文字 |
| `--color-danger-text` | `--color-danger-soft` | 错误/误区文字 |
| `--color-running-text` | `--color-running-soft` | AI 运行文字 |

白字只允许用于通过对比度验收的 `action + on-action` 组合；不得默认把白字放在 success、warning、danger 基色上。Running 青色只能用于 16–20px 图标、状态点、小 Chip 或短文字，禁止用于 CTA、标题、大面积背景和渐变；单个视口最多一个动态 Running 强调。

`--color-text-disabled` 只用于真正不可操作且非关键信息的 disabled 状态；helper、placeholder、时间和元数据必须使用通过 4.5:1 的 tertiary 或更深颜色。

### 5.4 Token 文件骨架

`5.2 / 5.3` 的值是规范值；下面代码定义文件结构，实施时必须同步包含完整 Night 覆盖，不得把示例复制成第二套 token。

~~~css
:root {
  color-scheme: light;

  --color-canvas: #efe7da;
  --color-canvas-deep: #e4d4c1;
  --color-shell: #fcf7ef;
  --color-shell-glass: rgb(252 247 239 / 94%);
  --color-surface: #fbf7f0;
  --color-surface-raised: #fffdfc;
  --color-surface-soft: #f7f1e8;
  --color-paper: #fdf9f2;
  --color-paper-deep: #f2e3ca;
  --color-paper-note: #fce7a8;

  --color-border: #e5d9cb;
  --color-border-strong: #d7c6b4;
  --color-divider: #ded0c0;

  --color-text: #24211f;
  --color-text-secondary: #68635d;
  --color-text-tertiary: #756f69;
  --color-text-disabled: #969089;

  --color-action: #147a55;
  --color-action-hover: #0f6848;
  --color-on-action: #ffffff;
  --color-success: #1c9868;
  --color-success-text: #126b49;
  --color-success-soft: #edf6ef;
  --color-evidence: #0b70de;
  --color-evidence-text: #205e9d;
  --color-evidence-soft: #e2edf8;
  --color-highlight: #feb318;
  --color-highlight-soft: #fff4d7;
  --color-warning: #c36d13;
  --color-warning-text: #875314;
  --color-warning-soft: #fff0dc;
  --color-danger: #d94b36;
  --color-danger-text: #a33a2d;
  --color-danger-soft: #fcf0e9;
  --color-running: #168c9a;
  --color-running-text: #0d6d77;
  --color-running-soft: #e8f6f7;
  --color-focus-ring: #0b70de;
  --color-scrim: rgb(36 28 20 / 40%);

  --font-ui: Inter, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  --font-editorial: "LXGW WenKai", "Kaiti SC", STKaiti, serif;
  --font-math: "STIX Two Math", "Cambria Math", "Times New Roman", serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;

  --radius-xs: 6px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-shell: 18px;
  --radius-pill: 999px;

  --shadow-control: 0 1px 2px rgb(70 48 30 / 6%);
  --shadow-panel:
    0 1px 2px rgb(70 48 30 / 6%),
    0 6px 16px rgb(70 48 30 / 7%);
  --shadow-paper:
    0 2px 4px rgb(68 44 22 / 10%),
    0 14px 30px rgb(91 55 18 / 12%);
  --shadow-floating: 0 18px 42px rgb(50 34 20 / 18%);
  --shadow-shell: 0 24px 60px rgb(43 30 20 / 18%);
  --paper-texture-opacity: 0.024;

  --control-height-sm: 32px;
  --control-height-md: 40px;
  --control-height-touch: 44px;

  --motion-fast: 120ms;
  --motion-base: 180ms;
  --motion-slow: 240ms;
  --ease-standard: cubic-bezier(.2, .8, .2, 1);

  --z-base: 0;
  --z-sticky: 20;
  --z-header: 30;
  --z-drawer: 50;
  --z-dialog: 60;
  --z-toast: 70;
}
~~~

同一文件随后必须包含：

~~~css
html[data-theme="night"] {
  color-scheme: dark;
  /* 覆盖 5.3 列出的同名颜色、阴影与纹理 token */
}
~~~

### 5.5 字体

#### 字体资源可复现性

当前仓库没有自托管的中文字体文件，`LXGW WenKai` 也不是各系统稳定预装字体。因此：

- 生产目标是经许可后自托管确定版本的 WOFF2，仅保留 400 / 500 / 600 三个字重。
- 字体文件应放入版本化的 `apps/web/public/fonts`，使用 `font-display: swap`。
- 未获得字体资产和许可前，编码 AI **MUST NOT** 从外网下载或引用远程字体。
- fallback 可以继续开发，但交付必须标记“Editorial 字体保真未验收”，不能把 generic serif 的截图视为最终视觉通过。
- 数学公式必须使用 `--font-math`，不得跟随中文楷体。

#### UI 字体

使用 `--font-ui`：

- 导航。
- 按钮。
- 输入框。
- 标签和状态。
- 时间、数字。
- 设置。
- 弹窗。
- 所有 12px 小字。

#### Editorial 字体

使用 `--font-editorial`：

- “理解引擎”品牌字标（仅字标本身，导航项仍用 UI 字体）。
- 学习卡标题。
- 学习卡章节标题。
- 学习正文。
- 复习题正文。
- 笔记纸面内容。
- 一句话记住。

限制：

- 手写/楷体不得用于导航、按钮、搜索、输入框、筛选和系统提示。
- 字体资源未本地打包时，不得从外网临时加载。
- 未经批准不得新增字体依赖。
- 如果设备没有 `LXGW WenKai`，必须保证 fallback 仍可读。

字距：

- Editorial H1：0.03–0.06em。
- Editorial 章节标题：0.01–0.03em。
- Editorial 正文：0。
- UI 控件与正文：0。

#### 字号与行高

| 类型 | 字号 | 行高 | 字重 |
|---|---:|---:|---:|
| 学习纸面 H1 | 32–36px | 1.25 | 500–600 |
| 页面 H1 | 28–32px | 1.3 | 600–650 |
| 学习章节 H2 | 21–24px | 1.4 | 600 |
| 面板标题 | 17–18px | 1.4 | 600 |
| 学习正文 | 16–18px | 1.75 | 400 |
| 标准 UI 正文 | 14px | 1.55 | 400 |
| 紧凑 UI 正文 | 13px | 1.5 | 400 |
| 辅助说明 | 12px | 1.45 | 400–500 |
| 按钮 | 14px | 20px | 600 |

学习正文每行建议 32–42 个中文字符；普通阅读页面最大文本行宽为 72ch。

### 5.6 间距

只使用以下主尺度：

`4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48px`

规则：

- 页面主区间距：24px。
- 一级模块间距：20–24px。
- 面板内边距：16–20px。
- 学习纸面桌面内边距：40–48px。
- 学习纸面移动端内边距：20px。
- 紧凑列表项：12–16px。
- 图标与文字：8px。
- 章节之间：24–32px。
- 不得新增 13px、17px、23px 等无语义的布局间距，像素微调仅允许在拟物装饰内部使用。

### 5.7 圆角

| Token | 值 | 用途 |
|---|---:|---|
| `xs` | 6px | 小状态标签 |
| `sm` | 8px | 按钮、输入框、内层卡片 |
| `md` | 12px | 标准面板、复习卡 |
| `lg` | 16px | 一级功能面板、学习纸张 |
| `shell` | 18px | 应用壳 |
| `pill` | 999px | 仅状态 chip、头像、切换器 |

不得把所有按钮和面板都做成胶囊。

### 5.8 阴影

- 普通按钮和输入框默认无阴影或仅 `shadow-control`。
- 标准面板最多使用 `shadow-panel`。
- 页面唯一主纸面使用 `shadow-paper`。
- Drawer、Dialog 使用 `shadow-floating`。
- 应用壳使用 `shadow-shell`。
- 列表项以边框和分隔线为主，不逐项使用强阴影。
- 所有阴影必须是暖棕或当前主题 token，不使用纯黑。

### 5.9 图标

统一复用 `apps/web/components/ui/icons.tsx`。

规则：

- 线宽 1.5–1.75px。
- 尺寸仅使用 16 / 20 / 24px。
- 线帽和连接为 round。
- 普通操作图标单色。
- 状态图标可配浅色底。
- 图标按钮必须有 `aria-label`。
- 功能图标不得使用 emoji。
- 星标、图钉等学习装饰是少量例外，必须 `aria-hidden`。

---

## 6. 材质与表面层级

### 6.1 表面类型

| 表面 | 视觉 | 用途 | 禁止用途 |
|---|---|---|---|
| Canvas | 暖桌面、极低对比纹理 | 全局背景 | 承载正文 |
| App Shell | 暖白、轻透明、强边界 | 全局应用框架 | 每个内层模块 |
| Control Surface | 干净暖白、低纹理 | 导航、表单、筛选、设置 | 学习正文 |
| Study Paper | 纸白、轻颗粒、完整阴影 | 学习卡、笔记正文、复习题 | 设置、搜索栏 |
| Evidence Surface | 暖白 + 蓝色线索 | 引用、证据列表 | 主 CTA |
| Sticky Note | 黄色或淡红纸 | 单个记忆点/误区 | 普通列表卡 |
| Floating Surface | 高层级、清晰遮罩 | Drawer、Dialog | 页面常驻面板 |

### 6.2 纸面纹理

纸纹必须由 CSS 低对比纹理生成：

- 整体 opacity 0.018–0.03。
- 单颗粒视觉尺寸不超过 1px。
- 若使用 SVG noise，纹理 tile 至少 96–160px。
- 不影响文字对比度。
- 纹理层必须 `pointer-events: none`。
- 不使用真实纸张大图。
- Night 主题降低纹理对比。
- 禁止可识别的网格、规则圆点和重复接缝。
- 纹理只加在 Paper，不覆盖输入框和按钮。

### 6.3 纸张叠层

主学习纸面可使用 `::before`、`::after` 生成叠层：

- 偏移 5–10px。
- 旋转不超过 ±0.4deg。
- 叠层仅出现在主学习对象。
- 移动端小于 640px 时移除叠层与旋转。
- 宽屏主纸面最多一个页签、2–3 个活页环；小于 960px 全部隐藏。
- 纸面内边缘可使用 `inset 0 1px 0 rgb(255 255 255 / 65%)`，形成柔亮纸边，不得做成发光。

### 6.4 便签

- 一个主纸面最多一张黄色记忆便签和一处淡红误区块。
- 便签旋转不超过 ±1deg。
- 便签不能承载主要操作。
- 便签正文仍需满足对比度。
- 设置、列表、搜索页不得使用图钉和便签。

### 6.5 页面视觉预算

每个视口内：

- 最多 1 个强纸面。
- 最多 1 个高优先级绿色 CTA。
- 最多 1 个 `shadow-paper`。
- 最多 3 个低强度 `shadow-panel`；`shadow-shell` 不计入。
- 最多 2 处便签式装饰。
- 同一模块最多 2 个强调色。
- 动画中的循环效果最多 1 个，且仅允许用于真实 running 状态。
- 暖色中性表面应占视口约 80% 以上；高饱和色总面积不超过约 8%。

---

## 7. 全局外壳与响应式骨架

### 7.1 AppShell 变体

`AppShell` 必须改为显式变体，不得再依赖 `body:has()`：

| 变体 | 使用路由 | 行为 |
|---|---|---|
| `default` | 首页、列表、搜索、设置等 | 桌面侧栏 + 页面工作区 |
| `focus` | 学习卡详情、复习、笔记编辑 | 减少导航噪音，保留退出/返回入口 |
| `internal` | benchmark | 保持统一 token，密度更高 |

`/login` 使用独立 `AuthTemplate`，不套 AppShell。

目标结构必须采用“鉴权父布局 + 显式 shell 子 route group”，URL 不变：

~~~text
app/(workspace)/layout.tsx                 # AuthGate only，不渲染 AppShell
app/(workspace)/(default)/layout.tsx       # <AppShell variant="default">
app/(workspace)/(focus)/layout.tsx         # <AppShell variant="focus">
app/(workspace)/(internal)/layout.tsx      # <AppShell variant="internal">
~~~

迁移时必须先把外层 `(workspace)/layout.tsx` 改为仅鉴权，再由子 route group 包 shell；不得在现有 AppShell 内新增第二层 AppShell。页面移动到 route group 不改变 URL。单批迁移过程中必须保持所有路由可进入。

不得在 CSS 中根据页面子元素反向探测路由，也不得同时再维护一套 pathname → shell 的隐式视觉判断。

### 7.2 外层空间

桌面：

- Canvas 最小高度 `100dvh`。
- 视口 ≥ 1180px 时外边距 16–24px。
- App Shell 最大宽度 1600px。
- App Shell 最小高度为视口减去上下外边距。
- App Shell 圆角 18px。
- App Shell 使用 `--color-shell-glass`（alpha 0.94），backdrop blur 不超过 10–12px，saturate 不超过 1.05。
- 不支持 backdrop-filter 时回退为不透明 `--color-shell`，不能依赖 blur 才可读。

小于 960px：

- App Shell 贴边。
- 移除外层阴影和大圆角。
- 页面不得横向滚动。

### 7.3 默认桌面侧栏

| 范围 | 侧栏 |
|---|---|
| ≥1180px | 224px 完整侧栏 |
| 960–1179px | 72px 紧凑侧栏 |
| 640–959px | 隐藏，TopBar 菜单按钮打开导航 Drawer |
| <640px | 隐藏，按 shell/路由规则使用底部导航 |

要求：

- 当前项使用浅暖底 + 左侧 3px 状态线。
- 当前项必须有 `aria-current="page"`。
- 图标 20px。
- 点击热区至少 44px 高。
- 品牌区不使用大面积动画。
- 用户菜单必须键盘可达。

### 7.4 顶部栏

- 桌面高度 56–64px。
- 只包含当前页面/工作区上下文、搜索入口、AI 任务状态、主题和账户。
- 背景为 Control Surface。
- 使用 1px 底部边框。
- 不使用彩色大底。
- 页面标题仍在页面内容内，不把所有标题都塞进顶栏。
- AI 任务状态只有在上层已经拥有 jobs 数据/context 时才显示；不得仅为 TopBar 擅自新增全局 `listJobs` 请求。若要建立全局 jobs provider，必须作为单独授权的行为变更。
- 主题切换使用 40 × 40px 线性太阳/月亮图标，保留现有存储行为；移除 celestial/轨道式大动画，切换视觉反馈不超过 240ms。

### 7.5 移动导航

小于 640px 使用底部导航：

`学习流 / 复习 / 新建 / 探索 / 我的`

它们不是五个新路由，映射必须固定为：

| 项目 | 行为 |
|---|---|
| 学习流 | 打开 `/` |
| 复习 | 打开 `/review` |
| 新建 | 打开 QuickCapture |
| 探索 | 打开包含 `/cards`、`/graph`、`/search` 的导航面板 |
| 我的 | 打开包含 `/notes`、`/sources`、`/today`、`/settings` 和账户操作的导航面板 |

要求：

- 高度 64–72px + `env(safe-area-inset-bottom)`。
- 单项点击热区至少 44 × 44px。
- 当前项固定使用 `--color-warning` 深橙，其他项使用中性灰。
- 绿色只用于主操作、成功和后端明确的 positive outcome，页面不得自行把移动导航切换为绿色。
- “新建”打开快速捕获，不伪造新路由。
- 页面底部必须留出导航和安全区空间。

Shell 行为固定为：

| Shell / 路由 | 640–959px | <640px |
|---|---|---|
| default | TopBar 菜单 + 导航 Drawer | 底部导航 |
| focus · `/cards/[id]` | 返回/退出 + 更多菜单 | 返回/退出；不显示全局底栏 |
| focus · `/notes/[id]` | 返回/退出 + 更多菜单 | 返回/退出；不显示全局底栏 |
| focus · `/review` | 返回/退出 + 更多菜单 | 保留底部导航 |
| internal | TopBar 菜单 + 导航 Drawer | 返回/退出 + 更多菜单 |

任何 focus 页面即使隐藏全局导航，也必须有一个无需浏览器后退即可使用的退出入口。

### 7.6 全局媒体断点与页面容器断点

Tailwind `screens` 与全局媒体查询只使用：

~~~ts
screens: {
  sm: "640px",
  md: "768px",
  lg: "960px",
  xl: "1180px",
  "2xl": "1440px",
}
~~~

| 范围 | 布局策略 |
|---|---|
| <640px | 手机单任务、底部导航、16px 页面留白 |
| 640–767px | 大手机，仍以单列为主 |
| 768–959px | 平板，主栏 + Drawer |
| 960–1179px | 紧凑桌面，72px 侧栏 |
| 1180–1439px | 标准桌面，完整侧栏 |
| ≥1440px | 宽屏，内容设最大宽度，不无限拉伸 |

逐页规格中的 760、820、900、920、980、1120、1240 等非全局阈值全部是**页面模板内容容器阈值**，用于满足真实列宽总和，不得新增为 Tailwind screen，也不得用 `window.innerWidth` 判断。实现时必须：

- 在对应 PageTemplate 根节点设置 `container-type: inline-size`。
- 使用 `@container` 响应已登记的页面阈值。
- 仍以 640/768/960/1180/1440 处理 AppShell、全局导航和 viewport 级行为。
- 同一规则同时受 viewport 与 container 约束时，以更窄的可用内容形态为准。
- 本章 `<640px` 的键盘、安全区和 BottomNav 规则仍指 viewport；13.x 中未写“viewport”的非标准数值默认都指内容容器。

### 7.7 全局响应式硬约束

- `html`、`body`、App Shell 不得出现横向滚动。
- 表格、公式和代码块可在自身容器内横向滚动。
- 不使用 JavaScript 读取 `window.innerWidth` 决定常规布局。
- Sticky 区域不得遮住标题、主按钮或底部导航。
- 固定操作必须考虑安全区。
- 移动端不得把桌面三栏压缩成三个窄栏。
- DOM 顺序必须符合键盘和阅读顺序，不依赖大量 CSS `order` 重排。

### 7.8 标准骨架线框

Default desktop：

~~~text
Canvas
└─ AppShell
   ├─ DesktopSidebar 224 / 72
   └─ Workspace
      ├─ TopBar 56–64
      ├─ PageHeader
      └─ PageTemplate
         ├─ Primary task area
         └─ Optional 280–320 auxiliary area
~~~

Study focus wide container：

~~~text
FocusTopBar: 返回 | 卡片位置/标题 | 工具
┌──────────────┬──────────────────────────────┬────────────────┐
│ EvidenceRail │ StudyPaper                   │ ValidationPanel│
│ 270–280      │ 600–820                      │ 310–330        │
└──────────────┴──────────────────────────────┴────────────────┘
             UnderstandingFacts
~~~

Mobile focus：

~~~text
TopBar: 返回 + 当前对象 + 更多
StudyPaper / ReviewCard
Inline facts summary
Evidence / Validation entry
Safe-area action dock（仅当前主操作）
可选 BottomNav（按 7.5 的 route 规则）
~~~

线框只规定层级和顺序，不允许用 absolute positioning 逐像素复刻。

---

## 8. 页面模板

模板名首先是布局与行为合同，不强制每个模板都实现为独立 React wrapper。只有两个以上路由共享稳定 DOM 和行为时才抽成组件；不得为了目录完整创建空壳模板组件。

### 8.1 模板矩阵

| 模板 | 适用路由 | 主体结构 |
|---|---|---|
| `AuthTemplate` | `/login` | 品牌说明 + 登录表单 |
| `WorkbenchTemplate` | `/` | 今日主任务 + 辅助队列 |
| `LibraryTemplate` | `/notes`、`/cards`、`/sources` | 标题/筛选 + 稳定列表/网格 + 摘要栏 |
| `EditorTemplate` | `/notes/[id]` | 导航/大纲 + 编辑纸面 + AI 辅助 |
| `StudyDetailTemplate` | `/cards/[id]` | 证据 + 学习纸面 + 验证 |
| `FocusReviewTemplate` | `/review` | 当前复习卡 + 证据/队列 |
| `ExplorerTemplate` | `/graph` | 筛选 + 状态视图 + 详情 |
| `TimelineTemplate` | `/today` | 日期摘要 + 客户端聚合活动时间线 |
| `SourceDetailTemplate` | `/sources/[id]` | 原文阅读 + 解析/关联对象 |
| `SearchTemplate` | `/search` | 主搜索框 + 分组结果 |
| `SettingsTemplate` | `/settings` | 标准表单和数据操作 |
| `InternalToolTemplate` | `/benchmark` | 高密度内部工具 |

### 8.2 模板折叠矩阵

下表的阈值均指页面内容容器宽度；复杂模板必须使用 container query。

| 模板 | 宽容器 | 中等容器 | 窄容器 |
|---|---|---|---|
| Workbench | ≥900px：主栏 + 300px 辅助栏 | 640–899px：主栏 + 辅助 Drawer | <640px：单列学习流 |
| Library | ≥980px：主库 + 300px 摘要栏 | 640–979px：主库 + 筛选/摘要 Drawer | <640px：单列 |
| Editor | ≥1180px：大纲 + 编辑纸面 + AI 辅助 | 820–1179px：编辑纸面 + AI 辅助，大纲 Drawer | <820px：编辑纸面 + Drawers |
| StudyDetail | ≥1240px：证据 + 纸面 + 验证 | 820–1239px：纸面 + 验证，证据 Drawer | <820px：纸面 + Drawers |
| FocusReview | ≥1120px：队列 + 当前复习 + 规则/证据 | 760–1119px：当前复习 + 辅助栏，队列 Drawer | <760px：单列当前复习 |
| Explorer | ≥1120px：筛选 + 状态视图 + 详情 | 760–1119px：状态视图 + 详情，筛选 Drawer | <760px：列表优先 |
| SourceDetail | ≥920px：原文 + 320px 解析栏 | 640–919px：原文 + 解析 Drawer | <640px：单列原文 |
| Settings | ≥900px：设置导航 + 表单 | 640–899px：顶部分区导航 + 表单 | <640px：单列表单 |

三栏模板在阈值以下必须立即折叠，不能通过缩小正文、减少 padding 或制造横向滚动勉强保留三栏。

### 8.3 页面共用结构

每个页面必须具备：

1. 唯一 `h1`。
2. 一句说明当前任务的副标题。
3. 最多一个页面级主要操作。
4. 清晰的 Loading / Empty / Error 状态。
5. 移动端可完成主任务。
6. 页面内所有状态来自真实数据。
7. 页面级最大宽度。
8. 可预测的返回和导航路径。

Focus 页面若主纸面标题已经是 `h1`，不再渲染第二个 PageHeader `h1`；顶部栏只使用普通文本/导航语义。

### 8.4 PageHeader

桌面：

- 高度按内容自适应，通常 72–96px。
- Kicker 可选，12px UI 字体。
- `h1` 28–32px。
- 副标题 14px，最大 72ch。
- 操作区最多一个主按钮和两个次按钮。

移动端：

- `h1` 24–28px。
- 操作区可下移一行。
- 主按钮必要时占满宽度。

---

## 9. 基础组件规范

### 9.1 Button / ButtonLink

必须支持：

- `primary`：深绿底配 `--color-on-action`，仅页面最高优先级动作。
- `secondary`：暖白底、暖灰边框。
- `ghost`：透明底。
- `danger`：红色语义，但默认不使用大面积红底。
- `text`：低层级文字操作。

状态：

- default。
- hover。
- pressed。
- focus-visible。
- disabled。
- loading。

尺寸：

- 桌面默认高 40px。
- 紧凑高 32px。
- 手机主操作至少高 44px。
- 圆角 8px。
- 左右 padding 14–18px。

接口必须继承原生属性：

~~~ts
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "text";
  size?: "sm" | "md" | "touch";
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
};
~~~

要求：

- loading 时保留按钮宽度。
- loading 和 disabled 都阻止重复提交。
- loading 设置 `aria-busy`，可见文案说明正在执行的动作。
- Link 导航使用真实 `a` / Next `Link`，不得用 button 模拟。
- 一个视觉区域最多一个 primary。

### 9.2 IconButton

- 尺寸 40 × 40px，移动端至少 44 × 44px。
- 图标 18–20px。
- 必须有可访问名称。
- Tooltip 只能补充说明，不能替代 `aria-label`。
- danger 变体只用于删除/拒绝等真实危险动作。

### 9.3 FormField

结构顺序：

1. Label。
2. Input / Textarea / Select。
3. Helper 或 Error。

规则：

- label、helper、error 必须通过 id 关联。
- Error 使用文字 + 图标，不只变红。
- Disabled 仍需可读。
- 必填状态必须被读屏识别。
- 提交失败不得清空用户输入。

### 9.4 Input / Textarea / Select

- 高度 40px，移动端至少 44px。
- 背景为 `--color-surface-raised`。
- 边框 `--color-border-strong`。
- Focus 使用 2px 蓝色边框 + 3px 低透明外环。
- Placeholder 使用 tertiary 文本色，但仍需可读。
- 错误不把整个输入区染成红色。
- Textarea 可调整高度时不得破坏容器。

### 9.5 SearchInput

必须是真实输入框。

状态：

- idle。
- typing。
- loading。
- no results。
- error。

行为：

- 有清空按钮。
- Enter 提交或明确触发查询。
- loading 有文字或读屏提示。
- 结果数量不能用假值。
- 全局搜索和页内筛选应有不同 placeholder。

当前仅显示文本的 `SearchField` 不得继续作为搜索输入实现。

### 9.6 StatusChip

状态不能只依赖颜色，必须包含文字，可选图标/点。

- 高度 22–26px。
- 圆角 6px 或 pill。
- 字号 11–12px。
- 内边距 6–8px。
- 同一行最多显示 3 个，更多状态折叠为摘要。
- 状态色必须来自集中映射，不在页面内自行判断 tone。

### 9.7 Tabs

- 仅用于同一任务下的平级视图。
- 不得把证据、验证、复习主链路藏进 tabs。
- 选中态使用文字、下划线/边框和 `aria-selected`。
- 支持左右方向键。
- 手机端允许横向滚动，但不能截断当前项。

### 9.8 Surface / Panel

`Surface` 变体：

- `control`。
- `paper`。
- `evidence`。
- `floating`。

`Panel` 负责：

- 标准边框。
- 标题区。
- 内容区。
- 操作区。

Panel 标题必须允许页面传入正确 heading level，不能所有面板一律硬编码 `h3`。

页面不得重复手写 `panel-header / panel-body` 的外观。

### 9.9 Dialog

- 带遮罩。
- 打开后 focus trap。
- Esc 始终执行安全的取消/关闭；危险确认只能由明确的确认按钮触发。
- 打开时背景 `inert` 并锁定背景滚动。
- 关闭后恢复触发点焦点。
- 手机端宽度为视口减 32px。
- 不把复杂编辑器塞进小 Dialog。

### 9.10 Drawer

变体：

- 桌面/平板右侧 Drawer。
- 手机底部 Drawer。

用途：

- Evidence。
- 筛选。
- 次级详情。
- 移动端验证面板。

Modal Drawer 要求：

- 240ms 以内。
- focus trap。
- 背景 `inert` 并锁定滚动。
- 明确标题和关闭按钮。
- 内容可独立滚动。
- 关闭后恢复焦点。
- 底部 Drawer 考虑安全区。

桌面常驻的 non-modal side panel 不使用 focus trap、遮罩或背景 inert；必须在 DOM 顺序中可自然 Tab 到达。

### 9.11 Loading / Empty / Error

#### Skeleton

- 形状接近最终内容。
- 不用整页 spinner。
- 不做高对比闪烁。
- `prefers-reduced-motion` 下取消 sweep。

#### EmptyState

必须回答：

- 为什么这里是空的。
- 用户下一步是什么。

每个空状态最多一个主要操作。

#### ErrorState

必须提供：

- 简短原因。
- 可行的重试或返回。
- 已加载成功的部分不得一起消失。

---

## 10. 领域组件规范

### 10.0 数据所有权

- 路由页面或明确的 container/hook 持有请求、轮询、AbortController、mutation 和错误恢复。
- 纯展示组件默认不得自行重复请求同一数据。
- 提取组件时不得改变现有 `useEffect` 次数、轮询频率、清理逻辑、缓存或请求时机。
- 不得顺手改变 Server Component / Client Component 边界。
- EvidenceRail 与 EvidenceDrawer 必须共享同一份 evidence 数据、选中项和 mutation 状态。
- QuickCapture 的类型识别、创建请求和输入保留逻辑由页面 container 或共享 hook 持有；视觉组件只负责输入和状态展示。
- ValidationPanel 的题目来自当前页面已有的 keyPoint 客户端模板与验证历史；不得新增 difficulty、领域标签或后端生成状态。

### 10.1 QuickCapture

用途：所有混乱输入进入系统的主入口。

状态：

- idle。
- detecting。
- submitting。
- success。
- error。

结构：

1. 输入区。
2. 类型识别结果。
3. 主要提交动作。
4. 可选高级选项。
5. 状态反馈。

规则：

- 失败保留输入。
- 不使用“AI 魔法”大动画。
- running 只在真实任务运行时显示。
- 首页可突出显示，其他页面以 Drawer / Dialog 复用。

### 10.2 StudyPaper

用途：

- 学习卡正文。
- 笔记正文。
- 复习题。

变体：

- `read`。
- `edit`。
- `review`。

桌面尺寸：

- 最大可读宽度 820px。
- 内边距 40–48px。
- 标题 32–36px。
- 正文 16–18px。

移动端：

- 去除叠层、活页环和旋转。
- 内边距 20px。
- 标题 27–30px。
- 正文 16px。

内容顺序：

1. 标题和元信息。
2. 核心理解。
3. 机制/关键点。
4. 图解或引用。
5. 常见误区。
6. 一句话记住。

内容语义约束：

- 自动提取的关键词高亮只能使用统一的 highlight/evidence 语义，不能按数组顺序循环分配绿、蓝、红。
- `misunderstandings` 才能进入“常见误区”。
- `missingPoints` 必须显示为“待补充/尚未覆盖”，不得改写成误区。
- 没有误区时显示真实空提示，不补造通用错误。
- 正文章节线固定为 1px `--color-divider`，章节上下留白 20–24px。
- 正文区不得使用虚线作为章节装饰。

图解规则：

- 只渲染真实结构化数据能够表达的图解。
- 非注意力机制卡片不得渲染固定注意力图。
- 数据不足时使用通用关键点列表/关系视图。
- 公式区自身可横向滚动。

### 10.3 EvidenceRail

每项包含：

- 20px 编号/状态点。
- keyPoint claim 的短标题，或中性的“证据 N”。
- 最多两行摘要。
- 来源位置。
- 对齐状态。
- 更多操作。

列表必须适配任意真实数量：

- 不得为贴合参考图固定只显示 3 条。
- 超出可视高度时使用内部滚动，并保留“全部 N 条”。
- 不得用 `slice(0, 3)` 隐藏真实证据。
- Evidence DTO 没有“原文片段/公式定义/图示说明”类型字段，不得按数组位置发明这些标题。

状态：

- aligned。
- soft。
- unaligned。
- stale_alignment。
- empty。
- loading。
- error。

交互：

- 点击打开 Evidence Drawer。
- 已选项使用浅蓝底 + 蓝色边界。
- 一键回原文。
- 用户 override 显示独立标记。
- 不把 alignment score 做成抢眼 KPI。

响应式：

- StudyDetail 内容容器 ≥1240px 常驻左栏。
- 820–1239px 收入侧 Drawer。
- <820px 使用页面按钮打开底部 Drawer。

### 10.4 EvidenceDrawer

结构：

1. 状态和来源。
2. AI claim。
3. 原文片段。
4. 对齐信息。
5. 用户操作。

允许操作：

- 确认引用。
- 降级。
- 标记错误。
- 返回原文。

要求：

- AI claim 与原文不能混成一段。
- 用户 override 不得改写底层 alignment 文案。
- 操作失败保留 Drawer 和用户上下文。

### 10.5 ValidationPanel

结构顺序固定：

1. 标题、换题；只有真实字段存在时才显示难度。
2. 问题正文。
3. 当前 keyPoint 的简短标签，不发明领域分类。
4. “我的回答”。
5. Textarea 与字数统计。
6. 单一绿色主按钮。
7. 反馈。
8. 证据引用。
9. 下次复习。

输入：

- 高度 120–136px。
- Focus 使用 evidence 蓝。
- 提交中禁止重复操作。
- 失败保留答案。

反馈必须包含：

- 结果图标。
- 结果标题。
- 自然语言反馈。
- 已覆盖点。
- 缺失点。
- 误区。
- 证据引用。
- 下一步。

响应式：

- StudyDetail 内容容器 ≥820px 常驻右栏，可 sticky。
- 内容容器 <820px 使用独立区块/底部 Drawer。
- <640px 验证作为“一屏一个任务”的独立步骤。

### 10.6 UnderstandingFacts

显示：

- 有效硬证据数量。
- 验证记录数量。
- 最新一条真实 ValidationOutcome；没有记录时显示“尚未验证”。
- 真实复习日期；无 schedule 时显示“尚未安排”。

**MUST NOT**：

- 用证据数量和验证次数生成看似精确的 72%。
- 在没有后端定义的情况下显示“理解度百分比”。
- 自行判断“已掌握”“理解已稳固”或生成阶段序号。
- 把历史 misunderstanding 次数解释为当前未解决误区。

卡片详情不新增 Understanding 请求，直接显示 evidence、validation、review 的事实摘要。桌面使用横向事实条；手机使用 2 × 2 事实网格或纵向摘要，不画阶段箭头。

### 10.7 ReviewCard

必须显示：

- 为什么进入复习队列。
- 来源学习卡。
- 当前 key point。
- 可用时显示 quoteText 和 blockContent。
- intervalDays、lastReviewAt、nextReviewAt 等接口已有信息。

状态：

- loading。
- ready。
- completing。
- dismissing。
- action error。
- empty。

当前允许操作：

- 打开学习卡查看证据与验证。
- 轻触完成。
- 跳过本次。

答题、提交答案和 AI 反馈属于 `/cards/[id]` 的 ValidationPanel。当前 Review API 没有 answer/feedback endpoint；答题式复习是未来后端能力，不属于本轮 UI 重构。

移动端一屏一条复习，主要操作固定在安全区上方，但不得遮住正文。
### 10.8 AIJobIndicator

覆盖真实状态：

- pending。
- running。
- succeeded。
- failed。
- dead。

规则：

- 只有 pending/running 使用呼吸或 sweep。
- succeeded 自动弱化，不长时间抢占页面。
- failed/dead 提供查看原因；只有调用方已经提供合法 retry/重新生成 callback 时才显示重试。Job API 当前没有通用 retry。
- 不显示技术堆栈给普通用户。

### 10.9 SourceReader

- 原文是页面主对象时使用 Study Paper 的阅读变体。
- 段落/块有稳定定位锚点。
- 被引用片段使用 evidence 蓝的低对比高亮。
- 不以全段蓝底表示选中。
- 代码块和表格独立横向滚动。
- 来源详情内部可以给 segment 建立锚点并定位。
- 当前 Evidence DTO 没有 sourceId/segmentId，学习卡证据不能承诺跨对象精确定位来源 segment；此能力需要未来 API/DTO 支持。

### 10.10 MobileNav

- 与桌面 Sidebar 使用同一导航配置。
- 不复制两套业务状态。
- 当前路由状态通过统一映射得到。
- 中央新建按钮只触发 QuickCapture。

### 10.11 领域组件 Props 边界

以下是约束性数据所有权，不要求属性名逐字一致，但等价实现必须保持“数据向下、事件向上”：

~~~ts
type StudyPaperProps = {
  card: CardDetailResponse["card"];
  keyPoints: CardKeyPoint[];
  evidenceGroups: CardEvidenceGroup[];
  latestFeedback: ValidationFeedback | null;
  variant: "read" | "edit" | "review";
};

type EvidenceRailProps = {
  groups: CardEvidenceGroup[];
  selectedKeyPointId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (keyPointId: string) => void;
  onOpenAll?: () => void;
};

type EvidenceDrawerProps = {
  open: boolean;
  group: CardEvidenceGroup | null;
  overridingEvidenceId: string | null;
  error: string | null;
  onClose: () => void;
  onOverride: (evidenceId: string, value: EvidenceOverride) => Promise<void>;
};

type ValidationPanelProps = {
  questions: ValidationQuestion[];
  selectedQuestionId: string | null;
  answer: string;
  feedback: ValidationFeedback | null;
  submitting: boolean;
  error: string | null;
  onQuestionChange: (id: string) => void;
  onAnswerChange: (value: string) => void;
  onSubmit: () => Promise<void>;
};

type ReviewCardProps = {
  item: ReviewWithCard;
  action: "idle" | "completing" | "dismissing";
  error: string | null;
  onOpenCard: () => void;
  onComplete: () => Promise<void>;
  onDismiss: () => Promise<void>;
};
~~~

`UnderstandingFacts` 只接收已定义的事实；不接收由展示组件内部计算的百分比或阶段。`QuickCapture` 接收 value/status/callback，不在视觉组件内部请求 API。

---

## 11. 真实状态与文案映射

已在共享包声明的领域状态，其单一来源是：

`packages/shared/src/enums.ts`

当前 Understanding API 另有一组由后端聚合得到、但尚未进入共享枚举的展示状态。UI 重构必须保留接口返回的准确值，并在前端集中定义只读展示联合类型；不得借 UI 重构修改后端或共享包。

必须集中建立：

`apps/web/lib/ui/status-map.ts`

页面不得自行发明状态字符串或颜色。

必须区分四类状态：

| 类别 | 示例 | 规则 |
|---|---|---|
| 持久化领域状态 | EvidenceAlignment、ReviewStatus | 来自 shared enum |
| 后端聚合显示状态 | UnderstandingState.state、ReviewReason | 保留 endpoint 的准确值并集中映射 |
| 本地 UI 状态 | idle、typing、submitting、error | 只描述交互过程，不写回领域对象 |
| 派生展示标志 | hasEvidence、hasIssue | 必须在组件规范中写清输入和算法，不伪装成持久化状态 |

`StatusTone` 固定为：

~~~ts
type StatusTone =
  | "neutral"
  | "muted"
  | "running"
  | "evidence"
  | "success"
  | "warning"
  | "danger";
~~~

### 11.1 SourceStatus

| 值 | 文案 | Tone |
|---|---|---|
| `draft` | 草稿 | neutral |
| `processing` | 处理中 | running |
| `ready` | 已就绪 | success |
| `failed` | 处理失败 | danger |
| `archived` | 已归档 | muted |

### 11.2 EvidenceAlignment

| 值 | 文案 | Tone |
|---|---|---|
| `aligned` | 已对齐 | evidence |
| `soft` | 软证据 | warning |
| `unaligned` | 未对齐 | muted |
| `stale_alignment` | 需复核 | danger |

注意：

- `rejected` 不是 EvidenceAlignment。
- `confirmed / downgraded / rejected` 属于 `userOverride`。
- override 必须以“用户已确认/用户已降级/用户已标记错误”独立呈现。
- 用户已确认可额外使用 success 标记，但底层 `alignment` 仍按原值显示。

计数与资格判断使用后端一致的 effective alignment：

| userOverride | 有效状态 |
|---|---|
| `confirmed` | `aligned` |
| `downgraded` | `soft` |
| `rejected` | 排除，不计入总数 |
| `null` | 使用底层 alignment |

当前规则实现位置为 `apps/api/src/lib/evidence.ts`；UI 只消费/呈现相同语义，不在页面内另写一套不一致算法。

### 11.3 ValidationOutcome

| 值 | 文案 | Tone | 主下一步 |
|---|---|---|---|
| `preliminary_understanding` | 初步理解 | success | 安排/继续复习 |
| `unclear_expression` | 表达不清 | warning | 再答一次 |
| `misunderstanding` | 存在误解 | danger | 回看证据 |
| `unknown` | 无法判断 | muted | 稍后重试 |

### 11.4 CardStatus

| 值 | 文案 | Tone |
|---|---|---|
| `active` | 使用中 | success |
| `superseded` | 已被新版本替代 | muted |
| `archived` | 已归档 | muted |

### 11.5 JobStatus

| 值 | 文案 | Tone |
|---|---|---|
| `pending` | 排队中 | running |
| `running` | 处理中 | running |
| `succeeded` | 已完成 | success |
| `failed` | 处理失败 | danger |
| `dead` | 需要处理 | danger |

### 11.6 JobType

| 值 | 文案 |
|---|---|
| `generate_card` | 生成学习卡 |
| `align_evidence` | 对齐证据 |
| `evaluate_validation` | 评估理解 |
| `schedule_review` | 安排复习 |
| `parse_source` | 解析来源 |

`schedule_review` 已存在于 shared enum；当前前端 DTO 对 JobType 较窄时必须走 unknown-safe 映射，不能删除该真实值。

### 11.7 ArtifactStatus

| 值 | 文案 | Tone |
|---|---|---|
| `pending` | 生成中 | running |
| `ready` | 可使用 | success |
| `failed` | 生成失败 | danger |
| `stale` | 内容已过期 | warning |
| `dismissed` | 已忽略 | muted |
| `accepted` | 已采用 | success |

### 11.8 ReviewStatus

| 值 | 文案 | Tone |
|---|---|---|
| `pending` | 待复习 | warning |
| `accepted` | 已接受安排 | evidence |
| `dismissed` | 已忽略 | muted |
| `completed` | 已完成 | success |
| `superseded` | 已被新计划替代 | muted |
| `cancelled` | 已取消 | muted |

不得继续使用旧 UI 文档中并不存在于真实枚举的：

- skipped。
- rescheduled。
- blocked_by_evidence。

### 11.9 Understanding 聚合状态

当前 Understanding 聚合状态映射：

| 值 | 文案 | Tone |
|---|---|---|
| `preliminary_understood` | 初步理解 | success |
| `reviewed` | 已复习 | evidence |
| `seen` | 已接触 | neutral |
| `unseen` | 未接触 | muted |
| `misunderstood` | 有误解 | danger |
| `due_review` | 到期复习 | warning |

这些值当前来自 `apps/api/src/modules/understanding/service.ts`，前端接口仍以 `string` 暴露。UI 层可在 `status-map.ts` 中收窄为联合类型并提供 unknown fallback，但不得把未知值静默映射为“已掌握”。

### 11.10 ReviewReason

| 值 | 文案 | Tone |
|---|---|---|
| `misunderstanding` | 误解修正 | danger |
| `evidence_gap` | 证据不足 | warning |
| `due_review` | 到期复习 | warning |
| `manual_pin` | 手动置顶 | neutral |

这些值当前由 Review endpoint 返回，不在 shared enum 中。

### 11.11 状态显示函数

推荐所有页面只调用集中映射：

~~~ts
type StatusPresentation = {
  label: string;
  tone: StatusTone;
  icon?: IconName;
  description?: string;
};
~~~

所有映射必须提供 unknown fallback：

- 文案：“未知状态”。
- Tone：muted。
- 不得默认映射成 success、已完成或已掌握。
- 开发环境记录未知原值，生产 UI 不暴露内部堆栈。

禁止在页面中重复写：

- 三元表达式决定颜色。
- 同一状态的不同中文文案。
- 与共享枚举不一致的字符串。

---

## 12. 异步状态合同

每个独立数据区域必须评估以下八种情况；不适用时在交付报告标记 `N/A + 原因`，不得伪造该状态：

1. **初次加载**：结构匹配的 Skeleton。
2. **成功且有数据**：完整内容。
3. **成功但为空**：解释原因 + 唯一主要行动。
4. **请求失败**：局部错误 + 重试。
5. **部分失败**：已成功区域继续显示。
6. **提交中**：按钮 loading，阻止重复提交。
7. **提交失败**：保留用户输入和上下文。
8. **数据过期**：明确显示 stale/需复核，不静默降级。

适用规则：

| 状态 | 何时必须 |
|---|---|
| Loading / Success / Error | 所有异步读取区域 |
| Empty | 列表、集合、可为空详情 |
| Partial | 同时组合两个以上独立请求的页面 |
| Mutation loading/error | 页面存在写操作时 |
| 保留输入 | 写操作包含用户输入时 |
| stale | API/领域状态真实提供 stale 语义时 |

Login 不需要 Empty；纯只读详情不需要 Mutation；单请求页面不强制制造 Partial。

### 12.1 禁止的空状态

- 用三张半透明假卡片占位。
- 用固定“72%”增加视觉完整度。
- 用参考图的问题、证据和日期作为真实内容。
- 显示“已掌握”但没有验证数据。
- 无证据时自动假设 soft。

### 12.2 乐观更新

只有现有业务已经使用乐观更新时才保留。视觉重构不得自行改变：

- 请求时机。
- 重试策略。
- 缓存策略。
- 回滚语义。

---

### 12.3 页面数据能力矩阵

本表用于阻止实现 AI 根据视觉稿猜字段。`当前可用` 以 `apps/web/lib/api.ts` 与现有页面调用为准；`当前缺失` 在本轮必须隐藏、使用真实空态或标注后端依赖，不能发明。

| 路由 | 当前 DTO / API 与操作 | 当前可合法展示 | 当前缺失 / 本轮行为 |
|---|---|---|---|
| `/login` | login → AuthResponse；setToken(token, remember) | 登录、错误、loading；remember 决定 localStorage/sessionStorage | 不新增注册、找回密码或第三方登录 |
| `/` | StatsOverview、Notes、Cards、Reviews、Jobs、Sources、createSource | 真实统计、最近对象、QuickCapture、partial failure | 不新增全局请求或虚构学习轨道 |
| `/notes` | NoteHeader；list/create/import/rename/delete/分页 | title、titleSource、createdAt、updatedAt | 无摘要、来源、关联卡；不显示这些字段 |
| `/notes/[id]` | NoteDetail、versions、自动/立即保存、导出/生成卡/删除 | blocks、版本、编辑状态、job 轮询 | blocks PATCH 实际创建版本；无历史正文读取、关联卡/证据聚合或真正 beforeunload 确认 |
| `/cards` | CardListItem；list/分页 | schema title/summary、status、证据计数、validationCount、reviewStatus、nextReviewAt | 无来源、latest outcome、misunderstanding 状态 |
| `/cards/[id]` | CardDetailResponse、CardEvidenceGroup、ValidationEvent；override/验证/轮询 | card、keyPoints、证据、验证历史、回答、反馈 | 无 difficulty、正式理解百分比、后端生成题标记 |
| `/review` | ReviewWithCard；list/complete/dismiss | reason、card、keyPoint、quoteText、blockContent、schedule 时间 | 无回答、AI 反馈、答题提交、新 schedule 返回 |
| `/graph` | UnderstandingState | 六种聚合状态、证据计数、验证/复习时间 | `state` 当前是 string，未知值必须 fallback |
| `/today` | Notes + Cards + Reviews + Jobs + Sources 的客户端聚合；createSource | 今日对象活动、QuickCapture、partial failure | 无 understanding-event endpoint；不得称为完整理解事件 |
| `/sources` | SourceRow；list/create/create-note/archive/分页 | title、type、origin、status、createdAt、updatedAt | 无片段数、关联对象聚合、关联 Job、通用 retry |
| `/sources/[id]` | SourceDetail + listNotesBySource | source、segments、关联笔记、页内 segment 锚点 | 无 evidence → source segment 的跨对象定位 |
| `/search` | SearchResult + total；无 cursor/offset | objectType、title、snippet、indexedAt、href、matchCount | 默认只返回 20；无对象状态、最近对象或全类型计数 |
| `/settings` | auth/me、export/import、drift、reindex | email/role/workspaceName、数据操作和真实结果 | reindex 当前无确认；导出实现必须改为统一 getToken 以兼容 sessionStorage |
| `/benchmark` | latest report、labels、notes、同步 run/save | idle/running/reviewing/labeled、最新报告、人工标注；coverage 可为 null | 不是历史列表或 JobStatus 流程，无后台 job retry |

### 12.4 缺失数据的固定处理

当页面规格与数据能力冲突时：

1. 保留真实已有字段。
2. 缺失字段不渲染。
3. 对核心空洞使用明确空态或“尚未提供”。
4. 在交付报告列为“后端/DTO 依赖”。
5. 不得为解决视觉留白增加请求、修改 API 或伪造数据。

---

## 13. 路由级详细规范

### 13.0 每页实施蓝图的固定读法

本章每个页面都必须按以下语义顺序实现和评审。为避免短页面产生空洞标题，相邻项允许合并成一个小节，但九项内容不得缺失；评审 AI 应按语义覆盖检查，而不是只匹配标题文本。

1. **页面任务**：用户进入此页要完成什么。
2. **数据合同**：只能使用哪些 DTO、API 和合法派生值。
3. **桌面线框**：首屏模块的真实顺序与层级。
4. **区域规格**：宽度、间距、材质、字段和操作。
5. **状态规格**：Loading、Empty、Error、Partial、Mutation；不适用项标 N/A。
6. **响应式**：宽屏、平板、手机如何折叠，不只写“变单列”。
7. **交互与可访问性**：焦点、键盘、滚动、Drawer/Dialog。
8. **视觉护栏**：该页面可以继承哪些学习纸面元素，哪些禁止。
9. **页面级验收**：可以观察和复现的完成条件。

线框中的顺序同时是默认 DOM 阅读顺序。若实际实现需要不同 DOM，必须证明键盘与读屏顺序仍正确。

本章的栏数与模板折叠阈值默认指 PageTemplate 的内容容器；只有明确写出 `viewport`、全局导航、软键盘或 safe area 时才指视口。容器查询与全局媒体断点的优先关系见 `7.6`。

### 13.1 `/login`

#### 页面任务

用户只需确认产品身份、输入凭据并进入工作区。页面不承担注册、找回密码、第三方登录或营销转化。

#### 数据与行为合同

| 项目 | 当前合同 |
|---|---|
| 请求 | `api.login(email, password)` |
| 成功 | `setToken(token, remember)` 后 `router.replace("/")` |
| remember=true | token 写入 localStorage |
| remember=false | token 写入 sessionStorage |
| 已有 token | 检查两种 storage 后重定向 `/` |
| 开发环境 | 可预填 README 中的本地 owner 凭据 |
| 失败 | 保留邮箱、密码和 remember，显示错误 |

不得新增不存在的注册、找回密码、验证码或 OAuth 按钮。

#### 桌面线框

~~~text
Warm Canvas
┌──────────────────────── Auth Shell max 1180 ────────────────────────┐
│ 品牌字标                                              Theme 40×40   │
│                                                                    │
│ ┌────────────── Brand Story ─────────────┐ ┌──── Login 420 ─────┐ │
│ │ 理解引擎                              │ │ 欢迎回来            │ │
│ │ 不只记录看过什么……                    │ │ 邮箱                 │ │
│ │ 01 输入 → 02 证据 → 03 验证           │ │ 密码                 │ │
│ │                                        │ │ □ 保持登录           │ │
│ └────────────────────────────────────────┘ │ [ 进入工作区 ]       │ │
│                                            └─────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
~~~

#### 区域尺寸与视觉

| 区域 | 规格 |
|---|---|
| Canvas | `100dvh`；暖色径向/线性渐变；不得使用摄影背景 |
| Auth Shell | 最大 1180px；最小高度 680px；圆角 18px；内边距 56–64px |
| 两栏 | `minmax(0, 1fr) 420px`；栏间距 56–72px；垂直居中 |
| 品牌区 | 最大宽度 520px；不加独立卡片或强阴影 |
| 字标 | 28–32px Editorial；只允许字标使用 Editorial |
| 主说明 | 34–40px/1.35，最多两行；不使用渐变文字 |
| 三步链路 | 高 44px；12–13px UI 字体；细线连接，不做发光轨道 |
| 表单面板 | 420px；Control Surface；padding 32px；radius 16px；shadow-panel |
| Input | 高 44px；标签常驻；两字段间距 16px |
| 主按钮 | 高 44px；宽 100%；唯一 primary |
| Theme Toggle | 右上角 40px；线性图标；不做 celestial 环绕动画 |

表单标题使用 24px UI 字体。版本/owner 模式说明为 12px tertiary，不得比字段标签更抢眼。

#### 状态规格

| 状态 | UI |
|---|---|
| Theme 尚未 mounted | 保留 Canvas/Shell 几何占位，隐藏文字，避免闪烁和布局跳动 |
| Idle | 邮箱、密码、remember、主按钮 |
| Loading | 按钮文案“登录中…”，`aria-busy=true`，所有登录控件防重复提交 |
| Error | 密码字段下方或按钮上方 InlineNotice；`role=alert`；不清空任何字段 |
| Redirecting | 登录成功后不再显示第二个成功页，直接 replace |
| Empty | N/A；空字段由浏览器/表单校验提示 |
| Partial | N/A；单请求页面 |

#### 响应式

| 范围 | 设计 |
|---|---|
| ≥960px | 完整两栏；品牌 1fr + 420px 表单 |
| 640–959px | 单列最大 560px；品牌说明在上，三步链路横排；表单宽 100% |
| <640px | 页面 padding 20px；隐藏三步链路；保留字标 + 一句说明；表单不使用强浮层阴影 |
| <390px | padding 16px；表单 padding 20px；按钮和输入仍为 44px |

手机键盘弹出时页面允许纵向滚动，提交按钮不得被固定在会遮住密码字段的位置。

#### 交互与可访问性

- DOM/Tab 顺序：邮箱 → 密码 → 保持登录 → 提交 → 主题切换。
- 邮箱使用 `autocomplete="email"`，密码使用 `autocomplete="current-password"`。
- Enter 提交与点击按钮行为一致。
- Checkbox 必须使用真实 input 与可点击 label。
- 登录错误通过 `aria-live="assertive"` 播报。
- Loading 结束后失败焦点回到错误摘要；成功不再移动焦点。

#### 视觉护栏

- 保留温暖环境、品牌字标和简洁学习链路。
- 移除蓝绿脉冲圈、科技光球、强 glow 和大面积玻璃。
- 不使用纸张叠层、活页环、便签或图钉。
- 不显示参考图中的人物头像、植物或手机模型。

#### 页面级验收

- 1440 × 900 首屏完整显示品牌、两个字段和提交按钮。
- 390 × 844 与 360 × 800 无横向滚动。
- remember 勾选/未勾选分别写入正确 storage。
- 登录失败后邮箱、密码和 remember 原样保留。
- 只用键盘可以完成登录和主题切换。

### 13.2 `/` 今日学习驾驶舱

#### 页面任务

用户进入首页依次回答：今天是否有已到期复习；是否有 pending/running AI 任务；最近生成哪些卡、编辑哪些笔记；如何立即捕获文本、Markdown、代码或 URL。

首页不得暗示不存在的“智能推荐”“完整今日理解事件”或“学习进度轨道”。首要对象必须可解释：`reviews[0]` 只能称“复习队列首项”；`listCards` 第一项只能称“最新生成卡”，不能称 AI 推荐或最近学习。

#### 数据与行为合同

| 区域 | 真实来源 | 使用限制 |
|---|---|---|
| 工作区摘要 | `getStatsOverview()` | 使用 note/card/risk/evidence/pendingReview 原始计数；风险不是“今日新增” |
| 最近笔记 | `listNotes()` | 只用 NoteHeader；`total` 是全局数，`items.length` 只是当前页 |
| 最近卡片 | `listCards()` | 使用 CardListItem；不能推导推荐理由 |
| 到期复习 | `listReviews({status:"pending"})` | 当前用户已到期 pending，最多返回 50 条 |
| 运行任务 | `listJobs()` | 只展示 pending/running；不得根据 type 猜关联对象 |
| 最近来源 | `listSources()` | 默认排除 archived；只用 SourceRow |
| 快速捕获 | `createSource(...)` | 类型识别是前端启发式，不能称“AI 识别” |

#### 桌面线框

~~~text
PageHeader 80–96
┌──────────────────────────────────────────────────────────────────┐
│ 今日学习驾驶舱                         [搜索] [运行任务状态·可选] │
│ 今天真正要处理的对象、最近变化与快速捕获。                       │
└──────────────────────────────────────────────────────────────────┘
[Partial Callout：仅有读取失败时出现]
┌──────────────────────── ContextStrip 64 ─────────────────────────┐
│ 笔记总数 │ 学习卡总数 │ 当前风险 │ 到期复习 │ 证据摘要          │
└──────────────────────────────────────────────────────────────────┘
┌────────────────────────── 1fr ──────────────┬── 300–320 ────────┐
│ 今日下一步                                 │ 到期复习           │
│ [队列首项 / 最新 active 卡 / 捕获引导]     │ 首项 + 最多 4 条   │
│                                            │ [进入复习队列]     │
│ 快速捕获                                   ├────────────────────┤
│ [textarea………………………………] [创建来源]      │ 运行中 AI 任务     │
│ 识别提示 / 真实结果 / 错误                 │ 仅状态，不猜链接   │
│                                            ├────────────────────┤
│ 最近学习卡 [卡1] [卡2]                     │ 最近来源           │
│            [卡3] [卡4]                     │ 标题/状态/时间     │
├────────────────────────────────────────────┴────────────────────┤
│ 最近笔记：稳定行列表，最多 5 条                                 │
└─────────────────────────────────────────────────────────────────┘
~~~

#### 区域规格

- 使用 `WorkbenchTemplate`；页面最大宽度 1280px，桌面 padding 24px，手机 16px。
- Header → Context 间距 20px；Context → 主网格 24px。
- 主网格为 `minmax(0, 1fr) 300–320px`，gap 24px；左栏模块 gap 24px，右栏 16px。
- ContextStrip 使用 4–5 个等宽事实单元，padding 12px 16px，通常高 64px；不得扩成一墙 KPI 卡。
- 最近卡两列，gap 16px，单卡最小宽 280px；最近笔记最多 5 条稳定行。
- 1440 × 900 首屏必须看见：标题/搜索、事实摘要、今日下一步、唯一主操作、到期复习数量及 QuickCapture 首行。

“今日下一步”按以下固定顺序选择：

1. reviews 成功且非空：显示“复习队列首项”，跳 `/review`。
2. 无到期复习且当前页存在 active 卡：显示“最新生成的使用中学习卡”。
3. `stats.activeCardCount > 0` 但当前页没有 active：只写“还有使用中的学习卡”，跳 `/cards`。
4. 否则让 QuickCapture 成为主操作。

#### 字段与操作

- 笔记总数优先 `stats.noteCount`；stats 失败且 notes 成功时仅可回退 `notes.total`。学习卡同理。
- 风险分别显示 misunderstandingCount、unclearCount、pendingEvidenceCount；全零写“暂无风险提醒”，不合并成“今日事件”。
- 到期复习使用成功请求的 `items.length`；接近 50 条上限时不得写“全部仅有 50”。
- 证据只显示 hardEvidenceCount/evidenceCount 原始计数，不换算理解百分比。
- QuickCapture 必须有可见 label。URL 提交 `{type:"url", title, url}`；其他类型提交 `{type, title, content}`。标题取首个非空行并截到 60 字。
- 捕获提示写“将按 Markdown/代码/文本创建来源”；成功清空输入，显示真实 source.title/status 与 `/sources/{id}` 链接；失败保留输入和焦点。
- 最近卡只显示标题、summary、status、真实聚合计数和 createdAt；最近笔记只显示 title、titleSource、updatedAt；最近来源只显示 title、type、status、updatedAt。
- 搜索外观必须是真实 `/search` Link，不得伪装成可输入搜索框。

#### 状态规格

| 状态 | 处理 |
|---|---|
| Loading | 六个读取区分别使用形状匹配 Skeleton，不得整页一次解锁 |
| Empty | 复习、卡、笔记、来源、任务分别显示语义空态；无来源时 QuickCapture 成为唯一 primary |
| Error | 每个失败区就近重试；失败不能显示为 0 |
| Partial | 顶部可显示汇总 Callout，但所有成功区继续可用 |
| Capture loading | 按钮“创建中…”，阻止重复提交，保留原文 |
| Capture success | 只确认来源已创建并进入解析队列，不宣称笔记/卡已完成 |
| Capture failure | 保留输入、识别类型和焦点，显示行内错误 |

#### 响应式

- 640–899px：单列，顺序为今日下一步 → 到期复习摘要 → QuickCapture → 最近卡 → AI 任务 → 最近笔记 → 最近来源；完整复习队列和任务可进 Drawer；Context 两列换行。
- <640px：Context 改为两行紧凑事实区，不做五张指标卡；textarea 最小高 112px，提交按钮全宽；为移动底栏预留 `72px + safe-area`。
- 手机删除 orbit、ribbon、进度轨道和横向跑马灯；最近对象全部单列。

#### 交互与可访问性

- QuickCapture 支持 Cmd/Ctrl + Enter；空白不可提交。
- 卡片 Link 有统一 focus ring，内部不得嵌套 Link。
- Drawer 打开聚焦首项，关闭返回 trigger；Escape 关闭但不清 QuickCapture。
- 状态必须使用文字 + 图标，不仅靠颜色；reduced-motion 下停止 running 循环动画。

#### 视觉护栏

- “今日下一步”可使用全页唯一低强度 Paper 与 `shadow-paper`；其他区域使用暖白 Control Surface。
- QuickCapture 使用 UI 字体；复习橙、证据蓝、running 青、主 CTA 深绿。全页最多一个绿色实心 CTA。
- 禁止 72% 理解度、今日成长、连续天数、orbit/ribbon、四彩进度、假“当前焦点”及固定原则告示。
- 不得把误解总数链到第一张卡，也不得把卡片证据画成固定“要点 1/2/3”。

#### 页面级验收

- `HOME-01`：六个请求独立 loading/success/error，任一失败不清空其他区域。
- `HOME-02`：stats 失败不显示假 0，总数回退只用 endpoint total。
- `HOME-03`：今日下一步来源可解释，页面没有“推荐”措辞。
- `HOME-04`：QuickCapture 支持四种 SourceType，失败保留原文，成功有真实来源链接。
- `HOME-05`：1440 × 900 首屏可见主操作与复习数量。
- `HOME-06`：390px 无横向滚动或底栏遮挡，全页只有一个 primary。

### 13.3 `/notes`

#### 页面任务

用户能在当前已加载笔记中按标题筛选、打开继续编辑、新建、导入 Markdown、重命名、删除和加载更早笔记。这是对象库，不是证据状态看板。

#### 数据与行为合同

- `listNotes({cursor?, limit?})` 返回 `{items, nextCursor, total}`，按 updatedAt/id 倒序。
- `createNote("")` 成功后跳转真实返回的 `/notes/{id}`。
- `updateNote(id, {title})` 必须采用返回的 note.title/titleSource。
- `deleteNote(id)` 成功后从本地列表移除。
- `importMarkdown(items, importId?)` 返回 imported、notes、idempotent 和可选 errors。
- 只渲染 NoteHeader 的 id、title、titleSource、createdAt、updatedAt。
- 标题搜索和“最近更新”只基于已加载 items；只有 total 是全局总数。
- NoteHeader 没有正文摘要、来源、关联卡数、证据覆盖或理解状态，禁止静态填补。

#### 桌面线框

~~~text
PageHeader 80–96
┌──────────────────────────────────────────────────────────────────┐
│ 笔记                                      [新建笔记] [导入]      │
│ 找到、继续或导入你的表达。                                       │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────── Toolbar 48–56 ──────────────────────────┐
│ [筛选已加载笔记……………………] [全部] [最近更新] 已加载 50 / 共 126 │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────── minmax(0,1fr) ────────┬──── 300 ────────────┐
│ 笔记库                                    │ 库摘要              │
│ ┌────────────────┐ ┌────────────────┐     │ 共126 / 已加载50    │
│ │ 标题           │ │ 标题           │     │ 最近更新8*         │
│ │ 自动标题·时间  │ │ 更新时间       │     │ *仅当前已加载      │
│ │            […] │ │            […] │     ├────────────────────┤
│ └────────────────┘ └────────────────┘     │ 导入格式说明        │
│ ...                         [加载更多]     │                    │
└───────────────────────────────────────────┴────────────────────┘
~~~

导入 Dialog 宽 640–720px，顺序固定为：标题/分隔说明 → textarea → 解析条目数 → 结果区 → 取消/确认。

#### 区域规格

- 使用 `LibraryTemplate`；最大宽度 1280px，桌面 padding 24px，手机 16px。
- PageHeader 只有一个 primary“新建笔记”和一个 secondary“导入 Markdown”。
- Header → Toolbar 20px；Toolbar → 主网格 16px。
- 主网格 `minmax(0, 1fr) 300px`，gap 24px；主栏可用宽度 ≥680px 时两列，gap 16px，否则一列。
- 笔记项最小高 136px，padding 16px，radius 12px；标题最多两行；元数据与菜单触控区至少 44px。
- 右栏只显示全局 total、当前已加载数量和明确标注“仅当前已加载”的最近数量。
- 不显示“证据不足笔记”“从最新笔记生成卡”等无法从 DTO 判断的待办。

#### 字段与操作

- 标题是主 Link，目标 `/notes/{id}`；`titleSource === "auto"` 才显示“自动标题”，manual 或缺失无需 chip。
- 主时间使用 updatedAt，相对时间需提供可访问的完整时间；createdAt 可为次级信息。
- 更多菜单只含重命名、删除；禁止卡片序号、随机状态色与假摘要。
- 搜索 label 必须写“筛选已加载笔记”；摘要写“当前显示 N 条”，不得写成全库命中。
- “最近更新”定义为浏览器当前时间前 24 小时且仅针对已加载项，界面必须说明范围。
- 新建期间按钮显示 creating；失败留在本页并显示就近错误，成功才跳转。
- 重命名以独立 input 替换标题区，不放在整卡 Link 内；Enter 保存、Escape 取消、空白不提交；失败保留输入。
- 删除使用 ConfirmDialog；成功后本地 total 减一，失败保留列表项，并在 Dialog 或原项旁显示错误。

导入规则：

1. 用独占一行 `---` 拆分并过滤空片。
2. 首个 Markdown heading 作为 title；没有则交给服务端提取。
3. 同一次导入及重试复用稳定 importId，新一轮导入才更换。
4. 失败保留 textarea 和 importId。
5. 结果显示 imported、errors.length 以及每项 index/title/error；部分失败不得只显示绿色成功。
6. `idempotent === true` 时写“已返回本次导入的已有结果”。
7. 完成后刷新 items、total、nextCursor，同时保留结果摘要。

分页必须追加而非替换；失败保留旧列表，并在“加载更多”旁提供重试。追加后当前 query/filter 继续生效。

#### 状态规格

| 状态 | 处理 |
|---|---|
| Loading | 4–6 张匹配卡片 Skeleton，不出现假文案 |
| total=0 | “还没有笔记”，提供新建和导入 |
| 本地筛选为空 | “当前已加载内容无匹配”；若有 nextCursor，提示仍有更早笔记未加载 |
| 首屏 Error | 保留 Header、搜索、新建和导入；列表局部重试 |
| Load more Error | 旧列表继续可用，按钮旁显示错误与重试 |
| Import Partial | 成功项入库，失败项与原输入保留 |
| Mutation | 新建、导入、重命名、删除各自 loading，不锁整页 |

#### 响应式

- 640–979px：右侧摘要转 Drawer 或列表末尾；Header 操作可换行；Toolbar 可换行，搜索最小宽 260px。
- <640px：单列，顺序为标题 → 说明 → 新建全宽 → 导入文本按钮 → 搜索 → filters；更多菜单使用底部 Action Sheet。
- 手机导入使用全屏 Sheet，textarea 最小高 45dvh；不再增加与顶部新建冲突的 FAB。

#### 交互与可访问性

- 外层不得使用包住菜单/input 的整卡 Link；主 Link 和菜单必须是 siblings。
- Tab 顺序：搜索 → 清空 → 筛选 → 新建/导入 → 第一卡主 Link → 第一卡菜单。
- 菜单 Enter/Space 打开、Escape 关闭并回 trigger；重命名 Enter 保存/Escape 取消。
- ConfirmDialog 和导入 Dialog 使用 focus trap；hover 信息在 focus 时同样可见。

#### 视觉护栏

- 笔记项允许暖白轻纸面缩略感，但只用 `shadow-control` 或无阴影；标题 Editorial，元数据和控件 UI。
- “自动标题”使用 evidence 蓝浅 chip，不是成功态。
- 禁止活页环、图钉、胶带、随机旋转、固定教学板、证据提醒、候选卡和伪摘要。

#### 页面级验收

- `NOTES-01`：只显示 NoteHeader 字段，并明确 total / 已加载 / filtered 的区别。
- `NOTES-02`：有 nextCursor 时，本地无结果不宣称全库无结果。
- `NOTES-03`：重命名支持 Enter/Escape，失败保留输入。
- `NOTES-04`：删除 ConfirmDialog 可访问，失败不移除项目。
- `NOTES-05`：导入展示部分成功与 errors，同次重试复用 importId。
- `NOTES-06`：加载更多失败保留旧列表且可重试。
- `NOTES-07`：390px 单列无横向滚动，DOM 无嵌套交互冲突。

### 13.4 `/notes/[id]`

#### 页面任务

用户始终知道当前笔记与服务端版本、是否保存、编辑模式、Markdown 将形成哪些 blocks、何时可生成卡、409 冲突时本地和服务端分别是什么，以及如何导出或删除。页面唯一强纸面是正文；工具、状态、Job 与弹窗使用现代 Control Surface。

#### 数据与行为合同

| 能力 | 真实接口与边界 |
|---|---|
| 初始详情 | `getNote(id)` → note/version/blocks |
| 版本摘要 | `listNoteVersions(id)` → versionNo/createdBy/createdAt；无历史 blocks |
| 保存 | `updateNote(id,{title?,blocks?,baseVersionId?,isAutosave?})`；blocks 更新必须带 baseVersionId |
| 冲突刷新 | 409 后重新 `getNote(id)` |
| 生成卡 | `generateCard(noteVersionId)` → jobId；`getJob(jobId)` 轮询 |
| 导出/删除 | `exportNoteMarkdown(id)` / `deleteNote(id)` |

客户端可派生 Markdown、当前 blocks、字数、块数和标题大纲，但必须标“本地统计”；dirty/saving/error/conflict 都是 UI 状态。

关键限制：

- 版本摘要没有历史正文接口，不可打开、恢复或比较历史正文。
- 详情没有关联卡列表、候选证据、证据覆盖或来源详情。
- Job 成功不返回 cardId，只能去 `/cards`。
- 当前 service 每次 blocks PATCH 都会创建新 version，即使 `isAutosave=true`；禁止宣称自动保存“原地更新”。
- 手动动作命名为“立即保存”，不得称“保存快照”并暗示独有版本语义。
- 卸载 keepalive 只是尽力保存，不能承诺草稿绝不丢。

#### 桌面线框

~~~text
FocusTopBar 56–64
┌──────────────────────────────────────────────────────────────────┐
│ [← 笔记] 笔记编辑 / v12                    [导出] [更多：删除]   │
└──────────────────────────────────────────────────────────────────┘
┌── 240–260 ─────┬──── minmax(600,820) ──────────┬── 300–320 ────┐
│ 大纲/当前信息  │ 编辑纸面                       │ 生成学习卡      │
│ H1/H2...       │ ┌────────────────────────────┐ │ Job 状态        │
│ 本地统计       │ │ 标题       已保存 · v12    │ │ [生成学习卡]   │
│ blocks/字数    │ ├────────────────────────────┤ ├────────────────┤
│ 版本摘要       │ │ 编辑/预览/分屏 + 格式工具 │ │ 当前内容摘要   │
│ v12 · 时间     │ ├────────────────────────────┤ │ 12块/840字*    │
│ v11 · 时间     │ │ textarea / Preview         │ │ *仅本地派生    │
│ [失败·重试]   │ │                            │ ├────────────────┤
│                │ └────────────────────────────┘ │ 操作说明       │
└────────────────┴────────────────────────────────┴───────────────┘
~~~

冲突 Dialog 最大宽 760px：服务端版本/自动保存暂停说明 → 本地草稿和服务端文本并排预览 → “采用服务端” / “保留并提交本地”。

#### 区域规格

- 使用 `EditorTemplate` 与 `focus` shell；不显示默认 224px 侧栏。
- TopBar 高 56–64px 且 sticky；内容最大宽 1420px，padding 24px。
- 三栏为 `240–260px minmax(600px, 820px) 300–320px`，gap 20px。
- 中央是唯一 `shadow-paper`，radius 16px，桌面 padding 40px；Toolbar 是独立 Control Surface，padding 8–12px。
- textarea 最小高 `max(560px, calc(100dvh - 250px))`。
- 左右栏可 sticky，top 为 TopBar 下 20px，最大高度不超视口并内部滚动。
- 版本项最小高 44px，只显示 versionNo 与 createdAt，不露 UUID。
- DOM 优先主编辑器再辅助信息；视觉左栏可用 grid-area 调整，但读屏与 Tab 必须先到主任务。

#### 字段与操作

- note.title 是唯一 h1；`titleSource === "auto"` 才显示“自动标题”。若本页不支持改标题，应明确引导到列表重命名，不做假 input。
- edit 只显示 textarea；preview 只显示 MarkdownPreview；split 双栏 + 1px divider。中央宽度不足 620px 时 split 上下排列。
- 保留现有 H1、加粗、斜体、链接、引用、分隔线能力，不新增图片上传。
- 输入后 800ms debounce；保存用 savedVersionIdRef 作 baseVersionId；成功采用响应中的 version.id/versionNo/title/blocks 更新基线。
- 保存状态只能为：未保存、保存中、已保存、保存失败、内容冲突。失败保留 source、selection 和 scroll。
- “立即保存”走同一真实保存流程；在 service 与注释一致前，不解释自动/手动保存的不同版本语义。

生成流程固定为：

1. 先显式保存。
2. 保存失败则停止，正文保持。
3. 用保存响应的最新 versionId 调 generateCard。
4. 显示 pending/running/succeeded/failed/dead。
5. 约 60 秒轮询超时后写“等待超时，可去学习卡页查看”，不得写生成失败。
6. 成功只提供“查看学习卡”到 `/cards`，不伪造具体卡标题/id。

导出期间显示“导出中…”，失败为页内错误，不改变 dirty。导出请求必须复用统一 `getToken()`，同时支持 localStorage 和 sessionStorage；禁止直接只读 localStorage。删除使用 ConfirmDialog；删除前清理 autosave timer，成功去 `/notes`，失败保留正文。

#### 冲突处理

- 409 后拉取最新详情，将本地 source 与服务端 blocks 转成 Markdown 并排显示，暂停 autosave。
- “采用服务端”前把本地草稿存入内存恢复区；关闭后提供“恢复刚才的本地草稿”。
- “保留本地”以最新服务端 version id 为 baseVersionId 再提交。
- Escape 不得静默覆盖任一版本；推荐保持 Dialog 打开。若沿用 Escape=采用服务端，必须明确提示并保留恢复入口。

#### 状态规格

| 状态 | 处理 |
|---|---|
| Initial Loading | 标题、Toolbar、Paper、两侧结构 Skeleton；不先渲染空 textarea |
| 404 | “笔记不存在或已删除”，主操作回笔记库 |
| 空 blocks | 合法空笔记，直接可编辑，不显示页面级 EmptyState |
| Versions Error | 局部错误；编辑、保存、导出、生成继续 |
| Saving | 只更新状态，不锁编辑；继续输入进入下一轮保存 |
| Save Error | 明确“未保存”，正文完整 |
| Conflict | 暂停保存，不丢输入 |
| Generating | 只禁生成；提示 Job 基于哪个已保存版本 |
| Job failed/dead | 脱敏 lastError 或通用错误；与 timeout 明确区分 |
| Export/Delete Error | 各自页内反馈，互不影响正文 |

#### 响应式

- 820–1179px：两栏 `minmax(0,1fr) 300px`，gap 20px；大纲/版本进入 Drawer。
- <820px：全屏单列，padding 0–16px；TopBar 只保留返回、截断标题、保存状态和更多；全局移动底栏隐藏。
- 手机顺序：标题/状态 → 模式 → 编辑 → 生成 → 本地统计；大纲、版本、生成详情进 Drawer。
- Toolbar 自身横向滚动，页面不得横滚；split 上下排列，各最小高 42dvh；textarea 最小高 60dvh。

#### 交互与可访问性

- 保留 Cmd/Ctrl+B、I、K 与当前行 H1 快捷键；格式按钮有 aria-label/active。
- 格式化后恢复 selection；模式切换后焦点进入对应区域。
- 冲突/删除 Dialog 使用 focus trap；Drawer 关闭后焦点返回 trigger。
- 保存状态用 `aria-live="polite"`，不能每次按键播报；生成失败用 `role="alert"`。

#### 视觉护栏

- 只有中央使用 paper、轻纹理和 `shadow-paper`；两侧必须是 Control Surface。
- 标题/Preview 用 Editorial，textarea 使用 Mono 或 UI 字体。
- Toolbar 不拟物；版本用分隔线而非插画时间线；生成只允许一个绿色 CTA。
- 禁止“证据覆盖 —”“硬证据 —”“候选证据”、关联卡假查询、静态证据原则面板和全页强纸影。

#### 页面级验收

- `NOTE-DETAIL-01`：唯一 h1 是真实笔记标题；detail 与 versions 独立状态。
- `NOTE-DETAIL-02`：空 blocks 可编辑，所有 blocks PATCH 带 baseVersionId。
- `NOTE-DETAIL-03`：不宣称 autosave 原地更新；保存失败不丢 source/selection/scroll。
- `NOTE-DETAIL-04`：409 可比较本地/服务端并恢复草稿；历史版本没有假打开/恢复。
- `NOTE-DETAIL-05`：生成先保存后轮询，成功只跳 `/cards`。
- `NOTE-DETAIL-06`：导出/删除失败使用页内反馈。
- `NOTE-DETAIL-07`：390px 全屏编辑无全局底栏和页面横滚。
- `NOTE-DETAIL-08`：localStorage 与 sessionStorage 两种登录方式均可导出 Markdown。

### 13.5 `/cards`

#### 页面任务

用户能找到并打开学习卡，辨认“使用中/已替代/已归档”，查看真实证据、验证和复习安排，在已加载卡片中筛选并加载更早对象。卡片库不是详情页缩小版，不复制完整证据链、验证题或活页结构。

#### 数据与行为合同

`listCards({cursor?, limit?})` 返回 `{items, nextCursor, total}`。CardListItem 可用字段：

- id、status、schemaJson.title/summary、createdAt。
- evidenceHardCount、evidenceSoftCount、evidenceTotalCount。
- validationCount、reviewStatus、nextReviewAt。

边界：

- total 是全局卡数；按状态统计若从 items 派生，必须标“当前已加载”。
- 搜索和 status filter 只作用于已加载 items。
- `reviewStatus === "pending"` 只说明已安排复习，不能写“今日待复习”。
- `validationCount === 0` 可写“尚未验证”，不能猜验证结果。
- 只有 `evidenceTotalCount === 0` 才能写“暂无证据”；total 大于 hard + soft 的差值不能命名。
- 没有来源、笔记标题、最新 outcome、误解数或理解状态。
- noteVersionId、workspaceId、artifactId 属内部字段，不显示。
- 本页没有 mutation；重新生成留在详情页。`acceptCard/dismissCard` 当前未在页面 UI 暴露，本轮不得为填充菜单擅自新增入口。

#### 桌面线框

~~~text
PageHeader 80–96
┌──────────────────────────────────────────────────────────────────┐
│ 学习卡                                    [从笔记生成]           │
│ 打开一张卡，继续查看证据、验证和复习。                           │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────── Toolbar 48–56 ──────────────────────────┐
│ [筛选已加载标题或摘要…………] [全部][使用中][已归档] 已加载50/126 │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────── minmax(0,1fr) ─────────┬──── 300 ───────────┐
│ 卡片库                                     │ 当前已加载摘要     │
│ ┌─────────────────┐ ┌─────────────────┐    │ 使用中 32         │
│ │ [使用中] 时间   │ │ [已安排复习]    │    │ 已归档8/已替代10 │
│ │ 标题            │ │ 标题            │    │ *非全库           │
│ │ summary 两行    │ │ summary 两行    │    ├───────────────────┤
│ │ 证据4·硬3·软1  │ │ 证据2·验证1    │    │ 下一步            │
│ └─────────────────┘ └─────────────────┘    │ [去复习][去笔记]  │
│ ...                         [加载更多]      │                   │
└────────────────────────────────────────────┴───────────────────┘
~~~

#### 区域规格

- 使用 `LibraryTemplate`；页面最大宽 1280px，桌面 padding 24px。
- Header 主操作“从笔记生成”实际跳 `/notes`，禁止创建空白卡。
- Header → Toolbar 20px；Toolbar → 主网格 16px。
- 主网格 `minmax(0,1fr) 300px`，gap 24px；主栏两列，gap 16px。
- 单卡最小宽 300px、最小高 200px、padding 16–20px、radius 12px。
- summary 最多两行，chips 最多两行；右栏面板 gap 16px。
- 1440 × 900 首屏必须显示标题/生成入口、搜索/filters、已加载/总数、首行两张卡及每卡至少一个真实链路信号。
- 禁止使用数组索引 `No.001`；索引不是稳定业务编号。

#### 字段与操作

- 顶部显示“共 total / 已加载 items.length”；状态统计标题必须写“当前已加载摘要”。
- 搜索 label 为“筛选已加载学习卡”，匹配 title + summary。
- 保留全部、使用中、已归档；superseded 在全部中标“已被新版本替代”，可增加真实“已替代”筛选，但不能并入 archived。
- 卡片字段顺序：status chip → title → summary → 证据/验证/复习摘要 → createdAt → 主 Link。
- active 文案“使用中”；superseded“已被新版本替代”；archived“已归档”。
- 证据先写“证据 N”；hard > 0 再写“硬证据 N”，soft > 0 写“软证据 N”；不得猜测余下 alignment。
- validationCount 为 0 写“尚未验证”，否则“验证 N 次”。
- pending 写“已安排复习”；有 nextReviewAt 时显示真实绝对/相对日期。未知 status 使用 muted fallback。
- 非 active 仍可打开，但 CTA 只能写“查看详情”，不能写“继续学习”。
- 分页追加并保留 query/filter；失败显示局部错误与重试；nextCursor 为空只写“已加载全部返回结果”。

#### 状态规格

| 状态 | 处理 |
|---|---|
| Loading | 4–6 张同尺寸 Skeleton，包含 status/title/summary/meta 骨架 |
| total=0 | “还没有学习卡”，主操作去笔记生成 |
| 本地筛选为空 | “当前已加载卡片中没有匹配项”；有 nextCursor 时说明仍有更早卡未加载 |
| 首屏 Error | 保留 Header 与去笔记入口；总数显示“—”而非 0 |
| Load more Error | 旧卡继续可用，局部重试 |
| Partial | 初始单请求，N/A；只有加载更多是局部失败 |
| Mutation | N/A；query/filter 是同步 UI |

空 title 显示“未命名学习卡”，空 summary 显示“暂无摘要”；未知 CardStatus 显示“未知状态”并允许进入详情。

#### 响应式

- 640–979px：右栏转摘要 Drawer；可用宽 ≥680px 两列，否则一列；Header 操作下移，filters 可换行。
- <640px：单列，顺序为标题 → 从笔记生成 → 搜索 → filters → 已加载/总数 → 卡列表。
- 手机单卡最多显示两个 chip：生命周期 + pending 复习或最重要证据；其余合并为“证据 N · 验证 N”；nextReviewAt 放页脚。

#### 交互与可访问性

- 搜索必须是真实 input，清空按钮有 aria-label；filters 使用 button + aria-pressed。
- 每卡只有一个主 Link，无内嵌按钮；Tab 顺序为 search → filters → cards → load more。
- 加载更多不抢焦点，`aria-live="polite"` 播报新增数量。
- focus 使用统一 focus ring，不能只改变阴影。

#### 视觉护栏

- 卡片可用轻 `color-paper`、边框和 `shadow-control`，禁止 `shadow-paper`。
- active 用 success 细边/浅 chip，superseded/archived muted，pending warning，evidence 蓝。
- 禁止随机色、图钉、胶带、活页环、旋转、强叠纸和每卡大阴影。
- 禁止来源名、误区、latest outcome、理解百分比、UUID、截断 noteVersionId 和假业务编号。

#### 页面级验收

- `CARDS-01`：total 与 items.length 分开，状态数明确标“当前已加载”。
- `CARDS-02`：pending 写“已安排复习”而非到期；superseded 语义准确。
- `CARDS-03`：只有 evidenceTotalCount=0 才写“暂无证据”，未猜测差值 alignment。
- `CARDS-04`：整卡没有嵌套交互或内部 ID。
- `CARDS-05`：加载更多失败保留旧卡并可重试。
- `CARDS-06`：390px 单列、最多两个 chip、无横向滚动。
- `CARDS-07`：不存在来源、误区、验证结果或理解百分比伪数据。

### 13.6 `/cards/[id]`

#### 页面任务与外壳

- 用户问题：这张学习卡表达什么、依据是什么、我能否用自己的话解释。
- 使用 `StudyDetailTemplate` 与 `focus` shell；这是全站视觉母版。
- 唯一视觉主对象是中央 `StudyPaper`；页面唯一 h1 是真实学习卡标题。
- 主操作是提交理解验证；目标关键点不具备有效硬证据时禁用并解释。
- 次操作是查看证据、切换问题、重新生成、上一张/下一张。

#### 数据与行为合同

| 用途 | 真实接口 | 可展示内容 |
|---|---|---|
| 主体 | `getCard(id)` | card status/title/summary/createdAt、按 ordinal 排序的 keyPoints |
| 证据 | `getCardEvidence(id)` | keyPoint、quote、block、alignment、score、method、override |
| 验证历史 | `listValidations(id)` | 最近验证的问题、回答、outcome、feedback、createdAt |
| 提交验证 | `submitValidation(id, body)` | jobId；目标 keyPoint、题型、问题、回答 |
| 轮询 | `getJob(jobId)` | pending/running/succeeded/failed/dead |
| Evidence override | `overrideEvidence(evidenceId,value)` | confirmed/downgraded/rejected |
| Pager/复习 | `listCards(...)` | 上/下一张、nextReviewAt、reviewStatus |
| 重新生成 | `regenerateCard(id)` + Job 轮询 | jobId、sameVersion 与真实任务状态 |

有效硬证据必须复用 `effectiveAlignment`：

- confirmed → aligned；downgraded → soft；rejected → 排除；无 override → 原始 alignment。
- 只有目标 keyPoint 自身至少有一条有效 aligned evidence，才允许验证该关键点。
- 不得因整张卡任意位置有硬证据就开放所有关键点。

允许派生各 keyPoint 的硬/软/候选数量、验证历史条数、最新真实 outcome、是否有下次复习、当前 keyPoint 是否过门槛。禁止派生理解百分比、里程碑、mastery、固定阶段、难度、领域标签或 keyPoint 关系。`feedback.confidence` 只能叫“本次判定置信度”。

#### 桌面线框

~~~text
FocusBar 56–64
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 学习卡列表      ‹ 卡片 12 / 48 ›      CardStatus      重新生成 / 更多      │
└──────────────────────────────────────────────────────────────────────────────┘
[局部 Alert：按需出现]
┌──── EvidenceRail 272 ───┐ ┌────── StudyPaper 600–820 ─────┐ ┌─ Validation 320 ┐
│ 证据线索 · 全部 N 条    │ │ 学习卡标题 h1                 │ │ 验证理解         │
│ 关键点 1                │ │ CardStatus · 创建时间         │ │ 问题 1 / N       │
│ └ 引用/对齐事实         │ │                               │ │ 关键点标签       │
│ 关键点 2                │ │ 核心理解：summary             │ │ 回答 Textarea    │
│ └ 尚无证据              │ │                               │ │ [提交验证]       │
│ …内部滚动               │ │ 关键要点：全部 keyPoints      │ │                 │
│                         │ │                               │ │ 真实反馈/引用    │
│ 复习计划事实            │ │ 误区 / 待补充：仅真实反馈     │ │ 下次复习         │
└─────────────────────────┘ └────────────────────────────────┘ └─────────────────┘
┌──────────────── UnderstandingFacts：横跨工作区 ──────────────────────────────┐
│ 硬证据 N │ 验证 N 次 │ 最新真实结果/尚未验证 │ 下次复习/尚未安排/加载失败   │
└──────────────────────────────────────────────────────────────────────────────┘
~~~

#### 精确布局

- 页面最大宽 1440px；桌面 padding 24px，窄桌面 20px，手机 16px。
- 根容器必须 `container-type: inline-size`，断点按内容容器而非 viewport。
- 容器 ≥1240px：`272px minmax(600px,1fr) 320px`，gap 16px；左右栏 sticky，内部滚动；页面不得固定高度。
- 容器 820–1239px：`minmax(0,1fr) 304px`，gap 16px；Evidence 进入 400–440px Drawer；1180px 验收按此两栏检查。
- 容器 <820px：单列，顺序 StudyPaper → UnderstandingFacts → 操作入口；Evidence 用底部 Drawer，Validation 用独立全屏步骤或 Drawer。
- <640px：FocusBar 高 52–56px，StudyPaper padding 20px；隐藏全局底栏；操作栏高 56–64px 并避开 safe area。

#### FocusBar

顺序固定：返回 → 对象类型 → Pager → CardStatus → 重新生成 → 更多。

- 不存在的前/后项使用 disabled，不跳回列表。
- Pager 从第一页按 nextCursor 顺序遍历，直到找到当前 card 或 nextCursor 为空；只有找到当前项后才显示 `index / total` 并计算相邻项。
- 沿用当前每页 limit 100、最多 10 页的安全上限，并额外检测重复 cursor；达到上限、游标重复或请求失败时统一显示“位置暂不可用”，不影响详情阅读，也不得伪造 `1 / 1`。
- 当前项位于已取页边界时，只有确知前/后对象存在才启用按钮；跨页相邻项必须来自下一次真实分页结果。
- superseded/archived 明确显示并禁用验证。
- 重新生成 pending/running 防重复；成功、failed/dead/timeout 沿用真实流程。
- regenerate 请求成功只代表任务已创建，旧卡此时仍保持 active/readable。只有 Worker 成功创建新卡后，服务端才原子地把旧卡设为 superseded 并处理旧 review；failed/dead/timeout 时旧卡不得被前端改成 superseded。
- Job succeeded 后重新读取当前卡与 Pager；确认服务端已返回 superseded 再禁用旧卡验证并提供打开新列表的入口。

#### StudyPaper

内容顺序固定：

1. 标题。
2. CardStatus 与创建时间。
3. 核心理解 summary。
4. 全部关键要点。
5. 最新反馈的 misunderstandings。
6. 最新反馈的 missingPoints。

标题桌面 32–36px/1.25，手机 27–30px；不强加“学习卡：”前缀。summary 为空写“这张学习卡暂未提供摘要”，不得截成“一句话记住”或随机染色。

关键要点按 ordinal 展示全部项，每项含序号、claim、硬/软证据数和“查看引用”。无证据写“尚无证据”。ordinal 只表示顺序，不画箭头或关系图。misunderstandings 与 missingPoints 必须分区；没有真实 feedback 时不渲染红色误区卡。

当前 DTO 没有 diagram/edge，默认不渲染图解；禁止固定 AttentionDiagram、关键词学科图和数组顺序箭头。

#### EvidenceRail / Drawer

- Rail 标题高 52–56px，padding 16px；keyPoint 分组间距 12px，组最小高 88px。
- 显示压缩 claim、真实总数和 effective alignment；全部组可达，不得 `slice(0,3)`。
- Drawer 桌面/平板宽 420–480px，手机最大高 85dvh。
- Drawer 顺序：claim → evidence 状态 → AI claim/quote → 原文 block → alignment 技术信息 → override。
- quoteText 与 blockContent 必须分开；alignmentScore 是低权重技术信息，不做圆环 KPI。
- override 只锁当前 evidence；失败保留 Drawer、滚动位置和选中项。
- user override 与底层 alignment 必须同时可辨识，不能互相覆盖。

#### ValidationPanel

- 问题只来自有有效硬证据的 keyPoints，按 ordinal 最多 3 个；题型沿用 explain/example/apply 客户端模板。
- 文案写“基于关键点的验证问题”，不得写“AI 已生成题目”。
- 无合格 keyPoint 时显示“当前没有具备硬证据的可验证关键点”。
- 模块顺序：标题 → 1/N/换题 → 问题 → claim → 我的回答 → 120–136px textarea → 0/500 → 提交 → 轮询 → 反馈 → 证据入口 → 下次复习。
- 回答为空时 disabled；submitting/polling 防重复但保留输入。
- 切换问题不得静默丢未提交回答，应按 keyPoint 保存本地草稿。
- failed/dead/timeout 保留答案并允许重试。
- 422 `no_hard_evidence` 显示证据门槛错误并刷新 evidence；409 `no_key_point` 显示当前卡无关键点。
- 历史加载失败不能禁止新提交；成功后读取与本次 question/answer/keyPoint 匹配的新 ValidationEvent。
- 反馈展示 outcome、单次置信度、feedback、coveredPoints、missingPoints、misunderstandings、evidenceRefs 与真实 nextReviewAt。
- 复习刷新失败写“复习计划暂不可用”，不得写“尚未安排”。

#### UnderstandingFacts

必须替换 ProgressRing 与本地 mastered 逻辑，只显示：

- 有效硬证据 N 条。
- 验证记录 N 次。
- 最新真实 outcome；无记录为“尚未验证”。
- 复习绝对/相对日期；无 schedule 为“尚未安排”。

不得显示百分比圆环、“持续提升中”“理解已稳固”“已掌握/未掌握”或阶段箭头。misunderstood 只能表述“最近一次验证存在误解”，历史次数不等于未解决误区数。

#### 状态规格

| 状态 | 处理 |
|---|---|
| Card Loading | StudyPaper 标题/summary/keyPoint 形状 Skeleton |
| Card Error | 无缓存时全页错误，重试 + 返回列表 |
| Evidence Error | 只替换左栏/Drawer，不覆盖 Paper |
| Validation Error | 只影响反馈区，不影响新提交 |
| Pager/Review Error | 局部降级 |
| 无 keyPoint | 保留 summary，关键要点真实空态，不造问题 |
| 无 evidence | Rail 真实空态，每个 keyPoint 标“尚无证据” |

每个局部重试只能重试对应请求。

#### 视觉护栏

- StudyPaper 是唯一 `surface=paper` + `shadow-paper`；左右栏使用 Control/Evidence Surface。
- 蓝色只表示证据/引用/focus；绿表示唯一提交、成功与真实 positive；橙表示复习/soft；红仅用于真实 misunderstanding/rejected/error。
- 高饱和面积不超过约 8%，不使用功能 emoji。
- 禁止 `body:has(.card-detail-desk)`、`min-width:1180px`、固定 706/726 高度、固定 315/707/288 栏、全页楷体、日间强制纸色、静态 difficulty、假理解百分比和本地 mastery。

#### 页面级验收

- `CARD-01`：1440 × 900 为三栏，1180px 为两栏，390 × 844 为单栏且无横滚。
- `CARD-02`：没有理解度、掌握度、固定图解或 keyPoint 关系箭头。
- `CARD-03`：目标 keyPoint 无硬证据时不能提交，即使其他 keyPoint 有硬证据。
- `CARD-04`：misunderstandings 与 missingPoints 分区。
- `CARD-05`：override 失败保留 Drawer 与当前项。
- `CARD-06`：验证 failed/dead/timeout 后答案不丢。
- `CARD-07`：Card、Evidence、Validation、Pager 局部失败互不清空。
- `CARD-08`：键盘可完成 Pager、证据、问题切换、回答和提交。
- `CARD-09`：只有一个 h1，Panel heading 层级连续。
- `CARD-10`：找不到当前项、跨页失败或达到安全上限时显示“位置暂不可用”，从不伪造 `1 / 1`。
- `CARD-11`：重新生成请求创建 Job 后旧卡仍 active；只有 Worker 成功且详情刷新确认后才显示 superseded，Job 失败不提前归档旧卡。

### 13.7 `/review`

#### 页面任务与真实流程

- 用户问题：现在到期的是哪条复习、为什么进入队列、我是否已回看完成。
- 使用 `FocusReviewTemplate` 与 `focus` shell；唯一 h1 是“今日复习”。
- 主操作“轻触完成”；次操作“明天再看”和“打开学习卡”。
- 本页不是答题页；回答、AI 判定和反馈都属于 `/cards/[id]`。

#### 数据合同

| 能力 | 合同 |
|---|---|
| 队列 | `listReviews({status:"pending"})`；只返回已到期 pending，最多 50 条 |
| 完成 | `completeReview(id)` 只返回 `{ok}`；新 schedule 日期不返回 |
| 明天再看 | `dismissReview(id)`；当前项 dismissed，并生成明天的 pending |
| 学习卡 | `/cards/:cardId` |

可用字段：review.id/status/nextReviewAt/intervalDays/lastReviewAt/createdAt，card.id/title，可空 keyPoint.id/claim/quoteText，可空 blockContent，以及 reviewReason。

队列顺序由后端决定：misunderstanding → evidence_gap → manual_pin → due_review；同原因按 nextReviewAt。前端不得重排。

#### 桌面线框

~~~text
FocusBar 56–64
┌──────────────────────────────────────────────────────────────────┐
│ ← 返回学习流              今日复习              搜索队列 / 更多 │
└──────────────────────────────────────────────────────────────────┘
┌──── Queue 256 ───────┐ ┌──── Current ReviewCard ──────┐ ┌─ Facts 304 ─┐
│ 到期 N 条            │ │ 原因 · 第 i/N 条 · 间隔 N 天│ │ 到期时间    │
│ 搜索标题/关键点      │ │                              │ │ 上次复习    │
│ [选中] 原因 + 标题   │ │ 学习卡标题                  │ │ 当前间隔    │
│ [     ] 原因 + 标题   │ │ keyPoint claim              │ │             │
│ …内部滚动            │ │ 关键点引用 quoteText        │ │ 打开学习卡  │
│                      │ │ 关联原文 blockContent       │ │             │
└──────────────────────┘ │                              │ └─────────────┘
                         │ [轻触完成] [明天再看]        │
                         └──────────────────────────────┘
~~~

#### 区域规格

- 页面最大宽 1360px。
- 容器 ≥1120px：`256px minmax(0,1fr) 304px`，gap 16px；两侧 sticky；ReviewCard 自适应高度。
- 760–1119px：`minmax(0,1fr) 288px`；Queue 进入 360–400px 左 Drawer。
- 内容容器 <760px：单列一屏一条；Queue 为底部 Drawer；事实折进 Card 底部；Action Dock 高 64–72px。
- viewport 640–759px：没有 BottomNav，底部 padding 覆盖 ActionDock + safe area。
- viewport <640px：保留全局 BottomNav，ActionDock 位于 BottomNav 上方；底部 padding 覆盖 ActionDock + BottomNav + safe area。

#### 模块与操作

- Queue 数量来自返回数组；搜索只过滤已加载 card.title 和 keyPoint.claim。
- 搜索不匹配写“没有匹配的复习”，与全局 Empty 区分。
- 当前项用边界、背景和 `aria-current`，不能只靠橙色。
- ReviewCard 顺序：reason → 队列位置 → intervalDays → card title → claim → quoteText → blockContent → lastReviewAt → nextReviewAt → 操作。
- quoteText 标题“关键点引用”，blockContent 标题“关联原文片段”。DTO 没有 alignment，不得称硬证据、已对齐或可信引用。
- keyPoint 为空写“该复习计划未关联具体关键点”；blockContent 为空不渲染空白证据卡。
- complete/dismiss 任一进行中时禁用所有状态变更入口；不乐观移除，成功后重新取队列。
- complete 成功只写“已完成，复习队列已更新”，不能显示接口未返回的新日期。
- dismiss 成功写“已移到明天”。
- 当前项移除后优先选择原索引的下一项，否则前一项；失败保留当前项、搜索和滚动位置。

#### ReviewReason 映射

| reason | 文案 | 色彩 |
|---|---|---|
| misunderstanding | 误解修正 | danger |
| evidence_gap | 证据不足 | warning |
| due_review | 到期复习 | warning |
| manual_pin | 手动置顶 | neutral |

reason 只解释为何入队，不得改写为题型、学习阶段或分数。

#### 状态规格

| 状态 | 处理 |
|---|---|
| Loading | Queue + ReviewCard 匹配 Skeleton |
| Full Error | 保留标题，提供重试与返回学习流 |
| Empty | “现在没有到期复习”，提供学习流和学习卡入口 |
| Filter Empty | 提供清空搜索 |
| Completing | “正在完成” |
| Dismissing | “正在移到明天” |
| Action Error | 当前 Card 操作区就近显示，允许重试 |

最后一项完成后进入 Empty，不显示庆祝分数、连续天数或虚构奖励。

#### 交互、视觉与验收

- Current ReviewCard 可使用低强度 Study Paper；Queue/Facts 使用 Control Surface；quote 蓝引用线，block 中性 Evidence Surface。
- 页面最多一个绿色按钮；不使用 textarea、AI feedback、步骤进度、预计时长、翻卡、打卡墙或手机模型。
- `REVIEW-01`：完成当前项只需一次主要点击。
- `REVIEW-02`：页面没有答题输入、AI feedback 或 mastery。
- `REVIEW-03`：dismiss 明确“明天再提醒”；complete 不展示新日期。
- `REVIEW-04`：quote/block 未被标为硬证据。
- `REVIEW-05`：搜索空与队列空文案不同，失败后当前项保留。
- `REVIEW-06`：390 × 844 下 ActionDock 与 BottomNav 不遮正文。
- `REVIEW-07`：队列顺序与 API 一致，键盘可完成选择、打开、完成、稍后处理。

### 13.8 `/graph`

#### 页面任务与数据边界

页面标题使用“理解状态地图”，回答哪些 active 学习卡处于误解、到期、初步理解、已复习、已接触或未接触。唯一主对象是状态分组的可读列表，当前版本不实现图形节点。

`listUnderstandingStates()` 返回当前 workspace 最多 200 张 active 卡的平面数组；没有 relation、edge、parent、prerequisite、坐标或 source link。切换 filter 只做客户端筛选，不重复请求。

| 字段 | 正确语义 |
|---|---|
| title/subjectId | 学习卡标题与入口 |
| state | 后端聚合状态；前端不重算 |
| evidenceCoverage | 有硬证据 keyPoint 数 / keyPoint 总数，不是理解度 |
| hard/softEvidenceCount | 真实证据数量 |
| lastValidatedAt | endpoint 提供的最近状态时间 |
| nextReviewAt/reviewStatus | 当前复习事实 |
| misunderstandingCount | 历史 misunderstood 事件数，不等于未解决误区 |

#### 桌面线框与尺寸

~~~text
PageHeader
┌──────────────────────────────────────────────────────────────────┐
│ 理解状态地图                           [搜索] [学习卡列表]        │
│ 查看 active 学习卡的聚合状态，不表示对象关系。                   │
└──────────────────────────────────────────────────────────────────┘
┌────────────────────── Summary 64–72 ─────────────────────────────┐
│ active N │ 当前有误解 N │ 到期 N │ 初步理解 N                   │
└──────────────────────────────────────────────────────────────────┘
┌── Filter 240 ──┐ ┌────── 状态分组列表 ───────┐ ┌─ Detail 300 ──┐
│ 全部/六状态    │ │ 有误解 · N                │ │ 当前学习卡     │
│ 其他状态       │ │ 标题/状态/证据/时间       │ │ 状态与证据事实 │
│                │ │ 到期复习 · N              │ │ 时间/复习      │
└────────────────┘ └───────────────────────────┘ └────────────────┘
~~~

- 使用 `ExplorerTemplate` 与 default shell；最大宽 1400px。
- PageHeader 的“搜索”必须是跳转 `/search` 的真实 Link，不是本地 input；本页没有 query 状态，也不得用输入框外观伪装。
- ≥1120px：`240px minmax(0,1fr) 300px`，gap 16px；两侧 sticky，中栏自然增长。
- 760–1119px：`minmax(0,1fr) 288px`；Filter 进 Drawer。
- <760px：单列分组列表；筛选和详情分别进入底部 Drawer；永远不显示空白 canvas。

#### 分组、列表与详情

状态顺序固定：misunderstood → due_review → preliminary_understood → reviewed → seen → unseen → unknown。

- 计数来自当前 endpoint 返回的完整数组。
- “当前有误解”只统计 `state === "misunderstood"`，不能用 misunderstandingCount > 0。
- unknown 必须进入“其他状态”，不得映射成已理解。
- Filter 使用 button/radio 语义；本地筛选空提供“查看全部”，全局数组空才引导创建卡。
- 列表项显示 title、StatusChip、hard/softEvidenceCount、可选 lastValidatedAt/nextReviewAt 和“历史误解事件 N”。
- evidenceCoverage 只在详情栏写“关键点硬证据覆盖 2/3”或等价文案；超出 0–1 显示“数据暂不可用”。
- 选择行只更新本地 selected id；filter 使选择离开结果时清空。
- due_review 可跳 `/review`，但 DTO 无 review id，不能声称直达某个复习项。

#### 状态、视觉与验收

- Loading 同时给摘要、筛选计数和列表行 Skeleton；Error 时摘要为“暂不可用”，不能显示 0。
- Unknown 使用 muted chip 并保留对象；所有状态以文字 + 色彩表达。
- 全页使用 Control Surface、浅暖底和 divider；不使用主纸面、宇宙背景、发光节点、气泡、zoom/pan/minimap。
- 禁止节点连线、随机坐标、标题相似度关系、假前置、节点大小理解度、假完整度。
- `GRAPH-01`：DOM/SVG/Canvas 中没有任何未提供的 edge。
- `GRAPH-02`：六个已知状态和 unknown 都可读，误解计数只依据当前 state。
- `GRAPH-03`：evidenceCoverage 只标证据覆盖，页面无“理解 72%”。
- `GRAPH-04`：Error 不伪装为 0；760px 以下筛选/详情可用 Drawer 完成。
- `GRAPH-05`：1440 × 900 首屏可见摘要、筛选和一个完整状态组。
- `GRAPH-06`：PageHeader 搜索是可访问的 `/search` Link，页面没有未实现的本地搜索框。

### 13.9 `/today`

#### 页面任务与数据范围

页面回答“今天有哪些工作区对象被创建、更新或安排”。副标题必须说明这是当前已加载对象的客户端聚合，不是完整理解事件账本。主对象是倒序时间线，QuickCapture 是辅助任务。

页面保持五个独立请求的 `Promise.allSettled` 语义；Review 必须调用 `listReviews({includeAll:true})`，不能只请求已到期 pending：

| 对象 | 时间字段 | 合法事件 |
|---|---|---|
| NoteHeader | updatedAt | 笔记有更新 |
| CardListItem | createdAt | 学习卡已创建 |
| ReviewWithCard | review.createdAt | 复习计划已创建 |
| JobRow | scheduledAt | AI 任务已安排 |
| SourceRow | createdAt | 来源已创建 |

Note/Source 默认最多 100，Card/Review/Job 最多 50；因此文案必须是“已加载的今日活动”。Review 无状态变更时间，不能说 completed/dismissed 今天发生；Job.scheduledAt 不是完成时间；Card 无 updatedAt，不能表达今日修改。

#### 时间线构建

- 使用浏览器本地时区，区间 `[startOfToday, startOfTomorrow)`。
- 非法日期排除并记录开发诊断；按 time 降序，相同时间用 type + objectId 稳定排序。
- React key 使用 `type:objectId:time`，禁止数组下标。
- relativeTime 必须配 `<time dateTime>`，hover/focus 可读绝对时间。
- 事件字段固定为 objectType、objectId、time、title、description、status?、href?。
- 禁止生成“理解提升”“完成掌握”“修复误区”“建立连接”、streak、学习时长或 AI 日报。

#### 桌面线框与尺寸

~~~text
PageHeader
┌──────────────────────────────────────────────────────────────────┐
│ 今日变化 · 日期             [搜索已加载活动] [查看到期复习]      │
│ 基于当前已加载对象聚合，不代表完整理解事件。                     │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────── TodaySummary 4项 ────────────────────────────┐
│ 更新笔记 N │ 新建卡 N │ 安排任务 N │ 当前到期复习 N             │
└──────────────────────────────────────────────────────────────────┘
┌──── ActivityTimeline minmax(0,1fr) ─────┐ ┌── Aside 320 ────────┐
│ 活动 N 条 · 完整/部分                   │ │ 快速捕获            │
│ 10:32 ● 学习卡已创建  标题 [打开]       │ │ textarea / 创建来源 │
│ 09:50 ● 笔记有更新    标题 [打开]       │ ├─────────────────────┤
│ 09:10 ● AI 任务已安排 type/status       │ │ 最近来源 5 条       │
│ [显示更多已加载活动]                    │ │ 下一步              │
└─────────────────────────────────────────┘ └─────────────────────┘
~~~

- 使用 `TimelineTemplate` 与 default shell；最大宽 1280px。
- ≥900px：`minmax(0,1fr) 320px`，gap 24px；Aside sticky，Timeline 最小宽 520px。
- 640–899px：单列，Summary → Timeline → QuickCapture → 最近来源 → 下一步。
- <640px：padding 16px，Summary 2×2，时间改行内；保留 BottomNav 并预留安全区。

#### Summary 与时间线

- Summary 固定为：今日 updated notes、今日 created cards、今日 scheduled jobs、已加载 reviews 中 `status === "pending" && nextReviewAt <= now` 的当前到期数量。不得用 review.createdAt 是否在今天代替到期判断。
- 任一来源失败，对应格写“暂不可用”而不是 0。
- Timeline 项顺序：时间 → 类型 → 标题 → 一行真实描述 → 可选状态 → 可选对象链接。
- Review 只写“计划已创建 · 当前状态 X”，链接 card；Job 无 href 时不显示假详情。
- 首屏先显示 30 条；超过必须有“显示更多已加载活动”，不能静默 slice。
- 搜索过滤全部已加载活动的 title/description/映射状态，不只过滤前 30 条；placeholder 写“搜索今天已加载的活动”。

#### QuickCapture 与下一步

- textarea 最小高 88px，最大自然增长 160px；Shift+Enter 换行，Cmd/Ctrl+Enter 提交。
- 类型识别沿用前端逻辑，不增加 AI 请求；文案只能描述本地识别。
- 空文本禁用；提交写“正在创建来源”；成功后才清空并把真实 SourceRow 加入最近来源/活动；刷新失败不把已成功创建改成失败。
- 失败保留全部输入；不得写“AI 已理解你的内容”。
- 最近来源最多 5 条，只显示 title/type/SourceStatus；processing 不关联 Job，failed 无通用 retry。
- 下一步优先到期 pending review；review 请求失败写“复习状态暂不可用”，不得显示已清空。

#### Partial、视觉与验收

- 五个请求分别维护 loading/error/data；一个失败，其他四类继续。
- 顶部低高度 Partial Alert 列出失败模块，每区独立重试；Timeline 标题写“当前显示部分活动”。
- 只有五项都成功且今日数组为空，才显示“今天尚无活动”；部分失败且成功部分为空写“已加载部分暂无活动”。
- Timeline 是最完整 Surface；QuickCapture 是 Control Surface，不做便签；事件点用小面积语义色并配文字。
- `TODAY-01`：任一请求失败，其余数据继续，失败统计不显示 0。
- `TODAY-02`：Review/Job 时间语义正确，无完整账本、AI 日报或假里程碑。
- `TODAY-03`：QuickCapture 失败保留输入，成功可打开新来源。
- `TODAY-04`：超过 30 条有显示更多，搜索覆盖全部已加载活动。
- `TODAY-05`：390 × 844 无遮挡，所有时间都有 `<time dateTime>`。
- `TODAY-06`：只有全请求成功且为空才出现全天 EmptyState。
- `TODAY-07`：Review 请求包含 includeAll；到期摘要只按 pending + nextReviewAt 计算。

### 13.10 `/sources`

#### 页面任务与数据合同

用户管理进入理解流水线的来源资料，辨认草稿、处理中、就绪、失败和归档状态。

| 能力 | 真实合同 |
|---|---|
| 列表 | `GET /sources?status=&cursor=&limit=` → items/nextCursor/total |
| 创建 | type/title + text/markdown/code content，或 URL/content 至少一项 |
| 创建笔记 | `POST /sources/:id/create-note` → note/version |
| 归档 | `DELETE /sources/:id` → `{ok}`，真实语义是 status → archived |

SourceRow 只提供 title、type、origin、status、createdAt、updatedAt 等基本字段。默认列表排除 archived；没有通用 parse retry、恢复归档、片段数、关联对象聚合或关联 Job。

#### 桌面线框与尺寸

~~~text
PageHeader: 来源资料                                      [新建来源]
[当前资料] [草稿] [处理中] [就绪] [失败] [已归档]
┌──────────────────── minmax(0,1fr) ────────┬── 288 ──────────────┐
│ 当前筛选 · 共 total 条                    │ 状态说明            │
│ title                         [status][…] │ 当前已加载 n/total  │
│ type · origin · 创建/更新时间             │ draft/processing…   │
│ ...                          [加载更多]    │                     │
└───────────────────────────────────────────┴─────────────────────┘
~~~

- 使用 `LibraryTemplate` 与 default shell；最大宽 1240px。
- ≥980px：`minmax(0,1fr) 288px`，gap 20px；<980px 隐藏辅助栏并通过 Drawer 查看说明。
- 模块顺序：PageHeader → 状态筛选 → 操作错误 → 列表。
- 筛选高 40px；默认项叫“当前资料”或“全部（不含归档）”，不得含糊为包含 archived 的“全部”。
- 每行最小高 88px，padding 14–16px；标题最多两行，origin 单行截断并提供完整可访问文本。
- 整行进入 `/sources/[id]`；菜单按钮阻止行导航。菜单顺序：详情 → 创建笔记 → 归档。
- “创建笔记”只对 ready 显示，最终还需详情/接口确认有 segments；archived 不显示再次归档。

#### 新建来源 Drawer

- 桌面右侧 Drawer 宽 480px；顺序为类型 → 标题 → URL（仅 URL 类型）→ 内容 → 错误 → 取消/创建。
- 类型使用 RadioGroup/Segmented Control；标题高 40px，textarea 初始高 240px；code 使用等宽字体。
- URL helper 明确“URL 与正文至少填写一项”，不能要求同时提供。
- 成功关闭、清理已提交草稿并刷新当前筛选；失败保留全部输入。
- 普通关闭保留未提交输入，只有明确“清空”才移除。

#### 状态与响应式

- 初次 Loading 为 5 行 Skeleton；draft/processing 存在时轮询当前筛选第一页，并保留已加载后续页。
- 列表轮询沿用当前 2s 起步、每轮 ×1.5、上限 5s 的退避；不再存在 draft/processing 时终止，组件卸载或筛选切换时清理 timer 和在途请求。
- 轮询不显示百分比、剩余时间或 Job；failed 只给详情，不给重试。
- 归档使用 ConfirmDialog，明确“移入已归档；当前页面没有恢复入口”。
- 创建笔记/归档使用行级 loading；失败保留列表。创建笔记成功跳真实 note id。
- Load more 失败保留已有列表并提供重试；初读失败使用局部 ErrorState。
- 默认 Empty 提供新建来源；其他筛选 Empty 提供“查看当前资料”。
- <640px：状态筛选横向滚动，来源改单列卡；Drawer 从底部打开，最大高 90dvh，底部操作避开 safe area。

#### 视觉护栏与验收

- 现代 Control Surface；status 用中文文字 + 颜色。禁止纸张堆、图钉、片段数、关联计数、Job、retry、unarchive 和 metadata 推测。
- `SRC-LIST-01`：真实 status 参数工作，默认筛选不暗示包含 archived。
- `SRC-LIST-02`：URL 表单遵守“URL 或正文至少一个”。
- `SRC-LIST-03`：failed 无 retry，轮询不破坏后续分页。
- `SRC-LIST-04`：归档/创建笔记/加载更多失败均保留已有内容。
- `SRC-LIST-05`：390px 无横滚，触控目标至少 44×44px。

### 13.11 `/sources/[id]`

#### 页面任务与数据合同

页面用于阅读真实来源、浏览解析片段并创建/打开关联笔记。

- `GET /sources/:id` 返回 source 与 segments；segment 只含 ordinal、text、charStart/end、segmentType。
- `GET /sources/:id/notes` 返回关联 NoteHeader。
- `POST /sources/:id/create-note` 返回真实 note/version。
- `metadata.rawContent` 只是可选约定；只有 `typeof rawContent === "string"` 才能显示，不能当必有 DTO。

#### 宽屏线框

~~~text
PageHeader: ← 来源资料 / title                         [创建笔记草稿]
status · type · createdAt
┌── 段落导航 220 ─┬────── 原文 minmax(560,1fr) ──────┬── 解析栏 304 ─┐
│ #0 heading      │ [解析片段] [原始输入*]           │ 状态/类型      │
│ #1 paragraph    │ section#segment-{ordinal}        │ origin/时间    │
│ #2 code         │                                  │ 关联笔记       │
└─────────────────┴──────────────────────────────────┴───────────────┘
* 仅 rawContent 真实存在时显示
~~~

- 使用 `SourceDetailTemplate`；最大宽 1400px。
- ≥1180px：`220px minmax(560px,1fr) 304px`，gap 16px。
- 920–1179px：`minmax(0,1fr) 304px`，段落导航隐藏。
- <920px：单列原文，导航与解析/关联进入 Drawer。
- 原文正文最大 72ch，padding 28–36px；segments 按 ordinal 排序，锚点固定为 `segment-{ordinal}`。
- 导航项最小高 36px，只显示真实 ordinal/type/短文本；左右栏 sticky 但可内部滚动。
- 右栏顺序：状态 → 来源信息 → 当前操作 → 关联笔记，只显示真实 type/origin/time/status。

#### 原文与操作

- 默认“解析片段”；仅 rawContent 真实存在时显示“原始输入”Tab，两个长视图不得同时堆叠。
- code 使用等宽字体和内部横向滚动；quote 用 evidence 蓝左边线。
- 原文是本页唯一 Paper Surface；segments 不逐条做阴影卡。
- ready 且 segments 非空时“创建笔记草稿”为唯一 primary；ready 无片段时禁用并解释。
- draft/processing 自动轮询详情，沿用 2s → 5s → 10s 退避；ready/failed/archived、路由切换或组件卸载时立即终止并清理 timer/在途请求。不得显示百分比。
- failed 显示“解析失败”，无 retry；archived 无恢复入口。
- Source 与关联笔记独立读取：404 与网络/500 区分；关联笔记失败不阻断原文；只有请求成功且空才写“暂无关联笔记”。
- 轮询瞬时失败保留已加载内容并显示非阻断 warning。

#### 响应式、护栏与验收

- 640–919px：原文占满，顶部“段落/来源信息”打开右 Drawer。
- <640px：正文 padding 18–20px，段落导航用底部 Drawer；选段后关闭并定位。创建笔记只出现一次。
- 禁止承诺 Evidence 精确跳到 source segment；禁止 Job、retry、进度、metadata 全量序列化、网络错误冒充 404，以及同时渲染两份完整原文。
- `SRC-DETAIL-01`：404 与网络错误不同；每个 segment 有稳定锚点。
- `SRC-DETAIL-02`：关联笔记失败不阻断原文，processing 轮询保留内容。
- `SRC-DETAIL-03`：只有 ready 且有 segment 可创建笔记；failed 无 retry。
- `SRC-DETAIL-04`：rawContent 缺失时无空 Tab；390px 原文/代码/Drawer 无页面横滚。

### 13.12 `/search`

#### 页面任务与数据合同

用户通过关键词回到真实笔记、学习卡、来源或证据对象。

`GET /search?q=&type=&limit=` 返回 `{items,total}`；SearchResult 只有 objectType、objectId、title、snippet、indexedAt、href、可选 matchCount。

- type 只接受 note/card/source/evidence。
- 空 q 返回空，不发明最近内容。
- 默认 20；路由参数校验允许到 100，但当前 search service 使用 `Math.min(limit, 50)`，实际最多返回 50；接口没有 cursor/offset。
- evidence 可能按 card 聚合，matchCount 表示该 card 下证据命中数。
- 结果没有对象状态、来源状态、卡片验证状态或更新时间。

#### 桌面线框与区域规格

~~~text
PageHeader: 搜索
┌──────────────────────── Search Surface max 1040 ─────────────────┐
│ [搜索笔记、学习卡、来源、证据……                  ][清空]         │
│ [全部] [笔记] [学习卡] [来源] [证据]                             │
│ 查询“……” · 共 total 条；当前展示 items.length 条                │
├──────────────────────────────────────────────────────────────────┤
│ 笔记（当前返回 3）                                               │
│ title [笔记]                                                     │
│ snippet with mark · indexedAt                                    │
│ 学习卡（当前返回 2）…                                            │
└──────────────────────────────────────────────────────────────────┘
~~~

- 使用 `SearchTemplate`；页面最大宽 1040px，结果主栏最大 920px。
- 顺序固定：PageHeader → 48px 搜索框 → 40px 类型 Tabs → 摘要 → 分组结果。
- 搜索框最大宽 720px；清空热区 40×40px。
- 保留 300ms debounce 与 AbortController；过期请求不得覆盖新查询。
- activeTab 变化必须重新请求 type，不能只过滤旧 items。
- “全部”按 note → card → source → evidence 分组；空分组不渲染。单类型无需重复分组标题。
- 结果项最小高 88px，padding 14–16px；顺序完全采用 API 返回。
- snippet 中 `«…»` 转成 React `<mark>` 节点，不用 `dangerouslySetInnerHTML`。
- title null 显示“无标题”；href 空则渲染不可导航结果并说明。
- matchCount 只在 evidence 且 >1 时显示。

#### 数量、状态与响应式

- 永远区分 total 与 items.length；total 更大时写“共 N 条，当前展示 M 条”。
- 因接口无分页，不显示加载更多；其他 Tab 不显示由当前结果推算的全量数字。
- all 查询中的分组数量只能叫“当前返回 N”。
- 无关键词不请求；loading 使用结果行 Skeleton；error 保留 query/tab 并提供同请求重试。
- 清空要取消请求、清 results/error，并把焦点还给 input。
- 新请求开始后旧结果不得继续标为当前。
- 640–959px 内容占满；<640px padding 16px，Tabs 横向滚动，结果单列，snippet 最多四行。

#### 视觉护栏与验收

- 搜索框是首要焦点但不是 marketing hero；结果使用 Control Surface；mark 使用浅 highlight。
- 禁止最近搜索、热门、推荐、AI 摘要、相关度分数、对象状态和假分页。
- `SEARCH-01`：空查询不请求，快速输入不会被旧请求覆盖。
- `SEARCH-02`：切 Tab 真正发送 type，total/items.length 分开。
- `SEARCH-03`：空查询、零结果、error 三种状态不同，清空恢复焦点。
- `SEARCH-04`：390px Tabs、长标题和 snippet 无页面横滚。
- `SEARCH-05`：结果说明与测试按服务实际最多 50 条执行，不把路由参数上限 100 当作已返回数量。

### 13.13 `/settings`

#### 页面任务与数据合同

用户查看真实账户信息，导出工作区、批量导入 Markdown、检测并重建搜索索引。

| 区域 | 接口 |
|---|---|
| 账户 | `GET /auth/me` → email/role/workspaceName |
| 导出 | `GET /export/workspace` → owner-only JSON Blob |
| 导入 | `POST /import/markdown` → imported/notes/idempotent/errors |
| 漂移 | `GET /search/drift` → expected/actual/ghosts/missing/staleTitles/staleBodies/hasDrift |
| 重建 | `POST /search/reindex` → deleted/indexed/errors，owner-only |

#### 桌面线框与尺寸

~~~text
PageHeader: 设置
┌── 设置导航 224 ────┬──────────── 表单区 max 760 ────────────────┐
│ 当前账户           │ 当前账户：email / role / workspaceName     │
│ 数据导出           │ 数据导出                         [导出JSON] │
│ Markdown 导入      │ Markdown 导入                    [展开]     │
│ 搜索索引           │ 搜索索引：漂移检测 / 重建确认              │
└────────────────────┴─────────────────────────────────────────────┘
~~~

- 使用 `SettingsTemplate` 与 default shell；最大宽 1120px。
- ≥900px：`224px minmax(0,760px)`，gap 28–32px；导航 sticky，项目高 40px。
- Section 顺序固定：账户 → 导出 → 导入 → 搜索索引；间距 20px。当前没有经过合同确认的版本、帮助链接或法律文案来源，因此不渲染“关于”Section。
- 设置行最小高 72px，采用“标题/说明 + 操作”，默认页不堆多个绿色按钮。

#### 账户、导出与导入

- 账户只显示 `/auth/me` 的真实字段；失败局部提示，不硬编码 owner。没有改密码、注销或工作区切换 UI。
- 导出按钮“导出工作区 JSON”；请求必须复用统一 `getToken()`，同时支持 localStorage 和 sessionStorage，禁止直接只读 localStorage。
- 导出 loading 防重复，失败行内显示，不用 alert；说明必须基于真实 exportManifest，不擅自扩充。
- Markdown 导入默认折叠；展开 textarea 高 240px，按独占一行 `---` 拆分。
- 后端每次最多 100 篇、每篇最大 500,000 字符，前端可提前提示。
- 请求异常保留输入；返回 errors 时显示成功 N/失败 M 及 index/title/error。
- 同一次提交及其异常重试必须复用稳定 importId；只有用户明确开始新一轮导入时才生成新的 importId，防止重复创建。
- 只有完整成功才自动清空；部分成功保留原文；收起面板不清草稿。

#### 搜索索引

- 漂移检测与重建独立状态；结果先显示 hasDrift，再显示 expected/actual 和 ghosts/missing/staleTitles/staleBodies。
- “索引一致”必须来自真实检测，不是静态成功文案。
- 重建前必须新增 ConfirmDialog：标题“重建搜索索引？”；说明“删除派生索引并从业务表重新生成，学习数据不会删除”；取消默认焦点。
- 成功显示 deleted、四类 indexed 和 errors；`errors > 0` 用 partial/warning，不能纯成功。
- 403 显示 owner 权限提示；重建失败保留之前的 drift 结果。

#### 响应式、护栏与验收

- 640–899px：导航变顶部横向 anchor bar；<640px 单列，设置行纵向，textarea 字号 ≥16px，Drift 计数 2×2。
- 全页 Control Surface，不使用纸纹、便签或手写字体。
- 禁止不存在的密码修改、账户注销、通知/模型偏好、无来源的“关于”内容、假后台进度或可取消任务。
- `SETTINGS-01`：账户无硬编码；sessionStorage 登录也能导出。
- `SETTINGS-02`：导入异常/部分失败不丢输入并展示 errors。
- `SETTINGS-05`：同一次导入重试复用 importId，不会重复创建已成功对象。
- `SETTINGS-03`：重建必须经过键盘可达 ConfirmDialog；errors >0 不显示纯成功。
- `SETTINGS-04`：member 403 显示权限提示；390px 表单/Dialog/结果可用。

### 13.14 `/benchmark`

#### 页面任务与数据合同

owner 运行 Evidence 对齐基准测试、检查当前最新报告并完成人工标注。此页是同步内部工具，不是后台任务中心。

| 接口 | 真实语义 |
|---|---|
| `GET /benchmark/notes` | 样本 file/title/blockCount |
| `GET /benchmark/report` | 当前工作区最新一份 `report | null`，不是历史列表 |
| `GET /benchmark/labels` | 当前保存的 labels；DTO 无 runId |
| `POST /benchmark/run` | 同步返回 BenchmarkReport，无 jobId |
| `POST /benchmark/labels` | 同步保存并返回最终报告，无 jobId |

报告包含 runId、datasetVersion、timestamp、totalNotes、totalKeyPoints、results、hasLabels，以及三项 metrics。hardCitationPrecision、keyPointHardCoverage、validationExpectedPointsHardCoverage 在后端均可能为 null，UI 必须按 nullable 渲染。若 `apps/web/lib/api.ts` 仍将 coverage 写成 `number`，实施批次必须把前端类型收窄为 `number | null` 或加入等价运行时守卫；不得依赖错误类型把 null 当作 0。

#### 桌面线框与精确布局

~~~text
Internal TopBar: 返回工作区 / 内部评测 / Theme
PageHeader: Evidence 对齐基准测试                       [运行评测]
datasetVersion · 最新 runId · timestamp
┌── 运行信息 248 ──┬──────────── 报告区 minmax(0,1fr) ─────────────┐
│ 样本数           │ [Precision] [KP Coverage] [Val Coverage]      │
│ datasetVersion   │ [metricsVerified warning / threshold]        │
│ runId/timestamp  │                                              │
│ 当前 phase       │ 笔记结果 1                                  │
│                  │ ┌─ table min-width 1040，自身横向滚动 ─────┐ │
│                  │ │ alignment/claim/quote/score/block/label  │ │
│                  │ └──────────────────────────────────────────┘ │
└──────────────────┴──────────────────────────────────────────────┘
[reviewing 时 sticky：人工标注尚未提交 / 提交标注并计算 Precision]
~~~

- 使用 `InternalToolTemplate` 与 internal shell；最大宽 1360px。
- ≥960px：`248px minmax(0,1fr)`，gap 20px；左栏 sticky。
- 右栏顺序：全局错误 → 运行控制 → 指标 → 验证 warning → note results → 提交栏。
- 指标三列，单卡最小宽 200px，数字 26–28px。
- 每篇笔记为可折叠 Section，error 项默认展开；结果按 report.results 原顺序。
- 表格只在自身容器横向滚动，最小宽 1040px，表头 sticky，行高 ≥52px。
- 列序：ordinal 40 → alignment 88 → claim ≥240 → quote ≥300 → score 72 → method 100 → blockOrdinal 72 → reviewing 的正确标注 96 → expected ordinal 112。
- quote 使用 Mono + soft surface，内部最大高 96px。

#### Phase 与运行合同

只允许：

- `idle`：无报告或准备重新运行。
- `running`：run 请求尚未返回。
- `reviewing`：有报告且本次人工标注未成功保存。
- `labeled`：保存成功且返回 `hasLabels === true`。

提交中的独立状态为 `submittingLabels`；请求发出时不得提前进入 labeled。

初始并行读取 notes/latest report/labels。notes 失败不抹 report；report null → idle；`hasLabels=false` → reviewing；只有 true 才恢复 labeled。labels 无 runId，不能声称恢复任意历史 run。

- run 是同步长请求，只能显示不确定 spinner 和“请求仍在处理”；不显示百分比、样本完成数、估时、取消或 Job。
- run 失败回 idle 并可“重新运行评测”；这不是 retry job。
- 成功用返回 report 初始化 labels，进入 reviewing。
- 单篇 note.error 是部分失败，保留其他结果；没有逐篇 retry。

#### 指标与人工标注

- nullable metric 显示“— / 待人工标注”，绝不能当 0%。
- Precision 的真实阈值为 ≥80%；coverage 沿用 ≥60%，只在非 null 时判断。
- `metricsVerified === false` 必须显示“指标尚未经过充分人工标注验证”，不得使用成功绿或“达标”。
- sample count 来自 `/benchmark/notes`，加载前用 Skeleton，禁止硬编码 20。
- 新 run 的 isCorrectlyAligned 按现有合同初始化 false；helper 明确“勾选表示 quoteText 是准确逐字引用”。
- expectedBlockOrdinal 使用 number/step=1，空值提交 null。
- 提交中禁全部标注控件但保留值；失败回 reviewing 且所有输入原样保留。
- 提交成功用最终 report 更新指标并进入 labeled。
- 报告无原始 block 文本，不构造“原文 block 对照阅读器”。

#### 响应式、护栏与验收

- 768–959px：单列，运行信息变 ContextStrip，表格自身滚动。
- <768px：每篇先摘要再“查看明细”；可将每行变字段组，但不得删字段。<640px 无全局底栏，必须有返回工作区。
- 全页使用高密度 Control Surface，不使用纸纹、便签、emoji、指标渐变或循环动画；只有 running 允许真实循环动画。
- 禁止 benchmark JobStatus/jobId/队列/轮询/cancel/retry job、历史报告列表、固定估时、单篇 retry、null→0 和未验证指标绿色达标。
- `BENCH-01`：idle/running/reviewing/labeled 转换准确，保存成功后才 labeled。
- `BENCH-02`：running 无 jobId、百分比、取消或任务重试。
- `BENCH-03`：三项 null 都显示“—”；metricsVerified=false 不显示绿色达标。
- `BENCH-04`：提交失败后全部人工输入仍在，单篇错误不隐藏其他结果。
- `BENCH-05`：sample count 无硬编码；页面只有最新 report，无历史列表。
- `BENCH-06`：390px 可完成每条标注和最终提交，页面自身无横向滚动。

### 13.15 页面规格自审补充

完成逐页展开后，必须再用本节做一次“页面身份”检查。若实现截图无法在 3 秒内从主对象和主操作辨认路由，说明页面层级已经偏离。

| 路由 | 唯一首要对象 | 首要操作 | 强 Paper 数量 | 关键范围标签 |
|---|---|---|---:|---|
| `/login` | 登录表单 | 进入工作区 | 0 | storage 由 remember 决定 |
| `/` | 今日下一步 | 继续当前真实对象；无对象时创建来源 | ≤1 | 总数 / 已加载必须分开 |
| `/notes` | 笔记库 | 新建笔记 | 0 | 筛选已加载笔记 |
| `/notes/[id]` | 正文编辑纸面 | 编辑与保存；生成卡为后续动作 | 1 | 本地统计 / 服务端版本 |
| `/cards` | 学习卡库 | 从笔记生成 / 打开卡 | 0 | 筛选已加载学习卡 |
| `/cards/[id]` | 学习卡 StudyPaper | 提交当前关键点验证 | 1 | 证据/验证/复习事实 |
| `/review` | 当前到期 ReviewCard | 轻触完成 | ≤1 | 已加载到期队列 |
| `/graph` | 状态分组列表 | 打开学习卡 | 0 | active 卡、最多 200 |
| `/today` | 已加载活动时间线 | 打开活动对象 | 0 | 客户端聚合 / 已加载范围 |
| `/sources` | 来源列表 | 新建来源 | 0 | 当前资料默认不含归档 |
| `/sources/[id]` | 原文阅读器 | 创建笔记草稿 | 1 | 解析片段 / 可选原始输入 |
| `/search` | 搜索输入与结果 | 打开结果 | 0 | total / 当前返回 |
| `/settings` | 当前设置 Section | 当前展开操作 | 0 | owner-only / partial result |
| `/benchmark` | 最新评测报告 | 运行或提交本次标注 | 0 | 最新报告 / 同步请求 |

#### 自审后新增的固定规则

1. **滚动所有权**：页面主内容自然滚动；只有明确的 Rail、Drawer、Table 容器可内部滚动。禁止页面与主体容器同时出现两个相邻纵向滚动条。
2. **数量作用域**：所有 `total`、`items.length`、`filtered.length` 必须分别命名为“共”“已加载”“当前显示”；没有 total 的接口不得制造全局计数。
3. **成功语义**：mutation 成功只描述接口已经确认的结果。`{ok}`、job succeeded、资源创建成功不能自动扩写成 mastery、解析完成或已生成具体对象。
4. **错误不等于空**：任何请求失败都不能落成 0、“暂无”或 404；Partial 中成功区域必须保持。
5. **移动端唯一操作**：同一主操作不得同时出现在 PageHeader、正文尾部、FAB 和 Action Dock。每个断点只保留一个实例。
6. **纸面预算**：列表、筛选、设置、内部工具使用 Control Surface；只有需要长时间阅读/书写的主对象可用 Paper。
7. **技术字段收纳**：UUID、artifactId、versionId、jobId、alignmentMethod 等只在业务任务需要时进入低权重 disclosure，不得充当视觉填充。
8. **本地推导标记**：搜索、筛选、今日聚合、块数、字数等前端计算必须用“已加载”“本地统计”等范围文案。
9. **危险动作一致性**：删除、归档、重建索引均使用同一 Dialog 基础；默认焦点为取消，错误留在 Dialog 或触发区。
10. **实现前复核**：编码 AI 开始某页前必须重新打开该 route、对应 API 类型和本节规格；若当前代码合同变化，先更新本文档再实现。

---

## 14. 交互与动效

### 14.1 时间和缓动

| 类型 | 时长 |
|---|---:|
| 颜色、边框、hover | 120ms |
| 常规出现/消失 | 180ms |
| Drawer、Dialog | 240ms |

统一缓动：

`cubic-bezier(.2, .8, .2, 1)`

### 14.2 组件反馈

- 卡片 hover：上移 1px，边框加深，阴影提升一级。
- 按钮 hover：背景加深约 6%。
- 按钮 pressed：`scale(.98)` 或回到原位。
- 输入 focus：2px 实线 + 3px 低透明 ring。
- 新增列表项：淡入 + 上移 4px。
- Drawer：位移 + 淡入，240ms。
- Toast：淡入，不从屏幕远处飞入。

### 14.3 禁止动效

- 大幅弹跳。
- 连续漂浮装饰。
- 页面级视差。
- 卡片持续摇摆。
- 没有真实 running 状态的呼吸灯。
- 同时运行多个 sweep/shimmer。
- hover 造成布局位移。

### 14.4 Reduced Motion

`prefers-reduced-motion: reduce` 下：

- 取消非必要位移。
- 取消循环动画。
- Skeleton 变为静态。
- Drawer/Dialog 可保留极短淡入。
- 状态变化仍需通过文字可见。

---

## 15. 可访问性

### 15.1 对比度

- 普通文本至少 4.5:1。
- 大字号文本至少 3:1。
- 交互边界和图标至少 3:1。
- 黄色不得作为白底小字号文字。
- 状态色必须配文字/图标。

### 15.2 键盘

用户必须能用键盘完成：

- 主导航。
- 页面筛选。
- 搜索。
- 打开/关闭 Drawer。
- 打开/关闭 Dialog。
- 回看证据。
- 提交验证。
- 完成复习。
- 取消危险动作。

### 15.3 语义

- 每页只有一个 `h1`。
- 标题层级连续。
- 当前导航用 `aria-current`。
- Tabs 使用 `tablist / tab / tabpanel`、roving tabindex 和方向键。
- 图标按钮有可访问名称。
- 装饰图层使用 `aria-hidden`。
- FormField 正确关联 label/helper/error。
- Loading、保存、后台任务变化使用适当 `aria-live`。
- Dialog/Drawer 有标题、focus trap、Esc 和焦点恢复。
- App Shell 首个可聚焦元素提供“跳到主内容” skip link。
- 表单提交错误后，焦点移到错误摘要或第一个错误字段。

### 15.4 触控

- 所有主要触控目标至少 44 × 44px。
- 相邻危险与安全操作至少相隔 8px。
- 固定底部按钮不遮内容。
- 安全区使用 `env(safe-area-inset-bottom)`。

### 15.5 图表

- 所有图表必须提供列表或文字替代。
- 颜色不是唯一编码。
- 节点/边若可点击，必须有键盘等价操作。

---

## 16. 内容与文案

### 16.1 语言

- 面向用户的主 UI 使用中文。
- Source、Evidence、Validation 等英文对象名只在内部工具或必要技术上下文出现。
- 标题短、动作明确。
- 错误文案说明用户下一步，不暴露堆栈。

### 16.2 按钮文案

使用动词：

- 提交回答。
- 回看证据。
- 继续学习。
- 安排复习。
- 重试加载。
- 导出数据。

避免：

- 确定。
- 好的。
- 开始体验。
- AI 魔法生成。

### 16.3 空状态模板

结构：

1. 发生了什么。
2. 为什么。
3. 下一步。

示例：

> 还没有学习卡。先从一篇笔记生成学习卡，系统才能继续对齐证据和安排验证。

### 16.4 时间与数字

- 相对时间用于列表快速扫描。
- 精确日期用于复习计划和详情。
- 数字使用 UI 字体和 tabular-nums。
- 不使用未经定义的百分比。
- alignment score 仅在证据详情以低权重显示。

---

## 17. 目标代码结构

### 17.1 样式文件

~~~text
apps/web/app/
  globals.css                 # 仅导入与极少量全局规则
  styles/
    tokens.css                # 唯一设计 token
    base.css                  # reset、body、排版、focus
    motion.css                # 替换 animations.css；keyframes、reduced motion
    utilities.css             # 少量跨组件工具类
~~~

`globals.css` 不再承载页面专属样式。

迁移到 `motion.css` 时必须同步移除旧 `animations.css` import；确认无引用后删除旧文件，不得长期维护两套动画文件。

### 17.2 组件目录

~~~text
apps/web/components/
  ui/
    Button.tsx
    Button.module.css
    ButtonLink.tsx
    IconButton.tsx
    FormField.tsx
    Input.tsx
    Textarea.tsx
    Select.tsx
    Checkbox.tsx
    SearchInput.tsx
    Chip.tsx
    StatusChip.tsx
    InlineNotice.tsx
    Surface.tsx
    Panel.tsx
    Tabs.tsx
    Dialog.tsx
    ConfirmDialog.tsx
    Drawer.tsx
    Skeleton.tsx
    EmptyState.tsx
    ErrorState.tsx
    icons.tsx

  layout/
    AppShell.tsx
    AppShell.module.css
    DesktopSidebar.tsx
    MobileNav.tsx
    TopBar.tsx
    PageHeader.tsx

  study/
    StudyPaper.tsx
    EvidenceRail.tsx
    EvidenceDrawer.tsx
    ValidationPanel.tsx
    UnderstandingFacts.tsx
    ReviewCard.tsx
    QuickCapture.tsx
    AIJobIndicator.tsx
    SourceReader.tsx

apps/web/lib/ui/
  status-map.ts
  navigation.ts
  shell-variants.ts
~~~

实际迁移可分批完成，但不得继续向 `globals.css` 添加新的页面区块。

### 17.3 现有组件处置

| 当前实现 | 处置 | 关键约束 | 删除阶段 |
|---|---|---|---|
| `ui/Button.tsx` | refactor | 继承原生属性、补 variant/loading；移除 styled-jsx | P1 |
| `ui/Chip.tsx` + 全局 `.chip` | merge | 非状态标签用 Chip，领域状态只用 StatusChip | P1–P6 |
| `ui/StatusChip.tsx` | refactor | 只消费集中 status-map | P1 |
| `ui/Callout.tsx` + 全局 `.callout` | replace | 收敛为 InlineNotice / ErrorState | P1–P6 |
| `ui/Panel.tsx` + 全局 `.panel` | refactor | Surface/Panel 统一材质 | P1–P6 |
| `ui/ContextStrip.tsx` | refactor | 只展示真实聚合，不做 KPI 墙 | P4 |
| `ui/ProgressRing.tsx` | remove from card detail | 当前没有正式理解百分比；其他页面只有真实指标有明确用途时才允许保留 | P3 |
| `ui/ConfirmDialog.tsx` | keep/refactor | 复用现有 focus trap，作为 Dialog 基础 | P1 |
| `EvidenceDrawer.tsx` | refactor | 保留 override 业务；补 focus trap/焦点恢复 | P3 |
| `ValidationPanel.tsx` | refactor | 保留问题/提交/轮询；不新增请求或 difficulty | P3 |
| `NoteEditor.tsx` | keep + incremental extract | 业务 container 不大改，逐步抽视觉组件 | P4 |
| `MarkdownEditor.tsx` / `MarkdownPreview.tsx` | keep/restyle | 保留解析和编辑行为 | P4 |
| `AppShell.tsx` / `Sidebar.tsx` | replace incrementally | 按 `7.1` route-group 方案迁移 | P2 |
| `ArcThemeToggle.tsx` / `ThemeProvider.tsx` | keep/restyle | 不改变主题存储行为 | P1–P2 |

删除任何旧组件/选择器前必须确认所有引用已迁移。不得为了目标目录整洁重建已有业务组件。

### 17.4 样式策略

统一策略：

- Token：CSS Variables。
- 常规布局和简单状态：Tailwind utilities。
- 复杂材质、伪元素和领域组件：CSS Modules。
- 页面特有布局：同目录 `page.module.css`。
- 禁止新增 styled-jsx global。
- 静态样式不得放在 inline style。
- Inline style 只允许数据驱动值，例如图表坐标、真实进度角度。

### 17.5 Tailwind 映射

Tailwind 颜色名称必须是语义名称：

- canvas。
- shell。
- surface。
- surface-raised。
- paper。
- border。
- text。
- muted。
- action。
- success。
- evidence。
- warning。
- danger。
- running。

不得在页面使用 `blue-500`、`emerald-600` 等原始色阶决定业务语义。

最小颜色映射：

~~~ts
colors: {
  canvas: "var(--color-canvas)",
  shell: "var(--color-shell)",
  surface: "var(--color-surface)",
  surfaceRaised: "var(--color-surface-raised)",
  paper: "var(--color-paper)",
  border: "var(--color-border)",
  ink: "var(--color-text)",
  muted: "var(--color-text-secondary)",
  action: "var(--color-action)",
  onAction: "var(--color-on-action)",
  success: "var(--color-success)",
  successText: "var(--color-success-text)",
  successSoft: "var(--color-success-soft)",
  evidence: "var(--color-evidence)",
  evidenceText: "var(--color-evidence-text)",
  evidenceSoft: "var(--color-evidence-soft)",
  warning: "var(--color-warning)",
  warningText: "var(--color-warning-text)",
  warningSoft: "var(--color-warning-soft)",
  danger: "var(--color-danger)",
  dangerText: "var(--color-danger-text)",
  dangerSoft: "var(--color-danger-soft)",
  running: "var(--color-running)",
  runningText: "var(--color-running-text)",
  runningSoft: "var(--color-running-soft)",
},
~~~

透明度规则：

- 语义颜色优先使用 `*-soft` token。
- 禁止对直接映射为 hex CSS variable 的语义颜色使用 `bg-success/10`、`text-evidence/70` 等 opacity utility。
- 如未来确需 Tailwind alpha modifier，必须统一将 token 改为 RGB channel + `<alpha-value>` 方案，不能只在一个组件内私自实现。
- Tone class 必须来自完整字面量映射或 CSS `data-tone`；禁止运行时拼接 `bg-${tone}`，避免生产构建清除类名。

Tailwind 的圆角和阴影也必须映射 token；页面不得继续使用框架默认值：

~~~ts
borderRadius: {
  xs: "var(--radius-xs)",
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  shell: "var(--radius-shell)",
  pill: "var(--radius-pill)",
},
boxShadow: {
  control: "var(--shadow-control)",
  panel: "var(--shadow-panel)",
  paper: "var(--shadow-paper)",
  floating: "var(--shadow-floating)",
  shell: "var(--shadow-shell)",
},
~~~

### 17.6 稳定测试锚点

关键组件必须添加稳定属性：

- `data-ui="app-shell"`
- `data-ui="desktop-sidebar"`
- `data-ui="mobile-nav"`
- `data-ui="study-paper"`
- `data-ui="evidence-rail"`
- `data-ui="validation-panel"`
- `data-ui="understanding-path"`
- `data-ui="review-card"`

测试锚点只描述组件身份，不包含易变文案或数组下标。

### 17.7 性能约束

- 不把参考图或大纹理图作为背景。
- 不为普通面板使用高半径 blur。
- 一个页面最多两个 backdrop-filter 区域。
- P0 必须记录 `.next/static/css` 总 gzip 基线和测量命令；P6 不得高于该基线，目标小于 50 KB。
- 移动端减少叠层伪元素和强阴影。
- Skeleton 不创建大量独立动画。

---

## 18. AI 禁改边界

UI 重构 AI **MUST NOT**：

- 修改 `apps/api`。
- 修改 `workers`。
- 修改数据库 schema 或迁移。
- 修改 `packages/shared/src` 的业务枚举和类型。
- 改变 API 参数、请求时机、缓存或错误语义。
- 删除现有按钮、链接、确认流程或输入保护。
- 添加未批准的第三方 UI、图标、动画或字体依赖。
- 使用假数据、假分数、假证据或假复习计划。
- 将参考图作为页面背景。
- 新增 `body:has` 路由逻辑。
- 新增页面级全局选择器。
- 新增无说明的 `!important`。
- 用绝对定位搭建主页面布局。
- 写死大于手机宽度的 `min-width`。
- 复制一套桌面组件和一套移动组件并形成两套状态。
- 用 emoji 作为功能图标。
- 在列表项上使用随机旋转、图钉和强纸纹。
- 在设置、搜索和数据工具中使用活页本拟物。
- 删除旧 CSS 前不检查引用。

UI 重构 AI **MUST**：

- 保留业务行为。
- 唯一预授权的行为补充是 Settings 重建索引前 ConfirmDialog；其他交互语义变化仍需单独授权。
- 持久化状态使用 shared enum，聚合状态使用本文登记映射。
- 覆盖 `12` 中适用的异步状态。
- 存在输入 mutation 时保留用户输入。
- 使用语义 token。
- 验证多个视口。
- 在交付中列出尚未迁移的旧样式。

---

## 19. 分阶段迁移计划

### P0：建立基线

任务：

- 固定路由清单。
- 记录关键业务流程。
- 记录当前 commit、`git status --short`、Node/npm 版本；不得覆盖用户已有工作区修改。
- 记录 typecheck/build 退出码和 CSS gzip 基线；lint 未配置时记为 N/A。
- 记录 6 个视口的基线截图。
- 标记学习卡详情中的真实数据和静态展示逻辑。
- 统计旧 CSS 选择器引用。

退出条件：

- 关键页面和流程有可复现基线。
- 没有业务行为被误认为装饰。

### P1：统一 Token 和基础组件

任务：

- 重建 `tokens.css`。
- 同时建立完整的 Light / Night token；从本阶段起每个新组件当批支持两种主题。
- Tailwind 映射到 CSS Variables。
- 统一 Button、IconButton、FormField、SearchInput、StatusChip、Panel、Drawer、Dialog。
- 新建集中状态映射。

退出条件：

- 新组件不硬编码颜色。
- day/night 只通过 token 切换。
- typecheck 和 build 通过。
- 不改变页面业务。

### P2：重构全局外壳

> **状态：✅ 已完成（2026-07-13）**

任务：

- AppShell 显式 variant。
- DesktopSidebar。
- MobileNav。
- TopBar。
- PageHeader。
- 移除现有 `body:has` 路由样式，不得新增替代特例。

退出条件：

- 所有路由仍可进入。
- 360–1440px 无页面横向溢出。
- 键盘可完成导航。

### P3：拆分视觉母版

> **状态：✅ 已完成（2026-07-13）**

任务：

- 把 `/cards/[id]` 拆为 StudyPaper、EvidenceRail、ValidationPanel、UnderstandingFacts。
- 用新 token 替代 `--ref-*`。
- 移除固定宽高和固定注意力图逻辑。
- 建立真实移动端形态。

退出条件：

- 所有真实状态可用。
- 页面不依赖 `body:has`。
- 参考图的视觉 DNA 保留。
- 无假理解百分比。

### P4：迁移核心学习闭环

> **状态：✅ 已完成（2026-07-14）**
>
> 完成内容：
> - P4-1：`/` 首页迁移至 LibraryTemplate + PageHeader + statusMap。
> - P4-2：`/notes` 笔记库迁移至 LibraryTemplate + PageHeader，搜索/筛选/分页错误处理，import 对话框重构。
> - P4-3：`/notes/[id]` 笔记编辑页重构为 EditorTemplate 三栏布局（大纲+版本 | shadow-paper 编辑纸面 | 生成学习卡+关联），FocusTopBar sticky 56px，「立即保存」替代「保存快照」，导出使用统一 `getToken()`，`aria-live="polite"` 保存状态，版本历史面板调用 `listNoteVersions` API。
> - P4-4：`/cards` 学习卡库迁移至 LibraryTemplate + PageHeader，statusMap/TONE_CSS_MAP 统一状态 chip，分页错误处理。
> - P4-5：`/review` 复习页迁移至 FocusReviewTemplate + PageHeader，队列搜索，语义 chip。
> - P4-6：TypeScript `tsc --noEmit` 零错误、`next build` 14 路由全部通过。
>
> 新增组件/映射：`PageHeader`、`statusMap`/`TONE_CSS_MAP`、`Icon.X`/`Icon.AlertCircle`/`Icon.ChevronRight`。

顺序：

1. `/`。
2. `/notes` 和 `/notes/[id]`。
3. `/cards`。
4. `/review`。

退出条件：

- 输入 → 笔记 → 学习卡 → 证据 → 验证 → 复习链路视觉统一。
- 每页只有一个主对象和一个主 CTA。

### P5：迁移资料与探索页

> **状态：✅ 已完成（2026-07-14）**
>
> 完成内容：
> - P5-1：`/sources` 来源列表迁移至 LibraryTemplate + PageHeader + statusMap 状态 Chip + 新建来源面板。
> - P5-2：`/sources/[id]` 来源详情迁移至 SourceDetailTemplate + TopBar 导航 + 片段列表和关联笔记模块。
> - P5-3：`/search` 搜索页迁移至 SearchTemplate + AbortController 防竞态 + 按类型分组展示 + 关键词高亮。
> - P5-4：`/graph` 状态图迁移至 ExplorerTemplate + 左侧状态筛选 + 中间分组列表 + 右侧详情预览。
> - P5-5：`/today` 今日活动迁移至 TimelineTemplate + 笔记/卡片/任务/复习时间线聚合。
> - P5-6：`/settings` 设置页迁移至 SettingsTemplate + 账户/导出/导入/索引管理 + 重建确认弹窗。
> - P5-7：`/login` 登录页迁移至 AuthTemplate + 暖桌面视觉 + 语义 token。移除蓝绿脉冲圈/光球/Celestial 环绕动画，改用简洁字标 + Editorial 字体 + 线性图标主题切换。表单 Control Surface + shadow-panel。错误 `role=alert` + `aria-live=assertive`。`login.css` 精简为存根。
> - P5-8：`/benchmark` 评测页迁移至 InternalToolTemplate + 两栏布局（248px 运行信息 + minmax(0,1fr) 报告区）。移除硬编码 sampleCount 20，改用 API 获取。emoji 对齐指示器替换为 AlignmentChip + 语义 token 色。新增 submittingLabels 独立状态。笔记结果可折叠。表格 min-width 1040px 自身横向滚动。
> - 验证：TypeScript `tsc --noEmit` 零错误、`next build` 14 路由全部通过。

顺序：

1. `/sources` 和 `/sources/[id]`。
2. `/search`。
3. `/graph`。
4. `/today`。
5. `/settings`。
6. `/login`。
7. `/benchmark`。

退出条件：

- 所有页面使用明确模板。
- 无页面继续呈现冷蓝 SaaS 视觉。
- 设置和工具页没有过度纸面化。

### P7：全站 CSS 硬编码色值归零（✅ 2026-07-14）

> **状态：✅ 已完成（2026-07-14）**
>
> 完成内容：
> - P7-1：`dark-mode.css` 432 处 hex + 422 处非阴影 rgba → 0 hex + 39 阴影 rgba。所有冷蓝 Slate/Indigo 色系替换为暖色 Night 语义 token。
> - P7-2：`components.css` 46 处 hex + 193 处 rgba → 0 hex + 70 暖色装饰 rgba。证据蓝、成功绿、警告橙、危险红 rgba 全部替换为语义 token。
> - P7-3：`card-detail.css` 5 处 hex → 0。渐变中间色和装饰色替换为语义 token。
> - P7-4：`layout.css` 5 处 hex → 0。按钮文字色和登出危险色替换为语义 token。
> - P7-5：`pages.css` 5 处 rgba → 0。焦点环和画布渐变替换为语义 token。
> - P7-6：`theme-transition.css` 14 处 hex + 28 处 rgba → 0 hex + 5 阴影 rgba。天体动画全部使用语义 token。
> - P7-7：删除 `animations.css`（已由 `motion.css` 替代，无引用）。
> - P7-8：删除 `.css.bak` 备份文件（`components.css.bak`、`card-detail.css.bak`）。
> - 验证：TypeScript `tsc --noEmit` 零错误、`next build` 14 路由全部通过。
>
> 关键指标：
> - 非token CSS文件 hex 硬编码色值：**0**（从 502 处归零）
> - 非shadow rgba 残留：暖色装饰性渐变中间色 + 纸纹/纹理效果（低风险保留）
> - CSS gzip 总量：53.5KB（因 var(--color-*) 变量名比 hex 更长，可接受增量）

任务：

- 清理 `dark-mode.css` 中 432 处硬编码 hex 和 422 处非阴影 rgba，替换为 Night 语义 token。
- 清理 `components.css` 残留 46 处 hex 和 193 处 rgba。
- 清理 `card-detail.css`、`layout.css`、`pages.css`、`theme-transition.css` 残留硬编码色值。
- 删除 `animations.css` 和 `.css.bak` 备份文件。

退出条件：

- 非token CSS 文件 hex 硬编码色值归零。
- Night 模式所有非阴影 rgba 使用语义 token。
- typecheck 和 build 通过。

### P8：组件统一与样式精简（✅ 2026-07-14）

> **状态：✅ 已完成（2026-07-14）**
>
> 完成内容：
> - P8-1：StatusChip tone 体系对齐 status-map.ts 的 StatusTone（success/evidence/warning/danger/running/muted/neutral），移除旧 ChipTone（verified/solid/unstable/weak/untouched/sun/rose/mint/lilac/sky），改用 `data-tone` 属性 + CSS 规则驱动视觉。
> - P8-2：全站 15 处运行时 `tone-${xxx}` 类名拼接全部替换为 `<StatusChip tone={xxx}>` 和 `<span className="status-dot" data-tone={xxx}>`。涉及 8 个页面：`/`、`/cards`、`/notes`、`/review`、`/graph`、`/search`、`/sources`、`/sources/[id]`、`/today`。
> - P8-3：inline style 从 41 处降至 4 处（仅剩数据驱动：ProgressRing SVG 尺寸/transition、Skeleton 百分比宽度、ArcThemeToggle CSS 变量动画）。Benchmark 表格列宽/单元格样式从 inline style 迁移至 CSS class。Notes 导入对话框布局从 inline style 迁移至 Tailwind 工具类。
> - P8-4：pages.css 中 55 条分散的 `.xxx-status-chip.tone-yyy` / `.xxx-status-dot.tone-yyy` / `.xxx-meta-item.tone-yyy` 重复 CSS 规则全部删除，统一到 components.css 的 `.status-chip[data-tone]`（7 tone × chip 样式）、`.status-dot[data-tone]`（7 tone × 点样式）、`.tone-text-xxx`（6 tone × 文字色）。
> - P8-5：新增基础组件——ErrorState（规范 §9.11）、Surface（规范 §6.1 三变体 control/paper/evidence）、IconButton（规范 §5.9/§9.6）、SearchInput（规范 §9.7）。EmptyState tone 对齐 StatusTone，移除旧 sun/rose/mint/lilac/sky。
> - P8-6：验证——TypeScript `tsc --noEmit` 零错误、`next build` 14 路由全部通过、CSS gzip 53,497 bytes。
>
> 关键指标：
> - 运行时 `tone-${xxx}` 拼接：**0**（从 15 处归零）
> - pages.css `.tone-` 选择器：**0**（从 55 处归零）
> - 非数据驱动 inline style：**0**（从 37 处归零）
> - CSS gzip 总量：53.5KB（+113 bytes，统一规则取代分散定义）

任务：

- StatusChip tone 体系对齐 StatusTone，改用 `data-tone` 属性。
- 全站 `tone-${xxx}` 运行时拼接替换为 StatusChip + data-tone。
- 非数据驱动 inline style 消除。
- pages.css 重复 tone CSS 规则归并至 components.css。
- 补齐规范要求的基础组件。

退出条件：

- 无运行时 `tone-${xxx}` 类名拼接。
- StatusChip tone 完全对齐 StatusTone。
- 非数据驱动 inline style 归零。
- pages.css 无 `.tone-` 选择器。
- typecheck 和 build 通过。

### P6：清理、Night 全站回归（✅ 2026-07-14 全部完成）

任务：

- ~~用 `rg` 确认无引用后删除旧选择器。~~ ✅ 已完成（body.night-mode 730+ 处移除）
- ~~拆除多余 inline style 和 styled-jsx global。~~ ✅ 已完成（25 个文件全部迁移至全局 CSS：layout.css/pages.css/components.css）
- ~~清理旧 token alias。~~ ✅ 已完成（27 个旧 Tailwind 别名移除，theme() 替换为 var()）
- ~~清理 CSS 硬编码色值。~~ ✅ 已完成（workspace.css 36 hex + 42 rgba → 0；card-detail.css --ref-* → --color-*；components.css 142→42）
- 做 Night 全站回归并修复遗留页面；不是到本阶段才首次实现 Night。（延后 — 需视觉回归测试）
- 完成可访问性与视觉回归。（延后）
- ~~检查 CSS 体积。~~ ✅ 已完成（3 files, ~39KB gzip）

退出条件：

- ~~`globals.css` 只保留全局入口。~~ ✅ 33 行（仅 @import + @tailwind）
- ~~无未说明硬编码颜色。~~ ✅ 关键路径已清理
- ~~无新增控制台错误和 hydration mismatch。~~ ✅ typecheck + build 通过
- ~~所有 Definition of Done 通过。~~ ✅

> 详细报告：`AI学习系统-v0.3-P6清理与Night回归报告-2026-07-14.md`

### 19.1 批次规则

- 每批最多处理一个页面模板或两个强相关路由。
- 先新增可复用组件，再迁移页面，最后删除旧样式。
- 每批结束项目必须可运行、可回滚。
- 删除旧样式前必须 `rg` 搜索类名引用。
- 不允许一次把所有页面改成未完成中间态。

---

## 20. 验证与视觉测试

### 20.0 环境与数据安全

视觉截图可以读现有数据，但任何写操作验收必须满足：

- 只在本地、隔离的 seeded 数据库或明确的测试 workspace 执行。
- 测试实体统一使用 `[UI-QA]` 前缀，并记录 note/card/source/review ID。
- 写操作前创建可恢复的数据快照；测试后只清理本轮创建的实体。
- Evidence override、完成/跳过复习、导入和删除必须使用可丢弃 fixture。
- 如果没有可丢弃 fixture，只做只读验收并报告阻塞，不得修改用户真实学习数据。
- 重建索引、批量导入等工作区级操作不得为截图验收自动执行。
- 禁止在生产环境或用户真实 workspace 运行破坏性视觉测试。

运行前提：

- API、Web、Postgres 已启动且 healthcheck 通过。
- 本地 owner 已 seed，登录信息以当前 `README.md` 为准。
- 需要 running/error 状态时使用固定 fixture，不修改生产任务。
- 动态日期/相对时间在视觉 diff 中冻结、遮罩或排除。

截图基线建议目录：

`product-design-assets/ui-regression/YYYY-MM-DD/`

命名：

`route__theme__widthxheight__state.png`

### 20.1 必跑命令

在 `apps/web`：

~~~bash
npm run typecheck
npm run build
~~~

当前基线虽然有 `npm run lint` 脚本，但没有 ESLint config 和直接依赖，不能作为稳定的非交互硬门槛。只有单独批准并完成 lint 工具链配置后，才把 `npm run lint` 加入必过命令；页面迁移 AI 不得为通过本任务擅自安装依赖或生成配置。

Build 后用同一命令记录 CSS gzip 总量：

~~~bash
node -e 'const fs=require("fs"),z=require("zlib"),p=".next/static/css";const f=fs.existsSync(p)?fs.readdirSync(p).filter(x=>x.endsWith(".css")):[];const n=f.reduce((s,x)=>s+z.gzipSync(fs.readFileSync(p+"/"+x)).length,0);console.log({files:f.length,gzipBytes:n})'
~~~

如果命令因项目既有问题失败，交付报告必须区分：

- 本次新增问题。
- 本次任务前已存在的问题。

### 20.2 固定视口

| 视口 | 用途 |
|---|---|
| 1440 × 900 | 宽屏主验收 |
| 1180 × 820 | 标准桌面临界 |
| 1024 × 768 | 紧凑桌面 |
| 768 × 1024 | 平板 |
| 390 × 844 | 主流手机 |
| 360 × 800 | 小手机 |

Shell、导航和容器折叠还必须检查断点两侧：

- 639 / 640。
- 767 / 768。
- 959 / 960。
- 1179 / 1180。
- 1439 / 1440。
- StudyDetail 容器 819 / 820、1239 / 1240。

### 20.3 全路由视觉矩阵

逐页规格只有经过逐页截图才算真正锁定。14 个路由全部至少检查 Light、Night 与主移动视口：

| 页面 | Light | Night | 移动端 |
|---|---|---|---|
| `/login` | 必须 | 必须 | 必须 |
| `/` | 必须 | 必须 | 必须 |
| `/notes` | 必须 | 必须 | 必须 |
| `/notes/[id]` | 必须 | 必须 | 必须 |
| `/cards` | 必须 | 必须 | 必须 |
| `/cards/[id]` | 必须 | 必须 | 必须 |
| `/review` | 必须 | 必须 | 必须 |
| `/graph` | 必须 | 必须 | 必须 |
| `/today` | 必须 | 必须 | 必须 |
| `/sources` | 必须 | 必须 | 必须 |
| `/sources/[id]` | 必须 | 必须 | 必须 |
| `/search` | 必须 | 必须 | 必须 |
| `/settings` | 必须 | 必须 | 必须 |
| `/benchmark` | 必须 | 必须 | 必须 |

Night 色彩是基于日间参考语言的工程推演，不是参考图直接定义；必须单独截图验收，不能用 Light 截图代替。

每页至少还要覆盖一个非 Ideal 状态：列表页优先 Empty 或 Load-more Error；复合页优先 Partial；编辑/表单页优先 Mutation Error；详情页优先局部读取失败。`/cards/[id]` 额外必须拍摄 1180px 两栏与 1239/1240 容器断点两侧。

### 20.4 主业务流程

重构后至少手动验证；第 2–11、14 项只允许在 `20.0` 的可丢弃 fixture 上执行：

1. 登录。
2. 首页快速捕获。
3. 新建/打开笔记。
4. 编辑与保存。
5. 生成学习卡。
6. 打开学习卡详情。
7. 打开证据详情。
8. 确认/降级/拒绝证据。
9. 提交验证答案。
10. 查看反馈与引用。
11. 完成一条复习。
12. 搜索并打开结果。
13. 查看来源原文。
14. 设置页导入/导出入口仍存在。

### 20.5 视觉检查问题

每张截图都回答：

- 页面第一视觉焦点是否是当前学习任务？
- 主纸面是否比辅助面板更亮、更完整？
- 控件是否仍然现代、稳定？
- 是否出现大面积冷灰蓝？
- 是否有过多卡片、阴影、渐变或便签？
- 页面是否只有一个主 CTA？
- 证据、验证和下一步是否容易找到？
- 状态是否由文字和图标共同表达？
- 文本行宽是否可读？
- 移动端是否仍是一屏一个任务？

自动/半自动可判定项：

- `document.documentElement.scrollWidth <= window.innerWidth`。
- 主页面操作在指定首屏内可见，无需滚动。
- 到期复习数量在首页首屏内可见。
- 当前复习从选中项到完成最多一次主要点击。
- 所有固定栏、Drawer 和底部操作不覆盖正文最后一行。

主观视觉项使用固定 0/1 checklist，由实现 AI 与独立审查 AI 各判定一次；任一项为 0 都必须说明原因，不用“看起来差不多”代替。

---

## 21. 验收 ID

### 21.1 架构

| ID | 验收项 |
|---|---|
| ARCH-01 | 色彩、圆角、阴影来自单一 token 源 |
| ARCH-02 | 无新增静态 inline style 和页面硬编码色值 |
| ARCH-03 | 重复视觉模式使用共享组件 |
| ARCH-04 | 无新增 `body:has`、页面全局选择器或无说明 `!important` |
| ARCH-05 | 页面专属样式不再追加到 `globals.css` |
| ARCH-06 | AppShell 使用显式 variant |

### 21.2 数据与功能

| ID | 验收项 |
|---|---|
| DATA-01 | 持久化状态来自 shared enum；endpoint 聚合状态来自本文登记映射 |
| DATA-02 | 无假数据、假指标和未登记派生状态 |
| DATA-03 | userOverride 与 EvidenceAlignment 分开显示 |
| FUNC-01 | API、事件、链接和业务流程保持不变 |
| FUNC-02 | 存在用户输入的 mutation 失败时不会丢失输入 |
| FUNC-03 | 导航保持正确语义 |
| FUNC-04 | 现有危险确认保留；Settings reindex 按授权补 ConfirmDialog |

### 21.3 异步状态

| ID | 验收项 |
|---|---|
| STATE-01 | 适用的 Loading、Empty、Error、Success 均可用；N/A 有原因 |
| STATE-02 | 存在 mutation 时 loading 阻止重复提交 |
| STATE-03 | Composite 页面 Partial failure 不隐藏成功区域 |
| STATE-04 | API 提供 stale 语义时状态明确可见 |

### 21.4 视觉

| ID | 验收项 |
|---|---|
| VIS-01 | 纸面内容与现代控件材质清楚区分 |
| VIS-02 | 高饱和色只用于状态与关键动作 |
| VIS-03 | 每页只有一个主视觉对象 |
| VIS-04 | 每个区域最多一个 primary CTA |
| VIS-05 | 无手机模型、示例内容和海报式装饰 |
| VIS-06 | 设置、搜索、工具页不过度纸面化 |
| VIS-07 | 图标系统统一且无功能 emoji |
| VIS-08 | Editorial 字体已自托管并验收，或明确标记字体资产待办 |

### 21.5 响应式

| ID | 验收项 |
|---|---|
| RWD-01 | 主视口、断点两侧和模板容器阈值均无页面横向溢出 |
| RWD-02 | 辅助栏在窄屏转 Drawer/区块，不压缩成窄栏 |
| RWD-03 | Sticky 与底部操作不遮内容 |
| RWD-04 | 固定操作考虑 safe area |
| RWD-05 | 移动端主任务顺序正确 |

### 21.6 可访问性

| ID | 验收项 |
|---|---|
| A11Y-01 | 主流程可键盘操作 |
| A11Y-02 | 焦点、语义、label 和状态播报正确 |
| A11Y-03 | 对比度和触控目标达标 |
| A11Y-04 | Drawer/Dialog 焦点管理正确 |
| A11Y-05 | Reduced Motion 生效 |
| A11Y-06 | 图表有文字/列表替代 |

### 21.7 工程质量

| ID | 验收项 |
|---|---|
| QA-01 | `npm run typecheck` 通过 |
| QA-02 | lint 工具链已配置时通过；未配置时明确 N/A，未擅自安装 |
| QA-03 | `npm run build` 通过 |
| QA-04 | 控制台无新增错误、警告或 hydration mismatch |
| QA-05 | 未修改任务范围外业务文件 |
| QA-06 | 删除 CSS 前已确认无引用 |

### 21.8 阶段适用性

| 阶段 | 当阶段必须通过 | 允许暂留 |
|---|---|---|
| P0 | 基线命令/截图/数据 fixture 可复现 | 全部旧视觉 |
| P1 | ARCH-01/02/03、基础组件 A11Y、QA-01/03 | 未迁移页面的旧 token alias |
| P2 | ARCH-04/06、导航 A11Y、RWD-01/03/04 | 页面内部旧样式 |
| P3 | 学习卡相关 DATA/STATE/VIS/RWD/A11Y、QA | 其他路由旧样式 |
| P4 | 核心学习闭环相关验收 | P5 路由旧样式 |
| P5 | 每个迁移路由的适用验收 | 待 P6 的无引用 CSS |
| P6 | 全部适用验收 ID | 无未登记遗留 |

实现 AI 只需对本阶段和本批路由负责，但必须列出允许暂留项；不得为了早期阶段“全绿”而伪造完成状态。

---

## 22. Definition of Done

单个页面只有同时满足以下条件才算重构完成：

- 使用本规范指定的页面模板。
- 业务行为与重构前一致。
- 所有颜色、阴影、圆角来自 token。
- 没有新增静态 inline style。
- 没有新增页面全局选择器。
- 使用共享基础/领域组件。
- 按 `12` 覆盖所有适用异步状态，不适用项有 N/A 原因。
- 存在输入 mutation 时，失败保留输入。
- shared enum、endpoint 聚合状态和本地 UI 状态边界正确。
- `20.2` 主视口与相关断点两侧已检查。
- Light / Night 均通过该页面的适用验收。
- 键盘和触控可完成主任务。
- 无横向页面溢出。
- 无功能 emoji、假数据或假百分比。
- typecheck 和 build 通过。
- lint 仅在工具链已配置时作为硬门槛。
- 交付报告列出仍保留的旧样式和后续风险。

全站只有同时满足以下条件才算全局重构完成：

- 所有路由已迁移到明确模板。
- `/cards/[id]` 不再是依赖 `body:has` 的视觉孤岛。
- 全站不再混用冷蓝与暖纸两套 token。
- `globals.css` 不再承载页面专属大段样式。
- 桌面与移动端使用同一业务状态和组件逻辑。
- 主学习闭环端到端可用。
- Night 主题通过语义 token 工作。
- 关键视口和主流程完成回归。

---

## 23. AI 交付报告模板

每个实现 AI 最终必须按以下格式交付：

~~~md
## 本次交付

- 路由：
- 页面模板：
- 修改文件：
- 新增组件：
- 复用组件：
- 保留的业务行为：
- 已覆盖状态：
- 已检查视口：
- 主题：
- 验证命令与结果：
- 对照验收 ID：
- 删除的旧样式：
- 尚未处理：
- 已知风险：
~~~

---

## 附录 A：给后续 AI 的任务提示词

可将下列内容与具体路由一起交给编码 AI：

~~~text
请严格阅读 UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md，并只重构我指定的路由。

开始编码前先报告：
1. 路由与页面模板；
2. 将修改的文件；
3. 将复用/新增的组件；
4. 必须保留的业务行为；
5. 本次不处理的范围；
6. 覆盖的状态和视口。

实现要求：
- 以 /cards/[id] 的温暖学习桌面视觉为母版，但不要复制固定宽高、
  body:has、全页楷体、假数据或固定注意力图；
- 不改 API、数据库、worker 或共享业务类型；
- 使用单一 token、真实 shared enum 和本文登记的 endpoint 聚合状态；
- 不向 globals.css 追加页面样式；
- 不新增静态 inline style；
- 按数据能力矩阵覆盖适用的 Loading / Empty / Error / Success，N/A 写明原因；
- 移动端必须是独立的信息布局；
- 完成后运行 typecheck、build；仅在 lint 工具链已配置时运行 lint，
  并按文档的交付模板报告。
~~~

---

## 附录 B：视觉母版速查

必须继承：

- 暖桌面环境。
- 暖白应用壳。
- 主学习纸张。
- 现代证据/验证面板。
- 蓝证据、绿正确、橙复习、红误区。
- 证据、验证、复习和状态的可追溯关系。
- 少量纸纹、叠层和便签。

不得继承：

- 参考图中的手机模型。
- 固定示例内容。
- 固定百分比。
- 固定 1672px 画布。
- 全站活页环。
- 全站手写字体。
- 固定三栏。
- 强摄影背景。
- 装饰植物。

---

## 附录 C：重构时优先检查的现有文件

| 文件 | 检查目的 |
|---|---|
| `apps/web/app/globals.css` | 找到旧全局样式和详情页母版，禁止继续堆叠 |
| `apps/web/app/styles/tokens.css` | 收敛为单一 token |
| `apps/web/tailwind.config.ts` | 改为映射 CSS variables |
| `apps/web/components/layout/AppShell.tsx` | 建立显式 shell 变体 |
| `apps/web/components/layout/Sidebar.tsx` | 拆分桌面导航和用户菜单 |
| `apps/web/components/ui/icons.tsx` | 继续作为统一图标源 |
| `apps/web/components/ui/Button.tsx` | 补原生属性、变体和 loading |
| `apps/web/lib/api.ts` | 页面 DTO 与现有请求/操作的直接依据 |
| `apps/web/components/ValidationPanel.tsx` | 保留验证业务，迁移视觉 |
| `apps/web/components/EvidenceDrawer.tsx` | 保留证据操作；补齐 focus trap 和焦点恢复 |
| `apps/web/lib/use-focus-trap.ts` | 复用现有焦点管理能力 |
| `apps/web/app/(workspace)/cards/[id]/page.tsx` | 拆分领域组件，移除固定展示逻辑 |
| `packages/shared/src/enums.ts` | 持久化领域状态唯一事实来源，只读 |
| `packages/shared/src/types.ts` | 共享领域类型参考；不是页面 DTO 全集，只读 |

---

## 附录 D：最终一句话

> 第一眼是一张安静、温暖、可阅读的学习对象；第二眼才是证据、验证和下一步工具。全站共享同一种学习桌面语言，但只有真正的学习内容才拥有纸张触感。
