# 决策记录 08-5：全链路 E2E 0 容忍校验（§16.4/§17.1 子集）

> 状态：**Frozen（已冻结）**
> 执行：阶段 08（W7）任务 08-5
> 日期：2026-08-08
> 来源：`08-w7-audit-observability.md` 任务 08-5（原方案 §16.4 硬 Gate + §17.1）；
> 冻结记录 01-5（§16.4 自主性硬 Gate §5.3 清单）、07-4（存在感/控制状态）、
> 07-3（触发仲裁）、07-2（页面 coverage registry）、07-1（onboarding 首次引导）、
> 06-5（route-launcher）、05-5（PageCompanionContextV1）
> 约束级别：**全部 0 容忍验证通过**；E2E 记录留档。

## 1. 交付物

- `apps/api/src/modules/companion-shell/e2e-zero-tolerance.ts` —— 全链路 E2E 0 容忍
  校验**纯逻辑**（无 DB / 无网络 / 无副作用 / 无随机）。把冻结记录 01-5 §5.3「自主性
  硬 Gate」与任务 08-5 的 8 组 0 容忍要求翻译成确定性断言函数：
  - `CompanionActivity` 事件模型 + `CompanionActivityKind` 冻结枚举
    （listener/DTO/角色/声音/邀请/预取/调用/系统通知/observer/idle/LLM/ASR/TTS/
    开麦/通知/领域写/传输/credential 进入/自动续题/迟到结果）；
  - D1 `checkHiddenOffZeroActivity`：temporary_hidden/global_off 零活动矩阵与
    可取消调用/迟到结果；
  - D2 `checkEpochPropagationSla`：epoch 传播 SLA、旧 lease 到期后零挂载/调用、
    CAS 失败零谎报；
  - D3 `checkNewDevicePreResolutionZeroMount`：新设备认证后、解析前零挂载；
  - D4 `checkCredentialPageZeroIngress`：credential 页六面零进入 +
    LLM/ASR/TTS/个性化预取/observer 零；
  - D5 `checkQuietZeroAndPrePermitTransfer`：quiet 零 observer/context/idle +
    permit+接受前零传输；
  - D6 `checkMutationRequiresFourGates`：写入四重验证 + Global Shell 零领域写；
  - D7 `checkAutonomyZero`：零自动开麦/零未 opt-in 通知/later 零副作用/停止
    100%/零自动续题（附 `computeStopSuccessRate`）；
  - D8 `checkOnboardingZero`：offered 零二次展示/consumed 零自动重放/跳过动作
    数 1/终态零回退；
  - 聚合入口 `runZeroToleranceSuite`（确定性报告）+ `assertZeroTolerance`
    （0 容忍 fail closed，抛 `ZeroToleranceFailure`）+ 各维度说明。
- `apps/api/src/modules/companion-shell/e2e-zero-tolerance.test.ts` —— 单测（53 例），
  每个 0 容忍项提供「干净样本断言 0 违规 + 违规样本断言必检」双断言。
- 本文档 —— 决策记录（Frozen）。

## 2. 决策：0 容忍校验是确定性纯函数，不是 e2e 场景实录

0 容忍要求不能依赖「肉眼检查一条真实旅程录像」——必须能被机器确定性判定。因此本
校验器以 `CompanionActivity` 事件序列 + 每维度上下文为输入，穷举匹配后返回违规列表：

- **输入输出皆为纯数据**：校验器不读时钟、不调 DB、不执行任何伴星动作，只对
  harness/测试注入的记录做判定；同一输入恒得同一输出（无随机、无顺序依赖）。
- **时间窗保守判定**：活动 `atMs` 缺省视为「确认/检查窗口内发生」；`temporary_hidden`
  只约束当前设备（`deviceSessionId` 不匹配的活动不判），`global_off` 约束所有设备并
  额外包含系统通知。
- **0 容忍 fail closed**：`assertZeroTolerance` 任一维度违规即抛
  `ZeroToleranceFailure`（违规列表人类可读），供 CI / E2E harness 在旅程结束点调用。

## 3. 决策：8 组 0 容忍 → D1~D8 的语义映射

| 维度 | 冻结依据（01-5 §5.3） | 校验输入 | 违规判定 |
| --- | --- | --- | --- |
| D1 hidden/off | 第 1 条 | 当前 device + temporary_hidden 确认/global_off CAS 应用 + 活动序列 | hidden/off 后 12 类活动（含 observer/idle）或系统通知（global_off）；可取消调用未取消；迟到结果被采用 |
| D2 epoch | 第 2 条 | global_off 应用时刻、账号当前 epoch、各设备接收记录、旧 lease 到期时刻、CAS 结果 | 传播 > SLA；收到旧 epoch；lease 到期后挂载/调用；CAS 失败却显示全局成功 |
| D3 新设备 | 第 3 条 | auth_completed / account_state_resolved / mount_activity 事件序列 | 认证完成后、解析完成前出现挂载类活动 |
| D4 credential 页 | 第 4 条 | credential 页活动序列 | 输入值/字段交互元数据进入六面任一（DTO/日志/analytics/截图/模型/持久上下文）；该页 LLM/ASR/TTS/个性化预取/observer |
| D5 quiet/permit | 第 8 条 | presence + surfaceActive + 活动序列 | quiet 未召唤时 observer/idle/完整 PageCompanionContextV1；moderate/active 在 permit+接受前传输 entity refs/页面内容 |
| D6 写入 | 第 11 条 | 每次变更尝试的四重门布尔 + 执行结果 | 四重验证（影响预览+context/permission 重验+有效 nonce+显式确认）缺一仍成功执行；Global Shell 直接写领域数据 |
| D7 自主性 | 第 16/17/18 条 | 活动序列 + later/dismiss/stop 副作用 + 停止尝试 | 自动开麦（用户显式触发豁免）；未 opt-in 通知；later/dismiss/stop 改 schedule/偏好/理解或制造负向记录；停止未成功；自动续题 |
| D8 onboarding | 第 6 条 | offerStatus + 各计数 | offered 后二次自动展示；consumed 后系统自动邀请/重放；跳过动作数 ≠1；consumed 后回退 |

## 4. 决策：W0 SLA 冻结值

冻结记录 01-5 §5.3-2 只冻结「`global_off` account epoch 向 active devices 传播不
超过 W0 SLA」，未在文档给出具体毫秒值。本记录按 W0 冻结口径定义
`GLOBAL_OFF_PROPAGATION_SLA_MS = 5_000`（5 秒）作为默认阈值：account epoch 落库后
（`service.ts updateCompanionAccountState` 的 `epoch` 单调递增 + 广播钩子）到任一
active device 收到该 epoch 的传播耗时超过 5s 即违规。校验函数接受注入 `slaMs`，
CI 若校准 W0 SLA 只改常量/注入值，不改变校验逻辑。

## 5. 与既有模块的对接（复用语义，不耦合实现）

- 活动 kind、permit 语义、六面渠道、later/dismiss/stop 副作用枚举均按 07-2/07-3/
  06-5/01-5 的冻结语义在**本地复刻**（如 `CompanionSensitivity`、`CompanionPresenceLevel`、
  `MutationAttempt` 的 nonce），校验器不 import web 侧文件或触发生产调用，保持
  `apps/api` 单测可独立运行、零副作用。
- 对既有实现的验证由 E2E harness（后续接线任务）注入真实旅程记录；本校验器只负责
  「判定」，负责「记录」的 harness 不在此任务范围内。
- Global Shell 零领域写对应 `shell-actions.ts` 每个结果字面量 `canonicalWrite: false`
  的编译期保证；D6 在运行时对 harness 观察到的领域写事件再检一道（双层保障）。

## 6. 验收与证据

- [x] 8 组 0 容忍全部有确定性校验函数与单测样本（D1~D8，53 用例）。
- [x] 每个 0 容忍项：干净样本 0 违规 + 违规样本必检双断言。
- [x] `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）。
- [x] `npm test --prefix apps/api` 通过（# tests 2301, # pass 2301, # fail 0，
  含 e2e-zero-tolerance.test.ts 53 用例）。

## 7. 不做的边界（后续任务）

- 本任务不实现 E2E 场景实录/harness（浏览器自动化、事件埋点、截图比对）——那是
  接线与 CI 层工作；本校验器提供其终点的确定性判定入口。
- 不修改既有 companion 模块的任何行为语义（全部读侧校验，无状态写入）。
- 不重复实现 onboarding CAS / 抑制链 / 预算等既有逻辑；只校验其对外可观察结果。
