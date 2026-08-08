# 决策记录 04-2：Voice Artifact 与 Provider 数据治理（§7.2 + §13.2）

> 状态：**Frozen（已冻结）**
> 执行：阶段 04（W3）任务 04-2
> 日期：2026-08-08
> 来源：`04-w3-voice-artifact-assessment.md` 任务 04-2（原方案 §7.2 + §13.2）+ 冻结记录 01-2 §6/§6.1、01-4 §13.2
> 约束级别：FrozenProbe hash 绑定通过；raw audio 短 TTL 与加密生效；Provider policy 不满足时语音 fail closed；敏感内容不进日志。

---

## 1. 交付物

- `packages/shared/src/voice-artifact-contracts.ts`：voice / text_or_mixed payload 与
  `ASRProviderPolicy` 的 zod strict schema（契约单一来源）。
- `apps/api/src/modules/learning-sessions/voice-service.ts`：模态 payload 落点、
  FrozenProbe 逐 hash 绑定、Provider 数据治理 fail closed、日志净化。
- `apps/api/src/modules/learning-sessions/voice-service.test.ts`：数据治理相关单测。
- 本决策记录 + `04-1-voice-pipeline.md`。

## 2. 冻结语义与实现映射

### 2.1 模态 payload（01-2 §6.1 / 04-w3 任务 04-2）

- `voice` payload（`VoicePayloadSchema`，strict）：逐字 `confirmedTranscript`、
  `segmentTimestamps`（逐字 segment 含 startMs/endMs/text/confidence）、
  `asrProvider/asrModel/asrVersion/language/confidence`、可选短期 `audioRef`/`audioHash`、
  `confirmedAt`（用户确认时间 = canonical answer 时刻）。
- `text_or_mixed` payload（`TextOrMixedPayloadSchema`，strict）：原始 `text` 与确定性
  `contentHash`；`supersedesArtifactId` 保留来源（不伪装为纯 voice）。
- 确认前的中间态用 draft（无 `confirmedAt`）；只有重录后的确认仍属纯 voice。
- 契约字段改动必须回阶段 01 W0 评审（冻结记录约束级别）。

### 2.2 FrozenProbe 逐 hash 绑定（01-2 §6 / §7.2）

- `assertArtifactMatchesFrozenProbe(artifact, frozenProbe)`：逐项比对 probeId /
  publicSceneContractId / publicPayloadHash / privateSolutionId / privateSolutionHash /
  sceneSafetyReportHash / disclosureProfileHash / templateTrustCeiling；
- 任一失配或 FrozenProbeRef 缺失 → `FROZEN_PROBE_MISMATCH` fail closed；
- 只有 version 没有 private solution/safety hash 不足以进入评估。

### 2.3 raw audio 短期 transient + 长期保留边界（01-4 §13.2）

- raw audio 只是 ASR 与短期争议窗口的 transient 输入：仅以短期 `audioRef`（加密、短 TTL、
  默认不进长期备份）出现在 voice payload；
- `audioHash` 为单向 sha256 摘要，不可恢复声音；
- 用户确认后 raw audio 丢失/到期不降低既有 trust（confirmedAt 后 canonical answer 即
  transcript，raw audio 非 canonical 输入）。

### 2.4 Provider 数据治理 fail closed（01-4 §13.2）

- `ASRProviderPolicy`（tenantPolicyRef / region / retentionDays / trainingUseProhibited /
  consentVersion）绑定到 artifact/contract；
- `assertProviderPolicyCompliant(policy, workspacePolicy)`：tenant policy ref 匹配、
  region 在允许列表、retentionDays ≥ 最小、训练使用禁令满足、consent version 一致；
  任一不满足 → `PROVIDER_POLICY_VIOLATION`，TTS/ASR 一律 fail closed（不调 provider），
  用户仍有 text / eligibility 合格的 structured 路径。

### 2.5 敏感内容不进日志 / analytics（01-4 §13.2）

- `redactForLogs`：递归置 `[redacted]` 的字段集合 = 音频/transcript/segment/题面/答案/
  payload/answerExcerpt/claim/rationale 等；服务调用方在写普通日志、Prometheus label 或
  analytics payload 前必须经过它。

### 2.6 请求义务（01-2 §6.2，与 04-1 共享）

- 所有写请求必须携带 base revision、public scene hash、user action nonce、idempotency key；
- locked 后迟到 autosave/chunk 一律拒绝（`ARTIFACT_LOCKED`），不恢复为 trusted。

## 3. 类型收口说明

- 与 04-1 相同：契约单一来源在 `packages/shared/src/voice-artifact-contracts.ts`；
  index.ts 收口后 apps/api 迁移为 `@ailearn/shared` 导入，收口前本地声明等价类型。

## 4. 不写掌握/schedule 真值

- 本模块只落 artifact/transcript/模态与 provider 治理约束，0 canonical write；
- disposition / trust / schedule 由 04-3、W5 任务消费。

## 5. 验收（对应 04-w3 任务 04-2 验收）

- FrozenProbe hash 绑定通过（失配 100% fail closed）；
- raw audio 短 TTL（audioRef 短期）+ 加密 + audioHash 单向不可恢复；
- Provider policy 不满足时语音 fail closed（region/训练禁令/consent/retention/tenant ref
  各场景单测覆盖）；
- 敏感字段日志净化单测通过；完整 `npm test --prefix apps/api` 1641/1642 通过（唯一失败为
  并行任务 04-3 `trust-service.ts` 被 SEC-01 静态扫描误判，与本任务无关，见报告）。
