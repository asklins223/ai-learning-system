# M3 Gate 证据：逐点评估与 Review 集成

> 里程碑：M3<br>
> 执行人：`@asklins223`<br>
> 日期：2026-07-25<br>
> 关联 Git commit：`v0.6-implementation` 分支 HEAD

## Gate 1：Evaluation Gold 和 false-mastery 门禁通过

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| Rubric 逐点评估 | ✅ | `evaluate-rubric.ts` 校验一一对应、unknown ID、answerExcerpt 真实子串 |
| 确定性 reducer | ✅ | `reduceRubric` 纯函数从 assessments 重算 outcome |
| unable 确定性路径 | ✅ | `unableToAnswer` 为每个 rubric item 写 missing assessment + 系统 artifact |
| False-mastery 防护 | ✅ | contradiction 阻断升级、required 全 covered、加权 ≥ 70% |
| Evaluation Gold v1 人工标注 | ⏳ | 需真实数据集 ≥ 120 个回答 |
| false-mastery rate ≤ 5% | ⏳ | 需真实 Provider + 人工标注 |

## Gate 2：Provider/job/fingerprint 失败不会错误升级或丢答案

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| Provider 失败 → evaluation_retryable | ✅ | 不写半套 assessment，保留最终答案 |
| Fingerprint 不匹配 → STALE | ✅ | 事务内校验 source fingerprint |
| Question 过期 → STALE | ✅ | 事务内检查 expires_at |
| hasHardEvidence 事务内重查 | ✅ | 事务内重新查询 txRubricItems |
| Understanding event 在 hasHardEvidence 后写入 | ✅ | hasHardEvidence=false 时降级为 "seen" |
| Stale/assisted 不产生升级 | ✅ | shouldMutateSchedule=false |
| 答案保存成功率 100% | ✅ | submit 原子写入答案 + evaluation job |

## Gate 3：validation 与 review 共用相同 reducer/scheduling policy

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| 共用 reducer | ✅ | `reduceRubric` 在 AI 评估和 unable 路径均使用 |
| 共用 scheduling | ✅ | `calculateSchedule()` 统一分发器 |
| initial_validation 分支 | ✅ | 断言无 reviewAttemptId、检查 pending schedule 冲突、创建首条 schedule |
| review 分支 | ✅ | 锁定 review attempt + input schedule、完成 input、创建后继 |
| Review attempt 标记 completed | ✅ | 完成后更新 status=completed |
| generation 递增 | ✅ | 后继 schedule generation = input.generation + 1 |
| FSRS shadow 写入 | ✅ | 只对 unassisted 结果写入，shadow 对正式 schedule 零影响 |

## 交付物清单

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| evaluate_rubric handler | `workers/ai-worker/src/handlers/evaluate-rubric.ts` | ✅ |
| Validation Session API (10 端点) | `apps/api/src/modules/validation/session-service.ts` | ✅ |
| Session Routes | `apps/api/src/modules/validation/session-routes.ts` | ✅ |
| Session Schema | `apps/api/src/modules/validation/session-schema.ts` | ✅ |
| dispatchEvaluateValidation | `workers/ai-worker/src/index.ts` | ✅ |
| Review later action command 迁移 | `apps/api/src/modules/review/attempt-service.ts` | ✅ |
| 导出/导入 v0.6 新表 | `apps/api/src/modules/export/service.ts` | ✅ |
| 遥测隐私扫描 | `apps/api/src/__tests__/v06-telemetry-privacy-scan.test.ts` | ✅ |

## 测试覆盖

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `apps/api/src/__tests__/v06-cache-control-contract.test.ts` | 9 | ✅ 全绿 |
| `apps/api/src/__tests__/v06-telemetry-privacy-scan.test.ts` | 4 | ✅ 全绿 |
| `apps/web/lib/__tests__/v06-session-contract.test.ts` | 20 | ✅ 全绿 |
| `apps/api/src/integration-tests/v06-validation-session-postgres.integration.ts` | 14 | ✅ 全绿（需 DB） |

## 总测试数

| 包 | 测试数 | 状态 |
| --- | --- | --- |
| `apps/api` | 1361 | ✅ 全绿 |
| `workers/ai-worker` | 537 | ✅ 全绿 |
