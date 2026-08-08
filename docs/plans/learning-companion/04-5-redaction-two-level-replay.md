# 决策记录 04-5：重录/修订、redaction 与两级 replay（§13.2）

> 状态：**Frozen（已冻结）**
> 执行：阶段 04（W3）任务 04-5
> 日期：2026-08-08
> 来源：`04-w3-voice-artifact-assessment.md` 任务 04-5（原方案 §13.2 + §7.2 状态机）+ 冻结记录 01-2 §6.2、01-4 §13.2
> 约束级别：全复制面 redaction 残留扫描为 0；两级 replay 测试通过；ASR 不可靠时 100% not-assessable/fail closed；删除后不宣称可完整语义重审。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/redaction-service.ts`：状态机、`applyRedaction`
  （locked→redacted tombstone）、`buildRedactionCascade`/`applyRedactionCascade`、
  `scanForResidual`/`assertResidualFree`、`replayCanonical`、`reAuditAllowed`/`canonicalReplayAllowed`、
  `writeCompensatingInvalidation`、`deletionImpacts`。
- `apps/api/src/modules/learning-sessions/redaction-service.test.ts`：19 个单测（node:test + assert）。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 状态机（01-2 §6.2）

`ARTIFACT_STATE_TRANSITIONS`：

```text
Voice Artifact: capturing → transcribed → awaiting_confirmation → locked | superseded | stale
Any locked Artifact: locked → redacted（append-only tombstone，不可恢复为 locked）
```

- `assertValidArtifactTransition`：非法转换（含 `redacted → locked` 等一切 redacted 出边）抛
  `INVALID_ARTIFACT_TRANSITION`（fail closed）；
- 重录/手工修正由 04-1 `reRecord`/`switchModality` 创建新 revision/artifact 并记录
  `supersedesArtifactId`，**不原地修改已哈希行**；`correctionMethod` 区分
  `re_recorded` 与 `manual_text_edit`（04-1 已实现，本模块不重复）。

### 2.2 applyRedaction：locked → redacted（不可恢复）

- 只接受 `status === "locked"`；`redacted`/其余状态一律拒绝（`ALREADY_REDACTED`/`NOT_LOCKED`）；
- `raw_audio` scope 不触发 redaction（删除 raw audio 只结束声音复核能力，既有 trust 不变）；
- tombstone 只含：`artifactId`、`status="redacted"`、`redactionId`、`redactedAt`、
  `reasonCode`、`policyVersion`、`modality`、`deletionScope`、`outcomeRef`（content-free 历史引用）；
  **不含** transcript / segments / contentHash / audioRef / audioHash；
- 返回 `reAudit: false`：删除后不得宣称该 assessment 仍可做完整语义重审。

### 2.3 redactionCascade：全复制面覆盖（§13.2）

`buildRedactionCascade(artifactId, scope)` 返回覆盖计划（模式复用 02-7 `buildRedactionCascadeSql`）：
- `response_artifact`：payload/contentHash/segments/audioRef/audioHash → null，transcript → `[redacted]`；
- `assessment`：`answerExcerpt`/`rationale`（复述用户答案的）→ `[redacted]`，feedback → null；
- `critic_job_payload` / `tutor_job_payload`：payload/inputSnapshot → null；
- `retry_payload`：payload/attemptData → null；
- `object_reference`：artifactId/payload → null；
- `cache`：value → null；
- `learning_result`/`full` 追加 legacy 旧域表（`validation_events.userAnswer` → `[redacted]`、
  `review_attempts.answerText` → null）；
- `applyRedactionCascade(plan, executor)`：注入 executor 逐步骤执行，任一失败即抛错
  （fail closed，不半途留下 content copy）；真实执行在 RLS 事务内。

### 2.4 contentScan：残留扫描为 0（§13.2）

- `scanForResidual({ sensitiveTokens, candidates })`：对数据库 / 对象存储 / 队列 / cache 的候选
  内容片段做敏感 token 命中扫描，返回命中清单 + `clean`；
- `assertResidualFree`：`clean=false` 抛 `RESIDUAL_FOUND`（删除过程 fail closed）；
- `tombstoneIsContentFree`：tombstone 序列化后不得含任何敏感 token（content-free 校验）。

### 2.5 两级 replay（§13.2）

- **第一级 canonical replay**：`replayCanonical(events)` 复用 02-9 `replayProjection`，
  确定性重放既有 outcome 与投影（相同事件流 → 相同 hash；顺序敏感）。对
  locked/superseded/stale/redacted 均可行（`canonicalReplayAllowed`；redacted 的
  outcome ref 保留在 tombstone，可确定性重放既有 outcome）；
- **第二级 semantic re-audit**：`reAuditAllowed(status) === status === "locked"`。
  只有未 redacted（且 locked）的 artifact 才能被新版 Critic 做完整语义重审；
  redacted/superseded/stale/未锁定一律拒绝。

### 2.6 compensating invalidation（§13.2）

- `writeCompensatingInvalidation(store, input)` 复用 02-9 `appendCanonicalEvent`：
  写 `understanding.event`（action=`invalidate`、skipReasonCode=`user_requested_deletion`、
  status=`superseded`），**append-only，绝不改写历史事件**；
- 幂等：understanding 幂等键 `subjectType:subjectId:eventType` = `artifact:artifactId:invalidated`，
  重复删除不重复占 outbox sequence；
- outbox payload 走 02-9 白名单校验：含 transcript/answer 原文会抛
  `CanonicalEventValidationError`（fail closed，无原文残留）；
- official scheduler 在同一事务 supersede/cancel 派生 schedule 后产生恰好一个 active
  schedule——属 scheduler（01-2 §7.4），本模块只写事件不改历史。

### 2.7 删除影响说明（§13.2）

`deletionImpacts(scope)` 供 UI 删除前展示三种影响：raw audio / answer content / learning result
（answer content 与 learning result 触发 redaction，raw audio 单独删除不降级 trust）。

## 3. 决策点与收口

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| redaction 落库方式 | 调用方在同一事务落 tombstone + 执行 cascade；本模块纯逻辑可测 | 不写第二套真相，真值仍落现有权威域 |
| `reAuditAllowed` | 仅 `locked`（比「未 redacted」更保守） | superseded/stale 内容非当前有效；fail closed 优先 |
| canonical replay 对 redacted | 允许（`canonicalReplayAllowed("redacted")=true`） | tombstone 保留 outcome ref，既有 outcome 可确定性重放 |
| 级联匹配 | opaque `artifact:{id}` ref + 字段白名单（复用 02-7） | 无注入面、无内容匹配 |
| invalidation 事件 | `understanding.event`（action=invalidate） | understanding 幂等键支持 artifact 级 subjectId；不改 validation/review 历史 |

## 4. 验收映射

- [x] 状态机严格：capturing→…→locked|superseded|stale；locked→redacted 不可恢复（单测断言 redacted 无出边）；
- [x] 重录/手工修正创建新 revision 并记录 `supersedesArtifactId`（04-1 提供；本模块不原地改已哈希行）；
- [x] 删除后各复制面残留扫描为 0（contentScan 单测）；
- [x] 删除后不宣称可完整语义重审（`reAudit=false` + `reAuditAllowed("redacted")=false`）；
- [x] 两级 replay 测试通过（canonical 确定性重放 + re-audit 门禁）；
- [x] 补偿 invalidation：append-only、幂等、payload 无原文；
- [x] ASR 失败/低置信/音频替换/replay 攻击 fail closed → not_assessable（04-4 `assessReliability`，可无损重试）。

## 5. 后续衔接

- 04-6（UI）：删除前展示三种影响（`deletionImpacts`）；麦克风拒绝后 text/structured 无死路；
- W5 COMMIT：消费冻结 Artifact 集与 `EpisodeTrustDecision`，redacted artifact 不进入正式归约。
