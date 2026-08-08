# 决策记录 02-9：canonical 事件、投影与重放（§12.2/§12.5）

> 状态：**Frozen（已冻结）**
> 执行：阶段 02（W1）任务 02-9
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-9（原方案 §12.2/§12.5）
> 约束级别：相同事件重放 hash 一致；projection 关闭时旧 reader 仍可读 pending schedule、attempt 和结果。

---

## 1. 决策

### 1.1 canonical 事实落点：不建平行真相

正式 overall outcome、attempt 和 schedule **继续落在现有权威域**：

- `validation_events`（正式 validation outcome，含 `outcome`/`confidence`/`feedback` 与幂等唯一约束）；
- `review_attempts`（正式 attempt，`(workspace_id, user_id, idempotency_key)` 幂等边界）；
- `understanding_events`（理解事件）；
- 现行权威表/枚举（`validation_outcome`、`review_status` 等）；
- facet projection 只读扩展后的 `validation_point_assessments`（`canonical_facet_observation` 的唯一 canonical facet fact）。

**不得新增 `understanding_evidence_events` 作为平行 canonical 真相**。任何新事件类型必须映射到上述既有权威域之一（本任务的 `eventType → 权威表` 映射固定为：`validation.event → validation_events`、`review.attempt → review_attempts`、`understanding.event → understanding_events`）。

### 1.2 outbox 派生投影（同事务）

新增 `learning_outbox_events`（append-only），与权威事实**在同一数据库事务内写入**（`appendCanonicalEvent` 组合器）：

- capability/map projection 只消费 outbox，投影逻辑不读、不写任何"第二套掌握真相"；
- 同一事务保证：投影看到的事件集合与权威事实永远一致（不会出现权威事实已提交但 outbox 未写 / 反之的半程状态）；
- `sequence` 每 workspace 单调（全局 PostgreSQL 序列的单调子集），`unique(workspace_id, sequence)` 兜底；`processed_at IS NULL` 即未消费，作为投影派生的游标；
- 每行 `projection_hash` 是该事件对三类投影（mastery/facet/map）的确定性贡献指纹，供 drift 检测。

### 1.3 重放 hash 一致

`replayProjection(eventStream)` 是纯函数：按事件顺序 fold 三个确定性 reducer（mastery/facet/map），`hash = sha256(stableStringify({ mastery, facet, map, eventTrace }))`。

- 相同 canonical event stream（同顺序）→ 相同 mastery/facet/map/eventTrace/hash；
- 乱序（不同流）→ 不同 eventTrace/hash；
- 稳定序列化对对象键按字典序排序，payload 键序不影响 hash；非有限数字直接拒绝。

`driftCheck(projectedHash, storedHash)` 对比重放 hash 与 outbox/投影存储的 hash，不一致即投影漂移。

### 1.4 payload 安全摘要规则

outbox payload **只存** schema action、IDs、hash、版本、计数、usage 和安全摘要：

- 白名单校验 `validateCanonicalEventPayload` 强制：白名单之外的键一律拒绝（fail closed）；
- 明确禁止 raw answer / chain-of-thought / rationale / question 原文 / feedback / excerpt 等敏感键（`SENSITIVE_FIELD_DENIED`）；
- 数据库层迁移 0078 另加 CHECK 兜底拒绝明显敏感键；
- 权威事实写入所需的私有字段（如 `validation_events.question` / `user_answer` 原文）通过 `canonicalFact` 单独携带，**绝不进入 outbox payload**。

### 1.5 projection 关闭时旧 reader 仍可读

`CanonicalFactReader`（`pgCanonicalFactReader(tx)`）**只读权威表**：pending schedule（`review_schedules`）、attempt（`review_attempts`）、结果（`validation_events`），不依赖投影。投影关闭 / 删除 / 漂移时，历史 reader、UI 与调度继续可用。

## 2. 理由

- **不建平行真相**：`understanding_evidence_events` 会与既有权威域产生双写漂移与"哪套为准"的裁决成本；既有 `validation_events`/`review_attempts`/`understanding_events` 已覆盖正式 outcome/attempt/schedule 语义（W0 冻结 §12.2）。
- **同事务 outbox**：避免 outbox 与权威事实之间出现窗口期（事务外 outbox 无法保证投影一致性）；同事务原子性使"相同事件流重放相同投影"成为可证明的性质。
- **纯函数投影/重放**：便于单测、便于在不同环境（API 进程 / worker / 批量修复）得到可复现结果；drift 检测由此可行。
- **payload 白名单**：从源头杜绝 raw chain-of-thought 落库，满足隐私边界（§12.5「事件 payload 只存 schema action、IDs、hash、版本、计数、usage 和安全摘要」）。

## 3. 取舍

| 取舍 | 选择 | 说明 |
| --- | --- | --- |
| 平行真相 `understanding_evidence_events` | 不建 | 与 1.1/2 一致；未来若需理解图谱，映射到 `understanding_events` 扩展 |
| outbox 事务边界 | 与权威事实同事务 | 原子；代价是权威事实写入须在同一 `ApiTransaction`（`pgCanonicalEventStore(tx)`） |
| sequence 分配 | 全局序列单调子集 | 每 workspace 单调且无需 per-workspace 锁；`unique(workspace_id, sequence)` 兜底 |
| 重放排序 | 不排序，按传入顺序 fold | 顺序由 DB 按 sequence 返回保证；乱序输入视为不同流（hash 不同），显式暴露问题 |
| payload 校验 | 白名单 + 禁止键双保险 | 未知键 fail closed，敏感键显式拒绝 |
| 旧 reader | 只读权威表，独立于投影 | projection 关闭/漂移不影响 pending schedule/attempt/结果可读性 |

## 4. 影响与后续

- 权威事实写入方（validation/review/evidence 领域 service）若要派生 capability/map 投影，应在同一 `withWorkspaceTransaction` 事务内调用 `appendCanonicalEvent`（传入 `pgCanonicalEventStore(tx)`）。
- 未来必须替换现有事实时：先给 backfill、双读比对、cutover、回滚和 contract migration，并保持相同 schedule 只由一个写路径消费（数据库 `review_schedules_pending_unique_idx` 已兜底）。
- 本模块**不新增**对 master/schedule/published relation 的直接写路径。

## 5. 验收映射

- 相同事件重放 hash 一致：`replayProjection` 单测（相同流同 hash、乱序不同 hash）。
- projection 关闭时旧 reader 仍可读 pending schedule、attempt 和结果：`CanonicalFactReader` + `readCanonicalFacts` 单测。
- 不写第二套掌握真相：本模块无任何 mastery/schedule 表写入；投影为纯函数输出。
- payload 不存 raw chain-of-thought：白名单校验 + 迁移 CHECK 兜底。
