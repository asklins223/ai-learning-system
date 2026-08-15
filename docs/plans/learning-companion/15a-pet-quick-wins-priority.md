# 桌宠体验前置快赢项（15a）

> 状态：**方案整理完成，待实施**
> 定位：15-companion-chat-emotion-migration.md 的**前置文档**——只收"简单、高优先级"的体验修复；情绪驱动表现（问题 7）与 TTS 时序改造（问题 2）属于后续 15 大文档，不在本文档实施。
> 依据：2026-08-12 桌宠体验反馈 10 条 + 代码走查定位（未改任何代码，均为只读核对）

---

## 1. 背景与范围划分

用户 10 条反馈中，本文档只实施"改动小、收益直接、风险低"的五项（A–E）；其余按依赖与复杂度归入后续 15 大文档/另议。

| # | 用户反馈 | 归类 | 去向 |
| --- | --- | --- | --- |
| 3 | 播完音频状态仍卡"正在说话中"，且提示可打断实际打不断 | ✅ **本文档 A**：流式 TTS 播放完成回调 + 打断验证 | 前置快赢 |
| 10 | 重开应用"正在验证桌面会话"加载背景难看、太大 | ✅ **本文档 B**：bootstrap 玻璃拟态小卡片 | 前置快赢 |
| 6 | 语音岛离人物太远，应放人物右侧、语音按钮上方 | ✅ **本文档 C**：语音岛定位到按钮上方 | 前置快赢 |
| 9 | 关闭"和伴星聊聊"输入面板后 live2d 闪一下（消失又出现） | ✅ **本文档 D**：窗口级副作用排查（与 2026-08-12 已修闪烁同源） | 前置快赢 |
| 4 | 学习快捷方式点提交失败 | ✅ **本文档 E**：menu-proposals 链路排查 + 错误码透传 | 前置快赢 |
| 7 | Live2D 形象未绑定对话、动画轮巡与 AI 无关 | 情绪驱动表现（方案 15 收尾） | **15 大文档** |
| 2 | 音频偶发播不出 + 文字全出完才生成音频 | TTS 时机改造（delta 级句子级合成） | **15 大文档**（与 1 同源） |
| 1 | 有转文字中间过程、体验不连贯 | 同上（TTS 时机 + 半双工延迟） | 15 大文档 / 后续 |
| 8 | 桌宠只是被动对话框，缺少系统引导 | 产品方向（proactive 场景扩展） | 另议 |
| 5 | 完整对话 UI 稀烂 | 已重构未上线（2026-08-12），上线后再评 | 另议 |
| 新 | 卡"伴星正在想"无响应、停止按钮无效 | ✅ **本文档 F**：SSE 空闲看门狗 + cancel 超时 + 失败本地终止 | 前置快赢 |

---

## 2. A：流式 TTS 播放完成回调（反馈 3）

### 2.1 现状与根因

- 非流式路径（`fetch /api/voice/tts` + playback pump）**已修**：`PetRuntimeProvider.tsx` 中 `pumpRealPlayback` 在全部段播完/段失败时派发 `voice.playback_finished` → `cooldown` → `idle`（含 2026-08-12 的"卡 speaking"修复）。
- **流式路径（P6，`COMPANION_STREAMING_VOICE_V1_ENABLED=true`）没有完成信号**：
  - `companion-stream-player.ts` 的 `StreamPlaybackController` 段完成后（`onSegmentDone`）phase 回 `idle`、queue 清空，但**不向外部暴露"队列全部播完"**；
  - `companion-stream-playback-runtime.ts` 的接口只有 `enqueue / bargeIn / clearBarged / dispose`，无完成回调；
  - `PetRuntimeProvider.tsx` 流式分支（`streamingVoiceEnabled` 时 `createStreamPlaybackRuntime` + `enqueue`）从不派发 `voice.playback_finished` → **voice 永久停在 speaking**。
- 打断：入口已接通（reducer `voice.toggle_requested` 在 speaking 时发 `stop_playback` effect → provider `bargeIn()` + `stopRealPlayback`）；"打不断"现象与流式 `bargeIn` 的实际中止效果相关，需在本次一并验证。

### 2.2 改动方案

1. `companion-stream-player.ts`：`StreamPlaybackController` 增加 `onDrained?` 回调——在段完成流程尾部，若 `queue.length === 0 && phase === "idle"` 且非打断所致，触发 `onDrained`；`bargeIn` 清队后**不**触发（barged 是主动中止，不算播完）。
2. `companion-stream-playback-runtime.ts`：`StreamPlaybackRuntimeOptions` 增 `onDrained?`，透传给 controller。
3. `PetRuntimeProvider.tsx` 流式分支：创建 `streamPlayback` 时挂 `onDrained` → 校验 run/generation 后 dispatch `voice.playback_finished`（带最后一段 `runId/generation/segmentId`，与 reducer 校验一致）；bargeIn 触发的 `onDrained` 必须被 controller 层挡掉（见 1）。
4. 打断验证：`stop_playback` 后确认 AudioContext 停止发声、voice 状态复位；若发现 `bargeIn` 后仍有残音/状态残留，一并修（sink.stop 已递增 audioFence + 停 activeSource，重点验证多段排队时的中断）。

### 2.3 验收标准

- [ ] `streamingVoice` 开启时：播完最后一段 → voice 从 `speaking` 自动回 `cooldown` → `idle`（状态不再卡死）；
- [ ] 打断（点语音按钮/`stop_playback`）后：立即停止发声，voice 进入正确状态，**不**误派发 `playback_finished`；
- [ ] 非流式路径回归：现有 pump 兜底行为不变（单测 + 手动验证）；
- [ ] 新增/更新测试：`companion-stream-player.test.ts` 补"队列播完触发 onDrained / bargeIn 不触发"用例。

---

## 3. B：bootstrap 加载视图玻璃拟态化（反馈 10）

### 3.1 现状

- `apps/web/app/(pet)/companion/pet/page.tsx` L171：`bootstrap === "checking"` → `<div className="pet-bootstrap">正在验证桌面会话…</div>`；
- `pet.css` `.pet-bootstrap`：`position: absolute; inset: 0` 全屏 grid 居中，13px 文字——整窗一行字，突兀。

### 3.2 改动方案

- 页面渲染：checking 态改为小卡片结构（约 200–240 × 88–120px），内容 = 加载指示（呼吸点/spinner）+ 主文案"桌宠正在载入中…"；`auth_required / global_off / error` 三态复用同一卡样式（各自文案），视觉统一。
- CSS：`.pet-bootstrap` 不再全屏铺背景，改为居中卡片：半透明背景 + `backdrop-filter: blur` + 1px 渐变描边 + 圆角（与 `.pet-voice-island` 同风格变量）。**注意**：透明窗口的 backdrop-filter 只能模糊窗口内已渲染内容，无法模糊窗口外桌面——"玻璃感"以卡片自身半透明 + 内部渐变/微噪实现，不依赖窗外模糊。
- 动效：尊重 `prefers-reduced-motion`，降级为静态卡片。
- **2026-08-12+ 修正（纸黄色背景）**：bootstrap 阶段没有 `.pet-surface-root`，原 `html:has(.pet-surface-root) body { background: transparent }` 不生效，body 露出全局 `--color-canvas` 纸黄色背景（base.css）→ 透明桌宠窗口里出现"大纸黄色矩形"。补 `html:has(.pet-bootstrap), html:has(.pet-bootstrap) body { background: transparent !important; overflow: hidden }`。

### 3.3 验收标准

- [ ] 重启应用/重开桌宠：看到居中玻璃小卡片（非全屏文字），文案为"桌宠正在载入中…"，**窗口背景完全透明（无纸黄色/任何底色矩形）**；
- [ ] 四种 bootstrap 状态（checking/auth_required/global_off/error）视觉一致、均可读；
- [ ] `prefers-reduced-motion` 下无闪烁动画；
- [ ] 透明窗口下卡片半透明层叠正常，无黑底/锯齿。

---

## 4. C：语音岛移到人物右侧、语音按钮上方（反馈 6）

### 4.1 现状

- 语音按钮 `.pet-voice-control`：`top: 392px`（底部），x = `--pet-voice-x`（角色内侧边缘，bubble-left 靠左）；
- 语音岛 `.pet-voice-island`：`top: 12px`（**窗口顶部**），x = `--pet-voice-island-x`（bubble-left 靠右 490px）——与按钮相距约 380px，且跑在人物头顶，观感断裂。

### 4.2 改动方案（2026-08-12+ 终版：完整版岛放人物头顶）

- 初版：岛放按钮正上方（top 324，178px）——落在角色腰部条带，实测**遮挡人物躯干**（用户反馈），废弃；
- 第二版：岛右对齐按钮列放顶部（top 12，178px）——不挡但**右上角离人物太远**（用户反馈），废弃；
- 紧凑版：缩窄到 100px 放人物右侧空隙（orb 36 + 短状态字）——不挡且贴人物，但**用户认为缩窄后不好看**（反馈），废弃；
- **终版**：**恢复 178px 完整版岛的样式**（orb 44 + 标题 + 操作提示），位置 = **人物头顶上方**（top 84，人物画布 y150 起、岛底 142 距头顶 8px 不遮挡；x = 角色画布水平居中 − 岛宽/2，bubble-left/right 通用）；
- 叠放：z-index 1（与人物无垂直重叠，压画布之下即可）；`pointer-events: none` 不参与命中。

### 4.3 验收标准

- [ ] island（178px 完整版，原样式）出现在人物头顶正上方，**不遮挡人物任何部位**；
- [ ] 完整文案（标题 + 操作提示）恢复显示；
- [ ] 不与气泡/输入框/工具栏/菜单重叠（island y 84–142，bubble y 88+ 同高段 x 不重叠、composer y 292+、toolbar y 282+）；
- [ ] 两个 `side` 方向布局对称正确；
- [ ] 命中几何（`registerHitGeometry`）不受影响（island 为 `pointer-events: none`，仅确认按钮区域正常）。

---

## 5. D：关闭输入面板后 live2d 闪烁（反馈 9）

### 5.1 现状与根因定位

- 用户描述："和伴星聊聊"（= `PetComposer` 输入面板标题，`PetComposer.tsx` L51）关闭后，整个 live2d 消失再出现。
- React 层已排除：`PetCharacterCanvas` 挂载 effect 依赖仅 `live2dEnabled / reducedMotion / animationOff`，composer/bubble 状态不影响 canvas 挂载与销毁。
- **同症状已有先例**：`apps/desktop/src/main.ts` L618-626 记录 2026-08-12 修复——`releaseTextInputFocus` 原调 `showInactive()`，transparent 窗口上对**已显示**窗口调 `showInactive` 会触发 GPU 合成重置，表现为"整个窗口消失再出现"；已改为 `blur()` 并保留注释。
- **主根因（2026-08-12+ 定位）**：`releaseTextInputFocus` 里的 `petWindow.blur()`——macOS 上 pet 窗口失焦后系统把焦点**回落到最近激活的窗口（主应用窗口）**：① 主窗口被前置聚焦（用户反馈"下层应用窗口跑到最上层"）；② 焦点切换本身触发 transparent 窗口合成重排 →"整窗消失再出现"闪烁。两者同源。
- 次要候选（已处理）：`setIgnoreMouseEvents` 关闭瞬间翻转（`setInteractionMode("passive")` 不再强制立即重算，延后到光标移动）；打开路径冗余 `show()`（已去掉）。

### 5.2 改动方案（已实施）

1. `main.ts` `releaseTextInputFocus`：**去掉 `blur()`**——关闭输入面板后 pet 保持焦点（页面无聚焦输入元素，无害；用户点击其他窗口时焦点自然切换），主窗口不再被前置聚焦，焦点切换不再触发合成重排；
2. `pet-hit-test-controller.ts` `setInteractionMode`：仅非 passive 模式强制立即重算；passive 不强制（关闭瞬间不翻转 `setIgnoreMouseEvents`）；
3. `main.ts` `requestTextInputFocus` 去掉对已显示窗口的冗余 `show()`；
4. 单测：`pet-hit-test-controller.test.ts` 新增"passive 不强制翻转、光标移动后自然翻转"用例（35/35 通过）。
5. 退路（若仍复现）：以真机日志（`releaseTextInputFocus` 的 logger）确认剩余窗口级调用，或 renderer 侧 canvas 开关瞬间暂停重绘。

### 5.3 验收标准

- [ ] 桌宠内反复打开→关闭"和伴星聊聊"输入面板，live2d 不再消失再出现；
- [ ] 气泡 dismiss、composer 开关、菜单开关全程无闪；
- [ ] 点击穿透功能不受影响（鼠标移到角色上仍可交互、移出后仍穿透，仅翻转时机延后）；
- [ ] 2026-08-12 的修复不回归（键盘焦点释放仍正常，无额外 showInactive）。

---

## 6. E：学习快捷方式提交失败（反馈 4）

### 6.1 现状与根因定位

- 前端链路：`PetMenu.tsx` `runLearningItem`（L237-289）→ `createLearningMenuProposal`（POST `/api/companion/menu-proposals`）→ catch 全部吞成"提交失败，可重试"（L285）——`LearningActionClientError` 的 `status/code` 未透传展示。
- 服务端（`routes.ts` L76-109 / L242-252）：`/companion/menu-proposals` 与 `/companion/learning-context` **都**门控 `COMPANION_ACTION_BRIDGE_V1_ENABLED === "true"`（未开 → 404 NOT_FOUND）。
- **根因（2026-08-12+ 定位，用户实测"登录状态已过期"）**：`requireSession`（`identity/middleware.ts`）对 **cookie 鉴权的非 GET 请求强制校验 `x-csrf-token`**（`hasValidCookieCsrf`，缺失 → **403 "csrf token required"**）。`learning-actions.ts` 的 `createLearningMenuProposal` / `decideLearningProposal` 两个 POST **都没带 CSRF header** → 一律 403 → E 节错误码透传把它显示成"登录状态已过期，请回到主窗口后重试"（误导文案）。`fetchLearningContext` 是 GET 不受影响，所以菜单能加载、一点提交就失败——与用户现象完全吻合。
- 修复：两处 POST 注入 `x-csrf-token`（`getCsrfToken()`，与 `companion-transcribe-api` 同款）；403 文案改为"登录状态已过期或请求未授权，请重试"（避免误导）。

### 6.2 改动方案

1. `learning-actions.ts`：`createLearningMenuProposal`、`decideLearningProposal` 的 fetch headers 加 `x-csrf-token`（cookie 鉴权非 GET 必需，缺失必 403）；
2. 前端错误码透传：`runLearningItem` catch 按 `LearningActionClientError.status` 分类——401/403 → "登录状态已过期，请回到主窗口重试"；404 → "学习功能未开放"；其他 4xx → "学习状态已变化，请重新打开菜单后重试"；5xx/未知 → 原文案；console 记录 status/code 供定位；
3. 若确认 capability 与端点门控不一致（flag 配置漂移），补一致性校验——当前 `learningActions = dialogueEnabled && actionBridgeEnabled` 与端点门控同 flag，一致。

### 6.3 验收标准

- [ ] 定位到"提交失败"的具体错误码（抓包/日志），确认属于上列哪一类并修复；
- [ ] 前端按错误码分类展示文案，不再无差别"提交失败，可重试"；
- [ ] 正常路径回归：能成功创建 learning proposal 并弹出确认卡（`bubble.learning_proposal_received`）。

---

## 7. F：卡"伴星正在想"无响应 + 停止按钮无效（新反馈）

### 7.1 现状与根因定位

- 症状：桌宠气泡进入"伴星正在想"（thinking）后长时间无响应，点停止按钮停不下来。
- 链路：提交 turn → worker 写 `assistant.status(thinking)` → provider 调用（最长 60s budget，超时 abort → failed）→ final/delta 写库 → SSE 推送。thinking 事件在 provider 调用**前**发出，thinking→final 之间前端只靠 SSE 心跳（api 每 15s comment）感知连接存活。
- 根因（前端缺兜底，服务端挂起/慢时前端永久等待）：
  1. **SSE 无空闲看门狗**：`openCompanionSse` 的 `reader.read()` 无超时——api 挂起/网络半开/TCP 静默断（心跳也停）时前端**永远等**，"伴星正在想"永不恢复；
  2. **cancel 请求无超时**：`cancelRun` 的 fetch 无超时——api 挂起时停止按钮的取消请求也挂起，UI 停不下来；
  3. **cancel 失败后不本地终止**：`cancelRealTurn` catch 分支原注释"keep the stream alive 无限等"——cancel 失败后不 abort、不派发终止动作。
- **真正的 UX 根因（2026-08-12+ 定位，用户反馈"停止没用"）**：reducer `turn.accepted` 把 composer 置 `closed`（提交后输入面板立即关闭）→ **停止按钮（在 composer 内）随之消失**——thinking/streaming 期间用户没有任何停止入口；语音按钮的"打断"只对已生成音频播放有效（`voice.toggle_requested` 不取消 running turn）。用户只能干等。
- **卡 thinking 的根因（2026-08-12+ 真机 CDP 实测定位）**：**reducer 没有 `character.cue` case**——worker 在 `assistant.status` 与 `assistant.delta` 之间下发 cue（seq 连续），reducer 忽略且不消费 seq → 后续 delta/final 在 `classifyDialogueEvent` 判 `future` **全部被拒** → UI 永久卡"伴星正在想"（无论等待多久、停止/播报全部失效）。真机证据：SSE 事件全部到达（status/delta/final），reducer 全部拒绝。
- **播完卡"正在播报"的根因（2026-08-12+ 真机实测定位）**：多条消息排队时，新 run 的 `voice.segments` 已把 reducer 的 voice 置 speaking（新 run），但新 run 的段被 `StreamPlaybackController` 的 **fence 丢弃**（fence 锁定旧 run 不再更新）→ 不播放 → 无 `onDrained` → voice 永久卡 speaking。

### 7.2 改动方案（已实施，含 2026-08-12+ 二次加固）

1. `fetch-sse.ts`：`openCompanionSse` 加**空闲看门狗**（默认 45s > 15s 心跳 ×2）——任何字节（含心跳 comment）重置；超时本地 abort + 报 `network`（调用方按 cursor 重连/失败兜底）。外层 try/finally 统一清理 timer 与外部 signal listener；
2. `companion-chat-client.ts` `cancelRun`：加 **10s 超时**（内部 AbortController + timer，组合外部 signal）；
3. `PetRuntimeProvider.tsx`：
   - **turn 级硬超时（90s）**：submit 建立 activeRealTurn 后启动 timer，超过 90s（> worker 60s budget + 余量）未终态 → 本地 abort + 派发 `turn.failed(TURN_TIMEOUT)`，fail-closed 强制结束——覆盖"worker 崩溃/run 永久卡 running/provider 卡死"等看门狗管不到的场景；
   - **停止立即生效**：`cancelRealTurn` 不再先 await cancel API——点击停止立即本地终止 UI（abort SSE + 清 active + 派发 `turn.cancelled`），cancel API 后台 fire-and-forget 同步服务端（失败由下次 restore 纠正）；
   - **气泡"停止生成"按钮（UX 根因修复）**：`PetBubble` running 视图（thinking/streaming）footer 新增"停止生成"按钮（`turn.cancel_requested`）——提交后 composer 被关闭、原停止按钮不可达，现在生成中随时可从气泡停止；生成中不显示"继续聊"；
   - **reducer 消费 character.cue（卡 thinking 根因修复）**：`pet-reducer.ts` 新增 `character.cue` case——消费 seq（`withSeq`）+ 保存最近 cue 到 emotion 域（补 generation）。修复后 delta/final 不再被 `future` 拒绝（单测锁定：cue 消费 seq → delta/final 正常 apply）；
   - **流式播放器新 run 接管（播完卡 speaking 根因修复）**：`StreamPlaybackController.enqueue` 在 generation 递增（新 turn 语音）时更新 fence、作废旧队列、停旧播放并播放新段——不再因 fence 丢弃导致 voice 永久卡 speaking（单测锁定：新 run 接管 / 旧 run 迟到段仍丢弃）；
   - 终态事件/onError/catch/abort_turn_stream 全部清理硬超时 timer；
4. 测试：`fetch-sse.test.ts` 新增"空闲超时 → network 错误（一次）/ 心跳重置不误报"（2/2）；全量 1003/1003。

### 7.3 验收标准

- [ ] 服务端正常时流式对话不受影响（心跳维持连接，45s 内不误报；90s 内正常完成）；
- [ ] api 挂起/网络断开时：最多 45s 后 SSE 自动重连或按重试预算失败兜底，不再永久卡"伴星正在想"；
- [ ] **点停止：立即停下**（无网络依赖），UI 马上回到可操作状态；
- [ ] **极端场景（worker 崩溃/run 永久卡）**：最多 90s 后本地强制 `turn.failed(TURN_TIMEOUT)`，界面必定恢复；
- [ ] 正常 cancel 路径回归：服务端 run 仍被取消（后台 cancelRun），restore 一致。

---

## 8. G：对话参数调整——丢掉思考模式 + 温度调高（用户建议）

### 8.1 背景

用户建议：日常陪伴对话"丢掉思考模式，输出快很多；温度调高，像真人对话——对错不重要，重要的是像助手的陪伴"。

### 8.2 改动方案（已实施）

1. `packages/shared/src/provider-capabilities.ts`：`ChatOptions` 新增 `disableThinking?: boolean`（显式关思考，优先级高于平台配置/env）；
2. `workers/ai-worker/src/lib/providers/openai-compatible.ts`：`chatCompletionStream`/`call` 两处 body 构建支持 `disableThinking` → `enable_thinking: false`（DeepSeek 系模型思考会显著拖慢首 token）；
3. `workers/ai-worker/src/handlers/companion-dialogue.ts` `COMPANION_PROVIDER_OPTIONS`：**temperature 0.6 → 0.9** + **disableThinking: true**（仅 companion 日常对话生效，其他任务不受影响；dashscope preset 本就默认关思考）；
4. 同步 `node_modules/@ailearn/shared` install-links 拷贝。

### 8.3 验收标准

- [ ] companion 对话请求体含 `enable_thinking: false`（可抓包/日志确认）；
- [ ] 首 token 延迟明显下降（思考不再阻塞输出）；
- [ ] 回复语气更随性自然（温度 0.9）；
- [ ] 其他任务（agent/结构化）的思考配置不受影响（默认行为不变）；
- [ ] worker 1061/1061、shared 413/413、tsc 干净。

---

## 9. H：IPC 竞态日志噪音 + GPU/IMK 日志说明（新反馈）

### 9.1 问题 2（真 bug）：`No handler registered for 'pet:set-interaction-mode'`

- 现象（日志）：`destroyPetWindow called from setPetModeEnabled ... Error occurred in handler for 'pet:set-interaction-mode': No handler registered`。
- 根因：app quit 流程原顺序 `ipcCleanup()`（移除全部 pet handler）→ `destroyPetWindow()`——窗口销毁瞬间 renderer 仍可能发出 `pet:*` invoke（如 `set-interaction-mode`），到达时 handler 已被移除。
- 修复（已实施）：
  1. `main.ts` quit 流程**先 `destroyPetWindow()` 再 `ipcCleanup()`**（窗口先死，handler 后清，排队 invoke 不再落空）；
  2. `register-pet-ipc.ts` handler 包装 try/catch——销毁竞态中 sender 校验抛错不再让 Electron 打印红色噪音，转 `logger.warn`（安全语义不变：请求不处理、invoke 返回 undefined）。
- 验收：退出应用/关闭桌宠时控制台不再出现 `No handler registered` 红字（日志级别可见 `pet ipc handler rejected` 属预期拒绝）。

### 9.2 问题 1（无害噪音，不修代码）：GPU overlay + IMK 错误

- `SharedImageManager::ProduceOverlay ... non-existent mailbox` + `Invalid mailbox`（页面加载时 3 次）：Chromium 合成器尝试硬件 overlay 提升失败——transparent 窗口已知现象，自动回退普通合成，**无功能影响**；
- `TSM AdjustCapsLockLED ...` / `IMKCFRunLoopWakeUpReliable ... mach port`：macOS 输入法框架（TSM/IMK）与 Electron 的已知兼容噪音，**无害**。
- 决定：不引入 GPU 开关（`disableHardwareAcceleration` 等会拖慢 Live2D 软件渲染）；若日后观察到**可见**闪烁/黑块再评估 `--disable-gpu-compositing`。

---

## 10. 实施顺序与验证

1. **A**（流式回调）→ **B**（bootstrap）→ **C**（语音岛）→ **D**（闪烁排查，先复现后修）→ **E**（错误码透传 + 定位）；A 涉及状态机需单测兜底，B/C 纯样式/布局，D/E 以排查+小改为主。
2. 每项完成后跑相关测试：`apps/web/features/companion-pet/voice/companion-stream-player.test.ts`、`pet-reducer.test.ts`、`conversation` 相关；样式/窗口类手动在桌宠窗口验证。
3. 五项完成并验证通过后，**直接接线进真实路径**（按 wire-up-after-verify 规则，不留未接半成品）；测试版未上线，可放开接线。

## 12. I：桌宠 AI 对话"完全不能用"——workspace 未开启 AI 使用（根因 + 实测）

### 12.1 根因（2026-08-12+ 真机实测确认）

- 现象：桌宠 AI 对话完全无回复（此前多轮前端兜底均未解决）。
- **实测方法**：本地 docker 栈（api 127.0.0.1:4000 + worker）登录 e2e 账号 → `POST /companion/conversations` 建对话 → `POST /conversations/:id/turns` 提交 → SSE 读事件流。结果：SSE 返回 `type:"error", code:"AI_CONSENT_REQUIRED", "workspace AI consent required"`。
- **根因**：workspace 的 `ai_data_policy.sendToExternal=false` + consent 未签（`ai_consent_version` 为空）→ worker `companion-dialogue` 在 provider 调用前抛 `AIConsentRequiredError` → run 失败。**所有 AI 功能（桌宠对话、学习卡生成）全部因此失败**——与用户此前"学习卡生成 worker 403"为同一根因。
- 实测对照：DB 开启 consent 后同一链路完整成功（thinking → delta 流式 → final → character.cue → voice.segment.ready；worker 日志 `companion dialogue run succeeded`）。

### 12.2 修复（已实施）

1. `PetBubble.tsx`：`AI_CONSENT_REQUIRED` 专用气泡——"AI 使用未开启" + 文案 + **"前往设置开启"**按钮（`openMainRoute({kind:"settings",section:"model"})`，直达设置页 AI 使用与数据选项卡）；
2. `packages/shared/src/desktop-pet-contracts.ts`：`settings.section` 枚举加 `"model"`（主进程 URL 映射 `/settings?section=model` 已通用，设置页已支持 `?section=model` 直达）；
3. worker 侧（§9.3 起已改）：policy 拒绝统一抛 `AIConsentRequiredError`（不可重试）、失败投影保留 `ai_consent_required` code——学习卡生成弹窗也会引导；
4. 验证：consent 关 → error AI_CONSENT_REQUIRED（引导）；consent 开 → 完整对话链路（web 1003/1003、shared 413/413、worker 1061/1061、api 3036/3036、双端 tsc）。

### 12.3 用户操作（问题本身是配置，不是代码）

1. 桌宠发消息 → 气泡显示"AI 使用未开启" → 点"前往设置开启"；
2. 设置页「AI 使用与数据」→ 开启"发送数据到外部 AI"并签署协议；
3. 回到桌宠重新对话 → 正常（链路已实测）。

---

## 13. 验收状态汇总（2026-08-12+ 真机实测）
| 项 | 验收点 | 状态 | 证据 |
| --- | --- | --- | --- |
| A 流式播完 | 播完 voice 回 idle / 打断不误触发 | ✅ **真机实测**：3 条对话全部 speaking→播完自动回 idle（"正在播报"不残留） | CDP 状态轮询 |
| B 玻璃卡片 | 透明无纸黄 / 四态一致 / reduced-motion | ✅ 纸黄根因修复（`html:has(.pet-bootstrap)`）；🖥️ 视觉待用户确认 | 代码走查 |
| C 语音岛 | 头顶居中完整版 / 不遮挡 | 🖥️ 位置已按用户反馈迭代 4 版（当前终版待确认） | 视觉识别确认遮挡问题 |
| D 面板闪烁 | 开关面板无闪 / 穿透正常 | ✅ 主进程移除 blur/show()/passive 翻转延后；🖥️ 真机待确认 | 日志待用户复测 |
| E 学习快捷 | CSRF 通过 / 细分错误码 / 正常路径 | ✅ **API 实测**：无 CSRF→403、带 CSRF→409 `NO_ACTIVE_SESSION`（新 code 生效）；正常路径需有学习数据 | curl 实测 |
| F 卡 thinking/停止 | 45s 重连 / 停止立即 / 90s 硬超时 / cancel 回归 | ✅ **真机实测**：生成中点击"停止生成"→ 立即"回复已停止"（t+300ms）；API cancel 链路 ✓ | CDP 实测 + curl |
| G 对话参数 | enable_thinking:false / 温度 0.9 | ✅ 代码 + worker 重启后对话实测成功（provider 接受参数） | 实测对话成功 |
| H IPC 竞态 | 退出无 No handler registered | ✅ 顺序修复 + handler catch；🖥️ 退出日志待确认 | 代码走查 |
| I consent 引导 | 未开启→引导；开启→对话正常 | ✅ **API 实测双场景**：consent 关→`AI_CONSENT_REQUIRED`；consent 开→完整链路（thinking→delta→final→cue→TTS） | curl 实测 + worker 日志 |
| J 声音（新） | 每条对话都有声音 / 第二次不失效 | ✅ **真机实测**：连续 3 条对话全部进入 speaking 且 api 收到 `/voice/tts/stream` 请求（edge-tts 容器 healthy） | CDP 实测 + api 日志 |
| K 长文本（新） | 气泡展示完整 / 长文本读完 | ✅ 修复：气泡 max-height 184→380（滚动区 86→280）、worker TTS 段 20→40/2000→4000 字、前端队列 20→50、失败段重试 1 次；单测锁定（tts-segments 40 段上限、stream-player 12/12） | 单测 + 代码 |

- ✅ = 已实测/单测通过；🖥️ = 依赖桌宠窗口 UI，需用户真机确认（我无法操作 Electron 窗口）
- 全量测试：web 1003/1003、shared 413/413、worker 1061/1061、api 3036/3036、双端 tsc、`git diff --check` 干净
- 运行时栈：api/worker 容器已重启加载最新代码（api healthy、worker `companion dialogue run succeeded`）

---

## 14. 风险与回滚

- 均为前端增量/样式改动 + 主进程窗口级副作用最小化，无服务端契约变更、无 DB 迁移；
- 流式回调只新增 `onDrained` 通道，非流式 pump 兜底保留，双路径互不干扰；
- D 若复现为合成重置类问题，改动集中在 `main.ts` / `pet-hit-test-controller.ts` 的副作用时序，改动前先以日志确认；
- 回滚：涉及 `companion-stream-player.ts`、`companion-stream-playback-runtime.ts`、`PetRuntimeProvider.tsx`、`page.tsx`、`pet.css`、`PetMenu.tsx`、`main.ts`、`pet-hit-test-controller.ts`，`git checkout` 即回；
- 未决项不阻塞本文档五项：问题 8/5 另议，问题 7/2/1 归 15 大文档。

## 11. 后续（15 大文档，不在本文档）

- 问题 7：`character.cue` 消费（reducer 已映射未接线）→ `emotion-vad.ts` → `emotion-expression-map.ts` → facs 层接线（服务端已 60% 就绪）；
- 问题 2/1：worker 将 TTS 段生成从 final 后前置到 delta 阶段（句子级边生成边合成），涉及事件 seq 布局与存储契约。
