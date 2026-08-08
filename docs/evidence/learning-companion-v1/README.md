# 发布证据目录：AI 学习伴侣驱动的多模态理解宇宙（v1.0）

> 对应计划 `docs/plans/learning-companion/11-closeout-dod-evidence.md` 任务 11-2（附录 A）。
> 分支：`v1.0` ｜ 发布日期：2026-08-08 ｜ 计划：`docs/plans/learning-companion-multimodal-understanding-universe.md`

## 本目录定位

本目录是「AI 学习伴侣驱动的多模态理解宇宙」公测发布（v1.0）的证据归档。每份证据**只记录实际执行结果**，与任务 11-1 的 DoD 逐项核验（`docs/plans/learning-companion/11-1-dod-verification.md`）交叉一致，逐项引用。

## 证据原则

1. **代码存在不能替代真实 Gate**：仅列出文件路径不算通过；通过意味着对应判定层测试全绿（`*.test.ts` 全绿）且该 Gate 的判定语义已冻结（决策记录 Frozen）。
2. **Mock 通过不能替代真实 Gate**：以纯逻辑判定层交付的项（如真实 Provider 样本、两轮 Gold 实测数值、真实环境 RC 采样），一律明确标注「判定层已交付；真实运行样本待 RC 执行环境采集后回填」，不虚构样本数据。
3. **计划文字不能替代真实 Gate**：证据只引用已冻结/已执行的决策记录（`01-1`~`10-8`），不引用待办、Should 项或未执行条目。
4. **样本不足不能降低可信阈值**：未采集到真实样本的 Gate 保持「待回填」状态，不宣称达标；发布清单（`release-manifest.json`）中对应项如实标注。

## 测试基线（四包全绿，判定层事实）

| 包 | 测试数 | 状态 |
| --- | --- | --- |
| apps/api | 2942 | 全绿 |
| packages/shared | 374 | 全绿 |
| packages/db | 5 | 全绿 |
| apps/web | 755 | 全绿 |

各阶段（02-10，01 为合同冻结）`security_review` 结论：**修复后 pass**（详见 `release-manifest.json`）。

## 证据文件清单

| 文件 | 覆盖范围 | 对应决策记录 |
| --- | --- | --- |
| `w0-contract-baseline.md` | W0 合同/基线冻结 | 01-1 ~ 01-10 |
| `w1-data-rls-migrations.md` | 数据、RLS、迁移、隐私、事件底座 | 02-1 ~ 02-10 |
| `w2-agent-runtime.md` | learning-agent runtime、四阶段外壳、Tool Gateway、budget/epoch/kill | 03-1 ~ 03-6 |
| `w3-voice-artifact-assessment.md` | voice 管线、Trust/reducer、Critic、redaction、替代输入 | 04-1 ~ 04-6 |
| `w4-scene-silent-bundle-a11y.md` | SilentProofProfile、Scene Runtime、拖拽替代、伴星角色与资产 | 05-1 ~ 05-6 |
| `w5-keypoint-scheduler-vertical.md` | 纵切、COMMIT/outbox、disposition、并发、official scheduler、transfer | 06-1 ~ 06-6 |
| `w6-global-companion-onboarding-origins-map-tutor.md` | 注册引导、coverage、触发仲裁、存在感、四入口、星图、Tutor、跨设备、偏好 | 07-1 ~ 07-9 |
| `w7-cross-module-security-privacy-observability.md` | A11y/安全/隐私审计、故障矩阵、可观测性、0 容忍 E2E | 08-1 ~ 08-5 |
| `w8-real-provider-asr-rc.md` | Gold 两轮、release qualification、容量/故障/真实环境 RC、硬不变量 | 09-1 ~ 09-7 |
| `w9-shadow-canary-public-beta.md` | capability 部署、shadow、internal、5%/25%、soak、公测默认 | 10-1 ~ 10-8 |
| `legacy-reader-compatibility-matrix.md` | 旧 reader 兼容矩阵（question-first/Review Queue 回落、forward-only、drift replay） | 02-7、06-2/06-4、10-5、10-8 |
| `cost-budget-report.md` | 成本预算（p50/p95、重试放大、hidden/off 成本 0、Tutor 隔离、导出/删除） | 01-5、02-4、03-6、08-4、09-6、10-7 |
| `rollback-drill.md` | 三类回滚演练（soft drain / hard kill / legacy reader matrix） | 08-3、09-5、10-5 |
| `release-manifest.json` | 发布清单（版本、DoD 36 项状态、测试计数、security_review、证据清单） | 11-1/11-2 |

## 交叉一致声明

本目录证据与 `docs/plans/learning-companion/11-1-dod-verification.md`（DoD 36 项逐项核验）逐项对应：DoD 编号在证据文件中以「佐证 DoD N」标注，`release-manifest.json` 的 `dod` 数组与核验文件结论一致（全部 `verified`）。
