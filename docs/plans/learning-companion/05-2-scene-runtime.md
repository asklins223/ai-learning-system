# 冻结记录 05-2：Structured Scene Runtime（§6.3 + §6.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 05（W4）任务 05-2
> 日期：2026-08-08
> 来源：`05-w4-scene-runtime-silent-profile.md` 任务 05-2（原方案 §6.3+§6.4）；冻结记录 `01-2-session-scene-artifact-trust-contracts.md` §3~§5/§7.3/§8.3
> 约束级别：**任意 UI/code 生成不可达**；未审核 Scene 无法展示；public payload 零 private 字段。

**交付物**：`packages/shared/src/scene-contracts.ts`（Scene 契约单一来源，zod strict）、`apps/api/src/modules/learning-sessions/scene-safety.ts`（scene-safety-v1）、`scene-safety.test.ts`（单测）、`apps/api/src/modules/learning-sessions/scene-activation.ts`（Scene Activation Service）、`scene-activation.test.ts`（单测）、本文档（决策记录）。

---

## 1. Scene 契约（01-2 §3.1/§3.2）

7 种 Scene 类型以 discriminated union 冻结：`VoiceTeachbackScene / OrderingScene / RelationCanvasScene / RepairScene / MultiStepScenarioScene / CounterexampleScene / OptionalTextScene`；Supervisor 只能选择并填充 versioned Scene schema，**不允许模型任意生成界面**（§6.3）。

每个 Scene 冻结字段（zod strict，`packages/shared/src/scene-contracts.ts`）：

- `sceneId / sceneType / template / version`；
- `target { keyPointId, targetIds }`、`sourceFingerprint`、`capabilityFacet`；
- `mode`（formal / practice）、`publicPayloadHash / publicPayloadVersion` 与 `secretSolutionHash / secretSolutionVersion` 独立；
- `disclosureProfile { maxProvableTrustClass, exposesTokenText, provableRecall, feedbackTiming }`；
- 逐 `rubricEvidenceBindings`（rubricItemId / criterion / evidenceRefIds / evidenceKind / server-only expectedTargetHash）；
- `assistancePolicy`、`templateTrustCeiling`、`feedbackTiming`；
- `distractorIds / branchIds / maxOperations / maxAttempts`；
- `a11yEquivalentPaths`（keyboard / tap-select-place / screen-reader / reduced-motion，语义要求不降低）。

## 2. Scene 三对象物理拆分（01-2 §3.2）

| 对象 | 可见性 | 内容 |
| --- | --- | --- |
| `PublicSceneContract` | 可返回客户端 | 净化题面、opaque token IDs、可见 token 文本、操作协议、A11y、publicPayloadHash / disclosureProfileHash / templateTrustCeiling |
| `PrivateSceneSolution` | 仅服务端/评估器 | 正确顺序/关系/branch、distractor 身份、rubric evidence binding、expected target refs |
| `PrivateLearningEpisodeContract` | 仅服务端 | target/schedule/fingerprint、RubricTargets、frozen probes、policy/model refs、budget、planHash |

客户端只得到净化 Session/Scene view；`PrivateSceneSolution` 与 `PrivateLearningEpisodeContract` 在 network/RSC/prefetch/cache/DOM 中字段级不可达（03-4 `PUBLIC_DTO_FORBIDDEN_FIELDS` + 本任务 active contract 的净化 `publicSceneContract` 双重保证，测试断言 `JSON.stringify` 不含 `correctOrderIds`/`secret`/`rubricTargets` 等）。

## 3. scene-safety-v1（01-2 §3.3）

每个动态 formal Scene 激活前执行，全部确定性纯函数（`scene-safety.ts`）：

1. **schema**：字段类型/枚举/必需/未知键（收口后改用 shared zod `safeParse`）；
2. **public/secret 分离**：public 对象零 private 字段名、public/secret 独立 hash 重算一致；
3. **allowlisted IDs**：secret 解引用 ID ⊆ 公开 allowed token/node/edge/option 集；rubric evidence refs ⊆ 预绑定集；
4. **答案泄漏**：public token 文本不覆盖 secret 答案文本；结构题不得声称 recall（01-2 §3.2）；disallowed claim / secret hash 不得出现在 public；
5. **可评估性**：secret 解非空；formal 无即时泄题（feedbackTiming ≠ immediate、不揭示答案）；
6. **唯一解或有效多解**：多解必须显式声明（`acceptPermutedGroups` / `acceptedRepairs`），否则唯一解且完整覆盖非 distractor 项；
7. **distractor 区分度**：distractor 有效、与答案文本互异、互不重复；无 distractor 需其他 basis（no_unique_slot_guess / multi_step_dependency / sufficient_operation_count）；
8. **事实支撑**：每 rubric evidence binding 引用的证据存在且 `semanticSupport=supported`；source fingerprint 与 Key Point 匹配；
9. **prompt injection**：`<script` / `javascript:` / `data:text/html` / `<svg` / `onerror=` 全形态拒绝；ID 必须安全形态（拒绝路径穿越）；
10. **语言与 A11y**：无替换字符乱码、等价操作存在且语义不降低、无计时/速度评分。

**mandatory 独立 Rubric/Scene Critic**（可注入 `SceneCriticPort`）：deterministic 全通过后必须 Critic=`approved` 才可激活。

**修复一次语义**：`runSceneSafetyWithRepair` 失败最多修复一次，仍失败按分类判定：
- 结构性失败（separation / allowlist / assessability / solution_uniqueness / distractor / factual）→ `blocked`（fail closed）；
- 仅 Critic 拒绝或可重试内容问题（prompt injection / 泄漏 / 语言）→ `question_retryable`。

**静态模板复用历史 approval**：只有完全静态且带不可变 `certificationHash`、内容槽位仍通过 deterministic allowlist 的模板可复用历史 approval（跳过动态 Critic）；任一行不满足 → 复用不可用，退回动态 Critic 路径。

判定枚举：`approved / repair_required / question_retryable / blocked`；报告含逐检查项结果、criticApproved、staticCertificationUsed、repairAttempts 与确定性 `reportHash`。

## 4. Scene Activation Service（01-2 §3.3）

唯一激活权限属于 deterministic `Scene Activation Service`（`scene-activation.ts`）。`activateSceneContract` 事务内按固定顺序验证，全部通过才产出并**写入一次 immutable active contract**：

1. **actor 权限**：`isActivationAuthorizedActor(actor)==="scene_activation"`；`assertNoActivatePermission` 断言 Author/Supervisor/Critic/Companion 越权即抛 `SceneActivationError`（网关侧 03-4 已确认：`DETERMINISTIC_ROLE_TOOL_IDS.scene_activation=["activate_scene_contract"]`，六个 LLM 角色 allowlist 均不含该工具，双防线）；
2. **Scene Author staging**：`readStagingStatus` 必须 `staged`（未注入 → fail closed）；
3. **scene-safety-v1**：`verdict=approved`；
4. **Critic / 静态认证**：`criticApproved=true` 或 `staticCertificationUsed=true`；
5. **两态一致性**：formal 无即时泄题 / practice ceiling 必须 `practice_only`；
6. **hashes**：public/private/solution/disclosure hashes 与 Episode 冻结 `FrozenProbeRef` 逐项一致；
7. **planHash**：`verifyPlanHash` 验证冻结 planHash 覆盖本 probe 全部 hashes（委托 session-service `computePlanHash`）；
8. **epoch**：`currentEpoch` 与冻结 `runtimeEpochSnapshot + episodeEpoch` 逐项一致，缺失（null）→ `epoch_mismatch` fail closed（03-6）；
9. **BudgetEnvelope**：ref/hash 匹配且 `sufficient=true`（不可借用，预算不足作答前阻断，01-2 §5.3）。

产出 `ActiveSceneContract { immutable: true }`；`activationNonce` 确定性生成（同冻结输入恒等），二次写入 → `already_active` 拒绝（exactly-once）。

## 5. 两态（§6.4）

- **formal mode**：无即时泄题；feedbackTiming ∈ {none, after_all_probes}，不揭示答案、无内容帮助；`templateTrustCeiling` 由 disclosure/profile/plan 决定；
- **practice mode**：可即时反馈（feedbackTiming=immediate 允许），ceiling 恒 `practice_only`（0 升级）。

## 6. 各模态最高可信资格（§6.4，已由 04-3 `computeEffectiveTrustClass` 落地，本任务确认）

- 语音讲解 → `mastery_eligible`（Agent 补写/ASR 不可靠/已给内容提示则降级）；
- 无提示排序/拖拽连线/故障修复/多步情境单 Scene → 最高 `facet_eligible`；
- 普通单选/判断/配对 → `diagnostic_only`；提示后 → `practice_only`；
- 关键输入无法可靠解析 → `not_assessable`；
- 等价 Gate 通过前所有结构 Scene 最高只为 `facet_eligible`（01-2 §8.3 R7）。

## 7. 实现边界与收口迁移

- `packages/shared/src/scene-contracts.ts` 为契约**单一来源**（zod strict schema + 类型）；`packages/shared/src/index.ts` 由主代理统一收口追加 `export * from "./scene-contracts.ts"`；
- 收口前 `@ailearn/shared` 未导出新契约，且 api 的 tsconfig rootDir 不允许跨包相对导入，故 api 侧按 silent-profile-registry 同款先例**本地声明同型接口**（structural 兼容），scene-safety 的 schema 校验为本地实现；主代理收口后应改为 `import { ... } from "@ailearn/shared"` 并改用 shared zod `safeParse`；
- 本模块全部为纯函数 + 注入端口：不读时钟（active contract 用确定性 nonce）、不写掌握/schedule 真值；真实 DB 写入由阶段 06 COMMIT/repository 接入（`writeActiveContract` 端口契约已冻结）。

## 8. 验收

- [x] 7 种 SceneSchema zod strict，public/secret 物理分字段；三对象拆分，public payload 零 private 字段（测试断言）；
- [x] scene-safety-v1 十项检查 + mandatory Critic + 修复一次语义（question_retryable / blocked 分类）+ 静态模板 certification hash 复用；
- [x] Scene Activation Service 唯一激活权限、事务内 9 步验证、immutable active contract、exactly-once；Author/Supervisor/Critic/Companion 无 `activate_scene_contract` 权限（断言 + 网关确认）；
- [x] formal/practice 两态；§6.4 各模态最高可信资格由 04-3 落地，本任务确认无回写掌握/schedule；
- [x] `npm run typecheck --prefix apps/api` 通过；`npm test --prefix apps/api` 通过（含 scene-safety 37 例 + scene-activation 16 例）。
