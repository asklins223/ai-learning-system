# 全站 HUD 语汇一致性审计（2026-09-22）

> 署名：Asklins
>
> 这份文档只谈一件事：**哪些界面没说动森 HUD 那套语汇，以及为什么它们看起来不像同一套。**
> 范围是 `apps/desktop-client` 渲染层的 21 个 CSS（22,387 行）与 112 个 `.tsx`。
>
> ⚠️ **读法（2026-09-23 加，同日更新）**：§0–§9 是 09-22 那一版的**静态审计原文**。下面这三句已经过期：
> "本轮是静态审计"、"**没有** CDP 逐屏量"、"**本轮不动手实施**" —— 实施与量测全在 **§10（二十波实施记录）**、**§11（仓库守卫）**与 **§12（对账表）**，
> **要想知道"到底做完没有"，直接读 §12 那张表**：每条审计结论一行，第三列是给它的读数。
> 续做入口是 §12「交给并行会话的（更新版）」+ §「仍未做」。文中的数字（152 处未注册字体名、136 处 `"Noto Serif SC"` 等）
> 是**审计当时**的，现在大多为 0；复现命令照跑会得到新值，别拿旧值当结论。
> 判据被我自己推翻的地方不改原文、就地标注（§第七波的"判定不做"、§3 的 C3、§2 的 V2 切角数、行号漂移），
> 因为"当时怎么错的"比一份干净的结论更省下一个人的时间。
>
> 原方法声明（保留）：静态审计阶段每条结论标了核对状态：
> - **✅ 已验** —— 我本人用命令复现过，命令附在 §1。
> - **◐ 代理报** —— 子审计员给出、我未逐条复算，方向可信但数字可能有偏差。
> - **✋ 待确认** —— 静态层面存在矛盾，必须真窗口才能定，见 §8。

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
- ✅ **结构性根因**：`WorkspaceLibrarySurface.tsx:435,511,630,631` 在**同一个节点上挂了两代 class**（`v3-goal-focus objective-expedition__focus`），28 个类名在 `approved-surfaces.css` 与 `objective-flow.css` **各定义一次**。
  > 行号到 09-23 已经漂了：当前是 `:438/514/634/655/665/676` 六处（第十三波复扫实测），"28 个类名"也应为 33 —— 以 §10 的复扫表为准，本行保留当时的原始观察。因为 `objective-flow` 带 `.hud-surface` 前缀而 `approved-surfaces` 不带，最终长相是**逐属性撞出来的** —— 它重声明哪条属性就听它的，漏掉的属性仍从旧皮肤漏下来。这不是配色问题，是"为什么这两页看起来不是一家"的机制。

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

## 10. 实施记录（2026-09-22 同日，批次 0–8）

闸门：`npm run typecheck` 干净、`npx electron-vite build` 成功、`npx vitest run` **166 文件 / 1390 测试全绿**（本轮开始前为 165 文件 / 1380 测试、其中 5 条红）。全部 CSS 过一遍 esbuild 解析，**0 警告**。

### 已落地

| 项 | 做了什么 | 实测 |
|---|---|---|
| 批次 0 | `--hud-*` 从 `.hud-surface` 提到 `:root`；确认全站没有任何夜间 `--hud-*` 覆盖，所以提作用域是行为中性的 | 构建产物里 `--hud-ink:` 声明恰好 1 处，落在 `:root` |
| A1 | 字体名换成注册名：135 处替换 + 19 处"两个名字都写"的重复栈合并，覆盖 10 个文件（含 `understanding-universe.tsx` 两处 canvas `context.font`） | `"Noto Serif SC"` / `"Noto Sans SC"` 源与产物均 **0 残留**；serif 169→166、sans 42→26，与合并数对账一致 |
| A2 | `objective-flow.css:25-26` 改成 `.desktop-app.hud-surface[data-theme="night"]` | 死选择器产物 0 命中 |
| A3 | 补齐 `.companion-hud__edge-panel` 缺的 `--companion-mint` / `--companion-mint-strong` | 面板表内 mint 声明 2 条 |
| A4a | 修 `styles.css:1050` 提前闭合的注释；**随后发现被吃掉的 `.evidence-slip` 基皮肤服务的是已无生产者的 `.card-editor` 网格**，所以按 AGENTS.md 删掉该皮肤而不是复活它（子规则 p/strong/button 是今天在用的，保留） | 注释块扫描：无 >20 行的失控注释；esbuild 不再报警 |
| A4b | `styles.css:2070` 未闭合注释补终止符，管线分歧消除 | esbuild 与 PostCSS 现在一致 |
| A5 | 删掉 `hud-pages.css` 里被覆盖的 `--hud-green:#556c55` | 声明次数 1 |
| A6 | `data-outcome` 分四档接手（成立金边净白 / 部分绿边 / 练习淡绿 / 不成立四档压平）；`@keyframes objective-seal-press` 只动 opacity+transform；压印挂在 `data-acknowledgement`，并补进 off 与 reduce 两档 | `objective-flow-css-guard` 由 5 红 → **15/15 绿** |
| B6 | 删除 `approved-surfaces.css` 的 18 条 `--v3-*` 别名，26 处引用直接指向 `--hud-*`；顺手把 6 处与 `--hud-*` 同值的裸 hex 归一 | `--v3-` 产物 0 残留 |
| B2 | 焦点环统一：**只改选择器里真的带 `:focus*` 的规则**，55 条改完发现误伤，按 HEAD 回滚了 9 条 `outline: 0/none` 抑制规则 | 全站 `outline: 3px solid var(--focus)` 46 处；非焦点的 5 处状态描边原样保留 |
| B1 | 奶油描边基色归一（≥2px、alpha≥.5、暖白且非母本者 → `rgba(255,252,235,α)`，保留各自 alpha） | ≥3px 厚边：**62 处同一基色，1 处例外** |
| B3 | `--quest-shadow` / `--quest-shadow-small` / `--universe-ac-shadow` 指向 `--hud-shadow` / `--hud-shadow-small`（后者与母本逐字节同值） | — |
| B7 | `approved-surfaces.css` 两处 `31px 42px 29px 38px` 补回被丢的 `/35px 30px 43px 31px` 半边 | — |
| B8 | `styles.css` 加一条**全站** Off 兜底（1ms + `iteration-count:1`），并修掉 `approved-surfaces.css` reduce 块只压时长不压迭代、导致 `v3-spin` 每秒转一千圈的缺陷；伴星两处因 portal 而失效的 Off 选择器改为读元素自己的 `data-motion`（并给 `CompanionEdgeSettings` 补上该属性） | — |
| B5/C1 | 门禁主按钮极性翻正：浅蜜桃底 + 深墨字 + 白提亮 + 2px `#af522c` + 抖动圆角 + hover 抬升 + `scale(.96)` 按压；顺带删掉因此没人读的 9 条 `--gate-action-border/-shadow/-shadow-hover` | — |
| C2 | 首页目录与建设说明弹窗换成母本纸板语法；`border-radius:8px` 的 44px 按钮换成母本按钮并补按压缩感；深色板绿主按钮换成蜜桃 | — |
| B9 | 首页岛展开态从冷黑 `rgba(20,22,24,.74)` 回到暖黑 `rgba(42,31,24,.9)`，影子回 `--hud-shadow-small`（原先同一颗岛收起/展开两个色温） | — |
| D | 删除死链：`home-room-life.css`（含 `main.tsx` import）、`scene/SurfaceCalibrator.tsx`（528 行，0 引用者）、`styles.css` 里整套 `.surface-calibrator` + `data-surface-calibration-base`（7,059 字节）、`approved-surfaces.css` 的 launcher 抑制行 | 全库 `surface-calibrator` 规则 0 |
| E | `DESIGN.md` 的 §Colors（换成实测值、点名 5 个根本不存在的 token 名）、§Typography（字体必须带 `Variable`）、§Companion Interaction Layer（5 个不存在的文件名 + 三种语言的边界）、以及"生成源已丢失"的告示 | — |

### 一处我自己造的故障（记着，别再犯）

我在 `hud-pages.css` 写"这个文件的生成源已丢失"的说明时，把 `.impeccable/` 写成了带 glob 的 `**/.impeccable/` —— 里面的 `*/` **当场闭合了我自己的注释**。同一类错误我在 `styles.css` 的修复说明里又犯了一次（`` `.study-workbench*/.study-notebook*` ``）。两次都是 esbuild 的 `Unexpected "*"` 报警抓出来的。**在 CSS 注释里写路径通配或类名列表，永远不要用 `/` 做分隔符。**

### 第二波（同日晚，死代码批量清除 + 控件收尾）

判据是一个可复现的检查器：**一个类如果在 `apps/desktop-client/src` 与 `packages/shared/src` 的所有非测试 `.ts/.tsx` 里都不出现（含 `foo--${x}` 这种动态前缀），任何 DOM 都不可能有它，引用它的选择器永远匹配不到。** 保护规则：`:not()` / `:has()` / `:is()` / `:where()` 里的类**不算匹配前提**，不据此删除；只有"必需位置"的类全死才删整条规则，逗号列表里逐成员判死。

自检：拿已知活类（`companion-presence`、`task-surface--`、`day-route`、`evidence-slip`、`surface-return-control`、`text-action`、`run-order-list`、`capture-error`）跑反例，**零误判**；再对拟删类逐个独立复核 `grep -rl` 生产者文件数 = 0。

| 文件 | 删除规则 | 摘除死成员 | 行数 |
|---|---|---|---|
| `styles.css` | 154 | — | 3009 → 1769 |
| `home-room.css` | 100 | — | 1096 → 573 |
| `approved-surfaces.css` | 28 | 12 | 581 → 526 |
| `home-v2.css` | 6 | 2 | 1300 → 1248 |
| `hud-surface.css` | 4 | 14 | 7056 → 7029 |
| `companion-hud.css` | 1 | — | — |

合计 **293 条不可能命中的规则**、**28 个死成员**被摘掉；两文件二次跑检查器均报 0，说明已收敛。删掉的主要家族：`.window-atmosphere*`、`.action-rail` / `.rail-action*`、`.onboarding-*` / `.guide-button*`、`.hotspot*`、`.companion-whisper*` / `.companion-presence-controls` / `.companion-account-controls`、四代 `.task-surface__header`、`.scene-status`、`.run-blocker`、`.surface-action-pair`、`.prototype-note`、`.v3-goal-pulse` / `.v3-goal-focus__copy` / `.v3-objective-intro` 等。

**同批控件收尾**
- 星图主行动按钮（`understanding-universe.css:1299`）：原先 `border` 与 `background` 同色（等于无描边）、无阴影、hover 只换底色、按压无反馈。补成可见描边 + 双层影 + 抬升/`scale(.96)`，圆角换成四角不等。它住在深色那一半，所以影子沿用夜间基色 `rgba(1,12,25,…)` 而不是暖棕。
- 开关 hover（`hud-controls.css:24-25`）：两个孤儿色值 `#c0ac8c` / `#6c8569` 改为**由母本轨道底色按 `--hud-ink` 压暗推导**，底色变了 hover 会跟着走。
- 气泡通道（`companion-bubble.css:11` / `:118`）：两处 `var(--companion-lane-bubble, …)` **全仓没有任何定义方**，注释说的"共用同一条气泡通道"其实一直没接上、永远走兜底。已在 `.companion-hud` 上把该变量定义为 `calc(100% + 60px)`。

### 两处「不做」的最终判断

1. **页 14 夜间**：查证后发现这不是单纯缺口——`study-surface.css:17-20` 的注释明确主张"本页夜间任务纸仍是奶油色，全站夜间冷青焦点环压在上面对比度不够"，而 `approved-surfaces.css`(7)、`hud-surface.css`(14)、`objective-flow.css`(1) 确实各自有夜间分支。也就是说**"页 14 夜盘走奶油"是一个写在代码里的决定，与其他页的做法冲突**。要么给它补一套 `--log-*` 夜间覆盖（推翻那条决定），要么把"任务页夜间统一走冷盘"写进 DESIGN.md 并回改那条注释——这是产品取向，不该由一次语汇收敛顺带替用户定。留待裁决。
2. **`scripts/port-hud-css.mjs` 保留不删**：它的输入 `mockup.html` 丢了，但脚本是**唯一一份"如何把 mockup 再移植成 hud-pages.css"的说明**，而 mockup 有可能从别处备份找回（`.impeccable/` 只是被 gitignore，不是被删）。删脚本才是不可逆的那一步，所以现在只让它保持"跑就 ENOENT"，并在 `hud-pages.css` 文件头与 DESIGN.md 里各写了一条不要跑的告示。

### 第三波（门禁接入与规格矛盾）

- **门禁 C1 部分接入**：输入框 `1px + 3px 12px 3px 3px` → 母本字段语法（`2px var(--hud-line)` + `13px`）；V2 切角族整批换成 V3.1 抖动圆角（`3px 15px 3px 3px`→`19px 24px 17px 21px`、`2px 9px 2px 2px`→`11px 14px 10px 13px`、`2px 8px/3px 12px`→`13px 17px 12px 16px`），**只换圆角不动盒尺寸**，零布局风险。门禁文件内 V2 切角现为 0。
- **`DESIGN.md` §Shapes 的规格矛盾**（新发现，值得单独记）：§Shapes 写的是 **V2 的轮廓语言**（"默认控件 2–4px 轻微圆角""主纸张用不对称切角如 `3px 18px 3px 3px`"），而实际生效的 V3.1 母本全篇是奶油粗边 + 双轴抖动圆角。也就是说**按 §Shapes 写代码会必然不统一**。已把该节改成：V3.1 为唯一母本、V2 切角列为历史层（约 20 处仍在主纸张与便签上，不做一次性替换）、`The Cut-Corner Rule` 由 `The Wobble Rule` 取代。

### 真窗口验收（补 §8 里"静态定不下来"的那几条）

起了一个 dev 实例附连 CDP，**全程只读**（截图 + `getComputedStyle`，未点击、未提交任何业务动作）。工装留在 `scripts/tmp-hud-verify{,2,3}.mjs`（`**/tmp-*.mjs` 已被 gitignore）。

| 项 | 实测值 | 判定 |
|---|---|---|
| A1 字体 | `document.fonts` 注册族名恰好 `Noto Sans SC Variable` / `Noto Serif SC Variable` 两个；屏上标题 computed `font-family` 为 `"Noto Serif SC Variable"` | ✅ |
| A2 夜间 | `.desktop-app` 上翻 `data-theme`：day `--quest-ink #44382f / --quest-paper #fff6dd` ↔ night `#f8ecd2 / #374a3f`，**确实翻得动** | ✅ |
| A3 伴星 mint | 在 `document.body` 下合成 `.companion-hud__edge-panel` 宿主：`--companion-mint #cdebd9`、`--companion-mint-strong #acd8c0` 都解析出值，`[aria-pressed=true]` 芯片 computed `background = rgb(205,235,217)`、`border = rgb(172,216,192)` | ✅ |
| 批次 0 | `body` 上 `--hud-cream` 解析为 `#fff2cf` —— 证明提到 `:root` 后 body 级 portal 真的取得到 | ✅ |
| B5/C1 门禁主按钮 | 合成 `.desktop-access-gate` 宿主：底 `rgb(232,149,104)`=`--hud-peach`、字 `rgb(62,45,34)`、边 `2px rgb(175,82,44)`、角 `17px/21px`、影 `0 5px 11px rgba(67,43,27,.16)`、`text-shadow rgba(255,255,255,.32) 0 1px`；亮度 底 163 vs 字 48 → **浅底深字，极性已正** | ✅ |
| C1 门禁字段 | `2px rgba(73,47,29,.22)` + `13px` | ✅ |
| B9 首页岛 | 展开态 trigger `rgba(42,31,24,0.9)` + `rgba(43,27,17,.22) 0 12px 28px…`（暖黑 + 母本双层影，不再是冷黑） | ✅ |
| C2 首页目录 | 现场正开着：`4px rgba(255,252,235,.78)`、四角 `31px 42px 29px 38px / 35px 30px 43px 31px` 完整双轴、影 `rgba(46,27,16,.28) 0 24px 60px…` | ✅ |
| 纸板收敛 | `.source-index` / `.study-card` 均 `4px rgba(255,252,235,.78)` + 双层影；`.evidence-slip` `3px rgba(255,252,235,.72)` | ✅ |
| B2 焦点环 | 真键盘 Tab 走 14 站：采到的环全是 `3px … offset=3px`，颜色 `rgb(122,210,223)` = **夜间 `--focus`**（应用当时在 night），说明环是随主题走的那一个 token | ✅ |

**两条量法教训（写下来免得下次又上当）**
1. **`document.fonts.check('… "Noto Serif SC"')` 对未注册的族名返回 `true`** —— 没有匹配 face 时它空洞地为真。**它不能用来证明字体没注册**；能证明的是 `document.fonts.forEach` 列出的实际族名。我第一版探针就被这个读数骗了一下。
2. **`.focus()` 程序性聚焦不触发 `:focus-visible`**，量到的 outline 是未聚焦态。焦点环必须用真键盘 `Tab` 量。

**一次险情（如实记录）**：收尾时我用 `pkill -f "study/apps/desktop-client/node_modules/electron"` 想收掉自己起的实例。并行会话**同时有一个实例在跑**（主进程 `37667`，`--user-data-dir=/private/tmp/objflow-final2-udd`，CDP `9747`）。查证后确认没打到他们：他们的主进程命令行是**相对路径** `./node_modules/electron/dist/…`，绝对路径里 `desktop-client/node_modules/` 后面接的是 `.pnpm/`，都不匹配那个模式。我的实例按 PID 收掉后复核：`37667` 仍在、`9747:200`、`API 4000:200`。**教训是：这台机器上 Electron 实例不止一个，收进程必须先按 PID 认，不要用命令行模式批量 pkill。**

### 第四波：V2 切角收干净 + **推翻我自己审计里的 C3**

**先说一个方法错误（连错两次才改对）**：判"哪些 V2 切角还生效"，我先后用了两种**不可靠**的判据——
1. 用正则去 `hud-pages.css` 里提取"被 V3.1 列表覆盖的类"，正则里的 `[^{}]*` **跨不过 `{`**，于是覆盖集恒为空，报出"39 处仍生效"（错）；
2. 改用浏览器量级联，却拿 `borderTopLeftRadius` 去匹配 `a b a a` 形状——而**只有斜杠形式**才会返回两个值，四值无斜杠时它只返回一个值，于是分类器把一切都判成"非切角"，报"0 处"（数字对，理由错）。

**正确的量法**：读**四个角**的 `border-*-left/right-radius`，判 `H0===H2 && H2===H3 && H1!==H0`（即 `a b a a`）。用这个判据实测，真正仍生效的 V2 切角是 **7 处**，不是 39 处——大纸板（`study-card` / `notebook` / `day-route` / `source-index` / `pinboard` …）早就被 `hud-pages.css:153` 那条 V3.1 列表接管了。

**已收掉的 7 处**（`npm run build` 后在真窗口逐个重量，全部 `✓`）：

| 类 | 改前 | 改后实测 |
|---|---|---|
| `.current-note` | `3px 19px 3px 3px`，**且 `border: 0`——大块纸面完全没有奶油描边** | `31/35 42/30 29/43 38/31` + `4px rgba(255,252,235,.78)` |
| `.claim-sheet` | 同上（也无描边） | 同上 |
| `.home-menu` | `4px 18px 4px 4px` + `1px rgba(255,255,255,.62)`（浅纸上挂白细线） | 母本板形 + 4px 奶油边 |
| `.approved-state` | `4px 20px 4px 4px` + `1px rgba(255,255,255,.56)` | 同上 |
| `.home-v2-collection` | `3px 12px 3px 12px` 族 + 1px | 母本板形 + 4px 奶油边 |
| `.surface-return-control` | `7px 12px 7px 7px` | 便签族 `23px 29px 20px 27px/…` |
| `.home-v2-catalog__notice` | `2px 12px 2px 2px` | 便签族同上 |

`current-note` / `claim-sheet` 这两处顺带修掉的是比圆角更重的问题：**它们是满幅纸面却一条描边都没有**，纯靠阴影浮着，违反 Physical Paper Rule。

### C3 驳回：页 14 不需要夜间分支（实测推翻本审计原结论）

原条目写的是"`study-surface.css` 夜间处理 0 处 ⇒ 违反 Registered Pair Rule"。趁应用正处于 night 主题，直接量各任务页此刻的纸色：

```
day-route(页14)  rgb(255,242,207) 亮度 242
study-card       rgb(255,242,207) 亮度 242
notebook         rgb(255,242,207) 亮度 242
marked-paper     rgb(255,242,207) 亮度 242
search-desk      rgb(255,242,207) 亮度 242
claim-sheet      rgb(245,234,213) 亮度 235
pinboard         rgb(196,155,109) 亮度 160
```

**夜间所有任务纸都是奶油色**，页 14 与全站完全一致；`study-surface.css:17-20` 那句"夜间任务纸仍是奶油色"是**真话**，不是没做完的活。`.night-paper` 是天文台那类表面**显式启用**的另一套面，不是任务页的默认命运。所以 C3 判错，页 14 无需补夜盘——**这条从"待决"里划掉**。

（顺带：`--hud-*` 没有夜间覆盖这件事，我在批次 0 就是靠"全站没有 `.night` 改写 `--hud-*`"这条实测判的，与本次结论同向。）

### 第五波：逐屏活体扫描（回答"到底还有哪里不统一"）

写了一个活体扫描器 `scripts/tmp-hud-sweep.mjs`（`**/tmp-*.mjs` 已 gitignore）：登录 → 逐个进 10 个轨道入口 → 对屏上每个 ≥70×34 的可见元素按四条判据判（细线当卡片边 / `a-b-a-a` 切角 / ≥3px 描边离调色板 / 大面底色离调色板）。**判据读的是渲染后的 computed style，不是源码文本。**

**第一轮命中 9 处，逐条定性后：**

| 命中 | 定性 | 处理 |
|---|---|---|
| `settings-block` 底色 `rgba(255,255,255,.34)` | **真漂移**：全站唯一没被暖化的白色叠加层，违反 Warm-First | 改成 `color-mix(in srgb, var(--hud-paper-light) 46%, transparent)`；复扫算出 `rgb(255,249,235)` ✅ |
| 门禁夜间盘底色 `#101511` | **真漂移**：G 通道偏高的冷黑，与它自己那张夜间盘（字段 `rgba(24,20,18)`、动作 `#d86d3a`）都不同族 | 改成 `#151110`（比字段暗一档的暖黑），滚动条底槽同批 |
| `objective-quest-region` ×3、`day-rail__card` ×2（2px 边） | **判据假阳性**：边色本来就是母本 `rgba(255,252,235,.72)`，且它们是嵌在大纸面里的行——Physical Paper Rule 正是要避免"给每个列表项做独立悬浮卡片"，升到 3–4px 反而违规 | 不改，并据此收窄扫描判据 |
| 复扫仍报 `settings-block` 底色 | **探针缺陷**：`color-mix()` 序列化成 `color(srgb 1 .976 .922/.46)`，我的调色板表只收了 `rgb()` 形式 | 属探针问题，值本身已正确 |

**结论：10 屏里首页 / 来源 / 笔记 / 星图 / 复习 / 查找 / 伴星 7 屏零命中**，剩下的命中经核要么已修、要么是判据太粗。截图留在 `/tmp/hud-sweep/`。

**这一波的量法教训（同 §9 一类）**：活体扫描的判据必须和**渲染语义**对齐，不能只按几何尺寸一刀切——"卡片尺寸 + 细线"这条会必然误伤嵌套行，因为细线在这里是刻意的层级抑制，不是漏改。

### 五波之后的状态

`typecheck` 干净 · `electron-vite build` 成功 · 全站 CSS 过 esbuild **0 警告** · `vitest run` **166 文件 / 1392 测试：1390 绿 / 2 红**（那 2 红 = 上文已归因的 `prosemirror-model` 双实例依赖问题，与本轮无关）。

**待决清单最终只剩两条**（原四条里，页 14 夜间被实测驳回、V2 切角已全部收掉）：
1. `WorkspaceLibrarySurface.tsx` 同节点双 class（28 个类名两代各定义一次）——需要与并行会话同步决定留哪一代。
2. `prosemirror-model` 双实例去重——需要一次 `pnpm install` 级别的决定，会波及并行会话。

### 第六波：控件按压反馈补全（把"需要真窗口"的那条做掉）

**先用不可靠的测法翻了一次车**：写了个遍历 `document.styleSheets` 找 `:active`+`transform` 的扫描器，跑出来"19 种控件形态全部无按压"——连母本 `.button`（`hud-pages.css` 明确有 `:active{transform:scale(.96)}`）也报无。这个数**不采信**：`r.style.getPropertyValue('transform')` 在 21 张表上恒为空，检测器本身是坏的。**今天第三次一个自信的错数**（前两次：`document.fonts.check` 空洞为真、`borderTopLeftRadius` 判形状）。

改用静态源查法（按 `选择器含 :active` + `声明块含 transform` 匹配），得到可信清点：全站 `hover-transform` 32 条 / `active-transform` 25 条，而**完全没有按压规则的文件**是 `approved-surfaces.css`、`hud-controls.css`、`study-surface.css`、`companion-{bubble,chat-record,hud,proposal-choice,root}.css`。其中影响最大的是 **`hud-controls.css`——它是全站开关/分段/选择器/滑杆的补全层，一条 `:active` 都没有**，而母本 `.button` 是"抬升 + `scale(.96)`"成对出现的，所以这些控件按下去只变底色不缩，手感不像同一个应用。

**已补**（按房规追加到 `hud-controls.css` 末尾，数值照抄母本不自新一档）：`.switch` / `.hud-segmented button` / `.hud-picker__trigger` / `.hud-picker__option` / `.hud-slider__thumb` 的 `:active:not(:disabled) { transform: scale(.96); transition-duration: 110ms }`，外加开关旋钮的配套位移（`.switch:active i` 缩放、`.switch.on:active i` 保持 `translateX(18px)` 再缩放，避免整块缩而旋钮不动）。

**真鼠标验证**（合成控件挂进 `.hud-surface`，`mouse.down` → 读 computed → `mouse.up` → 再读）：

```
switch              静=none  按住=matrix(0.96,0,0,0.96,0,0)  松=none  ✅ 生效且可回弹
picker__option      静=none  按住=matrix(0.96,0,0,0,0.96…)   松=none  ✅
segmented button    静=none  按住=matrix(0.96,…)             松=none  ✅
```

（同一次里"运行时找不到那条规则"的读数又是搜索循环漏了嵌套层导致的假阴性——**负结果优先怀疑探针**。）

**仍未补按压的**：`approved-surfaces.css` 与伴星那几个文件。伴星侧是有裁决的第二种语言，按不按母本手感是产品取向；`approved-surfaces.css` 那批手写按钮（`1px`/`border:0`/`999px` 各形态）要连"收不收编到 `.button`"一起决定，见下方待决第 1 条。

### 第七波：调色板分叉收回 + **双 class 这条为什么判定"不做"**

**先纠正一处我自己的粗数。** 第一次算两代冲突时，我把 `@media` 里的紧凑档当成基础档比，于是"旧 7px / 修正层 12px"这种**合法的响应式降档**被算成冲突。把媒体条件带下去之后：**两代共定义 33 个类名，同上下文同值 54 处，真冲突 91 处（其中基础档 90）**。

**已做：把 `--quest-*` 里的"衬底"收回母本。** 冲突的根因是同一批元素上挂着**两套平行调色板**——`objective-flow.css` 把 `--hud-butter #f3d678` 重抄成 `--quest-butter #f2cf6b`、`--hud-cream #fff2cf` 重抄成 `--quest-paper #fff6dd`、`--hud-line` 重抄成 `rgba(75,57,42,.18)`……处理原则是**衬底共用、身份保留**：

| 收回母本（与 `--hud-*` 仅 1–13 通道偏差，属重抄） | 保留（这条链路的识别色） |
|---|---|
| `--quest-paper`→`--hud-cream`、`--quest-cream`→`--hud-paper-light`、`--quest-soft`→`--hud-soft`、`--quest-butter`→`--hud-butter`、`--quest-line`→`--hud-line`、`--quest-ease-out`→`--hud-ease-out`（原为逐字节同值） | `--quest-ink`（更软的墨，Δ20）、`--quest-line-strong`（alpha 有意更强）、`--quest-grass/-grass-deep/-moss`（远征绿）、`--quest-water/-water-deep`（水蓝）、`--quest-clay/-clay-deep`（陶土）、`--quest-wood` |

夜间那一档不受影响：夜间盘是**逐条重新赋值**（`--quest-paper: #374a3f` 等），基础档换成 `var()` 引用不会盖掉它。

**判定不做：把旧代被覆盖的 90 条声明从 `approved-surfaces.css` 删掉。**
> **这条判定已在 §第十一波作废**，理由不是想法变了而是量法变了：当时我拿"我自己写的粗糙特异度模型"当唯一依据，所以不敢删；这一轮改成让真引擎逐元素对拍 computed，删除就从"推理"变成"可证"。做法、判据与四条闸门以 §第十一波为准，下面这段只保留当时的推理过程（含它错在哪）。
 我写了这个删除器（`/tmp/dedup-old-skin.mjs`，未执行），然后停手，理由是量出来的事实本身：修正层的选择器写成 `.hud-surface .v3-*`（0,2,0）**且**后加载，对全部 90 处冲突在**特异度和顺序上双双必胜**——也就是说**这些冲突今天已经没有任何视觉代价**，删与不删画面完全一致。于是这件事的性质从"UI 不统一"变成"纯代码卫生"，而它同时满足三个不该在此刻做的条件：① 零可见收益；② 落点与并行会话正在改的 `objective-flow.css` / `learning-run-surface.tsx` / 伴星那批文件重叠；③ 我的脚本里那个特异度模型是**粗糙的**（把修正层一律记作 2），误判会静默改掉画面。零收益 + 有静默风险 + 需要一次跨会话协调，这三条同时成立时不做是对的。

**留给后续的正确做法**：等他们那批改动落地后，按"同类同属性同上下文"逐条删旧代，并且**每删一批跑一次逐屏 computed 对拍**（`scripts/tmp-hud-sweep.mjs` 可以直接当对拍器用：改前改各跑一次，比对每个元素的 rim/圆角/底色读数）。

**归因又一次先读报错**：本轮结束时全量测试 4 红——2 条是已归因的 `prosemirror-model` 双实例，另外 2 条新红在刚出现的 `CompanionProposalChoice.test.tsx`。这次没有再猜"是并行会话的改动"，读了原文：`Unable to find an element with the text: 需要你的选择` / `role "button" name "正在确认…"`，是**文案与角色断言**对不上，且 `CompanionProposalChoice.tsx` 的 `M` 不是我（我从头到尾没碰过该组件）。判定为他们正在做的文案重构，与本轮无关。

### 第八波：`image-lightbox--card` 这个变体其实从没实现过（待决第 4 条，已修）

这条不用跑应用就能证死。`variant="card"` 在 `notebook-surface.tsx:1509` 使用，注释原话是「遮罩只盖住这张纸面，不铺满整个窗口」；样式是 `position:absolute; inset:0; border-radius:inherit`（`styles.css:1671-1674`）。可组件**无条件** `createPortal(…, document.body)`：

- 挂到 body 后绝对定位的包含块变成**初始包含块 = 整个视口** → 它照样铺满窗口；
- `border-radius: inherit` 继承的是 body 的 **0** → 拿不到纸面的抖动圆角。

也就是 card 变体和全屏变体渲染结果一样，**这个变体等于没实现**。而原有测试只断言了类名（`className === "image-lightbox image-lightbox--card"`），所以它一直是绿的——**类名断言看不见挂载点**。

**修法**：只有非 card 形态才 portal。全屏形态必须出走是真的（伴星抽屉的 `animation … both` 让 transform 常驻、把 fixed 后代关进 406×778），但 card 用的是 `absolute`，它要的恰恰是"被宿主管住"，而 `.notebook` 本来就是 `position:relative`（`hud-pages.css:61`），留在原地即按预期铺满纸面并继承抖动圆角。

**补了一条可反证的断言**（`image-viewer.test.tsx`）：card 形态的 `lightbox.parentElement` 必须是宿主 `.notebook`、且不是 `document.body`。反证做过：把组件改回"一律 portal"后**只有这条红**（`expected <body…> to be <div class="notebook">`），其余 10 条含"全屏必须 portal"那条仍绿——两条断言不互相矛盾；还原后 11/11。

> 过程中自己差点留了个雷：反证脚本里 `cd ..` 走错一层导致测试根本没跑，而**变异还写在文件里**。是靠"还原前先 grep MUTANT"发现的。反证要跑第二次并**当场核对还原后的文件内容**，不能假定脚本走完了。

### 第九波：`styles.css` 衬底 token 收回母本（待决第 3 条，已做）

先量清每个旧 token 的活消费者与和母本的通道偏差，再按"**衬底收回、独立角色保留**"处理：

| 收回 `--hud-*`（10 条） | 偏差 | 保留自有值 | 理由 |
|---|---|---|---|
| `--ink` `#30231a` | **逐字节相同** | `--focus` `#9a351d` | 它是全站焦点环的唯一 token，**HUD 层反过来读它**（`hud-pages.css:178`、`hud-controls.css`、`objective-flow.css`），不是重复 |
| `--paper-deep` `#e8d4b1` | **逐字节相同** | `--accent-deep` `#8e391d` | 比 clay 更深的动作色，母本无对应 |
| `--paper` `#f7ecd5` | Δ2,2,0 | `--sage` / `--sage-deep` | 草绿两档，Δ2,13,15 不是重抄 |
| `--paper-strong` | Δ0,1,5 | `--glass-*` / `--control-*` | 深色浮层的描边与文字，另一套语义 |
| `--ink-soft` | Δ3,5,5 | `--wood` / `--star` | 场景材质色与星光色 |
| `--line` / `--line-strong` | Δ3,2,1 / Δ2,1,1（含 alpha） | | |
| `--accent` → `--hud-clay` | Δ0,1,5 | | |
| `--paper-shadow` / `--soft-shadow` → `--hud-shadow` / `--hud-shadow-small` | Δ1,0,0 / Δ5,3,1 | | |

**为什么不能只靠推理**：`--ink: var(--hud-ink)` 写在 `styles.css`，而 `--hud-*` 声明在 `main.tsx` **更晚**加载的 `hud-pages.css` 里——跨加载顺序的自定义属性引用正是"会静默解析成空"的那一类。静态侧先排掉两种自伤（**无自引用、与 `--hud-*` 无重名**），再在真窗口逐个读 computed：

```
--ink            #30231a            = 母本 ✅
--paper-deep     #e8d4b1            = 母本 ✅
--line           rgba(73,47,29,.22) = 母本 ✅
--paper-shadow   0 24px 60px rgba(46,27,16,.28),… = 母本 ✅
--accent         #bd5a31            = 母本 ✅
--focus          #9a351d            （保留自有值 ✅）
```

自定义属性在**计算值时**解析，不受声明先后影响，实测确认了这一点。至此衬底（纸、线、影、主色）在全站只有一个来源：`hud-pages.css` 的 `--hud-*`。

### 第十波：`prosemirror-model` 双实例修好了（待决最后一条压着红测试的）

**先更正本文档上一轮写错的一句**：我在 §本轮结束时的闸门状态 里写过"vite 侧 `resolve.dedupe` 与 `test.server.deps.inline` 都实测无效，**只剩依赖层去重**"。这句**以偏概全**了——我只试了那两种就给整条路判了死刑。正解是第三种：**在 `vitest.config.ts` 里把测试侧的 `prosemirror-model` 显式 alias 到 y-prosemirror 实际链接的那份 realpath**。

**为什么方向要反过来**：`dedupe` 是把两边都往**顶层**那份拉，而 `y-prosemirror` 走 SSR 外部化、由 Node 解析，永远拿 `.pnpm` 那份——所以 dedupe 只会让测试也变成"错的那一份"，两边依旧不同实例。要对齐的是**外部化消费者已经拿到的那个**。

**实现要点**（`vitest.config.ts`）：不硬编码版本号，读 `node_modules/.pnpm/y-prosemirror@*/node_modules/prosemirror-model` 这个符号链接并 `realpathSync`，入口取 package.json 的 `module`（`dist/index.js`）。升级 prosemirror 后它自然跟着走。

**自己踩到的第二个坑**：第一版稳健实现里写了 `dirname(realpathSync(配置目录))`——**多退一层**，`.pnpm` 找不到，而我的 `catch` 把它静默兜成 `{}`，alias 没注入，测试退回 `RangeError` 红，**配置本身看起来毫无异常**。这和"静态守卫天生绿"是同一个失败形状，已改成**解析不出来直接抛**。

**反证做过**：`resolve: prosemirrorResolve()` → `{}` 时 **2 红且正是那条 `RangeError`**；还原 → 4/4 绿，且当场 grep 确认 `MUTANT` 计数为 0。

**结果：本轮第一次全绿——171 个测试文件 / 1425 条测试全部通过**（此前一直是 2 红压着）。

### 级联对拍台：把"我判的特异度"换成"引擎算的结果"（`scripts/tmp-hud-oracle.mjs`）

待决第 1、2 条我上一轮都推给"需要更准的特异度模型"。这一轮先承认那模型我写不准，于是**不判特异度**：

1. `capture` 连上开发窗，走完 11 个入口（含理解详情），把每一屏的 `document.documentElement.outerHTML` **和全部样式表按页面里的实际顺序**冻结到 `/tmp/hud-oracle/snapshot/`；
2. `run <tag>` 把冻结 DOM + 冻结样式喂给**我自己 launch 的 headless Chromium**，逐元素读 54 项 computed（四边宽度与颜色、四角圆角、底色、字族字号字重、四边内边距、外边距、阴影、透明度、焦点环、backdrop-filter…），并顺手用 `closest('.hud-surface')` 数候选类有没有渲染在 HUD 之外；
3. `diff a b` 逐元素逐属性比。8 个维度组合全跑：**日/夜 × 1440/700（跨过 760 断点）× reduced-motion 两档**，88 页 / 8320 条读数 / 约 20 秒。

它比"我读 CSS 推理"强的地方是引擎不会错，但它自己会**空洞成立**，所以三条闸门都实做过：

- **灵敏度**：把 `.hud-surface .v3-goal-row__title` 的 13px 改成 17px → **16 处差异**，落点正是那一个元素的 `fontSize`（外加 `lineHeight` 被 `font` 简写带着走），8 个组合各一次。
- **可重复**：改前连跑两次对拍 → **0 处差异**（页面里所有 animation/transition 在重放时被 `!important` 冻掉，否则分不清"我删的"和"动画进行到第 37ms"）。
- **非空**：`recss`/`resrc` 每次都要打印"哪张样式表变了、多少字节、多少条块"。这条是被咬出来的——我按 `--apply` 删完 103 条之后对拍 **0 差异**，看着像成功，其实是 vite 已经死了而 Electron 还活着，页面里的 `<style>` 是启动那一刻的化石，bundle 一个字节都没变。**"0 差异"和"什么都没测到"长得一模一样。**

另外两处判据修正（都是我自己先写错再量出来的）：

- 屏名当文件名用 `replace(/[^\w]+/g,"_")` —— JS 的 `\w` 不含中文，11 个入口全塌成同一个 `dom-_.html` 互相覆盖，"11 屏对拍"实际是同一屏读 11 次。改成序号 + **每屏记录活动界面指纹**，指纹和上一屏相同就喊。
- `:active` 挂在**用户激活链上的祖先**，不在被按的那个节点上；只读目标自己的 transform 会把真按压判成"无按压"。改成读目标及其祖先的最小缩放，并报"动的是哪一个"。

### 第十一波：双 class 结构性去重落地（待决第 2 条，上一轮的"判定不做"作废）

上一轮我以三个理由判它"不做"：零可见收益、落点与并行会话重叠、我的特异度模型粗糙。**这三条都被这一轮的量法解决了**：收益本来就是零（所以才要用对拍证明它仍是零），重叠的部分只涉及样式文本不涉及他们的 JSX，而判据不再是我的模型——只有同时满足

① 旧代那条选择器是**裸单类** `.c`（无伪类/属性/嵌套），② 新代有一条**恰好** `.hud-surface .c`（中间没有别的层级、没有 `[data-outcome]` 这类额外条件），③ @media 上下文逐字相同，④ 该类在 11 屏冻结 DOM 里**一次都没有**渲染在 `.hud-surface` 之外

才删。②里"没有额外条件"是关键：写成 `.hud-surface .c[data-outcome]` 就不覆盖所有 `.c`，删旧代会改画面。

- 结果：**103 条声明**（真冲突 58 + 新代逐字节重抄 45）、`approved-surfaces.css` 32,433 → 30,071 字节、清空并删掉 4 个规则块。
  **和 §第七波那句"91 处冲突"对不上，是因为两把尺不同**：第七波按"两代同上下文同属性"粗数（复合选择器也算对手），这一轮只认"旧代裸单类 vs 新代恰好 `.hud-surface .c`"这一种可证形状，所以 103 条里含了 45 条第七波没算的**同值重抄**、同时排除了那些对手是复合选择器的。两把尺都对，但只有这一轮这把配得上"删了不改画面"。
- 出界闸门：11 屏实测**无一个候选类**渲染在 HUD 之外；再用静态一条兜底——全渲染层只有 4 个文件调用 `createPortal`（`DirectoryRail` / `image-viewer` / `HomeV2ObjectLayer` / `CompanionHud`），**没有一个提到这 24 个候选类**，所以 portal 到 body 这条路对这 24 个类根本不成立。
- 对拍：**0 处差异**（改前改后各 8,320 条读数）。这一次 `recss` 报"变化的 1 张 / −2,362 字节 / 268 → 264 条块"，非空闸门通过。
- 幂等复跑：删完再跑一次扫描器报 **0 条**——一次删干净了，不是一遍一遍漏。
- 去重器与对拍台都留在 `scripts/tmp-hud-dedup.mjs` / `scripts/tmp-hud-oracle.mjs`（`tmp-*` 已 gitignore，判据写在文件头注释里）。

**没做完的部分要说清楚**：那 24 个旧代类在 `approved-surfaces.css` 里**还剩 302 条声明**（`.v3-goal-row` 41 条、`.v3-goal-filters` 32 条…）。它们的对手不再是"恰好 `.hud-surface .c`"这种干净形状，删任何一条都要逐对判复合选择器——**而这已经不是去重，是迁移**：`WorkspaceLibrarySurface.tsx:525/630/665` 现在是 `v3-*` 与 `objective-expedition__*` / `objective-brief__*` **两代新钩子并挂**（并行会话正在进行的重构），旧代那 302 条今天还在真出力。把它并进新代是那条链路的改版决定，不是 HUD 语汇不一致，交过去（见文末交接）。

### 第十二波：这条链路"能按但按下去不动"的控件补上按压（待决第 1 条的可证部分）

先纠正条目本身的措辞：我审的时候把 `approved-surfaces.css` 那批写成"1px / border:0 / 999px 各形态"，量完发现**药丸形不是缺陷**——`objective-flow.css` 早就把 `.v3-goal-filters button` 重写成 `999px`，而同一条链路的 `objective-mode-badge`、`.learning-run-journey__state`、`objective-expedition__index:not([open])`、母本自己的 `.home-v2-hud__actions button` / `.room-control > button` 全是药丸。**药丸是这个应用里"岛状控件"的既有语汇**，改成抖动圆角反而更不统一。这条我按量的结果驳回自己原来的写法。

真缺的是**按压**：离线按压探针（真鼠标 + 逐帧读 transform）实测 `.v3-goal-filters button`、`.v3-goal-row`、`.objective-quest-node` 按下最小缩放都是 **1.000**，而同一屏已有按压的动作块量到 **0.985**（正对照）、`.nav-chip` 量到 1.000（负对照）。母本 `.button` 的按压是 `scale(.96)` 与 `transition-duration:110ms` **成对**出现的，数值照抄、不自新一档：

- `objective-flow.css:577-586` 给筛选 chip、列表行、远征节点、加载更多、原文出处行、判断/配对选项补 `:active:not(:disabled){transform:scale(.96);transition-duration:110ms}`，并补上母本那三重过渡（这几个控件原先一条 transform 过渡都没有，`scale` 会瞬间弹到位，按压就成了"跳"）。
- 原有那两个动作块的抬手幅度 **0.985 不动**（它们是大纸块），只补上同一对里缺的 `transition-duration:110ms`。
- 验证：改前 `1.000` → 改后 `0.960`（三个控件都是），**反向**再做一次（把那一段整体撤掉再量，三个又回 `1.000`）；同时 `run srcbase` vs `run srcpress` 静态对拍 **0 处差异**——按压之外的样子一点没动。
- `__tabs button`（紧凑档 44px 三格）没并进来：它是并行会话这一轮正在改的对象，加一行就撞车，写在下面的交接里。

### 被这一轮改到的一处守卫

`objective-flow-css-guard.test.ts` 的 P15 段读的是 `approved-surfaces.css`，断言 `.v3-next-action__verb` 有 ≥14px 的无条件字号。第十一波正好把那条**逐字节重抄**的声明删掉了（真值在 `objective-flow.css:278`，`font: 750 18px/1.35`）——于是守卫红。这是守卫跟着旧位置走，不是地板掉了；把该段的读取指向修正层，并对**两条断言各做一次变异**：字号打到 9px → 红（`expected 9 to be greater than or equal to 14`），在 `@media (max-width: 760px)` 里插一条降字号 → 红（"紧凑档还在降主行动块的字号"）。撤掉变异后 15/15 绿。**不会**为了守卫绿把那 1 条死声明放回 `approved-surfaces.css`。



### 第十三波：对**当前**树重扫（审计口径是 09-22 那份，这两天新落的文件从没量过）

`scripts/tmp-hud-resweep.mjs` 把本审计的判据原样跑在现在的树上（20 个 CSS / 114 个 tsx）：

| 判据 | 结果 |
|---|---|
| 未注册字体名 `"Noto Serif/Sans SC"` | **0** |
| `.desktop-app … .hud-surface` 永不匹配的后代写法 | **0** |
| 焦点环方言 | 9 处 `outline:0/none` —— 逐条查后 6 处是有意的（指针模态抑制、环移到外层 `:has()`、程序化聚焦的标题），3 处需判 |
| 双代际钩子并挂 | 6 处，全在 `WorkspaceLibrarySurface.tsx:438/514/634/655/665/676`（本文前面记的是 435/511/630/631，**已漂**，以这组为准） |
| 与 `--hud-*` 差 ≤3 通道的局部 token | 23 处：6 处 Δ0,0,0 全在星图调色板里；其余是 gate / home-v2 / companion / `--cgp-*` 等有意微调 |

**键盘焦点环普查（新的判据，977 次真 Tab）。** 前面那条只数"文件里写了什么方言"，看不见"根本没写"。于是在离线重放页里按**真 Tab**走遍 11 屏每一个焦点位，读 computed outline：**977 次停留，只有 3 类没有环**。

- `button.source-sheet`（来源库整行）——**真缺陷**：`hud-surface.css:716` 写着 `outline: none; outline-offset: -3px`，特异度 (0,2,1) 高于全局那条 `:is(button,…)`，等于把整列行的键盘焦点指示关掉；`outline-offset` 还留着，说明作者本来是要一个内嵌环、只把宽度写成了 0。已改成母本环 `3px solid var(--focus)` 并**保留 -3px**（这些行在 `overflow:auto` 的列表里，环画外面会裁掉半圈）。改后普查 55 → 39 处、这一类消失；`run srcbase` vs `run srcpress2` 仍然 **0 处静态差异**（环只在 `:focus-visible` 时出现，不影响静止外观）。
- `a.skip-link` —— 已核不是缺陷：它只在键盘聚焦时滑入（`:focus-visible{transform:translateY(0)}`）且自带纸面与投影，元素本身就是焦点态。
- `section.card-deck` —— **离线量不到的那一类**：环挂在 `data-deck-ring="true"` 上，而这个属性是 React 在 `onFocus` 里按浏览器 `:focus-visible` 判一次写上去的（`ReviewSurface.tsx:115/876`，注释解释了两档误报：键盘聚焦后改用鼠标拖卡时 Chromium 仍算 focus-visible）。冻结 DOM 里没有 JS，所以普查只能看见"没环"。**活页面按真 Tab 复核**：第 1 次 Tab 走到卡叠，`outline solid 3px rgb(122,210,223)`、`data-deck-ring=true` —— 环在，颜色是夜间盘的 `--focus` 青档（`#7ad2df`），不是方言。

**顺手推翻我自己的一条新假设。** 我原想把 `hud-surface.css` 里那份 `--universe-*` 调色板按"逐字节相同就收回母本"处理（6 个 token 与 `--hud-star`/`--hud-gold` 完全同值），并且发现 `.companion-center` 与 `.universe-page` 两份表被一句注释声明为"同值"。**文本比对不算数**：一份走 `var(--color-*)`/`color-mix()`，一份写字面量。把 16 个共享变量的**计算值**逐个算出来比：**8 个相同、8 个不同**——同一块 `universe-canvas-controls` 在星图页是奶油纸 `rgb(255,242,207)`，在伴星中心嵌的那份里是深夜玻璃 `rgba(11,33,48,.9)`，另有四条 alpha 各漂了 2–6 个百分点（`--universe-edge` 0.84 对 0.78）。两份都是有意变体（整页 vs 卡里嵌的小星图），于是**不收回、不对齐**，只把那句"与 .hud-surface .universe-page 同值"的假注释换成量出来的事实，免得下一个读者拿它去"对齐"。同理，伴星中心那份表整体是字面量调色板，把其中 6 个单独改成 `var(--hud-*)` 只会让一张表一半引用一半字面量——不是收敛。
`--universe-void-deep` / `--universe-glass` 在伴星中心解析为**空**，但唯一消费者是 `.universe-detail-scrim`（`understanding-universe.css:1667/1793`），而它只由 `graph-surface.tsx:602` 生产，嵌在伴星中心的是 `UnderstandingUniverse` 组件、没有 scrim → 不是静默失效，未改。



**B7 的另一半（抖动圆角与奶油粗边是一对）用计算值收口。** 先用 postcss 按文本量，报出"222 个类有圆角没粗边 / 2 个类有粗边没圆角"——**这个数不能用**：`companion-workbench` 与 `companion-stage` 那两条写的是 `border-radius: var(--companion-radius-shell)`，文本级分类看不见 token 里是什么（我刚把"别比文本、要算值"写进内存，转头就被自己的工具绊了一下）。换成在冻结页面上只量**真的渲染出来、且 computed 粗边 ≥3px 的成块面**：15 类，**四角全同值的 0 类**——`.day-route`/`.source-index`/`.search-desk`/`.current-note` 都是母本那条 `31 35 42 30 / 29 43 38 31`，`.companion-workbench` 是 `26 30 24 28`、`.objective-expedition__map` `36 30 29 39 / 39 29 31 37`、`.universe-detail-panel` `27 34 24 31`，各自抖但都抖。**B7 就此收口，没有待办**；工具留在 `scripts/tmp-hud-rim-computed.mjs`，文本级的 `tmp-hud-rim-pair.mjs` 只当反面教材留着。

**按压那条改动在活页面上的复核做到哪一步（说清楚，别多报）。** 已证：活页面的 `document.styleSheets` 里确实有这两条——`objective-flow.css` 的 `.hud-surface :is(.v3-goal-filters button, .v3-goal-row, .objective-quest-node, …)` 带着 `transform: scale(0.96)` 与那条三重过渡（"规则写了但没送到页面"正是本审计反复中招的那类，所以这一半必须单独查）。幅度是**同一个引擎**在冻结页上用真鼠标量出来的 0.960（正对照 0.985、负对照 1.000 同批跑过）。**没能在活窗口重跑这一帧**：应用的 `.nav-chip[理解]` 每次都恢复到 `task-surface--objective-detail`（屏上没有 `.v3-goal-row`），而"返回学习空间"是回家不是回列表——这是并行会话正在改的路由态，不值得我在这儿猜一条数字。顺带修了探针自己的一个假阴性：目标不存在时它原先会一路走到"没动"，现在会喊"屏上没有"（**负结果先怀疑探针**这条又用上一次）。

### 第十四波：把"推断"换成读数（活窗口按压、状态覆盖、构建产物、companion 衬底）

**① 按压在真窗口量到了。** 上一轮那条"没动"是探针的假阴性：**收起的 `<details>` 不渲染内容，可 `getBoundingClientRect` 还给一个 154×2157 的盒子**，于是按坐标落下去命中的是压在上面的星图节点。修法是探针自己加一条硬断言——中心点 `elementFromPoint` 不是目标就报"未按到目标"，**不许把"没按到"报成"无按压"**。修完在活窗口逐个真鼠标按：`.v3-goal-filters button` / `.v3-goal-row` / `.objective-quest-node` **全部 0.960**，负对照 `.nav-chip` 1.000。同一批也在离线重放上（名册展开态）复算，两边一致。

**② 状态覆盖从 11 屏扩到 12 屏，并把整批改动重证一次。** capture 现在每屏先把 `<details>` 展开，另外采两态：**理解/空态**（往搜索框灌一个必无结果的串，让 `v3-goal-list__empty` 真渲染）与**理解/详情**（点开第一行进 `task-surface--objective-detail`）。效果：之前零覆盖的 9 个类里 **7 个真进了读数**（`__empty`、`v3-next-action__text/label/verb/why/go`、`v3-section-heading`）；仍量不到的只剩 2 个——`v3-action-error`（要一次真失败的动作，会写脏数据）与 `v3-goal-list__paging`（要第二页数据）。然后**把本轮三处改动整体还原**（去重前的 `approved-surfaces.css`、无按压段的 `objective-flow.css`、`outline:none` 的原句 `hud-surface.css`）跑 `batchpre`，再换回现版跑 `batchpost`：`resrc` 报**恰好这 3 张样式表变化**（approved 269→265 条块、flow 473→475、surface 同块数只改一行），12 屏 × 8 组合 **9,008 条读数 diff = 0 处差异**。

**③ 构建产物验过了，而且没碰共享的 `out/`。** `npx electron-vite build --outDir dist/verify-batch`（注意它按 renderer 根解析，真实落点是 `src/renderer/dist/verify-batch/…`，两份都在 gitignore 的 `dist/` 下，验完已删）。产物 CSS 1,052,463 字节里能直接找到那两条：`.hud-surface button.source-sheet:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }` 与整条 `:is(.v3-goal-filters button, .v3-goal-row, …):active:not(:disabled)`；`out/renderer/assets/*.css` 的 mtime 仍是 00:25，证明并行会话那份实例没被我换掉。

**④ companion 那三条衬底 token 收了，代价说清楚。** `--companion-ivory`/`--companion-cream` 各在 `companion-hud.css` 里字面量写了 3 次（`:root` 段、`.companion-history`、`.companion-hud__edge-panel` 三处作用域——它们是**portal/抽屉各自补变量**的正常形状，不该合成一处，但该只有一份值）。已把 6 条声明改成 `var(--hud-paper-light)` / `var(--hud-cream)`。这条**不是** 0 差异能盖住的事：那两个作用域里的元素在我 12 屏冻结集里一个都没渲染（抽屉要人点开，我试了两条路都没稳定开成），所以对拍只证到"别的元素一点没动"。真实代价用合成夹具量出来：消费者底色从 `rgb(255,249,233)` 变 `rgb(255,249,235)`、`rgb(255,241,207)` 变 `rgb(255,242,207)`，**蓝/绿通道各差 1–2/255**，与 §第九波收 `--paper`（Δ2,2,0）同档；夹具同时证明别名在 `.companion-history` 与 `.companion-hud__edge-panel` 里**解析得到、不落空**（这是这类改动唯一会真出的事）。

**⑤ 全量测试现在不是绿的，但那不是我的。** 最新一次 `npm test`：**173 文件 / 1,451 条 / 10 红**，红集中在 `src/main/desktop-ipc-note-doc.test.ts`（7 条）与 `companion-home-cue.test.ts`（3 条），两份都在并行会话的在途改动里（`git status` 显示这两个模块与 `desktop-gateway.ts` 同为 M 态），且**都不读 CSS**。归因是量出来的，不是推的：把我对 `companion-hud.css` 的改动**整个还原**再单跑那两份伴星用例，**同样 8 红 14 绿**；grep 两个测试文件对 `.css` / `--companion-` 的引用数为 0。我自己的 CSS 侧守卫（`objective-flow-css-guard` 15 条、`objective-progress-band-guard`）保持绿。
- **这一轮的结论要落到契约里，否则下一轮会被推翻。** `DESIGN.md` 补/改了四处，都是"量出来的、别人会重新吵一遍的东西"：**① 按压与抬手成对**（母本 `hud-pages.css:159/160`：`translateY(-2px) scale(1.02)` 与 `scale(.96)` + `transition-duration:110ms`）——全文此前对 `:active` 一个字没写，所以这一轮我在三个地方各自补了一遍，必须有个唯一出处；**② 药丸形是"岛状控件与 chip"的既成语汇**，原句"药丸形只保留给右上沉浸控制岛与首页深色岛"比实测窄（目标链路筛选 chip `objective-flow.css:214`、`objective-mode-badge`、`learning-run-journey__state`、收起态名册把手都是），不改写就会被"统一成抖动圆角"；**③ V2 切角"仍有约 20 处"作废**，按四角形状的 computed 赢家量是 **0 处**（那个 20 是文本级统计，把被后层覆盖的也算进去了）；**④ `styles.css` 那 10 条衬底已是指向 `--hud-*` 的别名**（原文还写着 `--paper #f7ecd5`、`--accent #bd5b2d` 这些收回前的旧值），并把**星图两份调色板是有意变体、那句"同值"注释是假的**写进 Colors，免得下一个读者真去对齐。



### 第十五波：把"按压成对"从一条口头结论变成 9 个可数的读数

`scripts/tmp-hud-press-pair.mjs` 第一版报 19 条违例，**这个数不能用**，两处都是判据自己瞎：
① `:is(:hover, :focus-visible)` 被逐伪类剥掉后留下 `.hotspot:is(` 残骸，同一基认成两个 → 改成先反复摘最内层函数式伪类再摘简单伪类；
② `:active` 与 `:hover` **本来就写在不同媒体上下文里**（母本 hover 在 `@media(hover:hover)` 内、`:active` 在外面，`hud-pages.css:159` vs `:160`），按媒体配对会把这些合法配对全判成违例 → 配对只看基选择器，不看媒体。
修完：**可按压宿主上的 hover 抬升 21 处，配不到按压的从 19 收到 4**；其中 1 处是作用域写法不同（`.task-surface[data-motion-mode] .settings-ledger__row` 的按压由 `.hud-surface :is(.settings-ledger__row)` 命中），显式列进豁免而不是放宽判据；剩下 2 条在 `companion-hud.css`（交过去）。

**补的这块写在 `hud-surface.css` 末尾**（本文件的 house rule 是只追加），9 个基、数值照母本 `scale(.96)` + `transition-duration:110ms`。过渡不另补：能渲染到的三个用 computed `transitionProperty` 量过，本来就带 `transform`（`[transform, box-shadow, background-color]` 那种），补了反而是我猜的。

**证明分三条，缺一不可：**
- **静态不变**：`W2` vs `W2minus` 9,008 条读数 **0 处差异**。这里的方法改了一次——上一版是"改源文件 → `resrc` → 跑"，今天撞上并行会话**正在连续改 CSS**（同一对比较里 `resrc` 报了 3 张变化、`.objective-expedition` 的上边框在几分钟内 0→5→6px），于是"改前改后"混进了别人的改动。改成**只冻结 bundle 里那一张样式表做增删**（其余 20 张一字不动），比较对象就只剩我这一块。
- **按压真生效**：9 个基里 5 个在 12 屏冻结集里渲染不出来（要笔记带链接、要星图浮层开着…），于是搭合成宿主逐个真鼠标按：**9/9 全部 0.960**。第一版夹具把 `.companion-map-veil button` 直接挂在遮罩下，量出"无按压"——**遮罩本身 `pointer-events:none`，是卡面 `.companion-section-state` 才恢复 auto**（`hud-surface.css:2669/2679`），那是夹具搭错 DOM，不是产品缺陷；照真实嵌套重搭后就按得动了。负结果又一次先救在探针上。
- **守卫会喊**：`hud-substrate-guard.test.ts` 加第三段，把这三份文件里的"hover 抬升必须有配对按压"钉住（范围不含 `companion-hud.css`，注释写明为什么不含）；把我补的那块整体撤掉即红并列出 `.search-command button.tag`、`.note-links button`…，还原后 9/9 绿、文件字节一致。

**最后两个测不到的类也用夹具补上了**（`scripts/tmp-hud-fixture-diff.mjs`）：把 24 个候选类摆进 `.hud-surface`，只换 `approved-surfaces.css` 那一张（改前 `/tmp/approved-surfaces.css.pre-dedup` vs 改后现文件），逐元素比 37 项属性 → **0 处差异**。夹具自带灵敏度对照，而对照第一次是错的：我拿 `color` 与 `padding-top` 做对照，量到 0，差点判"夹具瞎"——其实是修正层 `.hud-surface .c` 以更高特异度把这两条盖掉了；换成没有任何人接手的 `text-decoration-line` 立刻量到 2 处。**"对照量不到"有两种成因，先分清是判据选错还是工具真坏。** 补完之后，那 103 条删除里属于 `v3-action-error` / `v3-goal-list__paging` 的 6 条也从"只有静态论证"变成有读数。

**契约与文档的自洽性扫了一遍**：`DESIGN.md` 点名的 24 个文件按 basename 全仓递归核，找不到的 6 个**都是刻意引用不存在的旧名**（第 11 行说 mockup 已丢失、184 行是我自己那份"这五个名字不存在"的更正），即**真过期引用 0 条**；行号引用无越界。审计文档文首加了"读法"块，明写 §0–§9 里"静态审计/没做 CDP 逐屏量/本轮不动手实施"三句已过期、文中数字是审计当时的，续做入口指到 §10/§11。

**闸门**：typecheck 0 错误，`npm test` **174 文件 / 1,465 条全绿**（含新守卫 9 条）。

### 第十六波：缓动方言（安静文件里最后一类可证的第二真理源）

只挑并行会话没在改的文件动手（判据：`ls -lT` 的 mtime，今天 08:00 之后被碰过的 `companion-hud.css` / `objective-flow.css` 一律不碰）。

**先纠正我自己的粗数。** 第一版脚本按"后 160 字符里有没有 transform"糊判，报 61 条 transition 写literal 缓动；按 `transition` 声明**逐段拆开**看它驱动的是哪个属性之后，真数是 **22 条**；再排掉"只改颜色/透明度"的（读不出手感差，为改而改）之后剩 **8 条**。母本自己的约定也在这一步量出来了：`.button` 写的是 `transform 140ms var(--hud-ease-out), box-shadow 140ms ease, background-color 140ms ease` —— **按属性分档**才是这套房子的写法，`box-shadow … ease` 不是方言，之前差点被我一起改掉。

**收了三个数：**
- **8 条里动的只有 6 条是真控件**（home-v2 岛上的 trigger / actions / region-menu、房间控制岛 trigger、跳过链接、伴星提案卡按钮）→ `ease-out` 换成 `var(--hud-ease-out)`。剩下的 `transform 120ms linear` 是**音量计**（跟着 `--voice-level` 连续走，加缓动会滞后），照 `.settings-voice__track i { transition: none }` 那条已有的 reduce 规则一起保留；home-room 那 5 条属于场景物件、其中一条挂着 Live2D 的 transform，不动。
- **10 条母本曲线的手抄**（`cubic-bezier(.23,1,.32,1)` 写成 0.23/​.23 两种格式）：gate 的 `--gate-ease-standard`、companion-root 与 hud-surface 的动画 → 改成 `var(--hud-ease-out)`；定义处与 `var(--hud-ease-out, cubic-bezier(…))` 这种**兜底写法**保留。
- **24 条同一个"岛形变"曲线的散抄**（`cubic-bezier(.22,1,.36,1)`，hud-surface 16 / home-v2 3 / styles 2 / 其余 3 个文件各 1）：它和 `--hud-island-motion: 320ms` 本来就成对，所以**给它补一个同族 token** `--hud-island-ease`，写在母本 token 行旁边，24 处全换成引用。**没有**把它并进 `--hud-ease-out`——那是岛状控件形变的识别度，属"身份保留"那一侧。
- 顺手按 AGENTS.md 删了一条**零消费者**的 `--hud-ease-drawer`（全仓只有定义那一处，DESIGN.md 也没提过它）。

**证明**：岛曲线单独做一张 bundle 回退（只把 `var(--hud-island-ease)` 换回字面量，改了 6 张、其余一字不动）→ 对拍 **0 处差异**；`computed transitionTimingFunction` 逐个回读确认 token 解析到位（岛 `.home-v2-hud` → `cubic-bezier(0.22, 1, 0.36, 1)`，`.skip-link` → `cubic-bezier(0.23, 1, 0.32, 1)`，`.room-control-trigger` 的 transform 那条腿已是母本、color/bg 仍按母本写 `ease-out`）。9 个被改的 CSS 过 esbuild **0 警告**，typecheck 0 错误，`npm test` **174 文件 / 1,468 条全绿**。DESIGN.md 的 token 表补了 `--hud-island-ease` 一行（含"此前手抄 24 处"的来由）。

**仍留的方言**（都是设计判断，不是重抄）：`cubic-bezier(0.16,1,0.3,1)` ×5、`(.22,.75,.2,1)` ×2、`(.2,.9,.28,1.18)` ×1（带回弹的那条）、`(0.4,0,0.2,1)` ×1（material 标准曲线）。要并成一条得先定"这个应用有几种运动性格"，那是动效取向不是语汇一致性。

### 第十七波：两个地板维度（字号 / 命中区），以及一档根本进不去的 CSS

地板只能在**真引擎算出的盒**上量，文本级统计不行（`padding:0` + 9px 字 = 12px 高的签条，grep 看不出来）。工具：`scripts/tmp-hud-floors.mjs`、`tmp-hud-hit-list.mjs`、`tmp-hud-hit-histogram.mjs`。

**先纠正一个差点报出来的大新闻。** 第一轮量"字号地板"报 30 类低于 8.5px（4-5px 的正文与按钮），看着像大缺陷；但那些读数全在 **700px 宽视口**下——而窗口锁死 `1672:941` 且最小 **1280×720**（`src/shared/window-geometry.ts:8`，`src/main/index.ts:407` 用它），**`@media (max-width:760px)` 在生产里永远匹配不到**。按可达尺寸重测：低于 8.5px 的只剩 4 类 8px 的微标签（`已有版本 · 昨天`、`01`、`主要依据`、`链路已核对`），与母本 `.tag`=9px 同档，不动。
顺带量到一个没写进任何文档的事实：**全仓 `max-width ≤ 900px` 的媒体块正文共 1677 行**（hud-surface 452、universe 358、styles 186、home-v2 136…），渲染层只有一个入口，也就是说这一千六百多行今天**没有一条能生效**。没删——删它等于替产品决定"窗口锁死是不是长期的"，也碰到并行会话在改的文件；只把数写在这里。

**命中区地板量出一个真缺陷并修了。** 可按压元素的房子档位实测：众数 42-44px（`.nav-chip`=43、`.button`=36），小控件一档 24-26px（`.hud-picker__trigger`=24、`.nav-collapse`=26）。低于 24 的只有 8 类，其中：
- **`来源`/`笔记` 的状态签条 `.index-tabs button` 只有 12×25**（`padding:0` + 9px 字），是全应用最矮的可按压元素 → 补 `padding: 6px 0`（只加竖向，文字基线不动），**实测 12 → 24px、第一签顶 y=222 不变**；隔离差分（只把 bundle 里那一处换回 `padding:0`）报 **16 处差异，全是这五个签的 `paddingTop/Bottom: 0px → 6px`**，没有第二件事被改动。
- 其余都判为可接受：19px 的两条（`queue-reason__more`、复习里的行内词按钮）是**夹在句子里的行内文字动作**（DESIGN.md 的"文字动作使用下划线"那一档），加大 padding 会顶开文字流；22px 的那条 `summary` 是 1280 宽整行；24-26px 是房子自己的小控件档。
- 一个量法上的坑要记：差分先跑出 0 处，其实是**对照没改成**（bundle 里是源文本 `padding: 6px 0;`，我按 CSSOM 的 `6px 0px` 去搜）——断言"对照确实改了 1 处"之后才拿到那 16 处。**非空闸门不只管被测输入，也管对照本身。**

**闸门**：9 个改动文件过 esbuild **0 警告**，`npm test` **174 文件 / 1,469 条全绿**（没有一条测试依赖那 12px 的签条高度）。

### 第十八波：零消费者的自定义属性（两版工具各错一个方向，第三版才算数）

起因是撞见 `--hud-ease-drawer` 有定义、没人读。于是普查全渲染层 292 个自定义属性的消费者，**前两版判据都错过**：

- 第一版把 BEM 修饰类当定义（`.button--primary:hover` 里的 `--primary:` 被当成一次 token 定义），凭空报出十几个「零消费者」；
- 第二版把定义位置收紧了，可读取侧只认 `var(--x)` 与 `getPropertyValue("–-x")`，于是把星图调色板整个冤枉了——那份调色板是 **TSX 用 `cssValue(style, "--universe-label", 兜底)` 读的**（`understanding-universe.tsx:319-340`），一次报 25 个假死。这正是我记过的那条：**判「零消费者」要到数据被读出去的那一层去核**。
- 反过来还有一次：我用「字符串出现次数」复核时按**子串**数，`--gate-paper` 被 `--gate-paper-deep/-strong` 连坐，把真死的说成活的说。

最终版 `scripts/tmp-hud-token-readers.mjs` 两条都补：定义必须在声明位置、token 后不得紧跟 `[A-Za-z0-9-]`，读取形态同时覆盖 CSS `var()`、JS 字符串位、内联 style 串。**结论：292 → 12 个零消费者**，其中 2 个属 `prototypes/`（独立评审脚手架，不动）。

**删掉的 31 条声明**（一个 token 在日/昏/夜几档里各有一次定义）：`--control-bg/-text`、`--glass-bg/-shadow`、`--star`、`--wood`、`--gate-focus/-paper/-paper-deep`、`--home-cloth/-paper/-paper-strong/-wood-deep/-theme-duration`、`--home-v2-clay/-focus/-magic/-wood/-paper`、`--companion-focus-ring`。
- `--wood` 是唯一有读者的：读它的是 `prototypes/companion-interaction/src/prototype.css:12` **自己定义自己用**，渲染层那份是孤儿 → 删。
- **留了 8 个并说明理由**：`--hud-berry/-blue/-sky` 是 DESIGN.md 颜色表里点名的调色板位（契约说它们是可选的颜料，不是待清的死码）；`--color-paper/-text/-evidence-soft`、`--universe-accent/-glass/-glass-strong`、`--z-header` 活在同一张被 TSX 读的调色板/移植 token 块里（那块自带注释警告「少一条就静默失效」），单摘三条反而让块不可读。要清的话连着块一起清，那是一次改版不是卫生。

**证明**：把「我删过的那几张样式表」单独退回删除前（其余文件、包括并行会话正在改的 `objective-flow.css` 一律保持现状）再对拍 —— 差异只有 **16 处，全是上一波那 `padding: 6px 0`**（8 组合 × 2 属性），**31 条 token 删除一条都没改到计算值**（零读者本就推得出，但这一步是量出来的，不是推的）。
另外这次对拍一开始报 28 处：多出的 12 处全在 `.objective-brief__hero` 上，同一时间 `objective-flow.css` 从 81,459 涨到 89,207 字节、+34 条规则——那是并行的他们。**归因之后再删噪音，别把自己的改动和别人的混在一个数里报。**

**闸门**：20 个 CSS 过 esbuild **0 警告**，typecheck 0 错误，`npm test` **175 文件 / 1,473 条全绿**。

### 收口指标（本轮结束实测）

| 指标 | 审计时 | 现在 |
|---|---|---|
| 未注册字体名 `"Noto Serif/Sans SC"` | 152 | **0** |
| CSS 总行数 | 22,387 | 20,597（−1,790；含并行会话这一轮的增减，只报实测值） |
| 焦点环写法 | 30 种 | `3px solid var(--focus)` 44 处 + 非焦点状态描边 4 处 |
| `data-outcome` 的 CSS 接手 | 0 | 13 处选择器 |
| `--v3-*` 第二真理源 | 18 条 | 0 |
| 门禁 V2 切角 | 5 族 | 0 |
| **全站 V2 切角（按四角形状实测级联赢家）** | 7 处真生效 | **0** |
| **逐屏活体扫描（10 个入口）** | — | 7 屏零命中；余 5 处经核为判据假阳性或探针序列化问题 |
| CSS 解析警告（esbuild 全量） | 2 | **0** |
| `objective-flow-css-guard` | 5 红 / 10 绿 | 15 绿（两条 P15 断言各做过变异，见上） |
| **两个地板维度（真引擎算盒）** | 30 类小字 / 8 类矮命中区（粗测） | 小字只剩 4 类 8px 微标签属房子档；命中区 1 处真缺陷（状态签条 12×25）修到 24px，其余 7 类判为可接受 |
| **`max-width≤900px` 媒体块** | 从没量过 | **1,677 行今天不可能生效**（窗口锁死最小 1280×720）；未删，属产品对窗口策略的决定 |
| **零消费者的自定义属性** | 从没核过（292 个 token） | **12 个**：删 31 条声明（对拍 0 处来自删除），留 8 个调色板位并写明理由 |
| **缓动方言**（按 `transition` 逐段拆属性后统计） | 61 粗数 / 真数 8 条会动的 | 6 条收进母本曲线；另收 10 条母本曲线手抄 + 24 条岛曲线手抄（新增 `--hud-island-ease`），删 1 条零消费者 token |
| **hover 抬升却按不动的可按压宿主** | 19 处（判据修好后重测） | **2 处**，都在 `companion-hud.css`（已交过去）；补的 9 个基合成宿主逐个真鼠标按 **9/9 = 0.960** |
| 全量测试 | — | **174 文件 / 1,465 条全绿**（含新增守卫 9 条） |
| **旧代被修正层覆盖的裸单类声明** | 103 条 | **0 条**（删完复跑扫描器报 0，幂等） |
| **逐元素 computed 对拍（8 组合 × 11 屏）** | — | 8,320 条读数，去重批次 **0 差异**、按压批次 **0 静态差异** |
| **B7 抖动圆角与奶油粗边是否成对**（按计算值量渲染中的成块面） | "222 有角无边 / 2 有边无角"（文本级分类，作废） | 粗边 ≥3px 的成块面 **15 类，四角全同值的 0 类** |
| **本链路按下去不动的控件** | 3 类实测 1.000 | 3 类实测 **0.960**（撤掉改动复测回 1.000；活页面只复核到"规则确实在样式表里"） |
| **键盘焦点环普查（真 Tab，11 屏）** | 未做过 | **977 次停留 / 3 类无环** → 1 类是真缺陷已修（来源行），2 类经核为有意（skip-link 滑入、卡叠环由 JS 门控并在活页面复核到环） |
| 新落文件复扫（字体 / 死选择器 / 双代钩子） | — | 字体 **0**、`.desktop-app … .hud-surface` **0**、双代钩子 6 处（交过去） |

**这一轮结束时的闸门状态**：`npm run typecheck` 干净、20 个 CSS 过 esbuild **0 警告**、`npm test` **172 文件 / 1,438 条全绿**（焦点环那条改动之后复跑仍是全绿）、级联对拍三批次各 8,320 条读数（去重 0 差异 / 按压批次 0 静态差异 / 焦点环修复后 0 静态差异，全部配双向变异或非空闸门）。
**这轮**故意没跑 `electron-vite build`：它会重写共享的 `out/`，而并行会话正用 `electron .`（读 `out/`）起实例做他们那批验收——在他们改动落地时把我这份半成品主进程塞进 `out/` 不算我的收益、算他们的风险。CSS 侧的正确性由 esbuild 解析 + 真引擎重放 + 全量测试覆盖，不依赖这次构建。


### 交给并行会话的一条

**这一轮新增两条，都带得出冷启动的事实：**

1. **`approved-surfaces.css` 里那 24 个 `v3-*` 类还剩 302 条声明在给画面出力**（`.v3-goal-row` 41、`.v3-goal-filters` 32、`.v3-goal-list` 37、`.v3-goal-focus__action` 23…）。它们不再是"被覆盖的死抄"——上一波按"裸单类 vs 恰好 `.hud-surface .c`"的判据能删的 103 条已删干净（复跑扫描器报 0）。剩下的要逐对判复合选择器，而且 `WorkspaceLibrarySurface.tsx:525/630/665` 现在是 `v3-*` 与你们新起的 `objective-expedition__* / objective-brief__*` **两代钩子并挂**，所以"旧代并入新代"是那条链路的改版决定，我没替你们做。重放工具在 `apps/desktop-client/scripts/tmp-hud-oracle.mjs`（`capture` 冻一屏 DOM + 全部样式表 → 改 → `resrc` → `run` → `diff`，8,320 条读数比对，灵敏度/可重复/非空三条闸门都写在文件头）。
2. **`.objective-expedition__tabs button`（`objective-flow.css:586`，紧凑档三格 tab）没有按压反馈**，我没并进本轮那张 `:is()` 清单，因为那是你们正在改的对象。要接就照本轮那两行的写法：`transform: scale(.96); transition-duration:110ms` 成对补（母本 `.button` 的值），别只补 `:active` 不补过渡——那几个控件原先一条 transform 过渡都没有，`scale` 会瞬间弹到位，读起来是"跳"不是"按"。

3. **`companion-hud.css` 里有两条 hover 抬升没配对按压**：`.companion-hud__controls > button`（两条 hover 规则：`:not([data-active])` 那档与 `[data-active]` 那档，`companion-hud.css:1604` 与 `:1609`）。我这份新守卫 `src/main/hud-substrate-guard.test.ts` 第三段暂时**不含这个文件**（你们在改它），补完按压后把文件路径加进 `SCOPE` 数组即可，不用改判据。修法是同一形状：`transform: scale(0.96); transition-duration: 110ms;` 成对补，别只补 `:active` 不补 transform 过渡。

（下面这条是第十波时删的 28 条，仍然有效。）本轮按上述判据删掉 `approved-surfaces.css` 里 28 条 `v3-goal-* / v3-objective-*` 规则，其中 **`.v3-goal-pulse` 在 31 号文档 P8 里还是活的**（"三个计数压在最底部 y=675"），说明列表页那块最近刚从 JSX 摘掉了。若那边的新一轮改动又把这些类名放回去，样式已经不在了 —— 用 `git log -p -- apps/desktop-client/src/renderer/src/components/approved-surfaces.css` 可取回，或直接重跑检查器确认当前存活集。

**（第十波时的）闸门状态**：`typecheck` 干净、`electron-vite build` 成功、全站 CSS 过 esbuild **0 警告**、`vitest run` **166 文件 / 1391 测试，1389 绿 / 2 红**。

**那 2 条红的真实归因（我先说错了，这里更正）**：我第一版把它记成"并行会话正在改的 `source-detail-surface.tsx` 的传递依赖"。实际报错是
`RangeError: Can not convert <paragraph("正文一句话") to a Fragment (looks like multiple versions of prosemirror-model were loaded)`
——这是**已知的依赖布局问题**：`node_modules/prosemirror-model`（顶层真实目录，1.25.11）与 `node_modules/.pnpm/prosemirror-model@1.25.11/…`（`@milkdown` / `y-prosemirror` 走的那份）**同版本两个实例**。仓库根同时存在 `package-lock.json` 与 `pnpm-lock.yaml`，混装是来源。与本轮 CSS 工作无关，也与他们的改动无关。

我试过两条**不动 node_modules** 的修法，都不够，已回退（不留一段声称能修却无效的配置）：
1. `resolve.dedupe: ['prosemirror-model', …]` —— 无效。
2. 再加 `test.server.deps.inline: ['prosemirror-model']` —— 仍无效。
原因：vitest 对 node_modules 走 SSR 外部化，`y-prosemirror` 的 `require` 根本不经过 vite 的解析层，所以任何 vite 侧 alias/dedupe 都管不到它。**真正的修法只剩依赖层去重**（一次 `pnpm install` / 删掉顶层那份真实目录），而那会波及正在跑的并行实例，属于要单独点头的动作。留作待决。

### 仍未做（截至本轮结束）

1. ~~`approved-surfaces.css` 里那批手写按钮的收编~~ → **按量的结果拆开处理**，见 §第十二波：药丸形不是缺陷（同链路 `objective-mode-badge`、母本 `.home-v2-hud__actions button` 都是药丸，改成抖动圆角反而更不统一，这条我驳回自己的写法）；真缺的按压已补齐并双向变异验过。**仍留一项**：`.v3-goal-list__paging button` 的"加载更多"今天是无边框无底色的粗体文字（`objective-flow.css:238` 覆盖掉了旧代的 1px 边框与奶油底），它要不要抬成一颗纸面按钮，是那条链路的层级判断，不是语汇不一致，我没替他们定。
2. ~~双 class 的结构性去重~~ → **已做可证的部分**，见 §第十一波：判据换成"引擎算的结果"之后删掉 103 条，8,320 条 computed 读数 0 差异；剩余 302 条属于改版而不是卫生，已连同重放工具一起写进上面的交接。
3. ~~`styles.css` 旧 token 近义重复~~ → **已做**，见 §第九波：10 条衬底收回 `--hud-*` 并在真窗口逐个验过计算值；`--focus` / `--accent-deep` / `--sage*` / `--glass*` 属独立语义，保留。
4. ~~`image-lightbox--card`~~ → **已修**，见 §第八波：card 变体此前等于没实现（portal 到 body 后 `absolute` 铺满视口、`inherit` 继承 0 圆角），已改为只在全屏形态 portal，并补了可反证的挂载点断言。
5. ~~`prosemirror-model` 双实例去重~~ → **已修**，见 §第十波：测试侧显式 alias 到 y-prosemirror 实际链接的那份 realpath，**未动共享 `node_modules`**；此前那句"只剩依赖层去重"是以偏概全，已就地更正。
6. **Δ≤3 通道的近义局部 token 还剩 23 处未收**（`tmp-hud-resweep.mjs` 列得全）。已收的是 `styles.css` 那 10 条衬底（§第九波）与 `--quest-*` 衬底（§第七波）。**这轮故意没动的三类**：`--companion-ivory/-cream`（Δ0,0,2 / Δ0,1,0，在并行会话正在改的 `companion-hud.css` 里，同一张表出现三次）；`--gate-*` / `--home-v2-*` / `--log-*` / `--cgp-*`（Δ1–3，各自带"更深的墨 / 更暗的纸"语义，属于本审计自己定的**身份保留**那一侧）；星图那 6 个与 `--hud-star`/`--hud-gold` **逐字节同值**的字面量（第十三波量过：那张表整体是有意变体，单独把 6 个改成 `var()` 只会让一张表一半引用一半字面量）。要收 companion 那三条，判据与做法照 §第九波，别另起一套。：测试侧显式 alias 到 y-prosemirror 实际链接的那份 realpath，**未动共享 `node_modules`**；此前那句"只剩依赖层去重"是以偏概全，已就地更正。全量测试首次全绿（171 文件 / 1425 条）。
7. **`max-width ≤ 900px` 的 1,677 行紧凑档 CSS** 在锁死最小 1280×720 的桌面端永远匹配不到（第十七波量的，渲染层只有一个入口）。按 AGENTS.md 这种没有有效调用方的链路该整条删，但删它等于替产品宣布「窗口最小尺寸是长期决定」，还要动 8 个文件（含并行会话在改的）。要删就连 `@media (max-height: 520px)` 那档一起量、一起删；先拍板窗口策略。
8. ~~D 组"无生产者"的死样式没删干净~~ → **我名下的删完了**，见 §12 第二十波：`home-room.css` 106 → 10 条、`styles.css` −6、`hud-surface.css` −5、`approved-surfaces.css` −5，每批都有引擎对拍 0 差异 + 灵敏度对照。**剩 37 条按用户划的线没动**（理解/学习链的 `objective-*`/`learning-run*`/`card-*`/`goal-stack`，以及 ProseMirror 运行时注入的 `ProseMirror-selectednode`/`tableWrapper` 这类不是 TSX 产的类），列单命令写在 §12「交给并行会话」第 3 条。

### 已驳回的审计条目

**我自己这条审计的写法也要驳回一半**：待决第 1 条原文把 `approved-surfaces.css` 那批控件写成"`1px` / `border:0` / **`999px` 各形态**"，言下之意是药丸形不合规。量的结果是反的：`objective-flow.css` 早把 `.v3-goal-filters button` 重写成药丸，而同一条链路的 `objective-mode-badge`、`.learning-run-journey__state`、`objective-expedition__index:not([open])`、以及**母本自己的** `.home-v2-hud__actions button`、`.room-control > button.room-control-space` 全是药丸——药丸是这个应用里"岛状控件 / chip"的既有语汇，把它们改成抖动圆角才是制造不统一。DESIGN.md:126 那句"不要把容器改成统一大圆角或药丸"管的是**纸面容器**，不是 chip。未改形状，只补了缺的按压（§第十二波）。


`source-library-surface.tsx:626` 的内联 `rgba(255,255,255,.18)` 分隔线：核实容器后确认它落在 `.capture-strip`（`background:#344538` 深绿）上，**深色带上用浅色细线是对的**，换成暖棕的 `--hud-line` 反而看不见。未改。

## 11. 守卫（2026-09-23）：把这一轮判据变成会喊的东西
前面每一波都靠我手跑对拍，那东西活不过一次会话。补一份仓库自带守卫 `src/main/hud-substrate-guard.test.ts`（6 条），钉两件"改一次就静默退回"的事：

1. **旧代不许再抄一份被修正层吃定的声明**（§第十一波那 103 条的形状）。**正对照**用一份合成 CSS：`.v3-demo{color}` 对 `.hud-surface .v3-demo{color}` 必须报，而对手写成 `.hud-surface .v3-demo[data-outcome]`（带附加条件）**不许**报——这一条同时钉住判据的方向，防止守卫越扩越宽把合法情况也算成违例。
2. **衬底 token 必须是 `var(--hud-*)` 引用**：`styles.css` 10 条（§第九波）、`--companion-ivory/-cream` 各 3 处（§第十四波）、`--quest-*` 衬底 6 条（§第七波）。**只看基础档**——夜间盘是逐条重新赋值的，那是设计不是分叉。

写这份守卫的过程本身抓到三个东西，都记下来，因为它们就是"静态守卫天生绿"的三种形状：

- **文件开头的 `@import` 会把后一条 `:root` 粘成一条 @ 规则**，于是 `styles.css` 那 10 条衬底**一条都没读到**，而断言"当前树里全是引用"照样绿。抓住它的是我照例配的"判据读到了多少条"非空断言（读到 12 而不是 22）。
- **`@media` 里的规则整段没被读到，而且 after-media 的部分被污染**：写 `@media` 时把整块消费掉了，收尾那个 `}` 于是被当成"弹出一层"，弹掉了**本来就没入栈**的上下文——结果是第一条 @media 之后的所有顶层规则都挂着那个 @media 的条件。**这正是"文件末尾重抄一条"测不出来的原因**（我先在文件顶部变异，红了；换到末尾，绿了——同一个违例、两种结果就是判据坏了）。改成递归 + 字符串感知的花括号配对后，末尾变异红、`@media (max-width:1201px)` 两侧成对变异报出 `v3-goal-list#margin@…`、单独只改一侧仍判"合法"。
- 变异全部跑完即还原，三份 CSS 与变异前**字节一致**（`diff -q` 逐个核过），树上没有 `变异`/`MUTANT` 残留。

最新全量：`npm test` **174 文件 / 1,454 条全绿**（含这份守卫）。前一次跑还红着的 10 条（note-doc IPC 与伴星 cue）是并行会话在途的改动，这一轮复跑已经绿了 —— 顺带说明为什么我上一轮坚持"红要先归因再动手"：那 10 条不是我造成的，我也不该去修。



## 12. 对账（2026-09-23）：每一条审计结论现在的判定，以及定它的那一个读数

> "都做完了吗"不该由我口头回答。这张表把 §2–§6 的每条条目与 §8 的每条"静态定不下来"对到现状。
> 第三列**必须是读数**（哪个命令、量到什么数），不是"我觉得"。读数出处要么在 §10 对应那波的"证明"段，
> 要么在 §12 末尾第十九、二十波里现量。

| 条目 | 判定 | 靠什么读数 | 还欠什么 |
|---|---|---|---|
| A1 未注册字体名 | **已修** | `document.fonts` 只注册两个带 `Variable` 的族名；复扫源与产物 `"Noto Serif/Sans SC"` 0 残留 | — |
| A2 双 class 夜间选择器永不匹配 | **已修** | 产物里 `.desktop-app[…] .hud-surface` 0 命中；真窗口翻 `data-theme` 后 `--quest-ink/paper` computed 跟着翻 | — |
| A3 portal 掉 mint | **已修** | `document.body` 下合成宿主，`--companion-mint/-strong` 都解析出值，芯片 computed 对得上 | — |
| A4a/A4b 注释吞 CSS | **已修** | 20 个 CSS 过 esbuild **0 警告**（审计时 2 条）；esbuild 与 PostCSS 对同一份文件一致 | — |
| A5 `--hud-green` 双声明 | **已修** | 声明次数 1（`#66816a`），`#556c55` 只作为历史值留在 DESIGN.md 一句说明里 | — |
| A6 `data-outcome` 无接手 | **已修** | `objective-flow-css-guard` 15 绿（原 5 红），13 处选择器接手，两条新断言各做过变异 | — |
| B1 奶油描边基色 | **已收** | ≥3px 厚边 62 处同一基色、1 处例外（经核为深色带上的浅色线）；`tmp-hud-rim-computed.mjs` | 1px 细线是否全抬成 3–4px 是版面密度决定，不是语汇分叉 |
| B2 焦点环 30 种 | **已收** | 合同写法 `3px solid var(--focus)` **45** 处；真键盘 Tab 普查 977 次停留，3 类无环 → 1 类真缺陷已修、2 类经核为有意 | 非合同的 5 条 outline 逐条看过宿主：都是**状态描边**（模态内虚线、`aria-pressed` 选中、reduce 下的注意环、ProseMirror 选区），不是焦点环 |
| B3 阴影四套 | **部分** | 315 条 `box-shadow` 声明：**123 条引用 `var(--…)`、192 条自写字面量（去重 151 值）**；字面量最多 hud-surface 43 / hud-pages 29 / companion-hud 21 / gate 17 / home-v2 13 | **等一个设计决定**：哪些字面影并进 `--hud-shadow*`。三个近义 token（`--quest-shadow*`、`--universe-ac-shadow`）已别名，剩下的不是笔误 |
| B4 控件母本没被复用 | **部分** | TSX 挂母本 `.button` 127 处；CSS 里"选择器含 button 且同时声明 background+border"的自绘规则 **88 条**（hud-surface 35、companion-hud 16、home-v2 10…） | 按压那一半已收并被守卫钉住；**整只控件换成母本**是逐控件改版，且 35 条里多数在两份热文件里 |
| B5 主按钮极性反 | **已修** | 合成门禁宿主 computed：底 `rgb(232,149,104)`、字亮度 48 vs 底亮度 163 → 浅底深字 | — |
| B6 `--v3-*` 第二真理源 | **已删** | 产物里 `var(--v3-` 0 残留 | — |
| B7 抖动圆角只有一半 | **已收** | 只量真渲染且 computed 粗边 ≥3px 的成块面：15 类，**四角全同值的 0 类** | — |
| B8 降级半套 | **已修** | 全站 Off 兜底 1ms + `iteration-count:1`；`v3-spin` 不再每秒千圈；伴星两处 portal 死选择器改读 `data-motion` | 本轮又删掉 `home-room.css` 两条空的 lite/off 占位规则（占位即空实现，按 AGENTS.md 不留） |
| B9 冷色泄漏 | **已判定** | 19 处冷色逐条看完，1 处收（`#79cedc` → `var(--hud-star)`），其余落在 Warm-First 的豁免（伴星、星图、夜间冷光）或有意变体 | 灵动岛"需要留意"状态灯 `#ef9675` 与 `--hud-peach` 差 13 通道——三颗灯是一族，动一枚要动一族，留给动效判断 |
| C1 门禁整块 | **已接入** | `desktop-access-gate.css` `var(--hud-*)` 5 处、V2 切角按四角形状实测 0 处、主按钮极性见 B5 | 昏（dusk）档仍是整套替换，本审计认它的理由 |
| C2 home-v2 弹窗 | **部分** | `home-v2.css` `var(--hud-*)` 13 处；四值圆角 8 处中**母本双轴斜杠形状 4 处** | 另 4 处是岛/灯的自有形状；再收要逐处判断 |
| C3 页 14 无夜间分支 | **驳回（实测）** | night 主题下量任务纸 computed：`day-route`/`study-card`/`notebook`/`marked-paper`/`search-desk` 全 `rgb(255,242,207)`，`claim-sheet` 235 | 没有欠账：这个产品不做逐页转暗，`.night-paper` 是另一套显式面 |
| D `home-room.css` | **本轮删完** | 106 → **10 条规则**、22,534 → 3,083 字节；两把尺 + 引擎对拍（§第二十波） | 无 |
| D `home-room-life.css` / `SurfaceCalibrator.tsx` | **已删** | 前几波；`main.tsx` 的 import 同步去掉 | 无 |
| D `styles.css` 176 条无生产者 | **部分** | 同判据两把尺：本轮删 6 条，**剩 27 条**；`approved-surfaces.css` 208 条规则里剩 1、`hud-surface.css` 1,281 里剩 9 | 37 条**故意没删**：理解/学习链（`objective-*`、`learning-run*`、`card-*`、`goal-stack`）与 ProseMirror 运行时注入类（`ProseMirror-selectednode`、`tableWrapper`…）。列单一条命令：`node scripts/tmp-hud-homeroom-prune.mjs --file <css>` |
| D 结构性根因（双代并挂） | **已删可证部分** | 修正层覆盖的旧代裸单类声明：103 条（§十一波）+ 本轮 5 条 = **0 剩余**（守卫 `hud-substrate-guard` 第一段现绿） | 他们新写的 `.hud-surface .v3-goal-*` 又让 5 条旧代变成"被吃定"，我按同一判据删掉了；再发生由守卫喊 |
| E DESIGN.md 自己过期 | **本轮改正** | 脚本比对：文档里 69 个 token 名 / 36 个色值逐个去代码里找 | 现在"查无"的名字全部在文档里被明说成"不存在/已删/历史值"，见第十九波 |
| §8-1 A4b 浏览器拿到哪份 | **已定** | esbuild 与 PostCSS 一致、0 警告；构建产物与源同集合 | — |
| §8-2 字体实际渲染 | **已定** | `document.fonts` + 标题 computed `"Noto Serif SC Variable"` | — |
| §8-3 每个控件焦点环 | **已定** | 真键盘 977 次停留普查（§十四波） | — |
| §8-4 计数≠生效次数 | **大部分已定** | 关键几条换成计算值：描边 15/0、切角 0、按压 9/9=0.960、衬底别名逐条 computed | B4 的"按钮 13 种"仍是源码级统计，没逐只量过 |
| §8-5 删除安全性 | **已定** | 三把尺（去注释源码 + 24 万条真窗口元素身份 + 全仓非 CSS 源码）；本轮删除引擎对拍 0 差异 | — |
| §8-6 `image-lightbox--card` | **已修** | §第八波：改形态挂载点 + 可反证断言 | — |

**一句话结论**：A 组全清、B 组 6 清 2 部分 1 判定、C 组 1 接入 1 部分 1 驳回、D 组我名下文件只剩**故意留给他们的 37 条**、E 组本轮对上。**真正的"没做完"集中在三件需要别人判断的事**：阴影字面量收敛（B3）、控件整只换母本（B4）、以及那 37 条属于理解/学习链的死样式。

### 第十九波：把 `DESIGN.md` 与代码对账（E 组收口）

做法很笨但有用：脚本把 DESIGN.md 里出现的**每个 `--token` 名**与**每个 6 位 hex** 拿去渲染层源码里找，找不到的逐条看是真过期还是历史陈述。量到 **69 个 token 名里 14 个查无、36 个色值里 9 个查无**。

其中三处是**我自己上一波造出来的过期**：第十八波删掉零消费者 token 时删了 `--wood`、`--star`、`--control-bg/-text`、`--glass-bg/-shadow`，但没回头改文档 —— 文档还在用现在时介绍它们（"`--glass-*` / `--control-*` 是深色浮层…`--wood`、`--star`"）。**改 CSS 的人不会自然地去改文档，所以对账必须是命令，不是自觉。**

改正清单（8 处）：
1. §Colors 旧代 token 段：改成"`styles.css` 里仍自持值的只剩 6 条"，并把删掉的 6 个名字连原因写清。
2. §Colors 夜间段：`styles.css:131` → 实际 `:135`，且夜间块现在**只覆盖 `--focus`** 一条（`--control-bg` 已随删除消失）。
3. 同段末尾那句"页 14 至今没有任何夜间分支，这是已知缺口" —— 与本文 §10 对 C3 的实测驳回**直接矛盾**，改成"夜间任务纸一律奶油色"的量。
4. §Colors 首页段：`--home-paper`/`--home-cloth` 那套整条作废（连带第二十二波把 `home-room.css` 删干净），改成"首页现在只有 `home-v2.css` 自带 4 条局部 token、10 处读者"。
5. `--star: #73cadc`"两者待收敛"→ 已收敛，只剩 `--hud-star`。
6. §Elevation 的 `--shadow-lg`/`--shadow-md`：这两个名字**从来没有实现**，而同一段 §64 又说它们不存在 —— 文档自己打架。改成 `--hud-shadow`/`--hud-shadow-small` 与代码里的真实值，并把 B3 的 315/123/192 计数写进去当未决代价。
7. §Companion 的"气球"那条：以前写 `#fff6e2 → #fbeacb` 渐变 + 双描边 + 四档语气，实测现在**没有渐变**（平涂 `--hud-cream`）、描边是 `1px --hud-line` + 3px 奶油环、圆角 `24 27 8 24`、**只有默认与 `--touch` 两档**。
8. 同节"玻璃"那条：底不是 `rgba(20,22,24,.7)` 而是 `--companion-glass: rgba(11,33,48,.85)`，盘边不是 1px 暖白而是 `--companion-plate-border: 3px solid rgba(255,252,235,.62)`；"薄荷 `#a8d59a` 主行动 / 蜜桃 `#ef9675` 录音中"在 `.companion-center` 里**一处都搜不到** —— `#ef9675` 是首页灵动岛的状态灯（`home-v2.css:179`），跟录音无关。

**收口判据（可重跑）**：DESIGN.md 里每个 token 名/色值要么在代码里 grep 得到，要么在文档里被明说"不存在/已删/历史值"。量完的数：**14 个查无名字与 9 个查无 hex 全部落在后一类**。

### 第二十波：死链按"两把尺"删（D 组，我名下文件删干净）

审计 §5 对 D 组三条都只敢标 ◐，因为 §8-5 写过"无生产者可能判错"。这一波把判据做到能删：

- **尺一（源码）**：选择器**主语**（逗号分支各自最后一个带类复合）的每个类名，在 `renderer/src` 的 ts/tsx **去掉注释之后**连子串都没有。
- **尺二（运行时）**：该类名在级联对拍台冻结的**真窗口 DOM** 里从没出现（26 份快照 × 8 组合 × 12 屏 = 246,688 条元素身份）。
- **尺三（仓库级兜底）**：被判死的名字拿去全仓非 CSS/非文档源码里找 —— 找到的 7 个经核全是**截图与冒烟脚本**（`capture-scene.mjs`、`capture-island.mjs`、`smoke-packaged.mjs`）在选择器字符串里，不是 DOM 生产者。
- **拼接兜底**：`companion-bubble--${tone}` 这类模板拼接的修饰类，字面量永远不完整出现 → 13 个拼接基名进保护名单，命中即不删。

三个判据缺陷都是量出来的，不是想到 的：
1. 注释里出现过 `hotspots` 一词 → 整条 `.hotspot` 链被判活（`scene-depth.ts:15`）。→ 去注释再找。
2. 只看"最后一个复合"会漏判**祖先永远配不上**的规则（`.home-catalog .home-recovery`）。→ 逐复合判，任一支有"整组类名无生产者"即该支死。
3. **`:is()` 是"或"**：`.content :is( .source-index, .folio-page, .notebook, … )` 被空白拆成一串"复合"后，其中一个成员无生产者就把整条判死 —— 而 `.source-index`、`.notebook` 都活着。→ union 一律放弃判定（宁可漏删）。改完 10 条对照全过，含"摘掉拼接守卫后 `.companion-bubble--page` 必须翻成判死"这条反向对照。

删了什么：
- `home-room.css`：**106 → 10 条规则**，22,534 → 3,083 字节（`.hotspot*`、`.home-command-deck`/`.rail-action*`、`.home-room-depth*`、`.home-catalog*`、`.companion-whisper*`、`.companion-scale-control`、`--home-*` 表和只服务它们的 3 条 `@keyframes`、2 条空的 lite/off 占位）。
- 第二批不在判据内、靠引擎判：**14 条声明 + 1 条整规则被 `home-v2.css` 的 `.desktop-app[data-home-scene-variant="v2"] …`（`App.tsx:197` 恒成立）逐条盖掉**。
- `styles.css` −6（`.hotspot*` 5 + 夜间 `.action-rail`）、`hud-surface.css` −5（`.home-v2-hud__directory`、`.capture-slot`/`.drop-slot` 4）。
- `approved-surfaces.css` −5：并行会话新写的 `.hud-surface .v3-goal-search`（`:236`）把旧代的 `width/height/color` 吃定，`.v3-goal-list` 的 `overflow-x/y` 同理 —— 这正是 §十一波那条判据的形状，守卫当场变红，删完回到 0 剩余。

**对拍（每批一次，8 组合 × 96 页 × 9,008 条读数）**：home-room 第一批 0 差异、第二批 0 差异、styles+hud-surface 0 差异、approved-surfaces 0 差异。
**灵敏度不是推的**：home-room 第一批一开始连"改 `filter` 值"都测不出反应 —— 因为 `filter` 被 v2 层盖掉、`.window-live2d > button` 又不在冻结 DOM 里，**两次 0 都是假 0**；换成 `filter: … !important` 立刻报 8 处，styles.css 上加一条 `.companion-presence { text-decoration-line: underline }` 报 37 处。对照跑完即撤，文件与撤掉后逐字节 `cmp` 一致。
**归因**：`objective-flow.css` 在他们手里一直在长（本轮 81,459 → 84,599 字节），所以 before/after 两次读数之间**只允许我改的那一张表变**，否则会像上一轮那样报出 1,252 处假差异。

**顺带发现（不是本轮造成的）**：`capture-scene.mjs` 仍在断言屏上有 5 个 `.hotspot-layer button` 并等 `.home-catalog` 可见，`capture-island.mjs` 等 `.action-rail:visible` —— 这些 DOM 早就不产了，这两个 `npm run capture` 侧的脚本**在我动手之前就跑不过去**。删 CSS 不影响它们（它们等的东西本来就没出现），但谁要再用它们得先迁到 Home V2 的钩子上。

**闸门（本轮结束）**：`npm test` **175 文件 / 1,488 条全绿**（含 `hud-substrate-guard` 新增的阈值对照与"已知欠账"断言），`npm run typecheck` 退出码 0，20 个 CSS 过 esbuild **0 警告**，渲染层 CSS 总行数 20,597 → **19,946**。

### 交给并行会话的（更新版）

1. **`--quest-paper: #fff9e9`（`objective-flow.css:214`，`.objective-expedition__index` 那档新纸）与 `--hud-paper-light: #fff9eb` 只差 2 通道** —— 按本文一直用的阈值（1–3 通道算重抄）该写成 `var(--hud-paper-light)`。我没有替你们改，因为那是你们正在写的文件。守卫 `hud-substrate-guard.test.ts` 现在把这一条**钉成"已知欠账"**（`SUBSTRATE_OUT_OF_SCOPE` + 一条断言精确到值）：你们改完之后那条断言会红，红的意思是"把 `objective-flow.css` 加回 `SUBSTRATE`"，不是"把判据改回去"。
2. `companion-hud.css:1604` / `:1609` 两条 hover 抬升没配按压（上一版第 3 条，仍然有效）。
3. 理解/学习链的死样式**一条命令可列**：`node apps/desktop-client/scripts/tmp-hud-homeroom-prune.mjs --file components/hud/hud-surface.css`（把 `--keep` 去掉就会把它们全列出来；当前我名下三个文件共 37 条：`styles.css` 27、`hud-surface.css` 9、`approved-surfaces.css` 1）。判据带 10 条双向对照，改判据前先跑对照。
4. **`--home-v2-ease-out: cubic-bezier(0.16, 1, 0.3, 1)`** 是 `--hud-ease-out (.23,1,.32,1)` 的近邻（Δ0.07/0/0.02），4 处引用。要不要并成一条是动效判断，我没动 —— 但别再新写第四条曲线。
5. 上面那两条 `capture-*.mjs` 断言的 DOM 已经不存在。
