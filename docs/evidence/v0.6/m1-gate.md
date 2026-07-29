# M1 Gate 证据：Schema、RLS 与纯策略

> 里程碑：M1<br>
> 执行人：`@asklins223`<br>
> 日期：2026-07-25<br>
> 关联 Git commit：`v0.6-implementation` 分支 HEAD

## Gate 1：fresh/upgrade/repeat/restore migration 通过

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| Migration 0040 (`0040_v06_trusted_mastery_schema.sql`) | ✅ 已创建 | 含 7 新表 + 5 现有表扩展 + RLS policies |
| Migration 0041 (`0041_v06_quality_signals.sql`) | ✅ 已创建 | quality signals 表 |
| Schema mirror (`packages/db/src/schema/`) | ✅ 已同步 | validation-v2.ts、evidence.ts、ai.ts、job.ts |
| Fresh migration | ⏳ 需 PostgreSQL 集成测试 | 设计已验证，待运行 |
| Representative v0.5 upgrade | ⏳ 需 PostgreSQL 集成测试 | 设计已验证，待运行 |
| Repeat migration | ⏳ 需 PostgreSQL 集成测试 | 设计已验证，待运行 |
| Backup/restore | ✅ 导出/导入已实现 | export/service.ts 新增 8 张新表导出/恢复 |

## Gate 2：RLS 多 workspace/多 user 矩阵 0 泄漏

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| 新表 RLS policy 定义 | ✅ | migration 0040 含全部 7 新表 RLS |
| user-private 表 RLS | ✅ | validation_submissions、validation_action_commands、validation_assistance_exposures、validation_point_assessments、scheduling_shadow_decisions 均定义 user-level RLS |
| 跨 workspace/user 隔离测试 | ⏳ 需 PostgreSQL 集成测试 | RLS policy 已定义，待运行验证 |

## Gate 3：reducer、assistance 和 schedule 表驱动测试全绿

### Rubric Reducer v1 (`rubric-reducer.ts`)

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared/src/rubric-reducer.test.ts` | 101 | ✅ 全绿 |

覆盖：6 条规则总序、25 种 verdict 组合 × 2 配置、加权覆盖度计算、fail-closed 边界、权重变体、错误处理。

### discrete-v2 调度策略 (`scheduling-policy-v2.ts`)

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared/src/scheduling-policy-v2.test.ts` | 53 | ✅ 全绿 |

覆盖：partial 不推进、source_viewed 冷却门禁、stale/provider_failure 不改 schedule、effective review start = max(next_review_at, unassisted_eligible_after)、全 interval tier、时间注入。

### Source/Exposure Fingerprint (`fingerprint.ts`)

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared/src/fingerprint.test.ts` | 30 | ✅ 全绿 |
| `packages/shared/src/fingerprint-invariant.test.ts` | 26 | ✅ 全绿 |

覆盖：SHA-256 组件化、exposure 冷却门禁、exposure fingerprint 跨版本不变性（prompt/rubric/model 变化时 exposure fingerprint 不变）、source fingerprint 对内容变化敏感性、冷却门禁不变性、确定性与格式。

### Question Safety (`question-safety.ts`)

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared/src/question-safety.test.ts` | — | ✅ 全绿 |

覆盖：claim/quote/expectedConcept 泄露检测、prompt injection 检测、invalid evidence ref 独立 reason code。

### Deterministic Question (`deterministic-question.ts`)

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared/src/deterministic-question.test.ts` | — | ✅ 全绿 |

覆盖：fallback 措辞生成、1 个 required rubric item 绑定 claim 与 hard evidence。

### Scheduling Unified (`scheduling-unified.ts`)

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared/src/scheduling-unified.test.ts` | 19 | ✅ 全绿 |

覆盖：v1/v2 策略分发、partial 在 v1 推进/v2 不推进、source_viewed 差异、guard check 一致性。

### Feature Flags (`feature-flags.ts`)

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared/src/feature-flags.test.ts` | 16 | ✅ 全绿 |

覆盖：5 个 flag 默认值/启用/禁用、fail-closed 不变量。

## 总测试数

| 包 | 测试数 | 状态 |
| --- | --- | --- |
| `packages/shared` | 352 | ✅ 全绿 |

## 交付物清单

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| v0.6 共享枚举 | `packages/shared/src/enums.ts` | ✅ |
| rubric-reducer-v1 纯函数 | `packages/shared/src/rubric-reducer.ts` | ✅ |
| discrete-v2 调度策略 | `packages/shared/src/scheduling-policy-v2.ts` | ✅ |
| 统一调度分发器 | `packages/shared/src/scheduling-unified.ts` | ✅ |
| source/exposure fingerprint | `packages/shared/src/fingerprint.ts` | ✅ |
| question safety | `packages/shared/src/question-safety.ts` | ✅ |
| deterministic question fallback | `packages/shared/src/deterministic-question.ts` | ✅ |
| feature flags | `packages/shared/src/feature-flags.ts` | ✅ |
| Schema (7 新表) | `apps/api/src/db/schema/validation-v2.ts` | ✅ |
| Schema mirror | `packages/db/src/schema/validation-v2.ts` | ✅ |
| Migration 0040 | `apps/api/src/db/migrations/0040_v06_trusted_mastery_schema.sql` | ✅ |
| Migration 0041 | `apps/api/src/db/migrations/0041_v06_quality_signals.sql` | ✅ |

## 二十一轮审查修复

M1-M3 代码经过二十一轮对照计划的深度审查，共修复 50+ 个问题，覆盖：
- 事务内 fingerprint/question/schedule FOR UPDATE 重读
- 跨 submission exposure 检测
- 调度前置检查（pending schedule 冲突、review attempt 锁定、input schedule PENDING 校验）
- understanding event 与 hasHardEvidence 顺序
- exposure 原子 upsert
- artifact type 合规性
- failureCode 一致性

最终审查（第二十一轮）确认 0 项修复，代码层面审查完结。
