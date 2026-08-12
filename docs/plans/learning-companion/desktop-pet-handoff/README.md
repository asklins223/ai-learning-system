# 桌宠式 AI 学习伴星实施交接包

> 状态：P1 Surface V2.3 已实施；**本轮实现已交付，但 macOS 真实 Electron 启动/GPU/OS DPI、麦克风采集、TTS 播放、ASR transcript 真机端到端验证与 24h soak、Windows/Linux 真机、签名安装/升级/回滚仍为发布门禁待办（P6 phase-report deferredScope 2026-08-11 13:35；P3 11:06 明确“真机端到端人工验证未执行”），不能以本地 smoke 代替**
>
> 版本：Handoff Contract v1.3
>
> 日期：2026-08-11
>
> 工程基线：`v1.0` / `c73f9eabfd4c80e157dfca56db95eab655372dd7` + 当前未提交工作区
>
> 授权状态：**以 §4 的 Owner 记录为唯一依据。当前角色表面继续按 P1 `Surface Prototype` 标识；真实 Electron 的输入采集、TTS 播放和 ASR transcript 回填已在 macOS/Docker 环境验证，但跨平台、24h soak 和发布签名门禁尚未全部通过，不得提前标记 P3/P6 完成。**

---

## 1. 这个实施包解决什么问题

总方案 [`../13-desktop-pet-ai-learning-companion-reconstruction.md`](../13-desktop-pet-ai-learning-companion-reconstruction.md) 已经锁定正确方向，但它主要是产品架构与验收方案。陌生实施 Agent 仍可能在视觉、状态所有权、API payload、数据库、主动消息、人设、provider 接线和阶段范围上自行脑补。

本目录把这些缺口收敛为可执行合同。实施 Agent 不得只读总方案，也不得只凭 README 开始编码。

### 1.1 权威顺序

出现冲突时按以下优先级处理：

1. Owner 在本文件 §4 中明确填写的批准记录；
2. 本实施包中带有 `MUST / MUST NOT / Gate` 的合同；
3. 总方案 13 的产品不变量与总体 Definition of Done；
4. 方案 12 中仍有效的 Learning Session、独立评估、canonical write、隐私和发布证据约束；
5. 当前代码和数据库中的既有安全不变量；
6. 参考项目只能提供技术证据，不能覆盖本项目合同。

任何实施 Agent 都无权自行降低更高优先级约束。发现不可同时满足的条目时，必须停止当前阶段并提交冲突证据，不能选择自己偏好的解释。

### 1.2 必须阅读的文件

按顺序完整阅读：

1. [`../13-desktop-pet-ai-learning-companion-reconstruction.md`](../13-desktop-pet-ai-learning-companion-reconstruction.md)
2. [`01-product-ux-character-contract.md`](./01-product-ux-character-contract.md)
3. [`02-runtime-window-state-contract.md`](./02-runtime-window-state-contract.md)
4. [`03-conversation-api-data-proactive-contract.md`](./03-conversation-api-data-proactive-contract.md)
5. [`04-phase-runbooks-and-validation.md`](./04-phase-runbooks-and-validation.md)

同时只按任务需要读取：

- [`../12-companion-experience-reconstruction.md`](../12-companion-experience-reconstruction.md) 中继续有效的 canonical/assessment/隐私约束；
- [`../../../../reference-projects/learning-companion/README.md`](../../../../reference-projects/learning-companion/README.md)；
- [`../../../../reference-projects/learning-companion/SOURCE_LOCK.md`](../../../../reference-projects/learning-companion/SOURCE_LOCK.md)。

本地参考源码位于 `reference-projects/learning-companion/repos/`，被父仓库 `.gitignore` 排除。它们只保证在当前工作区可见；新机器或干净 checkout 必须按 `SOURCE_LOCK.md` 的 origin/commit 重新浅克隆。

---

## 2. 交付层级已经冻结

“有文件”“有窗口”“能点开输入框”都不是可用产品。

| 层级 | 包含阶段 | 对用户意味着什么 | 能否称为可用 AI 桌宠 |
| --- | --- | --- | --- |
| Technical Spike | P0 | 证明当前 Electron 壳能做透明、穿透、双窗口和登录 | 否 |
| Surface Prototype | P0–P1 | 真透明角色、气泡、composer、菜单和占位完整对话入口 | 否 |
| **Usable Desktop Pet V1** | **P0–P3** | 真实文字对话、完整历史、点按切换录音、ASR/TTS 和打断 | **是，这是 Owner 当前核心预期的最低交付** |
| Expressive Character | P0–P4 | 同一角色的 Live2D、Idle、眼神、情绪和口型 | 是，且具备连续生命感 |
| AI Learning Companion | P0–P5 | 可确认地启动/继续真实学习会话且不污染 canonical truth | 是，且真正具备学习协作能力 |
| Release Candidate | P0–P6 | 流式语音、平台硬化、24h soak、升级和回滚 | 可对外发布候选 |

因此：

- P1 完成时必须标记为 `surface_prototype`，不得向 Owner 汇报“桌宠已可用”；
- P2 完成时可称为“文字桌宠可用”，不得声称语音已完成；
- 只有 P3 Gate 通过后，才可称为“Usable Desktop Pet V1”；
- P4 的 Mao PRO Live2D 正式运行时资产与 Owner 许可 Gate 已通过；P4 的性能、跨环境与发布验收仍未全部通过，因此 Sprite 仍保留为强制 fallback；
- P5 未完成前，不得称为“完整 AI 学习伴星”。

---

## 3. 实施任务的切分规则

### 3.1 禁止一次性执行 P0–P6

每个实施任务最多包含一个阶段。唯一例外是 Owner 明确批准的 P0 技术 spike 可以和纯文档化的 P0 结论同一任务完成。

原因不是形式流程，而是每个阶段都可能改变下一阶段的真实约束：

- P0 会决定透明窗口、会话共享、Electron 版本和 hit-test 是否可行；
- P1 需要 Owner 审核视觉证据；
- P2 会冻结 API、数据和跨窗口运行时；
- P3 会暴露真实声卡、权限、回声和 provider 限制；
- P4 依赖外部角色资产与许可；
- P5 才允许接 canonical Learning Session；
- P6 依赖前五阶段稳定产物。

### 3.2 每阶段的开始条件

实施 Agent 开始某阶段前必须同时确认：

1. §4 的 Owner 批准记录包含该阶段；
2. 上一阶段 Gate 有可读取证据；
3. 当前 Git 工作区已审计，用户已有变更不会被覆盖；
4. 对应合同不存在 `BLOCKED` Gate；
5. 所需依赖、模型、角色资产或凭据已由 Owner/环境明确提供；
6. Agent 已把该阶段加入工作计划，并明确不会顺手进入下一阶段。

### 3.3 每阶段的停止条件

任一情况出现即停止该阶段，不以 mock 或截图伪装通过：

- 角色资产不满足该阶段 manifest；
- 透明穿透、焦点、同源登录或 macOS 真机无法验证；
- 需要新增未批准依赖或改变许可证策略；
- API/DB 合同需要改变且实施包未更新；
- Docker 服务、真实 provider 或 Electron 运行环境不可用；
- `ailearn-dev-web-1`、API、Worker 或 Electron main 有未解释的 build/runtime error；
- 需要复制 GPL 项目的实现细节；
- 需要越过 Learning Session 公开 API 写 canonical truth。

---

## 4. Owner 批准记录

本节是唯一实施授权记录。实施 Agent 不得代替 Owner 修改 `approvalStatus`、`approvedPhases` 或资产/许可决定。

```yaml
approvalStatus: approved
approvedAt: "2026-08-10T14:40:32Z"
approvedBy: "user (Owner)"
approvedPhases: [P1, P2, P3]
approvalNote: "Owner 于 2026-08-10 确认视觉审批（G01-G12）与 Level A 资产权属；同日经交互确认批准 P2（真实文字对话）开工。2026-08-11 交互确认批准 P3（半双工语音）开工，并批准 API image 增加 Alpine ffmpeg/ffprobe；同日进一步冻结语音入口为点按开始、再次点按结束，不使用长按。2026-08-11 Owner 明确批准使用当前 Mao PRO Live2D Free Material 作为 P4 正式运行时资产；商业使用无需另行许可，再分发仍遵守原始条款。"

decisions:
  productShape: proposed-electron-pet-plus-browser-fallback
  windowTopology: proposed-one-main-plus-one-pet
  usableV1Scope: proposed-p0-through-p3
  firstReleasePlatform: proposed-macos
  electronP0Baseline: frozen-current-33.4.1-no-upgrade-without-separate-approval
  characterLevelAAsset: approved-owner-provided-sprite-v1-2026-08-10
  characterLevelBAsset: approved-mao-pro-live2d-free-material-owner-2026-08-11
  live2dDistribution: approved-live2d-free-material-owner-2026-08-11
  soullinkAdoption: deferred-until-p4-spike
  alwaysOnTopDefault: proposed-enabled-user-controllable
  characterBodyInteraction: approved-click-and-direct-drag-with-gesture-arbitration
  voiceMode: approved-tap-toggle-half-duplex-owner-2026-08-11
  audioDurationProbe: approved-owner-2026-08-11-alpine-ffmpeg-6.1.1
  streamingVoiceTransport: approved-owner-2026-08-12-local-sensevoice-plus-siliconflow-fallback-plus-edge-tts-http-stream
  proactivePresenceDefault: proposed-quiet
  privacyModeDefault: proposed-off-device-local-manual-only
  conversationScope: proposed-user-private-in-workspace
  rawAudioRetention: proposed-delete-after-transcription-with-hard-one-hour-cap
  referenceCodePolicy: approved-clean-room-for-gpl
```

### 4.1 批准语义

- `pending`：任何产品实施均不得开始；允许继续评审和补充文档。
- `approved`：只允许 `approvedPhases` 中列出的阶段。
- `changes_requested`：不得开始新阶段；已开始阶段只允许回滚或保存证据。
- 一个阶段通过不自动批准下一阶段。
- “继续”“继续实施”等指令只有在本节已批准且上下文明确指向某阶段时，才视为该阶段的继续授权。

### 4.2 历史建议的首次批准

建议 Owner 首次只批准：

```yaml
approvalStatus: approved
approvedPhases: [P0]
```

该建议已经执行到“P1 Gate 通过、P2 获批”。P2 真实文字纵切通过后才可批准 P3；批准顺序不改变“Usable Desktop Pet V1 必须完成 P0–P3”的定义。

### 4.3 Owner 交互修订（2026-08-11）

Owner 明确要求：**角色本体必须同时支持点击和直接拖动。** 此决定取代 01、02 和总方案 13 中“角色身体不是 P1 拖动区 / 只能使用独立 drag handle”的旧限制，但不改变当前批准阶段和能力边界。

- 主键按下后先进入待判定手势；移动未超过 `8 CSS px` 并松开时按一次角色点击处理；
- 移动超过 `8 CSS px` 且位置未锁定时进入 `dragging`，取消 long-press，并抑制本次及紧随其后的 click/menu intent；
- 右键仍直接打开根菜单；触摸或笔保持 `500ms` 且位移不超过 `8 CSS px` 时打开根菜单；
- `locked=true` 时角色仍可短按、右键和长按，但不得移动窗口；若本次手势位移已超过 `8 CSS px`，即使因锁定未进入 dragging，也必须抑制 pointerup 的 click，避免“拖不动却误开输入框”；
- 独立 drag handle 保留为可发现、可聚焦的辅助入口，不再是唯一拖动入口；
- 直接拖动必须走 typed preload `dragBy`，使用稳定 screen 坐标、animation-frame 合帧和结束后单次持久化，不得引入全局鼠标 hook。

### 4.4 角色交互表面 V2 / V2.1 / V2.3 实施检查点（2026-08-11）

本节记录实施结果，不改变 §4 的 Owner 阶段授权：

- 角色本体、微型气泡、composer、确认卡、根菜单/学习菜单/更多菜单和浏览器 compact fallback 已按统一视觉系统重构；V2.1 移除所有浮层灰黑投影与 backdrop 暗底；
- 角色本体短按、直接拖动、右键菜单、触控/笔长按、辅助 drag handle、锁定分支和拖后 click 抑制已落地；
- hit geometry 改为从实际 DOM rect 经 `ResizeObserver` 注册，不再按旧卡片高度写死；
- V2.3 撤销活动语音的大气泡、图表波形和“声音转文字”流程卡；外置麦克风固定在角色侧，采用点按开始/再次点按结束，旁侧 `178×58` 无阴影流体语音岛以同一彩色核心从 listening 声纹原地收束为 finalizing/transcribing 识别脉冲，成功识别后回填可编辑 composer；实现状态见 P3/P5 phase-report——**真实 Electron 麦克风采集/TTS 播放/ASR 端到端为发布门禁待办（P3：2026-08-11 11:06 明确“真机端到端人工验证未执行”；P5 的 14/14 指 worker handler 单测，非真机验证）**；
- 活动语音期间 quick toolbar 与辅助 drag handle 自动收起，避免 Electron hover 叠层；角色本体仍可点击、可直接拖动；
- 菜单 focus 与 `aria-checked` 选中线改为向内绘制，二级菜单首尾项不再被 overflow 裁切；
- 拖动改为 screen 坐标、首帧阈值位移补齐、animation-frame 合帧/单请求队列；主进程拖动期间不再逐帧写偏好 JSON 或广播，释放后才提交最终位置；
- 最新真实 Electron 回归与 V2.3 截图见 [`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/)；V2/V2.1 证据继续保留为历史差异基线；
- 仓库级 `make verify` 的 PostgreSQL integration lifecycle JSON 参数 Gate、deploy-readiness 和全量包测试已通过（使用本地 Compose 数据库变量）；coverage 仍按既有设计为 report-only，低于阈值的关键组由 release-check 继续拦截；
- P4 当前运行时已接入 Owner 指定的 Mao PRO：API 通过 `COMPANION_LIVE2D_V1_ENABLED` 独立授予能力，Electron 与 Browser fallback 都读取该 bootstrap 能力；加载失败、WebGL context loss、`reducedMotion` 和 `animationOff` 仍回退 Sprite。Owner 对该正式运行时资产的批准已记录在本节；`redistributionAllowed=false` 仍不解读为公开再分发许可；
- 当前默认 Pet route 的阶段标签随 capability bootstrap 显示 `P3 · Voice`；无真实能力或 flag 关闭时才回退 `P1 · Fixture`。本轮不把 macOS/Docker 证据冒充成 Windows/Linux、24h soak 或发布升级回滚，因此不能据此声明 P3/P5/P6 Gate 已完成。

### 4.5 P6 streaming voice 解除 blocked（2026-08-12）

Owner 于 2026-08-12 交互确认**解除 streaming voice 的 blocked 状态**，范围与依据：

- 授权范围：**只接线 streaming voice 本体**——AudioWorklet 双路径录音、ASR 三路由接入运行时、edge-tts 客户端流式播放、能力 flag 接线；P6 平台硬化项（Windows/Linux 真机、24h soak、签名升级回滚）维持 deferredScope；
- provider 与 wire 语义按总方案 13 §14 P6 输入 Gate 冻结：客户端本地 SenseVoice（sherpa-onnx）+ SiliconFlow 文件转写降级 + edge-tts HTTP chunked 音频流（非 WSS-only），不再要求 WSS wire-contract addendum；
- **运行形态偏差标注（2026-08-12 Owner 确认）**：本地 SenseVoice 采用 **Electron utilityProcess + sherpa-onnx-node native**（官方 npm 包、Apache-2.0、预编译 darwin/linux/win），替代冻结文本中的 "sherpa-onnx WASM"——官方无 WASM npm 包（需源码自建或依赖不可审计第三方 CDN），且 §13 自身 Gate 措辞（"native runtime 可加载"、"utility process 峰值内存增量 ≤ 700MB"）指向 native utility process；renderer 经 AudioWorklet 采 PCM → IPC 送 utility process 识别；
- 模型资产：sherpa-onnx 官方 SenseVoice onnx（int8）下载到开发机，**不入仓库/不打包**，由性能探测 Gate（逻辑核心 ≥4 / 总内存 ≥8GB / 冷启动 ≤3s / warm RTF ≤0.5 / 峰值增量 ≤700MB）控制是否启用 `local_streaming`；
- `COMPANION_STREAMING_VOICE_V1_ENABLED` 默认 fail-closed；`local_streaming` 未通过探测时自动走 `siliconflow_file` / `text_only` 降级，P3 文件式点按录音保留为无本地能力时的降级路径；
- 本授权只覆盖 streaming voice 接线，不改变 P0–P5 既有阶段边界；接线完成仍需真实 Electron/真机证据才能声称 P6 完成。

---

## 5. 实施 Agent 开工协议

实施 Agent 必须先输出以下审计结果，随后才可修改代码：

```text
当前批准阶段：P?
上一阶段证据：存在 / 不适用 / 缺失
当前 HEAD：<commit>
脏工作区重叠风险：<files or none>
本阶段外部 Gate：<list>
本阶段预计修改文件：<explicit list>
本阶段禁止修改：<explicit list>
验证命令：<commands>
真实 Electron/Docker 证据路径：<path>
```

实施中必须：

- 先最小纵切，后扩展状态；
- 每次只维护一个 `in_progress` 步骤；
- 至少每 60 秒提供一次可验证进展；
- 新增依赖前记录用途、版本、许可证、打包影响和替代方案；
- 所有迁移使用当前仓库下一个真实编号，不使用本文件中的占位编号；
- 每个共享合同使用 `z.object(...).strict()` 与 `z.infer`，保持当前 `@ailearn/shared` 风格；
- 所有 workspace/user 数据访问走现有 transaction-local RLS context；
- 真实失败必须暴露为阶段 Gate 失败，不把 mock 成功写成真实成功。

---

## 6. 推荐交接提示词

Owner 批准某阶段后，可将以下内容连同对应阶段名称交给新的实施 Agent：

```text
完整阅读 docs/plans/learning-companion/desktop-pet-handoff/README.md 及其规定的全部权威文件。
只实施 Owner 批准记录中的 <PHASE>，不要开始下一阶段。
先审计当前脏工作区和真实工程结构，再提交阶段计划。
严格遵守 UX、状态机、API/数据、主动消息、许可证和证据合同。
必须在真实 Electron 和当前 Docker 栈验证；检查 ailearn-dev-web-1、API、Worker、Renderer 与 Electron main 日志。
如果外部资产、许可、凭据或上一阶段证据缺失，停止并报告 Gate，不得用 mock 冒充完成。
```

---

## 7. 本实施包自身的完成标准

- [x] 总方案引用本实施包并消除 P1“可用”歧义；
- [x] 产品/UX 合同包含布局、视觉 token、所有关键状态、动作时序和视觉证据；
- [x] 角色 manifest 记录当前输入 hash、不可用事实和 Level A/B Gate；
- [x] runtime 合同只有一个状态真相来源，character presentation 为派生投影；
- [x] Electron 生命周期、hit-test、焦点、位置与跨窗口 leader 有确定协议；
- [x] API 请求/响应/错误和 SSE payload 是完整 discriminated union；
- [x] 对话、消息、run、event、voice、proactive delivery 的表和 RLS 约束明确；
- [x] provider/worker/queue 接线复用现有能力治理；
- [x] 人设、气泡切句和主动消息规则明确；
- [x] P0–P6 每阶段都有输入、文件范围、任务、测试、证据和停止条件；
- [x] 未决外部事项全部标记为 Gate，不留给实施 Agent 自行决定；
- [x] 文档间链接、术语、阶段边界和完成声明一致。

---

## 8. P6 streaming voice 接线状态（2026-08-12 更新）

Owner 于 2026-08-12 解除 streaming voice blocked（见 §4.5）。原"六文件 dead code"
审计结论已更新——**基础件已全部接入生产调用链**，接线方式如下：

| 文件 | 原状态 | 现状 |
| --- | --- | --- |
| `voice/companion-asr-router.ts` | dead | **已接线**：`companion-streaming-asr-runtime` 调 `decideAsrRoute`/`staticCompatPass`（三路由决策） |
| `voice/companion-asr-probe-runner.ts` | dead | 纯逻辑基准仍无生产调用（worker 内以 `probeRecognizeElapsed` 等价实现跑真实探测） |
| `voice/companion-sherpa-sensevoice.ts` | dead | **已接线**：Electron utility process（`desktop/src/voice/asr-utility-worker.ts`）以 sherpa-onnx-node `OfflineRecognizer` 实现同一语义；renderer 经 `companion-asr-client` 访问 |
| `voice/companion-dual-capture.ts` | dead | 纯状态机无生产调用；运行时接线在 `companion-dual-capture-runtime`（AudioWorklet PCM + 下采样） |
| `voice/companion-stream-player.ts` | dead | **已接线**：`companion-stream-playback-runtime` 以 `StreamPlaybackController` 驱动 `/voice/tts/stream` 流式播放 |
| `voice/companion-audio-buffer.ts` | dead | **已接线**：`companion-dual-capture-runtime` 用 `BoundedAudioBuffer` 累积 48k PCM |

新增接线层：
- `desktop/src/voice/asr-utility-worker.ts` + `asr-manager.ts`：utility process 本地
  SenseVoice（sherpa-onnx-node，Apache-2.0，Electron ABI 直接兼容）；
- `desktop/src/ipc/register-asr-ipc.ts` + `pet-preload` `window.asrAPI`：typed IPC
  （sender 校验 + payload schema，模型路径仅 main 受信配置注入）；
- `web/.../voice/companion-asr-client.ts` / `companion-streaming-asr-runtime.ts` /
  `companion-dual-capture-runtime.ts` / `companion-stream-playback-runtime.ts` /
  `companion-audio-worklet.ts` / `companion-transcribe-api.ts`；
- `PetRuntimeProvider`：`streamingVoiceEnabled`（bootstrap capability）分支——双路径
  录音、三路由转写、edge-tts 流式播放、barge-in fence。

能力开关 `COMPANION_STREAMING_VOICE_V1_ENABLED` 默认 fail-closed；`local_streaming`
由真实性能探测（冷启动 ≤3s / RTF ≤0.5 / 内存增量 ≤700MB）控制，未通过自动降级
`siliconflow_file` / `text_only`，P3 文件式点按录音保留为降级路径。

**未接线/未验证（不得冒充完成）**：真实 Electron 麦克风采集 + AudioWorklet 双路径 +
edge-tts 流式播放的真机端到端（本环境 macOS 容器 sandbox 受限，仅以
`--no-sandbox` 验证 utility process 识别链路）；Windows/Linux 真机、24h soak、
签名升级回滚仍为 P6 deferredScope。

---

## 9. Dialogue Router 三态（2026-08-12 实现记录）

方案 13 §7.2 / 03 §9.4 的 Dialogue Router 三态已在 worker 侧实现：

- **casual_chat / learning_question**：lexeme 预检不命中，或 classifier 判 `none` → 走 persona 文字回复；
  `learning_question` 由 grounded-tutor 分支承接（有 grant 时）。
- **learning_action**：lexeme 命中 + classifier `confidence>=0.90` + intent available → worker 在 run final
  事务内同事务落 proposal + `action.proposed` 事件 + assistant message `action_ref`（kind='action'），
  与 API 菜单路径同构（§8.3 步骤 5）。支持 `resume_current` / `start_short`；
  `open_review` / `open_current_card` / `open_star_map` 为纯导航回落文字。

新增/修改：
- `packages/shared`：`companionActionIntentV1Schema`、`companionActionClassifierInputV1Schema`、
  `COMPANION_ACTION_LEXEMES`、`COMPANION_ACTION_ROUTER_OPTIONS`（§9.4 冻结）。
- `workers/ai-worker/src/handlers/companion-dialogue-router.ts`：`shouldRunActionClassifier` /
  `buildActionClassifierInput` / `classifyDialogueAction` / `resolveAvailableIntentsInWorker` /
  `constructActionProposalInWorker` / `persistRouterDecision` / `readStoredRouterIntent`。
- `workers/ai-worker/src/handlers/companion-dialogue.ts`：classifier 在 persona 之前调用；final 事务
  proposal 落库；retry 复用冻结 decision（不重新分类）；seq 无空洞（proposal 未插入时归还预留 seq）。

Gate 状态：worker 单测 13/13（router）+ 全量 1058/1058；shared 403/403。**真实 provider E2E
（classifier 实际调用 + proposal 确认闭环）仍需 Docker/真机验证，本实现不构成 P5 Gate 通过证据**。
