# 决策记录 04-6：语音替代输入与 reduced-motion 状态（§13.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 04（W3）任务 04-6
> 日期：2026-08-08
> 来源：`04-w3-voice-artifact-assessment.md` 任务 04-6（§13.4 A11y 硬门禁）+ 冻结记录 01-4 §13.4/§13.5、01-2 §6/§6.2、§7.2 模态 payload
> 约束级别：**麦克风拒绝后无操作死路**；**键盘/读屏可完成同等主路径**；无倒计时评分、无操作速度评分；reduced-motion 完整支持；UI 不把尚未支持的组合伪装成可验证。

---

## 1. 交付物

| 文件 | 职责 |
| --- | --- |
| `apps/web/components/learning-companion/VoiceInputPanel.tsx` | 麦克风状态机（idle/requesting/recording/transcribing/awaiting_confirmation/confirmed）、录播控制（开始/暂停/重听/确认/重录/切 text）、权限拒绝/浏览器不支持/语音不可用时的 text fallback 与 structured-proof 入口、无倒计时无速度评分 |
| `apps/web/components/learning-companion/TextOrMixedInput.tsx` | text_or_mixed canonical fallback：原始文本 + 确定性 hash 语义；手工编辑 transcript 标记为 text_or_mixed（supersedes 保留来源）；未编辑转写禁止冒充文字提交 |
| `apps/web/components/learning-companion/ModalSwitcher.tsx` | voice ↔ text_or_mixed ↔ structured-proof-v1 模态切换（radiogroup 语义）；不可用组合不渲染为可选项，只给非交互说明 |
| `apps/web/lib/learning-companion/voice-api.ts` | Voice API 客户端收口：transcribe/confirm/reRecord/switchModality（`POST /api/learning-sessions/voice/:action`，服务端路由后续任务接）；每写请求带 base revision / public scene hash / user action nonce / idempotency key；客户端镜像校验 + hash 预览（服务端为准） |
| 本决策记录 | 冻结语义、A11y 硬门禁映射、组件约束 |

## 2. 冻结语义与实现映射

### 2.1 模态矩阵（§13.4）

| Key Point | 零打字路径 | canonical fallback | eligibility 合格 |
| --- | --- | --- | --- |
| 支持 voice 的 Key Point | `voice`（语音逐字 + 确认） | `text_or_mixed`（始终可用） | 另加 `structured-proof-v1` |
| 不支持 voice 的 Key Point | —（不存在语音路径） | `text_or_mixed`（始终可用） | 另加 `structured-proof-v1` |

- `text_or_mixed` 是**所有** Key Point 的 canonical fallback（01-4 §13.4）；
- `structured-proof-v1` 仅对 profile-eligible 目标开放，且只经**跨模态 Gold** 获得零语音零打字资格；
- `ModalSwitcher` 按 `structuredProofEligible` / `voiceAvailable` 过滤可选项：不合格目标**不渲染**结构式证明选项（不可见的 silent mastery 路线被切断），不可用项只以文字说明原因 —— 满足"UI 不把尚未支持的组合伪装成可验证"。

### 2.2 麦克风拒绝后无操作死路（§13.4 硬门禁）

`VoiceInputPanel` 保证任意时刻至少存在一条通往 canonical 提交的路径：

| 情形 | 可用路径 |
| --- | --- |
| 权限正常、ASR 成功 | 语音 → 确认（voice locked） |
| 权限被拒（`NotAllowedError`） | 重新申请麦克风 **或** 内嵌 `TextOrMixedInput` 文字提交（必填回调 `onSubmitText`） |
| 浏览器不支持录音 | `TextOrMixedInput` 文字提交 |
| 设备错误 | 重试 / `TextOrMixedInput` 文字提交 |
| 语音整体不可用（ASR provider policy 不满足 workspace policy，§13.2） | fail closed + `TextOrMixedInput` 文字提交（eligibility 合格时另有 `structured-proof-v1`） |
| ASR 低置信 / 转写失败 | 可无损重录（重新录音）**或** `TextOrMixedInput` 文字提交 |
| 转写被手工编辑 | 强制走 `text_or_mixed`（拒绝以纯 voice 确认，防伪装） |

- `onSubmitText` 在 `VoiceInputPanel` 中为**必填** props —— 保证权限拒绝后文字路径始终可落地；
- 无任何"单一失败即退出"的分支；所有错误都有重试或模态切换出口。

### 2.3 无倒计时、无速度评分（§13.4 / §6.5）

- 组件不渲染任何计时器；录音时长不展示、不进评分；
- 口音、流利度、语速、停顿、音量不进理解判定（服务端 `assessTranscriptionQuality` 只按关键术语置信度 fail closed，见 04-1）；
- UI 文案显式声明"无倒计时 · 不限速度"，防止用户误以为存在速度评分。

### 2.4 键盘 / 读屏同等主路径（§13.4）

- 全部操作为原生 `<button>` / `<textarea>`，可 Tab 聚焦、Enter/Space 触发；
- `ModalSwitcher` 用 `role="radiogroup"` + `role="radio"` + `aria-checked` 提供当前模态语义；
- 顶部隐藏 `role="status"` + `aria-live="polite"` 只播报必要阶段变化（录音中/转写中/确认成功/错误），不做无关播报；
- 错误用 `role="alert"`，成功用 `role="status"`；触控目标统一 ≥ 44×44 CSS px；
- 确认 dialog 语义由宿主页面的 `ConfirmDialog` 负责（本组件不在组件内再造模态层）。

### 2.5 reduced-motion 完整支持（§13.4）

- 动画仅用于状态指示：录音红点呼吸、转写旋转图标 —— 均附加 `motion-reduce:animate-none`（或 `motion-reduce:transition-none`）显式静态化；
- 全局 `prefers-reduced-motion: reduce`（`app/styles/motion.css`）兜底禁用全部 animation/transition；
- 信息传达不依赖动画：所有状态同时有文字与图标，动画禁用后语义不变。

### 2.6 voice-api.ts 收口语义（对齐 voice-service）

- 端点：`POST /api/learning-sessions/voice/:action`（transcribe / confirm / reRecord / switchModality），服务端路由由后续任务接管；
- 每个写请求注入四义务：`baseRevision`（CAS）、`publicSceneHash`（stale 判定）、`userActionNonce`（8-128 字符）、`idempotencyKey`（幂等兜底）—— `createVoiceObligations` 生成，`validateVoiceObligations` 客户端 fail-fast 镜像校验（服务端仍独立复核，fail closed）；
- `audioRef`/`audioHash` 由上游 transient 上传管线提供（04-1，raw audio 短 TTL / 加密 / 不进长期备份）；组件只传 Blob 给注入回调，不直接上传音频；
- 内容 hash（text_or_mixed / voice transcript）以服务端计算为准；客户端的 `computeTextContentHashPreview` / `computeVoiceTranscriptHashPreview` 仅作 UI 展示（安全上下文不可用时返回 null 并降级为文字说明）；
- 复用 `lib/api.ts` 的 `API_URL` / `getToken` / `getCsrfToken` / `ApiError`，不新增第二套鉴权。

### 2.7 组件约束（任务 04-6 要求）

- 三个组件全部为**纯 UI + props 回调**：服务端调用（transcribe/confirm/reRecord/switchModality/text 提交/结构式证明）一律经注入回调，组件内不出现 fetch；
- `VoiceInputPanel` 内的浏览器录音 API（`getUserMedia` / `MediaRecorder`）为本地能力探测与录音采集，不构成服务端调用；
- 避免运行时不确定行为：录音/转写用 `ref` 管理（`discardRef` 防放弃录音误触发转写、`aliveRef` 防卸载后 setState），卸载时停止轨道、撤销对象 URL、停止回放；
- 无 `styled-components`；样式跟随项目 tailwind token 体系（颜色/圆角/阴影来自 `tokens.css` 映射），不新增 CSS 文件。

## 3. 验证

- `cd apps/web && npx tsc --noEmit`（apps/web tsconfig `include: ["**/*.ts", "**/*.tsx"]` 自动覆盖 `components/learning-companion/` 与 `lib/learning-companion/`）；
- 类型从 `@ailearn/shared`（`packages/shared/src/index.ts` 已 `export *` voice 契约）导入 `VoicePayload` 等，与 04-1/04-2 契约单一来源一致；
- 组件级行为断言（键盘/读屏/无死路）依赖宿主页面集成与 Playwright 阶段验证（不在本任务范围）。

## 4. 待后续任务接入

- 服务端路由 `/api/learning-sessions/voice/:action` 由后续任务按 voice-service 语义实现（端点路径与 DTO 已冻结于本记录 + voice-api.ts）；
- 宿主页面将 `VoiceInputPanel` 的注入回调接到 `voiceApi.*` 与 04-1 transient 上传管线；
- `structured-proof-v1` 目标页面接线 `onSwitchToStructuredProof`。
