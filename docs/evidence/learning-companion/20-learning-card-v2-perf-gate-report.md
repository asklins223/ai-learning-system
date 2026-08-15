# 方案 20 §23.7 — V2 性能 Gate 测量报告（R35）

> 环境：production-like（真实 postgres docker pg16 + worker 确定性管道 + 真实网络栈），
> 单机 dev 容器。测量脚本：`workers/ai-worker/src/integration-tests/v2-perf-measure.ts`
> （`ROUNDS=20 LLM_SAMPLE=1`，2026-08-15）。
> 方法：20 轮独立 workspace 的 micro-note 全旅程计时，p50/p90/p95 百分位。

## 1. 实测结果对照门槛表

| 指标 | 门槛 | 实测 | 状态 |
|---|---:|---:|---|
| 创建 Generation Run API p95 | ≤ 1s | **122.8ms**（p50 37.8 / p90 120.2 / max 149.6） | ✅ 达标 |
| 首个可见进度 p95 | ≤ 2s | 同 create（事件同事务写入，≤150ms） | ✅ 达标 |
| micro-note 到 review/zero-card p95 | ≤ 20s | **117.1ms**（p50 45.4 / p90 104.0 / max 201.3，确定性模式） | ✅ 达标 |
| micro-note review-ready 后完成决策 p50/p90 | ≤ 10s/≤30s | 确定性 <200ms；LLM 模式依赖平台 | ✅（确定性）/ 待平台 |
| activation API p95 | ≤ 2s | **未测**（需 production 负载；单次路径 30–80ms 量级，R32/R33 实测） | 待 production |
| reveal exposure-first 成功率 | 100% | 机制级 100%（C18 exposure-first 事务断言）；压测未做 | 待 production |
| Run PREPARE target snapshot 成功率 | ≥99.9% | C5/C38/redaction IT 全路径通过（合法 active target）；失败均 fail-closed（预期内） | 待 production 计数 |
| 非 provider 原因成功终态率 | ≥98% | 确定性 30/30 E2E + 20/20 测量轮全成功 | ✅ |
| Candidate repair rate | ≤20% | LLM 模式 bounded repair 单次上限（代码级 ≤1 次/候选） | 待平台统计 |
| provider retry amplification | ≤1.25 | retryable 仅平台 5xx/429/超时，attempts≤3（代码级 bound） | 待平台统计 |
| quick review 首屏交互 p95 | ≤1s | 未测（Web 交互，需 production） | 待 production |

## 2. LLM 模式参考采样

真实 provider（tokenrhythm/deepseek-v4-flash-0731，配置平台）单轮全旅程
（含 planner/author/grounding/pedagogy 四次调用）：**60.1s**。
provider 网络/推理延迟主导；平台抖动（503/空输出）由 retryable 重试兜底。
§23.7 的 LLM 相关门槛（决策 p50/p90、repair rate、retry amplification）
需在平台稳定窗口内以 production-like 流量统计，R35 如实记录未定论。

## 3. 结论与后续

- 确定性/工程侧门槛（API p95、旅程 p95、成功终态率）**达标**；
- production 侧门槛（activation p95、reveal 压测、PREPARE 成功率计数、
  首屏交互）需上线后由 dashboard/告警（§24.2/§24.3）持续观测，已列入
  §24.7 runbook 的事前检查；
- 测量脚本可重复执行（`ROUNDS`/`LLM_SAMPLE` 可调），作为回归基准。
