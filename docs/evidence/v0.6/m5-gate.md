# M5 Gate 证据：Card Repair 与成本观测

> 里程碑：M5<br>
> 执行人：`@asklins223`<br>
> 日期：2026-07-25<br>
> 关联 Git commit：`v0.6-implementation` 分支 HEAD

## Gate 1：非触发 0 二次调用；hard failure 0 激活

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| assessCardOutput 返回结构化 issue reason codes | ✅ | `card-quality.ts` 12 个 reason codes |
| 非触发样本 0 二次调用 | ✅ | `CARD_REPAIR_V1_ENABLED` flag 门禁所有 repair 行为 |
| 最多一次 repair | ✅ | CAS `none → claimed → completed` + `repair_attempt_count CHECK (0..1)` |
| Hard failure 0 激活 | ✅ | 修复后重新运行同一 assessor，hard failure → job 失败 |
| schema_unparseable 不进入 repair | ✅ | 直接失败，不调用 Provider |
| Provider maxAttempts=1 | ✅ | `postJsonToPublicEndpoint`/`callOnce` 原生 HTTP 无重试 |
| Draft/final artifact lineage | ✅ | `parentArtifactId` 指向 draft artifact |
| Repair logAICall | ✅ | `operation = "generate_card_repair"` 审计日志 |
| Card Repair Gold v1 人工标注 | ⏳ | 需真实数据集 ≥ 30 个含缺陷 card draft |

## Gate 2：Repair Gold 与既有 90/85/85 指标达标

| 检查项 | 状态 | 备注 |
| --- | --- | --- |
| Reason code 稳定性 | ✅ | 12 个 reason codes（hard/soft/terminal） |
| Hard trigger 精度 | ✅ | quote_not_in_source、claim_quote_unrelated、insufficient_valid_key_points、schema_invalid_bounded |
| Soft trigger | ✅ | claim_too_short、claim_vague、duplicate_key_point、coverage_too_low、claim_quote_too_similar |
| 非回归 | ⏳ | 需真实 Provider 验证既有 90/85/85 指标 |
| 修复后 hard gate | ✅ | 同一 assessor 重跑 |

## Gate 3：成本、延迟和 repair 触发率可按 provider/model/prompt 分桶

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| ProviderUsage 接口 | ✅ | `totalTokens, promptTokens, completionTokens, requestId` |
| getLastUsage() 方法 | ✅ | Mock/DashScope/OpenAI-compatible 三个 Provider 均实现 |
| costTokens 真实写入 | ✅ | artifact 插入 + logAICall 审计日志 |
| inputHash 真实写入 | ✅ | SHA-256 Provider 输入指纹 |
| logAICall 审计日志 | ✅ | provider/model/duration/dataSize/status/errorMessage/costTokens |
| Repair 触发率分桶 | ✅ | repair 调用单独记录 logAICall |

## 交付物清单

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| assessCardOutput | `workers/ai-worker/src/lib/card-quality.ts` | ✅ |
| RepairCardInput + repairCard | `workers/ai-worker/src/lib/ai-provider.ts` | ✅ |
| Mock repairCard | `workers/ai-worker/src/lib/providers/mock.ts` | ✅ |
| DashScope repairCard | `workers/ai-worker/src/lib/providers/dashscope.ts` | ✅ |
| OpenAI-compatible repairCard | `workers/ai-worker/src/lib/providers/openai-compatible.ts` | ✅ |
| CAS repair state | `workers/ai-worker/src/handlers/index.ts` | ✅ |
| ProviderUsage + readUsage | `workers/ai-worker/src/lib/providers/json-response.ts` | ✅ |
| repair_state/repair_attempt_count | `apps/api/src/db/schema/job.ts` | ✅ |

## 测试覆盖

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `card-assess-repair.test.ts` | 12 | ✅ 全绿 |
| `v06-telemetry-privacy-scan.test.ts` | 4 | ✅ 全绿 |
| `mock-v06.test.ts` | — | ✅ 全绿 |

## 总测试数

| 包 | 测试数 | 状态 |
| --- | --- | --- |
| `workers/ai-worker` | 537 | ✅ 全绿 |
