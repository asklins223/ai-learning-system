# 决策记录 07-3：触发仲裁、双预算与建议抑制（§5.4.5）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-3
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-3（原方案 §5.4.5）；
> 冻结记录 01-3（数据/API/工具边界）、02-4（audit/ledger 隐私生命周期）、
> 03-5（Global Shell 确定性动作与触发仲裁）
> 约束级别：同一 `contextBudgetKey`/`reasonBudgetKey` 不重复；
> 多标签/多设备同一用户同时最多一条提示；无有效 permit 不渲染主动提示。

## 1. 交付物

- `apps/api/src/modules/companion-shell/trigger-arbitration.ts` —— 触发仲裁纯逻辑 +
  事务语义封装：
  - `COMPANION_TRIGGER_REASONS`：bounded registry enum，六种合法 reason
    （resume_paused_task / recoverable_error_explanation / canonical_stale_change /
    committed_change_display / long_absence_resume / active_tier_next_step），
    **never model-authored**——任何其他字符串在 policy 校验/rule 解析阶段拒绝；
  - `CompanionTriggerRuleV1` registry（reasonId、sourceEventType、
    allowedPresenceLevels、allowedPageKinds、requiredCapabilityIds、
    suppressionModes、stableContextKeyPolicy、cooldownPolicyId、actionManifestId）
    与默认规则表；
  - 抑制顺序链 `SUPPRESSION_CHAIN_ORDER`：auth_local_hidden/global_off >
    temporary_hidden > page_muted/page_context_off/focus_until_task_end/
    suggestion_paused/suppressedSuggestionClassIds > presence level > rule
    capability/page/action eligibility > stable page budget 与 reason budget；
  - 双预算两个稳定身份 key 构造：`buildStablePageContextKey`（workspace +
    routePattern + canonical target/origin + targetChangeEpoch）、
    `buildContextBudgetKey`（user + stablePageContextKey + cooldownEpoch）、
    `buildReasonBudgetKey`（user + workspace + canonical target/origin +
    targetChangeEpoch + boundedReasonId + cooldownEpoch）；
  - `CompanionTriggerPolicyV1` 签名冻结：结构校验 + hash 校验双 gate，
    **policy 缺失或 hash 不匹配 → 主动提示 fail closed**（被动召唤与页面原生
    功能仍可用）；reasonId/cooldownEpoch/lease TTL/key policy 均由签名 policy
    冻结，Agent 无权生成或修改；
  - `issueSuggestionPermit`：一次提示 = 同一 DB 事务（policy 校验 → rule 解析 →
    抑制链 preflight → 预算判定与唯一约束插入/更新 → 获取 account-scoped 短 TTL
    activeSuggestionLease → 签发一次性 `CompanionSuggestionPermitV1`）；任一
    key/lease 冲突抛 `TriggerArbitrationError` 由调用方整体回滚，前台不渲染；
  - `consumeSuggestionPermit`：dismiss 置 consumedAt 终态、cooldownEpoch 单调
    +1、释放 lease，**不退还已消费预算**；迟到 dismiss（surface epoch 落后）
    一律丢弃；
  - `evaluateTargetChange`：canonical 指纹实质变化才单调 +1（服务端唯一判定）；
    `compareTriggerPriority`：召唤 > 续接 > 可恢复错误 > canonical 变化 > 普通建议；
  - drizzle ledger 表定义与 `createPgTriggerLedgerRepo`（路由接线层使用）。
- `apps/api/src/modules/companion-shell/trigger-arbitration.test.ts` —— 单测
  （内存 repo 模拟行锁/唯一约束/lease 冲突）。

## 2. 决策：合法 reason 是 bounded registry，不是自由文本

Agent/客户端提交的 reasonId 必须是 registry 中的字面量；`resolveTriggerRule`
对未知 reasonId 返回 null，`issueSuggestionPermit` 抛 `UNKNOWN_TRIGGER_REASON`。
注册后首次 consent surface 使用**独立 onboarding 状态机与预算**（任务 02-3/
07-1），不进本 registry；onboarding 的 offer CAS 已由 service.ts 实现。

## 3. 决策：抑制顺序链是唯一权威，budget 在链尾

`applySuppressionChain` 纯函数按固定顺序执行 preflight 层（前 8 层 + presence
level + rule eligibility）；两个 budget gate 由 `issueSuggestionPermit` 在事务内
基于 ledger 行追加判定。顺序保证：隐藏/关闭优先于一切路由级抑制；presence
level 先于 rule eligibility；预算最后。认证、安全、权限与破坏性操作确认属
页面原生系统 UI，不进 trigger budget。

## 4. 决策：双预算唯一性 = 稳定身份 + 唯一约束

`stablePageContextKey` 只由 workspace/routePattern/canonical
target-origin/targetChangeEpoch 派生，**不复用随刷新变化的
pageInstanceId/contextVersion/viewport/临时选择**。同一
(user, stablePageContextKey, cooldownEpoch) 至多一次 context 展示；
同一 reason 在同一 (target, epoch, cooldown) 至多有界次数。ledger 表以
`contextBudgetUnique` 唯一索引兜底（迁移 0076）。dismiss 后 cooldownEpoch
单调 +1 → 新预算槽，旧 key 永不复用。

## 5. 决策：一次提示 = 单事务原子签发，冲突整体回滚

签发流程在同一 DB 事务内完成（生产由路由接线层 withWorkspaceTransaction
包裹 repo）；内存测试以全局 FIFO 锁模拟「第二个事务等待第一个提交后读到
已提交行」，验证多设备并发仅一条成功（第二个拿不到 permit）。dismiss、
页面离开或 TTL 释放 lease 不退还预算；`reasonBudgetRemaining` 只减不增。

## 6. 决策：policy fail closed，targetChangeEpoch 服务端单调

policy 结构非法、hash 缺失或不匹配 → `TRIGGER_POLICY_INVALID`，主动提示不
渲染但被动召唤与页面原生功能保留。`targetChangeEpoch` 由
`evaluateTargetChange`（服务端对 canonical 指纹的实质变化判定）单调 +1，
客户端/Agent 不能自增 epoch 换取新预算。

## 7. 验收与证据

- [x] 同一 `contextBudgetKey`/`reasonBudgetKey` 不重复
  （`CONTEXT_BUDGET_ALREADY_SPENT`/`REASON_BUDGET_ALREADY_SPENT` 用例）。
- [x] 多标签/多设备同一用户同时最多一条提示（并发仅一条成功 + 活跃 lease
  冲突用例）。
- [x] 无有效 permit 不渲染主动提示（policy 缺失/篡改 fail closed、预算/
  抑制拦截即抛错；前端由 07-5 及后续接线任务消费 permit）。
- [x] `npm test --prefix apps/api` 通过（# tests 2173, # pass 2173, # fail 0，
  含 trigger-arbitration.test.ts 25 用例）。
- [x] `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）。

## 8. 不做的边界（后续任务）

- 本任务不接 `/me/companion/trigger` 等 HTTP 路由；permit 签发由路由接线层
  注入 repo 并包裹事务（后续接线任务）。
- onboarding 首次 consent surface 的独立预算由 02-3/07-1 状态机承载，本模块
  不重复实现。
- 页面 coverage registry / action manifest 的 hash 校验属任务 07-2；
  `actionManifestValid` 作为输入由接线层传入。
