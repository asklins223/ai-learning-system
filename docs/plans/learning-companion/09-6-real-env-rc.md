# 决策记录 09-6：真实环境 RC（§16.6）

| 项 | 值 |
| --- | --- |
| **状态** | Frozen |
| **执行** | 阶段 09（W8）任务 09-6：真实环境 RC |
| **日期** | 2026-08-08 |
| **来源** | `docs/plans/learning-companion/09-w8-quality-capacity-rc.md` 任务 09-6（§16.6，W8 bullet）+ 冻结记录 01-5 §16.6 |
| **约束级别** | 全部硬不变量关闭，无 placeholder / skip / insufficient-data 伪通过；成本 Gate 达标；任一 p95 成本或调用数越过冻结上限即停止扩量，不得靠缩减 Critic、证据或 A11y 绕过 |

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/real-env-rc.ts`：真实环境 RC **纯逻辑**——
  真实环境证据清单（真 Provider / 真 ASR / PostgreSQL / 对象存储 / 浏览器）、
  成本与调用放大 Gate（每 Episode/Session 独立预算、用户级 p50/p95、冻结上限、
  越限停止扩量、禁止缩减质量项绕过、Tutor 独立预算隔离）、用户取消确认后零新增
  调用、`temporary_hidden/global_off` 后零新增 Companion 成本、公开认证层/安静
  锚点/未触发 context 注册零 Provider 调用、汇总判定。无 DB / 无网络 / 无时钟 /
  无副作用 / 无随机（零 import，独立可测）。
- `apps/api/src/modules/learning-sessions/real-env-rc.test.ts`：单测（node:test），
  42 例全绿。
- 本文件：决策记录。

实现边界：本模块**不采集数据**，只对 RC harness 注入的证据报告、成本样本与
表面成本做确定性判定；成本上限为 W0 冻结口径默认值并接受注入——RC 校准 W0 阈值
只改常量/注入值，不改变判定逻辑（与 09-4 / 09-5 的处理一致）。

## 2. 真实环境证据清单（无伪通过）

`REAL_ENV_EVIDENCE_CHECKLIST`（6 项，覆盖五类真实环境组件）：

| # | 证据 id | 组件 | 真实性契约 |
| --- | --- | --- | --- |
| 1 | `provider_llm_call` | provider | 真实 Provider 端点发起计费 LLM 调用（真实 model id、request id、鉴权与响应），非本地 stub/mock |
| 2 | `provider_token_usage` | provider | 真实 Provider 返回的输入/输出 token 用量（usage 字段），用于冻结每 Episode/Session 预算 |
| 3 | `asr_transcription` | asr | 真实音频经真 ASR provider/model 生成逐字 transcript（含 confidence 与 provider/model/version），非合成 transcript |
| 4 | `postgresql_live` | postgresql | 真实 PostgreSQL 连接执行 schema 迁移与事务读写（行级证据：行可查询、可回滚），非内存/模拟数据库 |
| 5 | `object_storage_put_get` | object_storage | 真实对象存储写入/读取并哈希校验一致（raw audio 短期暂存/artifact），非本地文件系统替代 |
| 6 | `browser_e2e` | browser | Chrome stable 真实浏览器完成主路径用户旅程（DOM/事件/截图证据），非 jsdom/无头模拟 |

`validateRealEnvEvidence` 判定（0 伪通过，硬约束）：

- 质量必须为 `real`；`placeholder / skip / insufficient_data` 一律违规；
- `requiresArtifact` 证据必须带 `artifactRef`（缺引用 = insufficient-data 伪通过）；
- 清单项缺测（未被证据报告覆盖）→ 违规（skip 伪通过）；未知 id / 重复上报 → 违规。

## 3. 成本与调用放大 Gate（§16.6，W0 冻结上限）

`FROZEN_COST_CAPS`（W0 冻结口径默认值，01-5 §16.6 未给具体数值；RC 校准只改
常量，不改变判定逻辑）：

| 维度 | 每 Episode 上限 | 每 Session 上限 | 用户级 p95 上限 |
| --- | --- | --- | --- |
| `llmCalls`（LLM 调用） | 12 | — | 100 |
| `inputTokens`（输入 token） | 40,000 | — | 300,000 |
| `outputTokens`（输出 token） | 8,000 | — | 60,000 |
| `asrSeconds`（ASR 秒数） | — | 600 | 3,600 |
| `ttsCharacters`（TTS 字符） | — | 20,000 | 120,000 |
| `objectStorageBytes`（对象存储） | 1,000,000 | — | 5,000,000 |
| `tutorBudgetUnits`（current-target Tutor 独立预算） | 4 | — | 30 |

判定函数（全部为确定性纯函数，负值一律违规）：

- `checkEpisodeBudgetCaps`：LLM 调用/token/对象存储/current-target Tutor 独立
  预算按每 Episode 冻结上限判定（scope 隔离：session 样本不进入本检查）；
- `checkSessionBudgetCaps`：ASR 秒数/TTS 字符按每 Session 冻结上限判定；
- `checkUserP95CostCaps` + `computeStopScaling`：用户级 p50/p95 成本（R7 线性
  插值，与 08-4 metrics-schema `computePercentile` 同源语义）；**任一 p95 成本
  或调用数越过冻结上限 → `stopScaling = true`，立即停止扩量**；用户成本样本
  为空 → 违规（insufficient-data 伪通过，不静默放行）；
- `checkNoQualityReductionBypass`：以缩减 **Critic / 证据 / A11y** 任一方式绕过
  成本上限的上报一律违规（即使 p95 在限内）；
- `checkTutorBudgetIsolation`：Tutor detour 用独立 envelope，不得消耗或借用
  formal assessment 预算（借用 > 0 → 违规）；Tutor 独立预算由
  `perEpisode.tutorBudgetUnits` 上限约束。

## 4. 零调用 / 零成本 Gate（§16.6）

- **用户取消被服务端确认后**新增 LLM/ASR/TTS/对象存储调用必须为 0
  （`checkCancelConfirmedZeroNewCalls`：llmCalls/token、asrSeconds、
  ttsCharacters、objectStorageBytes 任一 > 0 → 违规）；
- **`temporary_hidden/global_off` 确认后**新增 Companion 成本必须为 0
  （`checkHiddenOffZeroNewCost`：全维度含 Tutor，任一 > 0 → 违规）；
- **公开认证层 / 安静锚点 / 未触发页面 context 注册**产生的 Provider 调用与成本
  必须为 0（`checkZeroProviderCallSurfaces`：`public_auth` / `quiet_anchor` /
  `untriggered_context_registration` 三个表面逐一判定）。

## 5. 汇总判定

`evaluateRealEnvRc` 汇总全部 Gate：

- `evidenceViolations`：证据清单（0 伪通过）；
- `episodeBudgetViolations` / `sessionBudgetViolations`：每 Episode/Session 独立预算；
- `userP95Violations` + `userP50` / `userP95` 报告 + `stopScaling`：用户级分位；
- `qualityReductionViolations`：缩减 Critic/证据/A11y 绕过；
- `tutorIsolationViolations`：Tutor 独立预算隔离；
- `cancelConfirmedViolations` / `hiddenOffViolations` / `zeroProviderSurfaceViolations`：
  零调用/零成本 Gate；
- `allPassed`：以上全部通过且不停止扩量时为 true。

## 6. 验证记录

```text
$ npm run typecheck --prefix apps/api
# 通过（0 错误）

$ npm test --prefix apps/api
# tests 2735
# suites 485
# pass 2735
# fail 0
#（含 real-env-rc.test.ts 42 例：证据校验 / 成本 Gate / 零调用与零成本 Gate / 汇总）
```

## 7. 约束级别与回滚评估

- **约束**：全部硬不变量关闭；无 placeholder / skip / insufficient-data 伪通过；
  成本 Gate 达标（每 Episode/Session 独立预算、用户 p95 上限、停止扩量、Tutor
  隔离、取消/hidden-off/零 Provider 表面全零）；
- **回滚触发**：任一证据伪通过、任一预算/p95 越限、缩减质量项绕过、取消或
  hidden/off 后新增调用/成本、或零 Provider 表面产生成本 → 对应 Gate 违规，
  `allPassed = false`，进入 W8 真实环境 RC 评审，不得带违规放行进入阶段 10；
- **可重复性**：全部判定为纯函数，同一输入恒得同一输出（测试覆盖「同一输入
  两次评估结果一致」）；
- **关联契约**：01-5 冻结记录 §16.6、08-4 observability/metrics-schema.ts
  （CostSample / 分位 / p95 上限 / hidden-off 同源语义）、09-5 fault-injection-rc
  （取消确认后新增调用为 0 的重复执行语义）、09-7 硬不变量收口。
