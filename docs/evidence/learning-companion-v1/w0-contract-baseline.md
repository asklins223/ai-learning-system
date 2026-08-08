# W0 证据：合同 / 基线冻结

> 对应任务 11-2 证据文件 2。佐证 DoD 1、2、3、7、8、9、10、31 的冻结基准。
> 批准记录：`docs/plans/learning-companion/11-closeout-dod-evidence.md` 附录 B。

## 1. 批准记录（已签署）

| 日期 | 动作 | 说明 |
| --- | --- | --- |
| 2026-08-02 | Draft 1.0 Final Proposal | 最终候选方案 |
| 2026-08-04 | Draft 1.1 Global Companion Expansion | 全站 Global Companion Shell |
| 2026-08-04 | Draft 1.2 Character Reference | 伴星角色动作示例与视觉冻结 |
| 2026-08-07 | **Approved** | Repository Owner 通过 v1.0 分支执行指令一次性批准 §21 全部 **13/13** 条确认 |
| 2026-08-08 | W0 冻结登记 | 阶段 01 十项签署/确认完成，索引登记完成（01-10 状态 Confirmed） |

批准后进入 W0/W1/W2，不再另开「是否让伴星从登录起全站可达」「是否做前台学习伴侣」「是否支持无打字主路径」的方向讨论（§21 收口）。

## 2. 决策记录清单（01-1 ~ 01-10，均已冻结）

| 记录 | 冻结项 | 状态 | 冻结日期 |
| --- | --- | --- | --- |
| 01-1 | 总体 Agent 与系统架构（§4） | Frozen | 2026-08-07 |
| 01-2 | Session/Scene/Artifact/Trust 合同（§6+§7） | Frozen | 2026-08-07 |
| 01-3 | 数据、API 与工具边界（§12） | Frozen | 2026-08-07 |
| 01-4 | 安全、隐私、无障碍与可靠性规则（§13） | Frozen | 2026-08-07 |
| 01-5 | 成功指标、性能与成本 Gate（§16） | Frozen | 2026-08-07 |
| 01-6 | 测试、故障与安全矩阵基线（§17） | Frozen | 2026-08-07 |
| 01-7 | Feature Flags 与 capability bundle（§18.1） | Frozen | 2026-08-07 |
| 01-8 | 拟人化角色视觉与动画合同（§5.1/§5.2） | Frozen | 2026-08-07 |
| 01-9 | 个性化与非强迫游戏设计（§11） | Frozen | 2026-08-07 |
| 01-10 | 文件级改造方向（§19） | **Confirmed** | 2026-08-07 |

## 3. W0 冻结的硬事实（后续所有 Gate 的判定基准）

- 事务层级：`LearningSession` 仅作容器；`LearningEpisode` 是 canonical 单元（恰好一个 `keyPointId` + 一个非空 `OfficialSchedulingDecisionV1`）。
- 可信链：双 Critic + deterministic core 拥有可信激活、评估与业务提交权；**Agent 无 canonical write**（佐证 DoD 20）。
- 旧 v0.7 XP/streak 主线明确 Superseded（佐证 DoD 2、31）。
- 成本/性能/质量阈值冻结于 01-5（W8/W9 验收基准，不得调低）；测试/故障矩阵冻结于 01-6。
- 视觉合同冻结于 01-8（含素材权利 W0 记录，见 `w4` 证据）；个性化边界冻结于 01-9。
- 文件边界方向冻结于 01-10（Confirmed）。

## 4. 判定层证据

- 本阶段为合同/基线冻结，无独立实现测试；判定层 = 十份决策记录头部签署日期（2026-08-07）+ 索引登记（2026-08-08）+ 附录 B 批准记录表。
- 各记录引用的实现/测试由 W1 起逐阶段落地，见 `w1`~`w9` 证据。
