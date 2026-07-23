# ADR-0008：Playwright 浏览器验收底座与矩阵

- Status: Accepted
- Owner: Quality Owner
- Approver: repository owner
- Date: 2026-07-18

## Context

v0.4 CI 只做 Web HTTP smoke，没有真实浏览器、三视口、键盘、无障碍、page error 或 console error 门禁。v0.5 的邀请、onboarding 和 review attempt 无法仅靠 API 单测验收。

## Decision

1. 使用 Playwright Test，PR 默认 Chromium 1440；nightly/RC 覆盖 Chromium 390/768/1440，关键旅程加 Firefox 1440。WebKit 为 Could。
2. fixture 通过版本化、非生产可用的 seed CLI/script 创建两个 workspace、Owner、member、未消费邀请、服务端验证题、hard/soft evidence 和到期 schedule；禁止增加公开 HTTP seed 后门。51/100/1000 边界数据只在 nightly/RC profile 创建。每个 test worker 使用独立命名空间并可幂等清理。
3. 使用 `@axe-core/playwright` 扫描 WCAG 2.2 AA；serious/critical 为 0。核心路径同时用键盘执行并检查焦点、减少动画和可见错误恢复动作。
4. 全局监听 `pageerror`、unhandled rejection、request failed 与 `console.warn/error`。page error/资源安全错误永不 allowlist；console 例外必须精确匹配并记录 Issue、Owner、审批与最长 14 天到期日。
5. 测试重试只用于收集第二份 trace，首轮失败仍判失败。失败保留 screenshot、video/trace、console 和 JUnit 至少 90 天。
6. PR smoke 固定覆盖登录/登出/session、笔记与生成卡、evidence override、validation、review attempt、workspace 切换和权限拒绝；相关变更通过路径过滤增加定向旅程，但不得手写枚举测试文件。

## Alternatives

- Cypress：可行，但当前 Next/Fastify/多项目 fixture 与 Playwright 多浏览器/trace 能力更贴合既定矩阵。
- 只保留人工验收：拒绝，无法形成 RC 可重复门禁。
- 自动 retry 后任一成功即通过：拒绝，会掩盖 flake。

## Consequences

CI 需要浏览器镜像/缓存、真实 PostgreSQL fixture 和 artifact 存储。M1 必须先建 harness，M2/M3 同步增加旅程，不把基础设施拖到 M5。

## Migration

新增独立 `tests/e2e` package、Playwright config、fixture contract 与 console allowlist schema；先接登录/workspace smoke，再随垂直切片扩展。

## Rollback / Forward-fix

单个确认 flake 可按 14 天 allowlist 隔离，但核心安全路径不能关闭。基础设施故障与产品失败分开报告，修复后重跑原始 commit。

## Evidence

- v0.4 `.github/workflows/ci.yml` 没有浏览器框架或 E2E job。
- v0.5 计划 6.7 固定旅程、视口、浏览器错误和可访问性门禁。
