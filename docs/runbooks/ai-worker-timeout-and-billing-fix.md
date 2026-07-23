# AI Worker 超时与计费错误修复报告

> 维护者：Platform Owner
>
> 最后更新：2026-07-20（第二轮更新：DashScope 统一走 OpenAI 兼容端点 + `response_format`）
>
> 关联文件：`workers/ai-worker/`、`packages/shared/`

---

## 背景

生产环境中 AI Worker 频繁出现两类问题：

1. **`HandlerTimeoutError`** — `generate_card` 和 `evaluate_validation` handler 在 120s lease 窗口内无法完成，导致 job 被 reaper 回收后无限重试。
2. **`overdue-payment` 错误重试风暴** — DashScope 账户欠费后，所有 AI job 都返回 `overdue-payment` 400 错误，但 worker 仍按正常重试逻辑重试 3 次，浪费 lease 时间并放大错误指标。

## 根因分析

### 超时根因

| 因素 | 修改前 | 影响 |
| --- | --- | --- |
| **全局超时不可配** | 所有 job 类型共用 60s 超时 | `generate_card` 结构化 JSON 输出经常需要 70-85s，频繁触发超时 |
| **`max_tokens` 未设置** | AI provider 不限制输出 token 数 | 模型可能生成超长响应，延迟可达 120s+ |
| **串行 DB 往返过多** | `generate_card` 有 5-6 次串行 DB 查询；`evaluate_validation` 有 6-7 次 | 每次 5-20ms，累积 30-100ms 浪费 |
| **`workspaces` 表重复查询** | consent 检查、policy 获取、provider 选择各查 1 次 | 同一 job 最多查 3 次 `workspaces` 表 |

### 计费错误重试根因

`overdue-payment` 是永久性错误（账户欠费），但 worker 将其与普通瞬时错误（网络抖动、5xx）同等对待，按指数退避重试 3 次（10s → 20s → 40s），最终才进入 dead 状态。这导致：

- 每个 job 浪费 ~70s lease 时间
- 错误指标被放大 3 倍
- 用户等待反馈时间从即时变为 70s+

## 修复措施

### 1. 按 Job 类型配置超时阈值

**文件**：`workers/ai-worker/src/lib/handler-timeout-config.ts`（新增）

| Job 类型 | 默认超时 | 环境变量覆盖 |
| --- | --- | --- |
| `generate_card` | 90s | `WORKER_TIMEOUT_GENERATE_CARD_MS` |
| `evaluate_validation` | 90s | `WORKER_TIMEOUT_EVALUATE_VALIDATION_MS` |
| `align_evidence` | 30s | `WORKER_TIMEOUT_ALIGN_EVIDENCE_MS` |
| `parse_source` | 60s | `WORKER_TIMEOUT_PARSE_SOURCE_MS` |
| 全局默认 | 90s | `WORKER_MODEL_TIMEOUT_MS` |

**优先级**：per-type env > global env > per-type default > global default

所有超时值被 clamp 到 `LEASE_TIMEOUT_MS - 10s = 110s`，确保 abort 在 reaper 回收之前触发。

### 2. 不可重试错误立即 dead-letter

**文件**：`workers/ai-worker/src/lib/non-retryable-errors.ts`（新增）

检测以下永久性错误模式（大小写不敏感）：

- **计费**：`overdue-payment`、`payment required`、`insufficient balance`、`account suspended`
- **鉴权**：`invalid api key`、`unauthorized`、`forbidden`
- **配置**：`is required for`、`not configured`、`consent not signed`

**文件**：`workers/ai-worker/src/queue.ts`

新增 `markJobDead()` 函数，通过 `status: "failed"` 触发 `ailearn_fail_job(max_attempts=1)` 强制 dead 转换，跳过重试周期。

**文件**：`workers/ai-worker/src/index.ts`

tick 循环 catch 块中优先检查 `isNonRetryableError`，命中后调用 `markJobDead` 并递增 `ailearn_job_non_retryable_dead_total` 指标。

### 3. AI Provider 输出 token 限制

**文件**：`workers/ai-worker/src/lib/providers/dashscope.ts`、`openai-compatible.ts`

| 操作 | `max_tokens` | 理由 |
| --- | --- | --- |
| `generateCard` | 8192 | 结构化 JSON 输出（title + summary + key_points），需要充足空间 |
| `evaluateValidation` | 2048 | 较简单的判定输出（outcome + confidence + feedback），无需大量 token |

同时在 DashScope compatible-mode 请求中显式设置 `stream: false`，避免 SSE 解析开销。

### 6. DashScope 统一走 OpenAI 兼容端点 + `response_format`

**文件**：`packages/shared/src/ai-endpoints.ts`、`workers/ai-worker/src/lib/providers/dashscope.ts`

#### 问题

DashScope 原生端点 (`/services/aigc/text-generation/generation`) 不支持 `response_format` 参数，只能靠 system prompt 约束 + 容错 JSON 解析。模型经常输出 ```json 代码块标记或前缀说明文字，导致解析失败或超时。

#### 修复

1. **`resolveDashScopeTextEndpoint`** 改为对所有模型（包括 `qwen-plus`、`qwen-max` 等）统一返回 `openai_compatible` 协议，将 `/api/v1` 自动重写为 `/compatible-mode/v1/chat/completions`。

2. **`DashScopeProvider.callOnce`** 简化为单一代码路径，不再按 `native_text` / `openai_compatible` 分支。请求体新增：

```json
{
  "response_format": { "type": "json_object" }
}
```

   DashScope OpenAI 兼容端点支持 `response_format: { type: "json_object" }`，强制模型输出合法 JSON，从源头消除 ```json 围栏和前缀文字问题。

3. **用户自定义 DashScope 配置**：用户在个人设置中选择 DashScope provider 时，`DashScopeProvider` 构造函数接收用户的 `baseUrl`，`resolveDashScopeTextEndpoint` 会自动将其转换为兼容端点。无需用户手动配置 `/compatible-mode/v1`。

4. **OpenAI 兼容 provider** (`OpenAICompatibleProvider`)：保持原有逻辑不变，不加 `response_format`，因为无法确定用户配置的第三方端点是否支持此参数。

#### 协议路径对比

| 场景 | 修改前 | 修改后 |
| --- | --- | --- |
| `qwen-plus` 默认 | native_text → `/services/aigc/text-generation/generation` | openai_compatible → `/compatible-mode/v1/chat/completions` |
| `qwen3.5-plus` | openai_compatible | openai_compatible（不变） |
| 用户自定义 DashScope | 取决于 baseUrl | 自动重写为 compatible-mode |
| 用户自定义 OpenAI 兼容 | 不经过 DashScope 逻辑 | 不变 |

#### `safeParseJson` 保留策略

即使有了 `response_format: { type: "json_object" }`，仍保留容错 JSON 解析作为防御层。原因：
- 部分旧模型可能不完全遵守 `response_format`
- 网络中间件可能修改响应体
- 测试中仍需要验证容错路径

### 4. DB 查询并行化与 JOIN 优化

#### 4.1 `resolveAIGovernanceContext` — 个人配置与 workspace 并行查询

**文件**：`workers/ai-worker/src/lib/governance.ts`

```
修改前: getPersonalAIProviderRuntimeConfig(userId) → db.query.workspaces  (2 次串行)
修改后: Promise.all([getPersonalAIProviderRuntimeConfig, db.query.workspaces])  (1 次并行)
```

该函数将原先分散在 `checkAIConsent` + `getWorkspaceAIPolicy` + `getWorkspaceAIProvider` 中的 3 次 `workspaces` 查询合并为 1 次，并返回预解析的 `policy` 供 `enforcePrivacyGovernanceWithPolicy` 同步使用。

#### 4.2 `runGenerateCard` — 三路并行

**文件**：`workers/ai-worker/src/handlers/index.ts`

```
修改前: Promise.all([version+note JOIN, noteBlocks]) → resolveAIGovernanceContext  (2 次串行)
修改后: Promise.all([version+note JOIN, noteBlocks, resolveAIGovernanceContext])  (1 次并行)
```

#### 4.3 `runEvaluateValidation` — 三路并行 + evidence JOIN

**文件**：`workers/ai-worker/src/handlers/index.ts`

```
修改前: Promise.all([card, kp]) → evidence SQL → noteBlocks → resolveAIGovernanceContext  (4 次串行)
修改后: Promise.all([card, kp, resolveAIGovernanceContext]) → evidence+block JOIN SQL  (2 次串行)
```

evidence 查询改为 `LEFT JOIN note_blocks` 一次性获取 block 内容，消除后续的 `noteBlocks.findFirst` 串行查询。

#### 4.4 幂等检查合并

**文件**：`workers/ai-worker/src/handlers/index.ts`

`evaluate_validation` 的幂等检查从两次串行 `validationEvents.findFirst` 合并为单次 OR 条件查询（by jobId OR by input 组合）。

### 5. Prometheus 指标

**文件**：`workers/ai-worker/src/lib/metrics.ts`（新增）

新增指标：

| 指标 | 类型 | Labels | 用途 |
| --- | --- | --- | --- |
| `ailearn_job_non_retryable_dead_total` | Counter | `type` | 不可重试错误直接 dead 计数 |
| `ailearn_job_duration_seconds` | Histogram | `type` | Job 总运行时长 |
| `ailearn_job_terminal_total` | Counter | `type`, `status` | Job 终态计数 |
| `ailearn_job_retries_total` | Counter | `type` | Job 重试计数 |
| `ailearn_job_lease_lost_total` | Counter | `type` | Lease 丢失计数 |
| `ailearn_provider_calls_total` | Counter | `operation`, `status` | Provider 调用计数 |
| `ailearn_provider_call_duration_seconds` | Histogram | `operation` | Provider 调用延迟 |
| `ailearn_provider_errors_total` | Counter | `operation`, `error_category` | Provider 错误分类计数 |

Metrics HTTP 服务器监听 `WORKER_METRICS_PORT`（默认 9100），暴露 `/metrics` 端点。

---

## 优化效果汇总

### DB 串行往返减少

| Handler | 修改前串行往返 | 修改后串行往返 | 减少 |
| --- | --- | --- | --- |
| `generate_card` | 5-6 | 3-4 | ~40% |
| `evaluate_validation` | 6-7 | 3 | ~55% |
| `resolveAIGovernanceContext` | 2 | 1 | 50% |

### AI 调用延迟控制

| 措施 | 预期效果 |
| --- | --- |
| `max_tokens: 8192` (generate_card) | 截断冗长输出，减少 ~10-20s 尾部延迟 |
| `max_tokens: 2048` (evaluate_validation) | 截断冗长输出，减少 ~5-10s 尾部延迟 |
| `stream: false` | 避免 SSE 分块解析开销 |
| `response_format: { type: "json_object" }` | 强制 JSON 输出，消除 ```json 围栏和前缀文字解析失败 |

### 不可重试错误处理

| 场景 | 修改前 | 修改后 |
| --- | --- | --- |
| `overdue-payment` | 重试 3 次 → dead（~70s） | 立即 dead（<1s） |
| `invalid api key` | 重试 3 次 → dead（~70s） | 立即 dead（<1s） |
| `consent not signed` | 重试 3 次 → dead（~70s） | 立即 dead（<1s） |

---

## 涉及文件清单

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/lib/handler-timeout-config.ts` | 新增 | 按 job 类型配置超时，支持环境变量覆盖 |
| `src/lib/non-retryable-errors.ts` | 新增 | 检测不可重试错误模式 |
| `src/lib/metrics.ts` | 新增 | Prometheus 指标定义与 HTTP 服务器 |
| `src/lib/governance.ts` | 修改 | 新增 `resolveAIGovernanceContext`，并行查询优化 |
| `src/lib/handler-timeout.ts` | 修改 | `HandlerTimeoutError` 类（已有，未改逻辑） |
| `src/handlers/index.ts` | 修改 | 并行化 DB 查询，JOIN 优化，治理上下文整合 |
| `src/lib/providers/dashscope.ts` | 修改 | `max_tokens` 限制，`stream: false`，统一走 compatible 端点，`response_format` |
| `src/lib/providers/openai-compatible.ts` | 修改 | `max_tokens` 限制（不加 `response_format`） |
| `packages/shared/src/ai-endpoints.ts` | 修改 | `resolveDashScopeTextEndpoint` 统一返回 `openai_compatible` |
| `src/queue.ts` | 修改 | 新增 `markJobDead()` |
| `src/index.ts` | 修改 | 集成超时配置、不可重试错误检测、指标上报 |

---

## 验证结果

- TypeScript 编译：`tsc --noEmit` 通过，0 错误（ai-worker + shared）
- 单元测试：367 个测试全部通过（ai-worker 19 suite + shared 6 suite）
- ESLint：0 错误

---

## 运维指南

### 调整超时

```bash
# 全局覆盖（所有 job 类型）
export WORKER_MODEL_TIMEOUT_MS=100000

# 单类型覆盖
export WORKER_TIMEOUT_GENERATE_CARD_MS=100000
export WORKER_TIMEOUT_EVALUATE_VALIDATION_MS=80000
```

### 监控关键指标

```promql
# Provider 调用延迟 p95
histogram_quantile(0.95, rate(ailearn_provider_call_duration_seconds_bucket[5m]))

# 不可重试 dead 计数
rate(ailearn_job_non_retryable_dead_total[5m])

# Job 完成率
rate(ailearn_job_terminal_total{status="succeeded"}[10m])
  / (rate(ailearn_job_terminal_total{status="succeeded"}[10m]) + rate(ailearn_job_terminal_total{status="dead"}[10m]))

# Lease 丢失率
rate(ailearn_job_lease_lost_total[5m])
```

### 常见问题排查

**Q: 欠费恢复后已有 dead job 如何处理？**

用户需手动重新提交对应的学习卡生成或验证请求。dead job 不会被自动重试。

**Q: 如何区分瞬时超时和永久超时？**

查看 `ailearn_provider_call_duration_seconds` 直方图。如果 p95 持续高于 80s，说明模型本身延迟过高，考虑：
1. 降低 `max_tokens` 限制
2. 切换到更快的模型（如 `qwen-turbo` 替代 `qwen-plus`）
3. 调高 `WORKER_TIMEOUT_GENERATE_CARD_MS`

**Q: `isNonRetryableError` 误判怎么办？**

如果某个错误被误判为不可重试（例如 `access denied` 出现在 RLS 策略调试中），可以在 `non-retryable-errors.ts` 的 `NON_RETRYABLE_PATTERNS` 中移除对应模式。但建议谨慎操作——大多数 "access denied" 确实是永久性的。

**Q: 用户自定义 DashScope 的 baseUrl 需要改成 `/compatible-mode/v1` 吗？**

不需要。`resolveDashScopeTextEndpoint` 会自动将 `/api/v1` 重写为 `/compatible-mode/v1`。用户保持原有 baseUrl 配置即可，系统会自动路由到兼容端点。

**Q: 为什么 OpenAI 兼容 provider 不加 `response_format`？**

用户配置的第三方 OpenAI 兼容端点（如 vLLM、Ollama、LM Studio 等）不一定支持 `response_format` 参数。如果发送了不支持的参数，可能导致 400 错误。因此保持原有逻辑，仅靠 system prompt + 容错解析来处理 JSON 输出。DashScope 的兼容端点明确支持此参数，所以只有 DashScope provider 启用了。
