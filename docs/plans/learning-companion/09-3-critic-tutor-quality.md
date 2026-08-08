# 决策记录 09-3：Assessment Critic 与 Tutor 质量（§16.2/§16.3）

| 项 | 值 |
| --- | --- |
| **状态** | Frozen |
| **执行** | 阶段 09（W8）任务 09-3：Assessment Critic 与 Tutor 质量 |
| **日期** | 2026-08-08 |
| **来源** | `docs/plans/learning-companion/09-w8-quality-capacity-rc.md` 任务 09-3（§16.3，W8 bullet）+ 冻结记录 01-5 §16.2/§16.3 + 07-7 grounded-tutor/grounded-answer-critic |
| **约束级别** | critic 一致性、Tutor precision 与全部零容忍项必须 ≥ 冻结阈值；阈值 W0 冻结、RC 后不得降低 |

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/critic-tutor-quality.ts`：质量校验**纯逻辑**——
  Assessment Critic 与人工逐项一致性计算（§16.2 阈值判定）、evidence refs 完整率 100%
  校验、source-grounded substantive support precision ≥95%、扩展知识伪装为当前文章事实
  0 判定、abstain 正确性、Tutor 输出直接进 canonical Card/published relation/mastery 0
  判定、Should flag 下错误 support mode/越权 workspace/unsupported 段使用来源标签 0 判定，
  以及汇总报告。无 DB / 无网络 / 无时钟 / 无副作用。
- `apps/api/src/modules/learning-sessions/critic-tutor-quality.test.ts`：单测（node:test），
  50 例全绿。
- 本文件：决策记录。

实现边界：本模块**不采集任何评估或人工标注数据**，只对 RC harness 注入的样本与结构
做确定性判定；阈值/容忍值均为 W0 冻结口径常量并接受注入——RC 校准 W0 阈值只改常量/
注入值，不改变判定逻辑。apps/api 不跨目录 import workers/ai-worker，`TutorSegment` /
逐段 verdict / 来源标签语义以本地结构复刻（与 07-7 grounded-tutor / grounded-answer-critic
类型面一致）。

## 2. Assessment Critic 与人工逐项一致性（§16.2，冻结阈值）

`computeCriticHumanAgreement` 按 (facet) 逐项计算，口径与既有 `qualification-report.ts`
（W4 第一轮 blinded qualification）完全一致：

| 指标 | 冻结阈值（`FROZEN_S16_2_THRESHOLDS`） | 判定 |
| --- | --- | --- |
| 人工双标一致性（raterA==raterB 样本 / 双标注齐备样本） | ≥ **0.8** | 低于即未达标 |
| Critic upgrade precision（upgrade 正类） | ≥ **0.95** | 低于即未达标 |
| Critic upgrade recall（upgrade 正类） | ≥ **0.9** | 低于即未达标 |
| 分层最小可判样本量 | **3** | 不足 → passed=null，不判定 |

统计口径：
- `abstain` / `not_assessable` 独立计数，**不计入** precision/recall 分母；
- 人工双标不一致（无 Gold 共识）只计 `disagreement`，不进入任何对错判定；
- 双标一致性只统计 raterA 与 raterB 均存在的样本；
- passed=null（样本不足）不标记未达标，也不参与 allPassed 失败。

## 3. Tutor 质量（§16.3，冻结要求 `FROZEN_S16_3_REQUIREMENTS`）

| # | 冻结要求 | 校验函数 | 判定 |
| --- | --- | --- | --- |
| 1 | 当前 target answer segment 的 evidence refs 完整率 **100%** | `checkEvidenceRefsCompleteness` | 声称 refs（evidenceRefs + derivedFromCurrentTarget.premiseRefs）全部 ⊆ allowlisted evidence/premises 且每个 current_target 段绑定非空引用（derivationType 非空）→ 完整率恰为 1.0；无 current_target 段 → null（不判定） |
| 2 | source-grounded substantive support precision **≥95%** | `computeSourceGroundedSupportPrecision` | 分母 = 带来源标签展示的段；分子 = 人工逐项复核确认确实由来源实质支撑的段；precision ≥ 0.95；缺人工复核不计分子（fail-closed） |
| 3 | 将扩展知识伪装成当前文章事实 **0** | `checkExtendedKnowledgeDisguise` | current_target + extendedExplanation=true，或 extended_explanation/workspace_knowledge 段以 current_target 来源标签呈现 → 违规 |
| 4 | 不足以回答时明确 abstain | `checkAbstainCorrectness` | answerable=false 必须 didAbstain=true；abstain 后不得呈现带来源标签事实段 |
| 5 | Tutor 输出直接进入 canonical Card / published relation / mastery **0** | `checkTutorDirectCanonicalWrites` | 输出结构不得携带 mastery / canonical Card / published semantic relation / schedule；proposal 必须全部 requiresUserConfirmation=true |
| 6 | Should flag 下错误 support mode / 越权 workspace / unsupported 段使用来源标签 **0** | `checkShouldFlagSourceLabelViolations` | unsupported/partial 段不得带来源标签；extended_explanation/unknown 段不得用来源标签；shouldFlag 未开不得出现 workspace_knowledge 段 |

`evaluateCriticTutorQuality` 汇总全部 Gate，任一违规即 `allPassed=false`；null 判定
（无 current_target 段 / 无带标签段 / 样本不足）不视为失败。

## 4. 与 07-7 的关系

- 07-7 已在 worker 侧以类型面保证：`TutorProposal.requiresUserConfirmation: true` 字面量、
  `buildGroundedTutorSystemPolicy.forbiddenOutputs`（mastery/canonical_card/
  published_semantic_relation/schedule/...）、`grounded-answer-critic` 的
  `sourceLabelAllowed = verdict === supported` 与 `partial/unsupported → 降级或 abstain`；
- 本模块在 apps/api 侧把这些语义冻结为可注入校验的纯函数，供 W8 RC harness 对
  **真实运行产物**做确定性复核：即使模型或编排回归，质量 Gate 仍按冻结阈值判定。

## 5. 验证记录

```text
$ cd /Users/asklins/Documents/study && npm run typecheck --prefix apps/api
# 通过（0 错误）

$ cd /Users/asklins/Documents/study && npm test --prefix apps/api
# tests 2693
# suites 474
# pass 2693
# fail 0
#（含 critic-tutor-quality.test.ts 50 例全绿）
```

## 6. 约束级别与回滚评估

- **约束**：critic 逐项一致性、Tutor precision 与全部零容忍项必须 ≥ 冻结阈值；
  阈值 W0 冻结、RC 后不得降低；abstain/not_assessable/双标不一致的统计口径冻结；
- **回滚触发**：任一门限未达标或任一零容忍项 > 0 → 对应 Gate 违规、
  `allPassed=false`，进入 W8 Tutor 质量 RC 评审，不得带违规放行；
- **可重复性**：全部判定为纯函数，同一输入恒得同一输出；
- **关联契约**：01-5 冻结记录 §16.2/§16.3、04-4 assessment-critic、07-7
  grounded-tutor / grounded-answer-critic、05-6 qualification-report（§16.2 统计口径同源）。
