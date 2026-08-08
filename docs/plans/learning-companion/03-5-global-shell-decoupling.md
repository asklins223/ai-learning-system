# 决策记录 03-5：Global Shell 与 Session Supervisor 解耦（§0.5/§5.4）

> 状态：**Frozen（已冻结）**
> 执行：阶段 03（W2）任务 03-5
> 日期：2026-08-08
> 来源：`03-w2-session-supervisor-runtime.md` 任务 03-5（原方案 §0.5/§5.4）
> 约束级别：普通浏览/引导路径零 Session 创建、零 learning budget 消耗。

## 1. 目标

把 Global Companion Shell（统一伴星身份、页面导航、首次引导、静态帮助、触发仲裁、
origin 恢复）与 Learning Session Supervisor 的运行时彻底解耦：普通浏览/引导路径
**不创建 Learning Session、不借用 learning Agent budget**，全库只有一条 Learning
pipeline（PREPARE → SESSION_AGENT → INDEPENDENT_ASSESS → COMMIT），Global Shell
只做确定性分发与呈现。

实现：`apps/api/src/modules/companion-shell/shell-actions.ts`（9 个确定性动作服务）、
`apps/api/src/modules/companion-shell/shell-actions.test.ts`（单测）、
`apps/api/src/modules/companion-shell/index.ts`（re-export）。

---

## 2. 决策：Global Companion Shell 是确定性分发与呈现壳，不是第二条 Learning pipeline

- **单一 contract**：所有页面复用一个 versioned context/action contract
  （`global-shell-context-action-v1`：`contextVersion` + `pageAccess` + 动作目标字段）。
  客户端提交的 `contextVersion` 必须等于当前版本，否则 `STALE_CONTEXT_CONTRACT` 409 拒绝
  （防旧上下文与拼装上下文）。
- **单一触发仲裁器**：所有动作走唯一入口 `executeGlobalShellAction`（白名单校验后分发），
  并挂可注入 `ShellActionArbiter`：同一页面一次只展示一个动作、冷却、每用户开关
  （production 由路由层接入账号级 `globalEnabled/suppression` 等开关读取）。
- **一套用户开关**：不新增 per-page 助手 Agent、消息历史或记忆库；所有页面共用一个
  账号级开关集（复用 02-3 `user_companion_account_state`，本模块只声明开关读取钩子）。
- **九个专用执行函数**：`executeSpotlightUiAnchor` / `executeOpenPageHelp` /
  `executePreviewNavigation` / `executeResumeOnboarding` / `executeResumeCheckpoint` /
  `executeShowPermissionScope` / `executeDismissSuggestion` /
  `executePreviewRegisteredPageAction` / `executeRequestPageActionConfirmation`，
  与白名单 `GLOBAL_SHELL_ACTION_IDS` 一一对应（测试断言无遗漏无多余）。

## 3. 零 Session 创建、零 learning budget 消耗（解耦证明）

- **无依赖**：`shell-actions.ts` 不 import `learning-sessions` 模块、不 import
  budget/DB/shared；单测对源码做静态 import 断言（测试从源头锁定解耦）。
- **类型层面**：每个动作结果带字面量 `sessionCreated: false`、
  `learningBudgetSpent: 0`、`canonicalWrite: false`，编译期即阻止把 Global Shell
  动作当作学习管道入口或领域写。
- **运行时守卫**：`canCreateSession()` 恒返回 `false`、`learningBudgetForShellAction()`
  恒返回 `0`，统一执行流程在生成结果前合并判定（不可达护栏）。
- **执行语义**：每个动作只做「校验页面上下文/权限 → 记录 audit → 返回确定性结果」；
  不创建 Episode、不直接修改领域数据、不调 Agent。页面导航、首次引导、静态帮助
  全部走本服务，不触碰 PREPARE/Episode/BudgetEnvelope。

## 4. 确定性动作清单与边界（§5.4，9 个）

| 动作 | 页面访问级别 | 所需上下文 | 语义 |
| --- | --- | --- | --- |
| `spotlight_ui_anchor` | public / authenticated | pageOpaqueId, anchorId | 页面锚点亮显（纯 UI） |
| `open_page_help` | public / authenticated / **credential** | pageOpaqueId, helpTopic | 静态帮助面板 |
| `preview_navigation` | public / authenticated / **credential** | pageOpaqueId, destinationPageId | 静态导航预览，不实际导航 |
| `resume_onboarding` | public / authenticated | onboardingVersion | 恢复首次引导（非学习内容） |
| `resume_checkpoint` | **authenticated** | checkpointRef, userId, workspaceId | 被动恢复入口，**不创建 Session** |
| `show_permission_scope` | **authenticated** | permissionScopeId, userId | 静态权限范围说明卡 |
| `dismiss_suggestion` | public / authenticated / **credential** | suggestionId, deviceSessionId | 记录关闭建议意图，不改领域数据 |
| `preview_registered_page_action` | public / authenticated | registeredActionId | 动作预览，确认前零副作用 |
| `request_page_action_confirmation` | public / authenticated | registeredActionId, userId | 显式确认 UI，动作本身未执行 |

**权限边界**（fail closed）：

- `credential`（登录/注册凭据页）只放行静态帮助/关闭建议/导航预览；
  禁止任何个性化动作（resume_onboarding / resume_checkpoint / show_permission_scope /
  preview_registered_page_action / request_page_action_confirmation → `PERMISSION_DENIED` 403）。
- authenticated-only 动作（resume_checkpoint / show_permission_scope）在 public 页拒绝。
- 缺少动作所需字段 → `INCOMPLETE_PAGE_CONTEXT` 422；白名单外动作 → `UNKNOWN_ACTION` 400；
  仲裁器拒绝 → `ARBITER_DENIED` 409；context 版本失配 → `STALE_CONTEXT_CONTRACT` 409。

**模型不能自由拼装**：动作 ID 只接受预注册白名单；spatial actions
（`focus_nodes` 等）与任意拼装字符串一律 `UNKNOWN_ACTION` 拒绝；动作目标字段只取
净化页面上下文中的 opaque 引用，不接受任意内容/脚本/DOM。

## 5. 审计与隐私

每个动作执行成功都经可注入 `deps.audit` 写一行 audit（production 接 02-4
`companion_audit`）：只存 action / pageOpaqueId / actionOpaqueId /
entityOpaqueIds（目标 id 的 SHA-256 hash）/ contextVersion / permissionSnapshotHash
（pageAccess+action+requires 稳定指纹）/ policyVersion / result。不存页面内容、DOM、
截图、凭据或未提交输入（§12.2）；不写学习事实（§12.2 §2.2，02-4 同语义）。

## 6. 验收与证据

- [x] 普通浏览/引导路径零 Session 创建、零 learning budget 消耗
  （结果字面量 + 守卫 + 静态 import 解耦断言）。
- [x] 9 个 §5.4 动作均可确定性执行；未知 action 拒绝；权限不足拒绝。
- [x] `npm run typecheck --prefix apps/api` 通过。
- [x] `npm test --prefix apps/api` 通过（含 `shell-actions.test.ts` 新增 26 用例）。

## 7. 不做的边界（后续任务）

- 本模块不建 HTTP 路由；端点由后续任务在 `companion-shell/routes.ts` 接入
  （本决策只冻结服务层契约与边界）。
- 生产级审计接 `audit-service.logCompanionAudit`、账号开关接
  `user_companion_account_state` 读取，属路由层注入职责，不改本模块。
