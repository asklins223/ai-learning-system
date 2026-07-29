# M0 Gate 证据：基线与决策冻结

> 里程碑：M0<br>
> 执行人：`@asklins223`<br>
> 日期：2026-07-24<br>
> 关联 Git commit：`v0.6-implementation` 分支 HEAD

## Gate 1：Base SHA、migration end、Owner、预算和证据路径明确

| 项目 | 值 | 状态 |
| --- | --- | --- |
| Base SHA | `40fdf1c`（merge: complete v0.5 workspace implementation） | ✅ 已确认 |
| 迁移末端 | `0039_sec01_policy_catalog_repair.sql` | ✅ 已确认 |
| 下一可用迁移编号 | `0040` | ✅ 已确认 |
| v0.6 分支 | `v0.6-implementation` | ✅ 已确认 |
| Product Owner | `@asklins223` | ✅ 已确认 |
| Learning Loop Owner | `@asklins223` | ✅ 已确认 |
| AI Quality Owner | `@asklins223` | ✅ 已确认 |
| Security/Data Owner | `@asklins223` | ✅ 已确认 |
| Web UX Owner | `@asklins223` | ✅ 已确认 |
| Release Owner | `@asklins223` | ✅ 已确认 |
| 证据路径 | `docs/evidence/v0.6/` | ✅ 已创建 |
| RC 成本预算 | 待确认真实 Provider 凭据后冻结 | ⏳ 进行中 |

### v0.5 遗留门禁状态

| 门禁 | 状态 | 处置 |
| --- | --- | --- |
| 覆盖率门禁（8 项） | 未关闭 | 持续门禁，与 v0.6 并行推进 |
| SEC-01 RLS 正式启用 | 未关闭 | 持续门禁，M1 扩展 RLS 时一并推进 |
| AI Quality RC | 未关闭 | M2/M3 AIQ 黄金集达标后推进 |
| Alpha 运维证据 | 未关闭 | M7 RC 阶段推进 |
| 发布与观察期 | 未关闭 | M7 阶段推进 |

### 当前工作树能力归属

| 能力 | 归属 | 备注 |
| --- | --- | --- |
| 多工作区（Personal Workspace First、切换、加入/退出） | v0.5 baseline candidate | 已进入工作树，绑定 clean SHA 后纳入 |
| 头像和笔记图片 | v0.5 baseline candidate | 已进入工作树 |
| Source ingestion simplification | v0.6 工作树变更 | 当前 dirty worktree 中的未提交变更 |
| 安全能力（RLS、rate limit、policy catalog） | v0.5 baseline candidate | 已进入工作树 |

## Gate 2：v0.6 Must/Should/Could 与删减线获批

| 范围 | 状态 | 定义位置 |
| --- | --- | --- |
| Must（8 个工作包） | ✅ 已批准 | 计划 §5.1 |
| Should（6 项） | ✅ 已批准 | 计划 §5.2 |
| Could（4 项） | ✅ 已批准 | 计划 §5.3 |
| 删减线 | ✅ 已批准 | 计划 §5.4 |

## Gate 3：不存在另一份可编辑 v0.6 范围文档

| 检查项 | 状态 |
| --- | --- |
| Canonical 计划路径唯一 | ✅ `docs/plans/AI学习系统-v0.6-版本实施计划-2026-07-22.md` |
| 计划索引已更新 | ✅ `docs/plans/README.md` |
| 实施登记册已创建 | ✅ `docs/plans/v0.6-implementation-register.md` |

## 冻结的契约版本

| 契约 | 版本 | 定义位置 |
| --- | --- | --- |
| Question Provider | `generateValidationQuestion-v1` | 计划 §7.1 |
| Evaluation Provider | `evaluateRubric-v1` | 计划 §7.2 |
| Rubric Reducer | `rubric-reducer-v1` | 计划 §7.3 |
| Scheduling Policy | `discrete-v2` | 计划 §10.6 |
| FSRS Shadow | `fsrs-shadow-v1` | 计划 §6.8 |
| Source Fingerprint | `source-fingerprint-v1` | 计划 §6.7 |
| Exposure Fingerprint | `exposure-fingerprint-v1` | 计划 §6.7 |

## Feature Flags

| Flag | 默认值 | 回滚行为 |
| --- | --- | --- |
| `AI_QUESTION_V1_ENABLED` | `false` | 回退到客户端题面（只读历史，不升级） |
| `RUBRIC_EVALUATION_V1_ENABLED` | `false` | 回退到旧 evaluation |
| `QUESTION_FIRST_UI_ENABLED` | `false` | 回退到同屏 ValidationPanel |
| `CARD_REPAIR_V1_ENABLED` | `false` | 回退到单次 sanitizeCardOutput |
| `SCHEDULER_POLICY_VERSION` | `discrete-v1` | 保持旧策略 |
| `FSRS_SHADOW_ENABLED` | `false` | 不写 shadow 数据 |

## M0 开放决策默认建议

| 决策 | 默认建议 | 状态 |
| --- | --- | --- |
| v0.6 Base SHA | `40fdf1c` | ✅ 已冻结 |
| Question 题型 | Must: explain/example/apply | ✅ 已采纳 |
| Reducer 阈值 | 加权覆盖 ≥ 70%，required 全 covered，contradiction 阻断 | ✅ 已采纳 |
| 自信度 | 三档，仅 UI/分析 | ✅ 已采纳 |
| 查看原文 | 允许但永久标记 assisted | ✅ 已采纳 |
| Card repair | 最多一次，同 Provider/model | ✅ 已采纳 |
| FSRS 实现 | pin 维护中的库，只 shadow | ✅ 已采纳 |
| Question 有效期 | fingerprint 优先，默认 30 天 | ⏳ M1 冻结 |
| Rubric item 数量 | AI 2~5，fallback 1 | ⏳ M1 冻结 |
| FSRS rating | correct→Good, partial→Hard, incorrect/unable→Again | ⏳ M1 冻结 |
