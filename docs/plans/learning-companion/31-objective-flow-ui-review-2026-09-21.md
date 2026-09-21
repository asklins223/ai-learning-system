# 理解目标链路 UI 问题清单与重构方案（2026-09-21）

> 署名：Asklins
>
> 这份文档只谈一条链路：**理解目标列表 → 目标详情 → 作答 → 结算**（含四种作答题型的界面）。
> 所有「现象」都是我在跑起来的桌面端上量出来的（CDP `:9222`，视口 1440×810 @dpr 2），不是读代码推的；
> 少数确实没法量的，我在 §11 单独列成「未量到」，不混进结论里。
> **本轮不动手实施。**

## 0. 一句话结论

这条链路最贵的毛病不是某处不好看，而是**它在「结果」这一环把反馈掐断了**：我把灭火器四步全答对、四条判定全部写着「回忆 · 说清了」，页面同时告诉我「已证明 0 项 / 仍有缺口 1 项 / 还需补上：回忆」，而 `data-outcome` 和 `data-tone` 这两个本该驱动视觉的属性**在整个仓库里没有任何一条 CSS 规则**——答对和答砸是同一张像素级相同的纸。其余问题都围着这个洞长出来：列表页可见文字只占纸面 6.1%、详情页 7.9%，而**详情页 91% 的文本段小于 11px（41 段是 8px）**；提示的扣分说明只有 7.5px；结算页的返回按钮溢出到纸面以下 34px，必须滚动内层列才够得着；作答区同时挂 7 个控件把状态文字挤到 67px 宽折成两行；伴星提示条实测压在「提交回答」上面。所以「没成就感、很公式化、操作逻辑怪异」是三件独立的事同时坏了：**反馈不兑现、层级用字号把重点压平、动作区没有主次**。

## 1. 怎么量的

- **环境**：`apps/desktop-client` dev（`electron-vite dev -w --remoteDebuggingPort 9222`），CDP `:9222`，视口 1440×810 @dpr 2。
- **样本**：工作区 214 条 active 目标，列表实际载入 16 条。真走完的三次作答见 §2.1。
- **脚本**（`apps/desktop-client/scripts/`，gitignore 内，本轮保留当验收工具）：
  `tmp-objflow-lib.mjs`（连 CDP + 几何树 + 截图）、`tmp-objflow-s1-list` / `s2-detail` / `s3-run` / `s7-ordering` / `s9-choice` / `s11-hint` / `s13-formal` / `s16-density` / `s17-density2`（逐屏）、`tmp-objflow-s14-measure.mjs`（结算页溢出与遮挡）。
- **截图与几何落在** `apps/desktop-client/.objflow-caps/`（gitignore 内）。
- **代码位置**以 `apps/desktop-client/src/renderer/src/` 为根。
- **一个诚实的更正**：我第一版密度探针用 `getClientRects()` 直接累加，把滚动视口**以外**的内容也算了进去——列表因此多算了 10 行不在屏幕上的文字，报 6.6%。改成「只算与视口相交、且未被祖先 `overflow` 裁掉」的矩形后：列表 **6.1%**、详情 **7.9%**（`tmp-objflow-s16-density.mjs` / `tmp-objflow-s17-density2.mjs`）。**结算页的填充率我撤掉了**——那一屏的内层列本身在滚（`scrollHeight 727` vs `clientHeight 665`），旧口径必然虚高，而用新口径重测需要再走完结算一次，超出「补到够看为止」的额度。结算页本文只引用不受这个误差影响的**逐元素盒坐标**（P5/P27/P28/P29）。
- **量到一半环境塌了两次**：`CompanionPresence.tsx` 被并发存盘写成 `companionDeliveryReporter is not defined`，Vite 随后掉线（`5173` 拒连、窗口白屏），恢复后窗口被关。这些不是本链路的问题，但导致 §11 那几条没量到。

## 2. 主线：反馈在结算处断掉

### P1 四条判定全「说清了」，同一屏写着「已证明 0 项 / 还需补上：回忆」

- **实量**（`.objflow-caps/78-result-formal.png`，灭火器四步那张卡）：
  - 结算页 `.learning-run-result-rubric` 有 **4 行**，`__head` 全部是 `回忆 · 说清了`，理由分别是「用户明确写出第一步'提'…核心动作准确无误」「第二步'拔'…核心动作准确」「第三步'握'…核心要求完整覆盖」「第四步'压'…符合扫射根部的要求」。
  - 同屏左侧计数器：`用时 00:16 / 已证明 0 项 / 仍有缺口 1 项`；右侧三行账目：`已经证明 → 这次还没有形成可公开的已证明部分。`、`还需补上 → 回忆`、`复习安排 → 本次没有改变复习安排：本次属于练习，不改变复习。`；黄色便签：`接下来 → 先补上「回忆」`。
  - 页面属性：`data-outcome="practice_completed"`、`data-tone="neutral"`、`data-acknowledgement="idle"`。
- **库里读到的原文**（`learning_runs.result` / `learning_assessments`）：`{"outcome":"practice_completed","gapFacets":["recall"],"demonstratedFacets":[],"scheduleImpact":{"kind":"none","reasonCode":"practice_only"}}`，而 `rubric_results` 四条全是 `{"facet":"recall","verdict":"covered"}`；那次判定的 `source=assessment_critic`、`status=completed`、**`trust_class=practice_only`**。
- **为什么算问题**：这不是措辞能救的。UI 是照数据渲染的，数据自己矛盾——四条 `covered` 被折算成 `demonstratedFacets: []` 并且把 `recall` 塞进 `gapFacets`。用户读到的是「你哪里都没证明，但你还欠一次回忆」，而他刚刚把回忆做满了。这就是「做完一点成就感都没有」的字面来源。
- **待后端确认（不在本文范围，但必须一起修）**：为什么一条 `开始首次验证`、作答页明写「证据范围 可形成理解证据」的旅程，判完落的是 `trust_class=practice_only`。合同里有一句直接相关——`23-learning-objective-content-topology-system-rebase.md:556`「当前 LearningRun 由 PREPARE 和 lock-time ledger 决定 `practice_only`，客户端…」，也就是**这个天花板由服务端在锁定时决定，客户端不得自行推断**（`:440`、`:574` 同向）。那么问题就变成：作答页在开跑时显示的「可形成理解证据」是从哪个字段来的，它和锁定后的 `trust_class` 为什么可以不一致。UI 侧至少要做到：**covered 的 facet 不允许出现在「还需补上」里**，两者由同一个源出。

### P2 `data-outcome` / `data-tone` 没有任何 CSS 规则：答对和答砸是同一张纸

- **实量 + 复验**：`learning-run-surface.tsx:1929-1930` 发出 `data-outcome` 与 `data-tone`；对 `src/renderer/**/*.css` 全量 grep `data-outcome`、`\[data-tone` 的结果里，只有 `.home-catalog__ledger[data-tone="attention"]`、`.settings-inline-state[data-tone="error"]`、`.desktop-access-gate[data-tone="danger"]`、`.companion-hud__output[data-tone=…]` 四条无关命中。**结算板一条都没有。**
- **后果**：`已理解` 和 `无法评估` 的区别只有印章里那三个字。10 种 outcome（`outcomeSeal` `:126-134`）共用一套纸、一套绿栏、一套 42px 印章、一套奶油底色。
- **方案**：结算板按 `data-outcome` 分三档视觉温度——成立（`demonstrated`）：纸面转暖金、印章带压印动效、绿栏出现一条从「首次验证」到「现在」的实线进度；部分（`partial`）：已证明部分用绿色列出、缺口用陶土色列出，两者**在版面上分块**而不是同排灰字；不成立（`not_assessable` / `gap` / `skipped` / `declared_unable`）：明确降饱和、不出庆祝、也不出「已证明 0 项」这种伪账目。

### P3 「跳过」和「暂时不会」照样吃一颗 42px 大印章，违反 DESIGN.md

- **合同**：`DESIGN.md:152`「验证印章只出现一次；跳过或声明暂时不会时不显示印章，不做庆祝。」
- **实量**：我点「稍后再做」→ 确认 → 结算页 `__seal` 渲染的是 **`已跳过`**，42px 衬线（`hud-surface.css:5160 clamp(27px,3vw,42px)`），和 `已理解` 同一字号同一位置同一颜色（`.objflow-caps/73-after-skip.png`）。
- **代码**：`learning-run-surface.tsx:1932` 无条件渲染 `outcomeSeal`，`skipped` / `declared_unable` 都在表里（`:126-134`）。
- **方案**：`skipped` / `declared_unable` 时 `.learning-run-result-summary` 换成「安静版式」——不出印章节点，出一行小字说明这次记成了什么。庆祝通道本来就只有一条且已经写对：`learning-run-result-policy.ts:123` 只在 `demonstrated` 时让伴星确认；坏的是**纸面自己发了一个假印章**。

### P4 唯一的「下次到期」反馈永远写着「刚刚」

- **实量 + 复验**：`learning-run-surface.tsx:252-253` `已创建复习安排，下次到期 ${formatRelative(impact.dueAt)}。`；`surface-data.tsx:183-188` 算的是 `minutes = (now - parsed)/60_000`，未来的 `dueAt` 得到**负数**，`if (minutes < 1) return "刚刚"`。
- **后果**：`formatRelative` 是「过去时」函数，被拿去格式化未来时间。任何真实排期（明天、下周三）都显示成「下次到期 刚刚。」——这是结算页上唯一一句关于未来的话。
- **方案**：新增 `formatDue`（`今天 / 明天 / N 天后 / M 月 D 日`），`scheduleImpactText` 改用它；`objective-state-copy.ts` 里已经有「还有几天 / 已到期几天」的写法（`:114`、`objective-state-copy.test.ts` 已钉），复用而不是再造。

### P5 结算页的返回按钮溢出到纸面以下，要滚动内层列才够得着

- **实量**：`.learning-run-result-report` `overflow-y: auto`，`scrollHeight 727` vs `clientHeight 665`；`.learning-run-result-actions` 底边 `y=789`，而 `.learning-run-result-board` 底边 `y=755`——**主出口在纸面折叠线以下 34px**。截图里整块 actions 不可见，右侧有一条内层滚动条。
- **为什么算问题**：结算页的收尾动作（回去 / 看目标）是这条链路的终点按钮，它默认不在屏幕上。用户的第一反应是「这页还没加载完」。
- **方案**：actions 从可滚动的 report 里提出来，钉在结算板底部（和作答页 dock 同一槽位）；report 只滚内容。验收口径：`actions.bottom <= board.bottom - 8`。

### P6 三行否定式连排，唯一的肯定是一句 10px 灰字

- **实量**：`已经证明 / 还需补上 / 复习安排` 三行（`:1950-1959`）在两个空结果里分别是「这次还没有形成可公开的已证明部分。」「这次没有留下待补的理解缺口。」「本次没有改变复习安排…」——**同一屏三句以「没有」开头**。真正的肯定「回忆 · 说清了」在下方 `learning-run-result-rubric`，`__head` 10px、理由 10px。
- **加重项**：rubric 只有 `covered / missing / contradicted` 拿到颜色（`hud-surface.css:5217-5221`），`partial`（「只说清了一部分」）和 `not_assessable` 用默认墨色——**「只说清了一部分」和「说清了」在颜色上几乎无差**。
- **方案**：结算页第一视觉必须是「这次证明了什么」的聚合（条数 + facet 名 + 色带），空态才降级；四种 verdict 各自一个可辨颜色，且颜色之外带一个形状符号（`DESIGN.md:142` 不许用颜色/动画作为唯一说明）。

## 3. 列表页（page-10，`WorkspaceLibrarySurface.tsx:219-451`）

### P7 整页可见文字只占纸面 6.1%，八成文本段小于 11px

- **实量**（`tmp-objflow-s16-density.mjs`，只计视口内未被裁矩形）：`.v3-goal-workbench` = `[88,94,1071,654]`，**可见文字填充率 6.1%**；61 个可见文本段中 **49 段（80%）小于 11px**；字号直方图 `{8px: 24, 9px: 23, 10px: 2, 12px: 3, 13px: 2, 16px: 4, 19px: 1, 26px: 2}`。
- **对照合同**：`DESIGN.md:62`「主要使用 12–15px」，`:63`「元数据使用 9–11px」。**8px 的 24 段直接在合同下沿之外**，且它们不是元数据而是行标题旁边承担识别任务的标签。
- **方案**：整链路设一个 11px 地板（元数据）+ 13px 正文地板，把 8px 全部升上去；升完必然挤，所以 P8/P9 的删减要同批做。

### P8 焦点卡内部 281px 空带，占卡片高度 43%；整页最大连续空白 251px

- **实量**：`.v3-goal-focus` = `[88,94,374,654]`，CTA 底边 `y=393`，计数器 `.v3-goal-pulse` 顶边 `y=674` → **中间 281px 什么都没有**（占 654 的 43%）。整页最长连续空白竖带 **251px，起于 y=436**。
- **同时它还在横向溢出**：`.v3-goal-focus` `scrollWidth 431` vs `clientWidth 366`（**横向被裁 65px**），`scrollHeight 733` vs `clientHeight 646`。
- **为什么算问题**：这张卡是页面的视觉主角（374×654 的绿块），却把「要处理 8 / 进行中 7 / 答对过 1」这三个唯一的进度数字压在最底部 9px（`:375-379`，`y=675`）。主角在空转，进度在角落。
- **方案**：焦点卡改成三段紧凑卡（状态 → 主张 → 下一步），高度按内容走；三个计数提到卡的顶部做成一条进度带（见 §9.1 的「进度语言」）。

### P9 那颗主按钮写着「继续作答」，点了只打开详情

- **代码**：`WorkspaceLibrarySurface.tsx:370-373` 按钮内两行字是 `<small>打开目标详情</small>{primaryActionLabel(...)}`，`onClick` 是 `openObjective(activeGoal.objectiveId)`（`:349-352`，只做 `setActiveObjectiveId` + `invoke("open-objective")`）。
- **实量**：我点这颗写着「继续作答」的按钮，落点是 page-11 详情页（`.objflow-caps/20-detail-focus.png`），不是作答页。
- **为什么算问题**：这就是「操作逻辑怪异」最典型的一处。同一个词在详情页里又是另一回事（详情页那颗真的开始旅程）。**一个动词只能有一个落点。**
- **方案**：焦点卡上两个动作分开——`看详情`（次级文字链）+ `继续作答`（主按钮，直接 `learningRun.start`/`resume`，复用详情页 `startAction()` `:488-526` 那条已验证的链路）。

### P10 16 行右端挤成三种一模一样的药丸，行内 2~4 个 9px 标签互抢

- **实量**：16 行的右端标签分布 `开始首次验证 ×8`、`继续作答 ×6`、`开始到期复习 ×2`；行内 `.v3-objective-tags` 每行 2~4 个 chip，16 行里出现 **22 种不同 chip 文案**（`还没正式答过 ×7`、`正在作答 ×6`、`复习已到期 17 天 / 6 天 / 10 天 / 11 天 / 19 天`、`正式答过 · 昨天 / 12 天前 / 8月20日`、`练过 1 次 ×3`、`应用规则 ×5`、`步骤 ×3`、`关系 ×3`、`边界`、`顺序`、`事实`、`定义`、`因果模型`、`已经答对过`、`到复习时间了 ×2`），全部同一字号（9px）、同一灰底、同一圆角。
- **为什么算问题**：知识形态（`步骤`/`边界`/`因果模型`）是**内容属性**，复习状态（`复习已到期 17 天`）是**时间属性**，作答进展（`还没正式答过`）是**进度属性**，三类混在一排同权重 chip 里，扫视时无法分组；而右端那三个动作词是每行唯一的动词，却做成三个长得一样的次级药丸。
- **方案**：chip 分角色——状态用一个带色点的短语（保留 `objective-state-copy.ts` 的文案与测试），知识形态降成行标题后缀的一个词（不用 chip 容器），到期时间挪到右端动作下方做一行 11px 灰字。右端动作按类型给两种视觉：`开始`（实心）vs `继续`（描边）。

### P11 列表内滚动 + 页面骨架 = 双滚动，最后一行被拦腰裁

- **实量**：`.v3-goal-list` = `[500,223,637,507]`，`scrollHeight 1520` vs `clientHeight 507`——16 行 93px 高的卡装在一个 507px 的内层滚动列里，行与行之间是 1px 横线，视觉上像一整张连续的纸，**看不出这里能滚**。
- **方案**：要么让列表随页面滚（去掉内层滚动），要么给列表一个明确的可视窗口（半截行 + 顶部吸附计数 + 底部「还有 N 条」常驻）。二者都行，别保持现在这种「连续纸 + 隐形滚动」。

### P12 搜索框说「搜索已载入目标」，而标题说「全部理解目标」

- **实量**：标题 `全部理解目标`，副行 `已载入 16 / 16 条`，但服务器 active 目标实际 **214 条**（`learning_objectives_v2` 计数）；placeholder 是 `搜索已载入目标`，输入框只有 190×36。
- **为什么算问题**：同一块纸的标题承诺「全部」，控件承认「只搜已载入」。诚实的那半被藏成 placeholder。
- **方案**：把「载入更多」做成显式动作（滚动到底自动续读 + 顶部计数改成「已在看 16 / 共 214」），或者把标题改成「在看的理解目标」。**别让标题撒谎。**

## 4. 详情页（page-11，`WorkspaceLibrarySurface.tsx:458-637`）

### P13 详情页 41 个文本段小于 9px，主体信息层是 8px

- **实量**（`tmp-objflow-s17-density2.mjs`，修正口径）：`.v3-objective-workspace` = `[401,94,951,654]`，可见文字填充率 **7.9%**；58 个可见文本段里 **53 段（91%）小于 11px**，其中 **41 段是 8px**；整页最长连续空白竖带 **234px，起于 y=458**。字号直方图 `{8:41, 9:5, 10:7, 12:1, 14:1, 15:1, 16:1, 26:1}`——**26px 只有一个（标题），8px 有 41 个**。
- **具体是谁**（`approved-surfaces.css` 行号）：`:242` 状态行 8px、`:246/:249` 标签 8px、`:259/:263/:265/:266` 学习账本三列 8px、`:272/:275/:278/:282/:286-288/:291/:294` 证据清单 8px。`.v3-objective-sheet__header` 实测 8px、`.v3-lineage-boundary p` 实测 **8px/11.6px**（335px 宽的一段完整句子）。
- **方案**：详情页信息量本来就不大（见 P15），把 8px 全升到 11px 之后仍然空，所以先删（P16）再升。

### P14 内容区从 x=401 才开始，左边 313px 是房间背景

- **实量**：列表页内容 `[88,94,1071,654]`，详情页内容 `[401,94,951,654]`。同一个流程里两屏的**左边界差 313px**，纸面宽度差 120px。
- **为什么算问题**：从列表点进详情，纸面整体往右跳，返回时再跳回来。进出场动效（`TaskSurface.tsx:186-330` 的 GSAP）反而放大了这个跳，因为它是按「同一骨架上浮起一张纸」的假设写的。
- **方案**：四屏共用一条内容基线（左边界固定），详情用「列表 + 右抽屉」或「同宽两栏」，不要让 x 轴随页面切换漂移。

### P15 主行动区标题和按钮同词，按钮缩到 98×42

- **实量**：`.v3-next-action` = `[429,251,496,97]`，里面说明块 `[446,264,352,71]`，按钮 `[813,279,98,42]`。说明块里的 `<strong>` 是「继续作答」，按钮文字也是「继续作答」（`WorkspaceLibrarySurface.tsx:553-566`）。
- **为什么算问题**：这一屏唯一该被点的东西被做成一个 98px 的小药丸，贴到 496px 行的最右端；而它左边的标题占用了同一个词。**「现在最值得做」这块黄纸是整页视觉重心，却把决策做小了。**
- **方案**：主行动块整块可点（保留键盘可达），或者把按钮拉到块的右半宽（≥200px），标题换成「这次要做什么」而不是重复动词。

### P16 把工程账本摊给用户看：目标第 0 版 · 状态变更 1 次 · 学习卡第 1 版 · 发布第 1 版

- **实量**：`.v3-objective-revision` = `[429,706,496,38]`，5 个 8px `<span>`：`目标第0版`、`状态变更1次`、`学习卡第 1 版`、`发布第 1 版`、`创建于9月21日 12:13`。
- **为什么算问题**：这些是 revision/hash 闭包的产品内部概念，对「我会不会这道题」零帮助，而且以 8px 出现在页面最底部——像一张收据。
- **方案**：整块删掉，或收进一个「这条目标怎么来的」折叠区（和证据清单合并）。`23-learning-objective-content-topology-system-rebase.md` 要求的是**可追溯**，不是**把追溯字段摆在主版面上**。

### P17 右侧整栏在作答前一屏说「0 条原文证据」

- **实量**：`.v3-lineage-ledger` = `[969,94,383,654]`，头部右侧 `1条来源 ·0条原文证据`（8px/11.2px），唯一的来源行写着 `链路已核对 · 0 条原文证据` / `没有留当时引用的原文`，栏底再来一段 8px 的「这里仅呈现来源关系与学习状态；标准答案、评分规则和完整证据原文不会进入桌面渲染边界。」
- **为什么算问题**：这一栏的语义是「你的理解有几分证据」，实测它 654px 高、只有一个来源行 + 两处「0 条」+ 一段边界声明。**它把「证据为空」这个负面事实做成了整栏版面**，正好处在用户即将去作答的位置。
- **方案**：0 证据时这栏不该以满栏形态存在——收成详情页底部一行「这条主张目前没有留原文引用 · 去补一条」，把空间还给「这题会怎么问」的预告（§9.2）。

## 5. 作答页（page-16，`learning-run-surface.tsx:2031-2233`）

### P18 伴星在不在，纸面宽度差 193px

- **实量**：同一次会话里，`.learning-run-workbench` 伴星在场时 `[128,82,1031,673]`，伴星加载失败时 `[128,82,1224,673]`。
- **根因**：`hud-surface.css:305-311` 给 page-16/17 在伴星缺席时把 `right` 从 `--companion-seat-right (245px)` 改回 `55px`。
- **为什么算问题**：Live2D 加载失败（本次实测就发生了）会让作答页和结算页**整块重排 193px**，题干、输入框、按钮全部位移。一个装饰层的可用性不该决定主版面的几何。
- **方案**：座位预算常驻（伴星缺席时留白，不回收宽度），或者把版心改成与伴星无关的固定 `max-width` 居中。

### P19 动作区实测同时挂 7 个控件，状态文字被挤到 67px 宽折成两行

- **实量**：`active` 阶段一次数到 **7 个**可交互控件：`改做排序题 / 暂停 / 给我一点提示 / 稍后再做 / 暂时不会 / 更多选择 / 提交回答`。`.learning-run-dock__status` 在 7 控件时 `[411,665,67,26]`（「回答不会自动提交 · 尚未输入」折成两行：「回答不会自动提 / 交 · 尚未输入」），在 5 控件时 `[436,705,121,13]`（单行）。dock 本身 `[411,608,713,123]`，`.actions` 换行到两排（`y=625` 与 `y=693`）。
- **根因**：`learning-run-surface.tsx:2137-2228` 把「求助」「换方式」「出口」「提交」四类动作平铺在同一个 `flex-wrap` 行里；`.learning-run-switch-note` 又 `flex-basis:100%`（`hud-surface.css:4838`）强制换行，状态列没有任何最小宽度保护。
- **顺带量到的一条配色错**：那行「现在还不能改用语音作答…」的颜色是 `rgba(255, 248, 232, 0.7)`（`hud-surface.css:4839`）——**这是给深色底写的字**。它实际落在奶油纸面上（`.learning-run-workbench` 的 `background: var(--hud-cream)` = `#fff2cf`，`hud-surface.css:4682` / `hud-pages.css:20`），按 alpha 合成后约 `#FFF6E1`，与纸面自身几乎同亮度。截图里这行确实基本看不见（`.objflow-caps/62-ordering-editor.png`、`71-choice-selected.png`）。像素采样我还没做（见 §11），但「用深色底配色去写奶油底说明」这件事不需要采样就能定性。
- **为什么算问题**：主操作（提交）被 6 个次要按钮挤到第二排右下角；状态提示是这页唯一的「系统现在在干什么」，却被压到折行；而解释「为什么那个按钮是灰的」的那句，几乎不可见。
- **方案**：dock 分三段固定槽位——左：状态（`min-width: 220px`）；中：求助类（提示 / 换方式，收进一个「帮我把把」的下拉）；右：**只有一个**主按钮 + 一个出口。`暂时不会` 与 `稍后再做` 是两种真实结果（`:2184-2186` 注释已经写明），不能删，但可以并到出口菜单里的两项，而不是和提交抢同一排。

### P20 伴星提示条实测压在「暂时不会」和「提交回答」上

- **实量**（`elementFromPoint` 逐按钮测中心点）：`.companion-unavailable-notice` 出现时，`暂时不会` `[1131,693,78,38]` 与 `提交回答` `[1217,693,100,38]` 两个按钮的 `covered: true`，其余三个 `false`（`.objflow-caps/40-resume.png` 里可见：提交按钮整个被黑面板盖住）。
- **为什么算问题**：触发条件（Live2D 失败）是偶发的，但**几何关系是结构性的**——提示条锚右下，dock 主按钮也在右下。任何右下锚定的浮层（念头气泡、输入气泡、语音状态）都会盖住这条链路的提交键。
- **方案**：作答/结算页给伴星层划一条底部保留带（`--companion-dock-reserve`，高度 = dock 高 + 12），所有右下浮层不得进入；或者把提示条改成 dock 上方的一条 inline 通知。

### P21 提示的扣分说明是 7.5px——全链路最小、也最该看清的一句

- **实量**：`.learning-run-hint` 出现时 `[153,582,207,145]`（宽 207px），提示正文 `9px/13.95px`，惩罚说明 `small` 实测 **`7.5px / 11.625px`**：「看过提示之后，这张卡本轮只计练习分，不再计正式理解分。」提示出现前该块在 `y=683`，出现后整块上移到 `y=582`（**左栏内容跳 101px**）。
- **为什么算问题**：这句话决定用户这次作答还算不算数，却是全链路最小字号；而且提示面板挂在**左栏（导航栏）**里，不在题干旁边——求助信息和求助对象隔了 250px。
- **方案**：提示面板移到 stage 内、题干正下方；惩罚说明 ≥12px 且用陶土色标记；提示出现时不得移动左栏其它块（用固定槽位）。

### P22 切到「选择题」之后，题干还是那道回忆题

- **实量**（`.objflow-caps/70-choice-editor.png`）：切到选择题后 `.learning-run-stage__header h2` 仍是「请回忆这个主题的关键信息；并说明它成立的条件或不适用的情况（先不要查看任何材料）」，下面直接给两个选项「难度来自提取过程本身」/「难度来自材料含糊或指引不清」。选项区只有 2 行 707×40，落在 306px 高的 `.learning-run-response` 里，**下面 220px 是空的**。
- **为什么算问题**：选项和题干配不上，用户得自己猜「这两个东西是在回答哪个问题」。这不是样式问题，是**换作答方式时没换认知任务的表述**。
- **方案**：`switch_variant` 时题干必须一起换（题干来自 variant 自己的 `prompt`，服务端已有 `learning_run_private_contracts`/task 载荷）；如果 variant 没有独立题干，就不该提供这个切换。

### P23 三种题型用两套设计语言，同一块输入区里并排

- **复验**（grep `src/renderer/**/*.css`）：`.run-choice-*`、`.run-truefalse*`、`.run-matching*` **只存在于 `styles.css:1429-1481`**，`hud-surface.css` 里一条都没有；而 `.run-order-list`、`.run-relation-*`、`.run-repair-*`、`.run-bundle-*` 在 `hud-surface.css:4987-5056` 有 HUD 作用域规则。
- **实量对照**（同一个 `.learning-run-response` 容器内）：
  - 选择题行：`707×40`、文字 **11px**、圆角 **8px 均匀**（`styles.css:1440`）、底 `rgba(255,252,244,.55)`、字色 `#514031`、`○/●` 标记 `12×12` 且**溢出**（`scrollWidth > clientWidth`）。
  - 排序题行：`707×58`、文字 **11px**、**无底色**、`border-radius: 0`（`styles.css:2585`）、底部 1px 横线（`hud-surface.css:4992`）、右侧两个 40×30 圆形图标钮。
- **为什么算问题**：奶油纸上的 HUD 语法是「横线行 + 不对称圆角」（`DESIGN.md:100/:102`），旧 task-surface 语法是「半透明白卡 + 8px 均匀圆角」。两套在同一个面板里并排出现，切题型=换产品。
- **方案**：把 choice/matching/true_false 三个编辑器迁到 HUD 语法（同 `.run-order-list` 的横线行 + 同圆角族），删掉 `styles.css:1429-1481` 那三条旧配方；`true_false` 的两个按钮已经是 HUD `.button`，只缺 claim 条的迁移。

### P24 排序题没有序号，移动按钮在离文字 580px 远的地方

- **实量**：`.run-order-list` 4 行，每行 `707×58`；文字 `<span>` 在 `[449,304,568,16]`，两个 `.run-icon-button` 在 `[1029,297,40,30]` 和 `[1074,297,40,30]`——**从文字右端到按钮有 ~528px 空档**，且首行的「上移」是灰的（无解释）。DOM 是 `<ol>` 但 `list-style: none`（`styles.css:1402` 一带），**屏幕上没有任何 1/2/3/4 的位置标记**。
- **为什么算问题**：排序题的全部认知负荷在「谁在第几位」。没有序号，用户要自己在心里编号；按钮和文字分居两端，每次移动都要横跨 500px 找对应关系。
- **方案**：每行左侧一个 24px 序号徽章（衬线，随位置变化）；移动钮紧跟文字右端或整行可拖（`ReviewSurface` 那套拖拽已经存在，`review-deck.ts:174-182` 有阈值常量可复用）；首/末行的禁用钮改成占位灰点而不是消失的按钮。

### P25 语音转写的文本框完全没有样式；文本作答框没有焦点环

- **复验**：`run-voice-input.tsx:170-177` 的 `textarea` 在 CSS 里只被 `hud-surface.css:4883-4887` 声明了 `width/height/resize`，`styles.css` 里没有任何 `.run-voice-input` 规则；全局只有 `styles.css:55-57` 的 `button, input, textarea { font: inherit; color: inherit; }`——**`border` 与 `background` 从没被重置**，所以它是 UA 1px 边框 + UA field 底色；字号走 `inherit`，而它的祖先链（`.learning-run-response` 实测 computed `16px/normal`）没人设过字号 → **16px**。夜间还会因 `styles.css:53-54` 注释自己点明的 `color-scheme: dark` 反转成深色块。
- **同类**：`text_response` 的 `textarea` 用内联 `outline: "none"`（`learning-run-surface.tsx:810`）+ `hud-surface.css:4966 outline: 0` 把环打掉，`:focus` 只换成 `background-color: rgba(255,255,255,.18)` 的淡洗——违反 `DESIGN.md:141`（聚焦转暖橙边界）与 `:173`（不能只靠一种信号）。
- **方案**：语音转写框复用 `.run-text-editor` 的纸面语法；两处焦点态统一成 `3px solid var(--focus)` 外偏移 3px。

### P26 三个出口并存，其中一个是「返回返回书房」

- **复验**：纸内主按钮槽位（`learning-run-surface.tsx:2222-2226`，`返回书房` / `回到复习队列`）、纸外悬浮胶囊 `.return-home`（`App.tsx:171-173` → `HudPage.tsx:43-56`）、以及 `App.tsx:101-105` 的 `Esc`。`HudPage.tsx:49` 写的是 `aria-label={`返回${label}`}`，而 `label` 默认就是「返回书房」→ **朗读出来是「返回返回书房」**。
- **几何**：胶囊 `position:absolute; z-index:38; left:25px; bottom:22px; height:46px`（`hud-pages.css:44`），纸面 `.content` `z-index:15`、`bottom:55px`（`hud-pages.css:53`）→ 胶囊顶边压进纸面左下角，实测盖在绿色 `.learning-run-journey` 栏底部。
- **方案**：作答/结算页期间隐藏 `.return-home`（`approved-surfaces.css:364` 已经对 `.surface-return-control` 做过同样的事，只是没覆盖 `.return-home`）；`HudReturn` 的 aria-label 改成 `label` 本身。

## 6. 结算页（page-17）其余问题

### P27 印章 42px 在自己的盒子里纵向溢出

- **实量**：`.learning-run-result-summary__seal` 盒 `[160,152,204,48]`，`scrollHeight 54` vs `clientHeight 48`；字号 42px（`clamp(27px,3vw,42px)` @1440 命中上限）。四个汉字塞 204px 宽、48px 高的盒，纵向溢出 6px。
- **方案**：印章槽位给到 `min-height: 1.3em + padding`，或者按字数降字号；印章是这条链路唯一该有的「仪式」，不能被裁。

### P28 绿栏 665px 高里有 374px 是空的，计数器和标签隔 156px

- **实量**：`.learning-run-result-summary` = `[132,86,260,665]`；`kicker`(117) → `seal`(152-200) → 主张(216-233) 之后**一直到 y=607 才有下一个元素**（`dl`），空 374px（占 56%）。`dl` 内部 `dt` 在 `x=160`（宽 18-36px），`dd` 在 `x=334-344` → 标签与数值之间 **156px 空档**。
- **方案**：绿栏改成「这次证明了什么」的进度叙事（见 §9.3）：印章 → 一句人话的成就描述 → 从这条目标开始到现在的累计位置 → 用时/证明数/缺口数作为脚注（11px），而不是作为唯一的数字区。

### P29 「看这次的答案与解释」的标题比答案本身响 8px

- **实量**：`.learning-run-result-reveal__body h3` 实测 **18.72px 粗衬线**（「这次想考的是」），下面的 `__answer` 实测 **10px**。展开后这块从 38px 长到 128px，把下方 `接下来` 便签整体往下推。
- **根因**：`hud-surface.css:5230` 只给 `__body h3` 声明了 margin，没有 font-size → 走 UA `1.17em`（父级 16px）。而答案那行更绕：`:5231` 明明写了 `.learning-run-result-reveal__answer { font-size: 11px }`，但 `:5232` 的 `.learning-run-result-reveal__body p { font-size: 10px }` 特异性是 `(0,2,1)`，压过 `__answer` 的 `(0,2,0)`——**声明的 11px 从来没生效过**，我量到的 10px 才是真相。
- **方案**：`h3` 收到 13px 元数据档，`__answer` 用 `(0,3,0)` 以上的特异性把 14px 钉住；展开用固定高度槽位或 `grid-template-rows` 过渡，别推挤。

### P30 「接下来」便签承诺的动作，下面没有任何按钮

- **实量 + 代码**：`learning-run-next-step` 的 `strong` 是 `先补上「回忆」`（`:2006-2012`），实测整页只有两个按钮 `同步中 · 返回书房` 与 `查看理解目标`（`:2023-2028`）。`再来一次 / 继续补充证据 / 结算当前证据` 这些真动作只存在于作答页 dock（`:1906-1909`），结算页一个都不给。
- **加重项**：`:2015` 那句「说不会不扣任何东西：这条已排到最近的复习。」是**硬编码**，不看 `result.scheduleImpact`——它可以直接和上面「复习安排」那行打架（实测 `declared_unable` 路径）。
- **方案**：`接下来` 便签里放一个真按钮（补一次 / 再来一次 / 去研究册看懂），文案由 `scheduleImpact` 派生而不是写死。

## 7. 跨屏：层级、动效、token

### P31 三套并行色板 + 零间距 token

- **复验**：`styles.css:9-30`（`--ink/--paper/--accent…`）、`approved-surfaces.css:18-37`（`--v3-*`）、`hud-pages.css:15-21`（`--hud-*`）三套同时活着，`--v3-ink` 与 `--hud-ink` 与 `--ink` 都是 `#30231a`，阴影字符串逐字相同（`approved-surfaces.css:30` vs `hud-pages.css:18`）。**三套里都没有 spacing / radius token**——本链路的 `padding`/`gap`/`border-radius` 全是字面量，光 run 段的 gap 就有 5/6/7/8/9/10/11/12/13/16/18/22/23 十三档，圆角是 `38px 31px 42px 34px / 34px 43px 32px 40px`（`hud-surface.css:4681`）这类一次性写法。
- **约束**：`DESIGN.md:197` 禁止在代码声明之前往文档加 token，`:184` 要求局部 token 限定作用域。所以这一步是**先收敛代码里的字面量到一组组件级 token，再谈新值**。

### P32 进出场是 GSAP，屏内反馈是 CSS，结算页什么动效都没有

- **复验**：屏间转场全在 `TaskSurface.tsx:186-330`（timeline `artifact-rise`，`clip-path: inset(... round 28px)`、`rotateX -3.2`、stagger `.025/.055`，预算 `scene-motion.ts:22-24` full `.46/.25`）。结算板只靠 `[data-outcome]`/`[data-acknowledgement]` 换字，**没有任何专属 keyframe**。
- **为什么算问题**：这条链路唯一需要动效的时刻是「结果落地」，而它恰好是零动效的一屏。`DESIGN.md:20` 说的「关键结果只反馈一次」现在只由一个 `useRef` 保证（`resultAcknowledgementEligibleRef` `:1011`），纸面上看不出来。
- **方案**：给结算页一个一次性压印动效（印章 scale+rotate 落定，≤260ms，`transform`/`opacity` only，`data-motion-mode="off"` 时直接终态），并且**只在 `demonstrated` 时出现**——和 P3 的「跳过不出印章」是同一件事的两面。

### P33 窄视口（720–760px）把控件打到 5–6px

- **复验**：`hud-pages.css:156` 的 `@media(max-width:760px)` 里 `:161` 写着 `.hud-surface .small, .hud-surface .meta{font-size:5px}` 和 `.hud-surface .button{min-height:20px;padding:0 8px;font-size:6px}`；`hud-surface.css:5372` 又把 `.run-confirmation p` 打到 **5px**，靠 `:5394` 同特异性后置声明救回 9px（**换个顺序就又是 5px**）。dock 那五个按钮在紧凑档全部 6px，而同排的「更多选择」`summary` 被 `:5345/:5398` 明确提到 9px。
- **状态**：我**没量到**（不能改用户窗口尺寸），这是源码事实。列为 B8 的验收对象。

### P34 确认框在说「服务端合同」

- **实量**：点「稍后再做」弹出的 `.run-confirmation` 原文：`确认这项学习旅程操作` / `确定要稍后再做吗？当前已输入内容会按服务端合同处理。` / `确认` `取消`。
- **为什么算问题**：用户可见文案里出现「服务端合同」，属于内部词外泄（既有文案规范已禁止）；而且这句话没有回答用户真正想问的「我刚才输入的东西还在不在」。
- **方案**：改成第一人称、说清后果的一句，例如「这次的草稿我会替你留着，回来接着写。」并把两个按钮改成动词（`先放着` / `继续写`）。

## 8. 为什么会长成这样（诊断）

1. **结算页是数据视图，不是反馈界面。** `:1929-2030` 把 `result` 的字段逐个铺出来（counters / evidence / rubric / reveal / next-step），没有一处为「这次值不值得高兴」做判断。`data-outcome` 发出去了却没人接（P2），说明视觉分档本来就在计划里、只是没执行。
2. **四屏共用「大纸 + 侧栏」骨架，但没有为信息量小的情况设计形态。** 焦点卡 43% 是空的（P8）、详情页填充 8.2%（P13）、结算绿栏 56% 是空的（P28）——同一个病：容器高度写死，内容少时空转。
3. **字号被当成层级用。** 8px/9px 承担了 80% 的文本段（P7），因为它们被当成「元数据」；但 chip、标签、扣分说明这些**要参与决策**的文字也被划进这一档，于是重点被压平。
4. **动作区没有主次，是 flex-wrap 的必然结果。** 所有 actionLink 平铺进一个可换行的容器（P19），按钮越多、状态越窄、主按钮越靠边——控件数量与版式质量成反比。
5. **新增题型时只补了 DOM，没补 HUD 作用域。** choice/matching/true_false 是后加的，样式落在 `styles.css` 旧配方里（P23），于是同一面板两套语言。
6. **装饰层参与了版面几何。** 伴星缺席会改主版心宽度（P18）、右下浮层会盖住提交键（P20）——座位预算和 dock 之间从来没有划出保留带。

## 9. 重构目标形态（本轮不实施）

### 9.1 先补「进度语言」，再补装饰

这条链路现在**没有任何一处能回答「我走到哪了」**。作答页左栏只写「当前位置 · 问题 1」（实测 `dd` = `问题 1`，**没有总数**），stage 右上角在 checkpoint 态是一个裸词「进度」（`learning-run-surface.tsx:2074` 的三元表达式：`active` 态给草稿状态、其它相位只留这两个字；实测该元素 `[1106,112,18,13]`，后面什么数字都没有），结算页只有本次的 0/1 计数，列表只有 8/7/1 三个数。建议引入一条贯穿四屏的**同一视觉对象**：

- 单位是「这条目标上的位置」，不是百分比分数（合同禁止客户端自行推断掌握度：`23-…:556/:574`，`19-…:102`）。
- 数据源只用服务器给的 `personalState` / `progress` / `scheduleImpact`；缺失时显示 `—`（`DESIGN.md:178`）。
- 形态：列表焦点卡顶部一条 3 段带（没碰过 / 练过了 / 说清了），详情页同一位置的同一条码 + 当前指针，结算页同一条码 + **本次新增的那一段被点亮**（这就是 P32 的一次性动效落点）。

### 9.2 详情页改成「这次会怎么问」

保留合同边界（不承诺具体题面：`23-…:625`；不在详情页本地渲染作答：`:597`），但必须回答用户真正的问题：**我要做什么类型的认知动作**。把 P16 的版本账本和 P17 的空证据栏腾出来的空间，给三样东西：这题的作答方式（回忆 / 排序 / 配对 / 讲解，用作答页会出现的那个控件的**缩略示意**）、上次留下的缺口、以及一个真按钮「现在就开始」。

### 9.3 结算页重排（信息优先级）

1. 印章 + 一句**人话的结果**（「四步你全说清了」而不是「本次练习已经完成」）——`demonstrated` 才有印章与压印动效。
2. 这次证明了哪些 facet（带色带、可数），以及**它们相对这条目标的位置**（§9.1 的条码）。
3. 缺口（如果有）：每条缺口配一个真动作按钮（P30）。
4. 复习安排：一句带**真实日期**的话（P4）。
5. 逐条判定：作为可展开的明细，不是主版面。
6. 底部固定 actions 槽：回去 / 看目标（P5）。

### 9.4 作答页的三条硬规则

- **一屏一个主按钮**，且它永远在最右、永远不被浮层覆盖（P19/P20）。
- **求助信息贴在题干旁边**，扣分说明用正文字号（P21）。
- **换作答方式 = 换题干**（P22），并且所有题型共用 HUD 纸面语法（P23）。

## 10. 批次划分（每条可独立验收，互不阻塞）

每个批次的验收都用 §13 的探针重跑一遍，**改前改后各一份数字**，写进本文件对应小节。

| 批次 | 内容 | 验收口径（可判定，不靠眼缘） |
|---|---|---|
| **B0** | 结算页溢出 + 出口槽 + 印章裁切（P5/P27） | ✅ 已上线，见 §14。**口径改过**：原写「report 不再 `overflow-y:auto`」是错的——纸面高度固定时总得有一列可滚，病在出口落在那一列里。改成三条可判定的：主按钮下沿离纸面下沿 ≥8px、出口不在任何 `scrollHeight>clientHeight` 的祖先内、`__seal` `scrollHeight <= clientHeight` |
| **B1** | 结算页自相矛盾（P1/P6/P30） | 同一次 `covered` 判定下，「还需补上」里不出现该 facet；`已证明 N 项` 与 rubric `covered` 行数一致；`接下来` 便签内含 ≥1 个可点动作；`skipped`/`declared_unable` 时 DOM 里**没有** `__seal` 节点 |
| **B2** | `data-outcome` 真的驱动视觉 + 一次性压印（P2/P32） | 三种 outcome（demonstrated / partial / not_assessable）截图像素差异 ≥ 背景色与印章区两处；`[data-outcome]` 在 CSS 里 ≥ 3 条规则；动效只改 `transform/opacity`，`data-motion-mode="off"` 时 `getAnimations().length === 0` |
| **B3** | 「下次到期 刚刚」（P4） | 造一条 `dueAt` 为明天 / 5 天后 / 下月的评估，页面分别显示 `明天 / 5 天后 / M月D日`；`formatRelative` 不再被未来时间调用（新增单测断言负 minutes） |
| **B4** | 字号地板（P7/P13/P21/P33） | 列表 / 详情 / 结算三屏 `<11px` 文本段占比 = 0；提示惩罚说明 ≥12px；720×405 视口下 `.button` ≥ 11px、`.meta` ≥ 9px、`.run-confirmation p` ≥ 9px |
| **B5** | 空带与骨架（P8/P14/P28） | 焦点卡内最大连续空白 ≤ 64px；四屏内容左边界一致（`x` 差 ≤ 2px）；结算绿栏空带 ≤ 80px |
| **B6** | 动作区分层（P19/P20/P26） | dock 主按钮唯一且 `right` 对齐；`.learning-run-dock__status` 宽度 ≥ 200px 且不折行；右下浮层与 dock 的交叠面积 = 0；`.return-home` 在 page-16/17 不渲染；aria-label 不再出现「返回返回」 |
| **B7** | 题型语法统一（P22/P23/P24/P25） | `styles.css:1429-1481` 三条旧配方删除；choice/matching/true_false 行的 `border-radius` 与 `background` 与 ordering 行一致；切换 variant 后 `h2` 文本发生变化；排序行出现序号徽章；语音 textarea 的 computed `border`/`font-size` 与 `.run-text-editor` 一致 |
| **B8** | 列表与详情的动作语义（P9/P10/P11/P12/P15/P16/P17） | 焦点卡主按钮文案与 `onClick` 落点一致（新增组件测试钉住）；行内 chip 种类 ≤ 2；标题与搜索范围一致（要么「共 214」要么标题不写「全部」）；详情页不再出现版本账本 |
| **B9** | 文案（P34 + 各处内部词） | 全链路可见文案 grep 无「服务端 / 合同 / 渲染边界 / 评估 / 同步中 ·」；确认框两句都是第一人称且回答「东西还在不在」 |
| **B10** | 进度语言（§9.1，跨屏） | 四屏存在同一个进度条组件实例；其数值全部来自服务端字段（无客户端推断）；缺字段时显示 `—` |

**顺序建议**：B0→B1→B2→B3 是「反馈兑现」，先做；B4/B5 是「层级与版式」，其次；B6/B7 是「操作面」，可以并行；B8/B9/B10 需要产品口径确认（尤其 B10 的进度语义和 23 号文档的「不许客户端推断」边界）。

## 11. 没量到的（不装成量过）

- **判断题 / 配对题 / 关系搭建 / 纠错修补 / 组合证明 / 语音讲解这六种作答界面实机不可达**：库里 `practice_item` 现在只有 `ordering ×2`、`single_choice ×2`，`true_false` 与 `matching` 各 **0 条**（`learning_objective_revisions_v2` 计数）；`canonical_answer` 只有 `ordered_steps ×4`、`mapping ×1`、`bullets ×1`；本机无麦克风（实测 dock 里 `改用语音讲解` 被禁用并给出理由）。这五种我只能给出源码级诊断（P23/P25 的样式归属、`InteractionEditor:782-901` 的 DOM），**版面与动效结论要等能造出样本再补**。
- **窄视口（1280×720 / 720×405）下的四屏版面**：没有改用户窗口尺寸，P33 全部是源码事实。
- **`prefers-reduced-motion` / 动效档位 `lite|off` 下的实际表现**：没测。
- **夜间模式**：只看到 `styles.css:131-133` 的 `color-scheme: dark` 会影响 P25 那个无样式 textarea，没做像素采样。
- **对比度**：本轮没有做像素采样（30 号文档的 `tmp-cc-pixel.mjs` 那套）。P21 的 7.5px 灰字、P19 的 `.learning-run-switch-note` 淡洗句大概率不合格，但**我不写成结论**，留给 B4 的验收一起量。
- **复习队列（`ReviewSurface`）与今日学习（`StudySurface`）**：它们也通向同一个作答壳，但本文没量；P18/P19/P20 的结论对它们同样成立（同一个 dock、同一个伴星保留带）。

## 12. 必须尊重的既有合同（改之前先读这几条）

- **目标不是测验**：`23-learning-objective-content-topology-system-rebase.md:90/:597/:914/:1246`——三分钟旅程是唯一正式作答与承诺的场所；`objectiveStatement / publicSummary / conceptLabel` 三个标题不得互串；浏览、揭示答案、归档都不算学习结果。
- **不许客户端推断**：`23-…:440/:556/:574`、`19-…:102`——生命周期/复习/理解状态只能来自服务器字段，不得从标签或本机时间自算。§9.1 的进度语言受这条约束。
- **客观题只是练习件**：`docs/plans/objective-card-items-2026-09-21.md` D1–D4——选择/判断/配对/排序**永远不能替代正式判分**，判分走 `deterministic_structured`，`trust_ceiling = practice_only`。这解释了 P1 里那次 `practice_only`，也意味着**结算页必须把「练习」和「正式」两种结果在版面上分开说**，而不是让用户以为答对了却显示 0 项。
- **结算页相位语义**：`17-learning-run-ui-redraw-implementation-record.md:116-137`——`assessing` 期间锁产物、`checkpoint` 不得提前宣称、`committing` 不得预告排期变化、七种 outcome 各自带排期影响。本文的 P4/P30 是这条合同没落到版面上的部分。
- **页面里不许长第二个助手**：`19-system-ui-redraw-implementation-record.md:102`——伴星只能待在座位区，这也是 P20 的保留带方案的前提。
- **视觉与动效**：`DESIGN.md:142/:148/:151/:152/:173/:178/:184/:197`——禁用态不得只用颜色/动画说明；动效只改 `transform`/`opacity`；印章只出现一次且跳过不庆祝；缺字段显示 `—`；token 必须先在代码里声明复用。
- **文案**：用户可见文字用第一人称、平实、带人格，不出现服务端/合同/渲染边界这类内部词。

## 13. 复现与复测

```
cd apps/desktop-client
node scripts/tmp-objflow-s1-list.mjs         # 列表：截图 + 几何树
node scripts/tmp-objflow-s2-detail.mjs focus # 详情
node scripts/tmp-objflow-s16-density.mjs     # 列表：填充率 / 字号直方图 / 最大空带 / 焦点卡空带
node scripts/tmp-objflow-s17-density2.mjs    # 详情：同上口径
node scripts/tmp-objflow-s14-measure.mjs     # 结算页溢出、rubric 判定、计数器原文
node scripts/tmp-objflow-s4-clean.mjs        # 动作区逐按钮遮挡（elementFromPoint）
```

`tmp-objflow-lib.mjs` 里的 `tree()` 会打印每个节点的盒 + 字号 + 行高 + 字色 + `CLIP` 标记，是逐条复核本文数字最快的入口；`s16-density` 是「只算视口内未被裁矩形」的密度口径，B4/B5 直接用它做改前改后对比。

**这批脚本是本轮唯一的手段，也是后续每个批次的验收夹具**——按 30 号文档的先例，落地后若仍是唯一手段就转成受控脚本。

## 14. 实施进度（滚动更新）

版式修正统一落在**新文件** `components/objective-flow.css`（`main.tsx` 里排在 hud 层之后）。不写进 `hud-surface.css` 的理由写在该文件头部：这条链路的规则覆盖的是同文件更早处的声明，必须整体后置才稳定取胜，而且那个 6000+ 行的文件同时被伴星中心共用。

### B0 结算页出口槽与印章裁切 — 已完成（2026-09-21）

改动：`learning-run-surface.tsx:2004-2029` 把 `.learning-run-result-actions` 从 `<article class="…-report">` 里移出来，成为结算板的直接子节点；`objective-flow.css` 给板加 `grid-template-rows: minmax(0,1fr) auto`、把出口钉在第 2 行横跨两列、印章行高 1.32→1.45。

| 指标 | 改前（实量） | 改后（实量） |
|---|---|---|
| 主按钮下沿离纸面下沿 | **−34px**（在折叠线以下，须滚内层列） | **+26px** |
| 出口是否落在可滚容器内 | 是（report `overflow:auto`，727 vs 665） | **否**（`actionsInsideScroller: null`） |
| report 需要滚动的像素 | 62px | **0** |
| `__seal` `scrollHeight` / `clientHeight` | 54 / 48（裁 6px） | **61 / 61**（不裁） |

行高这一条值得记着：**1.32 不够**。第一次改完实测仍是 57 vs 55，差 2px；CJK 衬线在 42px 下要 1.45 才收得住。凡是按 `line-height` 估字形高度的，都要实量一次而不是算一次。

新增结构回归 `learning-run-surface.result.test.tsx`（3 例，含 12 条 rubric 的长判定场景）。**做过变异检验**：把出口挪回 report 内部后，两条结构断言转红（`expected true to be false` / 子节点数组少一项），第三条「两个出口都还在」保持绿——它钉的是另一件事。几何类指标 jsdom 量不了，由 `scripts/tmp-objflow-v-b0.mjs` 在实机上出上面那张表。

**顺带修掉的一个自埋坑**：`objective-flow.css` 第一版顺手重写了 `.learning-run-result-board` 的 `grid-template-columns`，会盖掉 `hud-surface.css:5348` 在 `@media (max-width:760px)` 里的另一档列宽。已删掉那行——后置层只加行、不动列。
