# W8 证据：真实 Provider / ASR 与 RC 质量收口

> 对应任务 11-2 证据文件 10。佐证 DoD 35。
> 决策记录：`docs/plans/learning-companion/09-1-gold-rounds.md` ~ `09-7-hard-invariants-closeout.md`。

## 1. 交付文件核验（路径存在 + 测试全绿）

| 文件 | 对应记录 | 职责 | 测试 |
| --- | --- | --- | --- |
| `apps/api/src/modules/learning-sessions/gold-rounds.ts` + `.test.ts` | 09-1 | 多模态 Gold 两轮编排（baseline/recheck）、标注覆盖矩阵、固定对抗集泄漏检查、分层统计 + W0 阈值对比 | `npm test --prefix apps/api` 全量通过 |
| `apps/api/src/modules/learning-sessions/release-qualification.ts` + `.test.ts` | 09-2 | 最终 release qualification：冻结 RC Gold 两轮（W4 从未见过）、严格口径、变更从第一轮重跑 | 同上 |
| `apps/api/src/modules/learning-sessions/critic-tutor-quality.ts` + `.test.ts` | 09-3 | Critic 与人工逐项一致性、Tutor 六项冻结要求（evidence 完整率 100%、precision ≥95%、扩展知识伪装 0 等） | `critic-tutor-quality.test.ts` 50 例全绿（# tests 2693 / fail 0） |
| `apps/api/src/modules/learning-sessions/capacity-perf.ts` + `.test.ts` | 09-4 | 容量 fixture 矩阵（243 组合）、性能门限（p95/帧率/内存/相对预算）、报告环境完整性强制 | `capacity-perf.test.ts` 24 例全绿（# tests 2613 / fail 0） |
| `apps/api/src/modules/learning-sessions/fault-injection-rc.ts` + `.test.ts` | 09-5 | RC 故障注入矩阵（11 项 × 5 次）、crash/retry/cancel/stale/rollback 重复执行、router 对账、重试放大、recovery queue SLA | `fault-injection-rc.test.ts` 106 例全绿 |
| `apps/api/src/modules/learning-sessions/real-env-rc.ts` + `.test.ts` | 09-6 | 真实环境证据清单（6 项五类组件）、成本与调用放大 Gate、零调用/零成本 Gate | `real-env-rc.test.ts` 42 例全绿（# tests 2735 / fail 0） |
| `apps/api/src/modules/learning-sessions/hard-invariants.ts` + `.test.ts` | 09-7 | §16.1 硬指标 22 项（19 项 0 容忍 + 3 项 100%）、§17.1 必测行为 35 条、伪通过检测（placeholder/skip/insufficient-data） | `hard-invariants.test.ts` 78 例全绿（# tests 2561 / fail 0） |

## 2. 多模态 Gold 两轮（09-1，佐证 DoD 35 前半）

- **两轮编排**：第一轮 `round=1, role=baseline` 建立基线；第二轮 `round=2, role=recheck` 修复后复测；round/role 强校验，不匹配抛 `GoldRoundsError`；`compareRounds` 按 `(metric, modality, rubricId, facet)` 配对，`roundsNotRegressed` 必须为 true——**修复后复测不得回归**。
- **标注覆盖矩阵**：语音 Teach-back、ordering/graph/repair 的 formal/practice 两态（6 项）、`structured-proof-v1` 全 bundle 与缺一 Scene（3 family 各 2 互补 Scene）、跨模态公平性四类分层（false-upgrade / false-downgrade / abstain / not_assessable，voice 与 silent_bundle 两侧）——分层由 `(systemVerdict, goldVerdict)` 推导，**不依赖标注者自报**。
- **固定对抗集答案泄漏 0**：`checkAdversarialLeak` 全集非空（空集 fail closed）、泄漏引用必须在全集内、`leaked === 0`；任一轮泄漏 >0 → 该轮失败。
- 判定口径：`abstain` / `not_assessable` 独立计数不计入 precision/recall 分母；人工双标不一致只计 `disagreement`。

## 3. 最终 release qualification（09-2，佐证 DoD 35）

- **W0 冻结阈值单一来源**（`W0_FROZEN_THRESHOLDS`）：人工双标一致性 ≥0.80、Critic upgrade precision ≥0.95、recall ≥0.90、分层最小可判样本 3；注入低于冻结值抛 `ReleaseQualificationError`，`thresholdAdjustmentAllowed` 恒 false。
- **冻结 RC Gold 两轮**：`w4UnseenFrozenRcSet` 必须 true（W4 从未见过）；两轮各自**严格口径**判定——每项阈值对比必须 `passed===true`，样本不足（`passed=null`）同样视为未达标（release 是最终 gate，杜绝样本不足伪通过）。
- **变更从第一轮重跑**：配置快照（模型 / prompt / profile registry / 阈值版本）两轮不一致即 `config_changed_between_rounds` 违规（fail closed）。
- **silent mastery bundle 一致性**：人工一致性基于 gold 共识；voice 路径按 `itemId` 配对；Wilson score 置信区间（Acklam 近似 ~1e-9），`requireCILowerBoundAboveThreshold=true` 时区间下界 ≥ 阈值。
- **缺 eligible profile 为 0** + 整体与各 family（procedure / causal-boundary / concept-application）覆盖率门槛；模态间只比较相同 facet。

## 4. Critic 与 Tutor 质量（09-3，佐证 DoD 35）

- Critic 与人工逐项一致性按 (facet) 计算，口径与 `qualification-report.ts`（W4 blinded qualification）完全一致，阈值与 §3 同源。
- Tutor 六项冻结要求全部有确定性校验：① evidence refs 完整率 100%（`checkEvidenceRefsCompleteness`）；② source-grounded substantive support precision ≥95%（缺人工复核不计分子，fail closed）；③ 扩展知识伪装成当前文章事实 0；④ 不足以回答必须 abstain（abstain 后不得呈现带来源标签事实段）；⑤ Tutor 输出直接进 canonical Card / published relation / mastery 0（proposal 全部 `requiresUserConfirmation=true`）；⑥ Should flag 下错误 support mode / 越权 workspace / unsupported 段使用来源标签 0。
- 与 07-7 的类型面保证（`forbiddenOutputs` / `sourceLabelAllowed`）构成双层保障：本模块对真实运行产物做确定性复核。

## 5. 容量与性能 RC（09-4，佐证 DoD 35）

- 容量 fixture 矩阵：Note 2K/13K/50K × Key Points 1/10/30 × Episodes 1/3/5 × 星图 100/1K/5K × 并发 1/5/25 = **243 组合**，任一维度必须命中冻结档位。
- 性能门限（W0 冻结）：本地 action → 下一帧视觉 commit p95 < 100ms；Scene state transition → 首个可交互帧 p95 < 300ms（均不含网络/Provider）；1,000 节点星图帧率 ≥ 50fps 基线；移动端内存 ≤ 300MB 绝对 + 80MB 相对增量；Global Shell 新增 JS/渲染/路由 p95 相对基线增量 ≤ 200ms（超限优先降级角色）；单场景样本量 ≥ 100。
- **报告环境完整性强制**：硬件（桌面参考机/中档移动设备）、浏览器（Chrome stable）、构建、数据 fixture、网络条件、区间必须记录；冷热路径分离；禁止 `dev_machine` 数据；聚合口径必须 p95（禁止平均值替代）。

## 6. 故障注入与降级 RC（09-5，佐证 DoD 35）

- RC 故障注入矩阵 **11 项 × 每项重复 5 次**：星图故障（100/1K/5K 节点）、并发 Session、ASR 故障、LLM 故障、对象存储故障、全局壳性能影响、跨设备恢复、登录过期、Companion 全故障降级；hard 项任何一次重复违反 → `rollbackEvaluationRequired = true`（立即回滚评估），缺测判 fail 不静默通过。
- crash/retry/cancel/stale/rollback 五类重复执行 5 次断言 100%：crash 恢复不重做已锁输入；retry 同一 provider/job attempt 重复计费调用 0；cancel 确认后新增调用 0；stale 拒绝；rollback 无残留 partial、不重复 commit。
- router 与 `CompanionPageCoverageRegistryV1` **100% 对账**（方向 A：每个真实路由被覆盖；方向 B：无 manualFallback 的 entry 必须命中真实路由）。
- 重试放大系数 = 计费调用 / 唯一请求，上限 1.5（`DEFAULT_RETRY_AMPLIFICATION_CAP`，W0 冻结）；recovery queue SLA 300s：已锁答案用预留额度完成评估、不得永久卡在 retryable、超 SLA 以 operational failure 结束且 0 学习副作用。

## 7. 真实环境 RC（09-6，佐证 DoD 35 核心）

- **真实环境证据清单 6 项（0 伪通过）**：真实 Provider 计费 LLM 调用（`provider_llm_call` / `provider_token_usage`）、真实 ASR 逐字 transcript（`asr_transcription`）、真实 PostgreSQL 事务读写（`postgresql_live`）、真实对象存储 put/get 哈希一致（`object_storage_put_get`）、Chrome stable 真实浏览器主路径旅程（`browser_e2e`）。`validateRealEnvEvidence` 判定：质量必须 `real`；`placeholder / skip / insufficient_data` 一律违规；`requiresArtifact` 证据必须带 `artifactRef`；清单缺测 / 未知 id / 重复上报违规。
- **成本与调用放大 Gate（W0 冻结上限）**：每 Episode LLM 调用 ≤12 / 输入 token ≤40,000 / 输出 token ≤8,000 / 对象存储 ≤1,000,000B / Tutor 预算 ≤4；每 Session ASR ≤600s / TTS ≤20,000 字符；用户级 p95：LLM 调用 ≤100 / 输入 ≤300,000 / 输出 ≤60,000 / ASR ≤3,600s / TTS ≤120,000 / 存储 ≤5,000,000B / Tutor ≤30。任一 p95 越限 → `stopScaling = true` 立即停止扩量；用户成本样本为空 → 违规（insufficient-data 伪通过）。
- **禁止缩减质量项绕过**：以缩减 Critic / 证据 / A11y 任一方式绕过成本上限的上报一律违规；Tutor detour 独立 envelope 不得借用 formal 预算（借用 >0 违规）。
- **零调用 / 零成本 Gate**：用户取消被服务端确认后新增 LLM/ASR/TTS/对象存储调用 0；`temporary_hidden/global_off` 确认后新增 Companion 成本 0（全维度含 Tutor）；公开认证层 / 安静锚点 / 未触发页面 context 注册三个表面的 Provider 调用 0。

## 8. 硬不变量与必测行为收口（09-7，佐证 DoD 35 的判定层收口）

- `HARD_INVARIANTS_16_1`：§16.1 全部 **22 项**硬指标（19 项 0 容忍 + 3 项 100%），每项含冻结文本、证据链映射与真实断言（读 `Section161Observations`）。
- `MUST_TEST_BEHAVIORS_17_1`：§17.1 全部 **35 条**必测行为（17.1-01 ~ 17.1-35），共 71 条真实断言。
- **伪通过检测机器可判**（`detectFakePass`）：断言列表为空 → placeholder；`requires` 未声明或声明字段未被实际读取 → insufficient-data；判定未读任何观察字段 → skip；任一伪通过 → `allClosed=false`、`rollbackEvaluationRequired=true`。清单缺测（裁剪为空/缺项）不静默通过。
- **双样本是每项断言的「可失败性」证明**：测试对每项构造干净样本（全 pass）与违规样本（破坏首个断言依赖字段 → 必 fail），覆盖全部 57 项/条。
- 收口编排 `runHardInvariantCloseout` 汇总 `summary.allClosed`；`assertHardInvariantCloseout` 0 容忍 fail closed。

## 9. 判定层证据

- 本阶段全部为**判定层交付**：数据源/场景端口注入、无 IO；真实样本（真实 Provider 调用、真实 ASR 转录、真实 PostgreSQL/对象存储、真实浏览器旅程、两轮 Gold 标注）由 RC harness 采集后注入本层复核——「判定层已交付；真实运行样本由 RC 执行环境采集后回填」的状态在 `release-manifest.json` 中如实标注，不虚构样本数据。
- 验证记录：`npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）；各测试文件计数见 §1 表（gold-rounds / release-qualification / critic-tutor-quality 50 / capacity-perf 24 / fault-injection-rc 106 / real-env-rc 42 / hard-invariants 78 全部全绿）。
- 决策记录 09-1 ~ 09-7 状态均为 Frozen（已冻结）。
