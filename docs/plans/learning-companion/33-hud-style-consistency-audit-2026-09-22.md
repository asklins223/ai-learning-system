# 全站 HUD 语汇一致性审计（2026-09-22）

> 署名：Asklins
>
> 这份文档只谈一件事：**哪些界面没说动森 HUD 那套语汇，以及为什么它们看起来不像同一套。**
> 范围是 `apps/desktop-client` 渲染层的 21 个 CSS（22,387 行）与 112 个 `.tsx`。
>
> **方法与 30/31 不同，这里先说清楚：** 本轮是**静态审计**——读源码、跑 CSS 解析器、比对构建产物、跑一条仓库自带的守卫测试。**没有** CDP 逐屏量，**没有**截图。所以每条结论我都标了核对状态：
> - **✅ 已验** —— 我本人用命令复现过，命令附在 §1。
> - **◐ 代理报** —— 子审计员给出、我未逐条复算，方向可信但数字可能有偏差。
> - **✋ 待确认** —— 静态层面存在矛盾，必须真窗口才能定，见 §8。
>
> **本轮不动手实施。**

## 0. 一句话结论

扫下来最贵的东西不是"某处不好看"，而是**四处在源头上根本没生效**，而在 CSS diff 里完全看不出来：全站 HUD 的衬线体写着 `"Noto Serif SC"` **136 次**，可 `package.json:30-31` 只装了 `@fontsource-variable/*`，注册名是 `'Noto Serif SC Variable'` —— 于是 HUD 层的"纸上的声音"一直在用 **Songti SC** 渲染，而唯一写对了名字的 `approved-surfaces.css`（33 次）用的是另一个真字体，**两种衬线体同时在跑**；`objective-flow.css:25-26` 的夜间主题选择器写成 `.desktop-app[data-theme="night"] .hud-surface`，而 `App.tsx:193` 把这三个标识放在**同一个元素**上，后代选择器不可能成立，**14 条夜间 token 全死，入夜后目标链路仍穿日盘**；伴星快捷设置面板的局部 token 表补了 9 个变量、**恰好漏掉它唯一要用的 `--companion-mint`**，选中态与滑杆轨道静默消失；`styles.css:1050` 注释里 `.study-workbench*/` 那个 `*/` 提前闭合了注释，把紧随其后的 `.evidence-slip` 基规则整个吃掉（构建产物 0 命中）。修完这四个，"不像同一套"的观感会先掉一大截；剩下的才是真正需要一轮语汇收敛的：母本那条 `4px rgba(255,252,235,.78)` 奶油粗边全站只有 47 次，而 1px 细线有 188 次、1.5px 这种母本里根本不存在的宽度有 40 次；`3px solid var(--focus)` 这个 DESIGN.md:141 唯一规定的焦点环只有 7 处，其余是蓝、金、`#a95836`、`--log-focus`、`--gate-focus` 等 **20 多种写法**；`approved-surfaces.css:18-37` 还在 `:root` 上重抄了 18 个与 `--hud-*` **逐字节相同**的 `--v3-*`，构成第二真理源。另有约 2,200 行（`home-room.css` 83 类里 67 类无生产者、`home-room-life.css` 全死、`SurfaceCalibrator.tsx` 0 引用）按 AGENTS.md 应当**整条删除而不是改样式**。仓库自带的 `objective-flow-css-guard.test.ts` 实跑 **5 红 / 10 绿**，其中一条正是 §2 的 `data-outcome` 无人接手。

## 1. 怎么查的 / 怎么复现

工作目录 `apps/desktop-client/src/renderer/src`。

```bash
# A1 字体：注册名 vs 使用名（源 CSS）
grep -rho 'Noto Serif SC Variable' --include='*.css' . | wc -l   # 33  ← 注册了
grep -rhoE '"Noto Serif SC"'       --include='*.css' . | wc -l   # 136 ← 没有任何 @font-face
grep -rhoE '"Noto Sans SC"'        --include='*.css' . | wc -l   # 16  vs 'Noto Sans SC Variable' 26
grep -n fontsource package.json           # 只有 -variable 两个包
grep -n "@import"  src/renderer/src/styles.css | head -2

# A2 夜间选择器不可能匹配：全仓生产端只有一处 hud-surface，且与 desktop-app / data-theme 同元素
grep -rn "className=.*hud-surface" --include='*.tsx' . | grep -v test    # 只有 App.tsx:193
sed -n '192,195p' App.tsx

# A3 面板 token 表漏了 mint
sed -n '1818,1828p' components/companion/companion-hud.css | grep -c mint   # 0
grep -n -- "--companion-mint[a-z-]*:" components/companion/companion-hud.css
grep -rn "CompanionQuickSettings" components/companion/*.tsx                # 只在 :1532 面板内渲染

# A4 styles.css 注释边界（逐字符扫描，不依赖任何 CSS 解析器）
node -e '/* 见 §9 脚本；输出：注释块 1036->1050、2067->2421 */'
EB=../../../packages/shared/node_modules/.bin/esbuild
$EB < styles.css   # 1050:58 Unexpected "*"；产物 62,859B vs 源 77,889B；evidence-slip/surface-calibrator 0 命中
grep -c "evidence-slip{grid-column" ../../out/renderer/assets/index-*.css   # 0 ← 构建产物同判

# A5/A6/B
grep -n -- "--hud-green:" components/hud/hud-pages.css      # 16 与 20，两个值
grep -c "data-outcome" $(find . -name '*.css')              # 全 0
grep -rn "data-outcome" components/surfaces/learning-run-surface.tsx   # :2252 在发
npx vitest run src/main/objective-flow-css-guard.test.ts    # 5 failed | 10 passed
```

**样本与口径**：CSS 统计一律按**出现次数**（不是行数）计；`border` 宽度、`outline` 颜色、`rgba(255,25x,2xx)` 奶油边基色都从 `--include='*.css'` 全量提取消除空格后归并。**没有**把 `project-archive/`、`reference-projects/`、`node_modules/`、`.impeccable/` 计入。

## 2. A 组：不是审美问题，是坏了

### A1 ✅ HUD 的衬线体从来没注册过，"纸上的声音"其实是宋体

- **现象**：源 CSS 里 `"Noto Serif SC"` 出现 **136 次**，`"Noto Sans SC"` **16 次**。`package.json:30-31` 只有 `@fontsource-variable/noto-sans-sc` 与 `@fontsource-variable/noto-serif-sc`，`styles.css:1-2` 也确实是 import 这两个；它们注册的族名是带 `Variable` 后缀的。
- **分布**（serif 未注册名 / 注册名）：`hud-surface.css` 48/0、`hud-pages.css` 46/0、`objective-flow.css` 24/0、`study-surface.css` 11/0、`source-intake.css` 2/0、`hud-controls.css` 1/0、`desktop-access-gate.css` 3/3、`approved-surfaces.css` 0/17、`styles.css` 0/6、`home-v2.css` 0/5、`home-room.css` 0/2。
- **为什么算问题**：这是"页面之间说不出来地不像"的字面来源。**HUD 母本层（94 处）全部掉到 `"Songti SC"`**，而 `approved-surfaces.css` 与 `styles.css` 渲染真的 Noto Serif。`DESIGN.md:58` 把 `"Noto Serif SC", "Songti SC", serif` 写成合同，所以这个错是从文档一路抄进代码的——**文档本身也不知道那个名字没有字面**。
- **修法**：一次性把 `"Noto Serif SC"` → `"Noto Serif SC Variable"`、`"Noto Sans SC"` → `"Noto Sans SC Variable"`。母本 `hud-pages.css` 是生成文件，要改 `.impeccable/review/desktop-pages-v3/mockup.html` 再跑 `scripts/port-hud-css.mjs`，否则下次重新生成又回去。DESIGN.md:58 同步改。
- **验收**：`grep -rE '"Noto (Serif|Sans) SC"' --include='*.css' .` 归零；真窗口用 `document.fonts.check('16px "Noto Serif SC Variable"')` 与一处标题的 `getComputedStyle(...).fontFamily` 对齐。

### A2 ✅ 目标链路的夜间主题永远不匹配，入夜仍穿日盘

- **现象**：`objective-flow.css:25-26` 是 `.desktop-app[data-theme="night"] .hud-surface, .desktop-app[data-theme="dark"] .hud-surface { ... }`，内含 **14 条** `--quest-*` 夜间赋值。`App.tsx:192-194` 同一个 div 上既有 `className="desktop-app hud-surface…"` 又有 `data-theme={theme}`；全仓 `.hud-surface` 的 className **只有这一处生产端**（其余命中都在测试里）。后代选择器要求 `.hud-surface` 是 `.desktop-app` 的后代，**不可能成立**。
- **佐证**：同一个文件在 `:274`、`:557` 已经用了正确的拼接写法 `.desktop-app.hud-surface.page-16`，所以这是漏改不是设计。测试里 `<div className="desktop-app hud-surface">` 恰好**同时**给了两个类，所以测试永远发现不了。
- **修法**：改成 `.desktop-app.hud-surface[data-theme="night"]`（与 `:274` 同形）。
- **验收**：夜间切到目标列表/详情/结算三屏，`--quest-ink` 的 computed 值应为 `#f8ecd2` 而不是日盘值。

### A3 ✅ 伴星快捷设置面板漏了它唯一要用的两个 token，选中态不显示

- **现象**：`companion-hud.css:1818-1828` 为 portal 出去的 `.companion-hud__edge-panel` 局部补了 9 个 `--companion-*`，**没有 `--companion-mint` / `--companion-mint-strong`**（它们只定义在 `:1-5` 的 `.companion-hud` 和 `:1078-1079` 的 `.companion-history`，两者都不是这个面板的祖先）。面板内的消费点：`:986-988`（`button[aria-pressed="true"]` 芯片选中）、`:1031-1032`（开关 ON）、`:942-946`（滑杆已填充轨道，整条 `background` 声明作废）、`:954`（滑块描边）、`:886`（权限说明左边框）。`CompanionQuickSettings` 只在 `CompanionHud.tsx:1532` 渲染，正好全在这个面板里。
- **讽刺点**：`companion-hud.css:1083` 的注释自己写着「抽屉是 portal 到 body 的，拿不到 `.companion-hud` 那套变量……否则 `var()` 会静默退化成"没有这条声明"」——同一份代码在隔壁面板违反了这条注释。
- **修法**：给 `:1819-1827` 补两行；根治办法见 §7 批次 0 的「把 `--hud-*` 提到 `:root`」。
- **验收**：打开伴星设置，切一个模型芯片，`getComputedStyle(chip).backgroundColor` 不得等于未选中态。

### A4a ✅ `styles.css:1050` 的注释提前闭合，`.evidence-slip` 基规则被吃掉

- **现象**：`:1036` 开了一段清理说明注释，本该在 `:1055` 闭合；但 `:1050` 正文里写着 `.study-workbench*/.study-notebook*/.review-workbench*/`，其中的 `*/` **在行中就闭合了注释**。逐字符扫描给出「注释块 1036 → 1050」，esbuild 直接报 `styles.css:1050:58 Unexpected "*"`。
- **后果**：从 `:1050` 剩余文本到 `:1057` 的 `{` 之间那段中文被当成**选择器前导**解析，整条规则被丢弃 —— **`.evidence-slip`（`:1057-1066`，`grid-column:2; background:#e7dca9; border-radius:3px 10px 4px 4px`）从不生效**。子规则 `.evidence-slip strong/p/button`（`:1068-1070`）反而活着，于是往 HUD 便签上漏样式（见 B6）。构建产物同判：`grep -c "evidence-slip{grid-column"` = **0**。
- **附带损害**：那段中文里点名的 `.study-notebook`、`.review-ledger`、`.day-route`、`.queue-desk` 会被任何死代码扫描当成"有定义"，污染后续清理判断。
- **修法**：把 `:1050` 的 `.study-workbench*/` 写成 `.study-workbench 等/`，或整段注释重述。

### A4b ✋ `styles.css:2067` 未闭合注释 —— 静态层面自相矛盾，必须真窗口定

- **已确证的部分**：`:2067` 那句 `/* The page is visibly bowed, …` 确实**没有闭合**，逐字符扫描的下一个 `*/` 落在 `:2421`，也就是说 `:2067–2421` 共约 355 行在注释体内，其中包括 `:2071-2073` 的校准调试开关 `html[data-surface-calibration-base="false"] :is(...)` 和 `:2075-2378` 的整套 `.surface-calibrator`。
- **矛盾的部分**：esbuild 与字节扫描都判"吞掉"（esbuild 产物里 `surface-calibrator` **0 命中**，输出 62,859B / 源 77,889B）；但 **Vite 实际构建产物留着它**（`out/renderer/assets/index-BIkSBoWN.css:13190`、`:13194`），PostCSS 也留着。也就是说**两条 CSS 管线对这个未闭合注释的容错不同**。
- **所以我不写成"坏了"**，写成一条**可移植性地雷**：这份文件目前在 esbuild 管线下会静默掉 355 行。真窗口一测便知（`getComputedStyle(document.querySelector('.surface-calibrator__handle')).position` 应为 `absolute`，以及把 `data-surface-calibration-base` 翻成 `false` 时深度层是否真的隐藏）。
- **实际代价低**：唯一消费者 `scene/SurfaceCalibrator.tsx` **0 个引用者**（✅ 已验），`approved-surfaces.css:366` 还把它的 launcher `display:none !important` 压着。按 AGENTS.md 整条删掉，这个雷连根消失。

### A5 ✅ 母本自己定义了两次 `--hud-green`

`hud-pages.css:16` 是 `#556c55`，`:20` 又写 `#66816a`，同一个 `.hud-surface` 块内，后者胜。前者被 `approved-surfaces.css:27` 原样抄成**活着的** `--v3-green` —— 所以这两支绿都在渲染。修法在 mockup 源，不在生成文件。

### A6 ✅ `data-outcome` 没有任何 CSS 接手；仓库守卫已经为此发红

- `learning-run-surface.tsx:2252` 发出 `data-outcome`（7 个取值）+ `data-tone` + `data-acknowledgement`；全仓 CSS 对 `data-outcome` **0 命中**。结果「已理解」与「无法评估」是同一张纸。
- **仓库自带的漂移探测器已经知道**：`npx vitest run src/main/objective-flow-css-guard.test.ts` → **5 failed | 10 passed**。红的五条是：`data-outcome` 接手数 `<3`、`@keyframes objective-seal-press` 找不到、压印未挂在 `data-acknowledgement`、chip 容器缺 `border-radius:0`、`.v3-objective-tags span` 无字号地板。
- 这条已在 `31-objective-flow-ui-review` 的 P2 立案，**本文不重复设计方案**，只把它记作"动 HUD 语汇时必须同批让这 5 条转绿"的验收闸门。

## 3. B 组：同一个概念有多套值（语汇漂移主体）

> 母本 = `hud-pages.css`（由 `.impeccable/review/desktop-pages-v3/mockup.html` 生成）。

### B1 ✅ 卡片描边：母本的粗奶油边只占三分之一

| 写法 | 次数 | 判定 |
|---|---|---|
| `rgba(255,252,235,…)` | **47** | 母本色 ✅ |
| `rgba(255,255,255,…)` | 20 | 纯中性白，未暖化 |
| 其余 24 种近白三元组 | 各 1–6 | `255,249,237` / `255,250,229` / `255,244,226` / `255,252,236` / `255,252,233` / `255,250,230` / `255,249,224` … |

**边框宽度分布**：`1px` **188**、`2px` 42、**`1.5px` 40**、`3px` 28、`4px` 22。母本的卡片语法是 3–4px，实际 1px 细线是它四倍；`1.5px` 这个亚像素宽度**母本里完全不存在**，主要长在伴星那一侧（`companion-hud.css` 17 处、`companion-chat-record.css` 等）。

### B2 ✅ 焦点环：DESIGN.md:141 只规定了一种，实际在跑 20+ 种

| 焦点环 | 次数 |
|---|---|
| `3px solid var(--focus)`（合同） | **7** |
| `2px solid rgba(57,103,132,.5)`（临时蓝） | 7 |
| `3px solid rgba(255,241,168,.72)`（金） | 4 |
| `3px solid var(--log-focus)`（`#b85a31`，页 14 私设） | 3 |
| `3px solid var(--gate-focus)`（`#8f3518`/`#285d66`/`#83d8e7`） | 3 |
| `3px solid rgba(57,103,132,.38)` / `.42` | 4 |
| `3px solid #a95836` | 3 |
| `3px solid #fff1a8` | 2 |
| 其余（`--home-v2-focus` `--color-focus-ring` `--accent-deep` `#ffc17f` `#78cddc` `rgba(175,82,44,…)` `rgba(131,216,231,.5)` `--sage-deep` …） | 各 1 |

`outline-offset` 也在飘：`3px` 23 次、**`2px` 18 次**、`1px` 3 次、`4px` 1 次。谁记得给某个控件单独写环，谁就换一种颜色；没写到的控件退回全局 3px 锈红 —— **环长什么样取决于有没有人记得写过它**。

### B3 ✅ 阴影：四套并存，两种层数

母本是双层 `--hud-shadow` / `--hud-shadow-small`（基色 `rgba(46,27,16)` / `rgba(43,27,17)`）。同时在跑的还有：`--quest-shadow`（`objective-flow.css:20-21`，**单层** `rgba(63,51,36)`）、`--v3-shadow`（`approved-surfaces.css:206,240` 用在卡片上，是 V3.1 已经弃用的 60px 重影）、`study-surface.css:137,313,733` 三个自定 `0 5–7px` 单层、伴星 `--companion-shadow`（`rgba(91,62,39)` 单层）、门禁夜间**纯黑** `rgba(0,0,0)`。

### B4 ✅ 控件母本没被复用

◐ 子审计统计：按钮 13 种、开关 4 种、标签 3 种、输入框 4 种。其中确有实锤的三处：
- **按钮**：母本 `.hud-surface .button`（`2px` + `17px 21px 16px 19px` + `--hud-cream` + hover `translateY(-2px) scale(1.02)` + active `scale(.96)`）之外，存在 `border:0`、`1px`、`1.5px`、`999px` 胶囊、`50%` 圆盘、`border-radius:8px` 方盒等写法，且**多数没有按压缩感**。
- **开关**：母本 `.switch`（42×24 / `#cbb99b` / 旋钮 `#fff8e8` / ON `#789177`）；另有原生 `accent-color` 复选框、`objective-flow.css:341` 手绘 24×24 单选、`companion-hud.css:1003` 又一个 42×24 但 `999px`+`rgba(201,164,126,.3)`。同尺寸、不同语法。
- **标签**：母本 `.tag`（`11px 14px 10px 13px` / butter / 9px / 750）；另有 `999px` 胶囊 12px/800，和 `approved-surfaces.css:246` 的 `#e6d3ad` 底 **8px** 字（守卫第 5 条红就是它）。

### B5 ✅ 主按钮极性反了 / 最淡

母本是**浅蜜桃底 + 深墨字 + 白 text-shadow**（`.button.primary`）。
- `desktop-access-gate.css:809-826`：深赭底 `--gate-action #bd542c` + 近白字 —— **反极性**。
- `companion-proposal-choice.css:115-118`：「接受」这颗卡上唯一的主动词，是 `rgba(205,235,217,.76)` 最淡的一档，且 `:126-134` 只有 hover 换底色、**没有 `:active`**。

### B6 ✅ 一个第二真理源：`approved-surfaces.css:18-37`

在 `:root` 上重抄了 **18 个 `--v3-*`**，其中 **17 个与 `--hud-*` 逐字节相同**（第 18 个 `--v3-green #556c55` 恰好等于 A5 里那条**已被覆盖的死值**）。后果：母本任何修正都不传导过去，反之亦然。AGENTS.md 明确不该为这种旧别名保留兼容层。

### B7 ✅ 抖动圆角只有一半

母本的识别度在**双轴斜杠**：`31px 42px 29px 38px/35px 30px 43px 31px`。`approved-surfaces.css:206,240` 抄成 `31px 42px 29px 38px` —— **把 `/` 后面那一半丢了**，手工感就没了。另一侧 `study-surface.css`、`objective-flow.css:470,349`、`home-v2.css:622,687,1068` 仍在使用纯 `8px/12px/18px` 等均匀圆角。

### B8 ✅ 降级只做了半套

| 文件 | `data-motion-mode="off"` | `prefers-reduced-motion` |
|---|---|---|
| `approved-surfaces.css` / `desktop-access-gate.css` / `hud-controls.css` / `study-surface.css` / `understanding-universe.css` | **0** | 各有 1–2 |
| `home-room.css` / `home-room-life.css` | 15 / 5 | **0** |

即：五个文件没做 Off 档，两个文件反过来没做系统 reduce 档。DESIGN.md:127/146 要求两条都对等完成。两个具体后果：**`approved-surfaces.css:177` 的 `v3-spin 1.2s infinite` 在 `:558` 的 reduce 分支下被改成 `1ms`，等于每秒转 1000 圈而不是停下**；`study-surface.css:105,332` 两个 spinner 在 Off 档继续转。伴星侧 `companion-hud.css:1747`、`:1893` 两条 off 规则因 portal 拿不到 `.desktop-app` 祖先，是**死选择器**（同文件 off 计数 19 里含这两条）。

### B9 ✅ 冷色泄漏到不该去的地方

Warm-First Rule（DESIGN.md:52）把蓝青限给伴星、星图、夜间冷光。以下不在豁免内：
- `study-surface.css:482-488` 日志节点用 `#3b6a8f`、`#3f7d8a`，且七个 kind 色全部硬编、无 token。
- `objective-flow.css` 的 `--quest-water` 一族（`:12,13` + 夜间）在目标页撑起**整套额外冷色**。
- `understanding-universe.css:2096` 把深色岛上的冷纳阴影 `rgba(0,12,24,.2)` 原样搬到奶油纸上。
- **最能说明问题的一处**：`hud-surface.css:483-499` 首页左下角那颗岛，**收起态暖黑 `rgba(42,31,24,.9)`、展开态冷黑 `rgba(20,22,24,.74)`**，同一组件两个色温；`:419` 展开时还丢掉 `--hud-shadow-small` 换成自定阴影，`:603` 主操作用 `rgba(113,167,134,.24)`  muddy 绿纱，而母本在深色岛上标"当前"用的是**浅色板**（`#f3dfb1` / `--hud-butter`）。

## 4. C 组：整块界面根本没说 HUD 语汇

### C1 ✅ `desktop-access-gate.css`（1,278 行，活的，且就在 `.hud-surface` 里）

`var(--hud-*)` **0 次**、4px 奶油边 **0 次**、抖动圆角 **0 次**、`hud-pop` **0 次**、`.button` 复用 **0 次**。`App.tsx:219` 把它挂在 `.hud-surface` 之下，所以它是**能**继承母本的，只是没有。它带着**三套各 26 token 的 `--gate-*` 表**（日/昏/夜），其中 `--gate-ease-standard: cubic-bezier(0.23,1,0.32,1)` 与 `--hud-ease-out` **逐字节相同**，`--gate-focus: #8f3518` 等于 DESIGN.md:46 文档值而**不等于代码里的 `--focus: #9a351d`**。整体仍停在 V2 的切角家族（`3px 14px 3px 3px`、`2px 9px 2px 2px`）。夜间阴影用**纯黑**。`--gate-*` 在 DESIGN.md 里**完全没有登记**（文档 `:48` 只登记 `--home-*`，`:161` 只登记 `--dock-*`/`--chat-*`），而 `:184`/`:197` 要求先登记再用。
> 昏（dusk）那一档的**理由**是正当的：两主题母本没给"第三个场景"留位置。该修的是它用**整套替换**表达了本该是"对 `--hud-*` 打一个 delta"的东西。

### C2 ✅ `home-v2.css` 的目录与建设说明弹窗

`:737` 全屏目录 `border:1px`、`:1022-1028` 唯一模态框 1px + 自定 `rgba(28,17,11)` 阴影、`:1061-1071` 按钮 `border-radius:8px`（正撞 `hud-surface.css:2607` 自己写下的"44px 高的东西用 8–14px 圆角读起来就是方盒"）、`:1073` 主按钮 `#526e61` 深绿底。焦点环在同一文件里有**三种**（`#fff1a8` / `--home-v2-focus #fff3b0` / `#a95836`）。
> 同时要给这文件记一笔：它是**本簇里唯一两条降级都做了**的（`home-v2.css:1245` + `:1259-1264`），还额外有 `prefers-reduced-transparency` 和 `prefers-contrast`，比母本层做得全。

### C3 ✅ `study-surface.css`（页 14）没有夜间分支

`grep '.night'` 与 `grep 'data-theme'` 均 **0 命中**，违反 Registered Pair Rule（DESIGN.md:54）。`:16` 的注释却声称已按"日间 `#f1e3c8` / 夜间 `#fff2cf`"核对过。

## 5. D 组：死代码 —— 按 AGENTS.md 该删而不是改

- ◐ `home-room.css`：83 个类钩子里 **67 个没有 JSX 生产者**（`.hotspot*`、`.home-command-deck`、`.rail-action*`、`.home-catalog*`、`.companion-whisper*`、`.companion-scale-control`…）；活的只剩 `.companion-presence[data-surface="room"]` 那几条几何，且被 `home-v2.css:49-83` 更高特异度盖掉。
- ✅ `home-room-life.css`：无生产者，且 `home-v2.css:39-47` 用 `display:none !important` 压着（`data-home-scene-variant="v2"` 由 `App.tsx:201` 硬编）。连同 `main.tsx:7` 的 import 一起删。
- ✅ `SurfaceCalibrator.tsx`：**0 个引用者**。连带 A4b 那 355 行歧义区域一起消失。
- ◐ `styles.css`：176 条规则无生产者（四代 `.task-surface__header`、`.action-rail`、`.hotspot*`、`.companion-whisper*`、`.card-editor`、`.scene-status`）、17 个空 `@media`、以及**自相矛盾的两遍自己**（`.run-*` 在 `:1385-1465` 与 `:2512-2544`）。
- ✅ **结构性根因**：`WorkspaceLibrarySurface.tsx:435,511,630,631` 在**同一个节点上挂了两代 class**（`v3-goal-focus objective-expedition__focus`），28 个类名在 `approved-surfaces.css` 与 `objective-flow.css` **各定义一次**。因为 `objective-flow` 带 `.hud-surface` 前缀而 `approved-surfaces` 不带，最终长相是**逐属性撞出来的** —— 它重声明哪条属性就听它的，漏掉的属性仍从旧皮肤漏下来。这不是配色问题，是"为什么这两页看起来不是一家"的机制。

## 6. E 组：`DESIGN.md` 自己是过期的那一份

- §Companion Interaction Layer 点名的 `companion-dock.css`、`companion-chat-drawer.css`、`CompanionDock.tsx`、`CompanionActionMenu.tsx`、`CompanionChatDrawer.tsx` **仓库里都不存在**。玻璃语汇实际长在 `hud-surface.css:2583-2649`（`--companion-glass`、`blur(20px) saturate(1.18)`）。而 `hud-surface.css:6821-6823` 白纸黑字裁决过「不去改 `companion-chat-record.css`，那是聊天记录的合同」。**所以伴星侧的暖纸方言是有案可查的第二语言，不算漂移；过期的是文档。**
- §Colors 表里的 `--accent-strong`、`--scene-control`、`--scene-text`、`--shadow-lg`、`--shadow-md` **在代码里没有这些 token 名**（代码是 `--accent-deep`、`--glass-*`、`--paper-shadow`、`--soft-shadow`）。文档 `--focus #8f3518` vs 代码 `#9a351d`；文档 `--ink #2e221b` vs 代码 `#30231a`；文档 `--star #72c6db` vs 代码 `#73cadc` vs 母本 `#79cedc`（三支）；文档 `--paper #f5ead5` 与母本一致而 `styles.css` 是 `#f7ecd5`。
- §58 把 `"Noto Serif SC"` 写成合同 —— 正是 A1 的源头。

## 7. 批次计划（顺序 = 修完一步能看清下一步）

| 批次 | 内容 | 为什么这个顺序 | 完成判据 |
|---|---|---|---|
| **0 前置** | 把 `--hud-*` 从 `.hud-surface` 提到 `:root`（伴星两处 body portal 是刚需，A3 是症状） | 不做这步，A3 只能靠再补一张局部表续命，B6 也永远有理由存在 | 两处 portal 子树内 `var(--hud-cream)` computed 非空 |
| **1 只修"坏"** | A1 字体名、A2 夜间选择器、A4a 注释、A3 mint | 四处都是一~二行、零设计决策、且各自遮住一片后续判断 | 三条 grep 归零 + 夜间 computed 正确 |
| **2 让守卫说话** | A6（`data-outcome` 三档接手）+ A5 + B4 里守卫点到的两条 | 这是唯一现成的漂移探测器，跑绿之前后面每一步都没有裁判 | `objective-flow-css-guard` 15/15 绿 |
| **3 拆第二真理源** | B6 删 `--v3-*` 全部指向 `--hud-*`；D 的 `WorkspaceLibrarySurface` 双 class 收一代 | 不留这个，任何后续统一都会在两代之间重新裂开 | `grep -c 'var(--v3-'` = 0 |
| **4 语汇收敛** | B1 描边、B3 阴影、B2 焦点环、B7 圆角、B9 冷色 | 这些是纯机械的"多→一"，可以按文件分小批、每批量一次 | 三项统计各自收敛到 1 个值：`rgba(255,252,235,…)` 之外归零、双层阴影 token 化、`3px var(--focus)` 独存 |
| **5 控件收编** | B4 按钮/开关/标签/输入 + B5 主按钮极性 + B8 降级补全 | 控件的改动会覆盖 4 章的数值，放后面避免返工 | 四种控件各只有 1 个母本实现；off/reduce 两栏都不再是 0 |
| **6 整块接入** | C1 门禁、C2 home-v2 弹窗、C3 页 14 夜间 | 三块都是整屏改动，放最后单独验收 | 三文件 `var(--hud-*)` 非零且夜间与日间同构图 |
| **7 删死链** | D 全部 + A4b 随 `SurfaceCalibrator` 一起消失 | 前面几步会反复要读这些文件，早删少读；但也**必须**等确认没有隐藏引用之后再删 | 受影响模块 typecheck + 测试全绿 |
| **8 回写文档** | §6 全部（DESIGN.md 改名、登记 `--gate-*` 或取消它、字体合同、`--focus` 真值） | 文档最后写，才有权威值可抄 | DESIGN.md 里每个 token 名与每个色值都能在代码里 grep 到 |

## 8. ✋ 静态层面定不下来、需要真窗口的

1. **A4b**：`styles.css:2067` 未闭合注释，esbuild 吞 / PostCSS+构建产物留 —— 浏览器实际拿到哪一份要实测。
2. **A1 的视觉后果**：未注册族名到底掉到 Songti 还是别的，需要真窗口 `document.fonts.check` + 一处标题 computed。
3. **B2**：焦点环按特异度撞完之后**每个控件**实际是什么色，只能逐控件量。
4. **◐ 全部计数**：本轮所有统计都是**源码出现次数**，不等于"浏览器实际生效次数"；B4 的"按钮 13 种 / 开关 4 种"来自子审计，我只复核了其中三处。
5. **D 的删除安全性**：67 个"无生产者"类名是按 className/classList 上下文判的，`querySelector` 字符串与运行时拼接可能漏判 —— 删之前要按 AGENTS.md 复核引用点。
6. **`image-lightbox--card`**：portal 之后 `border-radius: inherit` 与 `position:absolute; inset:0` 改读 `body` 几何，注释里那句"遮罩只盖住最近的定位卡片"可能已经作废。要量一次盒尺寸。

## 9. 我自己被推翻的一个判断

我最初假设：**portal 到 `document.body` 的组件会掉 `.hud-surface` 的 `--hud-*` token，所以样式静默丢失。**

一半不成立，已核清：**`DirectoryRail.tsx:418-420` 与 `HomeV2ObjectLayer.tsx:194-196` 都是 `document.querySelector(".desktop-app")` 当 portal 宿主** —— 落点仍在 `.hud-surface` **内部**（`document.body` 只是 layout effect 之前那一帧的兜底）。`.hud-surface .nav-chip` 这类后代选择器照常命中；`directory-rail.test.tsx:106` 的 `<div className="desktop-app hud-surface">` 包的是**同一套双类名**，测试与生产用的是同一个宿主解析机制，所以测试没有盲区。

真正出走只在伴星两处，而历史抽屉**自己补齐了 token 并写了注释说明为什么要补**（`companion-hud.css:1075-1090`）；只有快捷设置面板漏了两个（A3）。原生 `<dialog>`（`source-intake`、`home-v2-catalog`、`home-v2-feature-notice`）也不受影响：top layer 只改堆叠，不改选择器匹配与自定义属性继承。

我把这条写进来，是因为它顺带证伪了"整套 B 组的根因是 portal 掉 token"这个更省事的解释 —— 真正的原因是**同一个概念被不同代的人各自重抄了一遍**，也就是 §3。
