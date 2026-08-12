# 02 — Runtime、状态机、Electron 窗口与跨窗口协调合同

> 状态：P0/P1 runtime 已实施；2026-08-11 角色 click/direct-drag 修订已回归
>
> 适用阶段：P0–P6
>
> 目标：消除重复状态真相、窗口生命周期和 Pet/Main 并发行为的实现歧义

---

## 1. 状态所有权原则

运行时不得再用一个 `anchor/panel/stage` 枚举表达全部产品状态，也不得让 Character、Bubble、Voice 各自保存互相矛盾的 `thinking/speaking`。

唯一规则：

> **业务状态按域保存；角色表现永远从业务状态派生，不是第五份业务真相。**

### 1.1 七个正交域

```ts
interface PetRuntimeStateV1 {
  lifecycle: PetLifecycleState;
  turn: ConversationTurnState;
  bubble: BubbleDisplayState;
  composer: ComposerState;
  voice: VoiceDialogueState;
  menu: PetMenuState;
  window: PetWindowInteractionState;
  context: PetRuntimeContext;
}
```

Character Driver 不出现在该对象内。它只消费 `deriveCharacterPresentation(state)` 的结果。

### 1.2 Runtime context

```ts
interface PetRuntimeContext {
  surfaceId: string;
  surfaceKind: "pet" | "main" | "web_fallback";
  userId: string | null;
  workspaceId: string | null;
  accountEpoch: number;
  conversationId: string | null;
  latestEventSeq: number;
  inboxConversationId: string | null;
  inboxLatestEventSeq: number;
  activeGeneration: number;
  online: boolean;
  reducedMotion: boolean;
  animationOff: boolean;
  voiceOff: boolean;
  privacyMode: boolean;
}
```

- `surfaceId` 每次 renderer 启动生成 UUID，只存在内存；
- 尚未选择 dialogue 时固定 `conversationId=null/latestEventSeq=0/activeGeneration=0`；inbox ensure 完成前固定 `inboxConversationId=null/inboxLatestEventSeq=0`；
- authoritative conversation snapshot 有 active run 时以其 `generation` 初始化 `activeGeneration`，无 active run 时置 `0` 并直接把 cursor 对齐 snapshot head；不得从本地历史消息、最大 message seq 或缓存猜 generation；
- workspace 切换必须替换 `workspaceId`、断开旧 stream、释放 playback lock、取消本地音频并清空气泡；
- `accountEpoch` 落后于服务端时，所有迟到结果立即丢弃；
- `latestEventSeq` 是当前 dialogue conversation 的 durable cursor，不是数组下标；
- `inboxConversationId/inboxLatestEventSeq` 独立跟踪唯一 proactive inbox，绝不拿 dialogue cursor 消费 inbox event。
- `privacyMode` 是 Main process 下发的设备本地投影，默认 `false`；它不从服务端消息正文或其他应用状态推断。

---

## 2. 七个状态机

### 2.1 Lifecycle

```ts
type PetLifecycleState =
  | { kind: "booting" }
  | { kind: "visible" }
  | { kind: "hidden"; reason: "temporary" | "global_off" | "owner_disabled" }
  | { kind: "suspended"; reason: "system_sleep" | "locked_screen" | "app_quitting" }
  | { kind: "auth_required" }
  | { kind: "fatal"; code: string };
```

Lifecycle 只回答“surface 是否存在并应运行”。它不包含 listening、thinking、speaking。

### 2.2 Conversation turn

```ts
type ConversationTurnState =
  | { kind: "idle" }
  | {
      kind: "submitting";
      clientMessageId: string;
      idempotencyKey: string;
      input:
        | { kind: "text" }
        | {
            kind: "voice_transcript";
            voiceArtifactId: string;
            transcriptSha256: string;
            expiresAt: string;
          };
    }
  | {
      kind: "running";
      conversationId: string;
      runId: string;
      generation: number;
      phase: "accepted" | "thinking" | "streaming" | "acting";
      previewText: string;
      lastSeq: number;
    }
  | { kind: "final"; runId: string; generation: number; messageId: string }
  | { kind: "cancelled"; runId: string; generation: number }
  | { kind: "error"; runId?: string; generation?: number; code: string; recoverable: boolean };
```

- `turn` 是 assistant generation 的唯一客户端状态；
- `thinking/streaming` 不再出现在 Lifecycle 或 Voice；
- voice transcript submit 的 provenance 只存在于当前 submitting state/effect；网络结果未知时以同 clientMessageId/idempotencyKey/artifact 精确重试。用户编辑 transcript 后必须改为新的 text turn，让未绑定 artifact 自然过期；
- final 写入 durable message 后才可进入 `final`；
- UI 退出 final 后回到 idle，但 durable history 不删除。

### 2.3 Bubble display

```ts
type BubbleDisplayState =
  | { kind: "hidden" }
  | {
      kind: "turn";
      ref:
        | { kind: "client"; clientMessageId: string }
        | { kind: "run"; runId: string };
    }
  | { kind: "incoming"; deliveryId: string; messageId: string }
  | { kind: "confirmation"; proposalId: string }
  | { kind: "voice_status" }
  | { kind: "error"; code: string };
```

Bubble 只决定当前显示哪一种内容来源，不保存 assistant text 或 composer draft：

- `turn/client` 从 optimistic message store + submitting state 读取确定性“已收到”视图；`turn/run` 从 `turn.previewText` 读取；
- `incoming` 从 delivery/message store 读取；
- `confirmation` 从 proposal store 读取；
- `voice_status` 从 Voice state 读取；
- `error` 从受净化错误 store 读取。

这样 composer 可以和 streaming turn 同时存在，不再需要把两者塞入同一个互斥枚举。

### 2.4 Composer

```ts
type ComposerState =
  | { kind: "closed" }
  | { kind: "editing"; draft: string }
  | { kind: "submitting"; draftSnapshot: string; clientMessageId: string };
```

- `draft` 仅 renderer 内存；
- submit 成功收到 `turn.accepted` 后清空；
- 网络失败时恢复 `draftSnapshot`；
- assistant 正在 streaming 时允许打开 composer；新发送带 `supersedesGeneration`，由一次 POST 的服务端事务原子 supersede 旧 run 并创建新 turn；
- 关闭 composer 不取消 assistant turn。

### 2.5 Voice

```ts
type VoiceDialogueState = { operationEpoch: number } & (
  | { kind: "idle" }
  | { kind: "requesting_permission" }
  | { kind: "listening"; startedAt: number; streamId: string }
  | { kind: "finalizing"; streamId: string }
  | { kind: "transcribing"; streamId: string; uploadId: string }
  | { kind: "speaking"; runId: string; generation: number; segmentId: string }
  | { kind: "cooldown"; until: number }
  | { kind: "cancelled"; reason: string }
  | { kind: "error"; code: string; recoverable: boolean }
);
```

Voice 只回答“麦克风/转写/音频播放正在做什么”。`thinking` 属于 turn，不属于 voice。

硬不变量：

- `listening` 与 `speaking` 永不同时成立；
- `operationEpoch` 每次 renderer 启动从 0 开始；每次点按启动录音、barge-in、voice cancel、workspace/account/lifecycle fence 都单调增加；permission、track、upload、ASR 和 playback effect 捕获发起时 epoch，回灌事件不匹配当前 epoch 时只清理资源、不改变 UI、不提交 turn；
- 进入 speaking 前停止所有 live MediaStreamTrack；
- barge-in 顺序固定为：停止 source → 清队列 → 释放 playback lock → generation fence → 请求/打开麦克风；
- `voiceOff=true` 只禁止进入 speaking，不禁止 listening/transcribing 或文字回复；
- hidden/suspended/auth_required/fatal 必须落到 voice idle 并释放所有 track/audio node。

### 2.6 Menu

```ts
type PetMenuState =
  | { kind: "closed" }
  | { kind: "root"; focusItem: string }
  | { kind: "study"; focusItem: string }
  | { kind: "more"; focusItem: string };
```

- 菜单和 bubble 可以同时存在；
- 打开菜单时暂停 bubble auto-dismiss 计时；
- 打开 composer 时关闭菜单；
- confirmation 未处理时可以关闭菜单，但不能通过菜单触发第二个 destructive proposal。

### 2.7 Window interaction

```ts
type PetWindowInteractionState =
  | { kind: "passive" }
  | { kind: "interactive"; reason: "pointer_hit" | "menu" | "bubble" }
  | { kind: "text_input" }
  | { kind: "dragging" }
  | { kind: "accessibility_focus" };
```

- `text_input/dragging/accessibility_focus` 时主进程必须强制窗口可交互；
- passive 是否 click-through 由主进程命中控制器计算，renderer 不能直接切换；
- dragging 期间角色 click/抚摸/menu intent 全部忽略。

---

## 3. 状态事件与 reducer 合同

### 3.1 UI intent

```ts
type PetUiIntent =
  | { type: "character.clicked" }
  | { type: "composer.opened" }
  | { type: "composer.draft_changed"; draft: string }
  | { type: "composer.submitted" }
  | { type: "composer.closed" }
  | { type: "menu.opened" }
  | { type: "menu.navigated"; target: "root" | "study" | "more" }
  | { type: "menu.closed" }
  | { type: "privacy_mode.set_requested"; enabled: boolean }
  | { type: "turn.cancel_requested" }
  | { type: "voice.toggle_requested" }
  | { type: "voice.cancel_requested" }
  | { type: "bubble.dismissed" };
```

### 3.2 Runtime/system event

```ts
type PetRuntimeEvent =
  | { type: "bootstrap.authenticated"; userId: string; workspaceId: string; accountEpoch: number }
  | { type: "bootstrap.auth_required" }
  | { type: "account.global_off"; epoch: number }
  | { type: "workspace.changed"; workspaceId: string; accountEpoch: number }
  | { type: "network.online" }
  | { type: "network.offline" }
  | { type: "system.suspended"; reason: "system_sleep" | "locked_screen" }
  | { type: "system.resumed" }
  | { type: "desktop.window_state_changed"; state: DesktopPetWindowStateV1 }
  | { type: "voice.permission_result"; operationEpoch: number; granted: boolean }
  | { type: "voice.track_started"; operationEpoch: number; streamId: string }
  | { type: "voice.track_stopped"; operationEpoch: number; streamId: string }
  | {
      type: "voice.transcript_ready";
      operationEpoch: number;
      streamId: string;
      uploadId: string;
      voiceArtifactId: string;
      text: string;
      transcriptSha256: string;
      expiresAt: string;
    }
  | { type: "voice.playback_started"; operationEpoch: number; runId: string; generation: number; segmentId: string }
  | { type: "voice.playback_finished"; operationEpoch: number; runId: string; generation: number; segmentId: string }
  | { type: "voice.failed"; operationEpoch: number; code: string };
```

服务端 `CompanionStreamEventV1` 在 03 合同中定义，进入同一个 reducer adapter。

### 3.3 核心 transition 表

| 当前状态/事件 | 新状态 | 副作用 |
| --- | --- | --- |
| composer closed + character.clicked | composer editing | 请求 Pet focus，不打开 Main Window |
| composer editing + submitted | composer submitting + turn submitting + bubble turn/client | 生成 clientMessageId/idempotencyKey；有 active run 时带 supersedesGeneration；本地 fence 后 POST turn |
| turn submitting + turn.accepted | turn running/accepted + bubble turn/run | 清 draft，连接/续接 SSE |
| turn running + assistant.status(thinking) | running/thinking | bubble=turn |
| turn running + assistant.delta | running/streaming | seq/generation guard 后追加 preview |
| running + assistant.final | final | 校验 preview textLength/textSha256；持久消息必须可 GET 且 blocks hash 匹配 messageContentSha256；否则 snapshot |
| any active turn + cancel intent | 原状态直到 server ack | POST cancel，本地立即停止 TTS并 fence old generation |
| active turn + turn.cancelled | cancelled | 旧 delta/audio/cue 全部丢弃 |
| voice idle/error/cancelled + voice.toggle_requested | requesting_permission 或 listening | 只有用户点按角色旁外置麦克风或键盘激活才可触发 permission；pointerup 不参与提交 |
| listening + voice.toggle_requested | finalizing→transcribing | 第二次点按后停 track 并上传，禁止仍显示 listening |
| transcribing + 同 epoch/stream/upload 的 transcript_ready | composer editing（转写稿回填） | transcript 作为可编辑 draftSnapshot；用户确认发送时再连同 voiceArtifactId/hash/expiry 按 03 strict voice turn 提交；不匹配只清理迟到结果 |
| speaking + voice.toggle_requested | listening | 点按打断时严格执行 stop/fence/open mic 顺序 |
| proactive delivery accepted | bubble incoming | 仅 permit 有效、未过期且非 DND |
| any + privacy_mode.set_requested | 原状态直到 main ack | effect 调用 `setPrivacyMode(enabled)`；不得先乐观暴露正文 |
| desktop.window_state_changed | 更新 context/window projection | 只接受更高 revision；privacy 开启时替换 proactive preview、停止其 TTS且不补播 |
| global_off | lifecycle hidden | 断 SSE、停音频/麦克风/动画、销毁 Pet Window |
| workspace changed | lifecycle booting | 清所有 scoped state，重新 bootstrap |

### 3.4 Reducer 纯度

- reducer 只返回 state/effect descriptors，不直接 fetch、操作 BrowserWindow、播放音频或写数据库；
- effect runner 执行副作用后以 typed event 回灌；
- 每个 transition 有纯逻辑 node:test；
- 未识别事件 fail closed：state 不变并记录 content-free diagnostic code；
- reducer 不记录消息正文、transcript、provider 响应到普通日志。

---

## 4. Character presentation 是派生投影

```ts
type CharacterPresentationState =
  | "hidden"
  | "idle"
  | "invite"
  | "listen"
  | "think"
  | "analyze"
  | "speak"
  | "navigate"
  | "encourage"
  | "celebrate"
  | "uncertain";
```

`deriveCharacterPresentation` 使用固定优先级：

1. lifecycle booting/hidden/suspended/auth_required → `hidden`；
2. lifecycle fatal → `uncertain`；
3. voice listening/finalizing → `listen`；
4. voice transcribing → `think`；
5. voice speaking → `speak`；
6. 真实 navigation action started → `navigate`；
7. turn running acting → `analyze`；
8. turn running thinking/streaming → `think`；
9. 当前 error → `uncertain`；
10. 有允许展示的 proactive delivery → `invite`；
11. 有真实、policy 允许的 encouragement/celebration event → 对应状态；
12. 其余 → `idle`。

规则：

- LLM 只可建议 `CharacterCueV1`；客户端根据真实状态和系统事件二次校验；
- `celebrate` 不能由普通 assistant 文本或情绪标签单独触发；
- `committed_change` 仍必须由现有 `commit_recorded` 系统事件授权；
- 正式评估开始时继续使用现有 `assessment_handoff` 诚实性投影；
- Driver 收到的最终 projection 不反向改变 runtime state。

---

## 5. Generation 与迟到结果防护

### 5.1 接受事件的必要条件

```ts
type EventDisposition =
  | "duplicate"
  | "apply"
  | "consume_only"
  | "snapshot_required"
  | "rebootstrap_required"
  | "scope_violation";
```

处理每个 dialogue event 的顺序冻结为：

1. shared Zod parse 失败 → 关闭 stream，`snapshot_required`；
2. workspace/conversation 不等于当前订阅 → `scope_violation`，关闭 stream并重新 bootstrap；
3. `accountEpoch > context.accountEpoch` → `rebootstrap_required`，不推进 cursor；较旧 epoch 的合法连续 event → `consume_only`；
4. `seq <= latestEventSeq` → `duplicate`；`seq !== latestEventSeq + 1` → `snapshot_required`；
5. run-scoped 类型为 `turn.accepted/assistant.status/assistant.delta/assistant.final/character.cue/voice.segment.ready/turn.cancelled`，以及 `runId!=null` 的 `error`；generation 小于 active → `consume_only`，大于 active → `snapshot_required`，相等才 `apply`；
6. conversation-scoped 类型为全部 `action.*` 及 `runId=null` 的 `error`；它们不因 active generation 已前进而丢弃，验证 proposal/action store 后 `apply`，但不能反向改变 Turn generation；
7. `apply/consume_only` 都在同一次 reducer commit 中把 `latestEventSeq` 前进到 event.seq；`duplicate/snapshot/rebootstrap/scope_violation` 不前进。

`POST /turns` response 的 `eventCursor` 固定是同一事务写入的 durable `turn.accepted` event seq，不是响应时任意查询到的 conversation head。response 仍与当前 `submitting.clientMessageId` 匹配且 generation 不低于本地 active generation 时，可立即采用新 run/generation 作为迟到结果 fence；cursor 只能在 `eventCursor === latestEventSeq + 1` 时把 response 当作该条 `turn.accepted` 的语义等价输入并推进。`eventCursor <= latestEventSeq` 视为 SSE 已先消费；`eventCursor > latestEventSeq + 1` 必须保留当前 cursor 并 GET authoritative snapshot，绝不能直接跳过中间 event。其他 surface 先收到更高 generation 的任一 run-scoped event 时也 GET snapshot，不直接应用。POST 失败时恢复 draftSnapshot、解除本地临时 fence并 GET snapshot。

Inbox 使用同样的 scope/epoch/严格连续 cursor 规则，但只允许 `proactive.delivery`、`proactive.delivery.updated` 和 `runId=null` 的 `error`，不比较 generation。收到 delivery 后先完成 03 合同的 viewed/content claim，只有 response 允许才渲染正文；`contentPolicy/content_hidden` 或设备 privacy mode 走无正文分支。

Inbox 被用户删除或其 SSE 返回 `404` 时，清空 inbox id/cursor，按 03 合同重新 ensure 并从新 cursor 订阅；`409 CURSOR_EXPIRED` 则先 GET 同一个 inbox snapshot，不重新创建。两种路径都不得把已删除旧 inbox message 恢复到新 inbox。

Dialogue 的 authoritative recovery 固定顺序为：GET conversation snapshot并原子替换 active run/cursor → GET 最新 messages page（无 `beforeSeq`、limit 100）按 `(id,seq)` reconcile durable history → 以 snapshot `latestEventSeq` 连接 SSE。第二个 GET 之后产生或已被它提前看见的 final/result 仍会由 SSE event 推进 cursor，message store 按 ID 去重。Inbox recovery 不自动 GET message 正文，避免绕过 delivery viewed/content-claim；完整历史页只有在用户明确打开时才按普通 message API 读取。

### 5.2 新 generation

以下操作创建新 generation：

- 用户发送新 turn；
- 用户在旧 turn 未结束时重新发送；
- barge-in 后发送新的 transcript；
- retry 创建新 run。

`CURSOR_EXPIRED` 或客户端 payload/hash mismatch 只触发 authoritative snapshot + cursor replacement，本身不创建 generation；snapshot 中若有不同 active generation，再按该 authoritative run 执行 §5.2 fence。

新 generation 生效时必须原子执行：

1. 标记本地旧 generation cancelled/superseded；
2. 停止旧 AudioBufferSourceNode；
3. 清空旧 TTS segment queue；
4. 调用 CharacterPerformancePort.interrupt；
5. 释放旧 playback lock；
6. 拒绝旧 generation 的 run-scoped delta/cue/audio；conversation-scoped `action.*` 仍按 §5.1 验证并应用；
7. 更新 activeGeneration。

---

## 6. Pet/Main 跨窗口协调

### 6.1 数据与播放分离

- Pet 和 Main 可以各自连接 SSE；服务端事件与消息幂等，重复读取无副作用；
- Pet 常驻时最多维护两个 SSE：当前 dialogue 和唯一 inbox；没有 active dialogue 时只保留 inbox；两者 cursor 独立；
- 两个 surface 都可以渲染 durable text；
- 同一个 run 同一时刻只允许一个 playback leader 播放 TTS、驱动口型和发出系统音频；
- 任何写请求仍由服务端 idempotency key 防重，不能只依赖 BroadcastChannel。

### 6.2 Playback leader

Electron/Chromium 首选 Web Locks API：

```ts
const lockName = `ailearn:companion:playback:${workspaceId}:${runId}:${generation}`;
```

规则：

- 创建 turn 的 surface 先用 `{ ifAvailable: true }` 申请 lock；
- P0–P6 proactive delivery 不生成 voice segment、因此不申请 playback lock；未来若单独批准主动播报，才可由 Pet 优先、Pet 不存在/隐藏时 Main 申请，且仍受 privacy/DND Gate；
- 持有 lock 的异步作用域覆盖完整 audio queue；
- surface hidden、workspace change、cancel、crash 或 playback 完成时释放；
- 未拿到 lock 的 surface 显示文字，但不请求 TTS、不播放、不驱动口型；
- Web Locks 不可用时才使用 BroadcastChannel lease fallback：TTL `5s`，每 `2s` 续期，按 `(issuedAt, surfaceId)` 稳定决胜；
- fallback 发生 split-brain 时，收到更早有效 lease 的 surface 立即停音频。

跨窗口 barge-in：

1. 用户点按麦克风的 surface 广播 `playback.stop_requested {runId,generation,fenceId}`；
2. 当前 leader 立即 stop source、清队列、释放 lock，并广播 `playback.stop_ack {fenceId}`；
3. 发起方收到 ack 后开麦；无 ack 时最多等待 `150ms`，重新检查 lease 后 fail closed 到文字输入或确认旧 leader 已失效；
4. stop request/ack 不含文本或音频；
5. 端到端点按到静音目标仍为 p95 `≤200ms`。

### 6.3 BroadcastChannel

固定频道：

```text
ailearn-companion-runtime-v1
```

只广播无敏感正文的协调消息：

- surface hello/goodbye；
- active workspace/conversation/run/generation；
- playback lease；
- playback stop request/ack；
- cancel fence；
- Main/Pet route visibility；
- durable cursor changed。

不得广播凭据、完整消息正文、transcript、音频、学习答案或 provider 原始错误。

### 6.4 Main route ownership

- “完整对话”调用 typed IPC `openMainRoute({ kind: "conversation", conversationId? })`；
- Main Window 显示、恢复并导航到 allowlisted route；
- route 导航完成后 Main 通过 channel 宣告 active conversation；
- Pet 不等待 Main 打开才能继续当前 turn；
- Main 关闭/隐藏不取消 Pet turn。

---

## 7. Electron 启动与认证生命周期

### 7.1 窗口创建顺序

1. Main process 启动本地 Next.js server 并完成 identity health check；
2. 创建 Main Window；首次运行或无已知认证状态时正常显示登录/应用；
3. 读取 device-local `petModeEnabled`，若为 true，创建 **hidden Pet Window**；
4. Pet Window 加载最小 `/companion/pet?surface=electron`；
5. P0–P1 Pet renderer 通过同源 `/api/me/companion` 验证 cookie 与 `globalEnabled`，只显示技术图形/fixture；P2 起改用 03 合同的单次 `/api/companion/bootstrap`，在一个 authenticated request 中取得当前 `userId/workspaceId`、account `epoch` 与 feature projection；任一失败都不渲染个性化正文；
6. 验证成功且本机未 temporary hidden 才通知 main `pet:bootstrap-ready`；
7. Main 使用 `showInactive()` 显示 Pet；
8. 401/403 时 Pet 保持隐藏并请求显示 Main 登录页；
9. main process 不直接读取、复制或缓存 Web auth cookie。

P2 起，bootstrap 认证成功后，Pet renderer 还必须按 03 合同幂等 ensure inbox、恢复 `inboxLatestEventSeq` 并连接独立 inbox SSE；该网络步骤仍由 renderer 完成，main process 不获得 user/workspace id、消息或 cookie。

解决的循环依赖：Main process 不需要在创建 Pet 前知道 account state；Pet 可以先 hidden bootstrap，但未经认证绝不显示个性化内容。

### 7.2 Session partition

- Main/Pet 使用 Electron `session.defaultSession`，不创建不同 `partition`；
- 两窗加载完全相同的动态 origin，固定为本进程实际启动的 `http://127.0.0.1:<allocatedPort>`；不得把 `localhost`、任意 loopback port 或通配 host 当同源；
- 端口每次启动可变，但同一次进程内必须一致；
- 不把 auth token 放入 query、localStorage、IPC payload 或日志；
- 登出事件使 Pet 立即隐藏、停麦克风/音频并清空内存消息。

两窗 `webPreferences` 固定 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`、`allowRunningInsecureContent=false`；production DevTools 默认关闭。Pet 的 `will-navigate` 只允许同 origin 的当前 `/companion/pet` reload，其他一律 prevent；Main 只允许同 origin app navigation。两窗 `setWindowOpenHandler` 默认 deny，Main 的外链必须经过现有 HTTPS allowlist 后交系统浏览器，Pet 不直接开外链。任何 permission request 默认 deny，P3 只为 03 合同 §11.1 的可信 origin/path + 活跃用户手势临时允许 microphone。

### 7.3 Pet route 隔离

冻结路径：

```text
apps/web/app/(pet)/companion/pet/layout.tsx
apps/web/app/(pet)/companion/pet/page.tsx
```

要求：

- 使用专用 minimal layout；
- 不挂载 `AppShell`、旧 `CompanionRuntimeProvider`、Sidebar、Header、mobile nav 或 analytics page observer；
- `html/body/root` transparent；
- 只加载 token、accessibility 和 pet 样式；
- 未认证时不渲染角色正文，只向 preload 报 auth_required；
- 不能递归挂载旧 Anchor/Panel。

### 7.4 Main/Pet 关闭与恢复语义（P0–P3 macOS）

- `petModeEnabled=true` 且 app 非 quitting 时，Main Window 关闭按钮只 hide，不 destroy；Pet 继续存在；
- Dock `activate`、second-instance 或 Pet 的 `openMainRoute` 都恢复同一个 Main Window；若 renderer crash 导致窗口不可恢复才重建；
- “暂时隐藏”先显示 Main 的可恢复入口，再 hide Pet；默认只持续到本次 app process 结束，重新启动后按账号/本机设置恢复；
- “退出桌宠模式”原子写 `petModeEnabled=false`、销毁 Pet、显示并聚焦 Main；不删除 conversation/account 数据；
- `Cmd+Q`、系统 Quit 或经过确认的 native Quit 设置 `appQuitting=true`，允许两窗关闭并执行统一资源清理；
- `petModeEnabled=false` 时保持当前单 Main Window 的退出语义；
- P6 引入 tray/menu bar 后可扩展恢复入口，但不得静默改变以上数据和资源释放语义。

---

## 8. Typed preload 与 IPC 合同

Renderer 不得直接获得 `ipcRenderer`、BrowserWindow、screen、shell 或任意 URL 导航能力。

下列类型必须在 `packages/shared/src/desktop-pet-contracts.ts` 以 Zod `.strict()` schema 定义并导出类型；这里的字段集合就是 v1 完整集合，不允许 renderer/main 各自声明近似版本：

```ts
type DesktopPetInteractionModeV1 =
  | "passive"
  | "interactive"
  | "text_input"
  | "dragging"
  | "accessibility_focus";

interface DesktopPetCapabilitiesV1 {
  version: 1;
  platform: "darwin" | "win32" | "linux";
  transparentWindow: boolean;
  forwardedClickThrough: boolean;
  showInactive: boolean;
  contentProtection: boolean;
}

interface DesktopPetWindowStateV1 {
  version: 1;
  revision: number;
  visible: boolean;
  displayId: string;
  boundsDip: { x: number; y: number; width: number; height: number };
  contentSizeCssPx: { width: number; height: 520 };
  scaleFactor: number;
  petModeEnabled: boolean;
  petScale: 0.85 | 1 | 1.15 | 1.25;
  locked: boolean;
  alwaysOnTop: boolean;
  privacyMode: boolean;
  interactionMode: DesktopPetInteractionModeV1;
}

type PetBootstrapResultV1 =
  | { version: 1; kind: "ready" }
  | { version: 1; kind: "auth_required" }
  | { version: 1; kind: "global_off" }
  | {
      version: 1;
      kind: "fatal";
      code: "UNSUPPORTED_PLATFORM" | "PET_BOOTSTRAP_FAILED";
    };

type DesktopLifecycleEventV1 =
  | { version: 1; kind: "system_suspended"; reason: "sleep" | "screen_locked" }
  | { version: 1; kind: "system_resumed" }
  | { version: 1; kind: "displays_changed" }
  | { version: 1; kind: "temporary_hidden" }
  | { version: 1; kind: "app_quitting" };
```

`boundsDip` 固定表示 `BrowserWindow.getContentBounds()` 的 DIP 坐标；`contentSizeCssPx` 使用 zoom factor 1 下的 renderer CSS px。P0 必须实测两者在目标 DPI 下 1:1 对齐，不能把 device pixels 混入 schema。`revision` 由 main process 单调递增；renderer 丢弃更旧的 window state。bootstrap payload 故意不含 cookie、token、user/workspace id 或消息正文。

Main route allowlist 冻结为：

```ts
const allowedMainRouteV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    conversationId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    kind: z.literal("settings"),
    section: z.enum(["companion", "voice"]),
  }).strict(),
  z.object({ kind: z.literal("review") }).strict(),
  z.object({ kind: z.literal("card"), cardId: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("star_map"),
    keyPointId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    kind: z.literal("learning_session"),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid(),
    sessionId: z.string().uuid(),
    origin: z.enum(["card", "review", "star_map", "now"]),
  }).strict(),
]);

type AllowedMainRouteV1 = z.infer<typeof allowedMainRouteV1Schema>;
```

除 `kind/section/origin` 外的 ID 均由 shared schema 校验 UUID。main process 使用固定 mapping 构造 `/companion/conversations`、`/settings`、`/review`、`/cards/:id`、`/graph` 或 `/cards/:id/companion`，query 只通过 `URLSearchParams` 写入；renderer 不能提交 pathname、query string 或完整 URL。

```ts
interface DesktopPetApiV1 {
  getCapabilities(): Promise<DesktopPetCapabilitiesV1>;
  getDeviceSessionId(): Promise<string>;
  getWindowState(): Promise<DesktopPetWindowStateV1>;
  registerHitGeometry(input: PetHitGeometryV1): Promise<void>;
  setInteractionMode(mode: DesktopPetInteractionModeV1): Promise<void>;
  dragBy(deltaX: number, deltaY: number): Promise<void>;
  requestTextInputFocus(): Promise<void>;
  setPetModeEnabled(enabled: boolean): Promise<void>;
  setAlwaysOnTop(enabled: boolean): Promise<void>;
  setLocked(enabled: boolean): Promise<void>;
  setPetScale(scale: 0.85 | 1 | 1.15 | 1.25): Promise<void>;
  setPrivacyMode(enabled: boolean): Promise<void>;
  moveToSafePosition(): Promise<void>;
  openMainRoute(route: AllowedMainRouteV1): Promise<void>;
  reportBootstrap(result: PetBootstrapResultV1): Promise<void>;
  hidePet(): Promise<void>;
  onWindowStateChanged(callback: (state: DesktopPetWindowStateV1) => void): () => void;
  onLifecycleEvent(callback: (event: DesktopLifecycleEventV1) => void): () => void;
}
```

刻意不暴露 `setIgnoreMouseEvents`。点击穿透必须由 main process 根据经过校验的 geometry 和 interaction mode 决定。

`setPetModeEnabled(false)` 实现 §7.4 的“退出桌宠模式”；`true` 只能由 Main 的 Companion 设置页用户手势调用并创建 hidden-bootstrap Pet。`hidePet()` 只表示本次进程暂时隐藏，不能改写持久 `petModeEnabled`。

退出整个应用只走 Electron 原生 App menu、Dock/System Quit 或 `Cmd+Q` 生命周期；v1 不向任何 renderer 暴露 quit IPC，也不在 Pet 二级菜单提供“退出应用”。

`getDeviceSessionId()` 只返回本次 app process 启动时由 main 生成的 UUID；Main/Pet 得到同一个值，退出即失效，不写磁盘、不进入 BroadcastChannel/日志。它只用于 03 合同 proactive content claim header，不是设备指纹、登录凭据或授权依据。

### 8.1 IPC 安全

每个 handler 必须：

- 验证 sender BrowserWindow id 是当前 Pet 或 Main allowlist；
- 验证 senderFrame URL 的 origin/path；
- 使用 shared Zod `.strict()` schema；
- 限制 payload 大小和数组长度；
- 拒绝 prototype keys、NaN/Infinity、负尺寸和屏幕外任意巨大坐标；
- `openMainRoute` 只接受 discriminated union，不接受字符串 URL；
- 只有设置、导航、隐藏/退出桌宠模式等低频 privileged handler 写 content-free audit；`get*`、订阅和高频 geometry/interaction 更新只做 bounded diagnostic counter，避免 audit 洪泛；两者都不记录消息正文。

---

## 9. Hit-test 合同

### 9.1 Geometry payload

```ts
interface PetHitGeometryV1 {
  revision: number;
  contentWidth: number;
  contentHeight: 520;
  petScale: 0.85 | 1 | 1.15 | 1.25;
  regions: Array<{
    id: "bubble" | "composer" | "menu" | "menu_trigger" | "drag_handle" | "voice_control" | "character";
    kind: "rect" | "alpha_mask" | "polygon";
    rect: { x: number; y: number; width: number; height: number };
    polygon?: Array<{ x: number; y: number }>;
    mask?: {
      width: number;
      height: number;
      bitsBase64: string;
      sha256: string;
    };
  }>;
}
```

限制：

- regions 最多 8 个；
- `contentWidth` 必须精确等于 01 合同的 `560 + extraWidth`，范围 `560..621`；
- mask 最大 `128 × 128`，bitset 解码后最大 2048 bytes；
- polygon 每个最多 64 点；
- 所有坐标在 content bounds 内；
- revision 单调增加，旧 revision 丢弃；
- Bubble/Composer/Menu/MenuTrigger/Drag 始终 rect hit；
- Level A Character 的 `rect` 是 01 §2.3 公式得到的完整 `700×860` canvas transformed bounding rect，mask 的 128×128 cell 在该 rect 上线性映射；不得拿 opaqueBounds 当第二套缩放框；
- Level A Character 使用 manifest 中当前 pose 对应的预计算 alpha mask；pose 切换与 geometry revision 同步，旧 mask revision 丢弃；
- Level B 使用 Cubism hit area 的 bounded polygon；不在主线程逐帧 `readPixels`。

### 9.2 Main process controller

- Pet visible 且 interaction mode passive 时，以 `30Hz` 使用 `screen.getCursorScreenPoint()`；
- `screen.getCursorScreenPoint()` 与 `getContentBounds()` 都按 DIP 处理；zoom factor 固定为 1 时 `contentX=cursor.x-bounds.x/contentY=cursor.y-bounds.y`，不得再乘除 `scaleFactor`；scaleFactor 只用于 display fingerprint、证据和物理像素诊断；
- 在任一有效 region 内 → `setIgnoreMouseEvents(false)`；
- 不在 region 内 → `setIgnoreMouseEvents(true, { forward: true })`；
- interactive/text_input/dragging/accessibility_focus → 强制 false，不运行透明点抖动切换；
- hidden/suspended → 停止 polling；
- 状态未改变时不得重复调用 Electron API；
- Windows/macOS 分别真实验证；Linux 不假设 forward 可用，单独 Gate。

### 9.3 命中验收

- 角色透明发丝缝隙和角色外区域下方应用可点击；
- 脸、身体、导航环、bubble、menu、composer 可点击；
- 边界快速来回移动不产生可感知点击丢失；
- 输入中鼠标离开窗口不会突然失焦；
- 屏幕缩放和 petScale 后 mask 仍对齐；
- 不注册全局键盘/鼠标 hook。

---

## 10. 焦点、拖动与位置

### 10.1 焦点

- incoming 只 `showInactive()`；
- 用户点击角色打开 composer 时调用 `requestTextInputFocus()`，main 才 `show()`/`focus()`；
- composer 关闭后不强制把焦点抢回原应用，只调用 `blur()`/`showInactive()`；
- Main route 是用户明确动作，可正常聚焦 Main；
- menu 通过鼠标打开时不要求文本焦点，但通过键盘打开时必须获得 accessibility focus。

### 10.2 拖动

- P1 同时支持角色本体直接拖动、明确 drag handle 和菜单“移动位置”；
- 角色本体必须保留 click/right-click/long-press 语义，因此不得把整个角色命中区设为原生 `app-region: drag`；Renderer 以稳定的 `screenX/screenY` 按 `8 CSS px` 位移阈值仲裁，超过阈值后切换 `interactionMode=dragging`，首帧必须补齐阈值前累计位移，再通过 typed preload `dragBy(deltaX, deltaY)` 移动窗口；
- 进入 dragging 时必须取消 long-press timer，并抑制当前 pointer 序列及随后合成的 click；是否越过阈值必须独立于 `locked` 锁存，因此锁定状态下明显拖动也不能在 pointerup 误派发 click；只有从未越过阈值的 pointerup 才可分派一次 `character.clicked`；pointercancel/lostpointercapture/窗口失焦必须退出 dragging；
- drag handle 复用同一 typed drag controller；renderer 使用 animation-frame 合帧和单请求 in-flight 队列，pointerup 后必须先 flush 最后一段位移再退出 dragging。可使用平台原生 drag 作为经真机验证的优化，但不能因此绕过锁定、点击抑制和最终位置持久化；
- `locked=true` 时隐藏 drag handle 并禁用 move；
- dragging 期间主进程只调用 `BrowserWindow.setPosition`，不得逐帧写偏好 JSON或广播完整 window state；退出 dragging 后立即提交一次最终位置。非手势 move 仍 debounce `250ms` 保存；释放后稳定位置与首次最终位置误差必须 `≤2 DIP`，不得回弹。

### 10.3 Device-local persistence

```ts
interface DevicePetPreferencesV1 {
  version: 1;
  petModeEnabled: boolean;
  displayId: string;
  displayFingerprint: string;
  normalizedX: number;
  normalizedY: number;
  scaleFactor: number;
  petScale: 0.85 | 1 | 1.15 | 1.25;
  locked: boolean;
  alwaysOnTop: boolean;
  privacyMode: boolean;
}
```

- `displayFingerprint` 使用 workArea 宽高、scaleFactor 和相对布局的非敏感 hash；
- displayId 找不到时按 fingerprint/最大重叠/主屏顺序回退；
- normalized 坐标精确定义为 window content 左上角在可放置区间内的比例：`nx=(x-workArea.x)/max(1,workArea.width-window.width)`、`ny=(y-workArea.y)/max(1,workArea.height-window.height)`，保存/恢复都 clamp 到 `0..1`，恢复时使用同一逆公式；
- 显示器变化后以当前 pose transformed `opaqueBounds` 与目标 workArea 的交集面积比校验，至少 `60%` 角色可见；若当前 scale 无法满足，先降到 `0.85`，仍无法满足则置主屏右下安全区并提供“回到屏幕”，不得无限移动循环；
- “回到屏幕”移动到当前主屏右下安全区；
- 文件写入 Electron userData，使用 temp+rename 原子替换；损坏时回默认，不崩溃；
- 不写账号数据库，不跨设备同步。
- 新安装/无文件时固定默认：`petModeEnabled=false`、主屏右下安全区、`petScale=1`、`locked=false`、`alwaysOnTop=true`、`privacyMode=false`；只有用户明确启用桌宠模式才写 true 并创建 Pet；
- “暂时隐藏”只存在 app process 内存，不写本文件；下次启动仍按 `petModeEnabled` 决定，避免暂时隐藏永久找不到入口；
- `privacyMode` 默认 `false`，由 Main process 持有并通过窄 IPC 设置；Pet/Main renderer 只接收当前 boolean，不接收其他窗口标题、截屏、进程或应用正文；
- `privacyMode=true` 时将当前及尚未展示的 proactive bubble 投影为“伴星有一条消息，内容已隐藏”，并停止该 delivery 的自动 TTS；用户主动打开 composer、发送消息或打开完整对话仍按正常可见规则渲染；
- 切回 `false` 不得自动恢复或补播隐私期间已抑制的 proactive TTS；窗口间同步只广播 mode revision/boolean，不广播被隐藏正文。

---

## 11. 生命周期与资源释放

| 事件 | Pet Window | SSE | Mic | TTS/Audio | Animation |
| --- | --- | --- | --- | --- | --- |
| Main hidden | 保持 | 保持必要连接 | 仅用户已点按开始且尚未再次点按结束时 | 可继续当前用户回合 | 保持 |
| Pet temporary hidden | hide | 可断开 | stop | stop | stop |
| global off | destroy | disconnect | stop | stop | destroy |
| system sleep/lock | hide | disconnect | stop | stop | stop |
| system resume | hidden bootstrap 后恢复 | reconnect from cursor | idle | 不自动重播 | resume idle |
| renderer crash | reload once | cursor 恢复 | OS 自动释放并显式清理 | 不重播已完成 segment | recreate/fallback |
| app quit | destroy | disconnect | stop | stop | destroy |

Renderer reload 后：

- 先 GET authoritative conversation/run snapshot；
- dialogue 再 GET 最新 100 条 durable messages 并按 id/seq reconcile；Pet inbox 不在后台读取正文；
- 再从 durable cursor 连接 SSE；
- snapshot 先把 SSE cursor 对齐 durable head，旧 `voice.segment.ready` 不重新进入 queue；当前进程只保留最多 20 个已处理 segmentId 的内存去重集，不持久化 `playedAt`；
- 不恢复未发送 draft；
- 不恢复 listening；
- active run 可继续显示文字和后续 delta。

---

## 12. 必测不变量

- [ ] 七个状态域可以独立变化，Character 只从投影读取；
- [ ] composer 与 streaming 可同时存在；
- [ ] Voice 无 thinking 状态，Turn 无 speaking 状态；
- [ ] voice operationEpoch 可拒绝迟到 permission/track/ASR/playback，ASR success 携带并绑定 Companion voiceArtifactId；
- [ ] 新 generation 后旧 delta/audio/cue 均不可见；
- [ ] 旧 generation run event 被 consume 并推进 cursor但不渲染；conversation-scoped action event 仍更新 proposal且不回退 Turn；
- [ ] Pet/Main 双开只播放一份音频；
- [ ] origin surface 崩溃后另一 surface 可接管后续 segment，但不重播旧 segment；
- [ ] workspace/account epoch fence 拒绝迟到事件；
- [ ] dialogue/inbox 使用独立 SSE cursor，active turn 不会吞掉 proactive delivery；
- [ ] 非 leader surface 发起 barge-in 时，真实 leader 在开麦前停止；
- [ ] Main process 不读取 Web auth cookie；
- [ ] Pet route 不挂 AppShell/旧 Companion；
- [ ] renderer 无直接 click-through/window/navigation 原语；
- [ ] alpha mask/polygon 命中与 DPI/petScale 对齐；
- [ ] incoming 不抢焦点，composer 可正确获得焦点；
- [ ] privacy mode 只隐藏 proactive 正文/自动 TTS，不采集其他应用状态、不隐藏用户主动会话、关闭后不补播；
- [ ] temporary hidden/system sleep/global off 都释放麦克风和音频；
- [ ] 多屏拔插后角色仍可见并可回到主屏。
