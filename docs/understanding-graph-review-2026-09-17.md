# 理解星图（Page 19 · 理解关系图）界面全面复查

- 复查日期：2026-09-17
- 复查对象：`apps/desktop-client/src/renderer/src/components/surfaces/graph-surface.tsx`、`graph-sky.ts`、页面样式 `components/hud/hud-pages.css:103` + `hud-surface.css:4662-5106`，服务端 `apps/api/src/modules/understanding-v3/topology-repository.ts`，合同 `packages/shared/src/understanding-topology-v3-contracts.ts`
- 复查范围：①功能完整性 ②数据真实性 ③交互与视觉 ④多数据场景
- 证据来源：源码逐行核对（前后端 + 契约 + IPC 网关）、既有单测、`apps/desktop-client/scripts/graph-verify/` 下 2026-09-17 的真机截图与 `result.json`、以及按 `graph-sky.ts` 确定性布局公式做的几何复算（`plotGraphStars` 为纯函数，坐标可离线复现）。

## 结论摘要

- 星图**不是**"只有占位逻辑"的页面：节点、边、计数、空态、错误态、截断提示都来自服务端真实投影，也没有本机伪造数据。真实拓扑接口 `GET /v3/understanding/topology` 已签发（`desktop-ipc-contracts.ts:415`、`desktop-ipc.ts:1414-1418`），页面已在 `TaskSurface.tsx:488` 接线。
- 但存在 **3 个严重问题**：目标节点详情串到"笔记"分支导致焦点卡显示错误信息、服务端把笔记新鲜度写死为 `current`（恒显示"与来源同步"）、以及三处入口仍宣称"理解星图正在迁移/未接入"与已实现的事实相反。
- 交互与视觉方面有 2 处可复现的排版缺陷（底部列表压住外环星、关系行标题溢出焦点卡）与 1 处设置不生效（应用内"动效：关"不影响星图动效）。
- 多数据场景：星图**没有分页**（`continuationToken` 恒为 `null`），因此不存在"首页/末页/越界跳页"问题；真实边界是服务端容量护栏 + 盘面座位上限 + 列表无窗口化，其中"筛选后空族无空态""hover 触发整页重渲染"是本次新发现的问题。

> **状态更新（2026-09-18）**：本文件前 19 项修复针对的是**旧的 DOM 星图 / 三栏工作台**实现。该实现已被整体替换为 Web 成熟版 Canvas 星图（`understanding-universe.tsx`），下面的"修复记录"随之成为历史证据。当前实现的移植与桌面适配记录见文末「Web 成熟版移植完成记录」。

---

## P0 — 严重（用户可见的错误信息 / 数据不实）

### 1. 目标节点的焦点卡走错分支：显示"笔记 · …"，且不显示目标主张

- **现象**：选中一个理解目标时，焦点卡第三行显示「笔记 · 旧来源待复核」（截图 `scripts/graph-verify/19-graph.png`：kicker 明明是「理解目标 · 学习中」，第三行却是「笔记 · 旧来源待复核」）。目标真正的 `publicSummary`（这条理解主张是什么）在整个页面**任何地方都不显示**。
- **根因**：`graphNodeSummary` 用 `"freshness" in node` 判断是否为笔记，但 objective 节点同样带 `freshness` 字段（`objectiveNodeProjectionV3Schema` 同时有 `freshness` 与 `personal`），所以目标节点永远命中 note 分支；其后的 `isObjectiveNode(node)` 分支对目标**永不可达**（死代码）。
- **位置**：
  - `apps/desktop-client/src/renderer/src/components/surfaces/graph-sky.ts:120-130`（`graphNodeSummary`）
  - `packages/shared/src/understanding-topology-v3-contracts.ts:73-93`（objective 带 `freshness`）
  - `packages/shared/src/learning-objective-surface-contracts.ts:143-150`（`fresh` / `source_outdated` / `legacy_unreviewed`）
- **附带风险**：`NOTE_FRESHNESS_LABEL`（`graph-sky.ts:109-115`）的键是 note 的枚举，不含 `fresh`。目标 freshness 为最常见的 `fresh` 时会裸出英文「笔记 · fresh」。
- **修复建议**：按 `nodeRef.kind` 显式分发（objective → `${graphObjectiveStateLabel(state)} · ${publicSummary}`；source → `modality`；note → `freshness`；evidence → `supportSummary`），顺序上先判 `isObjectiveNode(node)`。补一条 `graphNodeSummary(objectiveNode())` 的单测——当前 `graph-sky.test.ts:231-234` 只覆盖了"受限证据"这一条摘要分支，正好漏掉了目标。

### 2. 笔记新鲜度是写死的假值："与来源同步"恒真

- **现象**：星图上每条笔记的焦点卡都写「与来源同步」，包括来源已经更新过的笔记。
- **位置**：`apps/api/src/modules/understanding-v3/topology-repository.ts:171-178` —— note 节点构造里 `freshness: "current"` 是硬编码字面量，从未参与计算。
- **连带问题**：客户端 `graph-sky.ts:109-115` 的 `source_outdated` / `archived` / `legacy_unreviewed` 三个标签在该链路上永不可达；且注释写着"服务端实际会返回的第四个值"，与当前服务端实现相反（服务端从 `computeFreshness` 同款逻辑里只算了 objective 的 freshness，note 的没算）。
- **修复建议**：note 节点复用 `surface-service.computeFreshness`（比对 note origin 的 `noteVersionId` 与 `noteCurrentVersionById`）真实计算，或把契约收窄为只允许 `current` 并删掉三个死标签 + 修正注释。

### 3. 三个入口宣称"正在迁移"，与已实现的事实相反

- **现象**：星图页已实现且可经左侧目录栏"星图"chip 正常打开，但以下入口仍告诉用户它不可用：
  - `ActionRail.tsx:318` —— 书房目录里「理解星图 / 尚未迁移」并弹出"真实拓扑接口尚未进入当前桌面合同"（V1 分支可见，`App.tsx:158` `{HOME_V2_ENABLED ? null : <ActionRail />}`）
  - `HotspotLayer.tsx:156-159` —— 房间"星窗"热点 `data-hotspot-state="pending"`、文案「理解星图 · 待迁移」（V1 分支可见，`RoomStage.tsx:691`）
  - `App.tsx:135-141` —— V1 下按 `g`：只要当前不在 surface 上就提示"理解星图正在迁移"
  - `home-feature-registry.ts:119` —— `pendingTitle`/`pendingDetail` 与事实相反；该 id 在 `WIRED_HOME_FEATURE_IDS` 里（`:96`）所以 notice 不会显示，属死文案但会继续误导后续读者
- **修复建议**：V1 三处入口改为真实动作 `invoke("graph")`（热点同时改 `data-hotspot-state="ready"` 与 `aria-label`），删除或改写 registry 中的 pending 文案。

---

## P1 — 高

### 4. 底部"等价列表"浮层压住外环星与它们的标题

- **现象**：`.graph-sky` 占满内容区高度并垂直居中（1440×810 下约为 654×654 的正方形），而 `.graph-index` 是绝对定位于 `bottom:5px; max-height:150px` 的浮层，等于盖住内容区底部约 155px（盘面 y ≈ 76% 以下）。`.graph-index` 在 DOM 中位于盘面之后，直接盖在星星和标题上。
- **量化**：按 `GRAPH_FAMILIES`（半径 17/25/33/41%）与黄金角布点复算，满座（8/10/12/12）时约 **5–7 颗外环星**（笔记环 + 来源环的下半圈）落在被遮区间，其标题还会向下再挂 30px。截图 `19-graph.png` / `bottom-after.png` 中「界面链路自检 09:13:43」「间隔重复是一种学习策略…」正压在面板上沿。
- **连带**：`sky.hidden`（`graph-sky.ts:258-269`）只统计"没拿到座位"的节点，不统计"画了但被盖住"的节点，所以面板遮星这件事对读者完全无解释。
- **位置**：`hud-surface.css:4671-4685`（盘面）、`hud-pages.css:103`、`hud-surface.css:4955-4966`
- **修复建议**：盘面可用高度扣除面板实际高度（如 `min(calc(100cqh - 158px), 100cqw)`，或在 `.constellation` 上改用两行 grid 让面板占位而非浮层），并把该预算同步给 `plotGraphStars` 的容量/半径。

### 5. 星标题互相压字（固定 104px 宽，不随盘面缩放）

- **现象**：`.star-node span` 宽度写死 `104px`；黄金角布点给出的同环弦长在桌面档只有约 55–85px，标题必然互相覆盖。
- **量化**（复算，含标题框高度）：
  | 视口 | 盘面 | 最近两星距离 | 标题框相交组数 | 其中同族 |
  | --- | --- | --- | --- | --- |
  | 1440×810 | 654px | 57.0px | 28 | 10 |
  | 1280×720 | 564px | 49.1px | 39 | 11 |
  | 720×405（200% 缩放） | 325px | 28.3px | 84 | 19 |
  截图 `19-graph.png` 中「牛顿第二定律的公式」与「牛顿第二定律的公式表述」已经叠在一起；紧凑档（`hud-pages.css:157`）只把字号降到 5px、宽度仍是 104px，问题被放大。
- **位置**：`hud-surface.css:4758-4782`、`hud-pages.css:157`、`graph-sky.ts:149-270`
- **修复建议**：宽度改为随盘面缩放的 `clamp(56px, ...)`；把盘面尺寸传入布局，做"同环最小弦长 ≥ 标题宽"的容量收敛或奇偶错层；紧凑档单独给窄标题宽（并保持两行 clamp）。

### 6. 焦点卡的关系行标题向左溢出卡片

- **现象**：`.graph-focus__relations button span` 只有 `nowrap + ellipsis`，缺 `min-width: 0`，于是 span 拒绝收缩到内容宽度以下，按钮的 `max-width: 100%` 压不住它；卡片本身是 `text-align: right`，溢出方向朝左，长节点名直接画到卡片外的星空上。截图 `19-graph-source-filter.png` 可复现（关系行文字起点在卡片左边界之外约 100px）。
- **位置**：`hud-surface.css:4898-4922`
- **修复建议**：`button span { min-width: 0; flex: 1 1 auto; }`（或给 button 加 `overflow: hidden`），与 `.graph-index__member span` 的写法保持一致（`hud-surface.css:5048-5054`）。

### 7. 从星图跳出去以后没有"返回星图"

- **现象**：`GraphSurface` 没有注册 `returnTarget`，所以点「打开笔记 / 打开来源 / 打开目标详情」之后，左下角退回控件显示默认的"返回书房"，读者无法回到刚才的星图（也回不到刚才选中的星与筛选）。
- **对照**：`note-library-surface.tsx:206`、`source-library-surface.tsx:175`、`CardGenerationSurface.tsx:607` 都按同一约定注册了返回目标。
- **位置**：`graph-surface.tsx:220-232`（`nodeByRef`）、`App.tsx:155-159`
- **修复建议**：跳转前 `setReturnTarget({ label: "返回星图", run: () => invoke("graph") })`，并在组件卸载时 `setReturnTarget(null)`。

### 8. 星图动效无视应用内"动效"设置

- **现象**：星图只读操作系统的 `prefers-reduced-motion`（`graph-surface.tsx:146-154` + `hud-surface.css:4872-4875`），不读 room store 的 `motionMode`。用户在设置里把动效调到"关"之后，选中星的 26s 皇冠旋转（`hud-surface.css:4739`）与 56 颗尘埃闪烁（`:2259-2278`）照旧运行。
- **对照**：`[data-motion-mode="off"]` 的规则只覆盖了 `.content > *` 的入场动画（`hud-surface.css:114`）与个别组件；`styles.css:1263-1269` 也不是兜底规则。全仓没有"关动效即停所有装饰动画"的规则。
- **修复建议**：补一条 `.desktop-app[data-motion-mode="off"] .graph-orbits g.is-crown, .desktop-app[data-motion-mode="off"] .sky-dust circle { animation: none; }`；同时把组件内的 `reducedMotion` 本地 state 改为复用 store 的既有信号，避免两套判断。

### 9. hub 节点会同时跑几十条"流星"，没有上限

- **现象**：`draw.touchesSelected && !reducedMotion` 对**每一条**与选中节点相连的边都挂一个 `<animateMotion>` + `drop-shadow` 滤镜。边绘制有 90 条上限（`GRAPH_EDGE_DRAW_LIMIT`），流星没有。选中一个 50 条关系的高连接目标时，就是 50 个滤镜动画同时跑。
- **位置**：`graph-surface.tsx:346-354`
- **修复建议**：只给排序后的前 N 条（如 6 条）挂流星，其余保留静态高亮；或在 `degree` 超阈值时整体降级为静态。

---

## P2 — 中

### 10. 多数据：列表无窗口化 + 每次 hover 重渲染整页

- **现象**：等价列表一次渲染全部节点（容器仅 150px 高、`auto-fill minmax(210px,1fr)`）；`hoverKey` 是组件 state，鼠标滑过任意一颗星都会重渲染整页，连同 N 个列表按钮与 4 次 `nodes.filter(...)` 计数。服务端护栏允许单集合 5000 行（`topology-repository.ts:91`），节点量级上来后 hover 会明显掉帧。
- **位置**：`graph-surface.tsx:390-393`（hover）、`479`（每次渲染 4 次 filter）、`484-502`（全量 map）
- **修复建议**：hover 显隐交给 CSS `:hover`（用 `data-` 属性或相邻选择器驱动 tip），筛选计数用一次 `useMemo` 分桶；长列表做窗口化或"前 N 条 + 查看更多"。

### 11. 多数据：筛选到空族时没有空态

- **现象**：某族节点为 0（截图里"证据 0"）时，点该 chip 后成员区什么都不渲染，看起来像页面坏了。
- **位置**：`graph-surface.tsx:484-502`
- **修复建议**：`filtered.length === 0` 时输出一行 `.graph-index__note`："该族当前没有节点"。

### 12. 多数据：截断/隐藏文案的口径与当前筛选不一致

- **现象**：`sky.hidden` 与 `truncated` 都是全量口径，却渲染在按族筛选后的成员区里：只看"笔记"时读到"另有 5 个没画上星空"，会被理解为笔记的 5 个；`本次载入 {nodes.length} 个节点（服务端还有更多）` 同样是全量数字出现在局部上下文。
- **位置**：`graph-surface.tsx:503-512`
- **修复建议**：按当前筛选计算并写明口径，或把"服务端截断"提示移到面板 head 行（与总数并列），避免与筛选数字混淆。

### 13. 可达性：listbox 的键盘模型不成立

- **现象**：成员区声明 `role="listbox"` + `role="option"`，但没有 roving tabindex、没有方向键、没有 `aria-activedescendant`，每个节点都是一个 Tab 停靠点，节点多时键盘用户要按 N 次 Tab 才能穿过列表。
- **另一处**：星空的方向键（`onStarKeyDown`）只移动 DOM 焦点、不同步选中，而 `aria-pressed` 表达的是选中 —— 焦点与选中分离，键盘用户会以为已经选中了。
- **位置**：`graph-surface.tsx:240-251`、`483-502`
- **修复建议**：列表按 listbox 规范给 `tabIndex={isSelected ? 0 : -1}` + 方向键；星空的箭头键同步 `setExplicitKey`，或统一改为 roving tabindex + Enter 选中。

### 14. 交互不一致：同一次"点亮压暗星"的两个入口结果不同

- **现象**：在等价列表里点一个被筛选压暗的节点，会顺带清掉族筛选（`selectFromIndex`）；直接在星空上点同一颗被压暗的星，筛选保留，只换选中。同一个语义动作两种结果。
- **位置**：`graph-surface.tsx:263-269` 与 `:388`
- **修复建议**：星空点击也走 `selectFromIndex`。

### 15. 来源摘要重复标签且裸出契约枚举

- **现象**：来源节点的焦点卡出现两遍标题（h3 与摘要），摘要里是 `modality` 原始值（`web` / `text` / `code` / `markdown`），没有走项目已有的中文映射。
- **位置**：`graph-sky.ts:121`；可复用的映射见 `surface-data.tsx:284-292`（`formatSourceKindLabel`）
- **修复建议**：摘要改为不重复标题的信息（类别中文名 + 收录时间/片段数等真实字段）。

### 16. 同名节点在星图与列表里无法区分

- **现象**：笔记常与它的来源同名——截图 `19-graph.png` 中"间隔重复是一种学习策略…"同时出现在**来源**与**笔记**两族，标题一模一样，星图上只有形状/位置差别；等价列表里也只靠右侧 5px、`#7e99a4` 的小字区分。
- **位置**：`graph-surface.tsx:497-500`、`graph-sky.ts:139-145`
- **修复建议**：列表项加类别角标（提高对比度与字号），标题区可用"笔记 · xxx"前缀；或在 tip/焦点卡里补来源名（evidence 已有 `sourceLabel` 的先例）。

---

## P3 — 低（清理类）

### 17. 契约声明了但整条链路未实现的能力

`understanding.graph` 路由在 shared 契约里带 `objectiveId` 与 `lens: current_target | evidence | provenance | issues`（`desktop-ipc-contracts.ts:452-456`、`476-482`），但：没有调用方传参、`RoomIntent` 里没有对应字段（`room-machine.ts:48-64` 的 `"graph"` 无 payload）、页面也不消费。结果是"从目标详情跳到星图并聚焦该节点"做不出来，深链里的 `lens` 永远到不了 UI。按 `AGENTS.md` 的清理原则，要么实现、要么从契约移除（当前无真实调用方）。

### 18. 死字段 `mood`

`hud-pages.ts:52-64` 为每个页面声明了 `mood`（星图为 `"guide"`），全仓无消费方（`bubble`、`seat`、`number`、`plate`、`wide` 都有消费方）。建议删除，或真正接到伴星情绪上。

### 19. 次要打磨

- 焦点卡右边界（`right:22px`）与等价列表右边界（`right:16px`）差 6px，两块"右对齐"面板没有对齐。
- `.graph-index` 有自定义滚动条（`hud-surface.css:4968-4972`），`.graph-focus__relations` 没有，同一页两种滚动条外观。
- `graph-focus__more` 写"另有 N 条关系 · 见等价列表"，但等价列表并不按选中节点过滤或定位，读者需要自己在几十/几百条里找。

---

## 已核对、未发现问题的部分（避免误判）

- **无伪造数据**：页面没有任何本地生成节点/边/计数；空态、错误态、截断态都有真实来源与文案（`graph-surface.tsx:275-286`、`surface-data.tsx:28-85`）。
- **四个跳转动作都落地**：`open-notebook` / `open-source` / `open-objective` 的目标 surface 在 `TaskSurface.tsx:482-496` 均已接线；`activeSourceId` / `activeObjectiveId` / `activeNoteRef` 在 `room-store.ts:366-372` 被正确保留；`activeNoteRef.noteVersionId: null` 是契约允许的（`room-store.ts:80-85` 注明唯一消费方只按 noteId 读当前版本），不是缺陷。
- **盘面正方形契约成立**：`.graph-sky` 依赖 `@supports (container-type: size)` 分支拿到 `min(100cqh,100cqw)`，`.constellation` 已声明 `container-type: size`（`hud-surface.css:5102`），奇偶环在不同窗口下仍是圆。
- **星空上的星星本体不重叠**：复算最近两星距离 57px（桌面）/ 49px（1280×720）/ 28px（紧凑档），均大于 22px 按钮直径；问题只出在标题框（见 P1-5）。
- **无分页缺陷**：`continuationToken` 恒为 `null`（`topology-repository.ts:745`），服务端在护栏命中时返回可用子集并置 `integrity.truncated`（`:738-750`），客户端如实提示（`graph-surface.tsx:508-512`）。当前不存在"首页/末页/空页/越界跳页"问题；列表用原生滚动容器 + `overscroll-behavior: contain`（`hud-surface.css:4955-4966`），没有滚动穿透或无限加载竞争。
- **选中节点永远有座位**：`plotGraphStars` 的 `pinnedKey` 换座逻辑正确（`graph-sky.ts:227-234`），被挤掉的节点进入 `hiddenKeys` 并在列表里如实说明，不会出现"选中了却没有星"。被筛选压暗的星不会被隐藏（`is-muted` 只是降透明度），选中时无条件恢复不透明（`:4867-4870`）。
- **`prefers-reduced-motion` 覆盖到位**：皇冠、尘埃、tips 入场动画都有媒体查询兜底（`hud-surface.css:4872-4875`、`:2461-2463`），流星在 JS 侧也有开关。缺的只是"应用内动效设置"这一层（见 P1-8）。

---

## 建议修复顺序

1. P0-1（目标摘要串分支）+ 补单测 —— 一行分支顺序，影响所有目标节点，收益最大
2. P0-3（三处入口说"正在迁移"）—— 消除与事实相反的对外表述
3. P0-2（note freshness 写死）—— 数据真实性，需服务端计算，工作量中等
4. P1-6 / P1-7 / P1-4 / P1-5 —— 交接与排版，其中 P1-4、P1-5 需要把盘面尺寸纳入布局计算
5. P1-8 / P1-9 + P2-10 —— 一组动效与性能收敛，可合并成一次改动
6. P2-11..16、P3 —— 交互一致性与清理

---

## 修复记录（2026-09-17，全部 19 项已修复）

### P0

- **P0-1 目标摘要串分支**：`graph-sky.ts` 新增四个互斥键守卫（`isSourceNode`/`isNoteNode`/`isObjectiveNode`/`isEvidenceNode`，各键只属一个 kind：`modality`/`currentVersionId`/`personal`/`supportSummary`），`graphNodeSummary` 按守卫分发，objective 分支恢复可达并显示 `publicSummary`；删除 `NOTE_FRESHNESS_LABEL`。补齐 4 kind 摘要分发单测（`graph-sky.test.ts`）。
- **P0-2 note freshness 写死**：选择收窄契约而非伪造计算。`understanding-topology-v3-contracts.ts` 的 `noteNodeProjectionV3Schema` 移除 `freshness`、新增 `hasSource: z.boolean()`（数据模型没有按来源的内容修订，`source_outdated`/`archived` 无计算依据）；`topology-repository.ts` 改为真实值 `hasSource: note.sourceId !== null` 并纳入拓扑指纹。前端笔记摘要改为「已关联来源 / 手写笔记」。契约测试与 fixtures 同步更新。
- **P0-3 三处"正在迁移"**：`ActionRail.tsx` 目录项改 `state="ready"` + `invoke("graph")`；`HotspotLayer.tsx` 星窗热点改 `data-hotspot-state="ready"`、`aria-label="打开理解星图"`、`invoke("graph")`；`App.tsx` 的 `g` 快捷键改为无条件 `invoke("graph")`；`home-feature-registry.ts` 删除 `pendingTitle`/`pendingDetail` 死文案。

### P1

- **P1-4 列表压星**：`.constellation` 改纵向 flex，新增 `.graph-plate`（`flex:1 1 auto; container-type:size`）承接 `.graph-sky`；`.graph-index` 由绝对定位浮层改为占位流式布局（`position:relative; margin:6px 16px 5px`），不再遮挡任何星。
- **P1-5 标题压字**：`.star-node span` 宽度改 `clamp(52px, 17cqw, 104px)`，随盘面容器缩放。
- **P1-6 关系行溢出**：`.graph-focus__relations button span` 补 `min-width:0; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis`，滚动条样式与列表对齐。
- **P1-7 无返回星图**：`room-store.ts` 的 `invoke` 支持 `options.returnTo`（`noteReturnTo` 扩展 `"graph"`）；objective/source 跳转经 `returnTo: { label: "返回星图", run: () => invoke("graph") }`，note 跳转 `setNoteReturnTo("graph")` + `open-notebook`；`notebook-surface.tsx` 消费该返回目标显示「返回星图」。
- **P1-8 动效设置不生效**：组件移除本地 `matchMedia`，改读 store 的 `motionMode`/`reducedMotion`（经 `resolveSceneMotionMode`）；`<section data-motion-mode>` + CSS 按 `lite`/`off` 关闭皇冠旋转与尘埃闪烁。
- **P1-9 流星无上限**：仅 `touchesSelected` 边按排序取前 6 条挂 `<animateMotion>`，且只在 `motionMode === "full"` 时；其余保持静态高亮。

### P2

- **P2-10 hover 重渲染 + 无窗口化**：tooltip 改为纯 CSS（兄弟节点 `.sky-tip` 由 `:hover +`/`:focus-visible +` 显隐），星按钮不再挂指针/焦点事件；筛选计数收敛为一次 `familyCounts` useMemo；列表项 `content-visibility:auto; contain-intrinsic-size` 虚拟化。
- **P2-11 空族无空态**：`visibleNodes.length === 0` 时渲染「该族当前没有节点」空态行。
- **P2-12 截断口径不一致**：新增 `hiddenShown` 按当前筛选计算隐藏数，文案与筛选口径一致。
- **P2-13 键盘模型**：星空方向键同步 `setExplicitKey`（焦点即选中）；列表实现 listbox roving tabindex（`tabIndex={isActive?0:-1}`）+ Home/End/方向键，`graph-focus__more` 改为可聚焦按钮并聚焦首项。
- **P2-14 入口行为不一致**：星空点击改走 `selectFromIndex`（同样清筛选），两入口结果一致。
- **P2-15 来源摘要裸枚举**：新增 `SOURCE_MODALITY_LABEL` 中文映射（web/text/code/markdown），摘要改为「xx来源」，不再与 h3 重复。
- **P2-16 同名不可区分**：新增 `graphNodeShortId`（节点 id 前 4 位），同名节点的列表项与 tip 附加短 id 标识；`duplicateLabels` 集合驱动。

### P3

- **P3-17 契约死字段**：按 AGENTS.md 清理原则，从 `desktop-ipc-contracts.ts` 的 `workspaceRouteSchema` 与 `safeReturnTargetSchema` 移除 `understanding.graph` 的 `objectiveId`/`lens`（全仓零调用方，深链解析器未实现；`star_map` 的 lens 属另一契约不受影响）。
- **P3-18 死字段 mood**：删除 `hud-pages.ts` 的 `HudCompanionMood` 类型与全部 `mood` 声明/赋值。
- **P3-19 打磨**：焦点卡右边界对齐列表（`right:16px`）；`.graph-focus__relations` 补滚动条样式。

### 附带修复：陈旧的 shared 依赖拷贝

- `apps/api/node_modules/@ailearn/shared` 是安装时的实体拷贝（desktop-client 侧是符号链接），契约改动后仍是旧版。已替换为与 desktop-client 一致的符号链接（`ln -s ../../../../packages/shared`）。`workers/ai-worker` 下也存在同样拷贝，但其源码不消费 topology/desktop-ipc 契约，未处理。

### 回归验证

- `apps/desktop-client` `tsc --noEmit`（node + web 双配置）：通过
- `apps/api` `tsc --noEmit`：通过
- `packages/shared` `tsc --noEmit` + 全量 `node --test`：284/284 通过
- `graph-sky.test.ts` + `graph-surface.test.tsx`（vitest）：29/29 通过
- `apps/api` `topology-snapshot-cache/limit` 单测（node --test）：8/8 通过

---

## Web 成熟版移植完成记录（2026-09-18）

### 背景

星图页先后有两版尝试都不可用：旧 DOM 星图（全量星点 + 底部等价列表）第一眼无法阅读；随后一版"目标驱动三栏工作台"把星图的空间感整块删掉，等于退回后台界面。产品决定以 **Web 端成熟版 Understanding Universe** 为准重做本页，而不是继续修补任何一版 DOM 星图。

对应实现来源：`f89df77:apps/web/components/study/UnderstandingUniverse.tsx`、`apps/web/lib/understanding-graph.ts`、`apps/web/app/styles/understanding-graph.css`。

### 本轮完成的内容

**1. 移植落地**

- 新增 `components/surfaces/understanding-universe.tsx`（Canvas 引擎：缩放/平移/惯性/聚类 LOD/节点拖拽/键盘/触控）、`understanding-universe-data.ts`（布局与筛选）、`understanding-universe.css`（1:1 移植的样式，含桌面适配）。
- 重写 `graph-surface.tsx`：真实拓扑 → `UnderstandingGraph` 映射（objective→理解恒星、note→笔记星座、source→来源行星、evidence→证据卫星）、搜索、状态筛选、图层开关、详情抽屉、空/错/截断态。
- 保留全部既有跳转与返回约定：`open-objective` / `open-notebook` / `open-source` 都带「返回星图」。

**2. 桌面外壳适配（本轮的主要工作）**

- 页面改为 full-bleed（`HudPage page="graph" wide` + `.hud-surface.page-19 .content`）：Canvas 拥有整个窗口，目录栏、标题 chip、返回胶囊、伴星浮在其上，符合 Web 版"one environment, not a dashboard in a card"的原始意图。
- **删除重复标题**：外壳 chip 才是页面身份，Canvas 内重复的大标题/eyebrow 退场，实时读数移到图层控制条（`20 / 20 星体 · 7 理解恒星 · 0 证据卫星 · 4 真实光路`）。
- **伴星保留且不被抢位**：`seat: "left"` 不变，底部筛选坞在 `comp-left` 下右移让开角色；compact 窗口下同样让位。伴星台词改写为星图语义。
- **补全 Web 设计令牌**：`--motion-fast`/`--radius-sm`/`--radius-md`/`--font-mono`/`--color-focus-ring`/`--color-action-hover`/`--universe-accent`/`--mobile-nav-inset` 桌面端原先不存在，移植样式里 30 余处声明是无效的（无过渡、无焦点环）；现已全部定义。
- **底部 HUD 冲突**：图例不再半透明压在星名上；详情抽屉打开时图例让位（抽屉自身已重复所选星体的图例信息）。
- **compact 窗口**（外壳下限 720×405）：图例隐藏、图层次与筛选坞改为贴边网格并整体右移到伴星之后、缩放控件转竖排。

**3. 修掉的移植缺陷**

- **初始取景框住空图**：`ResizeObserver` 的首次 `resize` 早于拓扑到达，`fitViewport` 对空布局走 early-return，把视口留在「正中 + zoom 1」并消耗掉一次性 fit；真实节点随后只是被平移到这个错误视口里（实测 zoom 恒为 100%，右上角星体被画到画布外）。现在空布局不消耗那次 fit，并在用户尚未接管镜头前随布局签名变化重新取景（`viewportTouchedRef`）。
- **`fit()` 支持 HUD 安全区**：新增 `insets` 属性，`fitViewport` 按上/下 HUD 带预留空间，默认视图不再把星体或星名塞进搜索框与控制条底下。

**4. 删除的旧链路（按 AGENTS.md 清理原则）**

- `hud-surface.css`：旧 DOM 星图 + 三栏工作台 + `.understanding-starmap` 两段共约 1590 行死样式。
- `hud-pages.css`：`.constellation*`、`.graph-index*`、`.graph-focus*`、无作用域的 `.star-node*` 共 21 条规则。
- `graph-sky.ts`：删除已无调用方的 `pickDefaultSelection` / `compareBands`，并把 docstring 从"workbench/inspector"改回星图语义。
- `understanding-universe-data.ts`：删除无消费方的 `findGraphPath`、`getGraphNeighborhood`、`getGraphNeighbors`、`getSelectedPath`、`GraphDirection`、`GraphNeighborhoodOptions`、`GraphPath`（约 480 行）。
- 验证脚本：`verify-graph-live.mjs`、`verify-rail-graph-entry.mjs` 改断言新的 Canvas 星图。

**5. 清理过程中发现并修复的连带回归**

- 被删的无作用域 `.hud-surface .star-node` / `.star-node i` 同时是**伴星中心记忆星轨**（page 20）的定位与星体样式来源：删除后记忆星会竖排成一列、星点丢失尺寸与光晕。已把这部分声明改挂到实际的消费方 `.memory-field .star-node` 作用域下（含 compact 字号与 6px 星点），并把原因写进注释。

### 验证

证据截图：`apps/desktop-client/scripts/graph-verify/19-graph.png`（默认取景）、`19-graph-focused.png`（选中星体的详情抽屉）、`19-graph-compact.png`（720×405）、`page-companion-memory.png`（page 20 记忆星轨恢复）。

- `apps/desktop-client` `tsc --noEmit`（node + web 双配置）：通过
- `npm test`（vitest，99 文件）：763/764 通过；唯一失败是 `surface-data.test.tsx` 的跨零点日期断言（`今天 - 26h` 在午夜后变成「前天」），与本次改动无关，改动前同样失败。
- 实机（Electron + 真实 API/DB，1440×810）：`verify-graph-live.mjs` 无 console/page error，20 节点 4 关系全部取景，缩放到 100% 时星名完整可读。
- 实机 compact（720×405）：星图、筛选坞、图层条、缩放控件、伴星、返回胶囊互不遮挡。
- 实机 page 20（伴星中心）：记忆星轨定位与星点样式恢复正常。
- `npm run build`（含 `validate:room-layers`）：通过。
