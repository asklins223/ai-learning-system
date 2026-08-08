# 决策记录 08-2：安全与隐私审计（§13.1/§13.3）

> 状态：**Frozen（已冻结）**
> 执行：阶段 08（W7）任务 08-2
> 日期：2026-08-08
> 来源：`08-w7-audit-observability.md` 任务 08-2（原方案 §13.1/§13.3）；
> 冻结记录 01-4（答案泄漏边界/RLS 与攻击面）、01-3（数据/API/工具边界）、
> 07-2（页面 coverage registry 与 manifest）、07-3（触发仲裁）、07-4（存在感控制）
> 约束级别：**所有攻击面对抗集通过；硬偏好违反为 0。**

## 1. 交付物

- `apps/api/src/modules/companion-shell/security-audit.ts` —— 安全/隐私审计
  **纯逻辑**（无 DB / 无网络 / 无副作用 / 无随机 / 无时钟依赖）：DOM Gold 双校验、
  credential 页零采集、manifest/action token 校验、stale action fail closed、
  workspace 切换原子清空、跨 workspace ref 不复用、对抗集 fail closed、
  drag/order/scenario payload 校验、relation candidate 不可经回答接口 published、
  hidden/off 零监听零调用矩阵与聚合套件。
- `apps/api/src/modules/companion-shell/security-audit.test.ts` —— 单测
  （每对抗面样本、DOM Gold 双校验、credential 六面零采集、stale fail closed、
  跨 workspace 拒绝等）。
- 本文件（决策记录）。

## 2. 决策：DOM Gold 双校验 = public allowlist + private denylist 同时生效

`checkDomGold` 对 trusted 提交前的前台 Companion DTO、RSC/hydration、prefetch、
cache 与 DOM 表面做**结构字段级**校验（不做粗暴 substring 禁止，§13.1）：

- **allowlist 校验**：任何表面出现的字段名必须属于 `publicAllowlist`；非
  allowlist 字段出现即违规；
- **denylist 校验**：`privateDenylist` 中的字段名（private contract 字段、完整
  claim 结论、secret solution、正确映射/distractor 身份、hidden rubric、
  expected target、private evidence、历史正确答案、内部 gap verdict、Tutor 提示
  等）出现在任何表面即违规——即使该字段同时被塞进 allowlist 也违规；
- **配置自检**：`publicAllowlist ∩ privateDenylist` 非空在配置层即失败（防
  allowlist 被 private 字段污染）；
- **DOM 文本**：`privateTokens` 出现在文本即违规；`publicTokens` 属于
  `PublicSceneContract` allowlist 放行（经 scene-safety-v1 批准）。

## 3. 决策：credential 页零采集六面 + 防枚举归一化

- 六面清单与任务 08-2 一致：`companion_dto` / `rsc` / `cache` / `analytics` /
  `logs` / `model_request`。输入值及字段焦点/长度/粘贴/自动填充/时序元数据
  进入任一面试 0 容忍违规；六面之外的渠道（截图/持久上下文等相邻面由 08-5
  D4 覆盖）记录出现视为防枚举失败，一律违规。
- `normalizeCredentialErrorCode`：内部错误码 → 公开只读白名单错误码
  （`GENERIC_AUTH/LOGIN/REGISTER/RESET_ERROR`），未映射内部码收敛为通用码，
  不泄漏枚举/堆栈/细节。
- `resolveCredentialPageRole`：`sensitivity === "credential"` 的页面只提供
  `static_help_only` 公开只读帮助（fail closed：不运行模型、不读表单、不观察
  字段或交互元数据）。

## 4. 决策：manifest / action token 校验与 stale action fail closed

- `validatePageManifestV1` / `validateActionTokenV1` 按固定顺序校验 schema →
  版本 → 来源 allowlist → workspace → permission snapshot hash → contextVersion
  → action allowlist ⊆ 注册表 → HMAC-SHA256 签名 →（token 另含 TTL）。任一失败
  fail closed。
- 签名载荷为确定性 canonical JSON（键序固定、数组排序），`verifySignature`
  使用常数时间比较。
- `evaluateStaleAction`：页面切换后 token 与当前页面任一维度（page instance /
  workspace / permission snapshot / contextVersion / action allowlist）不一致即
  拒绝动作——不绕过未保存内容、workspace 与权限状态（§17.2 故障矩阵）。

## 5. 决策：workspace/角色切换原子清空与跨 workspace ref 不复用

- `checkWorkspaceSwitchAtomicClear`：workspace 或角色切换后，旧 workspace 的
  全局任务上下文（entity refs / onboarding resume / invitation key / task state）
  必须原子清空；残留即违规。同一 workspace 且角色未变不要求清空。
- `checkCrossWorkspaceRefReuse`：同一 contextKey 在同一快照内出现在两个
  workspace，或复用了此前签发到他 workspace 的键（entity refs、onboarding
  resumeRef、邀请 key 三类全覆盖）= 违规。

## 6. 决策：对抗集确定性 fail closed

`evaluateAdversarialSample` 统一判定 8 个对抗面（§13.3）：

- prompt injection：命中任一确定性注入模式（大小写不敏感，含中英文）即拒绝，
  不依赖模型"自觉不泄题"；
- 伪 evidence/node/token/option ID：不在服务端签发注册表即拒绝；
- 跨版本引用：声明版本 ≠ 当前 context 版本即拒绝；
- 音频替换：绑定 hash 不一致且无用户显式确认（合法重录）即拒绝；
- replay：nonce 已消费或超出有效期即拒绝。

所有判定为纯函数、输入驱动、无时钟/随机依赖——对抗集确定性。

## 7. 决策：payload 校验、relation candidate 与 hidden/off 矩阵

- `checkCompanionPayload`：drag/order/scenario payload 校验 kind、每个 ID ∈
  allowlist、数量 ≤ maxCount、版本、hash，任一失败 fail closed。
- `checkRelationCandidatePublish`：semantic relation candidate 只能经
  relation review + 有审核权限的 actor 发布；经回答接口变成 published = 0。
- `checkHiddenOffZeroListenersCalls`：`temporary_hidden` 确认后当前 device
  session 的 observer / context DTO / 角色 / 邀请 / 声音 / 预取 / 新增
  Companion job = 0；`global_off` CAS 后所有设备上述活动 = 0。
- `checkGlobalOffAdditional`：`global_off` 后全部设备 lease 失效、Companion
  系统通知与跨设备调用为 0、已请求取消的调用必须被取消、迟到结果必须丢弃
  （不渲染/不写状态/不触发后续 job，§17.2）。

## 8. 聚合与 fail closed 断言

`runSecurityAudit` 聚合 7 个维度（DOM Gold / credential 零采集 / workspace 原子
清空 / 跨 workspace ref / relation publish / hidden/off / global_off 附加），
任一维度违规 → `ok=false`；`assertSecurityAudit` 抛 `SecurityAuditFailure`（0
容忍 fail closed），供 CI/接线层在 trusted 提交前调用。manifest/token/stale/
对抗集/payload 为独立判定函数，供各接入点单独复用。

## 9. 验收与证据

- [x] DOM Gold 双校验：allowlist 非白字段泄漏、denylist 字段泄漏（含 allowlist
  与 denylist 交集配置自检）、private token 文本泄漏全部检出；干净样本 0 违规。
- [x] credential 六面零采集：输入值及焦点/长度/粘贴/自动填充/时序元数据进入
  任一面试 0 违规被违反；未知渠道防枚举失败；错误码归一化不泄漏内部细节；
  公开帮助只读页面类型正确。
- [x] manifest / action token：schema/版本/来源/workspace/permission/context
  Version/allowlist/签名/TTL 各篡改面 fail closed（14 用例）。
- [x] stale action fail closed：页面实例/workspace/permission/contextVersion/
  allowlist 变化均拒绝（5 用例）。
- [x] workspace/角色切换原子清空 + 跨 workspace ref 不复用（entity/onboarding
  resumeRef/邀请 key 三类）。
- [x] 对抗集确定性样本：8 个攻击面全部被拒；干净样本放行。
- [x] payload 校验：非 allowlisted ID/数量超限/版本/hash/kind 各 fail closed。
- [x] relation candidate 经回答接口 published = 0；review 未经审核 actor 发布 = 0。
- [x] hidden/off 零监听零调用矩阵 + global_off 附加复核（lease/系统通知/跨设备
  调用/可取消调用/迟到结果）。
- [x] `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）。
- [x] `npm test --prefix apps/api` 通过（# tests 2431, # pass 2431, # fail 0，
  含 security-audit.test.ts）。

## 10. 不做的边界（后续任务）

- 本任务不接入 HTTP 路由/接线；审计器由路由接线层在 trusted 提交前、credential
  页请求、manifest/token 校验点与 hidden/off 确认后调用。
- 全链路 E2E 0 容忍（截图/持久上下文渠道、epoch 传播 SLA、新设备预解析等）
  属任务 08-5 `e2e-zero-tolerance.ts`，本模块与其互补不重复。
- 公开 token 的 `disclosureProfileHash` 进入 template trust ceiling 与
  `FrozenProbeRef` 的接线属 Scene/Trust 模块，本模块以 `publicTokens` 声明放行
  为前提。
