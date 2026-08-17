# Plan 23 W0 基线报告（Gate G0 结论）

> 文档类型：实施记录（docs/implementation/）
> 日期：2026-08-17
> 依据：23 方案 §30 Wave 0；附录 A 现场证据
> 对应脚本：scripts/objective-inventory.mjs（只读 inventory）、
> scripts/verify-objective-fixtures.mjs（fixture 断言）、
> scripts/legacy-field-scan.mjs（legacy 字段静态扫描）

## 1. 数据基线（2026-08-17 实测，235 个 workspace）

| 指标 | 数值 | 说明 |
|---|---:|---|
| workspaces | 235 | 含 notes/cards/objectives 任一数据的 workspace |
| notes | 548 | |
| legacy learning_cards | 939 | 其中 active 80+（混合工作区）、archived 33 全库 |
| legacy active key points | 917 | 旧正式内容主体 |
| V2 learning_cards_v2 | 289 | active 为主 |
| V2 learning_objectives_v2 | 289 | 一卡一目标成立（289/289） |
| alias key points（kp.id = objective_id） | 89 | V2 激活遗留的隐藏 alias |
| archived legacy alias 父卡 | 33 | 与 89 的差 = 56 需 W2-04 逐行对账 |
| Objective Origin 行 | 0 | W1 迁移已建表，尚未 backfill（W2） |
| review_schedules | 141 | |
| learning_runs | 295 | 含 active/checkpoint/ended/skipped/completed |

## 2. 附录 A 两类现场工作区（已固化为回归 fixture）

### 纯 V2 工作区 4f825f38-1a65-492a-8dec-c82868e6ea0f

| 指标 | 实测 | 附录 A 记录 |
|---|---:|---|
| legacy active card | 0 | 0（旧首页必空根因） |
| V2 active card | 3 | 3 |
| V2 active objective | 3 | 3 |
| alias key point | 5 | —（含已归档 Objective 的 alias） |
| review schedule | 1 | — |
| learning runs | 20 | — |

### 混合工作区 5f128f8f-a130-4411-b868-af219d0c206d

| 指标 | 实测 | 附录 A 记录 |
|---|---:|---|
| legacy active card | 80 | 80 |
| V2 active card | 3 | 3 |
| V2 active objective | 3 | 3 |
| alias key point | 3 | — |
| review schedule（pending） | 5 | — |
| learning runs | 19 | — |

verify-objective-fixtures.mjs 已把上述不变量变成可执行断言（legacy active=0 /
V2 active>0 / alias>0 / schedules>0 / runs>0），当前全绿。

## 3. 未解释差异

1. **alias key point（89）≠ archived legacy alias 父卡（33）**：89 个 kp.id 命中
   objective_id；但 archived legacy 卡只有 33 张。差值 56 行 alias 的父卡可能为
   active/other 状态或按其他约定创建——需要 W2 迁移 dry-run 逐行对账（W2-04）。
2. **纯 V2 工作区有 20 个 learning_runs**（active=13）但没有 active legacy 卡：
   这些 run 通过 V2 TargetSnapshot 运行，证明 V2 消费链路已存在；首页仍空说明
   断链在 Home 读模型，不在 Run。
3. **289 objectives / 289 v2 cards**：1:1 成立；89 个 alias 说明约 1/3 的 V2
   Objective 创建了隐藏 alias（其余为早期/未走 activation 的测试数据？）——
   W2-04 legacy alias dry-run planner 将逐条裁决。
4. **concept_label / surface_revision 为迁移期默认值**：W1-05/W1-08 只建列，
   回填与 bump 逻辑在 W2 完成。

## 4. Wave 0 任务状态与 Gate G0 结论

| 任务 | 状态 | 证据 |
|---|---|---|
| W0-01 Stop Line 清单 | 完成 | docs/implementation/23-stop-line-review-checklist.md |
| W0-02 Consumer Audit + Home/Stats + gate | 完成 | legacy-consumer-audit.ts（formal/owner/status）+ 6 个单测 |
| W0-03 legacy 字段静态扫描 | 完成 | scripts/legacy-field-scan.mjs（当前报告 137 处白名单外命中——即 §2.7 问题） |
| W0-04 V1/V2/alias inventory CLI | 完成 | scripts/objective-inventory.mjs（只读 SELECT） |
| W0-05 纯 V2 工作区 fixture | 完成 | scripts/verify-objective-fixtures.mjs（4f825f38 断言） |
| W0-06 混合工作区 fixture | 完成 | 同上（5f128f8f 断言） |
| W0-07 Origin 缺失/过期 fixture | 部分 | 依赖 W2 数据；W1 表已就绪 |
| W0-08 历史不可变回归 | 部分 | 方案 16 既有 hash 测试在案；W2 迁移后复验（RL-04） |
| W0-09 capability 空壳 | 完成 | capability-bundle.ts 新增 learning_objective_system_v3（OFF；默认无行为变化） |
| W0-10 基线报告 | 完成 | 本文档 |

**Gate G0 结论**：W0-03、W0-05、W0-06 已进入可执行脚本与断言；W0-08 复验
挂到 RL-04（W2 迁移后）。G0 视为通过，允许进入 W1 写入类任务。

## 5. 实施过程中对环境的变更（需知悉）

- 已应用迁移 **0175_learning_objective_content_topology.sql**（additive）：
  新建 learning_objective_origins_v2（FORCE RLS）、legacy_route_mappings_v2
  （FORCE RLS）；learning_objective_revisions_v2.concept_label、
  learning_cards.compatibility_role、learning_objectives_v2.surface_revision /
  surface_updated_at。
- 迁移前基线快照：本报告 §1/§2 数字（inventory 输出存档于
  outputs/plan23-w0-inventory-baseline.json）。
- 未重写任何历史 event / hash / run。
