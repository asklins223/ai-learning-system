# M4 Gate 证据：Question-first UX

> 里程碑：M4<br>
> 执行人：`@asklins223`<br>
> 日期：2026-07-25<br>
> 关联 Git commit：`v0.6-implementation` 分支 HEAD

## Gate 1：未辅助提交前全部网络/RSC/hydration/预取/DOM 隐藏结构字段为 0

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| SanitizedQuestion DTO 字段白名单 | ✅ | `v06-api-client.test.ts` 验证 18 个敏感字段不泄漏 |
| SanitizedReviewItem 字段白名单 | ✅ | `v06-review-leakage.test.ts` 12 个测试 |
| Cache-Control: private, no-store 全覆盖 | ✅ | `v06-cache-control-contract.test.ts` 9 个测试 |
| Exposure fingerprint 跨版本不变性 | ✅ | `fingerprint-invariant.test.ts` 26 个测试 |
| RSC/hydration "use client" 验证 | ✅ | `v06-dom-leakage.test.ts` 源码级验证 |
| 禁止敏感字段引用 | ✅ | `v06-dom-leakage.test.ts` 源码扫描 |
| Review 页面 sanitized API | ✅ | `v06-dom-leakage.test.ts` 验证 listSanitizedReviews/getReviewFocusMeta |
| Action command 幂等回放 | ✅ | `v06-session-contract.test.ts` 20 个测试 |
| Draft revision CAS 冲突 | ✅ | `v06-session-contract.test.ts` |
| unable/submit 响应最小化 | ✅ | `v06-session-contract.test.ts` |
| blocked 状态明确 | ✅ | `v06-session-contract.test.ts` |
| 100dvh + safe-area-inset-bottom | ✅ | `v06-keyboard-a11y.test.ts` 源码级验证 |
| Touch target 44px | ✅ | `v06-keyboard-a11y.test.ts` |
| role=alert | ✅ | `v06-keyboard-a11y.test.ts` |
| prefers-reduced-motion | ✅ | `v06-keyboard-a11y.test.ts` + validation-focus.css |
| Dark mode | ✅ | `v06-keyboard-a11y.test.ts` |
| ARIA 属性 | ✅ | `v06-keyboard-a11y.test.ts` |
| Cmd/Ctrl+Enter | ✅ | `v06-keyboard-a11y.test.ts` |
| E2E 泄漏检测 | ⏳ | E2E scaffold 已定义（`v06-e2e-scaffold.test.ts`），需安装 Playwright 运行 |

## Gate 2：首次验证、复习、查看原文/结果、unable、later、blocked、重试、冷却和恢复 E2E 全绿

| 场景 | 代码实现 | E2E 测试 |
| --- | --- | --- |
| 首次验证 Focus | ✅ | ⏳ 需 Playwright |
| 复习 Focus | ✅ | ⏳ 需 Playwright |
| 查看原文（assistance） | ✅ | ⏳ 需 Playwright |
| 结果揭示 | ✅ | ⏳ 需 Playwright |
| unable | ✅ | ⏳ 需 Playwright |
| later | ✅ | ⏳ 需 Playwright |
| blocked (no_hard_evidence/assistance_cooldown/unsafe_fallback) | ✅ | ⏳ 需 Playwright |
| question retry | ✅ | ⏳ 需 Playwright |
| evaluation retry | ✅ | ⏳ 需 Playwright |
| 冷却恢复 | ✅ | ⏳ 需 Playwright |
| refresh/跨设备恢复 | ✅ | ⏳ 需 Playwright |
| Review 后台完成不导航 | ✅ | ⏳ 需 Playwright |

> E2E scaffold 已定义 7 个场景 + 3 视口 + WCAG 配置，待安装 Playwright 后运行。

## Gate 3：390/768/1440、键盘、200% zoom 和 WCAG 门禁通过

| 检查项 | 源码级验证 | E2E 验证 |
| --- | --- | --- |
| 390×844 视口 | ✅ CSS 响应式断点 | ⏳ 需 Playwright |
| 768×1024 视口 | ✅ CSS 响应式断点 | ⏳ 需 Playwright |
| 1440×900 视口 | ✅ CSS 响应式断点 | ⏳ 需 Playwright |
| 键盘导航 | ✅ Cmd/Ctrl+Enter、role=alert | ⏳ 需 Playwright |
| 200% zoom | ✅ CSS rem 单位 | ⏳ 需 Playwright |
| WCAG 2.2 AA | ✅ ARIA、touch target、color | ⏳ 需 axe-core |
| reduced motion | ✅ @media (prefers-reduced-motion) | ⏳ 需 Playwright |

## 交付物清单

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| ValidationFocus 组件 | `apps/web/components/ValidationFocus.tsx` (~550 行) | ✅ |
| validation-focus.css | `apps/web/app/styles/validation-focus.css` | ✅ |
| 卡片验证 Focus 路由 | `apps/web/app/(workspace)/(focus)/cards/[id]/validate/page.tsx` | ✅ |
| Review Focus 路由 | `apps/web/app/(workspace)/(focus)/review/[scheduleId]/page.tsx` | ✅ |
| Review 安全队列 | `apps/web/app/(workspace)/(default)/review/page.tsx` | ✅ |
| Feature Flag (客户端) | `apps/web/lib/feature-flags.ts` | ✅ |
| Feature Flag (服务端) | `packages/shared/src/feature-flags.ts` | ✅ |
| 统一调度 | `packages/shared/src/scheduling-unified.ts` | ✅ |
| Review 安全端点 | `apps/api/src/modules/review/routes.ts` + `service.ts` | ✅ |
| E2E scaffold | `apps/web/lib/__tests__/v06-e2e-scaffold.test.ts` | ✅ 已定义 |

## 测试覆盖

| 测试文件 | 测试数 | 状态 |
| --- | --- | --- |
| `v06-api-client.test.ts` | 19 | ✅ 全绿 |
| `v06-review-leakage.test.ts` | 12 | ✅ 全绿 |
| `v06-session-contract.test.ts` | 20 | ✅ 全绿 |
| `v06-cache-control-contract.test.ts` | 9 | ✅ 全绿 |
| `v06-keyboard-a11y.test.ts` | — | ✅ 全绿 |
| `v06-dom-leakage.test.ts` | — | ✅ 全绿 |
| `feature-flags.test.ts` (web) | 8 | ✅ 全绿 |
| `feature-flags.test.ts` (shared) | 16 | ✅ 全绿 |
| `scheduling-unified.test.ts` | 19 | ✅ 全绿 |
| `fingerprint-invariant.test.ts` | 26 | ✅ 全绿 |

## 总测试数

| 包 | 测试数 | 状态 |
| --- | --- | --- |
| `apps/web` | 263 | ✅ 全绿 |
| `packages/shared` | 352 | ✅ 全绿 |
| `apps/api` | 1361 | ✅ 全绿 |
