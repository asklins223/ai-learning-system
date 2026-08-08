# W7 证据：跨模块安全 / 隐私 / 可观测性审计

> 对应任务 11-2 证据文件 9。佐证 DoD 9、12、13、32、33。
> 决策记录：`docs/plans/learning-companion/08-1-a11y-onboarding-audit.md` ~ `08-5-e2e-zero-tolerance.md`。

## 1. 交付文件核验（路径存在 + 测试全绿）

| 文件 | 对应记录 | 职责 | 测试 |
| --- | --- | --- | --- |
| `apps/web/lib/learning-companion/a11y-audit.ts` + `.test.ts` | 08-1 | WCAG 2.2 AA serious/critical 规则清单 + §13.4 产品硬门禁清单，DOM 经视图模型注入、纯函数可测；`runA11yAudit` 聚合 gate | `apps/web` 全套 750 项通过（含 a11y-audit 用例） |
| `apps/api/src/modules/companion-shell/security-audit.ts` + `.test.ts` | 08-2 | DOM Gold 双校验、credential 零采集、manifest/action token、stale fail closed、workspace 原子清空、对抗集、payload、hidden/off 矩阵；`runSecurityAudit` 7 维度聚合 | `npm test --prefix apps/api` # tests 2431 / pass 2431 / fail 0 |
| `apps/api/src/modules/learning-sessions/fault-matrix.ts` + `.test.ts` | 08-3 | §17.2 故障矩阵 22 项演练编排（`FaultSpec[] = FAULT_MATRIX`）、注入场景端口、`judgeDrill` / `runMatrixDrill` | `fault-matrix.test.ts` # tests 53 / fail 0 |
| `apps/api/src/modules/observability/metrics-schema.ts` + `.test.ts` | 08-4 | 冻结指标定义表（observation / observe-only / cost / hard-gate 四类）、观察 vs 硬 Gate 分离、p50/p95、重试放大、hidden/off 后新增成本 0 | `npm test --prefix apps/api` 全量通过 |
| `apps/api/src/modules/observability/privacy-review.ts` + `.test.ts` | 08-4 | privacy review 12 项确定性检查清单（audit/ledger TTL、残留、导出/删除）+ fail closed | 同上 |
| `apps/api/src/modules/companion-shell/e2e-zero-tolerance.ts` + `.test.ts` | 08-5 | 全链路 0 容忍校验（D1~D8 八组确定性断言）、`assertZeroTolerance` fail closed | `e2e-zero-tolerance.test.ts` 53 用例；# tests 2301 / pass 2301 / fail 0 |

## 2. A11y 审计（08-1，佐证 DoD 32）

- 规则与组件分离：模块只依赖同目录纯逻辑与 `@ailearn/shared` 类型契约，不 import 任何组件/JSX；源码零副作用断言（不含 `document.`/`window.`/`fetch(`/`setTimeout(` 等）。
- **WCAG 2.2 AA serious 规则 14 项**：非文本替代、语义标签、文本对比度（4.5:1 / 3:1）、200% zoom、320px reflow、非文本对比度 ≥3:1、键盘可达、无键盘陷阱、焦点顺序与返回、focus-visible、触控目标 ≥44×44、无倒计时评分、reduced-motion、名称/角色/值。
- **§13.4 产品硬门禁（critical）13 项**：onboarding 跳过同级、可导航、无 focus trap、焦点返回、live region 最少化、拖拽等价、读屏可理解、非颜色唯一、语音默认不自动播放、无时限评分、390/768/1440 三视口、角色状态一致性、硬偏好违反 0。
- 聚合 gate：`passed = (WCAG 2.2 AA serious/critical 计数 === 0) && (硬偏好违反 === 0)`。
- 角色状态一致性（`auditRoleStateConsistency`）复用 05-4 `eventAllowsVisualState` 权威映射：动画伪装评估进度 / 伪装 canonical 结果 / 活动量伪装知识成长均判违规。

## 3. 安全与隐私审计（08-2，佐证 DoD 9、12）

- **DOM Gold 双校验**（`checkDomGold`）：public allowlist + private denylist 同时生效；allowlist∩denylist 非空在配置层即失败；private token 出现在文本即违规。
- **credential 六面零采集**（佐证 DoD 9）：输入值及焦点/长度/粘贴/自动填充/时序元数据进入 companion_dto / rsc / cache / analytics / logs / model_request 任一面试 0 容忍违规；六面之外渠道出现记录视为防枚举失败；错误码经 `normalizeCredentialErrorCode` 收敛为公开白名单，不泄漏内部细节；`sensitivity=credential` 页面只提供 `static_help_only`（fail closed：不运行模型、不读表单、不观察字段）。
- **manifest / action token**：schema → 版本 → 来源 allowlist → workspace → permission snapshot hash → contextVersion → action allowlist ⊆ 注册表 → HMAC-SHA256 签名（常数时间比较）→ TTL，任一失败 fail closed（14 用例）；`evaluateStaleAction` 页面切换后任一维度不一致即拒绝（5 用例）——佐证 DoD 12 的「current context/permission 重验」与 stale 拒绝。
- **写入四重验证**：`e2e-zero-tolerance` D6 `checkMutationRequiresFourGates`（影响预览 + context/permission 重验 + 有效 nonce + 显式确认缺一仍成功执行即违规）+ Global Shell 零领域写（`shell-actions.ts` 每个结果字面量 `canonicalWrite: false` 的编译期保证）——佐证 DoD 12。
- **对抗集确定性 fail closed**：prompt injection / 伪 ID / 跨版本引用 / 音频替换 / replay 5 类对抗面全部确定性拒绝，8 个攻击面样本全部被拒、干净样本放行。
- **workspace/角色切换原子清空** + 跨 workspace ref 不复用（entity refs / onboarding resumeRef / 邀请 key 三类）。
- **hidden/off 矩阵**：`temporary_hidden` 确认后当前 device 12 类活动（含 observer/idle）= 0；`global_off` CAS 后所有设备上述活动及系统通知 = 0；可取消调用未取消 / 迟到结果被采用 = 违规（佐证 DoD 12 的零监听/零调用边界）。

## 4. 故障矩阵演练（08-3，佐证 DoD 33）

- §17.2 **22 项故障**逐项留档（表格 23 行 = 22 项故障 + 表头），每项声明 expected（failClosed / exactlyOnce / degrade / recover / noSideEffect）、hard invariant 标记与可验证断言集合。
- 每项执行 3 次重复（关键 crash/retry/cancel/stale/并发场景 5 次），判定均 **PASS**；hard invariant **18 项**通过率 **100%**；`rollbackEvaluationRequired = false`。
- H1 安全/隐私、H2 学习副作用、H3 权威一致性、H4 恢复可信度四类 hard invariant 违反 → 立即回滚评估（不得带违规进入阶段 09）。
- 可重复性：纯函数 + 注入端口（`FaultDrillPort.run(faultId)`），测试覆盖「同一端口两次演练结果一致」。

## 5. 可观测性与 privacy review（08-4，佐证 DoD 13）

- `metrics-schema.ts` 冻结四类指标：`observation`（观察不优化）、`observe-only`（7 项只观察）、`cost`（每 Episode/Session 预算 + 用户级 p50/p95 + 重试放大）、`hard-gate`（hidden/off 后新增成本 0、取消后新增调用 0、Tutor 不借 formal 预算、重试放大上限、p95 上限）。
- **观察 vs 硬 Gate 分离是结构约束**（`checkCoerciveAuthorization`）：任何非 hard-gate 指标授权 `hide_skip / extra_modal / streak / task_debt / auto_advance / companion_nudge` 即违规；observe-only 7 项经 `assertObservationOnlyMetric` fail closed；alerts 只以 hard-gate 与 cost 类指标为触发源。
- **privacy review 12 项**（佐证 DoD 13）：audit TTL 30 天、ledger TTL 30 天、tombstone content-free、实体清理覆盖全存储、导出覆盖率 100%、删除跨 workspace 级联、删除后不重新邀请 / 不重建画像、残留扫描唯一删除入口（count=1）、用途隔离（不入增长画像 / 兴趣推断 / 跨 workspace analytics）、RLS 双条件。`assertPrivacyReviewPassed` fail closed。

## 6. 全链路 E2E 0 容忍（08-5，佐证 DoD 9、12、33）

`e2e-zero-tolerance.ts` 以 `CompanionActivity` 事件序列为输入的确定性纯函数校验，8 组 0 容忍（D1~D8）：

| 维度 | 冻结依据（01-5 §5.3） | 判定 |
| --- | --- | --- |
| D1 hidden/off | 第 1 条 | hidden/off 后 12 类活动 / 系统通知 / 可取消调用 / 迟到结果 |
| D2 epoch | 第 2 条 | 传播 > SLA（`GLOBAL_OFF_PROPAGATION_SLA_MS = 5_000`）、旧 lease 到期后挂载/调用、CAS 失败谎报 |
| D3 新设备 | 第 3 条 | 认证后、解析前挂载 |
| D4 credential 页 | 第 4 条 | 六面零进入 + LLM/ASR/TTS/预取/observer 零 |
| D5 quiet/permit | 第 8 条 | quiet 零 observer/context/idle；permit+接受前零传输 |
| D6 写入 | 第 11 条 | 四重验证缺一仍成功；Global Shell 零领域写 |
| D7 自主性 | 第 16/17/18 条 | 零自动开麦 / 零未 opt-in 通知 / later/dismiss/stop 零副作用 / 停止 100% / 零自动续题 |
| D8 onboarding | 第 6 条 | offered 零二次展示 / consumed 零自动重放 / 跳过动作数 1 / 终态零回退 |

`assertZeroTolerance` 任一违规抛 `ZeroToleranceFailure`，供 CI/E2E harness 在旅程结束点调用（0 容忍 fail closed）。

## 7. 判定层证据

- 全部为纯函数判定层交付：无 DB / 无网络 / 无时钟 / 无副作用 / 无随机，同一输入恒得同一输出；真实 DOM/旅程观察由 E2E harness（接线层）注入视图模型后复核。
- 验证记录：`npm run typecheck --prefix apps/web`（`--incremental false`）与 `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）；`apps/web` 全套 750 项通过；`apps/api` 各阶段全量 # pass / # fail 见 §1 表。
- 决策记录 08-1 ~ 08-5 状态均为 Frozen（已冻结）。
