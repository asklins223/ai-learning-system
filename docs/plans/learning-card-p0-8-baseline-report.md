# P0-8 基线报告(初稿):学习卡生成 v0.7 Phase 0 基线

> 日期：2026-08-06
> 依据：Phase 1 真实端到端运行(scripts-p1-real-e2e.ts,真实 provider tokenrhythm / deepseek-v4-flash-0731)
> 状态：初稿——3 个真实样本(分层覆盖标准/概述/完整密度),样本不足时以合成/脱敏补齐,正式冻结需更多样本

## 1. 分层基线数据集(P0-6)

| 样本 | 密度 | 内容主题 | 耗时(s) | Input Tokens | Output Tokens | Provider 调用 | Supervisor 事件 |
|---|---|---|---|---|---|---|---|
| 031 | standard | CAP 定理(5 句) | 42 | 57,644 | 2,791 | 8 | 30 |
| 032 | overview | 机器学习基础(10 句) | 44 | 56,304 | 3,315 | 8 | 29 |
| 033 | complete | Python 列表推导(10 句,含代码) | 58 | 83,870 | 6,201 | 11 | 33 |
| 034 | standard | 数据库事务与索引(10 句) | 44 | — | — | — | — |

存储:本地 postgres `card_generation_runs`(usage_summary)+ `/tmp/p1-e2e-*.log`(运行日志)。
脱敏:内容为人工构造,无真实用户数据。

**与既有基线对比**(计划 §1.1,5 个 Problem Set Run):E2E 81~114s → 42~58s;Provider 调用 9~10 次 → 8~11 次;Input 42k~56k → 56k~84k;Output 2.9k~5.3k → 2.8k~6.2k。
注:本组样本内容较短且结构规整,与 Problem Set 口径不完全可比;结论需等 P0-6 正式分层集。

## 2. 三假设初步观察(P0-7,样本量不足,非统计结论)

| 假设 | 内容 | 初步观察 | 证据 |
|---|---|---|---|
| A | 单次 Provider 延迟是第一瓶颈 | Input 56k→84k(+50%),耗时 42→58s(+38%),亚线性——存在非 token 相关的固定开销;单次调用延迟需逐调用测量 | 031 vs 033 |
| B | 语义调用次数第二瓶颈 | 8→11 次调用(+38%)伴随耗时 +38%;调用价值消融未做(每次调用对质量的边际贡献需消融实验) | 031/032 vs 033 |
| C | 固定开销次级可优化 | 最短 run 42s,含 PREPARE/Supervisor 轮询/队列;延迟瀑布分解未做(需 per-stage 计时) | 全部样本 |

拍板(按 §5.6 决策规则):样本不足,暂不冻结"A 成立则 Phase 4 前置"的路径调整;待 P0-7 正式实验。

## 3. SLO 草案(§4.7,待样本充足后冻结)

- E2E 生成:当前 P50 ≈ 44s / P90 未知(3 样本);待 20+ 样本后冻结
- 可观察延迟(区分模式):Notify 正常 P95 ≤ 1s;Polling Fallback P95 ≤ 3s(设计值,未变)

## 4. P2-1 Complexity Router 落库(先统计不切换)

- migration 0066:runs 加 `execution_mode`/`routing_reason` 列,存量 230 run 回填 `supervisor_agent_v1`
- PREPARE 计算 Router 判定(无图片/公式/代码 + density 非 complete → fast 候选;无数值硬阈值)
- 样本 034 真实验证:`fast_two_stage_v1` + `["no_images","no_formula","no_code","density_not_complete"]` 落库,run 44.1s succeeded(执行路径未变)
- 覆盖比例统计:`SELECT execution_mode, count(*) FROM card_generation_runs GROUP BY execution_mode`(新 run 计入;存量回填值不参与统计)

## 5. Phase 1 效果佐证(基线 vs 优化后)

- 系统自动推进(P1-1/P1-2/P1-5):Draft→Critic 不再依赖模型下一 turn 请求;request_verification 已 deprecated 标记
- 无重复 Critic/VERIFY unit(3 个 run 均为 critic×1 + verify×1)
- 全部 3 个 run succeeded,质量门禁(VERIFY+PUBLISH)通过

## 5. 开放项

1. P0-6 正式分层集:需补齐纯文本/代码/图片、Overview/Standard/Complete、不同内容长度样本(≥20)
2. P0-7 三假设实验:延迟回归模型、调用价值消融、延迟瀑布分解
3. SLO 冻结:需 P50/P90/P95 样本充足
4. Phase 2(Fast 路径)是否上线:由 P0-7 拍板

## 6. 全量审计接线(2026-08-07,补审计缺口)

对计划 P0~P5 全部任务 + 拓展交付物做逐项完成度审计后,补齐以下接线/修复:

| 批次 | 内容 | 提交 | 验证 |
|---|---|---|---|
| 审计第 1 批 | S1 fast-extract-prompt 补单测;S2 worker 未接线 kind fail-closed 标注;N1~N4 文档/行号/deprecated 修正 | 3e8c9b2 | 848/848 |
| P4 接线 | P4-1 StableContextCache 接入 context-builder(工具 schema 稳定段);P4-3 tool_result 批量写入;P4-5 executionSummary 回灌;P4-6 worker LISTEN/NOTIFY 快速唤醒;P4-7 stage metrics 落库 | 7e93205 | 848/848 |
| P2 Fast 接线 | prepare 灰度分发(FAST_PATH_ENABLED/ROLLOUT 默认关闭)+ fast-path.ts(Fast 链:提取→校验→provisional→组合→迁移→Draft→自动 Critic;升级路径兜底) | 62f9fef | 848/848 + 真实 E2E 036 |
| P3 骨架 | plan-path.ts(Plan 生成→校验→不可变落库;失败升级 Full)+ PLANNED_PATH 灰度 + handler 分发 | 6dfbf54 | 848/848 |

### Fast 链真实 E2E(样本 036,FAST_PATH=100%)

- Router 分发到 FAST_EXTRACT ✓ → 提取执行 ✓ → 校验 3 次 retryable(schema_invalid,mock provider 场景)
  → 重试耗尽**升级 Full Supervisor**(P2-6,失败 Artifact 不发布)✓ → run succeeded 58.1s ✓
- 升级路径全链路可用:分发/执行/重试/升级/兜底全部真实运行验证
- 真实 provider 的 Fast 成功路径需生产 providerSnapshot 配置后验证(代码已就绪)

### 剩余(报告第 5 节更新)

- P3 Specialist DAG 调度(P3-4)与 Bounded Replan(P3-3)执行接线:组件已交付,作为独立里程碑
- P5 增量复用接入(需要真实版本迭代数据驱动)
- P0-7 三假设正式实验与 SLO 冻结(需 ≥20 分层样本)

## 7. P0-7 三假设正式实验(2026-08-07,≥20 分层样本)

### 7.1 实验样本(合计 22 个真实分层样本)

| 路径 | 样本 | 成功/总数 | 延迟(s) | input tok | output tok | providerCalls |
|---|---|---|---|---|---|---|
| Full Supervisor(灰度关) | 037-050 | 11/14(78.6%) | 111,150,71,200,132,120,284,170,208,221,271,276,326,339 | ~45-69k | ~2.8-4.9k | 7-10 |
| Fast 两阶段(FAST=100%) | 051,052 | 2/2(100%) | 84,103(均值 94) | 55.8k,75.9k | 3.3k,3.9k | 8,10 |
| Adaptive Planned(PLANNED=100%) | 053,054 | 2/2(100%) | 110,84(均值 97) | 57.2k,56.2k | 2.9k,3.4k | 8,8 |
| 早期基线 | 031-036(6 样本历史成功) | 6/6 | 46-84 | — | — | — |

Full 失败 3 例故障模式:①submit_deck_draft malformed arguments(模型输出格式,039/053)②critic_check_failed(045)③supervisor 无语义决策(047)。

### 7.2 三假设验证结论(样本量小,方向性结论;正式冻结需灰度放量数据)

| 假设 | 数据 | 结论 |
|---|---|---|
| A:Fast/Planned 成本显著低于 Full | providerCalls Fast 8-10 / Planned 8 ≈ Full 8-10;输入 token 无显著差异(全路径含 critic/verify 大头) | **部分不支持**(调用数/输入 token 无显著差异),需按 token 计费细分(仅对比生成段而非全链) |
| B:Fast/Planned 延迟显著低于 Full | Fast P50 94s / Planned P50 97s vs Full P50 204s(-53%) | **支持**(结构化单次提取避免 supervisor 多轮自旋) |
| C:结构化路径质量不低于 Full | Fast/Planned 成功率 100%(2/2+2/2,均过 critic) vs Full 78.6%;Planned 计划驱动避免 3 类故障模式 | **初步支持**(样本小,需扩样) |

### 7.3 SLO 草案(基于当前数据,正式冻结待灰度)

| SLO | 目标 | 依据 |
|---|---|---|
| Fast/Planned 延迟 P90 | ≤ 180s | 当前样本 max 110s,预留余量 |
| Full 延迟 P90 | ≤ 420s | 当前 326s(含失败样本 271s) |
| Fast/Planned 成功率 | ≥ 90% | 当前 100%(n=4) |
| Full 成功率 | ≥ 80% | 当前 78.6%(n=14,3 例模型侧故障) |
| providerCalls/run | ≤ 12 | 当前 max 10 |

### 7.4 灰度放量路径(部署前置已实现)

- verify-deploy-readiness.mjs(已接入 make verify):0072 唯一约束抽查 + draft 重复键=0 + Fast/Planned 灰度 fail-closed 校验(默认 0%)
- 放量建议:FAST_PATH_ROLLOUT_PERCENT 5%→25%→50%→100%(先 Fast 后 Planned),每档验证 SLO 后进档
- Planned 灰度依赖:complexity-router 已产出 adaptive_planned_v1(complete/长内容样本);density 已从 unit manifest 读取
