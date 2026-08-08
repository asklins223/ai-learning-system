# 决策记录 09-1：多模态 Gold 两轮（标注覆盖 + 答案泄漏对抗集）（§16.2/§17.1）

> 状态：**Frozen（已冻结）**
> 执行：阶段 09（W8）任务 09-1
> 日期：2026-08-08
> 来源：`09-w8-quality-capacity-rc.md` 任务 09-1（原方案 §15 W8 bullet + §17.1）+ 冻结记录 01-5 §3（§16.2 指标）
> 约束级别：**两轮 Gold 结果与阈值对比达标；任何变更从第一轮重跑。** 本记录为多模态 Gold 两轮的编排与判定语义，阈值取自 W0 冻结记录 01-5 §3，不得调低。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/gold-rounds.ts`：多模态 Gold 两轮编排纯逻辑（数据源注入、无 IO）。
- `apps/api/src/modules/learning-sessions/gold-rounds.test.ts`：单测（node:test + assert）。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 两轮编排（第一轮基线 / 第二轮复测）

- 第一轮 `round=1, role=baseline` 建立基线；第二轮 `round=2, role=recheck` 在修复后复测；round/role 强校验，不匹配直接抛 `GoldRoundsError`；
- 每轮独立执行三件事：固定对抗集答案泄漏检查、标注覆盖矩阵、分层统计 + W0 阈值对比；三者全部通过则该轮 `passed`；
- 顶层再对两轮样本合并做覆盖矩阵（`combinedCoverage`，两轮共同达成全部标注覆盖）；
- 两轮阈值对比 `compareRounds` 按 `(metric, modality, rubricId, facet)` 配对，`regressed` 表示复测轮数值下降（三项冻结指标均越高越好），`roundsNotRegressed` 必须为 true——**修复后复测不得回归**。

### 2.2 标注覆盖矩阵（09-1 核心）

| 维度 | 覆盖条目 | 来源 |
| --- | --- | --- |
| 语音 Teach-back | `voice_teachback` | 标注标签 `coverage.voiceTeachBack` |
| ordering/graph/repair 的 formal/practice 两态 | `scene_mode:{kind}:{mode}` 共 6 项 | `coverage.sceneMode`（scene-contracts 的 SceneMode 两态） |
| `structured-proof-v1` 全 bundle 与缺一 Scene | `structured_proof:{profileId}:{full_bundle\|missing_one_scene}` | `coverage.structuredProof`，profile 清单取 silent-profile-registry（3 family 各 2 互补 Scene） |
| 跨模态公平性四类分层 | `cross_modality:{facet}:{layer}:{modality}`（voice 与 silent_bundle 两侧各自） | `deriveCrossModalityLayer` 由 `(systemVerdict, goldVerdict)` 推导，**不依赖标注者自报** |

- 每维度 requiredCount 由 `GoldCoverageThresholds`（W0 冻结注入）给定，未达即 `passed=false`，`allPassed=false`；
- 跨模态公平性四类：`false-upgrade`（upgrade 判定侧 FP）、`false-downgrade`（downgrade 判定侧 FP）、`abstain`（不足回答明确弃权）、`not_assessable`（关键输入不可辨）——与 05-6/01-5 §3 完全同口径。

### 2.3 Question/Scene 固定对抗集答案泄漏为 0

- `checkAdversarialLeak`：对抗集引用全集必须非空（空集无法核查 → fail closed）；泄漏引用必须在全集内；`leaked === 0` 才 `passed`；
- 两轮各自执行；任一轮泄漏 >0 → 该轮失败、整体 `verdict.passed=false`。

### 2.4 判定口径（与 05-6 一致）

- 复用 qualification-report 的分层统计 / 阈值对比 / 汇总（同一统计模型）；
- `abstain` / `not_assessable` 独立计数，不计入 Critic precision/recall 分母；
- 人工双标不一致（无 gold 共识）只计 `disagreement`，不进任何对错判定；
- 阈值对比中样本不足 → `passed=null` 不判定（开发轮监控语义，不视为失败）；**release 严格口径见 09-2**。

## 3. 决策点

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 两轮关系 | 第一轮 baseline、第二轮 recheck；逐项对比不回归 | §15 W8「第一轮建立基线，第二轮在修复后复测」 |
| 覆盖矩阵 | 显式条目化（每维度 requiredCount 注入） | 可审计、可 fail closed；与 01-5 §3 各覆盖维度一一对应 |
| 跨模态分层推导 | 由判定推导，不采用标注自报 | 分层是统计事实，防止伪造标签 |
| structured-proof profile 清单 | 取 silent-profile-registry（注入可覆盖） | 与 05-1 三 family 对齐，保证覆盖条目完整 |
| 泄漏对抗集 | 全集非空 + 泄漏引用必须在全集内 | 空集无法核查、越界泄漏引用属数据异常，均 fail closed |
| 复测判定 | 第二轮不劣于第一轮（regressed=false）才通过 | 修复后不得倒退 |

## 4. 验收映射

- [x] 两轮 Gold 结果与阈值对比达标（每轮泄漏 0 + 覆盖矩阵全过 + 阈值对比无未达标项；第二轮不回归）→ `verdict.passed`；
- [x] 标注覆盖：语音 Teach-back、ordering/graph/repair 的 formal/practice 两态、`structured-proof-v1` 全 bundle 与缺一 Scene、跨模态公平性四类分层在 voice/silent 两侧的覆盖缺失即未达标（单测逐维度断言）；
- [x] Question/Scene 固定对抗集答案泄漏为 0（泄漏 >0 轮次失败；空集/越界引用抛错）；
- [x] 纯函数可测：数据源注入，无 IO（模块无 DB/时钟/外部依赖）；
- [x] `npm run typecheck --prefix apps/api` 通过；新增测试在 `npm test --prefix apps/api` 全量中通过。

## 5. 后续衔接

- 本任务产出两轮 Gold 编排判定；真实标注采集管线由上层调用方接入（本模块不实现采集）；
- W8 最终 release qualification 在独立冻结 RC 集复核（09-2），开发轮结果不参与 RC 阈值判定（01-5 §3）。
