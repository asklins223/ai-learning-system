# 决策记录 09-4：容量与性能 RC（§16.5）

| 项 | 值 |
| --- | --- |
| **状态** | Frozen |
| **执行** | 阶段 09（W8）任务 09-4：容量与性能 |
| **日期** | 2026-08-08 |
| **来源** | `docs/plans/learning-companion/09-w8-quality-capacity-rc.md` 任务 09-4（§16.5，W8 bullet）+ 冻结记录 01-5 §16.5 |
| **约束级别** | 全部 p95/帧率指标达标；RC 报告完整记录环境；任何一项越限即判违规，禁止用开发机平均值替代 p95 |

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/capacity-perf.ts`：容量/性能校验**纯逻辑**——
  容量 fixture 矩阵（冻结档位笛卡尔积）、性能门限（p95/帧率/内存/相对预算）、
  报告环境完整性强制校验、汇总判定。无 DB / 无网络 / 无时钟 / 无副作用。
- `apps/api/src/modules/learning-sessions/capacity-perf.test.ts`：单测（node:test），
  24 例全绿。
- 本文件：决策记录。

实现边界：本模块**不采集性能数据**，只对 RC harness 注入的样本与报告元数据做
确定性判定；阈值/档位/预算均为 W0 冻结口径默认值并接受注入——RC 校准 W0 阈值
只改常量/注入值，不改变判定逻辑。

## 2. 容量 fixture 矩阵（冻结档位）

| 维度 | 档位 |
| --- | --- |
| Note 字符数 | 2K / 13K / 50K |
| 每 Card Key Points | 1 / 10 / 30 |
| 每 Session Episodes | 1 / 3 / 5 |
| 星图节点 | 100 / 1K / 5K |
| 并发 Session | 1 / 5 / 25 |

`CAPACITY_FIXTURES` = 五个维度冻结档位的笛卡尔积，共 **243** 个组合（3³×3×3）；
`validateCapacityFixture` 强制任一维度必须命中冻结档位，`isFrozenCapacityFixture`
供报告校验复用。

## 3. 性能门限（W0 冻结，01-5 §16.5）

| 门限 | 冻结值 | 判定 |
| --- | --- | --- |
| 本地 companion action（pointer/key event handler）→ 下一帧视觉 commit | p95 < **100ms** | 不含网络/Provider；p95 ≥ 100ms 违规 |
| 已缓存合法 Session plan 后，Scene state transition → 首个可交互帧 | p95 < **300ms** | 不含网络/Provider；p95 ≥ 300ms 违规 |
| 1,000 节点星图帧率 | 不低于 W0 基线（默认 **50fps**） | 以 p95 帧耗时等价换算，低于基线违规 |
| 移动端内存上限 | 绝对 **300MB** + 相对 W0 基线增量 **80MB** | 双重约束，越限违规 |
| Global Shell 新增 JS/渲染/路由 p95 | 相对 W0 基线增量 ≤ **200ms** | 超限优先降级角色而不是延迟主页面 |
| 单场景样本量 | ≥ **100** | 不足即违规（不以少量样本替代） |

性能场景枚举：`action_to_frame` / `scene_to_interactive` / `star_map_fps` /
`shell_js_p95` / `shell_render_p95` / `shell_route_p95`。

## 4. 报告环境完整性（强制，01-5 §16.5 采集要求）

`validatePerfReportEnv` 强制校验，任一违规即判不通过：

- **硬件**：必须记录（桌面参考机 / 中档移动设备）；
- **浏览器**：必须为 **Chrome stable**（允许带版本号；canary/Safari 等违规）；
- **构建**：必须记录（commit/version/build id）；
- **数据 fixture**：必须命中冻结档位矩阵（任一度越界违规）；
- **网络条件**：必须记录；
- **区间**：必须含 **p95** 标识与数值区间；
- **样本量**：单场景 ≥ 100；
- **冷热路径**：必须分开采集（`hotCold = separated`）；
- **数据来源**：禁止 `dev_machine`（不得用开发机数据替代参考机/中档移动设备采集）；
- **聚合口径**：必须为 `p95`（禁止用平均值替代 p95）。

`evaluateCapacityPerf` 汇总全部环境 + p95/帧率/内存/Shell 相对预算 Gate，输出
`allPassed`。

## 5. 验证记录

```text
$ npm run typecheck --prefix apps/api
# 通过（0 错误）

$ npm test --prefix apps/api
# tests 2613
# suites 461
# pass 2613
# fail 0
#（含 capacity-perf.test.ts 24 例与 fault-injection-rc.test.ts 106 例）
```

## 6. 约束级别与回滚评估

- **约束**：全部 p95/帧率指标达标；报告完整记录环境；样本量 ≥100；冷热分离；
  禁止开发机平均值替代 p95；
- **回滚触发**：任一 p95/帧率/内存/相对预算越限或报告环境不完整 → 该项 Gate 判
  违规，`allPassed = false`，进入 W8 容量/性能 RC 评审，不得带违规放行；
- **可重复性**：全部判定为纯函数，同一输入恒得同一输出；
- **关联契约**：01-5 冻结记录 §16.5、08-4 observability（R7 分位语义同源）、
  07-6 星图两数据平面。
