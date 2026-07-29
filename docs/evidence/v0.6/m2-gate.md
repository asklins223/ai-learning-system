# M2 Gate 证据：Question + Rubric

> 里程碑：M2<br>
> 执行人：`@asklins223`<br>
> 日期：2026-07-25<br>
> 关联 Git commit：`v0.6-implementation` 分支 HEAD

## Gate 1：question/rubric 原子性和 stale 并发测试通过

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| Question + rubric 原子落库 | ✅ | `generate-validation-question.ts` lease-fenced 事务内全成或全败 |
| Stale 并发处理 | ✅ | 事务内重新计算 fingerprint，不一致时标记 STALE |
| Source mutation 检测 | ✅ | 事务内重新查询 keyPoint/card/evidence，检测删除和变更 |
| Evidence overrides JOIN | ✅ | LEFT JOIN evidence_overrides 计算有效覆盖值 |
| Submission 状态迁移 | ✅ | markSubmissionsStale/markSubmissionsBlocked 带状态守卫 |
| 30 天过期 | ✅ | expiresAt = now + 30 天 |
| Artifact type 区分 AI/deterministic | ✅ | VALIDATION_QUESTION vs DETERMINISTIC_QUESTION |

### 原子性测试

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `apps/api/src/integration-tests/v06-validation-session-postgres.integration.ts` | 14 | ✅ 全绿（需 DB 环境） |

覆盖：concurrent review schedule completion、submission status state migration、exposure cooldown monotonic upsert、submissions active unique index、action commands unique index、FOR UPDATE 并发锁、draft revision CAS 冲突、quality signals 表结构与 RLS、shadow decisions unique constraint、jobs repair_state CHECK 约束。

## Gate 2：Question/Rubric Gold 达标

| 检查项 | 状态 | 备注 |
| --- | --- | --- |
| Question Safety hard gate | ✅ | `assessQuestionOutput` 检测 claim/quote/expectedConcept 泄露、prompt injection |
| Deterministic fallback | ✅ | `generateDeterministicQuestion` 生成安全 fallback |
| Fallback safety gate | ✅ | fallback 也必须通过同一 hard gate，失败 → question_blocked |
| Question/Rubric Gold v1 人工标注 | ⏳ | 需真实数据集 ≥ 60 个跨领域 key point |
| 答案泄漏 0 | ✅ | 源码级测试验证 SanitizedQuestion 不含敏感字段 |
| Hard-evidence support precision ≥ 95% | ⏳ | 需真实 Provider + 人工标注 |

## Gate 3：客户端题面不能产生升级

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| SanitizedQuestion DTO 字段白名单 | ✅ | `v06-api-client.test.ts` 19 个测试验证 18 个敏感字段不泄漏 |
| Legacy client-authored question 不升级 | ✅ | `legacy_unrubriced` 标记，不能进入可信读取 |
| 服务端净化 DTO | ✅ | `getValidationSession` 返回净化状态 |
| Feature flag fail-closed | ✅ | `AI_QUESTION_V1_ENABLED=false` → deterministic fallback |

## 交付物清单

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| generate_validation_question handler | `workers/ai-worker/src/handlers/generate-validation-question.ts` | ✅ |
| AIProvider.generateValidationQuestion | `workers/ai-worker/src/lib/ai-provider.ts` | ✅ |
| Mock Provider | `workers/ai-worker/src/lib/providers/mock.ts` | ✅ |
| DashScope Provider | `workers/ai-worker/src/lib/providers/dashscope.ts` | ✅ |
| OpenAI-compatible Provider | `workers/ai-worker/src/lib/providers/openai-compatible.ts` | ✅ |
| Handler 注册 | `workers/ai-worker/src/index.ts` | ✅ |
| Feature flag 门禁 | `isAIQuestionEnabled()` | ✅ |
| Provider Usage Tracking | `ProviderUsage` + `getLastUsage()` | ✅ |

## 总测试数

| 包 | 测试数 | 状态 |
| --- | --- | --- |
| `workers/ai-worker` | 537 | ✅ 全绿 |
| `apps/api` (integration) | 14 | ✅ 全绿（需 DB） |
