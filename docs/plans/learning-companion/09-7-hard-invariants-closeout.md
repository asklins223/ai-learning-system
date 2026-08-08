# 决策记录 09-7：硬不变量与必测行为收口（§16.1/§17.1）

> 状态：**Frozen（已冻结）**
> 执行：阶段 09（W8）任务 09-7
> 日期：2026-08-08
> 来源：`09-w8-quality-capacity-rc.md` 任务 09-7（原方案 §16.1 可信性硬指标 + §17.1 必测行为）；
> 冻结记录 01-5（§16.1）、01-6（§17.1）
> 约束级别：**全部硬不变量关闭**；无 placeholder、skip 和 insufficient-data 伪通过。
> 关联交付：08-5 e2e-zero-tolerance、08-2 security-audit、08-3 fault-matrix、
> 06-2 episode-commit、06-4 race-rollback、02-9 canonical-events。

## 1. 交付物

- `apps/api/src/modules/learning-sessions/hard-invariants.ts` —— 硬不变量收口
  **纯逻辑**（无 DB / 无网络 / 无副作用 / 无随机）：
  - `HARD_INVARIANTS_16_1`：§16.1 **全部 22 项**硬指标清单与判定——19 项
    0 容忍（`tolerance: "zero"`）+ 3 项 100% 要求（`tolerance: "percent100"`），
    每项含冻结文本 `frozenText`、证据链映射 `mapsTo` 与一组**真实断言**
    （`HardInvariantAssertion`，读 `Section161Observations`）；
  - `MUST_TEST_BEHAVIORS_17_1`：§17.1 **全部 35 条**必测行为清单与判定，
    每条含冻结文本与断言（读 `Section171Observations`）；
  - `evaluateHardInvariant` / `evaluateMustTestBehavior`：单条判定（纯函数，
    全部断言满足才 pass，fail closed）；
  - `detectFakePass`：**无 placeholder / skip / insufficient-data 伪通过检查**
    ——用 Proxy 观测每条断言判定运行时实际读取的观察字段：
    断言列表为空 → `placeholder`；`requires` 未声明或声明字段未被实际读取 →
    `insufficient-data`；判定未读取任何观察字段 → `skip`；
  - `runHardInvariantCloseout`：收口编排，汇总 `summary.allClosed`（全部关闭）
    与 `rollbackEvaluationRequired`（任何硬指标违反/必测行为未通过/缺测/伪通过
    → 立即回滚评估）；清单缺测（裁剪为空/缺项）**不静默通过**；
  - `assertHardInvariantCloseout`：0 容忍 fail closed，未关闭即抛
    `HardInvariantCloseoutFailure`。
- `apps/api/src/modules/learning-sessions/hard-invariants.test.ts` —— 单测
  （78 例）：清单结构（22/35、id 唯一、断言非空、requires 字段真实存在、
  每项零伪通过）、§16.1 逐项与 §17.1 逐条**双样本**（干净样本全 pass +
  违规样本必 fail）、伪通过检测三类必检、收口编排与缺测防御。
- 本文件：决策记录。

## 2. 决策：硬指标收口是确定性纯函数清单 + 证据字段断言，不是场景实录

与 08-3/08-5 同构：收口校验器以**注入的观察记录**为输入（`Section161Observations`
/ `Section171Observations`），对冻结清单逐项/逐条做穷举匹配判定，输出违规列表
与关闭标志；同一输入恒得同一输出。真实旅程的观察记录由 CI / 接线 harness
（09-2 最终 qualification、09-5 故障注入、09-6 真实环境 RC）注入；本模块只
负责「判定」与「关闭声明」。

**证据字段协议（无伪通过的机器可判定义）**：每条断言必须声明
`requires`（该判定依赖的观察字段，点号路径）；`runHardInvariantCloseout`
常驻运行 `detectFakePass`，用 Proxy 在运行时观测判定真正读取的字段：
`requires` 为空、判定未读任何字段、或声明字段未被读取，一律判为伪通过并让
`allClosed=false`。这样「placeholder（空实现）/ skip（恒真占位）/
insufficient-data（无证据或证据与声明不符）」不再依赖人工自查，而是
确定性函数输出。

**双样本是每项断言的「可失败性」证明**：测试对每项构造干净样本（全 pass）
与违规样本（破坏首个断言依赖字段 → 必 fail），证明每项判定都不是恒真/空实现。

## 3. §16.1 硬指标清单（22 项）摘要

### 3.1 0 容忍项（19 项，全部「= 0」）

| id | 冻结文本（01-5 §2） | 断言覆盖 |
| --- | --- | --- |
| 16.1-z01 | 未知或越权 evidence/artifact/node/edge/option ref：0 | ref 零出现 |
| 16.1-z02 | practice/diagnostic/not-assessable 导致 mastery 或 schedule 升级：0 | 零升级 |
| 16.1-z03 | assisted/stale 结果训练 FSRS 或延长 interval：0 | 零 FSRS / 零 interval 延长 |
| 16.1-z04 | Agent 直接修改 outcome、due、mastery、published semantic relation：0 | 四面零直接写 |
| 16.1-z05 | 单击选择/判断单独产生 mastery upgrade：0 | 零升级 |
| 16.1-z06 | ASR/Agent 改写后的答案伪装为用户原始答案：0 | ASR/Agent 两路零伪装 |
| 16.1-z07 | semantic relation candidate 自动转 published：0 | 零自动发布 |
| 16.1-z08 | 未作答前 DOM/network/cache/prefetch 答案泄漏：0 | 四渠道零泄漏 |
| 16.1-z09 | 跨 workspace/user 学习数据泄漏：0 | 双维度零泄漏 |
| 16.1-z10 | 重复 job/tool/commit 产生重复副作用：0 | 三路零重复副作用 |
| 16.1-z11 | 一个 input schedule 被成功消费超过一次：0 | 零重复消费 |
| 16.1-z12 | 每个成功提交的 schedule-bearing Episode 的 successor schedule 数不等于 1：0 | successor 恰为 1 |
| 16.1-z13 | `facet_eligible` 或 incomplete silent bundle 改变 Key Point schedule：0 | 两路零 schedule 副作用 |
| 16.1-z14 | `record_only/no_effect` 写 schedule 或结束 review attempt：0 | 四路零副作用 |
| 16.1-z15 | `create_initial/consume_pending` 提交后 active schedule 数不等于 1：0 | 两路恰为 1 |
| 16.1-z16 | 同一内容通过 legacy/new、换 Scene/policy 绕过 exposure/cooldown：0 | 两路零绕过 |
| 16.1-z17 | FSRS shadow 进入候选、排序、推荐理由或用户文案：0 | 四面零 shadow |
| 16.1-z18 | Episode plan 包含 ineligible target 或缺少 official decision ref：0 | 两路零 |
| 16.1-z19 | 星图无事件依据的正式状态变化：0 | 零无事件变化 |

### 3.2 100% 项（3 项）

| id | 冻结文本（01-5 §2） | 断言覆盖 |
| --- | --- | --- |
| 16.1-p01 | 未 redacted 结果从 contract + frozen probes + artifacts + EpisodeTrustDecision + assessments + scheduling decision + reducer 可做完整语义重算：100% | 输入全可获得 + 重算结果一致 |
| 16.1-p02 | redacted 结果只要求由 canonical event + content-free tombstone 确定性重放既有 outcome/投影，且明确不支持 semantic re-audit：100% | 事件/tombstone 可获得 + 重放一致 + 明确不支持语义重审 |
| 16.1-p03 | 投影 replay hash 一致：100% | 重放 hash == 存储 hash（且重放 hash 非空，拒绝空 hash 伪通过） |

## 4. §17.1 必测行为清单（35 条）摘要

清单 id 与冻结记录 01-6 §2 一一对应（17.1-01 ~ 17.1-35）：

1 credential 页零采集 fuzz；2 首次引导全路径与 CAS 竞争；3 onboarding sandbox
隔离；4 router 与 coverage registry 对账；5 trigger 双预算与多设备竞争；
6 quiet 零主动面与完整 context 升级门；7 认证/安全/权限/破坏性确认不依赖伴星；
8 stale action 与多设备恢复/接管；9 上下文关闭零传输与 action 重验；
10 audit/ledger 用途隔离与 TTL；11 hidden/off 边界；12 新设备 account bootstrap；
13 A11y 焦点/读屏/zoom；14 语音 Teach-back 全流程；15 `structured-proof-v1`
bundle 完整性；16 Public Scene 零 private 字段；17 assistance 先写后返回；
18 多标签并发 reveal/lock/submit；19 legacy/new exposure 竞态三组；
20 lock 后不可变；21 Supervisor turn/deadline 上限；22 Critic mandatory；
23 multi-Episode partial commit；24 schedule exactly-once 与 successor；
25 disposition 矩阵；26 semantic relation 不可经验证路径 published；
27 hidden-answer 负向权限；28 问题标记 RLS；29 四 origin 就地完成；
30 无键盘主路径；31 无任务债务文案；32 `temporary_hidden`/`global_off` 完整边界；
33 transcript 治理；34 kill/cancel/stale/publish 与 COMMIT 交错；
35 root capability 反向依赖闭包与原子 apply/rollback。

每条带 1~4 个真实断言（共 71 条断言），冻结文本全文保留于
`MUST_TEST_BEHAVIORS_17_1[].frozenText`。

## 5. 伪通过检测：placeholder / skip / insufficient-data 的机器可判定义

`detectFakePass`（纯函数）对每条 spec 的每条断言按序判定：

1. 断言列表为空 → `placeholder`（空实现占位，没有任何实际判定）；
2. `requires` 为空 → `insufficient-data`（未声明证据依赖）；
3. Proxy 观测判定运行时读取字段为空 → `skip`（恒真占位，无条件通过）；
4. `requires` 声明的字段未被判定实际读取 → `insufficient-data`
   （声明证据与判定不一致，可能是字段名写错或短路漏读）。

上述任一问题出现在任何硬指标/必测行为上 → `summary.allClosed=false`、
`rollbackEvaluationRequired=true`。测试对三类伪通过各构造必检样本，
并逐项证明清单自身零伪通过。

**清单完整性防御**：`runHardInvariantCloseout` 对比传入清单与冻结全量清单，
缺项/裁剪为空 → `missingInvariantIds`/`missingBehaviorIds` 记录且 `allClosed`
保持 false（同 08-3 对空 runs 的 security_review MEDIUM 修复精神——空清单
不得被 `every()` 语义静默放行）。

## 6. 关联契约（证据链映射，只读复用语义）

- 02-9 canonical-events：p01~p03 的重放/投影 hash 语义（`replayProjection` /
  `computeProjectionHash` / `driftCheck`；p03 的重放 hash 由接线层计算后注入，
  本模块判定一致）；
- 06-2 episode-commit：z02/z04/z10~z15/z18、bt23/bt24/bt25（disposition、
  commitKey 幂等、恰一 successor）；
- 06-4 race-rollback：z11/z12/z16、bt18/bt19/bt20/bt23/bt34（单消费者、
  三组 exposure 竞态、lock 后不可变、交错）；
- 06-5 official-scheduler：z17（FSRS shadow 隔离）、z12/z18、bt24；
- 08-2 security-audit：z01/z04/z06/z07/z08/z09、bt01/bt08/bt09/bt16/bt26
  （DOM Gold、credential 零采集、relation 审核发布）；
- 08-5 e2e-zero-tolerance：bt01/bt05/bt06/bt07/bt09/bt11/bt12/bt32
  （hidden/off 零活动矩阵、新设备预解析、写入四重验证）；
- 08-3 fault-matrix：z10/z16、bt22/bt34（exactly-once、交错、late response）；
- 07-1/07-2/07-3/07-4/07-6/07-7/07-8、04-1/04-4/04-5/04-6、03-2/03-4/03-5、
  02-2/02-4/02-8、01-7：bt02~bt06/bt08/bt10/bt13/bt14/bt17/bt21/bt28/bt30~
  bt33/bt35 等对应契约。

本模块不越过这些契约写领域数据；对既有实现的判定由接线 harness 注入观察
记录后在本模块复核（双层保障）。

## 7. 验收与证据

- [x] §16.1 全部 22 项（19 项 0 容忍 + 3 项 100%）清单与判定齐全；
- [x] §17.1 全部 35 条必测行为清单与判定齐全；
- [x] 无 placeholder / skip / insufficient-data 伪通过：`detectFakePass` 常驻
  检查 + 三类必检样本 + 清单自身零伪通过；
- [x] 每项有真实断言与证据：双样本（干净全 pass + 违规必 fail）覆盖全部
  57 项/条；
- [x] 清单缺测不静默通过（空清单防御）；
- [x] `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）；
- [x] `npm test --prefix apps/api` 通过（# tests 2561, # pass 2561, # fail 0，
  含 hard-invariants.test.ts 78 用例）。

## 8. 不做的边界（后续任务）

- 本任务不接入 HTTP 路由/接线；观察记录由 09-2 最终 qualification、09-5
  故障注入、09-6 真实环境 RC 的 harness 注入，本模块提供其收口检查点的
  确定性判定入口。
- 不重复实现既有模块的判定逻辑（cas/竞态/重放/redaction 等），只按
  冻结文本本地声明断言并映射到既有契约语义。
- 不修改其它任何文件（含 index.ts 导出、既有模块行为）。
