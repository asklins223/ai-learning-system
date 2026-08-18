# 冗余代码审计报告

> 审计日期：2026-08-18（第五轮补充：2026-08-18）
> 审计范围：`apps/`、`packages/`、`workers/`、`.github/scripts/`、`infra/`
> 审计方法：通过 feature flag 追踪、退役注释 grep、已删除文件残留引用检查、新旧版本共存模式分析、重复函数定义检测、死代码路径（if(false)/void 抑制）扫描、501 占位路由检查、退役类型枚举值分析、DB schema 镜像检测、前端路由残留检查、错误类定义普查、Schema V1 注释普查、API 客户端零调用方法检测、@deprecated 标注扫描、Infra 配置 V1 引用检测、恒 null/void 抑制调用链追踪、shared 零消费方 parse 函数检测、重复 URLSearchParams 构造模式分析、V1 遗留类型零 import 消费方检测、重复 helper/util 函数定义普查、重复错误发送函数检测、CSS 引用零确认

---

## 一、总结

项目正处于从 V1（学习卡 v0.5）向 V2（learning-card-v2 / 方案 20）的大规模迁移阶段。许多 V1 代码路径已被功能标记为退役或由 flag 切流到 V2，但旧代码、旧兼容层、旧占位脚本仍大量保留在代码库中。以下是按类别分类的冗余代码清单。

---

## 二、Feature Flag 驱动的新旧版本共存（旧版本仍在但已被 flag 绕过）

### 2.1 调度策略：discrete-v1 旧版逻辑

| 项目 | 详情 |
|---|---|
| **文件** | `packages/shared/src/scheduling-unified.ts` |
| **Flag** | `SCHEDULER_POLICY_VERSION`（默认 `"discrete-v1"`） |
| **冗余内容** | `calculateDiscreteV1Schedule()` 函数（约 120 行）及其辅助函数 `normalizeV1Interval`、`nextV1Tier` |
| **现状** | V2 `calculateDiscreteV2Schedule` 已在 `scheduling-policy-v2.ts` 实现，行为更正确（partial 不升级、assistance-aware）。V1 仅作为灰度回退默认值保留 |
| **退役标志** | 注释明确标注 "legacy v0.5 policy" 和 "v1 bug: partial advances like correct" |
| **建议** | 灰度完成后删除 V1 函数、常量 `DISCRETE_V1_INTERVAL_TIERS` 及其测试用例 |

### 2.2 Card Generation V1 Writer 停写开关

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/config/learning-companion-flags.ts` |
| **Flag** | `CARD_GENERATION_V1_WRITER_ENABLED` |
| **冗余函数** | `isCardGenerationV1WriterEnabled()` |
| **现状** | 该函数**仅在此文件中定义，全项目无任何调用方**。V2 已切流，V1 writer 已停写，但 flag 函数仍保留 |
| **建议** | 可直接删除该函数及其对应的 flag 文档 |

### 2.3 Fast 路径 / Planned 路径灰度机制

| 项目 | 详情 |
|---|---|
| **文件** | `packages/shared/src/feature-flags.ts`（第 295–356 行） |
| **Flag** | `FAST_PATH_ENABLED`、`FAST_PATH_ROLLOUT_PERCENT`、`PLANNED_PATH_ENABLED`、`PLANNED_PATH_ROLLOUT_PERCENT` |
| **冗余函数** | `isFastPathEnabled()`、`getFastPathRolloutPercent()`、`isRunInFastBucket()`、`isPlannedPathEnabled()`、`getPlannedPathRolloutPercent()`、`isRunInPlannedBucket()` |
| **现状** | 这 6 个函数**仅在 `feature-flags.ts` 中定义和测试文件中引用**，生产代码中无调用方。灰度机制设计完毕但未接线 |
| **建议** | 如果 Fast/Planned 路径不会启用，可删除这一整段（约 60 行） |

### 2.4 首页 Onboarding Legacy Fallback

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/home-onboarding.ts` |
| **Flag** | `NEXT_PUBLIC_COMPANION_JOURNEY_V2` |
| **现状** | 注释标注 "P6（2026-08-14 切流）：Journey V2 + system_pet_v2 已原子开启"。当 `isJourneyV2Enabled()` 为 true 时，直接返回 `showOnboarding: false`。旧 fallback 路径（第 28–34 行）仅在 flag 关闭时生效 |
| **建议** | P6 切流已完成后，旧 fallback 路径可移除，`resolveHomeOnboardingVisibility` 可简化为直接返回 false |

---

## 三、已删除 V1 表/模块的残留兼容代码

### 3.1 Note Service 中的 V1 退役注释与空逻辑

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/note/service.ts` |
| **冗余内容** | 多处 V1 退役注释块，实际逻辑已空 |
| **位置** | `canUpdateVersionInPlace`（第 357 行注释 "V1 退役：旧版学习卡 learningCards（V1 表）已删除"）<br>`deleteNote`（第 1188 行注释 "V1 退役：旧版学习卡…已随 V1 表删除"）<br>`restoreDeletedNote`（第 1230 行同上）<br>`physicalDeleteNote`（第 1321 行注释 "V1 退役：原物理删除的级联清理…全部服务于已删除的 V1 卡片表，无 V2 等价物，已整体移除"） |
| **现状** | 这些函数中保留了大量的 V1 退役注释，但实际代码已为空或仅保留 V2 路径 |
| **建议** | 清理退役注释，保留必要的 V2 说明即可 |

### 3.2 Learning Runs 中的 V1 兼容薄壳

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/learning-runs/run-service.ts` |
| **冗余内容** | `createRun()` V1 兼容入口（第 389–413 行）、`mapV1OriginToV2()` 映射函数（第 415–451 行）、`resolveV2ObjectiveKeyPoint()`（第 461 行，函数体仅返回 alias） |
| **现状** | V1 入口 `createRun` 直接委托给 `createRunV2`，`mapV1OriginToV2` 只做 keyPointId→objectiveId 的字段重命名。注释标注 "V1 兼容薄壳" |
| **建议** | 如果前端已全面使用 V2 schema，可移除 V1 兼容层 |

### 3.3 Learning Runs 中的 V1 退役注释

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/learning-runs/run-processing-tick.ts` |
| **冗余内容** | 第 640、856、1099、1162、1318、1402 行均有 "V1 keyPointId 列已退役" 或 "V1 的 cardKeyPoints.quote 读取已退役" 注释 |
| **建议** | 注释清理 |

### 3.4 Run Critic 中的 V1 退役注释

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/learning-runs/run-critic.ts` |
| **冗余内容** | 第 238–240 行注释 "禁止再回查 V1 card_key_points.claim/quoteText" |
| **建议** | 注释清理 |

### 3.5 Export Service 中的 V1 退役注释

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/export/service.ts` |
| **冗余内容** | 第 242、438、1010、1020、1065、1344、1362 行多处 V1 退役注释 |
| **建议** | 注释清理 |

### 3.6 Stats Service 中的 V1 退役逻辑

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/stats/service.ts` |
| **冗余内容** | 第 115 行 "V2-only stats: since V1 tables removed"、第 168 行 "V1 validation 统计已移除" |
| **建议** | 注释清理 |

### 3.7 Server.ts 中的 V1 模块删除注释

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/server.ts` |
| **冗余内容** | 第 12–13 行、第 330–331 行注释 "V1 evidence module removed"、"V1 validation routes removed" |
| **建议** | 注释清理 |

---

## 四、已删除文件/模块的残留引用

### 4.1 RC Manifest Fill 脚本（已弃用但仍保留）

| 项目 | 详情 |
|---|---|
| **文件** | `.github/scripts/rc-manifest-fill.mjs`（127 行，完整文件） |
| **依赖** | 原调用 `packages/ai-quality/src/cli/supervisor-rc-gate.ts`（已在 git status 中标记为 deleted） |
| **现状** | 脚本头部标注 "已弃用 — V1 supervisor-rc-gate 已删除"。整个脚本只做一件事：读取 manifest、保持 `aiQuality.status = "not_run"`、输出文件、退出。所有 RC gate 逻辑已空 |
| **建议** | 整个脚本可删除，或在 `release-manifest-generate.mjs` 中直接内联 `not_run` 占位 |

### 4.2 Release Manifest Generate 中的过时引用

| 项目 | 详情 |
|---|---|
| **文件** | `.github/scripts/release-manifest-generate.mjs` |
| **冗余内容** | 第 598 行注释 "actual metrics filled by supervisor-rc-gate CLI run"、第 669 行 "需由 supervisor-rc-gate CLI 运行真实 Provider 后填充" |
| **现状** | `supervisor-rc-gate.ts` 已删除，这些注释引用了不存在的 CLI |
| **建议** | 更新注释或删除引用 |

### 4.3 已删除的 AIQ V1 模块

以下文件已在 git status 中标记为 deleted，且全项目无残留引用（grep 确认）：

| 已删除文件 | 状态 |
|---|---|
| `packages/ai-quality/src/card-generation-supervisor-v1/golden-set-data.ts` | ✅ 无残留引用 |
| `packages/ai-quality/src/card-generation-supervisor-v1/golden-set-schema.ts` | ✅ 无残留引用 |
| `packages/ai-quality/src/card-generation-supervisor-v1/rc-runner.ts` | ✅ 无残留引用 |
| `packages/ai-quality/src/card-generation-supervisor-v1/scorer.ts` | ✅ 无残留引用 |
| `packages/ai-quality/src/cli/supervisor-rc-gate.ts` | ✅ 无残留引用（但 `rc-manifest-fill.mjs` 仍引用其名称） |

### 4.4 已删除的 API repro 文件

| 已删除文件 | 状态 |
|---|---|
| `apps/api/repro-create.ts` | ✅ 无残留引用 |
| `apps/api/repro-variant.ts` | ✅ 无残留引用 |
| `apps/api/repro-variant2.ts` | ✅ 无残留引用 |

### 4.5 已删除的集成测试文件

| 已删除文件 | 状态 |
|---|---|
| `apps/api/src/integration-tests/evaluate-validation-concurrent-postgres.integration.ts` | ✅ 无残留引用 |
| `apps/api/src/integration-tests/v06-rls-matrix-postgres.integration.ts` | ✅ 无残留引用 |
| `apps/api/src/integration-tests/v06-validation-session-postgres.integration.ts` | ✅ 无残留引用 |

---

## 五、Legacy Adapter / 兼容层

### 5.1 Learning Sessions Legacy Adapter

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/learning-sessions/legacy-adapter.ts`（526 行） |
| **测试文件** | `apps/api/src/modules/learning-sessions/legacy-adapter.test.ts` |
| **用途** | 旧域（V1 validation_events / review_attempts）与新域（V2 multimodal artifacts）之间的兼容适配器 |
| **现状** | 函数 `toLegacyDomainSummary`、`fromLegacyAnswer`、`buildRedactionCascadeSql`、`canonicalCompatibilityCheck` 仍在使用中（有集成测试引用） |
| **建议** | 需确认 V1 旧域表是否仍有数据。若已全部迁移到 V2，可移除该适配器 |

### 5.2 Learning Card Library V1/V2 合并兼容层

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/learning-card-library.ts` |
| **冗余函数** | `mergeLearningCardsV2(legacy, v2)` — 将旧卡列表与 V2 卡列表合并 |
| **现状** | V1 卡表已删除，`legacy` 参数实际应为空数组。但函数仍保留合并逻辑 |
| **建议** | 确认前端是否仍有旧卡数据。若已全切 V2，可简化为只返回 V2 列表 |

### 5.3 Understanding Topology V1 Reader vs V3

| 项目 | 详情 |
|---|---|
| **旧文件** | `apps/api/src/modules/understanding/service.ts`（V1 reader，使用 `learningCardsV2` + `understandingEvents` 聚合） |
| **新文件** | `apps/api/src/modules/understanding-v3/topology-repository.ts`（V3 reader，直接读 Objective/Origin/Evidence） |
| **现状** | 两套拓扑读取逻辑共存。V1 reader 已做 V2 迁移（注释 "V1 learningCards/cardKeyPoints 已退役"），但仍是基于 card 的旧架构。V3 是基于 objective 的新架构 |
| **建议** | 评估 V1 reader 是否仍有调用方。若 V3 已完全替代，可移除 V1 |

---

## 六、Feature Flag 函数仅定义未使用

### 6.1 已定义但无生产调用的 Feature Flag 函数

| 函数 | 文件 | 状态 |
|---|---|---|
| `isCardGenerationV1WriterEnabled()` | `apps/api/src/config/learning-companion-flags.ts` | ⚠️ 零调用 |
| `isPlannedPathEnabled()` | `packages/shared/src/feature-flags.ts` | ⚠️ 零调用 |
| `getPlannedPathRolloutPercent()` | `packages/shared/src/feature-flags.ts` | ⚠️ 零调用 |
| `isRunInPlannedBucket()` | `packages/shared/src/feature-flags.ts` | ⚠️ 零调用 |
| `isHybridSearchEnabled()` | `packages/shared/src/feature-flags.ts` | ⚠️ 零调用（仅定义和测试） |
| `isFeedbackRegenerationEnabled()` | `packages/shared/src/feature-flags.ts` | ⚠️ 零调用（仅定义和测试） |
| `isVisionUnderstandingEnabled()` | `packages/shared/src/feature-flags.ts` | ⚠️ 零调用（仅定义和测试） |

> 注：部分函数可能是"预埋"的 feature flag，待后续接线。需与团队确认。

---

## 七、CSS 样式文件可能冗余

### 7.1 Card Set Carousel CSS

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/app/styles/card-set-carousel.css`（约 1200 行） |
| **现状** | 对应的 `CardSetDeckPage` 组件已被测试合约（`card-v2-redraw-contract.test.ts`）明确断言不再使用。但 CSS 文件仍保留，且 `DeckCover.tsx` 仍导入 `card-set-carousel.ts` 中的 `DeckPose` 类型 |
| **建议** | 确认 CSS 是否仍被其他组件引用。若否，可删除 |

### 7.2 Card Set Detail CSS

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/app/styles/card-set-detail.css`（约 763 行） |
| **现状** | `AppShell.tsx` 中仍有 `card-set-detail` 的路由匹配（`/^\/card-sets\/[^/]+$/`），但 `/card-sets/` 目录下已无页面组件 |
| **建议** | 确认 `/card-sets/[id]` 路由是否仍有页面。若无，CSS 和路由匹配可删除 |

---

## 八、备份快照文件

| 项目 | 详情 |
|---|---|
| **目录** | `backups/agent-snapshot/` |
| **文件** | `20260818-restore-without-shared.patch`<br>`20260818-worktree-before-any-my-change.patch`<br>`mine-shared-edits/learning-run-contracts.ts`<br>`mine-shared-edits/learning-target-v2-contracts.ts` |
| **现状** | 开发过程中的临时备份快照。`learning-run-contracts.ts` 中包含 V1 schema 定义（标注 "V1 createLearningRunRequestSchema 已退役"） |
| **建议** | 确认是否仍需要这些备份。若已合入主线，可删除整个 `backups/` 目录 |

---

## 九、优先级建议

| 优先级 | 类别 | 预估清理量 | 风险 |
|---|---|---|---|
| **P0 - 立即** | 4.1 RC manifest fill 脚本（已弃用，引用已删除文件） | 127 行 | 低 |
| **P0 - 立即** | 6.1 无调用的 feature flag 函数（isCardGenerationV1WriterEnabled 等） | ~60 行 | 低 |
| **P1 - 短期** | 2.1 discrete-v1 调度策略旧版逻辑 | ~120 行 + 测试 | 中（需确认灰度完成） |
| **P1 - 短期** | 3.1–3.7 V1 退役注释清理 | 注释 | 低 |
| **P1 - 短期** | 7.1–7.2 Card Set CSS 文件 | ~1963 行 | 中（需确认无引用） |
| **P2 - 中期** | 2.4 首页 Onboarding legacy fallback | ~10 行 | 低 |
| **P2 - 中期** | 3.2 Learning Runs V1 兼容薄壳 | ~60 行 | 中（需确认前端迁移完成） |
| **P2 - 中期** | 5.1 Legacy Adapter | ~526 行 + 测试 | 高（需确认数据迁移完成） |
| **P2 - 中期** | 5.2 Learning Card Library 合并函数 | ~20 行 | 中 |
| **P3 - 长期** | 5.3 Understanding V1 vs V3 reader | 整个模块 | 高（需评估路由调用方） |
| **P3 - 长期** | 8. 备份快照目录 | 整个目录 | 低 |

---

## 十、方法论说明

本次审计采用以下方法识别冗余代码：

1. **Feature Flag 追踪**：从 `packages/shared/src/feature-flags.ts` 和 `apps/web/lib/feature-flags.ts` 出发，追踪每个 flag 函数的调用方。零调用的 flag 函数即为冗余
2. **退役注释 grep**：搜索 `退役`、`deprecated`、`legacy`、`removed`、`已删除`、`已移除`、`no longer`、`not used` 等关键词，定位代码中的退役标记
3. **已删除文件残留引用**：根据 git status 中的 deleted 文件列表，grep 全项目确认是否有残留 import
4. **新旧版本共存分析**：识别 V1/V2 双版本共存的模块（scheduling、card-generation、understanding topology、review service、companion action bridge）
5. **CSS 引用检查**：检查 CSS 文件对应的组件是否已被测试合约断言不再使用
6. **重复函数定义检测**：搜索 `function sha256Hex` 和 `function stableStringify` 的全项目定义，识别重复实现
7. **死代码路径扫描**：搜索 `if (false)`、`void <identifier>` 模式，识别永不执行的分支和 linter 抑制语句
8. **501 占位路由检查**：搜索 `501`、`not_implemented`、`stub`、`placeholder` 模式，识别未实现的功能预留
9. **退役类型枚举值分析**：检查 union type 中的枚举值是否仍有代码路径产生它们
10. **DB schema 镜像检测**：比较 `packages/db/src/schema/` 与 `apps/api/src/db/schema/` 的同名文件，搜索 `@ailearn/db` import 确认是否有消费方
11. **前端路由残留检查**：搜索 AppShell 路由匹配、layout 注释、page 组件中引用已退役路由（`/card-sets/`）的代码
12. **错误类定义普查**：搜索 `class \w+Error extends Error` 定义，识别可统一的错误基类
13. **Schema V1 注释普查**：搜索 schema 文件中的 "V1 ... removed" 注释，统计残留引用
14. **API 客户端零调用方法检测**：对 `api.ts` 中的每个方法 grep 全项目，零匹配的方法即为冗余
15. **@deprecated 标注扫描**：搜索 `@deprecated`、`@removed`、`@obsolete` 标注，识别已废弃但仍保留的函数/字段
16. **Infra 配置 V1 引用检测**：搜索 `infra/` 目录中的 dashboard、alert 规则、脚本是否引用已删除的 V1 指标/模块
17. **恒 null/void 抑制调用链追踪**：识别 `getToken()` 等恒返回 null 的函数，追踪其残留调用方的无效条件分支
18. **Shared 零消费方 parse 函数检测**：grep `parse*` 辅助函数名，仅在定义文件出现的即为零消费方
19. **重复 URLSearchParams 构造模式分析**：识别 `api.ts` 中重复的 query string 构造逻辑
20. **V1 遗留类型零 import 消费方检测**：grep `import { TypeName } from "@ailearn/shared"` 确认 shared 包中的类型是否有外部消费方
21. **重复 helper/util 函数定义普查**：搜索 `function normalizeText`、`function relativeTime`、`function formatDate` 等常见工具函数名，识别跨文件重复定义
22. **重复错误发送函数检测**：搜索 `function send*Error`、`function validate*Id` 模式，识别路由层重复的错误处理和参数校验逻辑
23. **CSS 引用零确认**：grep CSS 文件名/类名在全项目中的引用，确认零 import 后可安全删除

> **注意**：本报告仅做识别，不做清除。清理前需与团队确认各模块的迁移状态。

---

## 十一、重复的工具函数定义（sha256Hex / stableStringify）

### 11.1 sha256Hex 函数在 11+ 处重复定义

| # | 文件 | 行号 | 可见性 |
|---|---|---|---|
| 1 | `packages/shared/src/content-hash.ts` | 21 | `export`（权威实现，带 node:crypto 惰性获取） |
| 2 | `packages/shared/src/hash-canonical-v2.ts` | 33 | `private`（带 node:crypto 惰性获取） |
| 3 | `packages/shared/src/learning-assessment.ts` | 12 | `private`（直接 `import { createHash } from "node:crypto"`） |
| 4 | `apps/api/src/modules/learning-runs/run-planner.ts` | 28 | `export` |
| 5 | `apps/api/src/modules/learning-runs/shadow-translator.ts` | 46 | `private` |
| 6 | `apps/api/src/modules/learning-runs/run-structured.ts` | 20 | `export` |
| 7 | `apps/api/src/modules/learning-sessions/canonical-events.ts` | 547 | `private` |
| 8 | `apps/api/src/modules/learning-sessions/episode-commit.ts` | 482 | `private` |
| 9 | `apps/api/src/modules/learning-sessions/scene-safety.ts` | 345 | `private` |
| 10 | `apps/api/src/modules/learning-sessions/silent-scene-author.ts` | 46 | `private` |
| 11 | `apps/api/src/modules/learning-sessions/relation-governance.ts` | 187 | `private` |
| 12 | `apps/api/src/modules/learning-sessions/redaction-service.ts` | 610 | `private` |
| 13 | `apps/api/src/modules/learning-sessions/handoff-adapter.ts` | 211 | `private` |
| 14 | `apps/api/src/modules/learning-sessions/legacy-adapter.ts` | 487 | `private` |
| 15 | `packages/shared/src/published-learning-asset-contract.ts` | 99 | `private`（命名为 `stableStringifyPublishedAsset` 内部使用） |

> **现状**：`packages/shared/src/content-hash.ts` 已提供权威的 `sha256Hex()` 导出实现（含客户端 bundle 安全的 node:crypto 惰性获取）。但 API 侧和 shared 侧至少 14 处仍各自定义了私有/导出的同名函数，逻辑完全相同。
>
> **建议**：P1 — 将所有私有 `sha256Hex` 替换为从 `@ailearn/shared/content-hash` 导入；`run-planner.ts` 和 `run-structured.ts` 中的 `export sha256Hex` 应改为 re-export 或直接消费方改导入。预计可消除约 80 行重复代码。

### 11.2 stableStringify 函数在 7 处重复定义

| # | 文件 | 行号 | 可见性 |
|---|---|---|---|
| 1 | `apps/api/src/modules/learning-sessions/canonical-events.ts` | 552 | `export` |
| 2 | `apps/api/src/modules/learning-sessions/scene-activation.ts` | 238 | `private` |
| 3 | `apps/api/src/modules/learning-sessions/session-service.ts` | 618 | `private` |
| 4 | `apps/api/src/modules/learning-sessions/trust-service.ts` | 88 | `private` |
| 5 | `apps/api/src/modules/learning-sessions/scene-safety.ts` | 328 | `private` |
| 6 | `packages/shared/src/learning-assessment.ts` | 23 | `private` |
| 7 | `packages/shared/src/published-learning-asset-contract.ts` | 99 | `export`（命名为 `stableStringifyPublishedAsset`） |

> **现状**：逻辑完全相同（对象键字典序排序、数组保序、undefined 跳过）。`canonical-events.ts` 的导出版本可被其他模块消费。
>
> **建议**：P2 — 统一为 `canonical-events.ts` 的 `stableStringify` 或抽取到 `@ailearn/shared` 的公共模块。预计可消除约 60 行重复代码。

---

## 十二、死代码路径（if (false) 与 void 抑制）

### 12.1 Validation Session Service 中的 `if (false)` 死分支

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/validation/session-service.ts` |
| **位置** | 第 1498、1653、1738、1894、1971、1988、2449、2475 行 |
| **冗余内容** | 共 8 处 `if (false) { // V2: resolvedObjectiveId ... }` 或 `if (false) { // V2: exposure check skipped }` 死分支 |
| **现状** | V2 迁移后，这些条件永远为 false，分支体不会执行。部分分支体中还有 `await acquireLearningUnitLock(tx, workspaceId, userId, "" as string)` 这种用空字符串 hack 的调用 |
| **建议** | P1 — 清除所有 `if (false)` 死分支及其内部的 hack 调用 |

### 12.2 `void resolveObjAndCard` 抑制的未使用函数

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/validation/session-service.ts` |
| **位置** | 第 143–198 行（函数定义）、第 201 行（`void resolveObjAndCard;`） |
| **冗余内容** | `resolveObjAndCard()` 函数（约 55 行）完整实现了 V2 objective/card 解析逻辑，但在第 201 行被 `void resolveObjAndCard;` 抑制为"已使用"。实际无任何调用方 |
| **建议** | P0 — 删除该函数及 `void` 抑制语句 |

### 12.3 测试文件中的 void 抑制

| 文件 | 行号 | 抑制语句 |
|---|---|---|
| `apps/api/src/__tests__/v06-lock-ordering-contract.test.ts` | 74, 75 | `void SESSION_MUTATIONS; void REVIEW_MUTATIONS;` |
| `apps/api/src/__tests__/v06-export-import-coverage.test.ts` | 72, 82 | `void V06_NEW_TABLE_IDENTIFIERS; void V06_EXISTING_TABLE_EXTENSIONS;` |

> **现状**：这些常量/数组被定义但未在测试断言中使用，以 `void` 抑制 linter 的 unused 告警。
>
> **建议** | P2 — 确认这些常量是否作为文档/合约存在。若否，可删除。若是，应改为注释或文档。

---

## 十三、501 占位路由（未实现的功能预留）

### 13.1 Understanding Topology V3 Deltas 路由

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/understanding-v3/routes.ts` |
| **位置** | 第 29–34 行 |
| **冗余内容** | `GET /v3/understanding/topology/deltas/:changeSetId` 路由直接返回 501 `change_set_deltas_not_implemented` |
| **现状** | 注释标注 "预留（当前 501，由 W4 后续 change set 物化后实现）"。路由已注册但功能为空 |
| **建议** | P3 — 如果 W4 仍在计划中，可保留作为占位。如果 W4 已取消，移除路由 |

---

## 十四、已退役的类型定义仍保留

### 14.1 `LegacyRouteResolutionStatus` 中的 `forbidden` 与 `ambiguous` 枚举值

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/learning-objectives/history-route-service.ts` |
| **位置** | 第 101–105 行（类型定义）、第 120 行（注释） |
| **冗余内容** | `LegacyRouteResolutionStatus` 类型包含 `"mapped" | "gone" | "ambiguous" | "forbidden"` 四种状态。但注释明确指出 "alias/hidden 兼容行已随 0176 清空，不再需要 forbidden 分支" |
| **现状** | `resolveLegacyRouteV3` 函数实际只返回 `"mapped"` 或 `"gone"`，`"ambiguous"` 和 `"forbidden"` 永远不会被产生 |
| **建议** | P2 — 从类型定义中移除 `"ambiguous"` 和 `"forbidden"`，简化 union type |

### 14.2 `CardSetRecord` 和 `CardSetListItem` 类型（V1 card-set 退役后残留）

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api-types.ts` |
| **位置** | 第 169–188 行 |
| **冗余内容** | `CardSetRecord` 和 `CardSetListItem` 接口定义了 V1 card-set 产品的完整字段（status、coverageReport、cardCount 等） |
| **现状** | 测试合约 `card-v2-redraw-contract.test.ts` 断言 `!librarySource.includes("api.listCardSets")`，UI 已不消费 card-set API。但类型仍从 `api.ts` re-export，且 `learning-card-library.ts` 中 `buildCardSetSourceIndex()` 仍接受 `CardSetListItem[]` 参数 |
| **建议** | P2 — 确认前端是否仍有旧 card-set 数据。若已全切 V2，可移除类型和 `buildCardSetSourceIndex` |

### 14.3 `LearningCardRecord` 中的 V1 字段

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api-types.ts` |
| **位置** | 第 138–152 行 |
| **冗余内容** | `cardSetId`、`scope`、`scopeKey`、`ordinal` 等字段标注 "M5 card-set metadata. Optional while older card responses are still supported." |
| **现状** | V2 卡通过 `toV2CardListItem()` 映射到 `CardListItem` 时，这些字段不填充。测试合约 `rl-legacy-cleanup.test.ts` 断言 Surface 合同不含 `cardSetId` |
| **建议** | P3 — 在 V1 card-set 数据完全退役后，从类型中移除这些字段 |

---

## 十五、Origin Migration 中的已移除分支残留

### 15.1 Legacy Alias 来源分支（已空）

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/learning-objectives/origin-migration.ts` |
| **位置** | 第 7 行（注释）、第 162–163 行 |
| **冗余内容** | 分类优先级第 3 项 "（0176 退役后移除）legacy alias 来源" 仍出现在文档注释和代码注释中，但实际逻辑已空——代码直接跳到第 4 项 "无法证明 → missing" |
| **现状** | 注释引用了一个已不存在的来源分支 |
| **建议** | P2 — 清理注释中已移除分支的描述 |

---

## 十六、Companion Learning Action Bridge 中的 V1/V2 兼容分支

### 16.1 Legacy V1 Payload 候选构造

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/companion-conversation/learning-action-bridge.ts` |
| **位置** | 第 172 行（注释 "过渡期兼容；RL-17 退场后整个 legacy 分支可被移除"）、第 240–265 行（V1 候选字段填充）、第 417–450 行（V1 payload 路径） |
| **冗余内容** | `learningRunStartCandidate` 同时填充 V1 字段（`cardId`、`keyPointId`）和 V2 字段（`objectiveId`、`originV2`）。proposal 确认时，有 objectiveId + originV2 的走 V2 payload，否则走 V1 payload |
| **现状** | 注释标注 "RL-17 退场后整个 legacy 分支可被移除"。V1 候选字段仅为"未升级客户端"保留 |
| **建议** | P2 — 确认客户端是否已全面升级到 V2。若是，移除 V1 payload 路径和 V1 候选字段填充 |

### 16.2 `void v2RunId` 抑制

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/companion-conversation/learning-action-bridge.ts` |
| **位置** | 第 242、265 行 |
| **冗余内容** | `const v2RunId = ...` 赋值后立即 `void v2RunId;` 抑制 unused 告警。变量计算了但从未使用 |
| **建议** | P1 — 删除 `v2RunId` 变量及其 `void` 抑制 |

---

## 十七、Review Service 中的 V1/V2 共存逻辑

### 17.1 Review Service 中的多路径解析

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/review/service.ts` |
| **位置** | 第 245–304 行 |
| **冗余内容** | 根据 `subjectType` 分三路径解析：`"validation"`（V1 验证事件→cardId 映射）、`"card"`（旧 V1 卡）、`"objective"`（V2 objective→cardId 映射）。`isV2Card` 标记区分新旧 |
| **现状** | V1 卡已退役（0176），`subjectType === "card"` 的行应已无新增。但代码仍保留完整解析路径 |
| **建议** | P3 — 确认是否仍有 `"card"` 类型的历史 schedule。若无，可简化为仅 `"objective"` 路径 |

### 17.2 Consumer Eligibility 中的 `validation` subjectType 分支

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/review/consumer-eligibility.ts` |
| **位置** | 第 11–23 行 |
| **冗余内容** | SQL 谓词仍保留 `subjectType = 'validation'` 分支（检查 `validation_events` 表存在性） |
| **现状** | 注释标注 "V2 only — legacy card/card_set references removed"，但 `validation` 分支仍保留 |
| **建议** | P3 — 确认 `"validation"` subjectType 是否仍有消费方。若无，可移除该分支 |

---

## 十八、Shadow Translator（迁移完成后可移除）

### 18.1 Shadow Reconciliation 模块

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/learning-runs/shadow-translator.ts`（149 行） |
| **冗余内容** | `translateLegacyFactId()`、`runShadowReconciliation()` — 旧事实→canonical envelope 的 shadow 对账工具 |
| **现状** | Shadow 期用于验证新旧链路不冲突。Cutover 完成后（reconciled=true 且 pendingFacts=0），translator 不再需要 |
| **建议** | P3 — 确认 cutover 是否已完成。若是，整个模块可移除 |

---

## 十九、优先级建议（更新）

| 优先级 | 类别 | 预估清理量 | 风险 |
|---|---|---|---|
| **P0 - 立即** | 4.1 RC manifest fill 脚本（已弃用，引用已删除文件） | 127 行 | 低 |
| **P0 - 立即** | 6.1 无调用的 feature flag 函数（isCardGenerationV1WriterEnabled 等） | ~60 行 | 低 |
| **P0 - 立即** | 12.2 `void resolveObjAndCard` 抑制的未使用函数（55 行实现） | ~55 行 | 低 |
| **P0 - 立即** | 16.2 `void v2RunId` 抑制 | 2 行 | 低 |
| **P1 - 短期** | 11.1 sha256Hex 重复定义（14 处私有副本） | ~80 行 | 低 |
| **P1 - 短期** | 12.1 `if (false)` 死分支（8 处） | ~30 行 | 低 |
| **P1 - 短期** | 2.1 discrete-v1 调度策略旧版逻辑 | ~120 行 + 测试 | 中（需确认灰度完成） |
| **P1 - 短期** | 3.1–3.7 V1 退役注释清理 | 注释 | 低 |
| **P1 - 短期** | 7.1–7.2 Card Set CSS 文件 | ~1963 行 | 中（需确认无引用） |
| **P2 - 中期** | 11.2 stableStringify 重复定义（6 处私有副本） | ~60 行 | 低 |
| **P2 - 中期** | 2.4 首页 Onboarding legacy fallback | ~10 行 | 低 |
| **P2 - 中期** | 3.2 Learning Runs V1 兼容薄壳 | ~60 行 | 中（需确认前端迁移完成） |
| **P2 - 中期** | 5.1 Legacy Adapter | ~526 行 + 测试 | 高（需确认数据迁移完成） |
| **P2 - 中期** | 5.2 Learning Card Library 合并函数 | ~20 行 | 中 |
| **P2 - 中期** | 14.1 `LegacyRouteResolutionStatus` 退役枚举值 | 类型修改 | 低 |
| **P2 - 中期** | 14.2 `CardSetRecord`/`CardSetListItem` 退役类型 | 类型修改 | 中 |
| **P2 - 中期** | 15.1 Origin Migration 已移除分支注释 | 注释 | 低 |
| **P2 - 中期** | 16.1 Companion Bridge V1 payload 兼容分支 | ~40 行 | 中（需确认客户端升级） |
| **P3 - 长期** | 5.3 Understanding V1 vs V3 reader | 整个模块 | 高（需评估路由调用方） |
| **P3 - 长期** | 8. 备份快照目录 | 整个目录 | 低 |
| **P3 - 长期** | 13.1 501 占位路由（Topology V3 deltas） | 5 行 | 低 |
| **P3 - 长期** | 14.3 `LearningCardRecord` V1 字段 | 类型修改 | 中 |
| **P3 - 长期** | 17.1–17.2 Review Service V1 路径 | ~30 行 | 高（需确认历史数据） |
| **P3 - 长期** | 18.1 Shadow Translator | 149 行 | 高（需确认 cutover 完成） |

---

## 二十、DB Schema 镜像重复（packages/db vs apps/api/src/db）

### 20.1 packages/db 整个包为 apps/api/src/db 的陈旧镜像

| 项目 | 详情 |
|---|---|
| **镜像目录** | `packages/db/src/schema/` |
| **权威目录** | `apps/api/src/db/schema/` |
| **冗余内容** | `packages/db` 包含 20 个 schema 文件（`evidence.ts`、`learning-sessions.ts`、`validation-v2.ts`、`companion.ts` 等），与 `apps/api/src/db/schema/` 中的同名文件内容相同或高度相似 |
| **现状** | 代码中无任何 `from "@ailearn/db"` 或 `from "packages/db"` 的 import。仅在注释中引用（如 `// 与 packages/db/src/schema/outbox.ts 的...`、`// packages/db/src/schema/companion.ts 保持一致`）。测试文件 `review-attempt-active-abandon.test.ts` 用 `new URL("../../../../packages/db/src/schema/evidence.ts", ...)` 直接引用文件路径，说明该包未被作为模块导入 |
| **建议** | P1 — 确认 `packages/db` 是否仍作为 drizzle-kit generate 的输入。若否，整个包可删除（约 20 个文件）。若是，应合并到 `apps/api/src/db/schema/` 单一来源 |

### 20.2 Schema 中残留的 V1 列引用注释

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/db/schema/learning-runs.ts` |
| **位置** | 第 135–137、152–155 行 |
| **冗余内容** | `legacySessionId`、`legacyEpisodeId`、`legacyOrdinal` 三个列及 `legacyEpisodeUnique` 唯一索引，用于 0133 E17 backfill 幂等 |
| **现状** | 这些列和索引专为 V1→V2 迁移期的 backfill 幂等设计。迁移完成后（无新 legacy row 写入），列值恒为 NULL |
| **建议** | P3 — 迁移完全确认后，可移除这三个列和索引 |

### 20.3 Evidence schema 中的 `legacy_unrubriced` 状态

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/db/schema/evidence.ts`（第 94 行）、`packages/shared/src/enums.ts`（第 161 行） |
| **冗余内容** | `validationEvents.status` 注释中包含 `legacy_unrubriced` 状态，`packages/shared/src/enums.ts` 中有 `LEGACY_UNRUBRICED: "legacy_unrubriced"` 枚举 |
| **现状** | 测试注释标注 "legacy_unrubriced marking test: removed in V2 cleanup"。该状态是 V1 遗留标记，V2 已不再产生 |
| **建议** | P3 — 确认数据库中是否仍有 `legacy_unrubriced` 行。若无，可从枚举和 schema 注释中移除 |

---

## 二十一、Worker Handler 残留的 V1 注释

### 21.1 Workers index.ts 中的 V1 删除注释

| 项目 | 详情 |
|---|---|
| **文件** | `workers/ai-worker/src/handlers/index.ts` |
| **冗余内容** | 第 1–4 行注释 "V1 evaluate_validation handler and all V1 learning card logic removed. This file previously contained the runEvaluateValidation handler which depended on the deleted learning_cards / card_key_points tables." |
| **现状** | 文件仅导出 `JobPayload` 接口，实际 handler 已分布在各自文件中。注释引用的 V1 handler 已不存在 |
| **建议** | P2 — 清理 V1 删除注释 |

---

## 二十二、前端残留的 V1 路由匹配与组件引用

### 22.1 AppShell 中的 `/card-sets/[id]` 路由匹配

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/components/layout/AppShell.tsx` |
| **位置** | 第 108 行 |
| **冗余内容** | `{ variant: "focus", test: (p) => /^\/card-sets\/[^/]+$/.test(p), page: "card-set-detail", ownsFocusHeader: true }` |
| **现状** | 测试合约 `card-v2-redraw-contract.test.ts` 断言 `!target.includes("/card-sets/")` 且 `!cardsPage.includes("CardSetDeckPage")`。`/card-sets/` 目录下已无页面组件。但 AppShell 仍保留该路由的 focus variant 匹配 |
| **建议** | P1 — 移除 AppShell 中 `/card-sets/` 路由匹配规则 |

### 22.2 Focus Layout 注释中的 `/card-sets/[id]` 路由说明

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/app/(workspace)/(focus)/layout.tsx` |
| **位置** | 第 9 行 |
| **冗余内容** | 注释 "适用路由：... /card-sets/[id]" 仍列出已移除的路由 |
| **建议** | P2 — 从注释中移除 `/card-sets/[id]` |

### 22.3 Learning Card 详情页中残留的 `forbidden`/`ambiguous` 错误消息

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/app/(workspace)/(focus)/learning-cards/[cardId]/page.tsx` |
| **位置** | 第 116–119 行 |
| **冗余内容** | 错误消息仍处理 `resolution.status === "forbidden"` 和 `resolution.status === "ambiguous"` 两种状态。但 `resolveLegacyRouteV3` 实际只返回 `"mapped"` 或 `"gone"`（参见 §14.1） |
| **现状** | `forbidden` 和 `ambiguous` 分支的 UI 文案（"这是一个隐藏的兼容引用" / "这张旧卡包含多个学习目标"）永远不会展示给用户 |
| **建议** | P2 — 移除 `forbidden` 和 `ambiguous` 的错误消息分支，与后端类型定义保持一致 |

---

## 二十三、`deprecatedProgress` 测试合约残留

### 23.1 Generation Progress Panel 测试中的 deprecated 断言

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/__tests__/generation-progress-panel.test.ts` |
| **位置** | 第 118 行 |
| **冗余内容** | `assert.ok(!overlaySource.includes("deprecatedProgress"))` — 断言 overlay 源码不含 `deprecatedProgress` |
| **现状** | 这是一条"负向断言"——确保已废弃的 `deprecatedProgress` 不会重新出现。但既然该标识已被移除，断言本身也只是历史验证残留 |
| **建议** | P3 — 保留无风险（作为回归防护）。若清理测试文件可移除 |

---

## 二十四、Schema 注释中的 V1 引用残留汇总

以下 schema 文件中包含 "V1 ... removed" 注释，引用了已删除的表/列/索引：

| 文件 | 注释行数 | 残留内容 |
|---|---|---|
| `apps/api/src/db/schema/validation-v2.ts` | 4 处 | "V1 card/keyPoint references removed"、"V1 keyPoint-based unique index removed" |
| `apps/api/src/db/schema/job.ts` | 1 处 | "V1 generation run reference removed" |
| `apps/api/src/db/schema/learning-sessions.ts` | 5 处 | "V1 keyPoint reference removed (cardKeyPoints table deleted)"、"V1 keyPointId reference removed"、"V1 keyPointId index removed" |
| `apps/api/src/db/schema/evidence.ts` | 8 处 | "V1 keyPointId reference removed"、"V1 evidenceSpanId reference removed"、"V1 keyPointIdx removed"、"V1 card/keyPoint references removed" 等 |
| `apps/api/src/db/schema/learning-runs.ts` | 2 处 | "V1 keyPoint reference removed (cardKeyPoints table deleted)" |

> **建议**：P2 — 统一清理 schema 文件中的 V1 removed 注释。这些注释在迁移完成后已无信息价值。

---

## 二十五、优先级建议（最终更新）

| 优先级 | 类别 | 预估清理量 | 风险 |
|---|---|---|---|
| **P0 - 立即** | 4.1 RC manifest fill 脚本（已弃用，引用已删除文件） | 127 行 | 低 |
| **P0 - 立即** | 6.1 无调用的 feature flag 函数（isCardGenerationV1WriterEnabled 等） | ~60 行 | 低 |
| **P0 - 立即** | 12.2 `void resolveObjAndCard` 抑制的未使用函数（55 行实现） | ~55 行 | 低 |
| **P0 - 立即** | 16.2 `void v2RunId` 抑制 | 2 行 | 低 |
| **P1 - 短期** | 20.1 `packages/db` 整个镜像包（无 import 消费方） | ~20 个文件 | 中（需确认 drizzle-kit 不依赖） |
| **P1 - 短期** | 11.1 sha256Hex 重复定义（14 处私有副本） | ~80 行 | 低 |
| **P1 - 短期** | 12.1 `if (false)` 死分支（8 处） | ~30 行 | 低 |
| **P1 - 短期** | 22.1 AppShell `/card-sets/` 路由匹配 | 1 行 | 低 |
| **P1 - 短期** | 2.1 discrete-v1 调度策略旧版逻辑 | ~120 行 + 测试 | 中（需确认灰度完成） |
| **P1 - 短期** | 3.1–3.7 V1 退役注释清理 | 注释 | 低 |
| **P1 - 短期** | 7.1–7.2 Card Set CSS 文件 | ~1963 行 | 中（需确认无引用） |
| **P2 - 中期** | 11.2 stableStringify 重复定义（6 处私有副本） | ~60 行 | 低 |
| **P2 - 中期** | 2.4 首页 Onboarding legacy fallback | ~10 行 | 低 |
| **P2 - 中期** | 3.2 Learning Runs V1 兼容薄壳 | ~60 行 | 中（需确认前端迁移完成） |
| **P2 - 中期** | 5.1 Legacy Adapter | ~526 行 + 测试 | 高（需确认数据迁移完成） |
| **P2 - 中期** | 5.2 Learning Card Library 合并函数 | ~20 行 | 中 |
| **P2 - 中期** | 14.1 `LegacyRouteResolutionStatus` 退役枚举值 | 类型修改 | 低 |
| **P2 - 中期** | 14.2 `CardSetRecord`/`CardSetListItem` 退役类型 | 类型修改 | 中 |
| **P2 - 中期** | 15.1 Origin Migration 已移除分支注释 | 注释 | 低 |
| **P2 - 中期** | 16.1 Companion Bridge V1 payload 兼容分支 | ~40 行 | 中（需确认客户端升级） |
| **P2 - 中期** | 21.1 Worker index.ts V1 删除注释 | 注释 | 低 |
| **P2 - 中期** | 22.2 Focus Layout 注释中的 `/card-sets/[id]` | 注释 | 低 |
| **P2 - 中期** | 22.3 Learning Card 详情页 `forbidden`/`ambiguous` 错误消息 | ~4 行 | 低 |
| **P2 - 中期** | 24. Schema 注释中的 V1 引用残留（20+ 处） | 注释 | 低 |
| **P3 - 长期** | 5.3 Understanding V1 vs V3 reader | 整个模块 | 高（需评估路由调用方） |
| **P3 - 长期** | 8. 备份快照目录 | 整个目录 | 低 |
| **P3 - 长期** | 13.1 501 占位路由（Topology V3 deltas） | 5 行 | 低 |
| **P3 - 长期** | 14.3 `LearningCardRecord` V1 字段 | 类型修改 | 中 |
| **P3 - 长期** | 17.1–17.2 Review Service V1 路径 | ~30 行 | 高（需确认历史数据） |
| **P3 - 长期** | 18.1 Shadow Translator | 149 行 | 高（需确认 cutover 完成） |
| **P3 - 长期** | 20.2 `legacySessionId`/`legacyEpisodeId`/`legacyOrdinal` 列 | 3 列 + 1 索引 | 高（需确认迁移完成） |
| **P3 - 长期** | 20.3 `legacy_unrubriced` 枚举值 | 枚举修改 | 中 |
| **P3 - 长期** | 23.1 `deprecatedProgress` 测试断言 | 1 行 | 低 |
| **P1 - 短期** | 26.1–26.5 前端零调用 API 客户端方法（8 个） | ~80 行 | 低 |
| **P1 - 短期** | 27.1 `@deprecated` governance 函数（3 个） | ~60 行 | 中（需确认替代方已接线） |
| **P2 - 中期** | 28.1 Supervisor Agent V1 Grafana dashboard | ~366 行 JSON | 中（需确认指标已退役） |
| **P2 - 中期** | 29.1 `getToken()` 恒 null 的残留调用方 | ~10 行 | 低 |
| **P2 - 中期** | 30.1 `setToken()` 恒无效的残留调用方 | ~15 行 | 低 |
| **P2 - 中期** | 31.1 `registerWithInviteToken`/`registerPersonal` 零调用方法 | ~20 行 | 低 |
| **P2 - 中期** | 32.1 `parse*` 辅助函数零消费方（7 个） | ~30 行 | 低 |
| **P2 - 中期** | 33.1 URLSearchParams 重复构造模式（11 处） | ~50 行 | 低 |

---

## 二十六、前端零调用的 API 客户端方法

### 26.1 `api.getCardPosition` — 零调用

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts`（第 1112–1113 行） |
| **方法** | `getCardPosition(id: string)` |
| **现状** | 全项目无任何 `api.getCardPosition` 调用（grep 零匹配）。原设计用于单请求获取卡片分页位置，但前端实际使用逐页翻页逻辑 |
| **建议** | P1 — 删除该方法 |

### 26.2 `api.listValidations` / `api.getValidation` / `api.getValidationByJobId` — 零调用

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts`（第 1328–1333 行） |
| **方法** | `listValidations(cardId)`、`getValidation(id)`、`getValidationByJobId(jobId)` |
| **现状** | 全项目无任何 `api.listValidations`、`api.getValidation`、`api.getValidationByJobId` 调用。这些是 V0.1b 时代的旧验证 API 客户端，已被 V0.6 `validation-sessions` 系列 API 全面替代 |
| **建议** | P1 — 删除这三个方法 |

### 26.3 `api.listCardGenerationAgentEvents` — 零调用

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts`（第 1129–1144 行） |
| **方法** | `getCardGenerationAgentEvents(id, opts)` |
| **现状** | 全项目无任何 `api.listCardGenerationAgentEvents` 或 `api.getCardGenerationAgentEvents` 调用。该方法用于增量拉取 Agent 活动流，但前端改用 SSE 流式订阅 |
| **建议** | P1 — 删除该方法 |

### 26.4 `api.getActiveReviewAttempt` / `api.abandonReviewAttempt` — 零调用

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts`（第 1513–1528 行） |
| **方法** | `getActiveReviewAttempt(reviewScheduleId)`、`abandonReviewAttempt(attemptId)` |
| **现状** | 全项目无任何 `api.getActiveReviewAttempt` 或 `api.abandonReviewAttempt` 调用。V05-RISK-04 的主动放弃和活跃查询功能未被前端接线 |
| **建议** | P1 — 删除这两个方法 |

### 26.5 `api.submitQualitySignal` / `api.getOnboardingState` — 零调用

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts` |
| **方法** | `submitQualitySignal(eventId, body)`（第 1427–1434 行）、`getOnboardingState()`（第 1630–1638 行） |
| **现状** | 全项目无任何 `api.submitQualitySignal` 或 `api.getOnboardingState` 调用。质量信号提交和 Onboarding 状态查询在前端未被使用 |
| **建议** | P1 — 删除这两个方法 |

---

## 二十七、`@deprecated` 标注但仍保留的 Worker 函数

### 27.1 `checkAIConsent()` — 已废弃

| 项目 | 详情 |
|---|---|
| **文件** | `workers/ai-worker/src/lib/governance.ts` |
| **位置** | 第 87–100 行 |
| **替代方** | `resolveAIGovernanceContext()` |
| **现状** | 标注 `@deprecated`，注释说明"该函数会独立查询 workspaces 表，与 resolveAIGovernanceContext 中的 workspace 查询重复"。仍被 `session-routes.ts`、`identity/service.ts` 和测试引用 |
| **建议** | P1 — 调用方迁移到 `resolveAIGovernanceContext().consentOk` 后删除该函数 |

### 27.2 `enforcePrivacyGovernance()` — 已废弃

| 项目 | 详情 |
|---|---|
| **文件** | `workers/ai-worker/src/lib/governance.ts` |
| **位置** | 第 496–517 行（双重 `@deprecated` 标注） |
| **替代方** | `enforcePrivacyGovernanceWithPolicy()` + `resolveAIGovernanceContext()` |
| **现状** | 标注 `@deprecated`，注释说明"内部会独立查询 workspaces 表获取 AI policy，产生冗余 DB 查询"。仍被测试引用 |
| **建议** | P1 — 调用方迁移后删除 |

### 27.3 `adaptFetchToPublicJsonRequester()` — TEST-ONLY 标注

| 项目 | 详情 |
|---|---|
| **文件** | `workers/ai-worker/src/lib/providers/openai-compatible.ts` |
| **位置** | 第 54–85 行 |
| **现状** | 标注 `@deprecated TEST-ONLY`，注释明确"MUST NOT be reachable from production code"。有生产环境守卫（`NODE_ENV === "production"` 时抛错）。仅被 `dashscope.ts` 和测试使用 |
| **建议** | P2 — 评估是否可替换为 mock 注入方式，消除该 SSRF 旁路适配器 |

### 27.4 `LogAICallParams` 中的 `userId` 字段 — 已废弃

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/modules/identity/service.ts` |
| **位置** | 第 984–991 行 |
| **现状** | `AuditActorIdentity` 类型中的 `userId` 字段标注 `@deprecated Use actorUserId. Kept for worker/API compatibility during migration.`。与新字段 `actorUserId` 共存 |
| **建议** | P2 — worker/API 完成迁移后移除 `userId` 字段 |

---

## 二十八、Infra 配置中的 V1 残留

### 28.1 Supervisor Agent V1 Grafana Dashboard

| 项目 | 详情 |
|---|---|
| **文件** | `infra/prometheus/dashboards/supervisor-agent-v1.json`（约 366 行） |
| **现状** | Dashboard 标题 "Supervisor Agent v1 — Card Generation Quality & Ops"，引用 `ailearn_supervisor_*` 系列指标（`run_terminal_total`、`coverage_ratio`、`critic_evaluations_total`、`shadow_runs_total` 等）。但 V1 supervisor 模块已全部删除（见 §4.3），这些指标不再产生 |
| **建议** | P2 — 确认 dashboard 是否仍被引用。若否，可删除整个 JSON 文件 |

### 28.2 Migration SQL 文件中的 V1 表定义残留

| 项目 | 详情 |
|---|---|
| **文件** | `apps/api/src/db/migrations/0000_illegal_kid_colt.sql`、`0011_n003_n005_n007_n011.sql` 等 |
| **现状** | 这些 migration 文件包含 `card_key_points` 和 `learning_cards` 表的 CREATE TABLE / ALTER TABLE 语句。0176 migration 已执行退役（DROP TABLE），但早期 migration 文件仍保留原始定义 |
| **注意** | Migration 文件是历史记录，通常不修改。但如果使用 squash migration 策略，可以清理 |
| **建议** | P3 — 仅在执行 migration squash 时一并清理 |

---

## 二十九、`getToken()` 恒返回 null 的残留调用链

### 29.1 `getToken()` 在 Cookie 迁移后已成为空壳

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts` |
| **位置** | 第 264–269 行（定义）、第 596 行（`request` 内部）、第 735 行（`getMeCached` 内部） |
| **现状** | `getToken()` 注释说明"Browser sessions use the HttpOnly ailearn_session cookie. Keeping this legacy accessor null prevents new code from reintroducing Web Storage bearer tokens"。函数体直接 `return null`。但 `request()` 中仍执行 `const token = getToken(); if (token) headers.set("Authorization", ...)` —— 条件永远为 false |
| **残留调用方** | `apps/web/features/learning-run/api/sse.ts`（第 68 行）、`apps/web/lib/learning-companion/voice-api.ts`（第 201、256 行）—— 这些文件 import `getToken` 并在 SSE/fetch 调用前检查 `if (token) headers["Authorization"] = ...`，条件永远为 false |
| **建议** | P2 — 从 `request()` 和所有外部调用方中移除 `getToken()` 调用，直接依赖 cookie credentials |

---

## 三十、`setToken()` 恒无效的残留调用链

### 30.1 `setToken()` 在 Cookie 迁移后仅做清理

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts` |
| **位置** | 第 271–288 行（定义） |
| **现状** | `setToken(token, persistent)` 的函数体只做 `localStorage.removeItem` 和 `sessionStorage.removeItem`，然后用 `void token; void persistent;` 抑制 unused 参数。实际不存储任何 token |
| **残留调用方** | `WorkspaceSwitcher.tsx`、`WorkspaceManagement.tsx`、`login/page.tsx`、`register/page.tsx`、`api.ts` 内部（logout、switchWorkspace 等）—— 这些调用方传入的 `token` 参数被完全忽略 |
| **建议** | P2 — 将 `setToken` 重命名为 `clearLegacyTokenStorage()` 或直接内联 `localStorage.removeItem`，消除 `void` 抑制和无效参数 |

---

## 三十一、`registerWithInviteToken` / `registerPersonal` 零调用

### 31.1 被统一 `register` 方法替代

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts` |
| **位置** | 第 1651–1673 行 |
| **方法** | `registerWithInviteToken(params)` 和 `registerPersonal(params)` |
| **现状** | 注释标注 "SEC-02 / ALPHA-01: v0.5 邀请码注册" 和 "ADR-0009: 无邀请码注册"。但这两个方法全项目零调用。实际注册逻辑使用统一的 `api.register(params)`（第 1676–1688 行），该方法支持有/无邀请码两种场景 |
| **建议** | P2 — 删除这两个已替代的方法 |

---

## 三十二、`packages/shared` 中零消费方的 `parse*` 辅助函数

### 32.1 Card Generation V2 Contracts 中的 parse 函数

| 函数 | 文件 | 状态 |
|---|---|---|
| `parseCreateCardGenerationRunRequestV2()` | `packages/shared/src/card-generation-v2-contracts.ts` | ⚠️ 零外部消费方 |
| `parseGenerationSemanticSpecV2()` | 同上 | ⚠️ 零外部消费方 |
| `parseGenerationInputSnapshotV2()` | 同上 | ⚠️ 零外部消费方 |
| `parseCardPlanV2()` | 同上 | ⚠️ 零外部消费方 |
| `parseLearningCardCandidateRevisionV2()` | 同上 | ⚠️ 零外部消费方（仅在定义文件自身出现） |

> **现状**：这些 `parse*` 函数是 zod schema 的 `.parse()` 薄包装。调用方直接使用 schema 对象的 `.parse()` 方法，不需要额外的函数封装。
>
> **建议**：P2 — 确认是否有外部包消费这些函数。若无，可删除（保留 schema 导出即可）。

### 32.2 Learning Card V2 Contracts 中的 parse 函数

| 函数 | 文件 | 状态 |
|---|---|---|
| `parseObjectiveEquivalenceReportV2()` | `packages/shared/src/learning-card-v2-contracts.ts` | ⚠️ 零外部消费方 |
| `parseObjectiveEquivalenceBindingV2()` | 同上 | ⚠️ 零外部消费方 |
| `parseInitialValidationReminderV2()` | 同上 | ⚠️ 零外部消费方 |

> **建议**：P2 — 同上，确认后可删除。

---

## 三十三、`api.ts` 中重复的 URLSearchParams 构造模式

### 33.1 11 处重复的 query string 构造逻辑

| 项目 | 详情 |
|---|---|
| **文件** | `apps/web/lib/api.ts` |
| **位置** | 第 1044–1053、1088–1097、1099–1108、1160–1169、1206–1213、1247–1254、1285–1294、1437–1446、1499–1510、1583–1592 行 |
| **冗余内容** | 11 处几乎相同的模式：`new URLSearchParams(Object.entries(params).filter(...).map(([k, v]) => [k, String(v)]) as [string, string][]]).toString()` |
| **变体** | filter 条件略有不同：有的用 `v != null`，有的用 `v !== undefined`，有的用 `v !== undefined && v !== false`，有的用 `Boolean(v)` |
| **建议** | P2 — 提取为 `buildQueryString(params: Record<string, unknown>, filterFn?: (v: unknown) => boolean)` 工具函数，消除约 50 行重复代码 |

---

## 三十四、优先级建议（第四轮更新）

| 优先级 | 类别 | 预估清理量 | 风险 |
|---|---|---|---|
| **P0 - 立即** | 4.1 RC manifest fill 脚本（已弃用，引用已删除文件） | 127 行 | 低 |
| **P0 - 立即** | 6.1 无调用的 feature flag 函数（isCardGenerationV1WriterEnabled 等） | ~60 行 | 低 |
| **P0 - 立即** | 12.2 `void resolveObjAndCard` 抑制的未使用函数（55 行实现） | ~55 行 | 低 |
| **P0 - 立即** | 16.2 `void v2RunId` 抑制 | 2 行 | 低 |
| **P1 - 短期** | 20.1 `packages/db` 整个镜像包（无 import 消费方） | ~20 个文件 | 中（需确认 drizzle-kit 不依赖） |
| **P1 - 短期** | 11.1 sha256Hex 重复定义（14 处私有副本） | ~80 行 | 低 |
| **P1 - 短期** | 12.1 `if (false)` 死分支（8 处） | ~30 行 | 低 |
| **P1 - 短期** | 22.1 AppShell `/card-sets/` 路由匹配 | 1 行 | 低 |
| **P1 - 短期** | 26.1–26.5 前端零调用 API 客户端方法（8 个） | ~80 行 | 低 |
| **P1 - 短期** | 27.1–27.2 `@deprecated` governance 函数（checkAIConsent + enforcePrivacyGovernance） | ~60 行 | 中（需确认替代方已接线） |
| **P1 - 短期** | 2.1 discrete-v1 调度策略旧版逻辑 | ~120 行 + 测试 | 中（需确认灰度完成） |
| **P1 - 短期** | 3.1–3.7 V1 退役注释清理 | 注释 | 低 |
| **P1 - 短期** | 7.1–7.2 Card Set CSS 文件 | ~1963 行 | 中（需确认无引用） |
| **P2 - 中期** | 11.2 stableStringify 重复定义（6 处私有副本） | ~60 行 | 低 |
| **P2 - 中期** | 2.4 首页 Onboarding legacy fallback | ~10 行 | 低 |
| **P2 - 中期** | 3.2 Learning Runs V1 兼容薄壳 | ~60 行 | 中（需确认前端迁移完成） |
| **P2 - 中期** | 5.1 Legacy Adapter | ~526 行 + 测试 | 高（需确认数据迁移完成） |
| **P2 - 中期** | 5.2 Learning Card Library 合并函数 | ~20 行 | 中 |
| **P2 - 中期** | 14.1 `LegacyRouteResolutionStatus` 退役枚举值 | 类型修改 | 低 |
| **P2 - 中期** | 14.2 `CardSetRecord`/`CardSetListItem` 退役类型 | 类型修改 | 中 |
| **P2 - 中期** | 15.1 Origin Migration 已移除分支注释 | 注释 | 低 |
| **P2 - 中期** | 16.1 Companion Bridge V1 payload 兼容分支 | ~40 行 | 中（需确认客户端升级） |
| **P2 - 中期** | 21.1 Worker index.ts V1 删除注释 | 注释 | 低 |
| **P2 - 中期** | 22.2 Focus Layout 注释中的 `/card-sets/[id]` | 注释 | 低 |
| **P2 - 中期** | 22.3 Learning Card 详情页 `forbidden`/`ambiguous` 错误消息 | ~4 行 | 低 |
| **P2 - 中期** | 24. Schema 注释中的 V1 引用残留（20+ 处） | 注释 | 低 |
| **P2 - 中期** | 27.3 `adaptFetchToPublicJsonRequester` TEST-ONLY 适配器 | ~30 行 | 中（需替代 mock 方案） |
| **P2 - 中期** | 27.4 `LogAICallParams.userId` 废弃字段 | 类型修改 | 低 |
| **P2 - 中期** | 28.1 Supervisor Agent V1 Grafana dashboard | ~366 行 JSON | 中（需确认指标已退役） |
| **P2 - 中期** | 29.1 `getToken()` 恒 null 的残留调用方 | ~10 行 | 低 |
| **P2 - 中期** | 30.1 `setToken()` 恒无效的残留调用方 | ~15 行 | 低 |
| **P2 - 中期** | 31.1 `registerWithInviteToken`/`registerPersonal` 零调用方法 | ~20 行 | 低 |
| **P2 - 中期** | 32.1–32.2 `parse*` 辅助函数零消费方（8 个） | ~40 行 | 低 |
| **P2 - 中期** | 33.1 URLSearchParams 重复构造模式（11 处） | ~50 行 | 低 |
| **P3 - 长期** | 5.3 Understanding V1 vs V3 reader | 整个模块 | 高（需评估路由调用方） |
| **P3 - 长期** | 8. 备份快照目录 | 整个目录 | 低 |
| **P3 - 长期** | 13.1 501 占位路由（Topology V3 deltas） | 5 行 | 低 |
| **P3 - 长期** | 14.3 `LearningCardRecord` V1 字段 | 类型修改 | 中 |
| **P3 - 长期** | 17.1–17.2 Review Service V1 路径 | ~30 行 | 高（需确认历史数据） |
| **P3 - 长期** | 18.1 Shadow Translator | 149 行 | 高（需确认 cutover 完成） |
| **P3 - 长期** | 20.2 `legacySessionId`/`legacyEpisodeId`/`legacyOrdinal` 列 | 3 列 + 1 索引 | 高（需确认迁移完成） |
| **P3 - 长期** | 20.3 `legacy_unrubriced` 枚举值 | 枚举修改 | 中 |
| **P3 - 长期** | 23.1 `deprecatedProgress` 测试断言 | 1 行 | 低 |
| **P3 - 长期** | 28.2 Migration SQL 中的 V1 表定义 | 历史文件 | 低（仅在 squash 时清理） |
| **P1 - 短期** | 34.1–34.3 重复的错误类定义（19 个 extends Error） | ~100 行 | 中 |
| **P2 - 中期** | 35.1 `packages/shared/src/types.ts` V1 遗留类型（8 个零消费方） | ~60 行 | 低 |
| **P2 - 中期** | 36.1 `normalizeText` 重复定义（3 处） | ~6 行 | 低 |
| **P2 - 中期** | 37.1 `relativeTime` / `formatRelativeTime` 重复定义 | ~30 行 | 低 |
| **P2 - 中期** | 38.1 `formatDate` 重复定义（2 处） | ~10 行 | 低 |
| **P2 - 中期** | 39.1 `sendSessionError` / `sendServiceError` 重复模式 | ~20 行 | 低 |
| **P2 - 中期** | 40.1 `validateSubmissionId` / `validateEventId` 近似重复 | ~20 行 | 低 |
| **P2 - 中期** | 41.1 CSS 文件完全无引用确认 | ~1963 行 | 低 |
| **P3 - 长期** | 42.1 `ReviewSchedule.subjectType` V1 枚举值 | 类型修改 | 中 |

---

## 三十五、`packages/shared/src/types.ts` 中的 V1 遗留类型（零消费方）

### 35.1 V1 域模型类型已无外部 import 消费方

以下 8 个类型/接口在 `packages/shared/src/types.ts` 中定义并通过 `index.ts` 全量导出，但全项目无任何 `import { ... } from "@ailearn/shared"` 引用它们（grep 确认）：

| 类型 | 用途 | 状态 |
|---|---|---|
| `NoteVersionBlock` | V1 笔记版本块结构 | ⚠️ 零消费方（被 `apps/api/src/db/schema/note.ts` 的 DB schema 替代） |
| `LearningCardKeyPoint` | V1 学习卡要点 | ⚠️ 零消费方（V1 `card_key_points` 表已删除） |
| `Evidence` | V1 证据行 | ⚠️ 零消费方（被 `apps/web/lib/api-types.ts` 的 `EvidenceRow` 替代） |
| `LearningCard` | V1 学习卡记录 | ⚠️ 零消费方（被 V2 `PublicLearningCardV2` 替代） |
| `AIArtifact` | V1 AI 工件 | ⚠️ 零消费方（V2 artifact 结构已完全不同） |
| `ReviewSchedule` | V1 复习计划 | ⚠️ 零消费方（被 `apps/api/src/db/schema/evidence.ts` 的 DB schema 替代） |
| `ValidationEvent` | V1 验证事件 | ⚠️ 零消费方（被 `apps/web/lib/api-types.ts` 的 `ValidationEvent` 替代） |
| `ValidationFeedback` | V1 验证反馈 | ⚠️ 零消费方（V2 评估结构已不同） |

> **现状**：这些类型是 V0.3/V0.5 时代的域模型。随着 DB schema 在 `apps/api/src/db/schema/` 中独立定义、前端在 `api-types.ts` 中自定义类型、V2 contracts 在 `packages/shared/src/learning-card-v2-contracts.ts` 等文件中重新定义，这些 V1 类型已完全失去消费方。
>
> **建议**：P2 — 从 `packages/shared/src/types.ts` 中移除这 8 个类型。`QuestionSafetyReport` 也需确认是否仍有消费方。

---

## 三十六、重复的 `normalizeText` 函数定义

### 36.1 三处独立定义相同逻辑

| # | 文件 | 行号 | 可见性 | 实现 |
|---|---|---|---|---|
| 1 | `packages/shared/src/fingerprint.ts` | 76 | `export` | `text.trim().replace(/\s+/g, " ").toLowerCase()` |
| 2 | `workers/ai-worker/src/lib/text-similarity.ts` | 28 | `export` | `s.trim().replace(/\s+/g, " ").toLowerCase()` |
| 3 | `apps/api/src/modules/learning-sessions/scene-safety.ts` | 743 | `private` | `text.trim().replace(/\s+/g, " ").toLowerCase()` |

> **现状**：三处实现完全相同——trim + collapse whitespace + lowercase。`fingerprint.ts` 的 `export` 版本可被其他两处消费。
>
> **建议**：P2 — 将 `text-similarity.ts` 和 `scene-safety.ts` 中的 `normalizeText` 改为从 `@ailearn/shared/fingerprint` 导入。注意：`fingerprint.ts` 不经 index 全量导出（node: 依赖），需从子路径导入。

---

## 三十七、重复的相对时间格式化函数

### 37.1 `relativeTime` / `formatRelativeTime` — 重复定义

| # | 文件 | 行号 | 函数名 | 实现 |
|---|---|---|---|---|
| 1 | `apps/web/lib/format.ts` | 2 | `relativeTime(iso: string)` | 刚刚 / x 分钟前 / x 小时前 / 昨天 / x 天前 / 日期 |
| 2 | `apps/web/features/companion-pet/conversation/conversation-model.ts` | 70 | `formatRelativeTime(iso: string \| null \| undefined)` | 刚刚 / x 分钟前 / x 小时前 / x 天前 / 日期 |

> **现状**：两个函数逻辑几乎完全相同，只是 `formatRelativeTime` 多了 null/undefined 守卫和"昨天"分支的缺失。两者都在同一 `apps/web` 包内。
>
> **建议**：P2 — `conversation-model.ts` 的 `formatRelativeTime` 改为从 `@/lib/format` 导入 `relativeTime`，加上 null 守卫包装。

### 37.2 `formatDate` — 两处重复定义

| # | 文件 | 行号 | 实现 |
|---|---|---|---|
| 1 | `apps/web/components/settings/InviteMemberSettings.tsx` | 219 | `function formatDate(iso: string \| null)` |
| 2 | `apps/web/app/(workspace)/(default)/companion/daily/page.tsx` | 43 | `function formatDate(date: Date)` |

> **现状**：两个 `formatDate` 的参数类型不同（ISO 字符串 vs Date 对象），但输出格式化逻辑类似。
>
> **建议**：P3 — 如果格式不同则保留；如果相同，统一到 `@/lib/format`。

---

## 三十八、重复的路由错误发送函数

### 38.1 `sendSessionError` / `sendServiceError` — 近似重复

| # | 文件 | 行号 | 函数名 | 逻辑 |
|---|---|---|---|---|
| 1 | `apps/api/src/modules/validation/session-routes.ts` | 52 | `sendSessionError(reply, error)` | 检查 `error instanceof SessionError`，映射 statusCode/code，返回 boolean |
| 2 | `apps/api/src/modules/card-generation-v2/routes.ts` | 97 | `sendServiceError(reply, error)` | 检查 `error instanceof CardGenerationV2ServiceError`，映射 statusCode/code，无返回值 |

> **现状**：两个函数做相同的事——检查自定义 Error 子类，映射为 HTTP 状态码和错误码，通过 reply 发送。唯一差异是检查的 Error 类型和返回值。
>
> **建议**：P2 — 可提取为 `sendDomainError<T extends DomainError>(reply, error, ErrorClass)` 通用函数。

### 38.2 `validateSubmissionId` / `validateEventId` — 近似重复

| # | 文件 | 行号 | 函数名 | 差异 |
|---|---|---|---|---|
| 1 | `apps/api/src/modules/validation/session-routes.ts` | 65 | `validateSubmissionId(req, reply)` | 从 `req.params.submissionId` 取值 |
| 2 | 同上 | 75 | `validateEventId(req, reply)` | 从 `req.params.eventId` 取值 |

> **现状**：两个函数体完全相同，只是参数名不同（`submissionId` vs `eventId`）。可以参数化。
>
> **建议**：P2 — 提取为 `validateUuidParam(req, reply, paramName: string): string | null`。

---

## 三十九、CSS 文件完全无引用确认

### 39.1 Card Set CSS 文件零引用（第四轮确认）

| 文件 | 行数 | 搜索结果 |
|---|---|---|
| `apps/web/app/styles/card-set-carousel.css` | ~1200 行 | grep `card-set-carousel` 零匹配（无 import/require） |
| `apps/web/app/styles/card-set-detail.css` | ~763 行 | grep `card-set-detail` 仅在 AppShell 路由匹配和 desktop-window-adaptation 测试中出现（非 CSS 引用） |

> **现状**：第四轮确认 CSS 文件完全无引用。`DeckPose` 类型也零引用（之前在审计中提到 `DeckCover.tsx` 仍导入 `DeckPose`，但 `DeckCover` 本身也零引用）。
>
> **建议**：P1 — 两个 CSS 文件和 `DeckCover.tsx` 可安全删除。

---

## 四十、重复的错误类定义普查

### 40.1 19 个 `extends Error` 的自定义错误类

以下文件各自定义了 `class XxxError extends Error`：

| # | 文件 | 类名 | 用途 |
|---|---|---|---|
| 1 | `apps/api/src/modules/validation/session-service.ts` | `SessionError` | 验证会话错误 |
| 2 | `apps/api/src/modules/companion-journey/journey-reducer.ts` | `JourneyActionError` | 旅程动作错误 |
| 3 | `apps/api/src/modules/companion-journey/journey-service.ts` | `JourneyServiceError` | 旅程服务错误 |
| 4 | `apps/api/src/modules/learning-runs/run-errors.ts` | `LearningRunServiceError` | 学习运行错误 |
| 5 | `apps/api/src/modules/learning-runs/run-critic.ts` | `CriticUnavailableError` | 评价器不可用 |
| 6 | 同上 | `CriticOutputError` | 评价器输出错误 |
| 7 | `apps/api/src/modules/card-generation-v2/author-service.ts` | `AuthorValidationError` | 作者校验错误 |
| 8 | `apps/api/src/modules/card-generation-v2/target-snapshot-adapter.ts` | `TargetSnapshotError` | Target 快照错误 |
| 9 | `apps/api/src/modules/card-generation-v2/helpers.ts` | `CardGenerationV2ServiceError` | 卡片生成 V2 服务错误 |
| 10 | `apps/api/src/modules/review/scheduling-policy.ts` | `ReviewSchedulingPolicyError` | 复习调度策略错误 |
| 11 | `apps/api/src/modules/review/attempt-service.ts` | `ReviewAttemptError` | 复习尝试错误 |
| 12 | `apps/api/src/modules/learning-sessions/gold-rounds.ts` | `GoldRoundsError` | 金牌轮次错误 |
| 13 | `apps/api/src/modules/learning-sessions/voice-providers/edge-tts.ts` | `EdgeTtsError` | Edge TTS 错误 |
| 14 | `apps/api/src/modules/learning-sessions/voice-providers/siliconflow-asr.ts` | `SiliconFlowAsrError` | 硅基流动 ASR 错误 |
| 15 | `apps/api/src/modules/learning-sessions/voice-providers/openai-compatible.ts` | `OpenAiCompatibleError` | OpenAI 兼容错误 |
| 16 | `apps/api/src/modules/learning-sessions/voice-providers/qwen-tts.ts` | `QwenTtsError` | 通义 TTS 错误 |
| 17 | `apps/api/src/modules/learning-sessions/tutor-detour.ts` | `TutorDetourError` | 导师绕行错误 |
| 18 | `apps/api/src/modules/learning-sessions/commit-outbox.ts` | `CommitOutboxError` | 提交信箱错误 |
| 19 | `apps/api/src/modules/learning-sessions/relation-governance.ts` | `RelationGovernanceError` | 关系治理错误 |
| 20 | `apps/api/src/modules/learning-sessions/answer-submission.ts` | `AnswerSubmissionError` | 答案提交错误 |
| 21 | `apps/api/src/modules/learning-sessions/qualification-report.ts` | `QualificationReportError` | 资格报告错误 |

> **现状**：项目中有 21 个自定义 Error 子类，大部分实现模式完全相同——构造函数设置 `statusCode`、`code`、`message`。没有一个统一的 `DomainError` 基类。
>
> **建议**：P1 — 提取 `DomainError` 基类（含 `statusCode`、`code`、`message`），所有自定义错误继承它。减少约 100 行重复构造函数代码。

---

## 四十一、`ReviewSchedule.subjectType` 中的 V1 枚举值残留

### 41.1 `"card"` 和 `"key_point"` 枚举值

| 项目 | 详情 |
|---|---|
| **文件** | `packages/shared/src/types.ts` |
| **位置** | 第 94 行 |
| **冗余内容** | `subjectType: "card" | "validation" | "key_point"` — `"card"` 对应 V1 学习卡（已退役），`"key_point"` 对应 V1 要点（表已删除） |
| **现状** | V2 使用 `"objective"` 作为 subjectType。但类型定义中仍保留 V1 枚举值 |
| **建议** | P3 — 确认数据库中是否仍有 `"card"` / `"key_point"` 类型的历史 schedule。若无，从类型中移除 |

---

## 四十二、优先级建议（第五轮更新）

| 优先级 | 类别 | 预估清理量 | 风险 |
|---|---|---|---|
| **P0 - 立即** | 4.1 RC manifest fill 脚本（已弃用，引用已删除文件） | 127 行 | 低 |
| **P0 - 立即** | 6.1 无调用的 feature flag 函数（isCardGenerationV1WriterEnabled 等） | ~60 行 | 低 |
| **P0 - 立即** | 12.2 `void resolveObjAndCard` 抑制的未使用函数（55 行实现） | ~55 行 | 低 |
| **P0 - 立即** | 16.2 `void v2RunId` 抑制 | 2 行 | 低 |
| **P1 - 短期** | 20.1 `packages/db` 整个镜像包（无 import 消费方） | ~20 个文件 | 中（需确认 drizzle-kit 不依赖） |
| **P1 - 短期** | 11.1 sha256Hex 重复定义（14 处私有副本） | ~80 行 | 低 |
| **P1 - 短期** | 12.1 `if (false)` 死分支（8 处） | ~30 行 | 低 |
| **P1 - 短期** | 22.1 AppShell `/card-sets/` 路由匹配 | 1 行 | 低 |
| **P1 - 短期** | 26.1–26.5 前端零调用 API 客户端方法（8 个） | ~80 行 | 低 |
| **P1 - 短期** | 27.1–27.2 `@deprecated` governance 函数（checkAIConsent + enforcePrivacyGovernance） | ~60 行 | 中（需确认替代方已接线） |
| **P1 - 短期** | 2.1 discrete-v1 调度策略旧版逻辑 | ~120 行 + 测试 | 中（需确认灰度完成） |
| **P1 - 短期** | 3.1–3.7 V1 退役注释清理 | 注释 | 低 |
| **P1 - 短期** | 7.1–7.2 Card Set CSS 文件 + DeckCover.tsx | ~1970 行 | 低（已确认零引用） |
| **P1 - 短期** | 34.1–34.3 重复的错误类定义（21 个 extends Error） | ~100 行 | 中 |
| **P2 - 中期** | 11.2 stableStringify 重复定义（6 处私有副本） | ~60 行 | 低 |
| **P2 - 中期** | 2.4 首页 Onboarding legacy fallback | ~10 行 | 低 |
| **P2 - 中期** | 3.2 Learning Runs V1 兼容薄壳 | ~60 行 | 中（需确认前端迁移完成） |
| **P2 - 中期** | 5.1 Legacy Adapter | ~526 行 + 测试 | 高（需确认数据迁移完成） |
| **P2 - 中期** | 5.2 Learning Card Library 合并函数 | ~20 行 | 中 |
| **P2 - 中期** | 14.1 `LegacyRouteResolutionStatus` 退役枚举值 | 类型修改 | 低 |
| **P2 - 中期** | 14.2 `CardSetRecord`/`CardSetListItem` 退役类型 | 类型修改 | 中 |
| **P2 - 中期** | 15.1 Origin Migration 已移除分支注释 | 注释 | 低 |
| **P2 - 中期** | 16.1 Companion Bridge V1 payload 兼容分支 | ~40 行 | 中（需确认客户端升级） |
| **P2 - 中期** | 21.1 Worker index.ts V1 删除注释 | 注释 | 低 |
| **P2 - 中期** | 22.2 Focus Layout 注释中的 `/card-sets/[id]` | 注释 | 低 |
| **P2 - 中期** | 22.3 Learning Card 详情页 `forbidden`/`ambiguous` 错误消息 | ~4 行 | 低 |
| **P2 - 中期** | 24. Schema 注释中的 V1 引用残留（20+ 处） | 注释 | 低 |
| **P2 - 中期** | 27.3 `adaptFetchToPublicJsonRequester` TEST-ONLY 适配器 | ~30 行 | 中（需替代 mock 方案） |
| **P2 - 中期** | 27.4 `LogAICallParams.userId` 废弃字段 | 类型修改 | 低 |
| **P2 - 中期** | 28.1 Supervisor Agent V1 Grafana dashboard | ~366 行 JSON | 中（需确认指标已退役） |
| **P2 - 中期** | 29.1 `getToken()` 恒 null 的残留调用方 | ~10 行 | 低 |
| **P2 - 中期** | 30.1 `setToken()` 恒无效的残留调用方 | ~15 行 | 低 |
| **P2 - 中期** | 31.1 `registerWithInviteToken`/`registerPersonal` 零调用方法 | ~20 行 | 低 |
| **P2 - 中期** | 32.1–32.2 `parse*` 辅助函数零消费方（8 个） | ~40 行 | 低 |
| **P2 - 中期** | 33.1 URLSearchParams 重复构造模式（11 处） | ~50 行 | 低 |
| **P2 - 中期** | 35.1 `types.ts` V1 遗留类型（8 个零消费方） | ~60 行 | 低 |
| **P2 - 中期** | 36.1 `normalizeText` 重复定义（3 处） | ~6 行 | 低 |
| **P2 - 中期** | 37.1 `relativeTime`/`formatRelativeTime` 重复定义 | ~30 行 | 低 |
| **P2 - 中期** | 38.1 `sendSessionError`/`sendServiceError` 重复模式 | ~20 行 | 低 |
| **P2 - 中期** | 38.2 `validateSubmissionId`/`validateEventId` 近似重复 | ~20 行 | 低 |
| **P2 - 中期** | 39.1 CSS 文件 + DeckCover 完全无引用确认 | ~1970 行 | 低 |
| **P3 - 长期** | 5.3 Understanding V1 vs V3 reader | 整个模块 | 高（需评估路由调用方） |
| **P3 - 长期** | 8. 备份快照目录 | 整个目录 | 低 |
| **P3 - 长期** | 13.1 501 占位路由（Topology V3 deltas） | 5 行 | 低 |
| **P3 - 长期** | 14.3 `LearningCardRecord` V1 字段 | 类型修改 | 中 |
| **P3 - 长期** | 17.1–17.2 Review Service V1 路径 | ~30 行 | 高（需确认历史数据） |
| **P3 - 长期** | 18.1 Shadow Translator | 149 行 | 高（需确认 cutover 完成） |
| **P3 - 长期** | 20.2 `legacySessionId`/`legacyEpisodeId`/`legacyOrdinal` 列 | 3 列 + 1 索引 | 高（需确认迁移完成） |
| **P3 - 长期** | 20.3 `legacy_unrubriced` 枚举值 | 枚举修改 | 中 |
| **P3 - 长期** | 23.1 `deprecatedProgress` 测试断言 | 1 行 | 低 |
| **P3 - 长期** | 28.2 Migration SQL 中的 V1 表定义 | 历史文件 | 低（仅在 squash 时清理） |
| **P3 - 长期** | 37.2 `formatDate` 重复定义（2 处） | ~10 行 | 低 |
| **P3 - 长期** | 42.1 `ReviewSchedule.subjectType` V1 枚举值 | 类型修改 | 中 |
