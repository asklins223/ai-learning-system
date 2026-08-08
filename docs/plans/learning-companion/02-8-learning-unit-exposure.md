# 决策记录 02-8：learning_unit_exposure aggregate/guard（§7.6）

> 状态：**Frozen（已冻结）**
> 执行：阶段 02（W1）任务 02-8
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-8（原方案 §7.6）
> 约束级别：legacy reveal → new Episode lock、new reveal → legacy submit、Scene/Rubric/policy rollover 三组共享 `contentExposureKey` 竞态正确。

**交付物**：`learning_unit_exposure` aggregate 与 learning-unit guard，供 legacy
question-first 与新 Episode 共同读写。

---

## 1. 目标与边界

learning-unit 的 exposure（reveal/assistance/lock/submit）必须跨页面、设备、
Session、Scene/policy rollover 和重开持久，且旧 question-first 与新 Episode
**读写同一 aggregate 和 guard**——不能靠切换入口重置。本记录冻结：

- `contentExposureKey` 公式（稳定 exposure 键，不含 Scene/rubric/provider/model/
  assistance policy 版本）；
- learning-unit guard 的固定锁序与 user action nonce；
- 竞态规则（lock 先赢 / assistance 先赢）；
- 确定性 dependency ledger 传播；
- legacy/new 同 aggregate 语义。

**不做**：不写掌握/schedule 直接真值；正式 outcome/attempt/schedule 仍落现有
`validation_events` / `review_attempts` / `understanding_events` 及其现行权威表；
本模块只承载 learning-unit 的 exposure 生命周期。

实现位置：
- `packages/db/src/schema/learning-exposure.ts`（drizzle 表，权威 schema）；
- `apps/api/src/db/migrations/0077_learning_unit_exposure.sql`（迁移 + RLS + GRANT）；
- `apps/api/src/modules/learning-sessions/exposure-service.ts`（纯函数 + 可注入
  repository + 默认 PG 实现）；
- `apps/api/src/modules/learning-sessions/exposure-service.test.ts`（单测）。

---

## 2. contentExposureKey（稳定 exposure 键，公式冻结）

```text
contentExposureKey = H(workspaceId, userId, keyPointId,
  publishedContentRevision, normalizedClaimHash, sortedEvidenceContentHashes)
```

- `H` = sha256，输出 `cex:{hex}` 前缀，与 artifact content hash 前缀区分；
- **evidence content hashes 在计算内再次排序**，乱序输入幂等（§7.6「排序幂等」）；
- **不得包含 Scene、rubric、provider、model 或 assistance policy 版本**：函数
  签名即冻结维度集合，Scene/policy rollover 后重算键不变，仍命中同一 aggregate；
- `publishedContentRevision` 变化（Key Point 内容换代）→ 键变化，旧 exposure
  与新内容隔离。

`learning_unit_exposure.content_exposure_key` 在 workspace 内唯一
（`learning_unit_exposure_key_unique_idx`），是「每 user+workspace 至多一个
当前 exposure」的最终兜底；同一键在旧/新入口、跨 Session 都命中同一行。

---

## 3. learning-unit guard：固定锁序 + user action nonce

`enter-practice/reveal` 与 `confirm-and-lock/submit` 锁**同一**
`(workspaceId, userId, contentExposureKey)` learning-unit guard 和**当前 probe
row**（§7.6）。实现 `learningUnitGuard(context, repository, operation)`：

1. `acquireExposureGuard`：learning-unit guard 锁。默认 PG 实现用事务级
   `pg_advisory_xact_lock(hashtextextended('learning-unit-exposure:{ws}:{user}:{key}', 0))`
   —— 与 `db/client.ts withSessionAdvisoryLock` 同键风格，但绑定在
   workspace transaction 同一连接上（保持 RLS 上下文），事务结束自动释放；
2. `lockProbeRow`：当前 probe row `FOR UPDATE`（同一 workspace/user，RLS FORCE
   兜底不匹配行不可见）—— **固定锁序：guard 锁先于 probe row 锁**；
3. `getOrCreateExposure`：读/建 aggregate 行（新建 revision=0）；
4. **revision CAS**：请求 `baseRevision` 必须等于当前 revision，否则
   `STALE_REVISION` fail closed（01-3 §2.3）；
5. 在锁内执行操作，`write(patch)` 以 `revision+1` 写回。

**user action nonce**：guard 必填参数（8-128 字符，格式校验），`computeNonceHash`
把 `(contentExposureKey, nonce)` 绑定为请求身份；配合 revision CAS 兜底旧 nonce
重放（revision 已推进即拒绝）。01-3 §2.3 的请求 body 校验（
`contentExposureKey + baseRevision + userActionNonce + requestHash` 按 URL 身份
重算）在调用方路由层执行，guard 内保证同锁域内的串行化。

---

## 4. 竞态规则（§7.6 同锁域）

guard 使两条路径串行化后，竞态判定退化为**基于当前 aggregate state 的纯函数
转移**（`revealTransition` / `lockTransition`，单测直接覆盖）：

- **lock 先赢**（`lockTransition`，state 无 practiceOnly、无锁）：
  冻结 pre-exposure snapshot（`assistanceSnapshot.capturedBy='lock'`、
  `contentAssisted=false`），设置 `lockedArtifactRef` / `lastLockedAt`；
  之后的 reveal **不追溯污染已锁 artifact**（不改 snapshot / lockedArtifactRef），
  但**写 exposure/cooldown**（`lastRevealedAt`、`exposureCount+1`、
  `cooldownUntil`），不写 `assistedAt` / `practiceOnlySince`；
- **assistance 先赢**（首次 reveal）：
  写 `assistanceSnapshot.capturedBy='assistance'`（contentAssisted=true）、
  `assistedAt`、`practiceOnlySince`——之后 **lock 必须看到 practice-only**
  （lock 不冻结正式 snapshot、不写 lockedArtifactRef）；返回内容仅以
  `contentLevel` 等级形式出现在 outcome 中，**具体内容由调用方在 guard 事务
  提交后才落地返回**（事务提交后才允许返回任何内容）；
- **幂等重放**：同 key 二次 lock → `alreadyLocked=true`，不覆盖已锁 ref；
  冷却期内 reveal → `blocked(cooldown)`；
- 已 practice-only 的后续 reveal：继续计数/更新 cooldown，不重复激活。

---

## 5. 确定性 dependency ledger（共享 evidence 传播）

`learning_exposure_dependency_ledger` 记录 `source → affected` 的 exposure
dependency 边，`(workspace_id, source, affected, shared_evidence_ref)` 唯一
（`learning_exposure_dependency_edge_unique_idx`），幂等写入：

- `propagateExposureDependency` 把输入边按 `(affectedKey, sharedEvidenceRef)`
  排序后逐个 `INSERT ... ON CONFLICT DO NOTHING`；
- `listAffectedKeys` 按 key 排序返回去重结果——传播按确定性顺序执行；
- 当 source learning unit 发生 reveal/assisted/lock 状态变化时，调用方经
  `listAffectedKeys` 拿到受影响 keys，以相同确定性顺序传播 exposure/cooldown
  （§7.6「共享 evidence 通过确定性 dependency ledger 传播到受影响 content
  exposure keys」）。

---

## 6. legacy/new 同 aggregate（不靠切换入口重置）

旧 question-first 与新 Episode 的 reveal/lock/submit 走**同一
`learning_unit_exposure` 表、同一 `learningUnitGuard` 锁域**：

- `ExposureGuardContext.path` 只作审计标注（`legacy_question_first` /
  `new_episode`），不参与键计算与状态分支；
- exposureCount 跨入口单调累计；二次 lock 幂等不覆盖；rollover 后键不变 →
  状态延续；
- 数据库唯一约束（exposure key 唯一 + 乐观 revision CAS）是跨入口竞态的最终
  兜底。

---

## 7. 验收对应（01-6 测试矩阵第 19 项）

| 竞态组 | 单测 | 断言 |
| --- | --- | --- |
| legacy reveal → new Episode lock | 竞态：assistance 先赢 | 首次 reveal 激活 practice-only；后续 lock `practiceOnly=true`、不写 lockedArtifactRef |
| new reveal → legacy submit | 竞态：lock 先赢 + legacy/new 幂等 | lock 冻结 snapshot；reveal 不追溯污染、写 exposure/cooldown；二次 lock 幂等 |
| Scene/Rubric/policy rollover | key 确定性 + rollover 单测 | 键不含 Scene/policy 维度，rollover 后读同一 aggregate 不重置 |

不写掌握/schedule 直接真值：本表/本模块只承载 exposure 生命周期。
