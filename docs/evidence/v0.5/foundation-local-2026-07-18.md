# v0.5 foundation 本地验证证据（2026-07-18）

> Status: Partial / Development evidence。本记录主体验证 foundation/expand 本地实现，并附当前分支增量 Actions 证据；它仍不代表 M0/M1 Gate 或 RC 通过。

## 绑定范围

- 开发起点：`33efa06f8c0a5f2d1e97e12dcb745b2314c606e8`
- 分支：`codex/v0.5-implementation`
- Foundation commit：`5b5591f20afd6ccac33a2158b2dba6c9e1503b16`
- 运行环境：Darwin/arm64，Node `v22.16.0`
- Git 状态复核：分支已推送并与 `origin/codex/v0.5-implementation` 同步；工作树 clean

## 自动化结果

| 验证 | 结果 |
| --- | --- |
| `make verify` | pass；233 pass、0 fail/skip/todo |
| Release/version contract | 13/13 pass |
| Shared | typecheck pass；22/22 test pass |
| Database package | typecheck pass；11-file schema mirror pass |
| API | typecheck pass；106/106 unit pass |
| Web | typecheck、ESLint pass；69/69 test pass |
| Worker | typecheck pass；23/23 test pass |
| PostgreSQL rate-limit integration | 隔离 PostgreSQL 16 上另行 1/1 pass；见 SEC-01 expand 证据 |
| Production builds | API、Web、Worker pass |
| Production dependency audit | 五个 package root 均为 0 vulnerabilities；审计后 dependency/lockfile 未变 |
| Release manifest JSON Schema | Draft 2020-12 validation pass |
| CI YAML parse | pass |
| `git diff --check` | pass |

本轮合计 233 项 `make verify` 检查，加 1 项真实 PostgreSQL integration，共 234 项通过。

## Clean release input 复核

Node `v22.16.0` 在 foundation clean commit 上执行 `verify-release-inputs` 通过，当时 19 个 journal migration 输入均已跟踪。后续 `1d2cada` clean commit 已确认当前 20 个 migration 输入完整，并由 Actions 的 Clean Release Inputs job 复核通过。

## 后续 expand 验证增量

同日以 Node `v22.21.1` 复跑当前 expand 工作树：`make verify` 246 pass、0 fail/skip/todo，API/Web/Worker production build 均通过；另在隔离 PostgreSQL `16.14` 上完成 rate-limit 1 项、RLS policy 1 项和双 Worker queue 5 项。完整范围与 enforce 阻断项见 SEC-01 expand 证据，本节不把增量结果改写为 foundation commit 本身的历史结果。

修复后的 [Actions run 29648766086](https://github.com/asklins223/ai-learning-system/actions/runs/29648766086) 绑定 `1d2cada4f7318c52ffc9c64c40e2b4c640c0c17a`，6/6 job success；Node artifact digest 为 `sha256:dbde1688abc20574d1ae2e187f0ce33d12f5ad87ddbb3678797818ddbec93907`，PostgreSQL artifact digest 为 `sha256:8318901612e226b79ae0229e7caed755d30ffdfa3fb577ab6b11020d772c5fab`。该结果属于 v0.5 分支增量，不替代 immutable v0.4 baseline 所需的原始 artifact。

## 尚未覆盖

1. immutable v0.4 baseline 对应的原始 CI artifact、全仓/关键模块/changed-lines coverage、浏览器 E2E、扫描和 AIQ 真实 Provider 报告；
2. SEC-01 RLS enforce、API 请求池 1,000 次交替复用和完整 Worker handler side effect/renew 故障矩阵；当前只覆盖 Worker `max: 1` 池与 jobs 双 session 子场景；
3. 邀请 token 的数据库/API 生产接入、成员/onboarding 旅程；
4. review attempt 持久化事务、幂等约束、API/UI、导出删除和 E2E；
5. 机器 gate report digest 聚合、镜像/部署 provenance、独立 human security/data review。
