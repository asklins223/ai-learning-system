# 冻结记录 05-1：最小 SilentProofProfile registry 与 eligibility matrix（§7.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 05（W4）任务 05-1
> 日期：2026-08-08
> 来源：`05-w4-scene-runtime-silent-profile.md` 任务 05-1（原方案 §7.4 + §6.4/§16.2）；冻结记录 `01-2-session-scene-artifact-trust-contracts.md` §7.4/§8.2/§8.3
> 约束级别：**无 eligible profile 的目标不展示 silent mastery 路线**；100% 被路由到 structured proof 的目标必须 eligibility=`eligible`。

**交付物**：`packages/shared/src/silent-proof-profile-contracts.ts`（契约单一来源，zod strict）、`apps/api/src/modules/learning-sessions/silent-profile-registry.ts`（最小 registry + eligibility matrix）、`silent-profile-registry.test.ts`（单测）、本文档（决策记录）。

---

## 1. 冻结范围（§7.4 + 01-2 §8.2）

- `SilentProofProfile` 是 **versioned 资格模板**，不是对所有知识通吃的小游戏；
- 初始 family 三个，每个合格 bundle **至少两个互补 Scene**；
- 每个 `structuredProofEligibilityReport` 必须证明**五项**（任一失败 → `ineligible`，fail closed）；
- 公测 silent route 采用 **Key Point 级激活**；无 eligible profile 的目标不展示 silent mastery 路线；
- Relation Canvas **只操作当前 Key Point 的冻结 Scene 结构**，不创建共享 semantic relation；
- 本任务不写掌握/schedule 真值（registry 与守卫均为纯函数）。

## 2. 初始 family 与最小 profile

| family | profile id | 互补 Scene 组合 | facets（可证明） | 状态 |
| --- | --- | --- | --- | --- |
| `procedure`（排序 + 修复） | `silent-proof-procedure-v1` | `ordering-scene-v1` + `repair-scene-v1` | procedure, boundary | active（已过 Gold） |
| `causal-boundary`（关系重建 + 条件变式） | `silent-proof-causal-boundary-v1` | `relation-canvas-scene-v1` + `conditional-variant-scene-v1` | relate, boundary, apply | active（已过 Gold） |
| `concept-application`（开放构建 + 情境应用） | `silent-proof-concept-application-v1` | `open-construction-scene-v1` + `situated-application-scene-v1` | explain, apply | active（已过 Gold） |

- 全部 profile **不声明 `recall`**：结构题公开 token 可展示完成操作所需 token 文本，但不得证明无提示 recall（01-2 §3.2）；
- `goldCertificationHash` 为独立 Gold 认证 hash（确定性生成占位，表示该 profile 已通过 false-upgrade/false-downgrade Gate）；active profile 必须持有，缺失则不得 eligible。

## 3. eligibility matrix：structuredProofEligibilityReport 五项证明

报告字段（`profileId / keyPointId / requiredFacets / coverageProof / recallNonDisclosure / discrimination / a11yEquivalence / goldPassed / eligibility`）：

| # | 证明 | 判定条件（全部满足才合格） | 失败原因码（示例） |
| --- | --- | --- | --- |
| 1 | `coverageProof` | 每个 required facet 至少一条 `answerNotLeaked=true` 的结构证据；证据 sceneId 属于 profile 互补 Scene 结构 | `missing_facet_coverage:*`、`answer_leaked_by_structural_evidence`、`evidence_scene_outside_profile_complementary_set` |
| 2 | `recallNonDisclosure` | profile facets / requiredFacets / claimedRecallFacets 均不声称 `recall`（公开 token 不覆盖无提示 recall） | `recall_not_provable_by_structured_scene_public_tokens` |
| 3 | `discrimination` | 区分度 basis 非空（valid_distractors / no_unique_slot_guess / multi_step_dependency / no_snapping_assist / sufficient_operation_count） | `no_discrimination_basis` |
| 4 | `a11yEquivalence` | 等价操作存在（tap_select_place / keyboard / screen_reader / reduced_motion）且语义要求不降低 | `missing_a11y_equivalent_operations` |
| 5 | `goldPassed` | 提交的独立 Gold 认证 hash 与 profile.goldCertificationHash 匹配 | `independent_gold_not_passed_or_mismatch` |

综合：`buildEligibilityReport` 五项全通过 → `eligibility=eligible`，否则 `ineligible`（fail closed，reasonCodes 累积）；profile 未注册抛 `EligibilityReportError(profile_not_found)`。

## 4. Key Point 级激活

`assertKeyPointEligibility({ keyPointId, routedToStructuredProof, eligibilityReport })`：

- 未路由到 structured proof → 允许（不展示 silent route）；
- 路由到 structured proof 的目标 **100% 必须 eligibility=`eligible`**：
  - `eligibilityReport === null`（无 eligible profile）→ 拒绝，`silentMasteryRouteOffered=false`；
  - report keyPointId 不匹配 → 拒绝；
  - report eligibility ≠ `eligible` → 拒绝；
- 通过 → 允许激活并展示 silent mastery 路线。

## 5. Relation Canvas 作用域

`relationCanvasScopedToFrozenScene`：操作目标必须属于当前 Key Point 冻结 Scene 结构（`sceneId ∈ frozenSceneIds`），且 **不得创建共享 semantic relation**（跨节点 published relation 属后续治理能力，01-2 §8.1）。任一违反 → 拒绝（fail closed）。

## 6. 实现边界与收口迁移

- `packages/shared/src/silent-proof-profile-contracts.ts` 为契约**单一来源**（zod strict schema + 类型）；`packages/shared/src/index.ts` 由主代理统一收口追加 `export * from "./silent-proof-profile-contracts.ts"`；
- 收口前 `@ailearn/shared` 未导出新契约，且 api 的 `tsconfig rootDir` 不允许跨包相对导入，故 registry 按 trust-service 同款先例**本地声明同型接口**（structural 兼容）；主代理收口后应改为 `import { ... } from "@ailearn/shared"`；
- 本 registry 全部为纯函数：不读时钟、不改状态、不写掌握/schedule 真值；报告产出后不落库。

## 7. 验收

- [x] 3 family 注册、id 唯一、versioned 模板、active profile 已过 Gold；
- [x] 每个合格 bundle ≥2 互补 Scene（排序+修复 / 关系重建+条件变式 / 开放构建+情境应用）；
- [x] 报告五项证明 + fail closed 综合 eligibility；
- [x] 无 eligible profile 的目标不展示 silent mastery 路线（`silentMasteryRouteOffered=false`）；
- [x] Relation Canvas 不创建共享 semantic relation；
- [x] `npm run typecheck --prefix apps/api` 通过；`npm test --prefix apps/api` 通过（含 `silent-profile-registry.test.ts`）。
