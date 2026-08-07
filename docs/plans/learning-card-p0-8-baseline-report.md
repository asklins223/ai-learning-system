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
