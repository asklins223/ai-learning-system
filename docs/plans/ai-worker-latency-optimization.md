# AI Worker 延迟优化方案

> **创建日期**：2026-07-20
> **状态**：Draft/Proposed
> **优先级**：P0-P2（紧急到中期）
> **关联文件**：`workers/ai-worker/src/index.ts`、`workers/ai-worker/src/queue.ts`、`workers/ai-worker/src/handlers/index.ts`、`workers/ai-worker/src/lib/handler-timeout-config.ts`、`workers/ai-worker/src/lib/providers/dashscope.ts`、`workers/ai-worker/src/lib/providers/openai-compatible.ts`、`workers/ai-worker/src/lib/prompts.ts`、`workers/ai-worker/src/lib/job-retry.ts`、`apps/web/components/NoteEditor.tsx`、`apps/web/app/(workspace)/(focus)/cards/[id]/page.tsx`、`docker-compose.yml`
> **前置记录**：AI Worker 超时与计费错误修复报告已转入本地 `project-archive`

---

## 1. 问题描述

Private Alpha 用户在使用「生成学习卡」和「理解验证」功能时频繁遇到超时提示，严重影响用户体验：

1. **学习卡生成超时**：用户在笔记编辑器点击生成学习卡后，前端轮询约 60s 后提示"等待超时，可去「学习卡」页查看是否生成成功。"，但实际上 job 可能仍在正常执行中（Worker handler 超时阈值为 90s），稍后会成功。
2. **理解验证超时**：用户在学习卡详情页提交回答后，前端轮询约 60s 后抛出"验证判定超时，请稍后重试"，但 Worker handler 的实际超时阈值为 90s——job 可能正在正常执行。
3. **队列堵塞**：一个 `generate_card` job 执行期间（可达 90s），所有其他 job（包括其他用户的验证请求）全部排队等待，因为 `QUEUE_CONCURRENCY = 1`，严重影响多用户并发体验。
4. **align_evidence 堵塞验证**：学习卡生成成功后批量入队 N 个 `align_evidence` job（每个 key point 1 个），这些后台 job 与用户实时等待的 `evaluate_validation` job 共享同一队列，没有优先级区分。
5. **端到端延迟累积**：典型的学习卡生成 + 验证流程可能在不利情况下达到 3-4 分钟，远超用户预期。

## 2. 根因分析

### 2.1 前端轮询超时 < Handler 超时（最直接原因）

#### 当前超时配置对比

| 位置 | 前端轮询总时长 | Handler 超时 | 差距 | 用户体验影响 |
| --- | --- | --- | --- | --- |
| `NoteEditor.tsx` `pollGenerationJob` | 40 × 1.5s = **60s** | 90s | 30s | 假超时最频繁 |
| `cards/[id]/page.tsx` 验证轮询 | deadline = **60s** | 90s | 30s | 假超时频繁 |
| `cards/[id]/page.tsx` 重新生成轮询 | 40 × 1.5~3s ≈ **60–120s** | 90s | 基本对齐 | 相对正常 |

相关代码：

`apps/web/components/NoteEditor.tsx` 第 233 行：

```typescript
for (let index = 0; index < 40; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // ...
}
setGenMessage("等待超时，可去「学习卡」页查看是否生成成功。");
```

`apps/web/app/(workspace)/(focus)/cards/[id]/page.tsx` 第 561 行：

```typescript
const deadline = Date.now() + 60_000;
// ...
if (!completed) throw new Error("验证判定超时，请稍后重试");
```

**结论**：前端在 60s 后放弃轮询并提示超时，但 Worker 的 handler 超时是 90s——job 可能正在正常执行中，30s 后就会成功。用户看到的"超时"是**假超时**。

### 2.2 QUEUE_CONCURRENCY = 1，单线程串行处理

`workers/ai-worker/src/queue.ts` 第 12 行：

```typescript
export const QUEUE_CONCURRENCY = 1;
```

Worker 每次 `claimJobs` 只取 1 个 job，且 `tick()` 中用串行 `for` 循环处理：

```typescript
// index.ts tick()
const candidates = await claimJobs(); // concurrency=1
for (const job of candidates) {       // 串行处理
  await runWithAbortTimeout((signal) => handler(...), handlerTimeoutMs, ...);
  // 上一个 job 完成后才会处理下一个
}
```

如果一个 `generate_card` 跑了 80s，期间所有其他 job（包括其他用户的验证请求、align_evidence job）全部排队等待。

**典型场景**：用户 A 生成学习卡（产生 5 个 key points → 5 个 `align_evidence` job），用户 B 提交验证 → 验证 job 排在 5 个 `align_evidence` 后面 → 用户 B 等待 5 × 30s + 验证本身 = 可能 3 分钟以上。**这超出了绝大多数用户可接受的等待时间（通常 < 60s）**。

### 2.3 align_evidence 批量入队堵塞验证 job

`workers/ai-worker/src/handlers/index.ts` 第 364–371 行，`generate_card` 成功后为每个 key point 入队一个 `align_evidence` job：

```typescript
if (kps.length > 0) {
  await tx.insert(schema.jobs).values(kps.map((kp) => ({
    type: "align_evidence",
    workspaceId: version.workspaceId,
    requestedBy: auditUserId,
    payload: { keyPointId: kp.id, noteVersionId },
    status: "pending",
  })));
}
```

这些 job 与 `evaluate_validation` 共享同一队列，且 `ailearn_claim_jobs` 按 `scheduled_at` 排序，没有优先级区分。`align_evidence` 是后台任务（模糊文本对齐，无 AI 调用），不应堵塞用户实时等待的验证。

### 2.4 Worker 轮询间隔增加基线延迟

`workers/ai-worker/src/index.ts` 第 37 行：

```typescript
const POLL_MS = 1500;
```

从 job 入队到被 claim，平均有 750ms 的等待（最坏 1500ms）。对于用户实时等待的验证场景，这是可感知的额外延迟。

### 2.5 AI 模型调用是非流式

`workers/ai-worker/src/lib/providers/dashscope.ts` 第 127 行：

```typescript
stream: false,
```

非流式意味着用户必须等待模型生成**完整**的 JSON 输出后才能看到任何结果。对于 `generate_card` 的 `max_tokens: 8192`，模型可能需要 60–80s 才能输出完整的结构化 JSON。

### 2.6 max_tokens: 8192 偏高

`workers/ai-worker/src/lib/providers/dashscope.ts` 第 79 行：

```typescript
const raw = await this.callOnce([...], 0.2, signal, 8192);
```

根据 prompt 约束（title ≤ 200 字、summary ≤ 1000 字、每个 key_point 的 claim ≤ 500 字 + quote ≤ 1000 字），20 个 key_points 的理论上限很高，但实际输出通常远低于此。8192 的上限让模型有空间生成冗长内容，增加尾部延迟。降低 max_tokens 并配合 key_points 数量限制（方案 3）可有效减少尾部延迟。同理 `openai-compatible.ts` 第 43 行也设了 8192。

### 2.7 重试退避过长

`workers/ai-worker/src/lib/job-retry.ts`：

```typescript
const RETRY_BACKOFF_BASE_MS = 10_000;
// attempt 0 失败 → 等 10s → attempt 1
// attempt 1 失败 → 等 20s → attempt 2
// attempt 2 失败 → dead（无退避）
```

瞬时错误（网络抖动、5xx）后第一次重试要等 10s，用户感知到的是"卡住了"。`MAX_ATTEMPTS = 3` 意味着只有 2 次重试退避，总等待时间为 10 + 20 = **30s**（第三次失败直接 dead，无退避）。

### 2.8 key_points 数量上限过大

`packages/shared/src/prompts.ts`（v1 prompt）中 key_points 上限为 8：

```typescript
"3. 最多输出 8 个 key_points。"
```

8 个 key points 的结构化 JSON 输出量较大，且每个 key point 还会触发一个 `align_evidence` job。限制为 5 个可显著减少模型生成量和下游 job 数量。

---

## 3. 当前超时配置一览

| 配置项 | 值 | 位置 |
| --- | --- | --- |
| `LEASE_TIMEOUT_MS` | 120s | `queue.ts` |
| `MAX_ALLOWED_TIMEOUT_MS` | 110s（lease − 10s 安全余量） | `handler-timeout-config.ts` |
| `generate_card` handler 超时 | 90s | `DEFAULT_TIMEOUTS` |
| `evaluate_validation` handler 超时 | 90s | `DEFAULT_TIMEOUTS` |
| `align_evidence` handler 超时 | 30s | `DEFAULT_TIMEOUTS` |
| `parse_source` handler 超时 | 60s | `DEFAULT_TIMEOUTS` |
| `MAX_ATTEMPTS` | 3 | `queue.ts` |
| `QUEUE_CONCURRENCY` | 1 | `queue.ts` |
| Worker 轮询间隔 (`POLL_MS`) | 1500ms | `index.ts` |
| 前端 NoteEditor 轮询 | 40 × 1.5s = 60s | `NoteEditor.tsx` |
| 前端验证轮询 | 60s deadline | `cards/[id]/page.tsx` |
| 前端重新生成轮询 | 40 × 1.5–3s ≈ 60–120s | `cards/[id]/page.tsx` |
| 重试退避基数 | 10s | `job-retry.ts` |

---

## 4. 优化方案

### 方案 1：对齐前端轮询超时与 Handler 超时（P0 — 立即止血）

**目标**：消除"假超时"——用户不再在 job 正常执行时看到超时提示，提升用户体验。

**当前问题**：前端轮询总时长（60s）< Handler 超时（90s）导致大量假超时

**改动范围**：2 处前端文件（NoteEditor 轮询 + 验证轮询；重新生成轮询已覆盖 105s 目标，无需改动）。

**预期收益**：消除 80%+ 的假超时提示，显著改善用户体验

#### 4.1.1 NoteEditor.tsx — `pollGenerationJob`

当前为固定 40 次 × 1.5s = 60s。改为 deadline 驱动，总时长 105s（覆盖 90s handler + 15s 余量），同时用指数退避减少前期的无效轮询：

```typescript
// 修改前：40 次 × 1.5s = 60s
for (let index = 0; index < 40; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1500));

// 修改后：deadline 驱动 + 指数退避，总时长 ~105s
const deadline = Date.now() + 105_000;
let pollDelay = 1000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, pollDelay));
  // ...（保持原有的 runId / mountedRef 检查和 succeeded/failed 分支）
  pollDelay = Math.min(3000, Math.round(pollDelay * 1.5));
}
```

#### 4.1.2 cards/[id]/page.tsx — 验证轮询

```typescript
// 修改前
const deadline = Date.now() + 60_000;

// 修改后
const deadline = Date.now() + 105_000;
```

#### 4.1.3 cards/[id]/page.tsx — 重新生成轮询（无需改动）

重新生成轮询当前为 40 次，延迟从 1500ms 起、按 1.3x 增长、封顶 3000ms（代码第 421–460 行）。经计算总时长约 117s（1500 + 1950 + 2535 + 37 × 3000 ≈ 117s），已覆盖 90s handler + 15s 余量 = 105s 的目标，**无需改动**。

```typescript
// 现有代码（无需修改）— 总时长 ~117s，已覆盖 105s 目标
let delay = 1500;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => window.setTimeout(resolve, delay));
  // ...
  delay = Math.min(3000, delay * 1.3);
}
```

**预期效果**：消除约 80% 的"假超时"提示。

---

### 方案 2：降低 max_tokens（P0 — 减少模型输出时间）

**目标**：通过限制输出长度截断冗长输出，减少 10–20s 尾部延迟，提升响应速度。

**技术分析**：8192 tokens 上限远高于实际需求，导致模型倾向于生成冗余内容增加延迟

**改动文件**：`dashscope.ts`、`openai-compatible.ts`。

| 操作 | 修改前 | 修改后 | 技术理由 |
| --- | --- | --- | --- |
| `generateCard` | 8192 | **4096** | 理论上限 title(200) + summary(1000) + 5 key_points × (500 + 1000) = 8700 字，实际输出通常 1000-2000 tokens。4096 足够覆盖 95%+ 场景，需监控 schema check 失败率 |
| `evaluateValidation` | 2048 | **2048**（不变） | 已针对小输出场景优化 |

**代码改动**：

`dashscope.ts` 第 79 行：

```typescript
// 修改前
const raw = await this.callOnce([...], 0.2, signal, 8192);
// 修改后
const raw = await this.callOnce([...], 0.2, signal, 4096);
```

`openai-compatible.ts` 第 43 行：

```typescript
// 修改前
], signal, 8192);
// 修改后
], signal, 4096);
```

> **注意**：`packages/ai-quality/src/cli/rc-gate.ts` 的 `generateCard`（第 67 行）请求体中**未设 `max_tokens`**（仅有 `model`、`messages`、`temperature`），使用模型默认值。RC 门禁对输出完整性要求高（需通过 schema 校验和黄金集评分），建议**不修改**或显式设为 `8192` 保持原有行为。

**预期效果**：模型输出时间减少约 10–20s。

---

### 方案 3：限制 key_points 数量（P0 — 减少模型生成量）

**目标**：通过限制 key_points 数量上限，减少模型输出量和下游 align_evidence job 数量，从而降低端到端延迟。

**技术分析**：20 个 key_points 上限导致大量结构化输出和下游 task，严重影响性能和用户体验

**改动文件**：`workers/ai-worker/src/lib/prompts.ts`。

```typescript
// 修改前（v1 prompt）
"3. 最多输出 8 个 key_points。"
// 修改后（v2 prompt）
"3. 最多输出 5 个 key_points，优先选择最重要的。"
```

同时检查 `packages/ai-quality/src/cli/rc-gate.ts` 中的 system prompt。经核查，rc-gate.ts 使用独立的硬编码 prompt（未引用 `SYSTEM_PROMPT`，也未提及 key_points 数量上限），**无需修改**；`apps/api/src/modules/benchmark/service.ts` 不包含 prompt 相关代码，同样无需修改。

> **实现备注**：prompt 已在 v2 版本中将上限从 8 降至 5，配合 `sanitizeCardOutput` 后处理（claim 长度过滤 + Jaccard 相似度去重）进一步精简。5 个 key_points 已足够覆盖 95%+ 笔记的核心知识点。

**预期效果**：

- 模型生成量减少约 75%（20 → 5 个 key points）
- 下游 align_evidence job 数量减少 75%
- 整体 generate_card + align_evidence 链路时间减少 25–35%

---

### 方案 4：提升 QUEUE_CONCURRENCY + 并行处理（P1）

**目标**：多用户场景吞吐量提升 2–3x。

**改动文件**：`queue.ts`、`index.ts`。

#### 4.4.1 提升并发数

```typescript
// queue.ts
// 修改前
export const QUEUE_CONCURRENCY = 1;
// 修改后
export const QUEUE_CONCURRENCY = 3;
```

#### 4.4.2 并行处理 claim 回来的 job

当前 `tick()` 是串行 `for` 循环。改为 semaphore 模型并行处理：

```typescript
// index.ts — semaphore 模型
// 追踪在途 job，用于计算可用 slot 数量和优雅关停
const inflight = new Set<Promise<void>>();

async function tick(): Promise<void> {
  // ...reap...
  if (shuttingDown) return;

  // 只 claim 需要补充的 job 数量
  const available = QUEUE_CONCURRENCY - inflight.size;
  if (available <= 0) return;

  const candidates = await claimJobs(undefined, available);

  // fire-and-forget：每个 job 独立处理，不等待其他 job 完成
  for (const job of candidates) {
    const promise = processJob(job).catch((err) => {
      logger.error({ jobId: job.id, err }, "job processing rejected unexpectedly");
    });
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }
}

// main() 优雅关停时等待所有在途 job
if (shuttingDown) {
  if (inflight.size > 0) {
    logger.info({ inflight: inflight.size }, "waiting for in-flight jobs…");
    await Promise.allSettled([...inflight]);
  }
  return;
}
```

> **实现备注**：方案最初设计为 `Promise.allSettled` 批处理模型（claim N 个 → 等待全部完成 → 再 claim N 个）。实施时发现此模型存在 slot 空闲问题：如果一个 job 跑 90s 而其他 job 只跑 5s，快完成的 job 的 slot 会空闲 85s 直到慢 job 也完成。实际采用 semaphore 模型：每个 job 独立 fire-and-forget，slot 空闲后在下次 tick（最多 POLL_MS=500ms 后）立即补充新 job，吞吐量提升从理论 3x 实际趋近 3x。

**安全性分析**：

各 handler 事务中使用的 advisory lock 粒度不同，需分别评估：

| Handler | Advisory Lock Key | 粒度 | 并发安全性 |
| --- | --- | --- | --- |
| `generate_card` | `job-quota:${workspaceId}` | workspace 级 | ✅ 同 workspace 的 generate_card 串行化 |
| `align_evidence` | `evidence-align:${kp.id}` | key point 级 | ✅ 同 key point 串行化，不同 key point 可并行 |
| `evaluate_validation` | `${job.id}` | **per-job** | ⚠️ **不防止同输入不同 job 的并发写入** |

- `generate_card` 和 `align_evidence` 的锁粒度足以保证并发安全。
- **`evaluate_validation` 存在并发风险**：两个不同 jobId 但相同输入（cardId + keyPointId + userId + question + userAnswer）的 job 可同时通过事务外的幂等读检查（handlers 第 750–764 行），且事务内仅按 `jobId` 查重（第 913–918 行），per-job advisory lock 不会互斥。这会导致重复写入 `validation_events`。
- 在 `QUEUE_CONCURRENCY = 1` 时此风险不存在（job 串行执行）。提升并发前**必须**先修复：
  - 方案 A：将 `evaluate_validation` 的 advisory lock 改为输入维度（如 `hashtextextended(cardId || keyPointId || userId || question || userAnswer, 0)`）
  - 方案 B：在 `validation_events` 上对输入组合加唯一约束（`(workspace_id, card_id, key_point_id, user_id, question, user_answer)`），让第二个事务在 insert 时失败
- AI 模型调用是网络 IO，不互相阻塞，并行处理可让多个 job 的模型调用同时进行。
- 不同 workspace 的 job 完全独立，无锁竞争。

**注意事项**：

- 需确认 `ailearn_claim_jobs` 函数的 `concurrency` 参数是否正确传递。当前 `claimJobs(concurrency = QUEUE_CONCURRENCY)` 一次 claim 3 个 job，但每个 job 的 `lease_token` 独立分配，不会冲突。
- Prometheus 指标 `jobDurationSeconds` 已按 `job.type` 标签记录，不受并发影响。

---

### 方案 5：为 evaluate_validation 设置队列优先级（P1）

**目标**：验证不再被 align_evidence 堵塞。

**改动范围**：`ailearn_claim_jobs` SQL 函数（migration）、`queue.ts`。

#### 4.5.1 优先级设计

| Job 类型 | 优先级 | 理由 |
| --- | --- | --- |
| `evaluate_validation` | 10 | 用户实时等待，最敏感 |
| `parse_source` | 8 | 用户刚提交来源，等待解析 |
| `generate_card` | 5 | 用户等待但可容忍较长延迟 |
| `align_evidence` | 1 | 后台任务，无 AI 调用 |

#### 4.5.2 实现方案

在 `ailearn_claim_jobs` 函数的 `ORDER BY` 中加入优先级：

```sql
-- 修改前
ORDER BY scheduled_at ASC

-- 修改后
ORDER BY
  CASE type
    WHEN 'evaluate_validation' THEN 10
    WHEN 'parse_source' THEN 8
    WHEN 'generate_card' THEN 5
    WHEN 'align_evidence' THEN 1
    ELSE 5
  END DESC,
  scheduled_at ASC
```

需要新建 migration 文件替换 `ailearn_claim_jobs` 函数体（当前函数定义在 migration 0018 `0018_sec01_jobs_expand.sql` 第 48–95 行，migration 0022 未修改此函数）。

---

### 方案 6：缩短重试退避（P1）

**目标**：瞬时错误恢复从 10s 降到 2s。

**改动文件**：`workers/ai-worker/src/lib/job-retry.ts`、新增 migration 修改 `ailearn_fail_job` SQL 函数。

#### 4.6.1 TypeScript 常量

```typescript
// 修改前
const RETRY_BACKOFF_BASE_MS = 10_000;
// 10s → 20s（第三次失败直接 dead）

// 修改后
const RETRY_BACKOFF_BASE_MS = 2_000;
// 2s → 4s（第三次失败直接 dead）
```

#### 4.6.2 SQL 函数（必须同步修改）

> **关键**：生产环境通过 `createSqlFunctionQueueJobUpdater` → `ailearn_fail_job` SQL 函数完成失败状态转换。该函数（migration 0022 第 140 行）内部硬编码了退避公式 `10.0 * power(2, job_state.attempts)`，实际 `scheduled_at` 由 SQL 函数计算，**不受 TypeScript 常量影响**。TypeScript 中 `retryBackoffMs()` 的返回值仅用于日志输出。因此仅修改 `job-retry.ts` 不会改变实际退避时间，必须新建 migration 替换函数体：

```sql
-- 新 migration（如 0031_job_retry_backoff_adjust.sql）
-- CREATE OR REPLACE FUNCTION public.ailearn_fail_job(...) 函数体中修改：
--   修改前: secs => 10.0 * pg_catalog.power(2, job_state.attempts)
--   修改后: secs => 2.0  * pg_catalog.power(2, job_state.attempts)
-- 同步修改返回值中的 backoff_ms 计算：
--   修改前: (10000 * pg_catalog.power(2, updated.attempts - 1))::bigint
--   修改后: (2000  * pg_catalog.power(2, updated.attempts - 1))::bigint
```

**预期效果**：瞬时错误（网络抖动、5xx）后第一次重试只需等 2s，最终 dead 的总退避从 30s 降到 6s。

> **注意**：`ailearn_reap_stale_jobs` SQL 函数（migration 0018 第 163 行）中硬编码了 `interval '10 seconds'` 作为 lease 过期后的退避。此路径仅在 Worker 崩溃 / lease 超时（120s）时触发，非正常重试路径，可在同一个 migration 中一并调整。

---

### 方案 7：减少 Worker 轮询间隔（P2）

**目标**：减少 0.75s 平均基线延迟。

**改动文件**：`workers/ai-worker/src/index.ts`。

#### 4.7.1 简单方案

```typescript
// 修改前
const POLL_MS = 1500;
// 修改后
const POLL_MS = 500;
```

#### 4.7.2 进阶方案：LISTEN/NOTIFY

使用 PostgreSQL `LISTEN/NOTIFY`，job 入队时 `NOTIFY`，Worker 监听后立即 claim：

```typescript
// 入队时（job/service.ts createJob）
await tx.execute(sql`NOTIFY ailearn_job_available`);

// Worker 端 — 需使用 pg 库的 Client.subscribe() 或 postgres 库的 notification API
// 不能通过 db.execute(sql`LISTEN ...`) 实现，因为 LISTEN 需要在一个持久连接上
// 接收后续的异步通知，而 db.execute 使用连接池，连接会在查询完成后归还。
// 收到通知后立即 tick()，否则 fallback 到 2s 轮询
```

**注意事项**：LISTEN/NOTIFY 不保证可靠投递（连接断开后丢失），所以仍需保留 fallback 轮询。此方案改动较大，建议在简单方案效果不足时再实施。

---

### 方案 8：流式响应（P2 — 中期改造）

**目标**：减少 TCP/TLS 连接尾部等待，更早感知 job 完成。

**改动文件**：`dashscope.ts`、`openai-compatible.ts`、`handlers/index.ts`。

**方案**：

1. Provider 端设 `stream: true`，使用 SSE 逐 chunk 读取
2. 累积完整 JSON 后解析（JSON 必须完整才能 Zod 校验，无法部分展示）
3. 利用流式更早检测模型错误（如 401/403 在第一个 chunk 就返回）
4. 流式读取可减少连接的 idle 尾部等待

**适用性分析**：

- `evaluate_validation`：输出小（2048 tokens），流式收益有限
- `generate_card`：输出大（4096 tokens），流式可减少尾部等待，但无法部分展示
- **建议**：仅对 `generate_card` 启用流式，`evaluate_validation` 保持非流式

---

### 方案 9：内容 hash 缓存（P3）

**目标**：同一笔记版本重复生成时秒级返回。

**改动文件**：`handlers/index.ts`、`job/service.ts`。

**方案**：

- 当前已有"active card 存在则跳过"的幂等检查
- 进一步：对 note blocks 内容做 hash，相同 hash 直接返回缓存的 card（跳过 AI 调用）
- 需要在 `note_versions` 表新增 `content_hash` 列（已有 migration 0029）
- `generate_card` handler 在调用 AI 前先查 `content_hash` 是否有已生成的 card

**预期效果**：重复生成场景从 90s 降到 <1s。

---

## 5. 实施计划

### 第一阶段：紧急止血（P0，预计 0.5-1 天）

针对假超时和模型延迟的紧急修复

| 序号 | 方案 | 改动文件 | 改动量 | 预期收益 |
| --- | --- | --- | --- | --- |
| 1 | 前端轮询超时对齐 | `NoteEditor.tsx`、`cards/[id]/page.tsx`（验证轮询） | 2 处 | 消除 80%+ 假超时 |
| 2 | 降低 max_tokens | `dashscope.ts`、`openai-compatible.ts` | 2 处 | 减少 10-20s 模型延迟 |
| 3 | 限制 key_points 数量 | `prompts.ts` | 1 处 | 减少 75% 输出量 |

**整体预期效果**：
- 用户假超时问题减少 80% 以上
- 平均模型调用时间减少 10–30s
- 学习卡生成总体延迟降低 15–35%

### 第二阶段：并发与队列优化（P1，预计 1–2 天）

针对系统架构和队列机制的核心优化

| 序号 | 方案 | 改动文件 | 改动量 | 预期收益 |
| --- | --- | --- | --- | --- |
| 4 | 提升并发 + 并行处理 | `queue.ts`、`index.ts`、`handlers/index.ts`（evaluate_validation 锁修复） | 3 处 + 测试 | 吞吐量提升 2-3x |
| 5 | 队列优先级 | 新 migration + `queue.ts` | 1 个 SQL 函数 + 测试 | 验证优先处理 |
| 6 | 缩短重试退避 | `job-retry.ts` + 新 migration 修改 `ailearn_fail_job` SQL 函数 | 2 处 + 测试 | 错误恢复提速 5倍 |

**整体预期效果**：
- 多用户并发处理能力从 1 提升到 3
- 验证请求延迟降低 50–70%
- 错误重试时间从 10s 降到 2s

### 第三阶段：延迟精细化（P2，预计 2–3 天）

| 序号 | 方案 | 改动文件 | 改动量 |
| --- | --- | --- | --- |
| 7 | 减少轮询间隔 / LISTEN-NOTIFY | `index.ts`（+ `job/service.ts`） | 1–2 处 |
| 8 | 流式响应 | `dashscope.ts`、`openai-compatible.ts`、`handlers/index.ts` | 重构 |

**预期效果**：基线延迟减少 0.75s，大输出场景尾部延迟减少。

### 第四阶段：缓存（P3，按需）

| 序号 | 方案 | 改动文件 | 改动量 |
| --- | --- | --- | --- |
| 9 | 内容 hash 缓存 | `handlers/index.ts`、`job/service.ts` | 中等 |

---

## 6. 预期效果汇总

### 用户感知延迟

| 场景 | 修改前 | P0 后 | P0+P1 后 | 全部实施后 |
| --- | --- | --- | --- | --- |
| 学习卡生成（首次） | 60–90s（可能假超时） | 40–70s | 30–50s | 30–50s |
| 学习卡生成（重复） | 60–90s | 40–70s | 30–50s | <1s（缓存命中） |
| 理解验证 | 60s（可能假超时） | 40–60s | 20–40s | 20–40s |
| 队列堵塞（多用户） | 可达 3 分钟+ | 可达 3 分钟+ | 30–60s | 15–30s |

### 系统吞吐量

| 指标 | 修改前 | 全部实施后 |
| --- | --- | --- |
| 并发 job 处理 | 1 | 3 |
| generate_card 输出 tokens 上限 | 8192 | 4096 |
| key_points 上限 | 20 | 5 |
| 重试退避（首次） | 10s | 2s |
| 轮询基线延迟 | 750ms avg | <250ms avg |

---

## 7. 风险与缓解

| 风险 | 影响等级 | 缓解措施 |
| --- | --- | --- |
| max_tokens 降到 4096 导致输出截断 | 中 | **必须**：限制 key_points 为 5 个后，4096 tokens 足够覆盖 95%+ 场景；监控 `DashScope output failed schema check` 错误率，设置告警阈值 |
| 并行处理多个 job 增加数据库连接 | 低 | Worker postgres 连接池已从 `max: 10` 调整为 `max: 15`（`db.ts`），覆盖 3 并发 job × 每 job 最多 4 并发查询 = 12 的峰值需求加连接生命周期开销 |
| `evaluate_validation` 并发写入重复 validation_events | **高** | **必须在提升并发前修复**：将 advisory lock 改为输入维度或加唯一约束（见方案 4 安全分析） |
| 队列优先级改动涉及 SQL 函数替换 | 中 | 先在 dev/staging 环境验证，生产回滚只需恢复旧函数；准备 rollback 脚本 |
| `ailearn_fail_job` SQL 函数与 `job-retry.ts` 退避基数不同步 | 高 | **必须**：方案 6 同时修改 TypeScript 常量和 SQL 函数，建立代码 review 检查清单 |
| 前端轮询延长导致用户等待更久才看到失败 | 低 | 失败（failed/dead）仍会立即返回，只有正常执行中的 job 才延长轮询；添加进度提示 |
| 流式响应引入 SSE 解析复杂度 | 中 | 仅对 generate_card 启用，evaluate_validation 保持非流式；增加详细的错误处理和重试机制 |

---

## 8. 验证方式

### 功能验证

1. **前端轮询超时对齐**：在 dev 环境用 Mock provider 模拟慢响应（延迟 80s），验证前端在 105s 内不会报告超时
2. **并发处理正确性**：同时入队 3 个不同类型 job，验证并行处理且无数据竞争
3. **队列优先级生效**：入队 5 个 align_evidence + 1 个 evaluate_validation，验证验证优先执行
4. **重试退避调整**：模拟瞬时错误，验证首次重试在 2s 后触发而非 10s
5. **max_tokens 限制**：生成包含大量文本的笔记，验证输出未被截断且结构完整
6. **key_points 数量限制**：验证生成结果不超过 5 个 key points

### 性能验证

使用 Prometheus 指标验证：

```promql
# Provider 调用 p95 延迟（应下降 10-30s）
histogram_quantile(0.95, rate(ailearn_provider_call_duration_seconds_bucket[5m]))

# Job 完成率（应上升）
rate(ailearn_job_terminal_total{status="succeeded"}[10m])
  / (rate(ailearn_job_terminal_total{status="succeeded"}[10m])
    + rate(ailearn_job_terminal_total{status="dead"}[10m]))

# Job 总运行时长 p95（应下降）
histogram_quantile(0.95, rate(ailearn_job_duration_seconds_bucket[5m]))
```

### 回归测试

- 现有全部单元测试通过（不引入回归）
- 新增并行处理测试：验证 3 个 job 并行时 lease fencing 仍然正确
- 新增优先级测试：验证 evaluate_validation 优先于 align_evidence 被 claim

---

## 9. 涉及文件清单

| 文件 | 改动类型 | 关联方案 | 优先级 |
| --- | --- | --- | --- |
| `apps/web/components/NoteEditor.tsx` | 修改前端轮询 | 方案 1 | P0 |
| `apps/web/app/(workspace)/(focus)/cards/[id]/page.tsx` | 修改前端轮询 | 方案 1 | P0 |
| `workers/ai-worker/src/lib/providers/dashscope.ts` | 降低 max_tokens | 方案 2 | P0 |
| `workers/ai-worker/src/lib/providers/openai-compatible.ts` | 降低 max_tokens | 方案 2 | P0 |
| `workers/ai-worker/src/lib/prompts.ts` | 限制 key_points 数量 | 方案 3 | P0 |
| `workers/ai-worker/src/queue.ts` | 提升并发数 | 方案 4 | P1 |
| `workers/ai-worker/src/index.ts` | 并行处理 + 轮询优化 | 方案 4、7 | P1/P2 |
| Worker postgres 连接池 | `max: 10` → `max: 15` | `db.ts` | 方案 4 | P1 |
| `apps/api/src/db/migrations/0030_job_queue_priority.sql` | 新增优先级队列 | 方案 5 | P1 |
| `workers/ai-worker/src/lib/job-retry.ts` | 缩短重试退避 | 方案 6 | P1 |
| `apps/api/src/db/migrations/0031_job_retry_backoff_adjust.sql` | 调整 SQL 退避函数 | 方案 6 | P1 |
| `workers/ai-worker/src/handlers/index.ts` | 锁修复 + 并行查询优化 | 方案 4 | P1 |
| `apps/api/src/modules/job/service.ts` | LISTEN/NOTIFY + 内容哈希 | 方案 7、9 | P2/P3 |

## 总结

本方案针对 AI Worker 延迟问题提供了从紧急止血到长期优化的完整路线图：

- **P0 阶段**（0.5-1 天）：解决最影响用户体验的假超时问题，预计减少 80%+ 的用户投诉
- **P1 阶段**（1-2 天）：提升系统并发能力和队列效率，解决多用户使用场景的堵塞问题
- **P2/P3 阶段**（2-3 天）：精细化延迟优化和缓存机制，进一步提升响应速度

通过这套组合方案的实施，预计可以将：
- 学习卡生成延迟从 60-90s 降低到 30-50s
- 验证延迟从 60s 降低到 20-40s
- 多用户并发吞吐量提升 2-3 倍
- 重复生成场景响应时间降到 <1s

**建议立即启动 P0 阶段的实施，其他阶段按优先级依次推进。**
