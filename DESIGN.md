---
name: 理解书房 Desktop V1 + Home V2 Preview
description: 温暖纸感的固定镜头 2.5D 学习书房，以功能旗标预览会生活的魔法伴星小屋首页。
---

<!-- q0-doc-metadata: status=CURRENT_DESIGN_TRUTH; version=V1+HOME_V2_PREVIEW; date=2026-09-11; implementation-freeze=active -->

<!-- 2026-09-22：本文件的 §Colors / §Typography / §Companion Interaction Layer 已按代码实测值更正。
     同一天的全站语汇审计与分批实施记录见
     docs/plans/learning-companion/33-hud-style-consistency-audit-2026-09-22.md。
     注意：`components/hud/hud-pages.css` 的生成源 `.impeccable/review/desktop-pages-v3/mockup.html`
     已丢失（`.impeccable/` 在 .gitignore 内，从未提交），该文件现在直接手改；
     不要跑 `scripts/port-hud-css.mjs`，它会 ENOENT。 -->

# Design System: 理解书房 Desktop V1 + Home V2 Preview

## Overview

**Creative North Star: “有生命的纸上书房”**

理解书房把学习界面做成温暖木质、手绘绘本感的真实书房，而不是冷灰蓝的 SaaS 面板。浅木、米白纸张、亚麻、自然光和克制的物理阴影建立空间感；轻卡通但不儿童化，装饰始终服从阅读与操作。

**Home V2 首页规则（2026-09-22 校正）：** Home V2 规则就是现行首页规则，取代此前首页的“四岛导航”和“默认 orb”约束。**不存在 `VITE_HOME_SCENE_VARIANT` 旗标**：代码里没有任何读取点，`HomeV2Provider` 无条件挂载，因此也不存在"由旗标切回 V1 回退分支"这回事——把它做成可切换是一次待决定的事，不是现状。该覆盖不改变任务面、服务权限或领域能力：`RoomProjectionV1` 保持不变，伴星只使用既有三条 typed API/IPC。Home V2 **已经是现行唯一首页**；旧首页运行分支的移除是一次待做的清理决定（`TaskSurface` 仍挂载在 `App.tsx:139`），不再是「门禁全绿后才发生」的前置条件。

Home V2 的视觉路径是固定镜头 2.5D：高分辨率日/夜注册图层负责构图，固定的对象锚点与前后遮挡建立空间层次，DOM、CSS、SVG 与受控 Canvas 负责状态、交互与数据。它不使用全局鼠标视差、自由相机、轨道漫游或第一人称导航；空间感始终服务于学习入口与任务连续性。

**核心体验规则：房间总览有生命，进入任务立即安静，关键结果只反馈一次。** 所有真实文字、控件、状态、错误与学习结果由语义化 DOM 承载；图片、视频、声音和图形层不能成为唯一信息源。

**Key Characteristics:**

- 固定构图、分层景深的 2.5D 房间舞台。
- 暖纸面、木质、柔和水粉和少量天蓝星光的视觉语言。
- 房间与任务面连续切换；同一时刻只保留一个注意力中心。
- 媒体是渐进增强；Pixi D0–D4 是正常分层路径，静态 poster 是资产或 WebGL 失败时的完整稳定回退。
- 中文优先，视觉标题用衬线，操作与说明用清晰无衬线。

## Colors

### V3.1 HUD 调色板（任务页真正的取值来源）

任务页的纸面、描边、阴影与缓动全部来自 `components/hud/hud-pages.css` 的 `--hud-*` 一族。
2026-09-22 起这组 token 声明在 `:root`（原先在 `.hud-surface` 上，而伴星有两处 `createPortal(…, document.body)` 落在那个子树之外，取不到变量就静默没有声明）。

| 属性 | 值 | 用途 |
|---|---|---|
| `--hud-ink` / `--hud-soft` | `#30231a` / `#705d4d` | 主文字 / 次要文字 |
| `--hud-paper` / `--hud-paper-light` / `--hud-paper-deep` | `#f5ead5` / `#fff9eb` / `#e8d4b1` | 纸面三层 |
| `--hud-cream` / `--hud-butter` | `#fff2cf` / `#f3d678` | 气泡与卡片底 / tag 与便签底 |
| `--hud-mint` / `--hud-green` | `#b9d3ad` / `#66816a` | 薄荷板 / 绿底动作 |
| `--hud-peach` / `--hud-clay` | `#e89568` / `#bd5a31` | **主按钮底** / 陶土强调 |
| `--hud-star` / `--hud-sky` / `--hud-blue` / `--hud-gold` / `--hud-red` / `--hud-berry` | `#79cedc` `#99cad4` `#203d57` `#e9c66f` `#a9533e` `#b86b69` | 星光、冷色与警示 |
| `--hud-line` / `--hud-line-strong` | `rgba(73,47,29,.22)` / `rgba(66,41,25,.46)` | 分隔线 / 控件边界 |
| `--hud-shadow` / `--hud-shadow-small` | 双层柔影 | 主板 / 小浮层 |
| `--hud-ease-out` | `cubic-bezier(.23,1,.32,1)` | 全站缓出 |
| `--hud-island-ease` | `cubic-bezier(.22,1,.36,1)` | **只给岛状控件的几何形变**（`.home-v2-hud` 展开收起时的 width/height/grid-template-columns/gap/padding），与 `--hud-island-motion: 320ms` 成对。此前这条曲线被手抄 24 处 |

**`--hud-green` 只有一个值（`#66816a`）。** 母本曾同时在一段里声明过两次（`#556c55` 与 `#66816a`），`#556c55` 是被覆盖的死值，却已被 `approved-surfaces.css` 抄走；2026-09-22 已删除重复声明。

### 旧一代 `styles.css` token（仍有人读，别再扩）

`styles.css:4-31` 这组 token 的**衬底已经收回母本**（2026-09-23 实测，逐条在真窗口读过 computed）：`--ink` `--ink-soft` `--paper` `--paper-strong` `--paper-deep` `--accent` `--line` `--line-strong` `--paper-shadow` `--soft-shadow` 现在都是 `var(--hud-*)` 的别名，**不再各自持有一个近义字面量**（上面那份"`--paper #f7ecd5`、`--accent #bd5b2d`"是收回前的旧值，留在这里只作历史）。`styles.css` 里**仍然自持值的只剩 6 条**：`--focus`（全站焦点环的唯一 token，**HUD 层反过来读它**，引用 49 处）、`--accent-deep`、`--sage` / `--sage-deep`、`--glass-line` / `--glass-text`（深色浮层的描边与文字）。原则是**衬底共用、身份保留**：与 `--hud-*` 只差 1–3 通道的属重抄，收回；差得远或语义不同的别当重复删。
同一天还删掉了 **`--wood`、`--star`、`--control-bg`、`--control-text`、`--glass-bg`、`--glass-shadow`** 六条：它们在渲染层消费者为 0（用"声明位置 + 词边界 + `var()` 多形态"三条件判的，删除后对拍 0 处计算值差异）。**本文件以前把它们当活 token 介绍过，那些句子现在都不成立了。**
`--hud-star` / `--hud-gold` 之外还有一处需要知道：**星图有两份调色板，是有意变体，不许互相对齐**。`.universe-page`（`understanding-universe.css`）走 `--color-*` / `color-mix()`，伴星中心里嵌的那份（`hud-surface.css` 的 `.companion-center` 局部表）写字面量——把 16 个共享变量的**计算值**逐个算出来比是 **8 同 8 不同**：同一块 `universe-canvas-controls` 在整页星图是奶油纸 `rgb(255,242,207)`、在嵌的小星图是深夜玻璃 `rgba(11,33,48,.9)`。那份局部表原先的注释自称"与 `.universe-page` 同值"，**这句是假的**，已换成量出来的事实。

**本文件此前点名的 `--accent-strong`、`--scene-control`、`--scene-text`、`--shadow-lg`、`--shadow-md` 在代码里不存在**（消费者 0）。当前对应的实现名：`--accent-strong` → `--accent-deep`；`--scene-control` / `--scene-text` → 深色浮层那一组只剩 `--glass-line` / `--glass-text`（`--control-*` 已随零消费者清理删除）；`--shadow-lg` / `--shadow-md` → `--hud-shadow` / `--hud-shadow-small`（见 §Elevation）。

### 夜间今天实际改了什么

`styles.css:135` 的 `.desktop-app[data-theme="night"]` **只覆盖一条**：`--focus: #7ad2df`（以前它还覆盖 `--control-bg`，那条 token 已随零消费者清理删除）。任务纸的夜间色不来自这张表，而是各页自己的 `.night-paper` 一类局部规则。本文件旧表里的整列"夜间"值是设计意图，不是现状记录。
**一条实测事实，防止再被写成缺口：** 这个产品**没有**"逐页夜间转暗"这回事。在 night 主题下量各任务页的纸色 computed：`day-route` / `study-card` / `notebook` / `marked-paper` / `search-desk` 全是 `rgb(255,242,207)`（亮度 242），`claim-sheet` 235——**夜间任务纸一律是奶油色**，`.night-paper` 是天文台那类显式启用的另一套面。所以"某页（例如页 14 的 `study-surface.css`，全文件 `night` 0 命中）没有夜间分支"通常不是缺陷，2026-09-22 的量推翻了这条原判。

**键盘焦点环只有一个：** `3px solid var(--focus)`，`outline-offset: 3px`；日间 `#9a351d`、夜间 `#7ad2df`（此前文档写的 `#8f3518` / `#83d8e7` 与代码不符）。页 14 因为夜间任务纸仍是奶油色、冷青环对比度不够，在该页作用域内把 `--focus` 覆盖为 `#b85a31`——**是同名 token 的局部覆盖，不是另立一个焦点色**。

**首页那套 `--home-*` 已经不存在了**（2026-09-23）。本文件以前写着"首页目录使用 `--home-paper: #f1dfbd`…可进入能力使用 `--home-cloth: #50604c`"——那些值属于旧物理目录 (`home-room.css` 的 `.home-catalog` / `.rail-action` / `.hotspot` 一族)，实现早已没有 DOM 生产者，整条链连同 token 表一起删掉了（判据与工具见 `docs/plans/learning-companion/33-hud-style-consistency-audit-2026-09-22.md` §12）。首页现在只有 `home-v2.css` 自带的一小撮局部 token（`--home-v2-ink` / `--home-v2-muted` / `--home-v2-paper-strong` / `--home-v2-ease-out`，共 4 条有 10 处读者）。

星光色现在只有一个：`--hud-star: #79cedc`（母本），以前那个近义重抄 `--star: #73cadc` 已删。证据便签与卡片引用使用现有暖黄纸色 `#efd982`；理解星图使用深海军蓝背景 `#172a3d`，以浅青、暖金、陶红区分节点状态。

**The Warm-First Rule.** 主工作区保持暖纸、木棕和橙色动作体系；蓝青色只用于伴星、星图与夜间冷光，不扩张成通用 SaaS 蓝色主题。键盘焦点环不属蓝色系（见上）。

**The Registered Pair Rule.** 日夜只改变光照、色温与主题颜色，不改变房间构图、交互锚点或任务结构。

## Typography

基础界面使用 `"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`；任务标题、研究册正文、引文、卡片问题和验证印章使用 `"Noto Serif SC Variable", "Songti SC", serif`。**家族名必须带 `Variable` 后缀**：`package.json` 只装了 `@fontsource-variable/noto-sans-sc` 与 `@fontsource-variable/noto-serif-sc`（`styles.css:1-2` import），注册出来的族名就是这两个带后缀的名字；写成不带后缀的 `"Noto Serif SC"` 没有任何 `@font-face` 与之对应，会静默掉到 `Songti SC`。2026-09-22 之前源 CSS 里有 136 处这么写，导致 HUD 层的衬线一直在渲染宋体。当前实现没有独立的字体 token，勿把下列组件值抽象成尚未落地的全局比例。

- **任务标题：** `clamp(27px, 2.6vw, 36px)`、字重 `680`、行高 `1.28`、字距 `-0.03em`，用于右侧任务面的唯一主标题。
- **阅读与输入：** 研究册正文为 `17px / 2`，引文为 `18px / 1.85`；较大的行高保留纸面呼吸感。
- **正文与操作：** 主要使用 `12–15px` 的无衬线文字；按钮以字重 `650` 保持清晰。
- **元数据：** 使用 `9–11px`、柔和墨色和轻微正字距（现有范围 `0.025–0.055em`），只承担时间、状态和来源说明。

**The Two-Voice Rule.** 衬线体表达“正在理解的内容”，无衬线体表达“系统如何操作”；不要让装饰字体进入表单、快捷键、状态或长段说明。

## Layout

房间使用固定 `1672 / 941` 参考画幅，原生内容窗口同步锁定该纵横比且不得小于 `1280×720`；不为不同窗口比例生成补画、不拉伸或模糊填充。系统缩放只等比改变有效 CSS 视口，始终保持同一构图，并通过单个变换层建立有限的空间聚焦。Home V2 首页镜头预设为：

**Home V2 验收视口矩阵（2026-09-11）：** `1440×810`、原生最小内容尺寸 `1280×720`，以及 125% / 150% / 200% 系统缩放；200% 缩放在 `1440×810` 上产生 `720×405` 的紧凑 CSS 视口，用于验收紧凑语义房间。`1024×700` 不是验收尺寸：原生窗口按 `1672:941` 锁定纵横比且不小于 `1280×720`，该尺寸既低于最小宽度也不在锁定比例上，产品运行时与截图脚本都无法产生它。该矩阵的可执行校验是 `src/shared/window-geometry.ts` 的 `homeWindowSizeProblems()`，验收记录见 [Home V2 魔法小屋验收记录](./docs/plans/27-home-v2-magic-cottage-acceptance.md)。

| 预设 | 已实现变换 |
|---|---|
| `wide` | 房间总览与首次物件选择 |
| `desk` | 学习、研究册与复习物件 |
| `shelf` | 书架、目录与房内查找 |
| `window` | 窗边目标与日夜控制 |
| `rest` | 休息角与伴星交互 |

首页使用“生活地图式书房”：总览只保留书桌、书架、星窗与休息角四个代表性命中区。第一次激活只聚焦区域并显示该区功能签条，第二次选择具体功能；未迁入能力打开准确的建设状态说明，不进入旧任务页面。左下角任务岛承载今日下一步与目录入口，右上角灵动岛承载个人中心、设置、主题、动效、静音与引导。

有效 CSS 视口宽度不高于 `720px` 或高度不高于 `480px` 时，首页切换为紧凑语义房间：保留装饰背景，提供四个区域入口与全屏目录；任务面保持全宽，200% zoom 与极窄窗口仍须完成全部操作且无横向溢出。

**The Fixed-Room Rule.** 只通过小幅平移与缩放把物件靠近任务面接缝；不旋转房间、不制造持续视差、不加入自由漫游。

## Elevation & Depth

深度来自纸张叠放、暖色边界、轻微材质纹理和双层柔影，而不是玻璃化面板堆叠。现有全局阴影只有：

- `--hud-shadow`: `0 24px 60px rgba(46,27,16,.28), 0 4px 14px rgba(46,27,16,.18)`，用于主纸面浮层（`--paper-shadow` 现在是它的别名）。
- `--hud-shadow-small`: `0 12px 28px rgba(43,27,17,.22), 0 3px 8px rgba(43,27,17,.14)`，用于小浮层、岛与chip（`--soft-shadow` 是它的别名）。

这两条是全站唯一的阴影来源（`styles.css` 的旧名 `--shadow-lg` / `--shadow-md` 从来没有实现，本文件以前按那两个名字写的数值也已经按代码改正）。除此之外全站仍有 **315 条 `box-shadow` 声明：123 条引用 `var(--)`，192 条自写字面量（去重后 151 个值）**，字面量最多的五个文件是 `hud-surface.css` 43、`hud-pages.css` 29、`companion-hud.css` 21、`desktop-access-gate.css` 17、`home-v2.css` 13——**哪些该并进母本双层影是个设计决定，不是笔误能带过去的**，见 33 号文档 §12 的 B3 行。

任务面使用可平铺的 `notebook-pages.webp` 纸纹；日间操作栏在纸纹上叠加暖米色半透明层，夜间任务面用深褐遮罩压低纹理。研究册输入区用 `34px` 节奏的横线模拟活页纸，学习卡使用 `learning-card.webp`，证据便签使用暖黄卡纸和约 `-0.5deg` 的轻微手工偏转。纹理必须低对比，不能降低正文可读性。

**The Physical Paper Rule.** 阴影说明纸层之间的关系；不为每个列表项或字段制造独立悬浮卡片。

## Shapes

**这一节此前写的是 V2 的轮廓语言，与现在实际生效的 V3.1 契约冲突**（V3.1 母本 `components/hud/hud-pages.css` 全篇用奶油粗边 + 双轴抖动圆角，且 §Components 已按 V3.1 描述任务面）。2026-09-22 明确两者关系：

- **界面语汇的唯一母本是 V3.1。** 新写的纸面、卡片、弹层、控件都用 V3.1：`border: 4px solid rgba(255,252,235,.78)`（小卡与小纸片 `3px`）配**四角不等 + 双轴斜杠**的圆角，例如 `31px 42px 29px 38px/35px 30px 43px 31px`；控件级 `17px 21px 16px 19px`；tag 与小纸片 `11px 14px 10px 13px`；字段 `13px`。圆形只用于关闭按钮、房间热点、状态点与图标容器；**药丸形（`999px`）是"岛状控件与 chip"的既成语汇**，实测除右上沉浸控制岛与首页深色岛之外，目标链路的筛选 chip（`objective-flow.css:214`）、模式徽标 `objective-mode-badge`、`learning-run-journey__state`、收起态的远征名册把手都用它——**不要把它们改成抖动圆角**，那只会制造新的不一致。"不要把容器改成统一大圆角或药丸"这句管的是**纸面容器**，不是 chip。
- **V2 的切角轮廓（`3px 18px 3px 3px`、`2px 2px 9px 2px`）已经清完**：按**四角形状的 computed 赢家**逐屏量，全站真生效 **0 处**（此前"约 20 处留在主纸张与便签上"是文本级统计，把被后层覆盖的也算了进去，作废）。这条判据本身留着：V2 切角**不再作为新样式的依据**，旧条目中的"默认控件 2–4px 轻微圆角""不对称切角形成识别度"两句据此作废。
- **`The Cut-Corner Rule` 由 `The Wobble Rule` 取代：** 大纸面的识别度来自**四角不等 + 双层柔影 + 粗奶油边**，不是来自"右上角特别圆"。不要把容器改成统一大圆角或药丸，也不要把它们改成 2–4px 直边切角。

## Components

### Room Stage

- 原生窗口只允许按 `1672:941` 等比缩放，最小内容尺寸 `1280×720`，并关闭最大化与全屏入口；所有正常、聚焦和过渡帧必须由同一个注册画幅覆盖，不存在按窗口比例切换的底图分支。
- 日/夜 D0–D4 由 Pixi 按深度顺序合成；合成 poster 只在资产或 WebGL 失败时接管。装饰媒体、伴星和背景图均从无障碍树隐藏。
- D0–D4 与 D6 全部以 `1672×941` 统一配准，并登记主题、深度、锚点、SHA-256、来源、许可和发布状态；基础层不得重复烘焙独立物件、收藏/接触阴影或前景遮挡。
- 首页窗景使用静态 poster 中已经完成透视与色彩统一的画面，不再叠加独立视频层，避免窗外内容与房间产生接缝或相对位移。
- 首页底图与全部 D0–D6 层不做持续鼠标视差。研究册、复习物件、地球仪与台灯只在悬停、键盘聚焦时用同源像素高光和接触阴影形成局部抬升；书架主体与窗户等大面积结构保持静止。
- 房间背景、窗景、家具与 D0–D4 场景层保持静止，不播放海面、窗光、台灯、书页或蒸汽循环。`roomLayers` 没有获批发布层时不创建 Pixi Canvas，避免重复上传同一张 poster。
- 伴星只使用已获许可的窗口内 Live2D（唯一形态，无形态切换项；2026-09-16 裁决）。许可、模型、WebGL、资源或上下文失败时**隐藏形象并就地给出可关闭说明**，不降级为光球或替身立绘；紧凑视图、Lite、Off 和 reduced-motion 仅暂停 Live2D ticker 并保留最后一帧，不得重建 Canvas。首页目录展开时伴星让出目录与桌面中心；目录收起后回到右下默认位置，拖动后的归一化脚点拥有位置控制权，提示不得抢回；角色缩放、窗口尺寸或系统缩放变化后必须以该脚点重新投影并收束到视口内。建议面板按左右空间自动翻向，并在矮窗口内滚动而不裁掉大小与重置控件。
- 拖动伴星身体只写入归一化脚点锚点，松手即定格，不吸附到最近区域：吸附会挪走用户刚刚放下的位置，破坏直接操作的可预期性。本条取代早期计划中的“松手后吸附到最近区域”，用户放置必须跨窗口尺寸、系统缩放、形态切换与会话内窗口变化保持。
- **借位必归还：** 低优先级（`ordinary`）提示永不移动伴星；高优先级提示可以临时把伴星走到目标区域，但必须在提示结束后归还用户脚点锚点，期间不改写、不覆盖用户放置。
- 伴星语音只承担短促合成提示：仅在关键提醒与用户显式唤醒伴星时发声，受总静音开关约束；语音服务不可用时静默降级，文本与操作路径保持完整。
- 首页伴星在脚下保留接触阴影，并把交互命中区收紧到角色本体；透明容器不能挡住研究册和复习物件。
- D5 只承载 Live2D、角色引导线与短暂交互反馈，不驱动背景物件；稳定画面不保留持续粒子、星点或闪粉。D6 使用透明近景绿植制造镜头前遮挡，并只在 Live2D 上方绘制一次。

### Home Command Deck, Catalog & Hotspots

- 房间区域、目录、快捷键与说明纸面共用 `HomeFeatureRegistryV1`；功能 ID、名称、所属区域、目录分组、顺序、状态与 pending 文案不得在业务组件中重复声明。
- 书房目录必须覆盖旧版全局导航的核心能力。当前只有目录本身与唤醒伴星使用首页真实能力；其余需要独立页面的能力保留独立入口并显示明确的“新版页面尚未接入”说明，不打开旧 `TaskSurface`、占位页面或样本内容。
- 书房目录打开后建立模态焦点边界并阻止背景热点、伴星和沉浸控制响应；矮窗口中标题与关闭入口固定在目录顶部，正文独立滚动。
- 目录顶部数字来自 `/v2/learning-dashboard` 经主进程、IPC 与 preload 投影后的显式 section state；未知值显示为未知，不能当作 `0`。
- 个人中心、设置中心、主题、动效模式（Full / Lite / Off）、总静音与引导固定在右上角灵动岛；目录页眉只保留真实状态概览、总静音与关闭入口。系统 `prefers-reduced-motion: reduce` 仍具有最高优先级并解析为 Off。
- 未完成的学习运行与未完成的学习卡生成在“今天”组展示真实恢复状态；新版任务页接入前，点击只说明建设状态，不进入旧链路。
- 四个区域使用互不重叠且至少 `44px` 的真实 DOM 命中区，功能签条与目录项具备完整 Tab 顺序、`Enter` / `Space`、`3px` 焦点环与焦点恢复；hover 只在精细指针设备启用。
- 快捷键为 `Cmd/Ctrl+Enter` 今日下一步、`Cmd/Ctrl+K` 全局搜索、`R` 今日复习、`G` 理解星图；每个快捷键调用对应注册功能，忽略 `defaultPrevented`、输入控件和模态窗口。

### Task Surface

- 任务面是带纸纹的右侧语义化 `dialog`，进入时由右向左移动 `36px` 并淡入；标题、关闭、正文和主动作保持一致顺序。
- 打开后焦点进入关闭按钮，搜索面直接进入输入框；关闭后恢复到来源控件。`Esc` 返回房间。
- 研究册、学习卡、复习、搜索、星图和验证共享同一纸面骨架，但各自保留最少量的领域特征：横线纸、暖黄证据便签、卡片翻面、图形与列表等价表达、一次性验证印章。

### Buttons & Fields

- 主按钮是暖橙实底配**深墨文字**：`background: var(--hud-peach)`、`color: #3e2d22`、`border: 2px solid #af522c`、圆角 `17px 21px 16px 19px`、`0 5px 11px rgba(67,43,27,.16)` 柔影（`components/hud/hud-pages.css:152`，实测取值不是推理）。次按钮是同款形的奶油纸面；文字动作使用下划线。旧条目写的"浅色文字、`3px` 圆角"与母本相反，已按实测更正。
- **抬手与按压是一对，不许只写一半。** 母本 `.button` 同时给 `:hover{transform:translateY(-2px) scale(1.02)}` 与 `:active{transform:scale(.96);transition-duration:110ms}`（`hud-pages.css:159`（hover）与 `:160`（active））。任何自定义可按压控件都要把这一对补全，数值照抄母本、不自新一档；原先一条 transform 过渡都没有的，先补过渡再补 `:active`，否则 `scale` 是"跳"不是"按"。大纸块（整块即按钮的远征动作块）沿用母本幅度里较小的一档 `scale(.985)`，但 `transition-duration:110ms` 同样要成对。按压是否真的生效要在真引擎上按真鼠标逐帧读 `transform` 量（离线重放即可，读**目标及其祖先**，`:active` 挂在激活链上）。
- 输入框使用低对比纸面、细边界和可选横线纹理。聚焦时边界转暖橙；全局键盘焦点使用 `3px solid var(--focus)`，外偏移 `3px`。
- 禁用态保留文字可辨识度并降低透明度，不用动画或颜色作为唯一说明。

### Interaction, Motion & Sound

- `full` 房间聚焦约 `480ms`，`lite` 缩短过渡并停止循环；`off` 与 `prefers-reduced-motion` 即时完成状态转换。所有镜头 timeline 可取消，快速重复操作只保留最后一次。
- 首页导航严格经过 `wide → region → feature notice/catalog → region → wide`；`Esc` 按“说明纸面、目录、区域”顺序退出并恢复打开前的键盘焦点。
- 动效主要改变 `transform` 与 `opacity`。阅读、输入、任务打开、窗口隐藏或首次引导期间，环境层立即安静。
- 环境音在首次可信用户交互后淡入，静音偏好持久化；任务打开、窗口失焦或隐藏时暂停。声音失败只回到静音，不能阻塞画面或任务。
- 系统时间 `07:00–18:00` 为白昼；台灯只覆盖本次会话的日夜选择，下次启动重新跟随系统时间。
- `prefers-reduced-motion: reduce` 将动画与过渡压到 `1ms`，并由应用同步到动效模式；减少动效不等于自动静音。
- 验证印章只出现一次；跳过或声明暂时不会时不显示印章，不做庆祝。

### Companion Interaction Layer

伴星的日常操作收进一个稳定的交互台（`components/companion/CompanionHud.tsx`）：身份与页面上下文、功能夹、记录入口、录音、文字输入和发送共用一个 HUD 岛，不再散成多枚漂浮按钮。首页业务入口使用贴着交互台展开的纸质功能夹，禁止圆盘遮住角色；完整记录从右侧展开为纸质手记抽屉（`.companion-history`），禁止居中聊天弹窗与连续圆角聊天气泡。两者共用同一条真实会话（`app/companion-chat-session.tsx`）。

> **2026-09-22 文件名更正：** 本节原先点名的 `CompanionDock.tsx`、`CompanionActionMenu.tsx`、`CompanionChatDrawer.tsx`、`companion-dock.css`、`companion-chat-drawer.css` 在仓库里**都不存在**。交互台与历史抽屉的实现落在 `CompanionHud.tsx` + `companion-hud.css`；下面"玻璃"那一套的实现不在 `companion-hud.css`，而在 `components/hud/hud-surface.css` 的 `.companion-center` 作用域里（`--companion-glass`、`--companion-plate-border`、`backdrop-filter: blur(20px) saturate(1.18)`）。

分工是一条硬规则：**气球负责"她说了什么"，玻璃负责"你对她做什么"。**

- **气球**（`companion-bubble.css`）是动森式对话气球：奶油纸底 `var(--hud-cream)`（`#fff2cf`）平涂、`1px solid var(--hud-line)` 描边，外面用 `box-shadow: 0 0 0 3px rgba(255,252,235,.88)` 描一圈母本奶油环，再叠 `--hud-shadow-small`；圆角 `24px 27px 8px 24px`（右下角是"开口"那一侧），底部中央旋转 45° 的小方块尾巴指向角色头顶。**语气只有两档**：默认与 `--touch`（`--hud-butter` 暖黄，用于触碰/完成庆祝）；本文件以前写的"`#fff6e2` → `#fbeacb` 渐变 + 双描边 + 四档 cue/touch/page/reply"在代码里已经没有实现。可点击的念头邀请把定位权交给 `button.companion-cue-open`，气泡在那条链里转 `companion-bubble--static`。
- **玻璃**（`hud-surface.css` 的 `.companion-center` 段）是首页 HUD 岛同一套语言，全部走这一段自己的局部 token：底 `--companion-glass: rgba(11,33,48,.85)`、盘边 `--companion-plate-border: 3px solid rgba(255,252,235,.62)`（就是母本那圈奶油边，alpha 低一档）、模糊 `--companion-glass-blur: blur(20px) saturate(1.18)`、影 `--companion-plate-shadow`、圆角 `--companion-radius-plate`。局部 token 一律以 `--companion-*` 前缀限定在这段作用域内。**以前这句写的底是 `rgba(20,22,24,.7)`、"1px 暖白描边"、"薄荷 `#a8d59a` 主行动 / 蜜桃 `#ef9675` 录音中"——那三个色在 `.companion-center` 里一处都搜不到**：`#a8d59a` 早被 `--hud-mint` 取代，`#ef9675` 只是首页右上角灵动岛的"需要留意"状态灯（`home-v2.css:179`），跟录音无关。

**手记抽屉与快捷设置面板是第三种、有意留出的暖纸方言**（`companion-hud.css` 的 `.companion-history` / `.companion-hud__edge-panel`、`companion-chat-record.css`、`companion-run-trace.css`、`companion-proposal-choice.css`）。`hud-surface.css` 里对此有书面裁决：不去改 `companion-chat-record.css`，那是聊天记录的合同。这两个界面都 `createPortal` 到 `document.body`，取不到 `.companion-hud` 上的变量，所以**必须在各自的作用域里自带一份局部 token 表**，少一条就会静默失效。

**文本与语音同一条时间线。** 回复气泡的可视字数由真实播放进度驱动（`app/companion-voice-playback.ts` 每 80ms 广播一次 `visibleChars`）；音频播不了时（静音、未解锁、合成失败、被提示音抢走）退到阅读计时器 `estimateCompanionReadDurationMs`，推进同一个计数。两者任一时刻只有一条在走，所以文字不会和声音各说各话。没有出声就不显示朗读指示——不假装在出声。

**编排由 `data-phase` 一个属性驱动：** `idle → listening → transcribing → thinking → replying → idle`。交互台骨架在全部状态下保持稳定；不能编辑时保留输入位置、明确禁用并显示状态，不允许输入框突然收起成空白或麦克风残影。页面 starter 只显示在交互台的上下文行，不另起一张遮挡正文的浮动气泡。历史抽屉打开时交互台完整让位，Escape 按“功能夹 → 历史抽屉 → 交互台”分层关闭。

**语音闸门。** 环境音沿用 `shouldRunHomeV2Ambient`（含 `surfaceOpen`，任务页静默）；**用户主动发起**的对话语音走同一函数但不含 `surfaceOpen`——用户亲口问出来的回复是他主动要的反馈，不是“主动输出”，与 2026-09-16 裁决 3 同一条线。

### Media Degradation & Accessibility

- `full` 可使用获准的局部视频；`lite`、`off` 与 `prefers-reduced-motion` 保留静态 D0–D4 分层和完整任务操作，只有资产或 WebGL 失败才由同构图 poster 接管。媒体加载、解码或声音播放失败各自独立降级，不改变学习状态。
- 首屏 poster、主动作和任务内容不等待媒体。首次引导始终保留可见 DOM 文本、无声进入与跳过路径；仅在获批视频挂载时提供暂停控制。
- 跳转链接、真实按钮与字段、清晰的 `:focus-visible`、任务面焦点进入与返回、键盘快捷键和 `Esc` 关闭构成基础访问路径，不能依赖动画结束事件。
- 背景图、视频、音频与伴星使用 `aria-hidden`；理解星图同时提供图形描述和可操作节点列表，任何图形增强都不能替代 DOM 等价内容。

### Product Data Boundary

首页不使用本机样本。主任务、待复习数、进行中任务与恢复状态来自已认证工作区的 `RoomProjectionV1`；同工作区刷新失败时保留最近有效数据并标记降级，工作区切换立即清空。合同未提供的笔记、目标与待修补总数显示“—”，不能从有限样本推断为 `0`。伴星投影只返回档案摘要、记忆计数、限长提示与房间装备，永不返回原始记忆正文；房间档案按 `(workspace_id, user_id)` 隔离，解锁由真实里程碑单调产生，装备写入必须通过槽位、解锁、重复与 revision CAS 校验。内部能力统一使用 `loading / ready / context / pending / unavailable / error`，未迁入项不伪装可用。

## Do's and Don'ts

### Do:

- **Do** 复用现有字体栈、纸纹、阴影和视图预设；首页局部 token 必须限定在房间总览，并记录在本文件。
- **Do** 让房间承担方向感，让总控书桌承担发现与分流，让任务面承担阅读、输入、结果与错误恢复。
- **Do** 在任务开始后暂停环境声音，让内容成为唯一注意力中心。
- **Do** 保持 poster、DOM 文本、键盘路径和焦点恢复在所有媒体与动效模式下完整可用。
- **Do** 为 SVG / Canvas 图形提供等价的 DOM 标签或列表，并将纯装饰媒体设为 `aria-hidden`。

### Don't:

- **Don't** 在 V1 引入自由相机、轨道控制、第一人称漫游或 2D/3D 模式切换。
- **Don't** 把真实文字、题目、答案、进度、状态或关系数据烘焙进图片、视频或装饰 Canvas。
- **Don't** 自动播放环境声，或让声音、颜色、动效成为任何信息和反馈的唯一载体。
- **Don't** 在用户阅读、写作或答题时保留持续吸引注意力的环境表演。
- **Don't** 把当前样本内容描述为正式服务端数据、真实 AI 结果或持久化成功。
- **Don't** 在代码尚未声明并复用之前，向本文件添加新的颜色、字号、间距、圆角、阴影或动效 token。
