# ADR-0006：遥测、隐私 allowlist 与 Alpha SLO

- Status: Accepted
- Owner: Platform Owner
- Approver: repository owner `@asklins223`（development self-review；独立 security/data review 待 RC）
- Date: 2026-07-18

## Context

v0.4 主要依赖 Pino 日志、health/readiness 和 AI audit rows。v0.5 需要计算 SLO、定位 request/job/lease/provider 链路，同时禁止把学习正文、回答、密钥或 Provider 原始响应复制到遥测系统。

## Decision

1. 暴露 Prometheus-compatible metrics；结构化日志继续使用 Pino。指标 label 必须为低基数 allowlist。
2. 允许事件仅包括：invite created/consumed/revoked、onboarding step/completed、card generation terminal、validation submitted/terminal、review attempt terminal、job claimed/retried/dead/lease-lost、provider call terminal、backup terminal、release deployed/rolled-back。
3. 允许属性：事件版本、环境、release/commit/migration、HTTP method/route template/status class、duration bucket、job type/status/retry count、provider/model identifier、错误分类、对象类型、布尔/计数、HMAC 后的 workspace/user 标识。禁止任意自由文本属性。
4. 永不记录 Note/Source/answer/quote/question 正文、API Key、Cookie、CSRF、Authorization、完整 URL query、Provider 原始请求/响应、完整 lease token。关联只记录 requestId、jobId 和 lease token 的不可复用短 fingerprint。
5. 运行日志默认保留 30 天，指标 90 天，安全/AI audit 180 天，发布与恢复证据长期随版本保留；访问限 platform/security Owner。Alpha 用户删除后，HMAC 标识无法反查，业务 audit 按删除规则处理。
6. SLO 计算和最小样本严格采用 v0.5 计划 4.2；样本不足显示 `insufficient_data`。跨 workspace、secret 泄漏和不可恢复数据丢失容忍度为 0。
7. 自动 privacy scan 使用 canary secret/正文片段验证日志、metrics、trace artifact 中不存在禁采内容。

## Alternatives

- 先接通用 analytics 再清理字段：拒绝，默认采集面过宽。
- 用原始 workspace/user UUID 作外部 label：拒绝，增加可关联性和指标基数。
- 完整 tracing 作为 Must：延后，先完成 SLO 必需指标和告警。

## Consequences

任何新增事件或属性都需要 code review 修改 allowlist。自由文本错误必须先分类和清洗。完整 token/成本 Dashboard 与 tracing 属于 Should。

## Migration

先建立 telemetry facade 和 allowlist 单测，再替换散落的日志字段；最后接 metrics endpoint、告警规则和 privacy canary 扫描。

## Rollback / Forward-fix

发现泄漏时立即停用对应 exporter、轮换受影响 secret、删除可删除的遥测副本并记录事件；通过收窄 allowlist 前向修复，不扩大保留期。

## Evidence

- v0.4 `apps/api/src/lib/logger.ts` 和 `/health`、`/ready` 是现有底座。
- v0.5 计划 4.2 与 6.6 固定 SLI、隐私和告警范围。
