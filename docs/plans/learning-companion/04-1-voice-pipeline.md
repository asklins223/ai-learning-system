# 决策记录 04-1：TTS / ASR / transcript 确认 / 重录 / 换模态（§6.5）

> 状态：**Frozen（已冻结）**
> 执行：阶段 04（W3）任务 04-1
> 日期：2026-08-08
> 来源：`04-w3-voice-artifact-assessment.md` 任务 04-1（原方案 §6.5）+ 冻结记录 01-2 §6/§6.2、01-4 §13.2
> 约束级别：语音 trusted 路径完整；重录/换模态不产生理解副作用；Agent 不能自动润色；关键术语低置信 100% `not_assessable`。

---

## 1. 交付物

- `packages/shared/src/voice-artifact-contracts.ts`：voice / text_or_mixed 模态 payload 与
  ASRProviderPolicy 的契约单一来源（zod strict schema + z.infer）。
- `apps/api/src/modules/learning-sessions/voice-service.ts`：TTS / ASR / transcript 确认 /
  重录 / 换模态 管线（含数据治理，见 04-2）。
- `apps/api/src/modules/learning-sessions/voice-service.test.ts`：41 个单测全部通过。
- 本决策记录 + `04-2-voice-artifact-governance.md`。

## 2. 冻结语义与实现映射

### 2.1 TTS 只原样朗读净化题面（§6.5）

- `ttsReadAloud({ text, provider, providerPolicy, workspacePolicy, language })`：
  1. `assertProviderPolicyCompliant` —— Provider policy 不满足 workspace policy → fail closed
     （04-2 详述）；
  2. `assertSafeTtsInput` —— 拒绝 SSML/XML 标签、远程音频 URL、隐藏提示/关键词暗示，
     且 voice/profile 必须在固定 allowlist（`companion-default-v1`）；
  3. 净化文本 **原样**传给可注入 `TtsProvider`（单测用 mock），不追加任何关键词/语气暗示。
- 口音、流利度、语速、停顿、音量不是 `ttsReadAloud` 的输入，也不进入任何理解判定。

### 2.2 ASR 逐字 + 关键术语低置信 → not_assessable（§6.5/§13.2）

- `transcribe(...)`：Provider policy fail closed 后调用可注入 `AsrProvider`；
- `assessTranscriptionQuality`（纯函数）：
  - 关键术语（来自净化题面）所在 segment 置信度低于阈值 → `not_assessable`
    （`critical_term_low_confidence`，不猜测，可无损重试）；
  - provider 标记的低置信 token 命中关键术语 → `not_assessable`；
  - 整体置信度（逐段最低）低于阈值 → `not_assessable`（`overall_low_confidence`）；
  - 语气词等低置信但非关键术语、整体仍够 → 通过（口音/流利度不进判定）。

### 2.3 确认 / 重录 / 换模态（§6.5 + 01-2 §6.2）

- `confirmTranscript`：用户确认的逐字 transcript 是 voice artifact 的 canonical answer；
  确认文本必须与 ASR 逐字 draft **完全一致** —— Agent 不能自动润色/概括/补全后按纯 voice
  提交（不一致 → `VOICE_CONFIRM_MISMATCH`，引导 `switchModality`）；确认后
  `status=locked` + `answerLockedAt/confirmedAt` 冻结，`correctionMethod` 固化
  （原样确认 `none`，重录链路保持 `re_recorded`）。
- `reRecord`：创建新 voice revision（`correctionMethod=re_recorded`，`supersedesArtifactId`
  指向旧 artifact，旧 artifact 置 `superseded`）；新音频走 transcribe →
  `submitTranscriptDraft` → `confirmTranscript` 后**仍属纯 voice**；前一 artifact 已
  locked → 拒绝重录。
- `switchModality`：手工编辑 ASR transcript 或纯文字输入 → 创建 `text_or_mixed` locked
  revision（`correctionMethod=manual_text_edit`，payload 内 `supersedesArtifactId` 保留来源，
  不伪装为纯 voice）；无麦克风/安静环境/言语障碍用户可不带来源直接切换
  （revision 0 起，无需音频输入）。
- 不原地修改已哈希行：一切修正走 superseding revision。

### 2.4 请求义务（01-2 §6.2）

- 每个写请求必须携带 `baseRevision`（revision CAS）、`publicSceneHash`（=publicPayloadHash）、
  `userActionNonce`（8-128 字符）、`idempotencyKey`；缺失/失配 fail closed。
- `appendChunk`：capturing 阶段逐字拼接；**locked 后迟到 chunk/autosave 一律拒绝**
  （`ARTIFACT_LOCKED`）。

## 3. 类型收口说明

- 契约单一来源在 `packages/shared/src/voice-artifact-contracts.ts`（zod strict + z.infer）；
  主代理在 `packages/shared/src/index.ts` 收口导出后，`voice-service.ts` 应改为
  `import type { VoicePayload, TextOrMixedPayload, ASRProviderPolicy, ... } from "@ailearn/shared"`。
- 收口前 apps/api 在 `voice-service.ts` 本地声明等价类型（本决策记录即迁移说明）。
- `FrozenProbeRef` / `TrustClass` 已由 shared 现有导出直接复用。

## 4. 不写掌握/schedule 真值

- 本模块只操作 artifact/transcript/模态状态，0 canonical write；
- `effectiveTrustClass` 由任务 04-3 在 lock 时计算，本模块 lock 仅冻结 artifact 状态与
  canonical answer。

## 5. 验收（对应 04-w3 任务 04-1 验收）

- 语音 trusted 路径完整：TTS（净化朗读）→ ASR（逐字）→ 确认（canonical answer）→
  lock（voice revision 语义）→ 换模态（text_or_mixed revision）全链路可测；
- 重录/换模态不产生理解副作用（新 revision，不污染已哈希行）；
- 41 个单测全通过；`npm run typecheck --prefix apps/api`、`packages/shared` 通过。
