# D4 · 隔离展示面合同（AI 动态讲解：整份 HTML + 脚本 + CSS + SVG）

> 日期：2026-09-24（**第二轮修订**，同日）
>
> 状态：**W0-4 交付的设计件（39d §5）。本文件不写产品代码、不改数据库。**
>
> 依据：39 §6.1–6.3、§15.3-6/-12、§17；39d §5；坐标与读数实测于提交 `e7cea900` + 干净树。
>
> 谁在用它：W4-1（隔离显示面实现＋探针）、W4-6、W5-x。**W4-1 不得自行改变本文件的威胁模型、CSP 形状、沙箱属性或红线**；不够用时回来改本文件。

---

## 0. 本轮修订为什么发生（决策记录）

第一稿把方案定成"允许集合解析重建"（把产物裁成受限 AST 再重建为 React 元素），理由是它**不放宽任何既有防线**。**用户 2026-09-24 否决了这个取向**，原话："需要整html的，因为这样才能实现的效果更好"；并在两个岔路口上选定：

| 岔路口 | 用户决定 |
| --- | --- |
| 产物里的脚本 | **连脚本一起放行**（真脚本沙箱） |
| 独立文档的位置 | **页面内嵌 iframe** |

并且明确："目前市面上很多开源的沙箱都很好用，也没必要自己手搓一个"。

### 0.1 与 39 §6.3 的冲突登记（以本文件为准，回来同步源文档）

39 §6.3 字面写的是 **"内容经允许列表解析重建"**。本文件**取代它在表达力上的那一半**：不再对元素／属性／CSS 做允许集合裁剪。它列出的**全部安全目标一条不减**，改由另一组机制承担：

| §6.3 的要求 | 第一稿（裁剪） | **本稿（隔离，用户选定）** |
| --- | --- | --- |
| 禁止任意脚本 | 靠"从不插入 HTML"，脚本无从表达 | **由平台承担**：不透明 origin + 无 `allow-same-origin` + 子文档自有 CSP |
| 禁止事件处理器 | 属性不在允许集合 | 允许（`on*` 是脚本的一部分；隔离在 origin 上做） |
| 禁止外部资源 | 属性不在允许集合 | 主进程请求闸（已有）+ 子文档 CSP `connect-src 'none'`／`img-src data:` |
| 禁止导航 | 无 `a`／`form`／`iframe` 元素 | `sandbox` 不给 `allow-top-navigation`／`allow-popups`／`allow-forms` |
| 禁止表单 | 元素不在允许集合 | 同上（`allow-forms` 不给） |
| 禁止存储 | 结构性不存在 | **不透明 origin ⇒ 存储 API 直接抛错** |
| 禁止 IPC | 结构性不存在 | preload 逐帧注入的洞已堵（§4.1）＋ 不透明 origin 拿不到父窗口 |
| 限额 | 元素数／深度／字节 | 换真脚本后**必须新增时钟中断与崩溃恢复**（§6） |

**这一条改动的代价必须写在明处**：表达力换来的是一块**真正会执行代码**的面。第一稿里"漏了也只是显示错"，现在"漏了就是代码执行"。所以 §7 的探针与 §8 的风险登记是本文件里分量最重的两节。

---

## 1. 现状（实测）

| 事实 | 坐标 | 读数 |
| --- | --- | --- |
| 应用协议已注册为 `standard` + `secure` | `src/main/index.ts:53-64` | `APP_SCHEME = 'ailearn-app'`、`APP_HOST = 'bundle'`；带 `supportFetchAPI`、`codeCache`、`stream` |
| 协议处理器**按 hostname 白名单**分流 | `src/main/index.ts:113-133` | 非 `bundle` 的 hostname 一律 `403` ⇒ 新增 `artifact` host 是**加一个分支**，不是新协议 |
| 主渲染进程已硬化 | `src/main/index.ts:416-426` | `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`、`webviewTag: false`、`navigateOnDragDrop: false`、`safeDialogs: true` |
| 主 CSP | `src/main/index.ts:218-246` | `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`；`style-src 'self' 'unsafe-inline'`；`img-src 'self' data: blob:`；**`frame-src 'none'`**；`object-src 'none'`；`base-uri 'none'`；`form-action 'self'` |
| 请求闸 | `src/main/index.ts:271-277` | `onBeforeRequest` 取消一切非 app scheme／dev origin／`blob:`／`data:` 的请求 |
| CSP 注入位置 | `src/main/index.ts:279-294` | 只覆盖 `mainFrame`／`subFrame`，且 subFrame 用**同一份**策略 |
| 导航闸 | `src/main/index.ts:318-332` | `setWindowOpenHandler` → deny；`will-navigate`／`will-redirect`（主 frame 事件）；`will-attach-webview` → preventDefault |
| 渲染进程今天没有 HTML 注入点 | 见守卫 | 产品源码 `dangerouslySetInnerHTML`／`.innerHTML=`／`insertAdjacentHTML`／`document.write` **0 命中**；`DOMParser` **0 命中** |
| **preload 会注入每一个子 frame** | Electron 官方文档（`nodeIntegrationInSubFrames`）："All your preloads will load for every iframe" | 原先 `src/preload/index.ts` 无条件 `exposeInMainWorld`，**子 frame 会拿到两条 IPC 桥** |

---

## 2. 威胁模型

**资产**：主渲染进程（preload 桥、一批 IPC 通道、用户全部可见数据）、主进程（`protocol.handle`、DB 访问面、文件系统）。

**对手**：被污染的材料与被模型转述出来的内容。**源材料里的指令视作材料，不成为生成器或播放器的执行授权**（39 §6.3 原话）。

| # | 类别 | 具体形状 | 本稿的挡法 |
| --- | --- | --- | --- |
| T1 | 脚本逃逸到主页面 | 从产物 frame 里读 `window.parent.document`、改父 DOM、调父全局 | 不透明 origin（`sandbox="allow-scripts"` 且**无** `allow-same-origin`）⇒ 跨源访问抛错 |
| T2 | IPC 桥触达 | 产物 frame 里出现 `window.ailearnDesktop` | preload 的 `isMainFrame` 守卫（§4.1，**已修**）；且不透明 origin 下 `top`／`parent` 的桥也拿不到 |
| T3 | 外部资源与请求 | `fetch('https://…')`、`<img src>`、CSS `url()`、`WebSocket` | 主进程请求闸（已有，进程级）＋ 子文档 CSP 收紧；**探针必须证明它真的拦到了** |
| T4 | 导航 | `top.location=…`、`window.open`、`<form>` 提交 | `sandbox` 不给 `allow-top-navigation`／`allow-popups`／`allow-forms`；主进程补子 frame 导航拒绝（§4.4） |
| T5 | 存储 | `localStorage`／`cookie`／`IndexedDB` | **不透明 origin ⇒ 直接抛错**（不是"我们禁了"，是"没有这个 origin 的存储"） |
| T6 | 资源耗尽 | 死循环、无限动画、内存爆炸、节点爆炸 | watchdog 时钟中断 + 崩溃恢复 + 配额（§6）。**这是本稿唯一必须自己做的部分** |
| T7 | 视觉欺诈 | 把示意图说成"实测执行计划" | 产物合同（§5.3），不靠隔离 |
| T8 | 覆盖／劫持主界面 | `position: fixed` 覆盖层 | 产物在自己的 frame 里，**结构上出不来**；父容器给固定尺寸与 `contain` |

**明确不在威胁模型内**（写出来是为了不让探针越扩越宽）：操作系统／内核／显卡驱动层攻击；**Chromium 0-day**（见 §8 第 1 行）；主进程或主渲染进程已被入侵的情形；用户自己在 devtools 里粘脚本；恶意**用户本人**（本产品的前提是单用户本机）。

---

## 3. 架构：第二个 origin + 不透明沙箱 frame

```
主渲染进程 ailearn-app://bundle（主 CSP 只多一条 frame-src）
   └─ <iframe sandbox="allow-scripts" src="ailearn-app://artifact/<artifactId>">
        不透明 origin · 无 storage · 无 preload 桥 · 自有 CSP
        内容 = 我们的模板（播放器/配额/watchdog）+ AI 产物（HTML/CSS/JS/SVG）
```

### 3.1 为什么是"第二个 host"而不是新协议

`ailearn-app` 已注册为 `standard` + `secure`（`index.ts:53-64`），所以 `ailearn-app://artifact` 是一个**正常 origin**，且与 `ailearn-app://bundle` **不同源**（origin = scheme + host + port）。而 `protocol.handle` 已经在按 hostname 分流（`index.ts:126-133`），加一个 `artifact` 分支即可。

**收益**：DOM 互不可达（同源策略）、存储天然分离、不需要新协议、不需要 `partition`。

### 3.2 为什么还要叠 `sandbox`（而不是只靠不同源）

只靠不同源，产物仍有：自己的 `localStorage`（会长期堆积）、自己导航自己的能力、弹窗能力。加 `sandbox="allow-scripts"` 之后 origin 变成**不透明**，上面三样全部消失——这正是"禁止存储"最干净的实现（不是禁用 API，是那个 origin 没有存储）。

**硬约束**：`sandbox` **绝不允许**同时出现 `allow-scripts` 与 `allow-same-origin`——那个组合下 frame 可以自己摘掉沙箱属性（浏览器厂商与 MDN 都把它列为禁止组合）。

给出的能力只有 `allow-scripts` 一项。**不给**：`allow-same-origin`、`allow-forms`、`allow-popups`、`allow-modals`、`allow-top-navigation*`、`allow-downloads`、`allow-presentation`、`allow-pointer-lock`。

### 3.3 子文档 CSP（`onHeadersReceived` 按 hostname 分支注入）

不透明 origin 下 `'self'` 不可用，所以脚本只能内联——这是本方案的**必然代价**，写清楚不藏：

```
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
font-src data:;
media-src data: blob:;
connect-src 'none';
worker-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

**刻意不给 `'unsafe-eval'`**：首期不承诺 wasm；若将来某类动态讲解需要，那是一次带读数的独立决定（改这一行要在实施日志里给出理由）。

### 3.4 主渲染进程 CSP 的唯一改动

```
- "frame-src 'none'"
+ "frame-src ailearn-app://artifact"
```

**这是本方案对既有防线的全部改动，只有这一条。** 它加的是"主页面可以嵌入我们自己的一个受限 origin"，不改主渲染进程自身的任何能力（`script-src`／`img-src`／`connect-src`／`object-src` 全不动）。

`onHeadersReceived` 的 subFrame 分支随之改成三路：`bundle` → 主策略；`artifact` → §3.3 的子策略；**其他一律拒绝**（现在只会套用主策略，那对产物 frame 太宽）。

---

## 4. 必须一并落地的四件护栏

### 4.1 preload 只在主 frame 暴露桥（**已修**，2026-09-24）

- 事实：Electron 的 preload 注入**每一个** iframe（官方文档原文："All your preloads will load for every iframe"）；而 `src/preload/index.ts` 的 `exposeInMainWorld` 原先是无条件的 ⇒ 产物 frame 一落地就会拿到 `ailearnDesktop`／`ailearn` 两条桥。
- 改法：最后一次暴露前加 `if (!process.isMainFrame) return`（等价形式），主 frame 行为零变化。
- 已钉住：`apps/desktop-client/src/main/renderer-html-sink-guard.test.ts` 新增第 3、4 条用例，判据是"每一条 `exposeInMainWorld` 必须落在 `process.isMainFrame` 的真分支里"，用**大括号配平**扫源码（不是"文件里有没有出现 `isMainFrame`"——那会在守卫只包住一条 expose 时喂假绿）。已自证会红（临时撤掉守卫 → 两条违例；还原即绿）。

### 4.2 请求闸保持不变，但必须**证明它拦到了**

`onBeforeRequest` 已经取消一切非 app scheme／dev origin／`blob:`／`data:` 的请求（`index.ts:271-277`），这是**进程级**的一道，比子文档 CSP 更靠底层。本方案不动它。

**但"没动"不等于"有效"**：探针必须跑**阳性对照**——在产物里放一个外链 `<img>` 与一次 `fetch('https://example.com')`，确认主进程的 cancel 计数**动了**；动了之后，再跑正式产物确认不动。本仓库反复吃过的假绿形状就是"计数器不动，被读成零违规"。

### 4.3 控制通道只走 `postMessage`

- 父 → 子：`frame.contentWindow.postMessage(msg, '*')`（不透明 origin 只有 `'*'` 可用）。
- 子 → 父：`parent.postMessage(msg, '*')`。
- **父侧必须校验 `event.source === frame.contentWindow`**，并按消息类型白名单处理；不实现任何"按消息内容执行动作"的通用通道（那等于把桥从后门开回来）。
- 子侧不暴露任何能触达父的能力；父子之间不共享任何对象引用。

### 4.4 子 frame 的导航要被拒

现状的 `will-navigate`／`will-redirect` 挂在 webContents 上、面向主 frame（`index.ts:321-327`）。子 frame 的导航需要 `will-frame-navigate`（或按当时 Electron 版本的等价事件）单独拒绝。

**这一条必须在实施时核实事件名与覆盖范围，并以探针证明**（探针：在产物里 `location.href='ailearn-app://bundle/index.html'`，断言 frame 没有跳走、且主页面未受影响）。写在这里是提醒它**不是自动成立的**。

---

## 5. 产物合同（与隔离正交，仍然生效）

### 5.1 单步／暂停／重播／减少动效

- 播放器由**模板**（我们写的）提供，AI 产物通过约定接口登记自己的步骤（如 `window.__artifact = { steps: [...], render(step) }`，具体形状 W4-1 定）。
- 减少动效／动效 Off：模板切到**静态分镜**（每一步都可见、可读），**不重生成、不丢步骤、不丢判断依据**（39 §6.3）。这条是可访问性门槛。

### 5.2 读数不许由模型逐次生成（39 §6.1，原样继承）

产物里出现的数字只能是 ① 服务端在生成时给定的值 ② 播放器算出的值 ③ 用户可改参数的当前值。第 ③ 种靠**参数表 + 播放器求值**，不是让模型在多帧里各写一串数字。

### 5.3 不许把示意说成实测（39 §6.1 末句）

产物文本与容器题注都不得出现"实测／真实执行计划／这是该数据库的结果"这类声称。验收走人工样本 + 语料两条（39 §14.2：模型不能作为自己质量的唯一验收证据）。

### 5.4 产物绑定与回放

产物绑定本轮快照与实际使用版本；恢复与历史回放读同一份产物、**不重新生成**（39 §4.3、§16.14）；换解释才产生新版本。

---

## 6. 配额与恢复：本方案唯一必须自己做的部分

真脚本进来之后，"限制"不能再靠内容裁剪，必须靠**运行时**：

| 项 | 手段 | 触顶行为 |
| --- | --- | --- |
| 死循环／长任务 | 模板内 watchdog + 主进程计时：产物声明 `ready`／`step` 心跳，超时未到即中止 | 中止 → 退回静态分镜，如实说明"这份动态内容没能跑起来" |
| 单份产物时钟预算 | 例如 20 秒 CPU 墙（**起点值，W4-1 核定**） | 同上 |
| 崩溃 | `webContents` 的 `render-process-gone`／frame 崩溃事件 | 重建 frame；连续两次即降级为静态分镜，不再自动重试 |
| 字节／节点数 | 服务端生成时与主进程组装时**双重**校验 | 整份拒绝，不做"截断后半篇" |
| 内存 | Chromium 无 per-frame 内存上限可直接设 | 降级靠"时钟 + 崩溃"两条兜；**如实登记为做不到的事**（§8 第 3 行） |

**注意**：产物 frame 与主页面**同渲染进程**（本文选定内嵌 iframe），所以 frame 的崩溃与卡顿会波及主页面。这是这条路的已知代价，见 §8 第 2 行与升级路径。

---

## 7. 探针与验收

### 7.1 第一层：静态守卫（**已落地**）

`apps/desktop-client/src/main/renderer-html-sink-guard.test.ts`，4 条用例：

1. 产品源码不存在 HTML 注入点（白名单目前为空；W4-1 落地时**只登记模板文件**）。
2. 检测形状的正／负对照（注释里的同名文字不许报）。
3. **每一条 `exposeInMainWorld` 都在 `process.isMainFrame` 真分支里**（§4.1）。
4. 守卫判据的正／负对照（守卫外的一条必须报、被守卫包住但写在块外也要报、守卫内的不许报）。

**会红已自证**：临时放含 `dangerouslySetInnerHTML` 的文件 → 用例 1 红并报 `file: label`；临时撤掉 preload 守卫 → 用例 3 红并报两条违例；两次都已还原复绿。

### 7.2 第二层：frame 内越权语料（W4-1 落地时）

**在产物 frame 内**执行（不是静态断言），每条配一条**负对照**（合法产物必须原样跑通）：

| 类 | 用例 | 期望 |
| --- | --- | --- |
| T1 | `window.parent.document.body.innerHTML` | 抛 `SecurityError` |
| T1 | `top.location.href = 'ailearn-app://bundle/index.html'` | 抛错或被 `sandbox` 拦 |
| T2 | `window.ailearnDesktop`／`window.ailearn` | `undefined` |
| T2 | `window.parent.postMessage({type:'__run'}, '*')`（伪造父指令） | 父侧忽略（source 校验失败） |
| T3 | `fetch('https://example.com')`／`new Image().src='https://example.com/x'` | 请求被主进程 cancel；**阳性对照先证明计数会动** |
| T3 | `new WebSocket('wss://example.com')` | 被拒 |
| T4 | `<form action="https://x"><input></form>.submit()` | 被 `sandbox` 拦 |
| T4 | `window.open('https://example.com')` | 被拦 |
| T5 | `localStorage.setItem('a','1')`／`indexedDB.open('x')`／`document.cookie='a=1'` | 抛错（不透明 origin） |
| T6 | `while(true){}` 的产物 | watchdog 中止 → 降级静态分镜，且**主页面不卡死** |
| T6 | 崩溃注入（`chrome://crash` 类构造） | frame 重建；两次后降级 |
| T7 | 产物自称"这是 PostgreSQL 的实测执行计划" | 人工样本验收（走 39 §14.2） |
| T8 | 产物内 `position: fixed; inset: 0` 的覆盖层 | 只在自己的 frame 内有效，主页面不受影响 |

### 7.3 第三层：真窗口（39d §3 第 8 条：UI 只在真窗口算验过）

- 真点开一个动态讲解（含脚本交互），走完 步进／暂停／重播／减少动效；
- 读三个计数：CSP 违规、主进程请求 cancel、frame 崩溃次数 = 0 增量（并先跑阳性对照）；
- 读产物 frame 内的 `window.ailearnDesktop === undefined`；
- **关掉动效后静态分镜步骤数 == 动效版步骤数**；
- 读不到就记读不到（39d §3 第 8 条）。

### 7.4 探针不过怎么办（升级路径；39 §17："探针不过就先改隔离方案"）

按**收紧**方向退：

1. **越权语料在某类构造上反复漏** → 把产物文档从"模板 + 产物同文档"改成**模板在外层 frame、产物在内层再嵌一层 frame**：内层用 `srcdoc`＋不透明沙箱只承载内容，外层持有播放器与配额。父子三层的 `postMessage` 都不共享对象。**多一层，不是放宽**。
2. **死循环／崩溃影响到主页面** → 换 `WebContentsView`（独立渲染进程）：进程级隔离成立，代价是它不在正文流里、滚动与排版要自己做（用户已知这条的代价，见 §0 的决定表）。
3. **`frame-src` 那条改动在评审里被否** → 退回第一稿的允许集合解析重建（本文件上一版仍在 git 历史里），表达力按裁剪版给。

**红线（任何一级都不许碰）**：不许给 `sandbox` 加 `allow-same-origin`；不许给子文档 CSP 加外部源（`http(s):`／通配符）；不许新增第三个 origin 以外的网络面；不许为了"效果更好"去掉请求闸或导航闸。

---

## 8. 已知风险与登记（诚实清单）

| # | 风险 | 现状处置 | 触发升级的信号 |
| --- | --- | --- | --- |
| 1 | **同渲染进程**：产物 frame 与主页面在一个进程里，Chromium 级漏洞可跨 frame | 内容级隔离（不透明 origin）成立，进程级不成立 | 出现一次跨 frame 逃逸或主页面受损 → §7.4 第 2 级 |
| 2 | **产物 frame 崩溃／卡顿波及主页面** | watchdog + `render-process-gone`；两次后降级 | 同上 |
| 3 | **内存无上限可设**（Chromium 无 per-frame 配额 API） | 靠时钟与崩溃两条兜；**如实承认做不到** | 出现内存导致的整体不可用 |
| 4 | 子文档 `script-src 'unsafe-inline'` 是不透明 origin 下的必然 | 记录在案；隔离靠 origin 不靠脚本策略 | — |
| 5 | 主 CSP `script-src` 含 `'unsafe-eval'`（`index.ts:230`） | 与产物无关（产物在另一个 frame）；但它意味着"主页面里漏一段脚本，CSP 挡不住" | 主渲染进程出现注入点（静态守卫会红） |
| 6 | 真脚本 ⇒ 产物可能很慢 | 首屏不阻塞：产物加载与主界面分离 | 首个可用产物的 p50/p95 超预算（39 §18.4） |

---

## 9. 未决项与落点

| 未决项 | 为什么本文件不定 | 落点 |
| --- | --- | --- |
| 模板与产物的接口形状（`window.__artifact` 怎么声明步骤） | 需要真实产物驱动 | W4-1 |
| watchdog 时钟预算、字节／节点上限的数值 | 需要真实产物分布 | W4-1 核定 → 39 §18.4 试用前冻结 |
| 是否允许 wasm（子文档是否开 `'unsafe-eval'`） | 首期不承诺 | 需要时单独决定 |
| 子 frame 导航拒绝的事件名与覆盖范围 | 随 Electron 版本变化，必须实测 | W4-1（探针见 §4.4） |
| 是否引入现成的产物框架（如 Sandpack 一类） | 见 §10 | W4-1 评估，默认不引 |

---

## 10. 关于"用现成的开源沙箱"（对 §0 那条指示的如实回应）

用户的方向是"不必自己手搓一个"。这条我同意一半，必须说清另一半：

- **"把 AI 产物渲染出来"这个需求的沙箱，业界做法就是平台原语**（`sandbox` iframe + 跨或不透明 origin + 自有 CSP + 请求闸），不是某个库。39b/39c 引用的同类产品（LibreChat Artifacts 一类）用的也是这个形状。**本方案没有手搓沙箱**——沙箱是 Chromium 给的，我们写的只是集成（模板、配额、控制通道）。
- **确实存在的"开源沙箱"分两类，都不落在本需求上**：
  - **代码执行沙箱**（E2B／Modal／Firecracker／microVM／`isolated-vm`／QuickJS）：它们运行*代码*，不渲染 DOM。要用它们就得自己实现 DOM/CSS 渲染——与"效果更好"背道而驰；而且多数是云端服务，本产品的请求闸本来就禁止外连。
  - **代码游乐场框架**（Sandpack 一类）：确实开箱，但它自带打包器与一整套 UI/运行时，允许的 API 面比我们要的大得多，且它是为"编辑源码"设计的，不是为"渲染一份产物"。
- **结论**：默认不引第三方沙箱框架；若 W4-1 评估后发现 Sandpack 一类的收益大于其体量与 API 面，回来改本节。**不引的理由要写进实施日志**，不是默认沉默。

---

## 11. 交付边界

本文件**授权**（相对第一稿新增）的唯一主进程改动是 §3.4 的 `frame-src` 与 §3.3 的 subFrame CSP 分支，以及 §4.4 的子 frame 导航拒绝。

本文件**仍然不授权**修改：`webPreferences` 的任何一项、请求闸（`onBeforeRequest`）、主 CSP 的其余指令、`hardenWebContents` 的其他部分、preload 的桥形状（除已修的 §4.1 守卫）、`package.json` 里的 Electron 版本。

W4-1 若发现必须改其中任何一项，回来改本文件并**单独列出改动与理由**。

---

## 附：本文件用到的实测读数（可复算）

```
# 1) HTML 注入点普查（产品源码，排除 public/ 与测试）
grep -rn "dangerouslySetInnerHTML\|insertAdjacentHTML\|document\.write\|\.innerHTML" \
  apps/desktop-client/src --exclude-dir=public | grep -v "\.test\."
  → 唯一命中：renderer/src/components/companion/companion-markdown.tsx:21（注释文字）
grep -rn "DOMParser" apps/desktop-client/src --exclude-dir=public → 0 命中

# 2) preload 子 frame 暴露（修前）
grep -n "isMainFrame" apps/desktop-client/src/preload/index.ts → 0 命中（即无守卫）
Electron 文档（WebPreferences · nodeIntegrationInSubFrames）："All your preloads will load for every iframe."

# 3) 守卫
npx vitest run src/main/renderer-html-sink-guard.test.ts
  → 修前 2 passed；加 preload 用例后 4 passed
  → 撤掉 preload 守卫 → 用例 3 红（两条"未受 process.isMainFrame 守卫"）；还原即绿
  → 临时放含 dangerouslySetInnerHTML 的文件 → 用例 1 红（报 file: label）；删除即绿
```
