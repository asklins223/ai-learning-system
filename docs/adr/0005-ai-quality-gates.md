# ADR-0005：版本化黄金集与分层 AI 质量门禁

- Status: Accepted
- Owner: AI Quality Owner
- Approver: repository owner
- Date: 2026-07-18

## Context

v0.4 有 30 篇样本和质量阈值，但黄金标签主要依赖可变 workspace 表，CI 不执行发布级质量比较。真实 Provider 又会产生网络、配额、漂移和成本不确定性。

## Decision

1. 样本文本、黄金标签、评分器、prompt 和 Provider 配置分别版本化并提交；标签完整性是 PR 硬门禁。
2. PR 只运行 schema/parser/alignment/scorer 与固定 Mock，不访问付费网络。Nightly 的 10 篇真实 Provider 趋势属于 Should。
3. RC 使用 30 篇完整集运行两次，两次均须达到 hard citation precision 90%、key-point hard-evidence coverage 85%、expected-location hard-evidence coverage 85%。
4. 参考 Provider 为 DashScope-compatible `qwen-plus`。RC manifest 必须额外记录 endpoint origin、服务商返回或控制台确认的不可变 revision、运行时间、temperature 0.2、prompt/dataset/label/scorer 版本；如果只能获得漂移别名且没有 revision 证据，RC 保持阻断。
5. 网络、DNS、认证、额度和服务商 5xx 与 schema/空结果/内容质量分开统计；只有基础设施失败可在 30 分钟内最多重试两次。
6. 单次 RC 成本上限 10 美元等值。超限停止，必须取得新的 Owner 预算批准，不得删样本规避。
7. 后续 RC 同配置两轮均值相对上一个已接受 RC 不得下降超过 2 个百分点；数据集或阈值变化必须新增决策记录。

## Alternatives

- 每个 PR 调真实模型：拒绝，成本和非确定性会污染代码门禁。
- 只保存结果、不提交标签：拒绝，无法复现或审计指标。
- 失败后替换难样本：拒绝，会静默优化指标而非产品。

## Consequences

RC 需要受控凭据、预算和 Provider revision 证据。没有这些外部输入时可以继续开发，但不能声明 AIQ gate 通过。

## Migration

把现有 30 篇样本迁入固定 dataset 目录，导出现有标签后人工复核并冻结；新增纯函数评分器和确定性 fixture，再接 RC runner。

## Rollback / Forward-fix

评分器 bug 通过新版本修复并重跑全部历史可比基线；不覆盖旧报告。Provider 故障只延迟 RC，不降低阈值。

## Evidence

- v0.4 benchmark contract 测试确认 30 篇唯一样本与 90/85/85 阈值存在。
- M0 基线未发现 CI 中的真实质量比较 job。
