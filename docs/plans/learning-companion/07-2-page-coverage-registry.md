# 决策记录 07-2：全路由 coverage registry 与 context/action manifest（§5.4.4+§5.4.6）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-2
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-2（原方案 §5.4.4 + §5.4.6）
> 约束级别：router 与 `CompanionPageCoverageRegistryV1` 100% 对账；credential/跨 workspace 泄漏与来源伪装为 0；未分类/隐式继承/manifest hash 失效在 CI/启动失败。

## 1. 目标

为 public-auth 与 authenticated 全路由交付 `CompanionPageCoverageRegistryV1`：
每个可路由页面声明 surface mode、sensitivity、context/action manifest（allowlist +
forbid），并保证任何新路由/内容变更都会在 CI/启动被对账拦截。

## 2. 决策

### 2.1 `CompanionPageCoverageEntryV1` 结构

```text
routePattern      路由模式（"/login"、"/sources/:id"，:name 匹配单个路径段）
pageKind          页面类别（冻结清单 COMPANION_PAGE_KINDS）
access            public-auth | authenticated
surfaceMode       四种 surface mode（见 2.2）
sensitivity       normal | private | credential（复用 PageCompanionContextV1 语义）
manifestVersion   该 entry manifest 语义版本（内容变化必须递增）
manifestHash      内容指纹（fnv1a:<hex>；失效 → CI/启动失败）
actionAllowlist   该页面允许的上下文动作（§5.4.6 职责矩阵 allow 侧）
forbiddenActions  该页面明确禁止的动作（§5.4.6 职责矩阵 forbid 侧）
requiredCapabilities 该页面所需能力旗标（manifest 内容）
manualFallbackTestId 无自动化覆盖时的手动测试兜底 ID（E2E-*）
owner             web | backend | shared-contracts
inheritsManifestFrom 显式继承父 manifest 的 pageKind
```

### 2.2 四种 surface mode（01-6「四种 surface mode」冻结）

| surfaceMode | 语义 | 使用页面 |
| --- | --- | --- |
| `static_help` | 只提供静态帮助，无锚点/召唤/角色 | SSO callback、账号安全/密钥/成员、admin、404/离线 |
| `transitional` | 认证页的轻量状态说明（静态，无角色交互） | login/register/forgot/invite/verify/mfa |
| `silent_anchor` | 安静锚点 + 手动召唤面板（标准可交互页面） | 首页、内容、卡片、Review/此刻、星图、搜索、设置等 |
| `panel` | 召唤面板（formal/工作台等需要更完整表面） | 全屏验证、工作台结果、共学工作台 |

Global Shell 启用且 surface 未命中 hide/hidden/off 时，registry 内可交互页面必须有
与 surfaceMode 一致的稳定召唤入口；隐藏/关闭时页面不显示锚点，只保证普通帮助、设置
或全局命令中的重新启用入口可达（QuietAnchor 已实现该语义）。

### 2.3 页面职责矩阵数据化（§5.4.6 完整表）

每类页面的职责以数据形式落在 `actionAllowlist` / `forbiddenActions`，单测用
`PAGE_DUTY_MATRIX` 断言逐类核对：

- 注册/登录/找回账号：解释公开能力/无障碍/确定性登录故障；禁读凭据/观察输入/建画像/麦克风；
- 首页/空 workspace：开始或恢复引导、选择示例、说明添加第一份材料、恢复暂停任务；禁强迫上传/自动创建/把 onboarding 做成待清任务；
- Source/Note：说明页面、朗读选区、定位证据、展示已发布 Card；禁未绑定 target 无界问答、解释直接发布 canonical Card、读未授权材料；
- Card/Key Point：一起学习、让我试试、查看证据、前往星图；禁 formal 前泄答案/rubric、替用户开始验证；
- 全屏验证（formal）：朗读操作/切换模态/可信交接/停止；禁泄答案/提示/代做/代提交/参与评分；
- Review/此刻：解释推荐、缩短、换一条、稍后、自由漫游；禁债务/红色逾期/静默延期/自动开始；
- 理解星图：聚焦/切透镜/铺路/恢复视口；禁自由创建共享关系、把 Scene 连线发布为图真值；
- 共学工作台：朗读操作/切换模态/一起学习/可信交接/停止；禁 formal 中提示/代做/代提交/参与评分；
- Episode 结果：解释真实变化/返回来源/可选查看星图/用户确认继续；禁夸大掌握/自动续题/庆祝动画掩盖边界；
- 搜索/无结果：缩小合法范围、解释无结果、引导添加或选择已有内容；禁编造/跨权限检索；
- 导入/生成：按确定性 job 状态解释进度；禁虚构百分比/承诺未完成产物/动画伪装进度；
- 设置/隐私/历史：解释选项影响、定位控制项、预览导出/删除范围、重播引导；禁自动改偏好/代确认/导出或删除；
- 账号/安全/成员/权限/密钥/MFA：仅签名静态 allowlist 解释；禁运行模型/语音、观察字段或交互元数据、读成员/密钥值、代授权或改变权限；
- 404/离线/降级：解释已保存状态与可恢复步骤；禁把系统故障表现成用户失败、阻塞原页面 fallback。

### 2.4 继承规则（fail closed）

- 子路由只有 **sensitivity 与 action manifest（allowlist + forbidden）与父完全相同时**
  才可显式 `inheritsManifestFrom` 继承；否则必须提供自己的 manifest；
- 子路由与父 manifest 完全相同却**未显式声明**继承 = 隐式继承 → 校验失败；
- 当前显式继承对：`source-detail ← library`、`note-detail ← note-list`、
  `review-schedule ← review`（allowlist/sensitivity/forbidden 完全一致）。

### 2.5 manifest hash（CI/启动失败）

- `manifestHash` 是对 entry manifest 规范化内容的稳定指纹（跨平台纯 JS FNV-1a，
  键序固定、数组排序；非密码学签名——凭据页静态签名由 02-5 HMAC 体系负责）；
- 构建时由 `coverageEntry()` 自动生成；`validateCoverageRegistry()` 与独立校验函数
  在任何内容变化后重新计算并比对，不一致即抛 `CoverageRegistryValidationError`。

### 2.6 router 100% 对账

- 对账以 apps/web/app 下全部 `page.tsx` 展开的真实路由为基准（忽略 route group，
  `[param]` 转 `:param`；`(workspace)/(internal)/benchmark` 的实际 URL 是 `/benchmark`）；
- 方向 A：每个真实路由必须被至少一个 entry 覆盖（未分类 → 失败）；
- 方向 B：registry 中无 `manualFallbackTestId` 的具体 entry 必须命中真实路由；
  尚未实现但规范要求覆盖的路由类别（forgot-password、invite、verify、mfa、
  SSO callback、key-point、results、import、generate、隐私/历史/账号安全/成员/密钥、
  co-study、episode-results、404、offline、admin）以 `manualFallbackTestId` 声明
  手动测试兜底。

## 3. 实现

| 文件 | 内容 |
| --- | --- |
| `apps/web/lib/learning-companion/page-coverage-registry.ts` | entry/registry 类型、四种 surfaceMode、bounded action enum、manifest 指纹、37 个全路由 entry、6 个校验函数族、查询 helper |
| `apps/web/lib/learning-companion/page-coverage-registry.test.ts` | 数据完整性、页面职责矩阵逐类断言、继承/hash 失败场景、router 100% 对账、匹配单元（33 项） |

## 4. 验收

- router 与 `CompanionPageCoverageRegistryV1` 100% 对账（真实路由全覆盖、
  registry 具体页面都被真实路由命中）；
- credential 页零采集与跨权限动作（read_credentials/cross_permission_search 等）
  不在任何 allowlist 中；
- 未分类/隐式继承/manifest hash 失效/forbidden∩allowlist 冲突均在测试阶段失败。
