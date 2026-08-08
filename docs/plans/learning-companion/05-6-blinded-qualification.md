# 决策记录 05-6：第一轮 blinded cross-modality qualification 报告（§16.2/§7.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 05（W4）任务 05-6
> 日期：2026-08-08
> 来源：`05-w4-scene-runtime-silent-profile.md` 任务 05-6（原方案 §16.2 + §7.4）+ 冻结记录 01-5 §3（§16.2 指标）、01-2 §8（§7.4 能力切面与 SilentProofProfile 规则）
> 约束级别：开发资格集与 W8 冻结 RC 集不重叠；相同 facet 的人工双标一致性与 Critic precision/recall 阈值 W0 冻结、RC 后不得降低；本报告不用于调低 W8 阈值。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/qualification-report.ts`：第一轮 blinded cross-modality qualification 的报告生成纯逻辑（统计模型，数据源注入）。
- `apps/api/src/modules/learning-sessions/qualification-report.test.ts`：单测（node:test + assert）。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 纯函数统计模型（数据源注入）

- `buildQualificationReport(input)` 为纯函数：全部样本（`QualificationSample[]`）与 W0 冻结阈值（`W0FrozenThresholds`）由调用方注入；模块不读 DB、不读时钟、不调外部服务、不改变状态；
- 输入含开发资格集标识 `qualificationSetId`；报告 meta 输出该标识及 `devSetDisjointFromW8RcSet=true` 声明（与 W8 冻结 RC 集不重叠的显式断言）；
- 非法输入 fail closed（`QualificationReportError`）：release 资格集、`devSetDisjointFromW8RcSet=false`、空标识、越界阈值、未知 modality/facet/verdict 一律拒绝。

### 2.2 分层统计（§16.2 逐项）

- 按 `(modality, rubricId, facet)` 分层：voice 与 silent_bundle 各自按相同 rubric/facet 分层报告
  `false-upgrade`（upgrade 判定侧 FP）、`false-downgrade`（downgrade 判定侧 FP）、`abstain`（不足以回答时明确弃权）、`not_assessable`（ASR 关键内容不可辨 / 结构化输入无法解析）四类计数及相对该层全部样本的率；
- 人工双标一致性：raterA 与 raterB 都存在的样本进入一致性分母，一致率为该层指标；双标不一致（无 Gold 共识）只计 `disagreement`，不进入任何对错判定；
- `abstain` / `not_assessable` 各自独立计数，均不计入 Critic precision/recall 分母（fail closed 语义：未判定不算错判）；
- Critic precision/recall 以「upgrade（掌握证据成立）」为正类，与冻结口径一致：`upgradePrecision = correctUpgrade/(correctUpgrade+falseUpgrade)`、`upgradeRecall = correctUpgrade/(correctUpgrade+missedUpgrade)`；同时提供 downgrade 判定侧 precision/recall 作为补充视角（非冻结主指标）。

### 2.3 模态间只比较相同 facet

- 跨模态对比表 `crossModality` 以 `(rubricId, facet)` 为键配对 voice 与 silent_bundle 的层；任一侧缺失该键 → `comparable=false` 且全部 delta 为 `null`；
- 不同 facet（或不同 rubric）之间绝不产生 delta —— 不要求单个排序 Scene 与开放讲解提供相同信息量（§16.2 补全说明）；
- delta 定义为 `silent − voice`，对 false-upgrade/false-downgrade/abstain/not_assessable 率、upgrade precision/recall、双标一致性分别给出。

### 2.4 阈值对比监控（不用于调低 W8）

- `thresholds` 输出对每层三项冻结指标的对比：`double_label_agreement`、`critic_upgrade_precision`、`critic_upgrade_recall`；
- 每项 `frozen=true`（W0 冻结，RC 后不得降低）；`passed`：达标 `true` / 未达标 `false`（仅监控信号）/ 样本不足或不可计算 `null`（不判定）；
- **硬性声明**：`meta.isReleaseQualification=false`、`meta.thresholdAdjustmentAllowed=false` —— 本报告是开发资格集的第一轮 blinded qualification，不是 release qualification，任何未达标结果都不得用于调低 W8 冻结阈值；W8 在独立 RC 集按 01-5 冻结阈值复核（见 09-w8）。

## 3. 决策点

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 报告用途 | 开发资格集第一轮 blinded qualification（`setKind="development"`） | 任务 05-6 明确定义非 release qualification；类型面与运行时均拒绝 release 集 |
| 资格集关系 | `devSetDisjointFromW8RcSet` 显式声明，为 false 拒绝生成 | 05-w4 任务 05-6 与 01-5 §3 要求开发资格集与 W8 RC 集不重叠 |
| 阈值处理 | 冻结值注入 + 只读对比（`frozen=true`），输出恒不可调低 | 01-5 §3：W0 冻结、RC 后不得降低；避免任何「以开发轮调低 W8 阈值」路径 |
| 正类定义 | Critic precision/recall 以 upgrade 为正类 | 与 false-upgrade/false-downgrade 分层口径对齐（§16.2） |
| abstain/not_assessable | 独立计数且不计入 precision/recall 分母 | 未判定不算错判；01-5 §3 要求四类分别分层报告 |
| 双标不一致 | 只计 disagreement，不进对错判定 | 无 Gold 共识的样本不具备 ground truth，不能参与一致性/精度统计 |
| 跨模态比较 | 只按相同 `(rubricId, facet)` 配对 | §16.2：模态间只比较相同 facet，不要求信息量相等 |

## 4. 验收映射

- [x] 报告在开发资格集上按相同 rubric/facet 分层报告 false-upgrade、false-downgrade、abstain、`not_assessable`（`stratifyByFacet` + 单测）；
- [x] 模态间只比较相同 facet，不同 facet 不产生 delta（`compareVoiceToSilent` + 单测）；
- [x] 报告含开发资格集标识与非 release 声明（`meta.qualificationSetId`、`isReleaseQualification=false`、`thresholdAdjustmentAllowed=false`）；
- [x] 阈值对比不可用于调低 W8：未达标层 `passed=false` 时报告仍声明阈值调整不允许（单测断言）；
- [x] 双标一致性与 Critic precision/recall 与 W0 冻结阈值对比，`frozen=true`，样本不足不判定；
- [x] 纯函数可测：数据源注入，无 IO（模块无 DB/时钟/外部依赖）；
- [x] TypeScript 严格模式通过（`npm run typecheck --prefix apps/api`）；全部测试通过（`npm test --prefix apps/api`）。

## 5. 后续衔接

- W5（阶段 06）以本报告达标的 profile-eligible 目标推进单 Key Point 纵切；
- W8 在独立冻结 RC 集复核人工双标一致性与 Critic precision/recall（09-w8 §16.2 阈值复核），开发轮结果不参与 W8 阈值判定；
- 报告输出由上层调用方接入实际资格集数据源（本模块不实现采集管线）。
