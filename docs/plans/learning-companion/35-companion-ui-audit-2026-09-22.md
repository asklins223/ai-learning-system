# 伴星交互界面审计：气泡 / 按钮 / 对话记录 / 快捷设置（2026-09-22）

范围：**伴星本体在页面上的那一圈界面** —— 头顶气泡、主动念头、三颗交互按钮、输入气泡、
「更多」菜单、右缘快捷设置、对话记录抽屉（含搜索与月历）、过程轨道与动作建议。
**不含伴星中心**（那是 `30-companion-center-ui-review`）。

## 0. 一句话结论

三件事在挡路：**她主动递的话点不到**、**她说"带你去看"结果页面不动**、**发送失败会在记录里
留下一句你其实没说过的话**。其余是"界面说话不算数"那一类：菜单承诺了没有的声音控件、
切了形态还全体署名 Mao、她在等确认时卡片会因为你自己打开菜单而消失。视觉上有一个系统性
档位问题：**伴星界面里带显式高度的 26 条控件规则，19 条低于 44px**，而 10–11px 的次要文字
用的那个棕色普遍落在 3.1–4.5:1。

## 1. 怎么查的 / 怎么复现

- 全量读：`CompanionHud.tsx`(2499) `companion-hud.css`(1999) `companion-chat-session.tsx`(1843)
  `CompanionPresence.tsx`(1679) `CompanionChatRecord.tsx`(375) `companion-bubble.css`(192)
  `companion-chat-record.css`(438) `companion-root.css`(280)。
- **类名两头对账**（剥掉两侧注释后，只算非测试 `.ts/.tsx` 生产者）：CSS 定义了但组件从不出现
  → `.companion-bubble--page`、`.companion-page-cue`；组件在用但 CSS 查无此名
  → `companion-bubble__voice`、`companion-history__legacy-proposal`。
  另单独确认 `--reply` / `--speaking` 无 CSS、`tone="page"` 从不传、`label`/`speaking` 两个 prop 无调用点。
- **命中区实测**：`node /tmp/cuecheck/run.mjs` —— 用 headless Chromium 加载**仓库里那份
  `companion-bubble.css` 原文** + 真实祖先链几何（`styles.css:347-374`、`companion-root.css:5-24`），
  量 `button.companion-cue-open` 的盒子、气泡中心 `elementFromPoint`、并打一次真鼠标点击。
  这条量法只证 CSS 层几何，不等于跑过真应用；B0 会把它固化成仓库脚本。
- **对比度**：按实际色值算（含 `rgba()` 压到底色上的合成），不是取色卡近似。
- **控件尺寸统计**：`node /tmp/hit.mjs`，按规则块抓 `button/input/.switch` 上的显式 height。

## 2. A 组：功能真的是坏的

### A1 ✅ 主动念头气泡「点开和她聊」点不到（零面积）

`CompanionPresence.tsx:1604` 用 `button.companion-cue-open` 包住气泡，而 `.companion-bubble`
是 `position:absolute`（`companion-bubble.css:7`），按钮自己 `display:block;padding:0`
（`:175-186`）—— 唯一子节点在流外，按钮盒塌成 **0×0**。

实测：按钮盒 `[763,251,0,0]`，可见气泡 264×57 位于 y=140；气泡中心的 `elementFromPoint`
返回根节点 `.desktop-app`；真鼠标点下去 **click 不触发**。

后果：这条邀请最长挂 30 秒（`CompanionPresence.tsx:649`），期间点哪里都没反应；键盘 Tab 到它时
焦点环画在离文字约 100px 的空盒上（并行会话刚把它从 2px 改成 `3px var(--focus)`，
即 `companion-bubble.css:188`）。`companion-cue-open` / `openThought` **零测试**。

### A2 ✅ 「她带我去那一局练习」页面不动，而前端当成功了

`companion-chat-session.tsx:330-334` 的 `learningRun.detail` 分支只 `setActiveRunId` 就
`return true`，缺 `invoke`。仓库里另外 7 处打开同一页面的入口全部成对写：
`RunRecoveryNotice.tsx:96-97`、`ReviewSurface.tsx:700-701`、`StudySurface.tsx:541-542`、
`WorkspaceLibrarySurface.tsx:418,613`、伴星中心自己 `companion-center-surface.tsx:503`。
因为返回 true，「前往」的 chip 会被就地移除 —— 按钮消失、不报错、页面不动。

既有测试只断言"点击会调 `goToRoute`"（`CompanionChatRecord.test.tsx:44`），恰好测不到这一跳。

### A3 ✅ 发送失败留下"幽灵消息"

`companion-chat-session.tsx:1472` 先塞乐观条目；`postTurn` 抛错走 `:1608` 的 catch，只写
failure，既不移除该条目也不重取列表。用户在抽屉里看得见自己"说过"这句话，而服务端从没有过
它（409 发生在写用户消息之前），直到下一次任意刷新才自己消失。

## 3. B 组：界面说的话与它做的事不一致

### B1 ✅ 「伴星设置」承诺"声音"，面板里一条声音控件都没有

入口小字 `CompanionHud.tsx:1502` 写「大小、声音、行为与账号偏好」。实际面板只有
大小/安静/专注/重置/隐藏/形态 + 在线/介入/权限/静默时段。
声音能力**在**全局设置的「语音与伴星」一节（`settings-surface.tsx:86,1841,1926`：引擎、音色、
试听、总静音）。所以正解不是新造控件，而是让这一行真的能走到那一节。

### B2 ✅ 快捷设置里露出内部术语

`CompanionHud.tsx:1630` 的 meta 行是 `${rendererLabel} · 版本 ${revision}`，
而 `rendererLabel` 来自 `CompanionPresence.tsx:1357`，值是 `Live2D` / `正在准备 Live2D` /
`Live2D 不可用`。用户看到的一行是「Live2D · 版本 3」。

### B3 ✅ 切了「形态」，全体文字仍署 Mao

`WINDOW_LIVE2D_MODEL_REGISTRY` 的 `displayName` 已经用在两处（形态按钮、
`CompanionPresence.tsx:1560` 的角落标签），但 **15 处** 用户可见文字与 aria-label 写死 "Mao"：
输入气泡标题/占位、三颗按钮的 `aria-label`、抽屉头部与每条消息的署名
（`CompanionChatRecord.tsx:208`）、轨道标签、确认提示、加载态。换成别的形态后署名不变。

### B4 ✅ 她在等确认时，选择卡会因为用户自己打开「更多」而消失

`CompanionHud.tsx:1342` 的 dock 只在 `chat.mode === "closed"` 渲染；而气泡的停留计时又因
`pendingProposalId` 暂停（`:557`）→ 打开「更多」那一刻卡片没了，画面像卡住。
「文字输入」态有自己的一份（`:1465`），所以只是 `actions` 这一档漏了。

### B5 ✅ 同一个文件两套报错判据

输入气泡按 `chat.failure && chat.phase === "error"` 显示，注释还专门说明陈旧报错不该挂着
（`CompanionHud.tsx:1461-1464`）；对话记录抽屉 `:2422` 无条件显示 `chat.failure`。

### B6 ✅ 搜索池有第二个真源，且拉取上限静默截断

`CompanionHud.tsx:1838` 的 `allMessages` state 从不清零，而它背后的缓存 `historyAllRef` 每 3 秒
被 `refreshMessages` 清一次（`companion-chat-session.tsx:699`）→ 两边不同步；抽屉常驻不卸载
（`CompanionHud.tsx:1541`），所以"刚聊过的搜不到"会一直持续到重启应用。
全量拉取上限 12 页 × 100 条（`:760`），超出的老消息不参与搜索，但界面只说「没有找到包含「X」的消息」。

## 4. C 组：命中区、对比度、字号

### C1 ✅ 控件命中区：26 条显式高度规则里 19 条 <44px

高频且最该改的几处：对话记录抽屉的麦克风/停止/发送 **34×34**（`companion-hud.css:1330`）、
抽屉头部三颗（返回/聊天记录/关闭）**40×40**（`:1189`）、动作建议卡的确认与拒绝 **36px**
（`companion-proposal-choice.css`）、快捷设置分段按钮 **32px**（`:1038`）、静默时段开关 **42×24**
（`:1044`）、缩放滑块珠 **18px**（`:990`）、月历格子 **30px**（`companion-chat-record.css:125`）、
清空搜索 **22×22**（`:38`）。达标的是三颗交互按钮 44、发送 48、菜单行 58。

### C2 ✅ 次要文字对比度全线在 AA 线下

按实际合成色算：月历条数徽标 7px `--companion-mint-strong` on ivory **1.50:1**（等于看不见）；
气泡里"她在做什么"过程行 **3.18:1**；轨道溢出行 **3.11:1**；抽屉消息头 10.5px **4.19:1**；
留痕摘要 10px **4.07:1**；快捷设置说明/组标题 10–10.5px **4.47:1**；抽屉错误行 10px 5.05:1（够但太小）。
讽刺点：那条过程行是 09-22 为了"有过程的时候完全看不到过程"才加的。

### C3 ◐ 同一条内容两种字号

她的话在气泡里 `clamp(14px,1.1vw,17px)` 650 字重（`companion-hud.css:212`），在记录里 12px
（`:1302`）；抽屉是"回看"的主场所，却是字更小的那一侧。是否统一要按伴星侧暖纸方言定档，见批次 9。

## 5. D 组：无人接手（按 AGENTS.md 该删而不是改）

| 项 | 位置 | 判定依据 |
|---|---|---|
| 朗读指示 `__voice` 三个 `<i>` + `--speaking` + `speaking` prop | `CompanionBubble.tsx:30,48,66` | 全仓 CSS 无此类名；`speaking` 无调用点传值 → 隐形且不发声 |
| `tone="reply"` 分支（文档承诺"字号略大、可更长"） | `CompanionBubble.tsx:14,20` | 无 CSS、无调用点；回复气泡实际是 `.companion-hud__output` |
| `tone="page"` + `label` prop + `.companion-page-cue` 全套定位 | `companion-bubble.css:115-172` | 组件从不渲染该容器，`label` 无调用点。**唯一有活路的一条**：A1 的修复正好需要"外层定位、内层 static"这个现成形状 |
| `companion-history__legacy-proposal` | `CompanionChatRecord.tsx:260` | 类名无 CSS，那块只是裸 `<div>` |
| `.companion-whisper*`（19 条）、`.companion-scale-control`（含其 `:focus-visible`） | `styles.css`、`home-room.css:503-518,559`、`home-v2.css:1200` | 零 JSX 生产者。**移交，不在本文件动手**（见 §6） |

## 6. 移交并行会话（`33-hud-style-consistency-audit` 的第二波）

那条批次表把 `.companion-whisper*` 与 `.companion-scale-control` 记成"已删"，但当前工作树里
`styles.css` 仍有 **19 条** `.companion-whisper`（`:386,403,416,423,706,713,722,984,995,999,1000,1025,1030,1040,1051,1053,1055,1064,1136`）、
`home-room.css` 10 条、`home-v2.css` 1 条。删除已经落在树里（`styles.css` 3009→1769、
`home-room.css` 1096→573，未提交），只是这个家族没被扫到。
本审计**不动**这三个文件，避免与在途改动撞车；复现判据用他们自己那条：非测试 `.ts/.tsx` 生产者数 = 0。

## 7. 批次计划（顺序 = 修完一步能看清下一步）

| 批次 | 内容 | 为什么这个顺序 | 完成判据 |
|---|---|---|---|
| **0 判据** | 把 §1 那条 headless 量法固化成 `apps/desktop-client/scripts/companion-ui-css-probe.mjs`：对给定 DOM+真实 CSS 报「控件盒尺寸 / 中心命中元素 / click 是否触发 / 焦点环落点」 | A1、C1 这类只有布局引擎能证；没有它，后面每一步都只能靠我读 CSS 讲道理 | 探针先对**当前**代码报出 A1 的 0×0 与 `hitIsInsideButton:false`（即它今天能红） |
| **1 A1** | 念头气泡改为「外层定位、内层承担命中」：按钮自己拿那条 absolute 链，气泡在按钮内部转 static（正好收编 `.companion-page-cue` 的形状） | 一处改动同时修好点不到与焦点环跑偏 | 探针：按钮盒 ≥ 气泡盒、中心命中落在按钮内、click 触发；`it()` 断言 `openThought` 被调且失败时不静默 |
| **2 A2** | `learningRun.detail` 补 `invoke("validate")`；并把 `applyRouteToRoom` 写成表驱动测试：**每种能映射出的 `DesktopRouteV1.kind` 都必须真正切页或如实返回 false** | 现在缺的正是"新增 kind 会漏"的守卫，不补就还会再来一次 | 该测试对未修前的代码必须红（变异验证） |
| **3 A3+B4+B5** | catch 里按 `clientMessageId` 摘掉乐观条目；proposal dock 条件由 `==="closed"` 改 `!=="history"`；抽屉错误行与输入气泡共用同一条"只有当前态是错才显示"的判据 | 三条都是小面积、纯逻辑，不依赖任何视觉决策 | jsdom 用例各一条，且逐条做过"行为消失即变红" |
| **4 B1+B2** | 快捷设置加一行「声音」→ 走既有 `setSettingsSection("companion")` + attention 通道跳到那一节；菜单小字改成实际内容；meta 行去掉 `Live2D`/`版本 N`，只留保存状态这一件用户能懂的事 | 不新造产品面，只把已有能力接上 | 点这一行后落在「语音与伴星」；meta 行无内部词（grep 断言） |
| **5 B3** | "Mao" 收成单一来源：伴星显示名从一个常量/账号字段读，15 处改指它 | 名字先止住漂移；能否自定义命名属产品，单独问 | `grep -c "Mao"` 在 renderer 生产代码里归零（模型文件与测试夹具除外） |
| **6 B6** | 搜索池单一真源：缓存失效即让 `allMessages` 一起失效；截断如实（命中行说清只覆盖了最近多少条） | 数字要留在能负责的地方 | 用例：刷新后重新搜索会重新拉取；无「未就绪当无记录」回潮 |
| **7 D 组清理** | 删 `speaking`/`reply`/`page` 三档与 `label` prop 及其 CSS；`.companion-page-cue` 若批次 1 已收编则留下，否则删；补 `legacy-proposal` 的样式或摘掉类名 | 放在功能修完之后，才不会顺手删掉正要复用的那个形状 | 两头对账脚本再跑一次：伴星目录内 0 孤儿、0 死成员 |
| **8 C2** | 次要文字按 4.5:1 反算取色，就地改 `--companion-muted` 一族的具体值（不叠末尾覆盖块）；月历徽标 7px 单列处理 | 这类改动会改变观感基线，必须在 C1 之前定，否则尺寸改完颜色又要重算 | 复算表：除刻意低优先级的禁用态外全部 ≥4.5 |
| **9 C1+C3** | 按 doc 30 B7 已定的口径（非列表 ≥44、列表行 ≥32）先统计全站既有档位再定值，就地改；气泡/记录两侧字号统一 | 放最后：它依赖前面稳定下来的结构，且用户两次推翻过我自定的档位，必须先量邻居 | 控件统计表 <44 的从 19 降到只剩"列表行/刻意紧凑"那一档，且 `out/` 实测过 |

## 8. 语音链路（子审计回来后的补充，均已自行复核关键判据）

### E0 ☑ 语音输入在这个应用里**从来不可能工作**（挡住用，最重的一条）

`apps/desktop-client/src/main/index.ts:503-506` 无条件拒绝一切权限：
`setPermissionCheckHandler(() => false)` + `setPermissionRequestHandler(…, callback(false))`。
全仓只有这一处权限处理器，且**窗口没有用任何 partition**（`grep -rn partition src/main` 为空）
→ 走的就是 `defaultSession`，这道闸对所有渲染层窗口生效。

`voice-recorder.ts:128` 用的是 `navigator.mediaDevices.getUserMedia` → 必然被拒；
而 `isSupported()`（`:116-118`）只看 API 存不存在，Chromium 里恒存在。所以：
麦克风按钮照常出现、tooltip 与 aria 写「语音输入」、点下去只得到
「麦克风不可用或未授权」（`use-companion-voice-input.ts:156-159`），
**连 macOS 的授权弹窗都不会弹**。全仓 `getUserMedia` 只有伴星这一条链在用，所以受影响面就是伴星语音输入。

> 这一条**不在我自行实施的授权范围内**：改主进程权限处理器是安全边界 + 打包（`NSMicrophoneUsageDescription`、
> TCC 授权）两件事，已单独提请用户裁决。见 §7 批次 6。

### E1 ✅ 没有"取消/丢弃录音"这条路

`use-companion-voice-input.ts:163-172` 的 `cancel()` **全仓零调用点**。唯二出路是 VAD 判到
1.2s 静音自动收尾，或再点一次＝结束并发送（`:174-177`）。转写不回填输入框（有意设计），
也没有删除/改这条的能力 → 说错了无法撤回。按 AGENTS.md，`cancel()` 属该删链路。

### E2 ✅ 全程没说话会把界面钉死在"我在听"

VAD 永不武装（`companion-voice-vad.ts:62`）→ 到 60s 时 `voice-recorder.ts:149` 自己
`void this.stop()`，**返回值没人接**：hook 仍停在 listening（气泡「我在听」、按钮脉动），
麦克风灯其实已灭，那 60 秒音频丢了；要再点一次才报「好像没录到内容」。

### E3 ✅ 识别中不能中断，最长约 90 秒

两颗麦克风在 transcribing 时被 disabled，而本地引擎 init 60s + 解码 30s
（`local-speech-recognition.ts:122,162`）可以走满，期间无取消无进度。

### E4 ✅ 抽屉里的麦克风在她回复时点了没反应

抽屉那颗只按 transcribing 置灰（`CompanionHud.tsx:2378`），但 hook 的 disabled 还含
`chat.phase === "sending"`（`:329`）→ `begin()` 在 `:132` 直接 return 且**不设 note**。
主交互列那一份既有守卫又有「停止当前回复后可说话」的解释（`:1363-1371`），抽屉两样都没有。

### E5 ✅ 失败提示排在最低一格，等于没有

`voiceNotice` 是 slot 链的**最后一项**（`CompanionHud.tsx:1086`），前面压着回复/停止/半句/
错误/过程/听/识别中；语音失败恰恰常发生在她正回话时 → 点了没有任何解释。且 5s 就被
`dismissNote()` 清掉（`:673-684`），而 note 字符串没变时 effect 不重跑 →
**连点两次同一失败，第二次不重置倒计时、也没有二次反馈**（与 `:44-49` 注释的意图相反）。

### E6 ✅ 朗读打断只存在于"生成中"；降级全程静默

停止按钮条件 `chat.phase === "sending"`（`:1326`、`:2405`），而朗读主要在终态之后
（`liveReply` 被 `speakingRef` 留住）→ 这段时间没有任何"闭嘴"入口。
`text_only`/`failed` 与 `progress.failure` 在 renderer **无消费方**（`:628-643` 一律
`noteAudioStopped()` 吞掉）→ 她不出声时界面不给原因；而
`companion-voice-playback.test.ts:489-505` 对这些状态断言很牢 —— 绿不等于看得见。
另：静音/失焦把 `userInitiatedAudible` 打假时只 `stopVoicePlayback()` 不动 generation
（`HomeV2AudioController.tsx:487-491`），`playVoiceBuffer` 对不可听直接 return（`:321-323`），
但剩余每段照发合成请求并记成 `played`（`companion-voice-playback.ts:647`）→ 质量归因表收假阳性。

### E7 ◐ 失焦即冻、即停声，且无说明

`windowState` 把未聚焦算 hidden（`App.tsx:174`）→ `presencePaused`
（`CompanionPresence.tsx:307`）→ `WindowLive2D.tsx:154,180` 再叠一层 `!document.hasFocus()`。
副屏/并排窗口下她一动不动也不再朗读，而"她在听"不受影响 —— 恰好在用户最容易看着她的时刻丢。

### E8 ✅ 归属判定漏两条，一边反向一边悬挂

- `CompanionRecordImage` 硬编码 `ownedByCompanion`（`CompanionChatRecord.tsx:139`）而被伴星中心复用
  （`companion-center-surface.tsx:13`）→ 中心页的全屏灯箱带 `data-companion-owned`，
  `hasForeignModal` 认作自家（`companion-modal-ownership.ts:31`）→ 中心页开灯箱时伴星不收。
- 快捷设置是 `role="dialog"` 但无 `aria-modal`（`CompanionHud.tsx:1602`），既不判外来也不随
  `eventPaused` 收起（挂载只看 `settingsOpen`，`:1525`）→ 交互台被关掉后右缘那块还浮着。
- Observer 只跟 `open`/`aria-modal`/childList（`CompanionPresence.tsx:319-325`），
  靠 class/hidden 切换的浮层一律漏判。

### E9 ✅ 语音开关没有落点

`voiceEnabled` 只可能因测评页为 false（`CompanionPresence.tsx:1571`），按钮静默消失、无解释；
账号级 `voiceOff`（`packages/shared/src/companion-shell-contracts.ts:224`、
api `companion-shell/service.ts:590`）在 desktop-client **全仓零读写** —— 服务端有这个字段，桌面端没人接。

### 推翻我自己预设的两条（记下来，别再照旧 judgement 动手）

1. **`--companion-*` 在伴星侧不会静默作废**：它在 `.companion-hud`、`.companion-history`、
   `.companion-hud__edge-panel` 各定义一份（`companion-hud.css:1,1117,1858`）。真正"用了但从未定义"的
   只有 `--companion-seat-*`/`--companion-bubble-*`/`--companion-model-top-shift`/
   `--companion-contact-shadow-width`，都由 JS `setProperty` 运行时写入，不是作废声明。
   → doc 30 那条教训**不适用于伴星自己这三块**，别再据此加覆盖块。
2. **`.button` 基类漏网在这批文件里一处没有**：语音按钮都是裸 `<button>` 由 `> button` 选择器接管；
   `CompanionPresence.tsx:1642` 的 `className="button"` 能命中基类（`.desktop-app` 自带 `hud-surface`）。

### 测试覆盖事实

`use-companion-voice-input.ts` **没有任何测试文件**；companion 目录所有测试里搜
`语音输入`/`Mic`/`mic` 零命中 → 麦克风按钮、note、失败文案、unsupported、cancel 全程无覆盖。
有覆盖的只有纯函数（VAD 节拍、RMS 的 `companionVoiceLevel`、本地/云路由降级、播放队列段级降级）。

### 该删的死链路（AGENTS.md）

`isCompanionVoiceAudible`（`companion-voice-playback.ts:172`，0 调用点）、
`getHomeV2VoiceLevel`（`companion-voice-level.ts:18`，仅测试）、
`CompanionVoiceRecorder.active`（`voice-recorder.ts:122`）、
`CompanionSpeechHandle.mode/segments/segmentCount`（外部只用 `.stop()`）、
`CompanionSpeechProgress.failure`（见 E6，要么接上要么删）、
`probeLocalAsrModel` 的 export、`CompanionVadInput` 三个运行时从不传的覆盖参数、`cancel()`（E1）。

## 9. 小构件与设置页（子审计回来后的第二批补充）

下面每条我都自己复核过判据（复核方式写在括号里），只有 F6/F7 标未证实。

### F1 ✅ 动作建议卡读失败就永久读不到（挡用）

`CompanionProposalChoice.tsx:51-63` 的 error 态只有两句文字，**没有重试**；
而 `companion-chat-session.tsx:926` 的守卫是 `!(id in proposalStates)` —— 失败的 id 已经以
`{phase:"error"}` 留在表里，所以重开抽屉也永远不会再取。（读文件 + 读该 filter 确认）

### F2 ✅ 过期与"已在别处决定"收不到，点下去只得到一句学习流程的报错（挡用）

`expiresAt` 在渲染层**从不参与判定**（全仓 grep：只有 invite 与 cue-delivery 用它），
状态更新只靠 `action.expired`/`action.decision` 事件，而订阅随回合 settle 退订
（`companion-chat-session.tsx:1116-1143`）。于是卡面长期写着"等待你的选择"、按钮可点，
点下去撞 409 → `conflict` → 弹的是「这条学习状态已经发生变化，请先同步后再继续。」
（`desktop-client.ts:106`），既不刷状态也不消失，再点再错。另一台设备决定同一件事同理。

### F3 ✅ 决定成功没有可见回执

`CompanionHud.tsx:1246-1248` 只认 loading/pending，非 pending 就把卡从 dock 撤走；
唯一反馈是"正在确认…"一闪，成没成只有读屏知道（`:1539` + clip 隐藏的 `.companion-hud__sr-status`）。

### F4 ✅ 轨道"出错不自动收"被 `tight` 推翻

`companion-agent-rail.tsx:149` 明确在 failed 时 `setCollapsed(false)` 兑现承诺，
`:164` 却是 `folded = collapsed || tight` —— 矮窗口下 `tight` 为真，出错那一轮照样塌成摘要。
另外 `progressText` 的 failed 分支不说"失败"，只剩边框变红（`companion-hud.css:599`）。

### F5 ☑ 静默时段可以把自己锁成"她再也不说话"（挡用，误导）

服务端 `packages/shared/src/companion-proactive-policy.ts:244`：`if (start === end) return true;`
（`:243` 解析失败也 `return true`）＝**全天静默**；而 `CompanionHud.tsx:1749-1766` 的两个时间框
不做任何交叉校验、无提示无确认。另外这一行没有任何说明文字，而静默时段实际只压 routine，
**到点提醒不受管**（`isWithinQuietHours` 仅 `companion-thought.ts:444` 调用）→ 凌晨仍会被提醒吵到。
清空时间框 → 返回 null、不发 patch、受控值把旧值弹回（`:1756/:1764`）＝静默无反馈。

### F6 ✅ 档位语言互相打架

- `companion-account-presence.ts:47-48` 说活跃度=说话长短（对），
  但 `companion-center-surface.tsx:1064` 的人格页写「活跃度：控制伴星主动出现的频率」（**错**：
  `activeness` 只进 `companion-dialogue-content.ts:734-737` 与日记篇幅，念头调度器一次也不读它）。
- 中间档两处不同词：`适中`（`:22`）vs `适度`（center:1065）。
- 同一个快捷设置面板里有三把"别吵我"（在线/勿扰、主动介入/安静、静默时段），只有介入有解释。
- hint 里有计数式表述「约 1 小时 30 分一次」（`:40-49`，现算自 `PROACTIVE_CADENCE_MS`）——
  不是被禁的"一天 N 条"，但"约"配的是精确常量。

### F7 ✅ markdown 不认链接，两处表现相反

`companion-markdown.tsx:19` 的 INLINE_PATTERN 只有 code/粗/斜 —— 无链接分支。
所以记录与抽屉里露出原文 `[笔记](https://…)`，而气泡侧 `plainCompanionBubbleText:65`
把它折成 `t`，URL 彻底消失。全 `apps/desktop-client/src` grep `openExternal|shell.open|target="_blank"`
0 命中 → **她给的链接一个都点不动**。（也正因为没有跳转，不存在"链接把应用窗口导航丢"的风险。）
两套投影不对称：`*斜*`/`~~删~~`/`> 引用` 在记录里留字面符号、在气泡里被剥掉。
XSS 面：无，全走 React 文本节点，测试钉住（`companion-markdown.test.tsx:46-52`）✓。

### F8 ✅ 超长回复被砍且不说"全文在记录里"（挡用的边缘）

`companion-bubble-reveal.ts:93-94` 把气泡文本硬截到 `COMPANION_BUBBLE_MAX_CHARS = 320` 加省略号；
`:119 companionBubbleOverflows`（"需要给出去抽屉看全文的入口"）**全仓只有自己的测试在用**。
所以 >320 字的回复从第 321 字起在气泡里永远看不见，内部滚动也只滚截断后的文本，
终态后连"显示全文"那颗都没了（它只在 `chat.draft` 期间存在）。
诚实结论：全文在对话记录里，不是丢数据，但界面一个字都没说。

### F9 ✅ 试听停不下来（设置页，挡用）

`settings-surface.tsx:1121-1126` 的唯一 `pause()` 挂在手动按钮上；换分区会让 `<audio>`（`:1971`）
整块卸载，而离开设置页的清理（`:1113-1119`）只摘监听不暂停，重挂后 ref 指向没有 `src` 的新元素
→ **旧音频继续放，暂停按钮按的是新元素**，读数冻结。全文件无 `src=""` 清理。
另：保存音色成功零回执（`changeVoice:1049-1065` 只设 failure 不设 notice）；
读失败时"声音"塌成一枚`未读到`、音色整列消失且无重试（`:1932-1942`）；
切引擎静默换音色（`:1929`），千问→edge→千问会无声回到默认那条。

### F10 ✅ 划选投喂右键菜单把系统右键整个吃掉

`CompanionFeedMenu.tsx:28` 在全应用 `preventDefault` 任何右键；笔记编辑器
（`note-editor.tsx:225` 的 contenteditable）里选中文本右键只剩"丢给伴星"。
无 Esc 关闭、打开不聚焦、条目 ~30px，且 >2000 字在显示计数前就被 `truncateFeedText`（`:31`）
切掉 → 计数永远显示切后的 2000/2000。**该文件零测试。**

### 该删的（AGENTS.md，除 §8 那串语音导出之外）

`companion-home-placement.ts`：`shouldCompanionBorrowPlacement`（`:355` 硬编 `return false`，
另配 5 条"永远 false"的测试 `companion-home-cue.test.ts:84-93`）、`companionCueRank`+`CUE_RANK`、
`companionPositionForHomeZone`、`companionNormalizedFootAnchor`、
`companionPositionForNormalizedFootAnchor`、`pointFallsWithinExpandedRect`、
`companionProjectedFootPoint` 的多余 export。（`COMPANION_RAIL_GUTTER` 是默认参数，**活**，别删。）
多余 export：`CompanionRunTraceView.tsx:44 shouldOpenRunTrace`、`companion-bubble-follow.ts:18/32`、
`companion-bubble-clearance.ts:22`、`companion-feed.ts:9-10` 两个事件名；
`settings-surface.tsx:51` 的 `findTtsVoiceOption` 本文件从未使用，
而 `:228 ttsDefaultVoiceFor` 与 `packages/shared/src/tts-voice-catalog.ts:86 defaultTtsVoiceFor` 同一条规则写两遍。
`companion-run-trace.css:75` 设的 `--trace-count` 全仓无人读 → 死内联变量。
`settings-surface.tsx:1022-1025` 那条注释描述的"改昵称同时点这一行"场景已不存在
（昵称在 `accountPanel`、作答方式在 `companionPanel`，`:2343` 一次只渲染一个分区）→ 注释在骗人。

### 未证实（要真机或需复现）

1. 断流回落到轮询时，`agent.tool.proposalId` 可能既没有 `action.proposed` 事件也不在消息的
   `action_ref` 里 → 留痕里的卡永久停在"正在准备选项…"。
2. 原生 `<input type="time">` 在这套纸面 HUD 里的实际观感与命中区（需真窗口）。

## 10. 批次计划（最终版，顺序 = 修完一步能看清下一步）


在原 §7 之上插入两条，并给批次 6 标"需用户裁决"：

用户已裁决：**E0 走"放行麦克风并补打包描述"**。

| 批次 | 内容 | 完成判据 |
|---|---|---|
| **0 判据** | 固化 headless CSS 探针到 `scripts/companion-ui-css-probe.mjs`（命中盒/中心命中/click 是否触发/焦点环落点） | 探针今天就能对 A1 报 0×0 与 `hitIsInsideButton:false`（先红再修） |
| **1 A1** | 念头气泡：外层定位、内层承担命中（收编 `.companion-page-cue` 的形状） | 按钮盒 ≥ 气泡盒、中心命中在按钮内、click 触发；`it()` 断 `openThought` |
| **2 A2** | `learningRun.detail` 补 `invoke("validate")` + `applyRouteToRoom` 表驱动守卫 | 修复前该测试红（变异验证） |
| **3 建议卡三态 F1+F2+F3** | error 态给重试（并让该 id 可重取）；`expiresAt` 到点就地判过期、撤走按钮；确认后留一句回执 | 三条用例 + 过期路径不再能点 |
| **4 静默时段 F5** | 前端交叉校验：`start===end` 不许提交、清空要有反馈；这一行补一句"到点提醒不受这条管" | 用例：相等时不发 patch 且给原因 |
| **5 A3+B4+B5+E4** | 摘乐观条目；dock 改 `!=="history"`；抽屉与输入气泡共用一条错误判据；抽屉麦克风 sending 时给同一句解释 | 各一条 jsdom 用例，逐条变异验证 |
| **6 E0 麦克风** | `main/index.ts` 只放行 `media`（其余仍拒），补 `NSMicrophoneUsageDescription` 与打包 Info.plist 配置 | 权限处理器有单测形状；打包描述存在 |
| **7 E5+E6** | 语音/失败提示抬到"这一轮无正文时优先"、同一 note 重出现要重置计时；朗读降级（`text_only`/`failed`）要有一处人话；终态后给"闭嘴"入口 | 用例覆盖"她在回话时点失败→看得见" |
| **8 B1+B2+E9** | 快捷设置加「声音」跳到既有那一节；菜单小字改准；meta 去 `Live2D`/`版本` | 落点正确；grep 无内部词 |
| **9 F7+F8** | markdown 链接要有分支（外链走外部打开，不做应用内导航）；超长回复明说"全文在对话记录里" | 用例 + 气泡/记录两侧同口径 |
| **10 B3** | "Mao" 收成单一来源 | 生产代码 grep `Mao` 归零（模型资产与夹具除外） |
| **11 E1+E2+F4** | `cancel()` 接界面或整条删；recorder 自停要交回 hook；轨道 `folded` 不再被 `tight` 推翻 failed 承诺 | 无孤儿导出；failed+tight 仍展开 |
| **12 F9+F10** | 试听卸载要真暂停；右键菜单不吞系统右键（限定在可选中区域）+ Esc/焦点；计数按切前长度 | 用例 |
| **13 D+§8 死链+§9 死链** | 无人接手的一律整条删（`__voice`/`--reply`/`--speaking`/`tone page`/`label`/`legacy-proposal`/placement 那七个/语音那六个导出） | 两头对账脚本 0 孤儿 |
| **14 C2** | 次要文字按 4.5:1 就地反算；月历 7px 徽标单列 | 复算表除禁用态全 ≥4.5 |
| **15 C1** | 先统计既有档位再定值，就地改；抽屉语音那颗补 pulse | 命中区 <44 的从 19 收敛到只剩列表行 |

## 11. 我自己还没做的判断

- E7（失焦冻结）是 09-16 那条"任务页不冻结当前帧"裁决的残余，改它等于推翻既有决定 —— 只登记，不擅自动。
- "能不能自定义她的名字"：当时确实没有入口，**2026-09-23 已实现**（见 §22）。
  "要不要能删对话记录"：我登记成"全仓无任何删除入口"——**这条判错了，它一直存在**，见 §22 开头。
- F6 里人格页那句错的"活跃度：控制伴星主动出现的频率"在 `companion-center-surface.tsx`，
  并行会话正在改那个文件 —— **移交**，我只改自己范围内的 `companion-account-presence.ts` 措辞。
- C3 已收口（批次 21，见 §21）：真因不是"气泡 14–17px vs 记录 12px"，而是抽屉正文**从来没声明过字号**
  （一路继承 `<body>` 的 UA 默认 16px），而同一格里"正在说…"的草稿段写着 12px —— 同一句话在她说完那一刻跳一号。
  已把字号挂到 `article` 上，取全站那一档 `--note-writing` = 14px，实机复量正文/段落都是 14px。

## 9. 验收标尺与不做的事

- 每批绿 = `npm run typecheck` 干净 + `npm run test` 受影响文件 0 失败**文件**（ANSI 色会骗过 grep）+ 该批自己的探针/用例红过一次。
- 并行会话正在改 `styles.css` / `home-room.css` / `CompanionHud.tsx` / `companion-hud.css` /
  `companion-chat-session.tsx`（大量未提交删除与性能改动）。因此：**只用 Edit 做定点替换，
  绝不 checkout/reset/restore 这些文件**；跨文件大改（§6 那三个 CSS）一律移交不自己动。
- 不做：不新增"要不要能删对话记录"——**这条已从"不做"里划掉**：删除入口本来就存在（§22 开头，我之前 grep 的词没对上所以漏看），不需要新增也不需要裁决。
  "能不能自定义伴星名字"同样已划掉：2026-09-23 用户点头后落在伴星中心人格页（§22）。

## 12. 实施记录（同日，边做边记）

闸门统一是：`npm run typecheck` 干净 + `npx vitest run <受影响面>` 0 失败文件 + 该批新断言逐条做过变异验证。

| 批次 | 结果 | 实测数字 |
|---|---|---|
| **0 判据** | 新增 `apps/desktop-client/scripts/companion-ui-css-probe.mjs`（headless Chromium + 仓库真实 CSS，量命中盒/中心命中/真点击/焦点环）。**先红后修**：对未修的代码报 `actor 0×0 = 0px²`、`elementFromPoint → DIV.desktop-app`、`click fired = false` | 修前 4 条全红；修后 4 条全绿，退出码 0 |
| **1 A1** | `companion-bubble.css`：把通道定位从气泡移到 `button.companion-cue-open` 自身，气泡在其内部转 static（正是原 `.companion-page-cue` 的形状，那块死 CSS 连同 v1 角落变体一起收编删除）；补 `pointer-events:auto`（祖先链整层 none）；入场改用只做竖直位移的关键帧 | 按钮盒 **240×57.375 = 13,770px²**，与可见块同尺寸；中心命中 `BUTTON.companion-cue-open`；click 触发 |
| **2 A2** | `applyRouteToRoom` 的 `learningRun.detail` 补 `invoke("validate")`；导出该函数并写表驱动守卫：九种可映射落点每种都必须发出换页请求，另加一条"表必须等于映射函数的全部产出"自检 | 15/15 绿；**变异验证**：撤掉那行 invoke → 恰好 `learningRun.detail` 一条红（1 failed | 14 passed） |
| **3 F1+F2** | 会话层：抽出 `loadProposalSnapshots` + 新增 `retryProposal`（错误态不再永久占位），撞 `conflict` 时**取回权威快照**而不是挂一句学习流程口径的报错；卡片：新增 `companionProposalExpired`，`expiresAt` 一过就按已过期渲染、不给按钮；error 态按需画「重试」（配套纸面样式，此前该类名无 CSS）。夹具的 `expiresAt` 从写死 09-21 改为相对当下 | 7/7 绿；**三条变异**：过期判据失效 → 恰好过期用例红；去掉重试按钮 → 恰好重试用例红；未修前那两条"待选择"用例因过期而红（证明判据真的在看 `expiresAt`） |
| 回归面 | `npx vitest run src/renderer/src/components/companion src/renderer/src/app` | **41 文件 / 357 测试全绿** |

### 两处过程记录

- 探针第一版**漏抄了应用的全局 `* { box-sizing: border-box }`**（`styles.css:33-35`），于是报出"按钮 240 宽、气泡 264 宽"这个不存在的缺陷——差值正好是气泡左右内边距 24px。补上 reset 后才是应用真实的盒模型。**探针自己也要被验**：它对未修代码必须红，对已修代码必须绿，两头都对才算有眼睛。
- 本轮开头 typecheck 里有两条 `companion-center-surface.test.tsx` 的报错（`node:fs` 不在 web 工程、隐式 any），那是并行会话在途改动的文件，我没碰；几分钟后复跑已经消失，他们自己修掉了。§6 那条 `.companion-whisper` 残留（`styles.css` 19 条 / `home-room.css` 10 条 / `home-v2.css` 1 条）**仍待他们处理**，我不进那三个文件。

### 第二波（批次 4–7）

| 批次 | 结果 | 实测 / 判据 |
|---|---|---|
| **4 F5** | `quietHoursWithBoundary` 从"回 `null` 让调用方静默"改成 `{ok,value}\|{ok,reason}` 判定：两端相等（服务端读作**一整天静默**，`policy:244` 且有合同钉着）不提交并把后果说在界面上；清空输入也给原因。面板下面补一行「这段时间里她不会主动开口；你约过的提醒到点照样会来」——依据是 `evaluateProactivePolicy` 在 `:152` 就为 triggered 早退，静默时段那条在 `:160` | 7/7 绿；**变异验证**：删掉相等判定 → 恰好那一条红（1 failed \| 6 passed），还原用字节级 `cp` 备份（不碰 git） |
| **5 A3+B4+B5+E4** | `send()` 的 catch 按 `optimisticId` 摘掉乐观条目（409 发生在写用户消息之前，留着一句"你说过但她没收到"的话到下次刷新才消失）；待决选择卡在 `actions` 态改挂在「更多」面板**内部第一行**（dock 与面板共用同一个盒子，直接放开会正好压在菜单上——我第一版就是这么写的，量出重叠后改法）；陈旧报错的门控收成一条 `visibleTurnFailure()`，抽屉那处不再无条件显示；抽屉麦克风补齐 `sending` 的 disabled 与那句解释 | 15 文件 / 357 测试绿；`<section>` 与 `</section>` 各 4 |
| **6 E0** | 主进程权限闸从"一律 false"改成**只放行 `media` + `audioCapture`**，且再过一遍应用自己的 `isAllowedNavigation` 来源判据；`electron-builder.yml` 的 `mac.extendInfo` 补 `NSMicrophoneUsageDescription` | **未在真窗口验证**：这一轮起不来带 CDP 的实例，麦克风是否真的能录、macOS 弹窗是否出现仍待一次实机验收（见 §13） |
| **7 E5** | 麦克风那条提示以前只能抢气泡唯一的槽位，她正说话时看不见 → 正文下面给它自己一行（气泡该空时仍由槽位占位，两处不重复渲染）；hook 新增 `noteRevision`，5 秒内撞同一个失败也会重置倒计时并再给一次反馈（`setNote` 全部收进 `showNote`，6 处） | 65 文件 / **571 测试全绿**；typecheck 0 错；探针仍 4/4 |

### 两处我自己的错，记下来

1. **给 `CompanionQuickSettings` 加「声音」那一行时，我的 `old_string` 跨到了下一个 `<section>` 的开头**，把「陪伴与账号」那一段的起始标签吞掉了。Edit 工具照样报成功。靠"数 `<section>` 与 `</section>` 的个数"抓出来（4/4 才对），当场补回。**加结构性节点之前先想清楚边界，改完要数配平**，不能只看工具回执。
2. **我那个类名对账脚本没有 cwd 守卫**，在错的目录下跑会扫到 0 个 CSS，于是理直气壮地打印「(无)」——差点据此判定"死类名清零了"。现在脚本自带 cwd 参数与"CSS 数不足即退出"的守卫，重跑后真相是 `.companion-page-cue` 已随批次 1 消失、`--page`/`--touch` 仍在（`--touch` 是动态拼类名导致的误报）。**探针自己也要被验**，这条与批次 0 的 box-sizing 教训同源。

### 全库回归

`npx vitest run`（整个 desktop-client）：**1409 通过 / 2 失败**，两条都在 `note-doc-editor-binding.test.tsx`，报 `RangeError: Can not convert <paragraph(…`——那是仓库里已知的"`prosemirror-model` 被装成两份"的环境问题（同版本号、两个实例），该文件本轮无人改动、也不在我范围内。除它以外全绿。

## 13. 还欠的（下一轮从这里接）

1. **实机验收**：只剩麦克风那一条 —— 这台 Mac 实测 **0 个 `audioinput`**（§14），端到端录音不是没做，是没有设备。念头气泡点一次、选择卡不压菜单这两条已在 §14/§15 量过。
2. **批次 9–22 已做完**：F9（试听卸载要真停）、E6（降级那句人话接上了读者）、F7 前后两半（外链通道 + 白名单一份实现）、E7（失焦不再算离场）、改名字（§22）。**语音侧"死导出"那条判定作废**——逐条核下来唯一 write-only 的字段是 `failure`，正确处置是给它接读者，不是删（§22）。
   **还欠的只剩两条，都要等环境而不是等决定**：① E6 那句降级人话与"浏览器被提到前台"只有真链路能验，而这台机器现在**没有 ai-worker 进程**（`companion-dialogue.ts` 等四个 worker 文件正被并行会话改），一次真对话以「消息已经送达，但这次回复等待超时」收场；② 端到端录音（本机 0 个 `audioinput`，§14）。
3. **移交并行会话**：`.companion-whisper` 残留 30 条（§6）；人格页那句错的「活跃度：控制伴星主动出现的频率」（`companion-center-surface.tsx:1064`，我这边只改了 `companion-account-presence.ts` 的口径）；E6 朗读降级要说话——它要动 `companion-voice-playback.ts`，那个文件他们还在改。

### 第三波（批次 9 的一半 + 批次 13）

| 项 | 结果 | 判据 |
|---|---|---|
| **F8 超长回复有个出口** | 气泡右下角那颗复用 `.companion-hud__output-reveal`（与「显示全文」同位、同族，且**天然互斥**：那颗只在流式草稿期存在，这颗要到终态之后），点击 `chat.setMode("history")`。`companionBubbleOverflows` 从此有真实调用方——它写的"需要给出去抽屉看全文的入口"终于存在了 | 全库 **1414 通过 / 2 失败**（那 2 条是已知的 `prosemirror-model` 双实例）；typecheck 0 错。**该按钮本身没有组件测试**（`CompanionHud` 全仓无测试文件，起一套 provider+网关替身的成本另计），判据是那条纯谓词已有的用例 |
| **D 组收口** | `CompanionBubble` 从四档收成两档（`cue`/`touch`）：`page`/`reply` 两个 tone、`label`、`speaking`、`className` 四个从未被传过的 prop 连同 `.companion-bubble__label`、`.companion-bubble--page` 两条 CSS 一起删；`--reply`/`--speaking`/`__voice` 本来就没有 CSS（朗读指示是三个画不出来的 `<i>`） | 类名两头对账现在**双向都是 (无)** |
| **`legacy-proposal` 补样式** | `companion-history__legacy-proposal` 以前查无此规则，那句"原执行节点已不可用"和卡片裸排在正文里；给了 grid/gap 与一条次要文字 | 同上 |

### 把对账工具本身验了一次（它以前会假绿，也会假红）

1. **假红**：`.companion-bubble--touch` 被报成死类名，其实是 `` `companion-bubble--${tone}` `` 动态拼的（`CompanionPresence.tsx:1612` 传 `"touch"`）。加了 `builtDynamically()`：待判死的名字若在源码里存在"某个前缀紧接 `${`" 的模板，就算活。
2. **假绿**：修完后它打印 "(无)"——这正是"什么都没扫到"和"扫到了但都干净"共用的输出。所以补了输入量守卫（扫到 <5 个伴星 CSS 就退出码 2）与 cwd 参数，并做了一次**自检**：临时放一条 `.companion-zzprobe-dead` → 它报了；同文件里再放一条 `.companion-bubble--zzdynamic`（撞上动态前缀）→ 它不报（这个方向上它宁可漏报不误删）。临时文件已删。

### 第四波（语音交互缺口 + 轨道失败态 + 投喂浮层）

| 项 | 结果 | 判据 |
|---|---|---|
| **E1 拾音没有"这次不算"** | 拾音中在气泡左下角给一颗「取消录音」，接上那条一直无人调用的 `voice.cancel()`。它与另外两颗天然互斥：`sending` 期间麦克风禁用（起不了录），「显示全文」只在草稿期、「全文在对话记录里」只在终态后 | `grep voice.cancel` 由 0 变 1；孤儿导出消失 |
| **E2 60 秒后界面假"我在听"** | `CompanionVoiceRecorder` 到上限不再自己 `void this.stop()`（返回值没人接、60 秒音频当场丢、气泡仍写「我在听」、按钮仍脉动），改为 `onLimit` 交回调用方走正常收尾；加了 `limitFired` 单次触发与 `start()` 复位，hook 侧接 `finishRef` | 单元层不可测（`start()` 要真 `getUserMedia`）——**没有为它写假测试**，只登记待实机 |
| **F4 出错那一轮只剩红边框** | `progressText` 补 failed 分支说「没说完」（与记录里那句「这一轮没能说完」同口径）。`folded = collapsed || tight` 保留：矮窗口下"不自动收"确实会让轨道越出窗口，所以改为**塌成摘要行也要把失败写进这句话** | 新用例；**变异验证**：删掉那一行 → 恰好该用例红 |
| **F10 投喂浮层（含对子审计的更正）** | 子审计报的是"全应用右键被吞"——**核实后不成立**：`CompanionFeedMenu.tsx:27` 无选区时直接 return，系统菜单照旧。真问题是两处：计数显示的是切过的长度（选 5000 字永远写着「2000/2000」），以及没有 Esc。都改了，并给这个零测试文件补了 5 条用例 | 5/5 绿；**变异验证**：把计数改回 `menu.text.length` → 恰好超长那条红；第 1 条（不该接管）与第 2 条（该接管）方向相反，共用同一发事件机制，所以"没有选区不接管"那条绿不是瞎读 |

### 三条踩坑记录（都是我自己工具的错，不是产品的）

1. `fireEvent.contextMenu(...)` 返回的是「事件**未**被取消」这个布尔，我按 `event.defaultPrevented` 去读，拿到 `undefined`，看起来像"组件从不拦截右键"。**先归因打印值的来源**，再怀疑被测物。
2. 改用裸 `document.body.dispatchEvent` 后菜单"不再出现"——因为不在 `act()` 里，React 的更新没冲下去。包上 `act` 即绿。**假失败优先怀疑自己的探针**。
3. `window.addEventListener` 不返回退订函数（我把它当成仓库里那个 `subscribeCompanionFeed` 了）。顺手改用真正的订阅口，反而多验了一层"投喂与开抽屉成对"。

### 一次不属于我的红

`npm run typecheck` 中途报过 3 条 `app-render-scope.test.ts` 找不到 `node:fs/path/url` —— 那个文件我没建也没碰，两次命令之间它被并行会话创建又删掉了（现在 typecheck 干净）。记录在此，避免下一轮把它当成回归。

### 当前闸门数

全库 `npx vitest run`：**1423 通过 / 2 失败**（仍是 `note-doc-editor-binding.test.tsx` 的 `prosemirror-model` 双实例）；typecheck 0 错；两个探针（CSS 几何 4/4、类名两头对账双向 (无)）均绿。

## 14. 实机验收（2026-09-22 深夜，真窗口 1440×810）

起法：`./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --user-data-dir=/tmp/qoder-companion-udd --remote-debugging-port=9333`（**不能 `node ./node_modules/.bin/electron`**，那是 sh 包装脚本，交给 node 跑会 `SyntaxError: missing ) after argument list`）。探针：`scripts/tmp-companion-live{,2,3}.mjs`。验完只杀自己那个 pid，临时 user-data-dir 已删。

### 批次 6 的权限闸：实机证成

- `navigator.permissions.query({name:"microphone"})` → **`granted`**。旧的 `setPermissionCheckHandler(() => false)` 不可能给这个值。
- `getUserMedia({audio:true})` → **`NotFoundError: Requested device not found`**，不是 `NotAllowedError` —— 请求已经过了权限层、走到设备选择。
- 但 `enumerateDevices()` 报 **0 个 `audioinput`**：这台机器没有麦克风。所以"录不了音"这次不是产品问题，**端到端录音仍然没验到**（缺的是设备，不是代码）。

### 命中区：从"CSS 声明值"换成"实测盒尺寸"

| 界面 | 可点元素 | <44 | 最差的几个（实测） |
|---|---|---|---|
| 快捷设置边缘面板 | 23 | **20** | 静默时段开关 24×42、分段按钮 32×47、时间输入 32×77、滑块 20×282（珠 18）、我新加的「朗读与音色」也是 32×82 |
| 对话记录抽屉 | 18 | **18（全部）** | 麦克风 34×34、发送 34×34、头部三颗 40×40、13 条「执行过程」`<summary>` 高 36 |
| 文字输入气泡 | 26 | 21 | 收起按钮 34×34、textarea 高 36 |
| 三颗主控制 / 菜单行 | — | 0 | 44×44、58×354，达标 |

另两条只有量得出来：**搜索框自己的盒子 17px 高**（外层胶囊 33px，点胶囊的空白内边距不聚焦，因为那不是 `<label>`）；月历面板 262×248 **没有被抽屉裁**（`clippedByDrawer = 0`）—— 我上一轮撤回的那条判断是对的，同时徽标 computed 字号确认就是 **7px**。

### 三条新的实机观察（静态读不出来）

1. **打开对话记录时，伴星本人被压掉约 74%。** 抽屉 410×782 钉在右缘，她 264×367 站在 x≈948–1212，重叠面积实测 **71,932 px²**。她自己的对话框把她挡住大半。
2. **遮罩功能上有效、视觉上几乎不存在。** scrim 实测 1440×810、`rgba(31,24,19,.28)`、左侧命中归它 —— 但夜间房间场景本来就接近这个亮度，看图时我第一反应是"遮罩没生效"。模态感在这种底图上不靠 28% 深棕传达。
3. **「查找记录」打开后整屏是空的**：只有搜索框、「按日期」和一句说明，下面全是空白。它按设计只负责"找"（时间线在对话视图），但用户点进来第一眼像坏了。

### 名字这条现在有实测支撑

形态三档的按钮实测写着 **Mao / 大肥鱼 / 小彩**（`WINDOW_LIVE2D_MODEL_REGISTRY` 的 displayName），而消息署名、按钮 aria-label、加载语等 15 处写死 "Mao" —— 选「小彩」之后，界面上每一句话仍然说 Mao。

### 探针自己的三次错（都记下来）

1. 把 sh 包装脚本交给 `node` 跑 → 启动失败，报的是 shell 语法错，长得像产品坏了。
2. 第一遍为了精简删掉"先点更多功能"那一步，于是「伴星设置」「对话记录」都报"找不到入口"，而输出里那句「更多菜单（已开）」成了假话 —— **量到 0 个元素先怀疑探针**，不是怀疑产品。
3. 截图与状态漂移对不上号（`companion-settings.png` 里画的是查找记录）。第三遍改成每次先 `reload()` 再走单一路径。

## 15. 批次 15：命中区抬回全站那一档（C1，实机复量）

**没有自定档位。** 依据三条：`DESIGN.md:153` 写了"至少 `44px` 的真实 DOM 命中区"；全站（伴星目录之外）67 条带 `min-height` 的控件规则里 **44px 占 27 条**，母本 `.hud-surface … .button { min-height: 44px }` 在 `objective-flow.css` 多处钉着；而"列表行 ≥32"是 doc 30 B7 已经定过的口径。对照之下伴星目录内 14 条里只有 3 条到 44。所以这一步是**把伴星侧抬回母本**，不是新造一档。

改的是 4 个 CSS 文件（`companion-hud.css`、`companion-chat-record.css`、`companion-proposal-choice.css`、`companion-run-trace.css`），改前/改后都用同一把真窗口尺复量（`scripts/tmp-companion-live{,2}.mjs`，1440×810）：

| 界面 | 改前 <44 | 改后 <44 | 说明 |
|---|---|---|---|
| 更多菜单 | 1/7 | **0/7** | 面板头部关闭/返回 34→44（三列模板的列宽同步改，否则标题被挤进按钮列） |
| 快捷设置面板 | **20/23** | **0/23** | 分段按钮 32→44、按钮组 36→44、时间输入 32→44、滑块 20→44（轨道仍 8px，Chromium 自己居中，观感不变） |
| 文字输入气泡 | 21/26 | **0/26** | 收起 34→44 |
| 对话记录抽屉 | **18/18（全部）** | **0/18** | 麦克风/发送 34→44、头部三颗 40→44、textarea 34→44、13 条「执行过程」折叠条 26→44 |
| 查找记录 | 4 个里 3 低 | 4 个里 **1** 低 | 唯一剩下的"低"是搜索框自身 42px 高——它住在 44px 的胶囊里并且填满胶囊，点哪儿都能聚焦（改前它的盒子只有 **17px**，点胶囊内边距不聚焦） |
| 月历 | 格子 30 | 格子 **34** | 按"列表行 ≥32"那一档，不跟 44 抢空间；面板 262×280，实测仍未被抽屉裁（`clippedByDrawer = 0`） |

两处刻意保留的形状差异：**静默时段开关**画出来仍是 42×24 的药丸，命中区扩成 44×44（药丸挪到 `::before` 居中，选中态的描边/底色跟着搬到 `::before`），视觉尺寸一分未变；**清空搜索那颗 22px 圆钮**没动（它在 44px 胶囊内，且真正的目标是旁边填满的输入框）。气泡内那两颗胶囊（「停止」「显示全文」，约 22px 高）**本轮没动**，理由是它们嵌在气泡底部、抬到 44 会吃掉正文行，且同一动作在别处有全尺寸入口（停止在输入行是 48×48）——这条作为已知例外记在这里。

目视复核（`/tmp/live3-settings.png`）：滑块轨道居中未偏移、开关药丸与珠子位置正常、选中态仍是薄荷、面板 340×723 在视口内。回归：typecheck 0 错，`companion + app` **42 文件 / 363 测试全绿**。

### 两条踩坑（都是自己的）

1. **`min-height: 44px` 插进了一个同一块里已经写着 `min-height: 26px` 的规则的前面** —— 后写的赢，等于没插。第一次复量时 13 条折叠条仍然 36px 才发现。补了一个"同块重复声明"扫描器扫全部伴星 CSS（现在 0 处）。**加声明要先看那块里有没有同名声明。**
2. 探针跑第三遍时报"找不到更多功能"，量到 0 个元素——应用自己落到了「学习服务暂时不可用」的门禁（并行会话在动 api 侧）。给 `live2/live3` 各加了"先点重新连接"一步，并让 `live1` 起跳前 `reload()`。**量到 0 先怀疑探针与现场，不要怀疑产品。**

## 16. 批次 14：次要文字对比度（C2）

**没有自定颜色。** 母本的次要文字是 `--hud-soft: #705d4d`（`hud-pages.css:33`；`understanding-universe.css:2045` 就是拿它当 `--universe-muted`），而伴星侧自己写了一支更浅的 `#876f5f`。所以这一步是**把伴星侧指回母本那一份**，不是新调一个色。

改动（全在伴星目录的 4 个 CSS 里）：

1. `--companion-muted` 的三处定义（`.companion-hud` / `.companion-history` / `.companion-hud__edge-panel`）改成 `var(--hud-soft, #705d4d)`。
2. 六处一次性棕字（过程行 `rgba(137,107,78,.8)`、气泡 note `.92`、轨道溢出 `.8`、留痕摘要 `.95`、轨道图标 `.92/.8`）全部换成 `var(--companion-muted)` —— 它们是同一个"次要文字"的第四、五份抄本。
3. 四处**用 `opacity` 表达"次要"**的地方改成直接给次要色（`nav--plain .68`、`image-note .8`、两处 `figcaption .74/.72`、`quote button .78`）。`opacity` 会连对比度一起压下去，而它想说的只是"这行不重要"。
4. 月历条数徽标：7px + `--companion-mint-strong`（实测 **1.50:1**，等于看不见）→ 9px + 次要色。
5. 取消态那一行**保留安静、但不再靠压字**：文字给次要色，"弱"交给图标（`rail-mark` 仍是半透明）。

**实机复量**（`scripts/tmp-companion-contrast.mjs`，沿祖先链找不透明底色后浏览器实算，不信 CSS 里写了什么）：

| 元素 | 实测 |
|---|---|
| 快捷设置 · 组标题 10px | **5.94:1** ✓（改前 4.47） |
| 快捷设置 · 权限说明 11px | **5.57:1** ✓ |
| 快捷设置 · 分段按钮 11.5px | 8.61:1 ✓ |
| 边缘面板 · 标题 14px | 8.37:1 ✓ |
| `.companion-hud` 上 computed `--companion-muted` | `#705d4d`（母本值确实到位，portal 出去的两块也拿到了） |

**没验到的部分，如实说**：抽屉里那几行（消息头 4.19→按同一底色推算 5.57、日期分组、系统行、留痕 summary）**只有推算、没有实机复量** —— 探针连着三次因为自己的点击序列把抽屉关掉而量空，我停在"再猜一次"的门槛上收了工。它们用的是同一个 token，值这一侧已经由边缘面板证明；差的是那几行各自的底色。下一轮补这一段只要 `更多 → 对话记录` 之后别再点别的。

回归：`companion + app` **42 文件 / 363 测试全绿**；CSS 几何探针 4/4；类名两头对账仍 (无)；同块重复声明扫描 0 处。`npm run typecheck` 有 2 条报错在 `ReviewSurface.test.tsx`（并行会话在改的文件，我一行没碰）。

## 17. 批次 10：她的名字（B3）+ 上一轮欠的抽屉对比度补测

**这条比原报的更严重。** 原报是"切了形态仍署名 Mao"。查到库里 `pet_profiles.name` 存的是 **`爱吃白饭的大肥鱼`** —— 也就是说界面上那十几处写死的 "Mao" 根本不是她的名字，是 **Live2D 模型名**（`window-live2d-contract.ts` 的 `displayName`）。她真正的称呼在伴星中心用着（`companion-center-surface.tsx:718`：`persona?.profile?.name ?? activePreset?.name ?? "伴星"`），而**伴星身边一处都没用**。

做法：
1. 新增 `components/companion/companion-display-name.ts`，把那条推导收成一份（取不到人格时回"伴星"，不回模型名）。中心那一行改成调用它是**移交项**（那个文件并行会话在改），在它改之前这里是唯一实现。
2. 名字住在会话层（`CompanionChatSession.companionName` + `setCompanionName`），气泡、抽屉、记录署名、头顶轨道共用；**换空间时复位**，不留上一个空间里的名字。
3. `CompanionPresence` 在已有的账号读取里顺带取一次人格（同一个已鉴权 epoch，不多加一次鉴权往返），**单独包 try**，且**不走 `unwrapGatewayResult`** —— 它对任何 not-ok 都先 `publishGateInvalidation` 再抛，一次补白读取不该把工作区视图打回首页。
4. 替换：HUD 14 处、记录署名 1 处、轨道 aria-label（改成 required prop，测试里故意用"小彩"，标签不跟 prop 走就会红）、加载语 1 处。

**实机复量**（真窗口，浏览器 computed 值，不读 CSS 源码）：

| 读数 | 实测 |
|---|---|
| 抽屉消息署名 | **爱吃白饭的大肥鱼**（改前 Mao） |
| 输入框 aria | 「继续问 爱吃白饭的大肥鱼」 |
| 消息头 10.5px 对比度 | **5.57:1** ✓（§16 欠的那条，改前推算 4.19） |
| 日期分组 11px | **5.94:1** ✓ |
| 留痕摘要 | **8.29:1** ✓ |
| 月历徽标 | **9px / rgb(112,93,77)** = 母本 `--hud-soft` ✓（改前 7px / 1.50:1） |

§16 里"只有推算没有实机"的那几条，这一轮全部补成实测。

**回归**：`npm run typecheck` 0 错；`npx vitest run` 全库 **171 文件 / 1429 测试 0 失败**（上一轮那两条 `prosemirror-model` 双实例的红也已消失，是并行会话处理的，不是我）。实例按 user-data-dir 认归属收掉，临时目录删除。

### 一次探针的自伤（记着）

补测脚本连开两个进程，第二个假设"上一个进程打开的抽屉还在"——`connectOverCDP` 之后调 `browser.close()` 会把应用一起关掉，于是量到全空，看起来像产品坏了。改成**一个自包含脚本：自己开抽屉、自己量、结尾 `process.exit(0)` 不碰 close**。跨进程接现场 = 假失败。

## 18. 批次 13 之一半：死导出清理（先做能被闸门兜住的那一半）

逐条自己数过调用方（全仓 `apps|packages|workers` 的 `.ts/.tsx/.mjs`，排除 `node_modules`、`out/`），不照抄子审计清单。

**删掉（零调用方）**：`isCompanionVoiceAudible`（`companion-voice-playback.ts`，注释里说的那条"换一次性台词"路径不存在）、`getHomeV2VoiceLevel`（连同它那条冗余断言 —— 前一行 `listener.mock.calls` 已经证明末值是 0）。
**去掉多余的 `export`（本文件内仍在用）**：`COMPANION_FEED_EVENT`、`COMPANION_OPEN_CHAT_EVENT`、`shouldOpenRunTrace`、`probeLocalAsrModel`。
**删掉死内联变量**：`CompanionRunTraceView.tsx` 设的 `--trace-count` 全仓没有 CSS 读它（同文件那个 `--trace-delay` **有**读，`companion-run-trace.css:68` 的 `animation-delay`，保留）。

**判错两条，当场撤回**：`companionBubbleAtBottom` 与 `companionProjectedFootPoint` 我按"只有测试在用"降级了 export，typecheck 立刻报 2 条 —— 它们都是**活的产品逻辑**，测试是直接测内部助手。AGENTS.md 要删的是零调用方，不是"只有测试调用"。**这条判据写下来**：区分"没人用"和"只有测试用"，后者要先问逻辑是否还活着。

闸门：typecheck 0 错，全库 `npx vitest run` **172 文件 / 1438 测试 0 失败**。

### 剩下没做的（要读文件才能删，不盲删）

`companion-home-placement.ts` 里那六个（`shouldCompanionBorrowPlacement` 硬编 `return false` 且只有"永远 false"的测试、`companionCueRank`+`CUE_RANK`、`companionPositionForHomeZone`、`companionNormalizedFootAnchor`、`companionPositionForNormalizedFootAnchor`、`pointFallsWithinExpandedRect`）—— 删它们要连带删掉配套测试，而那个文件我还没读过，**不在没读的文件上动刀**。同理 `CompanionSpeechHandle.mode/segments/segmentCount`、`CompanionSpeechProgress.failure`（E6 里"要么接上要么删"的那条）、`CompanionVadInput` 三个运行时从不传的覆盖参数。

## 19. 批次 9：链接（F7）—— 做了"不骗人"的那半，点了能开的那半停在共享设施

**为什么只做一半**：全仓（`src/main`、`preload`、`packages/shared`）没有任何"打开外部链接"的能力。要让她给的链接真的能点，得新加一条只放行 http/https 的 `shell.openExternal` 通道 —— 那是 **主进程 + preload + 共享合同三处一起动的共享基础设施改动**，而 `desktop-ipc.ts`、`desktop-gateway.ts` 正是并行会话此刻在改的文件（本轮结束时 `desktop-ipc-companion-visibility.test.ts` 刚被他们新建出来，还带着 7 条红）。所以我停在这里，不抢着改共享面。

**已经落地的**：不再把 markdown 原文吐给用户。
- `companion-markdown.tsx` 加了链接分支，**改成具名组**（我第一版按位置数 `match[8]/[9]`，实际是 6/7 —— 具名组让这类错位不可能发生）。
- 渲染成"标签 + 去处"两行（`.companion-md__link` + `<small>url</small>`），**刻意不画 `<a>`**：主进程 `will-navigate` 会把外链拦下来，一个"看着能点、点了没反应"的下划线比没有链接更糟（同一条判据就写在本仓库 `NavBlockLine` 的注释里）。
- 只认 `http(s):`；`javascript:`、`data:` 不解析成结构，照字面留成文字（这里没有 `dangerouslySetInnerHTML`，所以它既点不动也执行不了）。
- 气泡那侧维持原样：`plainCompanionBubbleText` 把 `[t](u)` 折成 `t` —— 朗读不该念 URL。

**验证**：markdown 12/12 绿（其中 8 条是既有的，具名组重构没碰坏 code/粗/斜就是靠它们兜住的）；新加 4 条链接用例；**变异验证**：把 `https?:` 限制去掉 → 恰好"非 http 不解析"那条红。

**闸门现状（归属说清）**：`src/renderer/src/components/companion` + `app` 全绿；全库跑出 7 条红 + 若干 typecheck 错，全部落在 `src/main/desktop-ipc.ts:1340` 与新建的 `desktop-ipc-companion-visibility.test.ts`（git 显示前者 M、后者 ?? 未跟踪）—— 并行会话的在途工作，不是我改的文件。我这轮在主进程只动过 `index.ts` 的权限闸（上一批），与这些行无关。

### 下一轮的入口

§13 那批未做项 + 本节的"能点"半条（要一次共享设施改动，建议单独一批、由用户点头后再动 `desktop-ipc.ts` / `preload` / 共享合同）。

## 20. 批次 13 的另一半：`companion-home-placement.ts` 那六条

读完整个文件才动刀（上一节"不在没读的文件上删代码"欠的就是这一步）。

**先核"零调用方"这一层读对了没有**：`shouldCompanionBorrowPlacement`、`companionCueRank`/`CUE_RANK`、`companionPositionForHomeZone`、`companionNormalizedFootAnchor`、`companionPositionForNormalizedFootAnchor`、`pointFallsWithinExpandedRect` 六个名字在全仓（含 `packages`、`worker`、`scripts`）只剩两处命中，都在 `companion-home-placement.test.ts` / `companion-home-cue.test.ts` 的 import 与用例里；没有 barrel 再导出，也没有 `obj[name]` 这种运行时算出来的名字。删。

- `shouldCompanionBorrowPlacement` 函数体是 `void input; return false` —— 它已经不是"一条策略"，是一句写死的话：**用户手放的位置谁也不许借**。这句话现在由"整条借用路径不存在"来保证，留着函数反而让下一个读代码的人以为有个开关。它的两条产品含义在 §12 批次 0 的记录里，不靠这段代码讲述。
- `companionCueRank` 排序表：客户端早就不做多路仲裁了（`companionCueAllowed` 只看 `priority !== "ordinary"`），"谁的主动气泡更急"这件事归服务端。留着这张表 = 留第二套没人在读的优先级，正是 §13 里抱怨过的"两套定义同一个安静"的形状。
- 连带删掉 `HOME_ZONES`（唯一的消费者就是 `companionPositionForHomeZone`，模块私有常量，不删就成了死变量）。
- 配套测试：删 4 个用例块（每语义锚点都在画面内 / 拖动脚点跨视口取整往返 / 两条 cue 排序）。`separates head and body touches` 那条**混着**活函数 `companionTouchKindAt` 和死的 `pointFallsWithinExpandedRect` —— 只切走死的那两半，留活的并改名为"by the visible height ratio"。这种混装块是删测试时最容易整块带走活断言的地方。

**共 -78 行**（源文件）+ 两份测试里的死块。

**闸门**：typecheck 我这边 0 错（唯一一条红落在并行会话的 `desktop-ipc.ts:1344`，`window.on(channel)` 那个联合通道过不了重载，归属已写清、不是本批文件）；`components/companion` + `app` **42 文件 / 360 测试全绿**。

**留在原地的两条"只有测试用"，核过之后是活的**：`companionProjectedFootPoint`（被 `companionPositionForProjectedFootAnchor` 内部调用，测试测的是投影/反投影这一对往返）、`COMPANION_ORDINARY_CUE_DEBOUNCE_MS`（被 `companionCueAllowed` 内部读，测试守的是"客户端只剩这一个旋钮"这条合同）。按 §18 写下的判据，这两条不删也不降级。

## 21. 批次 21：§14 三条实机观察里能改的那条，外加两条量出来的新缺陷

### 先还 §16 欠的那笔账（抽屉那几行只有推算、没实机）

`scripts/tmp-companion-contrast3.mjs` 量完：**正文 16px · 7.89:1 ✓、消息头 10.5px · 5.61:1 ✓、引用块 11px · 7.62:1 ✓、日期分组 11px · 5.95:1 ✓** —— 推算的 5.57 是对的，但现在它是量出来的。

**"连着三次量空"的真因是我自己的探针**：`tmp-companion-contrast.mjs` 对每个标签**只留第一次读数**，而第一次是在对话视图拿的（那时 `.companion-record__*` 本来就没挂载），于是后面真量到的也被丢掉。第二处错：正文的选择器写成 `article > p`，实际正文在 `div.companion-record__body` 里（`CompanionChatRecord.tsx:210`）——**"屏上没有"要先分清是没数据、还是选择器没对上**。

### 观察 3「查找记录打开是空的」——量出来是 68px / 651px

内容层实测 68px 高，外面列表 651px，**九成是空的**。改成一块居中的落地位（`.companion-record__landing`）：一句标题 + 两条路径各自说清去哪儿 + 一句"点一条回到原位"。改后实测 **149px 高、上留白 251 / 下留白 252**（真居中），截图 `/tmp/b21b-landing.png`。没有新增数据路径：`allMessages` 仍然只在第一次输入/开月历时才拉，不为了填空屏去预载整库。

### 顺手量出来的一条：抽屉正文从来没被排过版

`--companion-record__body` 全仓**没有任何 font-size 规则**，一路继承到 `<body>` 的浏览器默认 **16px** —— 全站没有一档是 16，而同一屏输入行只有 12px，正文比自己的输入行还大一号。更要紧的是同一条 `article > p` 写着 12px，而它管的正是**进行中那一轮的草稿段**：同一句话在她说完那一刻从 12 跳到 16。

改法（不是自定档位）：字号挂到 `article` 上，取 **`--note-writing` = 14px**（`hud-surface.css:6024`，笔记正文那一档），`article > p` 只留 `white-space: pre-wrap`。实机复量：**正文 14px、段落 14px**，消息头 10.5 / 日期 11 的层级没动。
**连带放行**：`.companion-record__stopped`（自己写 10px）与 `__image-note`（10.5px）以前被 `article > p` 的特异度压成 12px，**写着的值从来没生效过**，现在生效了。

### 观察 1/2 归位：一条不是缺陷、一条留给主进程

- **抽屉压住她 74%**：这条不动。理由是我这轮刚删掉的那句产品决定 —— 用户手放的位置谁也不许借（§20），为了一个面板把她挪走正是"隐形磁铁"。面板盖住房间是面板的本分。
- **遮罩视觉上几乎不存在**：这条**量完就改了**（原判"登记不动"是还没量）。全站真遮罩只有两处：
  `<dialog>::backdrop` 用 `rgba(25,17,12,.46)`（`home-v2.css:980`）、正式挑战确认层用 `rgba(39,33,27,.55)`
  （`objective-flow.css:626`），而伴星这扇唯一会把整页设成 `inert` 的面板自己写着 `.28` —— 三张里最浅的一张。
  改成取全站那一档现成的 `.46`，**两个场景各测四档**（同页 A/B，只改 `style.background`，房间左半 1400×1000 区域平均亮度）：

  | 遮罩 | 日间（无遮罩 166.4） | 夜间（无遮罩 67.6） |
  |---|---|---|
  | 旧值 `.28` | 127.2（暗 23.6%） | 55.9（暗 **17.4%**） |
  | `dialog .46` | 98.7（暗 40.7%） | 45.3（暗 **33.1%**） |
  | 确认层 `.55` | 93.6（暗 43.8%） | 49.1（暗 27.4%） |

  两条只有量出来才知道的事：① 旧值在**日间**其实暗了 23.6%，§14 那句"看不见"是**夜间**现场 —— 夜间基数只有 67.6，
  17.4% 折成绝对值只有 11 个点，所以不是"遮罩没生效"而是"暗得不够基数"。② **`.55` 在夜间比 `.46` 更亮**
  （49.1 vs 45.3）—— 两支底色不同（近黑 vs 浅棕），"alpha 越大越暗"跨底色不成立，所以不能靠数字大小挑档。
  取 `.46`：全站用过的值、且在两个场景里都是最暗的那一档。

### 观察 4（本轮新找到的两条，都来自同一次读数）

1. **执行过程把"给模型看的工具说明"直接吐在界面上**。真窗口截图里明晃晃写着「读取学习数据统计：…。**只在用户问自己学了多久/进度如何时调用**；她跟你打招呼、闲聊…不要调」。原因：`nodeLabel()` 那张"给人看的一句话"表（`companion-agent-nodes.ts:76`，2026-09-22 为"看不到过程"专门加的）轨道和头顶那句都走它，**只有 `CompanionRunTraceView.tsx:90` 是裸渲染 `node.label`** —— 修好的机制在同一条链上被绕过了。改成走 `nodeLabel(node)`。实机复量：那一步现在写「正在看你的学习数据」。
   两条新用例（**先红后绿**：改之前 `× 工具节点说给人听的那句话`、`× 认不出的工具不猜语义`；已有的 2 条一直绿 —— 它们只断状态字，从不断 label 文本，所以这个绕过能活这么久）。
2. **`safeSummary` 里装的是英文机器话**：「正在看到期复习 ｜ **tool arguments failed schema validation** ｜ 失败」。字段名写着 safe，内容是排查日志用的串。源头在 `packages/shared/src/companion-agent-registry.ts:164/168`（唯一产出点，运行期由 `workers/ai-worker/.../companion-agent-runtime.ts:3280` 原样放进 `safeSummary`，同一份又回给模型当工具报错）。**在源头改成中文一句**，两边一起变；同层其他 `safeSummary` 本来就是中文人话（"检索词是空的，我需要先知道要搜什么"）。
   改前先核：全仓没有测试断言这两条串；`companion-agent-registry.ts` 在 git 里是干净的（并行会话没在改这个文件）。**如实说清边界**：这条只管**以后**的失败轮次 —— 我看到的那一行是已经落库的历史轨迹，旧串还在里面；dev 那侧 worker 要不要重启才生效不归我动。

### 闸门

`npm run typecheck`（桌面）**0 错**；`components/companion` + `app` **42 文件 / 362 测试全绿**；桌面全库 **173/174 文件、1464/1465 测试**，唯一那条红在 `CardGenerationSurface.test.tsx`（git 显示该文件与它测的界面都没人改过，**单独重跑 10/10 绿**，按负载抖动记账，不算回归也不算绿）；`packages/shared` typecheck 0 错 + **375 测试 0 失败**；`workers/ai-worker` typecheck 0 错。

### 探针留下的三个自己的错（都记下来）

1. 我的点击匹配器写的是 `aria-label` 含"对话记录"，而抽屉那颗图标钮的 label 是「**关闭**对话记录」——图标按钮 `textContent` 是空的，所以"排除文字里带关闭的"这条兜不住它，探针自己把抽屉关了。改成 label 与 text 一起排。
2. 在**上一个探针留下的中间态**上走路径：第二次"点更多功能"其实是把菜单关掉，于是一路"找不到入口"。改成每次先 `reload()`。
3. 实例停在**超时中的正式挑战**页面上，伴星那三颗主控制本来就不在那一页 —— 找不到入口不是产品坏了。量之前先看现场（本轮起每次都打印"命中的是哪一颗"）。

### §18 那条"类名两头对账"原来没有落成文件 —— 这次补跑了

它当时是一次性的 `node -e`，仓库里查无此脚本，所以那条闸门是不可复跑的。本轮就地重写了一遍（带输入量守卫：扫到 <5 个伴星 CSS 或 <30 个类名就直接退出码 2），结果：**116 个声明类名，死类名 0**（唯一报出来的一条 `surface-data-state` 是**目录边界造成的假阳性** —— `companion-root.css` 里那条只是 `.companion-unavailable-notice` 作用域下的覆盖，真正打这个类名的是 `surfaces/surface-data.tsx`，在扫描目录之外。这条限制与 §18 记过的"对外部消费者的对账看不见同文件引用"是同一族）。
顺手记一个自己的错：我第一版把类名正则写成 `\.([a-z][a-z0-9]*(?:__|--)?[a-z0-9-]*)`，它会在长名字上截断，于是把我自己加的三条全报成"CSS 里没有"；换成 `\.([A-Za-z_][\w-]*)` 并先剥注释才对。**"两头都在"这种断言，先证正则真的抓到了全名**。

## 22. 批次 22（2026-09-23 上午）：用户点头的四条 + 之前"卡在别人文件"的三条

开工前先核并行的现场：**并行会话还活着**（最近 12 分钟 20 个文件被写，含 `companion-bubble.css`、`companion-root.css`、`companion-proposal-choice.css`、`learning-run-surface.tsx`、`objective-flow.css`、doc 33）。但我要动的四个文件都是冷的（`settings-surface.tsx` 00:33、`companion-voice-playback.ts` 07:03、`main/index.ts` 昨 23:14、`preload/index.ts` 00:26、`companion-center-surface.tsx` 昨 23:00），所以照做，热的那几个一个不碰。

### 一条我自己登记错的（先改口径）

§11 写着「要不要能删对话记录（**全仓无任何删除入口**）」——**这条是错的**。它早就存在，而且是两步确认的：`companion-center-surface.tsx:1139` 的 `DangerAction title="清空连续对话记录" detail="删除对话和动态收件记录；记忆、人格、旅程与操作记录保留。"` → `history.clear` → 回执「连续对话与动态收件记录已清除。」。
错因就是我记过的那一条判据的反面：**我 grep 的是 `deleteConversation|清空对话|删除记录`，而界面上的字面是「清空连续对话记录」、通道名是 `history.clear`** —— 词没对上就宣布"没有"。这条不是产品决定，是我漏看。§11 已改。

### F9 试听停不下来（`settings-surface.tsx`）

卸载那个 effect 以前只 `removeEventListener`，从不 `pause()`，于是切走这一屏录音还在放，而读数、进度条、「暂停试听」那颗全跟着界面一起没了。改成先 `pause()`、摘监听、再 `removeAttribute("src") + load()`（下次进这一屏不会先播上一个音色）。
**用例先红后绿**：新用例断"卸载后仍在放"这一件事，改之前 `× 试听：离开这一屏要停下来`，改之后 `settings-surface.test.tsx` **43/43 绿**。

### E6 朗读降级要说话（`companion-voice-playback.ts` + HUD）

真因不是"没有原因"，是**原因一直有、没人念**：三条降级 emit 全在填 `progress.failure`，其中 text_only 那支写的就是人话「语音合成超时，已继续显示文字」，而渲染层两个订阅者（呼吸角标、显现驱动器）都不读它，一律 `noteAudioStopped()` 咽掉。
所以修法是**给那条已有的人话接一个读者**，不是再写一套文案：`setSpeechNotice(progress.failure ?? null)`，显示在正文下面那行（与 E5 同一槽位，`voiceNotice` 在前）。这里刻意不留自造兜底 —— 宁可少一句，也不要第二套"为什么没念"。
不变量落在测试的 `collect()` 里：**任何 `text_only`/`failed` 事件都必须带一句人话，且不含 6 个以上连续拉丁字母**（挡英文机器串）。
**变异验证**（两次，第一次不算）：① 第一版我在订阅回调里直接 `expect(...)`，throw 把播放循环打断，红是红了、报出来的却是另一条下游断言 —— 改成记账 + `afterEach` 统一红。② 把降级文案换成 `"tts synthesis deadline exceeded"` → **恰好 5 条红，报的是「降级没带人话：text_only → tts synthesis deadline exceeded」**；第 6 条（"不是一条地址"那种）走的是解析失败，不归这条守。还原后 30/30 绿。

### 语音侧"死导出"这条：核完是**我判错方向**

`CompanionSpeechHandle.segments` 我按"只有测试读"要删，typecheck 立刻报 `companion-voice-playback.test.ts(174)` 在用 `.segments.map(segment => segment.endIndex)` —— 那是真在验切段行为。`mode`、`segmentCount` 同样有测试读者。`CompanionVadInput` 那三个"运行时从不传"的覆盖参数是 VAD 用例的注入缝（`companion-voice-vad.test.ts:82` 靠它把 90 秒的时序压成毫秒）。
**结论：这一项没有可删的东西**，唯一的 write-only 字段 `failure` 的正确处置是 §上面那样给它接上读者。按 §18 写下的判据（"没人用" ≠ "只有测试用"）逐条走了一遍，没有为了凑删除数而削测试。

### F7 她给的链接要点得开（四处一起动，用户已点头）

新通道 `ailearn.v1.shell.openExternal`：合同（`desktop-ipc-contracts.ts` 加通道 + `isWebLinkUrl` + 两个 schema）→ 主进程（`installHandler`，**唯一的信任边界**）→ preload（`shell.openExternal`）→ 渲染层（`.companion-md__link` 从 `<span>` 换成 `<button>`）。
两条设计决定：
- **白名单只有一份实现**，放在合同里。渲染层用它决定"画不画成能点的"，主进程用它决定"放不放行"。以前渲染层自己抄了一份 `https?:` 正则，于是"画得出来、点不动"。
- 仍然**不画 `<a>`**：应用内永不导航（`will-navigate` 照旧拦外链），要点开是操作系统的活，那是一颗按钮的语义。去处（URL 本身）继续写在下面一行。
- 渲染层刻意**不走 `unwrapGatewayResult`**：它对任何错误码都会 `publishGateInvalidation`，一条链接打不开不该把整个应用弹回门禁。
**测试**：主进程 8/8（1 条放行 + 6 条拒绝 + 原有），拒绝那组断两件事——返回 `forbidden` **且一次都没碰 `shell.openExternal`**；**变异**：把 `isWebLinkUrl` 放宽成"只要有协议" → 5 条拒绝红、报的正是这一条。markdown 13/13（新增一条：`tag=BUTTON`、点出去的是原样地址 `https://example.com/a?x=1&y=2`）。
**实机（真窗口，一次真发送）**：抽屉里那颗实测 `tag=BUTTON`、**92×41**、`cursor:pointer`、文案「示例站点 https://example.com」；点下去之后 `location.href` 一字未动（`ailearn-app://bundle/index.html`）—— 应用内没有导航。**没验到的**：操作系统有没有真把浏览器提到前面（这条只能靠人眼看，主进程侧由那条单测钉住）。

### E7 失焦不等于离场（用户确认推翻旧裁决）

根是一行：`src/shared/window-state.ts:17` 的 `visible && focused ? 'visible' : 'hidden'`。它有三层重复实现，全改了：
1. 主进程 `resolveWindowState` —— `focused` 这个输入**整个删掉**（留着它，下一个读代码的人还会以为焦点是判据）；`index.ts` 的 `focus`/`blur` 订阅随之变成空转，一起删。
2. `WindowLive2D.tsx:154,180` 又叠了一层 `!document.hasFocus()`（冻帧的第二把锁）。
3. `App.tsx:174` 渲染层自己把失焦写成 hidden —— 于是主进程那条真实状态白推了。
现在判据只剩"看不看得见"：最小化、隐藏、被完全遮挡（Chromium 会把 occluded 报成 `document.hidden`）。
`window-state.test.ts` 里原有一条 **"pauses room activity when a visible window loses focus"** —— 它把缺陷本身当正确行为钉着，已按新口径重写（三条：失焦仍可见 / 看不见才 hidden / minimized 最强）。
**没实机验**：并排窗口下她是否真的一直在动 —— 程序化让 Electron 窗口失焦/最小化这条路本来就走不通（记在 `reference-desktop-multi-account-acceptance`），而单测钉的是判据本身。

### 能改她的名字（用户点头，落在伴星中心）

写路径**本来就通**：`companionPersonaPatchV1Schema` 一直收 `name`（`PATCH /companion/pet-profile`），缺的只是没人能填。三处：
1. `companionPersonaPatchFromProfile` 的 `change` 加 `name?`（原来硬编 `name: profile.name`）。
2. 中心人格页顶部加一节「她叫什么」——`CompanionNameRow`（草稿本地存、`null` 表示"跟着档案"，所以服务端回什么显示什么；Enter 与「改名」两条路，脏了才可点）。容器与按钮行复用现成的 `.companion-inline-form` / `.companion-action-row`，**没有为一行输入新开一档样式，也就没碰热着的 `hud-surface.css`**。
3. 传播：`companion-display-name.ts` 加一条极小的订阅/广播。中心写入成功后直接播新名字（写入响应本来就带着那一版档案），读侧不再拉一遍 —— 两处各自拉就会出现"中心已改、气泡还叫旧名字"。
顺带把 §17 欠的移交项收了：中心 `:717` 那条自己抄的 `profile?.name ?? activePreset?.name ?? "伴星"` 换成调用 `companionDisplayName`，现在全站只有一份实现。
**实机（真窗口，改完已改回）**：`爱吃白饭的大肥鱼 → 测试改名甲`，回执「设置已保存。」，输入框回填新值；回到桌面后伴星那个 landmark 的 aria-label 变成「**测试改名甲** 身边的交互」，抽屉里三条消息头署名全是新名字，**没有重新拉人格**（这就是那条广播的作用）。随后原样改回。

### 闸门与现场归属

桌面 `npm run typecheck` 我这边 0 错；`src/shared` + `companion` + `app` + `src/main` **73 文件 / 619 测试全绿**（含并行会话新写的 `desktop-ipc-channel-coverage.test.ts` —— 它证明我这条新通道每层都注册齐了）。
**不是我的红**：全库跑另有 6–17 条红，全部落在 `WorkspaceLibrarySurface.*`、`learning-run-surface.*`、`objective-flow-css-guard`、`CardGenerationSurface.review.test.tsx` —— 这些文件在我跑测试的**同一分钟内**被并行会话写过（`learning-run-surface.tsx` 09:15:09、`objective-flow.css` 09:10:32），且其中三个文件单独重跑是绿的。
**这一轮唯一一次真 LLM 调用没走完**：回复超时，界面给的是「消息已经送达，但这次回复等待超时。」。查因：机器上**没有任何 ai-worker 进程**，而 `workers/ai-worker/src/handlers/companion-dialogue.ts` 等四个文件正被并行会话改着。我不去重启他们的 worker，所以 E6 那句降级人话、以及"浏览器被提到前台"这两条只有真链路能验的，仍然没验到。

## 23. 2026-09-23 实机回归：Personal Beta 的伴星外围

用隔离的桌面配置登录后，按真实点击路径复测了消息气泡、来源正文划选、对话记录搜索与日期跳转、更多菜单和快捷设置。历史搜索命中与月历跳转原来都回到最新消息：修正了跳转请求提前清除、列表自动贴底与缺少日期锚点三处，实机分别落到目标消息和目标日期。快捷设置底部静默时段可滚动到达；「朗读与音色」能进入设置中心的对应页。

来源正文划选可通过右键「丢给伴星」进入引用框，输入空白时发送不可用，引用可以移除。输入框原先借用页面的 `starter` 文案，在来源页会说「开始写笔记」，现改成聊天提示；有引用时单独提示围绕选区提问。用户在这一轮真实问「这段话在说什么」时，模型虽拿到选区却说没有附原文；把选区数据与问题放在同一个 user 回合后，实机能回答选区。再给「一句话」要求明确篇幅，并阻止无请求时顺手查询学习进度；最终实机只返回一句话。

首轮真实发送曾超时，worker 报 `column c.purpose does not exist`。`purpose` 实际属于当前任务变体，正式作答信号改为联查 `learning_task_variants`；随后真实回复成功。worker 的 `formal-answer-signal` 用例 7/7、对话用例 59/59、类型检查通过；桌面类型检查和构建通过。测试时产生的几条问答留在 Personal Beta 的对话记录中，未清空用户原有历史。worker 仍报 AI 审计日志写入失败；本次回复链路不受影响，该日志问题需按审计存储链另查。
