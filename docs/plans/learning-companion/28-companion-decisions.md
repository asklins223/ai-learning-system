# 决策记录 28：伴星形态、定位与存在感（Owner 已裁决）

> 状态：**已裁决（2026-09-16）**，实现按本文执行
> 前置：一次以代码为准的全系统伴星审计（结论见 §四"已修复勘误"）
> 说明：本文取代此前的 `28-companion-open-decisions.md`（同一编号，内容合并）。四条冲突已由 Owner
> 选定方向；实现侧以本文为唯一依据，不再引用互相矛盾的两份旧表述。

---

## 一、裁决 1：伴星只保留 Live2D，彻底移除 orb

**决定**：删除 orb 形态（不保留"低干扰默认形态"角色）。**Live2D 加载失败时不回退立绘或光球，而是隐藏形象并就地给一句可关闭的说明。**

### 受影响面（实测，非推测）

| 层 | 位置 | 处理 |
| --- | --- | --- |
| 渲染状态 | `apps/desktop-client/src/renderer/src/app/room-store.ts`（`CompanionForm = "orb" \| "live2d"`、`companionForm`、`setCompanionForm`、持久化字段） | 删除形态概念（只剩一种形态，不再需要状态与持久化） |
| 呈现组件 | `components/companion/CompanionPresence.tsx`（形态切换按钮、`live2dPreferred`、`renderedCompanionForm`、orb 浮动动画、`rendererLabel`、`data-form`） | 删除切换与 orb 分支；失败态改为"隐藏 + 可关闭说明" |
| 渲染宿主 | `components/companion/WindowLive2D.tsx`（`data-companion-renderer`、orb `<img>` 回退） | 只保留 Live2D；不可用时渲染空（不渲染替身） |
| 资产契约 | `components/companion/window-live2d-contract.ts`（`fallbackOrb`、`fallbackMao`、`shouldUseWindowLive2D`） | 三者全部删除；`mao-half-idle-v1.png` 替身图与 `WindowLive2D` 的替身 `<img>` 分支同批移除——任务页改为保留**原地待机动作**（见本文件 §四追加裁决），失败时只给可关闭说明 |
| 资产包 | `assets/learning-room/v1/manifest.json` 的 `companion` 条目（`STATIC-COMPANION-ORB-01`，含 sha256）、`objects/companion-orb.webp`、`media/learning-room-manifest.ts` 的 `addAsset(..., "companion", ...)` 与 schema 字段 | 删除条目、删除资源、删除代码引用（校验器会检查"条目↔文件"一致性，必须同步） |
| 冻结文档 | `docs/design/static-asset-production.md`（§242/§376：默认 adapter = 无脸 orb；苏醒/确认输入图）、`desktop-scene-companion-and-gsap-motion-contract.md`（MOTION-01 默认 orb）、`frontend-ui-refactor-guideline.md`（§10.1 两形态、§21.2 只验收 orb） | 按本裁决改写默认形态与失败行为 |
| 产品/设计口径 | `PRODUCT.md`、`DESIGN.md`、`first-golden-slice-product-and-ux-spec.md`、`desktop-frontend-capability-migration-contract.md`、`desktop-visual-ui-implementation-snapshot.md`、`2-5d-learning-room-master-guideline.md`、`2d-learning-room-motion-design.md`、`desktop-design-system-and-frozen-component-contract.md` | 凡断言"默认 orb / 失败回退光球"的段落按本裁决更新，或在历史快照类文档加取代说明 |
| 复核补漏（2026-09-16 复扫） | `static-asset-production.md`（§29/§166/§170/§188 仍写默认 orb 与"保留合法 orb"）、`desktop-frontend-capability-migration-contract.md`（`LIVE2D-DISTRIBUTION-01` 写"未通过时只发布 orb fallback"、`PRODUCT-TRUTH-01` 状态）、`desktop-scene-companion-and-gsap-motion-contract.md`（§8.1 `OrbPresenter` 仍在 presenter 清单）、`first-golden-slice-product-and-ux-spec.md`（`GS-COMPANION-01` 写"只验收 orb"）、`docs/plans/27-home-v2-magic-cottage-acceptance.md`（`home-v2-companion-orb` 截图项）、`3d-learning-room-design.md` 与 `3d-learning-room-asset-inventory.md`（统一覆盖声明补 orb 作废句）、`assets/learning-room/v1/PROVENANCE.md`（orb 仍写成 rendering fallback）、`PRODUCT.md`（"任务页静态半身立绘"已不存在） | 全部按本裁决改写；3D 归档文档保留历史表但由横幅覆盖；仅 `docs/plans/learning-companion/15a`、`16-audit-20260814` 作为历史记录保留 orb 字样 |
| **不动** | `assets/3d/learning-room/v1/**`（`companion-orb.webp`、`companion-orb-lod*.glb`）与其 manifest | 属已归档的 3D 学习房间资产管线，不是伴星形态；修改会破坏该资产包校验与历史证据 |

### 已知代价（需接受）

1. **Golden Slice 视觉验收项反转**：原「只验收低干扰 orb + 正式作答静默」改为「Live2D + 失败可关闭说明 + 正式作答静默」，需要重跑一次该场景证据。
2. **onboarding 苏醒/确认媒体**：`static-asset-production.md` 把 `STATIC-COMPANION-ORB-01` 用作这些媒体的输入图（该资产本身为 `RELEASE_BLOCKED`，缺 provenance/release sidecar）。改为 Live2D 后这些媒体的输入图需另行确认，属独立缺口。
3. **许可面收窄**：orb 是自产图（发布受阻），Live2D Mao PRO 为 `commercialReleaseAllowed=true`、`redistributionAllowed=false`。删除 orb 后伴星只有一条呈现路径，**它对资产许可成为单点依赖**，发布前必须维持许可复核。

---

## 二、裁决 2：伴星定位＝呈现层（不接入 Agent 能力）

**决定**：伴星**停在呈现层**。明确不接入对话、记忆、提议（typed proposal）、学习动作桥与工具页。

**这意味着**：
- 不做 Gate 5「伴星完整接入」，也不做 doc 16 的 P0–P9 桌宠重构；
- 服务端已实现的对话/记忆/交付/提案/旅程能力**保留在服务端**（它们有独立的产品价值与其他入口），但**不为伴星接桌面端通道**；
- 伴星可以做的事限于：形象与情绪表达、场景台词（客户端文案）、在场景间移动/让位、短语音提示、把用户送到既有页面（导航意图）。**不新增**任何业务写入能力。
- 与 MOTION-01「呈现层而非第二个 Agent」一致；doc 13/16 中"唯一伴星前台 + 真实对话/工具"的部分**不再作为目标**。

**仍然必须遵守的边界**（与形态无关）：同一个身份、任务时安静、正式作答全程静默且不给知识提示、只按真实回执说话、伴星故障不影响学习。

---

## 三、裁决 3：presence＝账号级 + 少量页面级

**决定**：以账号级为准（在线/勿扰/离线 + 安静/适中/活跃 + 静默时段 + 暂停建议/抑制，服务端已实现并已被 proactive-hook 真实读取），**另加三个页面级控制**：

| 页面级控制 | 语义 | 实现位置 |
| --- | --- | --- |
| 按页静音 | 在当前页面不主动出声/弹气泡 | 客户端（页面状态 → 抑制提示），随会话失效 |
| 专注到任务结束 | 进入任务后静音，直到该任务面关闭 | 客户端（复用既有 `surface` 生命周期） |
| 临时隐藏 | 立即隐藏伴星形象，保留一键恢复入口 | 客户端（复用既有 `presenceHidden` 链路） |

**不恢复**旧 web 的 8 状态表（`apps/web` 已删除，独立状态表会带来第二套真相）。账号级的可见/可改需要新增一条 IPC（当前桌面端只接了 4 条 companion 通道），列入实现待办。

### 实现落点（2026-09-16 完成，可核对）

| 层 | 落点 |
| --- | --- |
| 通道 | `companion.account.getState`（`GET /me/companion`）/ `companion.account.patchState`（`PATCH /me/companion`，`revision` CAS）；shared 契约 + preload `companion.account` + main handler/output schema 三处同批落地 |
| 账号级三项 | 在线/勿扰/离线、安静/适中/活跃、静默时段（含设备时区）；面板内 `.companion-account-controls`，写入冲突**不自动重放**，先重读再由用户确认 |
| 账号级关闭 | `globalEnabled=false` 时形象不出现，就地给"重新开启伴星"入口；**读不到状态不算关闭**（`companionAccountDisabled` 只在读到 `false` 时为真） |
| 页面级三项 | `.companion-presence-controls`：按页静音 / 专注到任务结束（任务面关闭自动解除）/ 暂时隐藏；均为会话状态，不进 `partialize` |
| 契约同步 | `docs/design/desktop-frontend-architecture-and-ipc-contract.md` §4.4 / §6.1 / §11.2 / §14.3 + 修订记录新增两行 `[AUDIT-FACT]` |
| 证据 | `desktop-ipc-companion.test.ts`（通道参数、空改动/非法枚举/未知字段 `invalid_request`、overview 漂移 `unsupported_contract`）、`companion-account-presence.test.ts`（选项取值与 patch 形状）、`room-store.test.ts`（真实写盘 payload 不含三项页面级状态） |

---

## 四、追加裁决：任务页继续播放原地动作（2026-09-16）

**决定**：任务页（阅读/写作/整理，即 `task_quiet`）**不冻结** Live2D 当前帧，保留**原地**待机动作（低幅呼吸与眨眼），仍然不位移、不出气泡、不隐藏标签之外的额外呈现；正式答题（`assessment_silent`）维持静止与静默。

这**推翻了本轮早前的实现**：当时按 `frontend-ui-refactor-guideline` §10.2 的"阅读、写作时静止"把任务页做成 `paused={presencePaused || companionVisualOnly}`（冻结当前帧 + 静态替身）。现在 `paused` 只由 `presencePaused`（隐藏 / 弹窗 / 窗口不可见）与用户自己的 `motionMode`（lite/off）、系统 reduced-motion 决定。

| 面 | 处理 |
| --- | --- |
| 代码 | `CompanionPresence.tsx`：`paused={presencePaused}`；任务页仍禁用拖动与主动输出（`.companion-surface-label` 保留） |
| 指引 | `frontend-ui-refactor-guideline.md` §10.2：阅读/写作改"缩小 + 原地待机 + 隐藏标签"，正式答题保持静止 |
| 动效合同 | `desktop-scene-companion-and-gsap-motion-contract.md` §8.2 `task_quiet`：改"缩小、原地待机、隐藏标签"，禁止事项补"在任务面位移或弹气泡" |
| 2D 动效设计 | `2d-learning-room-motion-design.md`：原"编辑/答题：静止，不呼吸、不闪烁"拆成"编辑/阅读：原地待机"与"正式答题：静止" |
| Golden Slice 规格 | `first-golden-slice-product-and-ux-spec.md` §6.2：窗景与环境声仍停止，伴星改"原地待机" |

**遗留**：原地动作的实际幅度/频率需要在实机（Electron + calibrated idle Token）看一眼；本会话只验证到类型、测试与构建，没有截图证据。

---

## 五、已修复勘误（事实基准，独立于上述裁决）

| 项 | 处理 | 依据 |
| --- | --- | --- |
| 服务端"已具备 Live2D 角色驱动、精灵图回退" | 删除该表述：服务端只下发语义情绪 cue；Live2D 参数与映射在客户端；Sprite 只有合同无实现 | `PRODUCT.md`；`identity/capability-projection.ts:63-65` |
| `ask_grounded_tutor` / `propose_memory_candidate` | 从契约删除（无 producer/分支缺失；后者要求服务端生成的 id，不可满足） | `companion-conversation-contracts.ts` |
| `proactive_cue` delivery kind | 删除（无生产者），历史行归一并收紧库约束 | 迁移 `0224` |
| `assistant_deliveries.kind` 缺 `memory_candidate` | 修复（此前 worker 抽取写入即触发 CHECK 违例、事务整体回滚） | 迁移 `0224` + kind 单一事实来源 + 对账测试 |
| 3 个死开关 | 删除并新增双向 capability 门禁 | `verify-companion-capability-config.mjs` |
| 审计导出分页 µs/ms 精度不匹配（重复读到 5 万行、85s） | 游标改为 µs 精度行比较（~30ms） | `companion-shell/audit-service.ts` + 回归测试 |
| `docs/feature-flag-inventory.md` 与代码不符 | 按代码重写 | 同上 |
