# 决策记录 07-8：跨页、跨设备与失败恢复（§5.4.7）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-8
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-8（原方案 §5.4.7）+ 冻结记录 01-2（Session/Scene/Artifact 合同）、01-3（数据对象清单）、05-5（控制状态作用域）
> 约束级别：恢复/接管前不暴露未重验 target 名称；未接管设备提交为 0；跨 workspace context/entity 泄漏为 0。

---

## 1. 交付物

- `apps/api/src/modules/learning-sessions/cross-device-recovery.ts`：§5.4.7 全部决策面
  的纯逻辑（无数据库/无网络/无时钟/无副作用源）——
  跨页有界携带校验、跨设备同步白名单、新设备续接询问、target 展示前重查、
  多设备显式接管、登录过期恢复、失败恢复与重试幂等。
- `apps/api/src/modules/learning-sessions/cross-device-recovery.test.ts`：51 个单测。
- 本决策记录。

## 2. 冻结语义与实现映射

### 2.1 跨页只携带四样东西（§5.4.7 bullet 1）

`validateCrossPageCarry` 只接受四样东西：有界任务摘要（`goalText` ≤
`MAX_CARRY_SUMMARY_LENGTH=200`）、`originRef`、合法 entity refs（≤ 8 且
必须绑定 workspaceId）、已确认 checkpoint；**任何 `messages` /
`messageHistory` / `transcript` 数组一律拒绝**（`unbounded_message_flow`，
不携带无限消息流）。返回时恢复来源/滚动位置/星图 viewport/选择态：
`resolveCrossPageRestore` 的 viewport/selection 只来自冻结恢复事实（07-5
PREPARE 冻结同源），且仅在返回来源是星图时呈现，**不是页面间携带数据**。

### 2.2 跨设备同步白名单（§5.4.7 bullet 2）

`CROSS_DEVICE_SYNC_WHITELIST` 恰为六类：onboarding offer 终态 / global off /
存在感 / suggestion suppression / 学习目标 / 合法 Session checkpoint。
`extractCrossDeviceSyncState` 输出键集合 = 白名单（snake_case，与 DB 列对齐）；
`NEVER_CROSS_DEVICE_FIELDS` 明确排除 temporary hidden / page mute /
未提交输入 / 原始音频 / 临时敏感内容；`assertNoDeviceLocalLeak` 对同步
payload 做键级校验，白名单外键一律判为泄漏。

### 2.3 新设备续接询问（§5.4.7 bullet 3）

`deriveNewDeviceResumeOffer`：无 checkpoint → none；已问过一次 → 被动入口
（至多问一次）；quiet → 只被动续接、**绝不自动展开完整 Scene**；trigger 不
允许 → 被动入口；其余 → `ask_once`（「继续上次任务 / 暂不恢复」）。
`chooseResumeResponse("continue_task")` 恒返回 `needsRevalidation: true` +
`needsExplicitTakeover: true` —— 选择「继续」也**不自动展开 Scene**。

### 2.4 target 展示前重查（§5.4.7 bullet 3，验收核心）

`revalidateTargetBeforeReveal` 在展示 target 名称前重查 workspace / 权限 /
内容 revision / policy / assistance / capability / checkpoint 时效（默认 7 天）。
任一过期 → `targetNameRevealed: false` + 原因 + 安全重建计划（不含 target
名称）；**恢复/接管前不暴露未重验 target 名称**由类型面（discriminated
union）与运行面（失败文本不含 targetName）双重保证。

### 2.5 多设备显式接管（§5.4.7 bullet 4，验收核心）

`tryExplicitTakeover`：无接管者 → 首个显式请求接管成功；已接管者重复请求 →
幂等同结果；其它设备 → 只读提示，`commitAllowed=false`（**未接管设备提交为 0**，
`isCommitAllowedForDevice` 恒为 owner 专属）。接管的显式性由调用方保证
（仅用户显式选择「在此设备继续」才调用，绝不自动接管）。

### 2.6 登录过期恢复（§5.4.7 bullet 5）

`reauthResumeAfterExpiry`：重新认证成功 → 回到原页面与合法 checkpoint，
可用 scope 取新授权；`replayedOldPermissionActions` 在类型面（`readonly []`）
与运行面恒为空数组 —— **不重放旧权限 action**，过期前的 pending action
转为「需用户重新显式确认」。

### 2.7 失败恢复与重试幂等（§5.4.7 bullet 6）

`buildFailureRecoveryOffer`：Shell/角色/动画/语音/模型失败**不阻塞页面**
（`neverBlockPage: true`）；始终提供「重试 / 使用手动方式 / 退出伴星」；
`planRetry` 只重放未应用步骤（`stepsToRetry`），已确认/已应用步骤不重复
（`retryIdempotent`）；存在丢失的已确认步骤时禁止重试（不丢失已确认步骤、
不重复副作用）。

## 3. 测试覆盖

51 个单测：跨页携带（消息流拒绝、跨 workspace 拒绝、有界长度/数量）、
返回恢复（星图现场与非星图零泄漏）、同步白名单（键集合=白名单、device-local
排除、泄漏检测）、新设备续接（至多一次/quiet 被动/不自动展开）、重查
（全通过才暴露、六类失败不暴露名称、checkpoint 时效）、接管（幂等/未接管
提交为 0）、登录过期（不重放旧权限 action）、失败恢复（三选项恒在/幂等/
不丢失已确认步骤）。

## 4. 验收对照

- 恢复/接管前不暴露未重验 target 名称：`revalidateTargetBeforeReveal` 失败
  分支 `targetNameRevealed: false` 且失败文本不含 targetName ✓
- 未接管设备提交为 0：`commitAllowed` 恒为 owner 专属，非 owner 恒 false ✓
- 跨 workspace context/entity 泄漏为 0：entity refs 必须绑定 workspace 且
  与 carry 一致，不一致即拒绝 ✓

---

*本文档为阶段 07 W6 任务 07-8 决策记录，忠实覆盖 `07-w6-global-companion-map-tutor.md`
任务 07-8（§5.4.7）。*
