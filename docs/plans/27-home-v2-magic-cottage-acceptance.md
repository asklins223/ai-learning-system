# Home V2 魔法小屋验收记录

> 状态：CURRENT_EVIDENCE · 预览验收记录（`VITE_HOME_SCENE_VARIANT=v2`），不改变 `implementation-freeze`
> 文档版本：v1.0
> 日期：2026-09-11
> 适用范围：Home V2 首页的权威验收视口矩阵、证据位置、相对原始计划的偏离，以及仍然诚实的缺口
> 上游设计：[Design System：理解书房 Desktop V1 + Home V2 Preview](../../DESIGN.md)
> 上游产品：[Product：Home V2 预览覆盖合同](../../PRODUCT.md)
> 上游动效合同：[桌面场景、伴星与 GSAP 动效合同（MOTION-01）](../design/desktop-scene-companion-and-gsap-motion-contract.md)
> 证据根目录：`.impeccable/review/home-v2/`（每个场景一份 PNG 截图与一份同名 JSON 合同快照）
> 可执行校验：`apps/desktop-client/src/shared/window-geometry.ts` 的 `homeWindowSizeProblems()`；截图脚本 `apps/desktop-client/scripts/capture-home-v2.mjs` 的 `assertFixedRatioSize()`

---

## 1. 权威验收视口矩阵

Home V2 的验收尺寸不是设计偏好，而是原生窗口的能力边界：`src/main/index.ts` 用 `HOME_WINDOW_MINIMUM_SIZE` 设置 `minWidth / minHeight`，并用 `window.setAspectRatio(HOME_WINDOW_ASPECT_RATIO)` 锁定 `1672:941`。任何验收矩阵都只能是这两个约束的交集。

| 场景 | 原生内容尺寸 | 系统缩放 | 有效 CSS 视口 | 验收对象 |
|---|---:|---:|---:|---|
| 宽屏基准 | `1440×810` | 100% | `1440×810` | 完整空间房间：八物件、稳定帧、日夜、目录、故障回退 |
| 原生最小尺寸 | `1280×720` | 100% | `1280×720` | 原生最小值下无裁切、无横向/纵向溢出、聚焦相机仍全覆盖 |
| 缩放 125% | `1440×810` | 125% | `1152×648` | 仍留在完整空间房间，构图不漂移 |
| 缩放 150% | `1440×810` | 150% | `960×540` | 仍留在完整空间房间，命中区与文字不丢失 |
| 缩放 200% | `1440×810` | 200% | `720×405` | 跨入紧凑语义房间：四个区域入口与全屏目录承担全部操作 |
| OS 减少动效 | `1280×720` | 100% | `1280×720` | `prefers-reduced-motion: reduce` 解析为 `off`，Live2D 保留最后一帧 |

`1024×700` 不是验收尺寸，也永远不会是：它既低于锁定的 `1280×720` 最小值，又不在 `1672:941` 比例上（`1024 / 700 ≈ 1.463`，`1672 / 941 ≈ 1.777`）。产品运行时无法产生该窗口，截图脚本 `assertFixedRatioSize()` 也会直接抛错。把 `1024×700` 留在验收矩阵里等于要求一个不可达的产品状态；窄视口需求改由 150% / 200% 缩放与紧凑语义房间承担。

`homeWindowSizeProblems(width, height)` 把这两条规则变成可执行断言：合法尺寸返回空数组，低于最小值与偏离比例各返回一条人类可读的问题。`HOME_WINDOW_RATIO_TOLERANCE`（`0.002`）是唯一容差来源，截图脚本在 `apps/desktop-client/scripts/capture-home-v2.mjs` 中以同名常量镜像同一数值（脚本运行在 TypeScript 构建之外，因此以注释互相引用，避免静默分叉）。

## 2. 证据位置与场景名

证据由 `apps/desktop-client` 的 `npm run capture:home-v2` 生成（需要 `VITE_HOME_SCENE_VARIANT=v2` 构建、`OWNER_EMAIL` / `OWNER_PASSWORD` 与可用的 Electron）。脚本每次运行会清空并重建 `.impeccable/review/home-v2/`，因此目录内容始终属于同一次 capture bundle；`home-v2-trace.json` 记录 `capturedAt`、源码脏状态与构建哈希、宿主与运行时版本、全部场景，以及 `visualMatrixCoverage`。

| 场景组 | 场景名（`.impeccable/review/home-v2/`） |
|---|---|
| 首屏与稳定画面 | `home-v2-first-guide`、`home-v2-1440x810`、`home-v2-night-1440x810`、`home-v2-minimum-1280x720`、`home-v2-zoom-125`、`home-v2-zoom-150`、`home-v2-zoom-200` |
| 魔法目录 | `home-v2-catalog-1440x810`、`home-v2-catalog-zoom-200`（各自写出 `-top` 与 `-bottom` 两份截图，覆盖目录页眉与滚动到底） |
| 聚焦相机 | `home-v2-focus-{desk,shelf,window,rest}-{1440x810,minimum-1280x720,zoom-125,zoom-150}` |
| 真实投影观察 | `home-v2-projection-due`、`home-v2-projection-interrupted`（`injected: false`，只记录认证 Owner 投影自然出现的状态） |
| 伴星 | `home-v2-companion-live2d`、`home-v2-companion-motion-continuity`（原 `home-v2-companion-orb` 截图项已随 2026-09-16 orb 裁决删除，不再是验收项）（含 `dragRelease: no-snap`、归一化放置漂移与 `shelf->rest` 借位回归） |
| 动效模式 | `home-v2-motion-lite`、`home-v2-motion-off`、`home-v2-reduced-motion` |
| 故障回退 | `home-v2-before-context-loss`、`home-v2-webgl-context-loss`、`home-v2-d3-asset-failure` |

当前证据快照：`capturedAt = 2026-09-11T06:17:29.448Z`，`source.head = c1f6470`（工作树 `dirty`），运行时 `electron 43.4.1 / chromium 150.0.7871.224 / node 24.18.1 / darwin arm64`。目录页眉的动效模式与中断恢复入口属于同批 renderer 修订，需要在下一份 capture bundle 中一并留证；本记录的矩阵不因该批次而改变。

## 3. 相对原始计划的偏离与理由

1. **验收视口从 `1024×700` 改为 `1280×720` + 125% / 150% / 200% 缩放。** 理由见 §1：原生窗口按 `1672:941` 比例锁定且不小于 `1280×720`，`1024×700` 不可达。旧矩阵仍残留在 `docs/design/frontend-quality-gates-and-visual-regression-plan.md`、`docs/design/desktop-design-system-and-frozen-component-contract.md`、`docs/design/first-golden-slice-product-and-ux-spec.md`、`docs/design/static-asset-production.md` 与两份 guideline / snapshot 文档中，属于待统一的跨文档扫尾（见 §5）。
2. **伴星拖动语义改为“归一化脚点锚点 + 松手不吸附”。** 原始计划写的是“松手后吸附到最近区域”；吸附会把用户刚刚放下的位置再挪走，破坏直接操作的可预期性。现行为：拖动只写入归一化脚点锚点，该锚点拥有位置控制权，释放即定格，并在窗口尺寸、系统缩放与形态切换后重新投影。
3. **提示借位规则显式化（借位必归还）。** 低优先级（`ordinary`）提示永不移动伴星；高优先级提示可以临时走到目标区域，但必须在提示结束后归还用户脚点锚点，且不得改写、覆盖用户放置。
4. **动效模式入口从房间控制岛移到魔法目录页眉。** Home V2 稳定画面不出现四岛，低频设置必须有唯一入口；目录页眉因此同时承担 Full / Lite / Off、总静音与未完成任务恢复。系统 `prefers-reduced-motion: reduce` 仍是最高优先级并解析为 `off`。
5. **中断恢复入口落在魔法目录内。** 未完成的学习运行与未完成的学习卡生成都从目录内恢复，且只进入真实链路，不伪造进度、结果或权限。
6. **伴星语音范围收敛为短促合成提示。** 只在关键提醒与用户显式唤醒伴星时发声，受总静音开关约束；语音服务不可用时静默降级，文本与操作路径保持完整。

文档收敛结果：`MOTION-01` 已按上述 1 / 2 / 3 / 4 修订（§4.1、§6.2、§8.3、§9.1、§11.3、§12.1 与文件头的预览同步记录），因为这些条款在该合同内原本写作“伴星只在已登记安全锚点间移动”与“四岛承担动效与声音变更”，与预览首页的直接拖动和目录入口冲突。`docs/design/2d-learning-room-motion-design.md` 无需修改：该文件自述为 `PARTIALLY_SUPERSEDED · NON_EXECUTABLE_REFERENCE`，其 §9.2 / §9.3 只把 `full / lite / off`、reduced motion 与声音偏好交给 `MOTION-01` 裁决，未规定动效模式入口表面，也没有禁止提示移动用户放置的伴星，因此与上述行为不构成冲突。

## 4. 由单元测试而不是截图覆盖的状态

截图脚本刻意不注入投影 fixture（`visualMatrixCoverage` 的 `projection.loading` / `projection.empty` / `projection.degraded` 因此保持 `not-observed`，理由写在 trace 里）。这些状态没有截图是有意为之：它们不是可稳定复现的真实认证投影，用假 fixture 截图会伪造产品状态。覆盖改由纯呈现逻辑的单元测试承担：

- `apps/desktop-client/src/renderer/src/app/home-presentation.test.ts`：`projection.loading`（阻塞加载不虚构空房间）、`projection.empty`（`noteCount` / `objectiveCount` 保持 `null`，不把未知当 `0`）、同步失败且无缓存投影、聚焦区自身 `error` + 缓存投影的 `retry` / `degraded`、以及“有缓存 + 刷新失败”的降级但可用输出。
- `apps/desktop-client/src/renderer/src/components/companion/companion-home-placement.test.ts`：五级提示优先级必须严格递增（`sync-error > interrupted-task > active-learning > due-review > ordinary`）。
- `apps/desktop-client/src/shared/window-geometry.test.ts`：§1 矩阵的可执行校验，含 `1024×700` 与 `720×480` 必须被拒绝。

`projection.due` 与 `projection.interrupted` 已由真实投影自然出现并通过 `home-v2-projection-due` / `home-v2-projection-interrupted` 留证；`loading` / `empty` / `degraded` 的截图缺口只由上述单元测试兜底，不得用注入 fixture 冒充证据。

## 5. 仍然诚实的缺口

- **投影状态无截图证据。** `projection.loading` / `projection.empty` / `projection.degraded` 依赖真实认证投影自然出现；当前 bundle 未观察到，只有 §4 的单元测试覆盖。若未来需要像素级证据，必须先定义“可合法注入且不伪造领域状态”的投影 fixture 合同，再改脚本。
- **伴星语音缺少真实服务/打包运行证据。** 桌面端当前已实现短提示 TTS、总静音/任务静默和 Live2D 口型采样；本次没有启动 API/TTS provider，且烟测因后端不可用停在工作区投影错误，因此这里只以类型检查、单测和构建为证据。
- **旧矩阵的跨文档扫尾未完成。** `docs/design/frontend-quality-gates-and-visual-regression-plan.md`（含 §「最小桌面 = 1024×700」矩阵行）、`docs/design/desktop-design-system-and-frozen-component-contract.md`、`docs/design/first-golden-slice-product-and-ux-spec.md`、`docs/design/static-asset-production.md`、`docs/design/frontend-ui-refactor-guideline.md`、`docs/design/2-5d-learning-room-master-guideline.md` 与 `docs/design/desktop-visual-ui-implementation-snapshot.md` 仍按 `1024×700` 描述验收或历史证据。本次只纠正 `DESIGN.md`、`PRODUCT.md`、`MOTION-01` 与本记录；其余文档需要一次显式修订，不能继续引用不可达尺寸。
- ~~**`MOTION-01` §8.1 的“V1 默认 adapter 是 orb”与预览首页的 Live2D 默认**……~~ **2026-09-16 已收敛**：`MOTION-01` §8.1 现写明唯一 adapter 是窗口内 Live2D（orb 已移除），首页与任务面同形；剩余约束只有许可与打包 Gate。
- **目录页眉新增入口的证据待补。** 动效模式与中断恢复入口进入目录页眉后，目录场景截图需要重新采集，才能证明“单一低频入口表面”在真实打包画面里成立。
