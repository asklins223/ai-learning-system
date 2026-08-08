# 决策记录 02-5：auth-surface manifest 与 credential 零采集（§12.3+§13.3）

> 状态：**Frozen（已冻结）**
> 执行：阶段 02（W1）任务 02-5
> 日期：2026-08-08
> 来源：`02-w1-data-rls-privacy-events.md` 任务 02-5（原方案 §12.3+§13.3）
> 约束级别：credential 页输入值及字段交互元数据进入 Companion DTO、日志、analytics、截图、模型或持久上下文为 0；Provider/observer 调用为 0。

## 1. 目标

登录/注册页（`sensitivity=credential`）在任何登录态下都不允许伴星采集凭据或其交互元数据。
为让页面在没有 authenticated API 的情况下仍能获得「角色说明、公开帮助与错误帮助」，
引入**随构建签名的 auth-surface manifest**：公开静态文案、随构建签名、经公开端点下发。

实现：`packages/shared/src/auth-surface-manifest.ts`（契约/schema/构建校验）、
`apps/api/src/modules/companion-shell/auth-surface.ts`（HMAC 签名 + 测试模式降级）、
`apps/api/src/modules/companion-shell/routes.ts`（`GET /public/auth-surface-manifest`）。

## 2. auth-surface manifest（§12.3 + §13.3）

- **来源**：manifest 内容全部是随构建签名的公开静态文案（角色说明、公开帮助、错误帮助），
  不涉密、不含账号/凭据相关值；经 `GET /public/auth-surface-manifest` 公开下发，**不鉴权**，
  不依赖 authenticated API，不发起 LLM/ASR/TTS 或个性化预取。
- **结构**（`AuthSurfaceManifestV1`）：`version`（literal `"1"`）、`signedAt`（构建时刻，
  随构建固定）、`signature`（hex HMAC-SHA256）、`surfaces[]`。每条 surface 含
  `surfaceId`、`surfaceKind`（`static_help | silent_anchor | transitional`）、
  `textContent`（归一化纯文本：空白折叠，非 HTML/富文本）、`visibleEntityRefs`（必须为空）、
  `allowedActions`（有限 allowlist，仅 `AuthSurfaceAction` 集合内动作）。
- **签名**：HMAC 密钥来自环境变量 `AUTH_SURFACE_MANIFEST_SECRET`，代码中不硬编码；
  对「不含 signature 的规范化 JSON 载荷」做 HMAC-SHA256（递归键排序、数组保序，
  跨进程可复现）。客户端渲染前校验签名，失败 **fail closed** 到通用帮助。
- **测试模式降级**：密钥缺失时用公开 test secret 签名，响应中显式注明 `testMode=true`；
  生产部署必须设置 `AUTH_SURFACE_MANIFEST_SECRET`。
- **构建即校验**：`buildAuthSurfaceManifestPayload` 强制每条 `visibleEntityRefs` 为空、
  `allowedActions` 属于 allowlist、`textContent` 归一化，并拒绝任何模型/ASR/TTS/
  observer/截图/剪贴板/交互时序相关字段（schema `.strict()` + 显式 forbidden-key 扫描）。

## 3. credential 零采集规则（§13.3）

任意 `sensitivity=credential` 页面（未登录或已登录）只允许使用签名静态 allowlist 和
`static_help / silent_anchor / transitional` surface：

- `visibleEntityRefs` / `selectedEntityRefs` 必须为空（schema `length(0)` + 显式校验）。
- **LLM / ASR / TTS 调用为 0**：不发起任何模型 Provider 请求。
- **Companion 预取为 0**：不预取学习内容/个性化上下文。
- **DOM / selection observer 为 0**：不挂载 DOM 观察器、选区观察器、焦点/长度/粘贴/
  自动填充/校验时序/输入节奏采集（Provider/observer 调用为 0）。
- 伴星最多读取**归一化页面状态**（如表单视图/提交中/通用错误/通用成功）与**通用错误码**。
- 错误码只给通用枚举（`AuthSurfaceErrorCode`）：`INVALID_CREDENTIALS`、
  `ACCOUNT_ACTION_BLOCKED`、`RATE_LIMITED`、`SERVICE_UNAVAILABLE`、
  `MANIFEST_UNVERIFIED` —— 一律**不暴露账号是否存在**。
- 验收红线：credential 页输入值及字段交互元数据进入 Companion DTO、日志、analytics、
  截图、模型或持久上下文为 0；Provider/observer 调用为 0。

## 4. 未登录「隐藏伴星」：单一 device-local 布尔值（§13.3）

- 未登录页尊重「隐藏伴星」时，**最多**在设备本地保存**一个布尔值**（如
  `localStorage["ailearn.companion.auth-surface.hidden"] = "true" | "false"`）。
- 不关联 user / workspace、登录标识、错误历史或学习数据；不写任何持久表；
  清除站点数据即可移除；不做服务端偏好持久化。

## 5. 未登录角色零 Provider（§13.3）

- 未登录（auth-surface）角色的伴星不依赖 authenticated API，也不依赖任何模型 Provider；
  全部能力来自随构建签名的静态 manifest 与通用错误码，本地即可渲染。

## 6. 验收

- `packages/shared` 与 `apps/api` typecheck 通过。
- `GET /public/auth-surface-manifest` 不鉴权返回签名 manifest（含 `testMode` 标注）。
- manifest 中所有 `visibleEntityRefs` 为空；构建时传入非空/模型字段直接 fail closed。
- 凭据页输入值及字段交互元数据零采集红线成立（见 §3）。
