# 统一学习运行与 Live2D 系统伴星 UI 重绘总记录

> 日期：2026-08-13  
> 状态：**UI 重绘已完成；后端底座（P0 合同 + P2 LearningRun 数据/API/outbox）已实施；production 前端接线与 P3–P9 未开始**  
> 产品与实施底稿：[16-unified-learning-run-micro-journey-live2d-system-companion.md](./16-unified-learning-run-micro-journey-live2d-system-companion.md)  
> 分项记录：[LearningRun UI](./17-learning-run-ui-redraw-implementation-record.md) · [理解星图行动面](./18-understanding-graph-action-ui-redraw-record.md)  
> 停止边界：完成主要页面/表面、开发态状态原型、响应式和代码质量验收后暂停；不进入 API、数据库、Assessment、Commit、Projection、Electron Bridge 或生产切流。

---

## 1. 本轮交付结论

本轮已经把方案二的 `LearningRun / Task / Artifact / Assessment` 产品语义和方案三的“三分钟微旅程”落实为主要 UI contract 与可交互样机，并保留现有 **Mao PRO Live2D 桌宠**作为唯一目标前台形态。真实 PetSurface 与 Journey runtime 尚未接线。

已完成的 UI contract / preview 表面：

1. 首用页面兜底与桌宠首邀样机；
2. 今日学习与学习动态中的下一步；
3. 学习卡详情的三分钟巩固入口；
4. 到期复习队列；
5. 统一 `LearningRunPlayer` 及全状态、全结果 UI；
6. 理解星图的节点行动面与 Run 返回显影状态；
7. Live2D 桌宠从首邀到结果收尾的旅程状态样机；
8. 对话历史页的只读档案式重绘。

来源资料页和笔记编辑页本轮有意保留为原生内容工作区，不复制伴星头像、聊天框、引导卡或侧栏。后续由桌宠通过受控命令打开/定位它们，而不是再造一套 AI 页面。

主应用页面中没有新增伴星头像、聊天输入框、AI 侧栏或右侧面板；历史页也不是第二个实时伴星，只负责读取、检索和审计当前已经载入的记录。

---

## 2. 页面与表面实施清单

### 2.1 首用、今日学习与原生入口

#### 首页首用恢复

- `apps/web/components/study/OnboardingGuide.tsx`
- `apps/web/app/styles/onboarding-guide.css`
- `apps/web/app/(workspace)/(default)/page.tsx`

旧六项“任务债务清单”现在只在真正空工作区作为首用兜底；已有笔记或学习卡的账户不再显示可能与页面事实矛盾的旧进度。该入口不绘制伴星人格，也不冒充桌宠旅程已接线。

#### 今日学习 / 学习动态

- `apps/web/app/(workspace)/(default)/page.tsx`
- `apps/web/app/(workspace)/(default)/today/page.tsx`
- `apps/web/app/styles/today.css`

开发态下一步可进入明确、可停止的微旅程样机；生产旧链路仍使用保守文案，不承诺尚未接线的多模态能力。平板与手机单栏会把下一步置于长账本之前。

#### 学习卡入口

- `apps/web/components/learning-companion/LearningCardActions.tsx`
- `apps/web/app/(workspace)/(focus)/cards/[id]/page.tsx`
- `apps/web/app/styles/card-detail.css`

开发态主 CTA 使用“三分钟巩固”并进入统一 Player 原型；生产仍保持旧链路，并恢复为“巩固这项理解”的保守文案，不承诺未接线的语音、操作或三分钟结果。

#### 复习队列

- `apps/web/app/(workspace)/(default)/review/page.tsx`
- `apps/web/app/styles/review-v06.css`

`?uiPreview=full` 在 development 提供预计时间、可换方式与结果边界的脱敏样例；生产队列仍保持当前中性说明与旧入口，真实 feature flag 和 writer 未被绕过。

### 2.2 统一 LearningRunPlayer

- `apps/web/features/learning-run/contracts.ts`
- `apps/web/features/learning-run/demo-fixtures.ts`
- `apps/web/features/learning-run/player/*`
- `apps/web/features/learning-run/renderers/*`
- `apps/web/features/learning-run/demo/LearningRunRedrawLab.tsx`
- `apps/web/app/(prototype)/learning-runs/ui-redraw/page.tsx`
- `apps/web/app/styles/learning-run.css`

同一个 Shell 已覆盖：

- `preparing / active / assessing / checkpoint / committing / paused`；
- `completed / recoverable_error / stale / ended / skipped / cancelled`；
- text、voice teach-back、ordering、repair、choice-with-rationale、scenario、relation 七类 renderer；
- 语音的 idle / listening / transcribing / ready / error；
- 换方式、提示降级、跳过、声明不会、暂停、结束与重试；
- demonstrated、partial、needs repair、not assessable、practice completed、skipped、declared unable 七种结果；
- created / rescheduled / none 三类复习影响。

正式输入期间没有伴星 UI；Assessment 和 Commit 未完成前不会提前显示“已掌握”或“已安排复习”。

### 2.3 理解星图行动面

- `apps/web/app/(workspace)/(default)/graph/page.tsx`
- `apps/web/app/styles/understanding-graph.css`

保留真实 graph API、Canvas、搜索、筛选、图层与 lineage，在选中 Card / Key Point 后增加原生行动区：

- 发起三分钟练习；
- 比较相邻概念；
- 沿真实 Source → Note → Card → Key Point 回溯证据；
- 预览三步学习路线；
- 展示 `delta / pending / practice / none` 四类 Run 返回状态。

页面不使用伴星头像或聊天框。当前路线与返回状态是 development-only UI contract；没有创建 Run、写 Projection 或在客户端推断掌握度。

### 2.4 Live2D 桌宠系统旅程

- `apps/web/features/companion-pet/journey/pet-journey-contracts.ts`
- `apps/web/features/companion-pet/journey/pet-journey-fixtures.ts`
- `apps/web/features/companion-pet/journey/PetJourneyPresentation.tsx`
- `apps/web/features/companion-pet/journey/PetJourneyRedrawLab.tsx`
- `apps/web/app/(prototype)/companion/pet/ui-redraw/page.tsx`
- `apps/web/app/styles/pet-journey.css`

现有 `PetCharacterCanvas`、Live2D driver、模型清单和角色身份被完整保留；没有换成页面内头像。开发态故事页现覆盖 20 个关键画面，包括：

- 一次性首邀、三步偏好与资料 waiting / processing / ready / failed / retry；
- LearningRun 提议、typed action 确认、执行与回执；
- demonstrated / partial / practice / skipped / declared unable / not assessable 结果；
- 可恢复错误、正式作答静默与 DND 状态。

首邀包含“用我的资料走一遍 / 体验 90 秒示例 / 我先自己看看”三个同级入口，以及低强调的“稍后”；不会抢焦点或自动导航。故事页中的正式作答和 DND 帧不渲染 Journey 卡；真实 PetSurface 硬抑制仍待 runtime 接线。390 / 768 / 1440 下均保留同一 Live2D 身份，低动效样机收敛为 idle，驱动级停帧仍明确延后。

### 2.5 对话历史档案

- `apps/web/features/companion-history/history-model.ts`
- `apps/web/features/companion-history/history-fixtures.ts`
- `apps/web/features/companion-history/CompanionHistoryArchive.tsx`
- `apps/web/app/(workspace)/(default)/companion/conversations/page.tsx`
- `apps/web/app/(workspace)/(default)/companion/conversations/conversation-page.css`

旧页面已重绘成桌宠唯一身份下的只读档案，而不是另一个聊天产品。生产界面只称“已载入的交互记录”，不再用“完整”掩盖当前 50 段 / 每段 100 条的读取上限：

- 对话索引、标题搜索、当前记录搜索及日期 / Run / 来源筛选；
- dialogue / voice / proactive / action & result / issue & recovery 类型筛选；
- confirmed voice transcript；
- proactive cue、action ref、result ref、route、error、recovery；
- 时间线、来源/Run 引用和保守的行动状态；未知 action/result 不显示成功，recovery 只显示“说明已记录”；
- 更早记录的分页 UI；
- 空态、加载态与错误态。

页面刻意没有 composer、新建对话、发送按钮或第二套角色头像。历史 Markdown 不自动加载远程图片且整体降级标题；内部 route 只使用受控路径。导出、删除与召回桌宠只画出禁用的“待接线”位置。生产继续读取现有对话服务；结构化 block fixture 与“载入更早记录”交互仅用于 development 验收，真实 cursor pagination 仍待服务端/Hook 接线。

---

## 3. 统一产品语义在 UI 中的落点

### 3.1 主观题不再等于长文本框

`explain / example / apply / paraphrase` 只描述要证明的能力。用户可直接说、短写、排序、修复或用结构化操作完成；“换个方式”始终是一级操作，不产生负向记录。

### 3.2 Skip、声明不会、提示三者分离

- 先跳过：0 Assessment、0 mastery、0 schedule 副作用；
- 我确实不会：记录当前选择，结果不使用“通过/掌握”，也不在缺少授权时承诺自动改期；
- 请求提示：先明确降为 practice，再展示提示并继续作答，提交后才显示练习完成。

### 3.3 三分钟是预算，不是倒计时

所有界面只表达预计用时和当前阶段，不显示秒级倒计时、超时惩罚或速度评分；结算后默认结束，不自动续题。

### 3.4 学习真相只来自正式链路

页面、fixture 和伴星都不能自行判断 mastery、schedule 或星图变化。只有 Artifact 锁定、独立 Assessment、确定性 Commit 与 Projection 完成后，生产 UI 才能显示对应事实。本轮所有 development fixture 都带有清晰的“非账户数据 / 不写学习真相”标识。

---

## 4. 开发态验收入口

| 表面 | 地址 | 边界 |
| --- | --- | --- |
| LearningRun 状态实验室 | `/learning-runs/ui-redraw` | development-only；production `notFound()` |
| Live2D 桌宠旅程 | `/companion/pet/ui-redraw` | development-only；不连接 API、不写学习事实 |
| 对话交互档案 | `/companion/conversations?preview=full` | preview 仅 development；生产只展示当前读取链已载入的记录 |
| 复习队列样例 | `/review?uiPreview=full` | preview 仅 development |
| 星图 Run 返回 | `/graph?graphUi=delta\|pending\|practice\|none` | development-only query fixture |

所有原型路由和 query fixture 均 fail-closed；不得作为生产完成度或真实 E2E 的证据。

---

## 5. 响应式、可访问性与交互验收

### 5.1 浏览器实测

| 表面 | 实测视口 / 主题 | 核心检查 | 结果 |
| --- | --- | --- | --- |
| LearningRun | 1440×900、768×1024、390×844；day/night | 七类 renderer、提示后继续作答、草稿暂停恢复、移动首屏自主操作 | 通过 |
| Live2D Pet journey | 1440、768、390；night / 低动效 | 同一 Live2D、20 帧、长结果、失败重试、确认框键盘行为 | 通过 |
| 对话交互档案 | 1440、768、390 | 保守行动状态、精确筛选、移动选择器、无 composer、无横向溢出 | 通过 |
| 理解星图 | 1440、768、390 | 返回提示与详情衔接、可调路线/过期态、键盘星体列表 | 通过 |
| Card / Review / Today / Home | 静态合同与组件回归 | 原型承诺只在 development 出现；已有内容账户不再展示旧 onboarding 债务 | 通过；本次未重新执行浏览器检查 |

浏览器实测页面没有应用错误；LearningRun 开发态观察到 Fast Refresh reload warning，不计为生产验收通过的证据。

### 5.2 可访问性约束

- 全部一级操作使用原生 button / link，并具有可读名称；
- Skip、End、换方式一步可达，不用仅图标表达；
- voice 必须用户主动开启并确认转写；
- ordering / repair 不依赖拖拽，支持点选和键盘路径；
- assessment / error / result 使用 live region / status 语义；
- Journey 样机的正式作答静默与 DND 保留可读状态说明但不渲染卡片；真实 PetSurface 抑制仍待接线；
- 390px 无页面级横向溢出；
- reduced-motion 保留同一 Live2D 身份和关键信息，不切换第二角色。

---

## 6. 自动化验证记录

```text
apps/web npm run typecheck
→ passed

npx eslint features/companion-history features/companion-pet/journey
  features/learning-run prototype routes conversation route AppShell
  LearningCardActions --max-warnings=0
→ passed

npx vitest run
  CompanionHistoryArchive.vitest.tsx
  PetJourneyPresentation.vitest.tsx
  LearningRunPlayer.vitest.tsx
  LearningRunRedrawLab.vitest.tsx
→ 4 files / 38 tests passed

node --import tsx --test
  companion-pet/desktop/desktop-pet-adapter.test.ts
  learning-run/demo/demo-context.test.ts
  home-onboarding.test.ts
  card-detail-ui-contract.test.ts
  review-v06-ui-contract.test.ts
→ 26 tests passed

apps/desktop node --import tsx --test src/main-route-path.test.ts
→ 2 tests passed

apps/desktop npm run typecheck
→ passed

git diff --check
→ passed

apps/web npm run build
→ passed
```

Production build 仍报告两条本轮之前即存在的 `react-hooks/exhaustive-deps` warning，分别位于旧 Card companion 页面与旧 `VoiceTeachBackScene`；本轮新增/重绘目录的定向 ESLint 为 0 warning。

组件测试覆盖：

- LearningRun 题面、自主操作、文字原文、提示降级、结构化 payload、Assessment/Result 真值；
- Pet 首邀、偏好、提议、确认、结果、静默与 DND，且 Presentation 本身不渲染第二头像；
- 历史页 block adapter、安全链接、搜索、筛选、分页、无 composer 与只读边界；
- Card / Review 原生入口和夜间样式合同。

---

## 7. 本轮明确未实施

以下生产能力仍是下一阶段，不能从本轮截图或 fixture 推断已经完成：

1. 正式 shared `LearningRun` contracts、DB migration 与 `/learning-runs` API；
2. Artifact draft/lock、Assessment worker、Finalizer/Commit、Review generation fence；
3. Card / Review 生产 CTA 切流与旧 `ValidationFocus` / companion writer 删除；
4. Main ↔ Pet typed Context / Event / Command Bridge；
5. 注册成功后创建/唤起 Pet、Journey V2 CAS 持久化与跨设备恢复；
6. Pet proactive inbox、SSE、presence、delivery lease 与工具 gateway；
7. 星图 Projection checkpoint/delta、RoutePlan 和 viewport receipt；
8. 历史真实 cursor pagination、全量 session scope、结构化 message block 与动作审计接线；
9. 真实 API/RLS/幂等/竞态/Gold/性能/跨设备 E2E；
10. 生产数据迁移、切流、回滚与旧 UI 删除。

---

## 8. 暂停点

本轮已经完成主要 UI 重绘与本次复审发现的体验修补，包括此前体验最差的对话档案页面，并保留现有 Live2D 桌宠身份。真实生产接线、PetSurface Journey 与历史全量读取仍明确延后。

按照 Owner 指示，实施在这里暂停。下一次恢复时应从 **正式 LearningRun shared contract + 单一 Card text/voice 纵切 + Main ↔ Pet Bridge** 开始；不要继续扩写 fixture，也不要重新建立页面内伴星卡、右侧面板或第二聊天入口。

## 9. 后端底座实施登记（2026-08-13，P0+P2）

UI 暂停点后的第一次恢复按 §8 指示从后端开始。本节登记已实施与仍未实施的后端工作，作为后续恢复的权威起点。

### 9.1 已完成（P0 + P2 服务端底座）

| 工作 | 落点 | 状态 |
| --- | --- | --- |
| LearningRun V1 共享合同冻结 | `packages/shared/src/learning-run-contracts.ts`（§12/§13.1/§15 全类型 + zod strict schemas + 错误码 + envelope/practice trail/return contract） | 已实施；strict/negative 测试 20 条 |
| 旧语言收敛 | `learning-session-contracts.ts` TrustClass 改为 re-export（值域一致） | 已实施 |
| LearningRun 数据模型 | 17 张新表（`learning_runs`/`learning_run_private_contracts`/`learning_tasks`/`learning_task_variants`/private 三表/`learning_artifacts`/`learning_assessments`/`learning_task_drafts`/`learning_run_events`/`learning_run_action_ledger`/`learning_activity_leases`/`learning_task_presentation_history`/canonical+practice outbox/`learning_run_idempotency`）+ `learning_run_processing_outbox` | 迁移 0116/0117；RLS workspace+user 双条件；private 三表对 ailearn_api 仅 INSERT；draft 对 worker REVOKE ALL |
| `/learning-runs` API | POST create（幂等 PREPARE + 确定性规划）、GET snapshot（ETag）、SSE events、GET/PUT/DELETE draft（AES-256-GCM 静态加密 + CAS 行锁）、POST submissions（原子 lock+outbox）、POST actions（状态机 + 幂等账本）、GET result、GET return-contract、POST activity-lease | 已实施；`learning_run_v1` capability 门控（§22.2 原子切换单位） |
| Assessment/Commit 主链 | `run-processing-tick.ts`：assessment_requested → 确定性评估（declared_unable）/ fail-closed not_assessable；commit_requested → canonical_unable Commit（schedule 消费/创建 + 恰好一个 envelope） | 已实施（API 进程内轮询，与现有 commit-outbox 同模式） |
| 并发与幂等 | Run 行 FOR UPDATE、draft 行锁、幂等重放 requestHash 比对、outbox 租约两段式 claim、lease 服务端下界计费 | 三轮 review 通过（ship as-is） |

验证：`apps/api npm test` 3073 pass / 0 fail；shared/db/api/web typecheck 全绿；packages/db 测试通过。**真实 DB 集成与浏览器 E2E 未执行**（本环境无 postgres/docker），迁移 0116/0117 尚未在真实库应用。

### 9.2 已知差距（诚实声明，勿据此宣称完成）

1. ~~text/voice 的 `assessment_critic` 未接入真 Critic~~ → **已接入**（2026-08-13 续）：`run-critic.ts`（OpenAI-compatible + SSRF 防护 + strict 输出解析，env `ASSESSMENT_CRITIC_URL/KEY/MODEL`）；全部 covered 且无提示暴露 → demonstrated → canonical Commit（initial_validation/scheduled_review + correct advance 政策）；提示暴露 → practice_completed（0 canonical）；部分 → checkpoint(partial)；**未配置或输出非法仍 fail closed 到 not_assessable**（真实 Critic 的端到端效果需部署 provider 后 Gold 验证）；
2. ~~迁移 0116/0117 未在真实数据库执行过~~ → **已在 dev postgres 执行并验证**（表结构/RLS/权限契约/hash 记录一致）；追加迁移 0118（active 唯一约束）/0119（standby 枚举）/0120（private hash 冗余到 variant 行，保持 private 表对 ailearn_api 无 SELECT）/0121（SECURITY DEFINER claim/release/mark 函数，跨 workspace RLS 兼容）；
3. `finish_current_evidence`（partial）、`activate_followup`、`retry_*` 动作属 P4，当前 409 fail closed；
4. star_map / onboarding sandbox 入口 409 fail closed（P7/P6）；
5. projection/return-contract 的 checkpoint 语义未接（P7），当前 return-contract 只返回 `run_active`/`no_projection_change`；
6. 前端 api 接线已完成基础件（`features/learning-run/api/`：client 方法组、SSE 流订阅、`useLearningRun` hook），但 **LearningRunPlayer 尚未切换到生产 hook**（demo 仍用 fixture；切换属 P3 剩余工作）。

### 9.3 真实 DB 纵切验证（2026-08-13 续）

`npm run test:learning-runs:postgres`（dev postgres）3/3 pass：
- card 创建（active/standby 双 Variant、create_initial 授权、事件 created/prepared/started/presented）→ declared_unable 提交 → outbox tick → completed + 恰好一个 schedule（generation 1、1 天、canonical_unable）+ 恰好一个 envelope（fact=canonical_unable）+ 重复 tick 0 副作用；
- text + Critic 未配置 → fail closed checkpoint(not_assessable)，0 canonical / 0 schedule；
- submission 同幂等键重放 → 同一 receipt、不重复 lock。

### 9.4 P3 切流与 P5 Bridge（2026-08-13 再续）

**P3 生产接线完成**（`learning_run_v1` flag 原子切换）：
- 前端 `NEXT_PUBLIC_LEARNING_RUN_V1` flag（`lib/feature-flags.ts` isLearningRunV1Enabled）；
- `/learning-runs/new`（稳定幂等键创建 + redirect）与 `/learning-runs/[runId]` 生产路由（flag off 404 fail closed）；
- `LearningRunLivePlayer`：`useLearningRun` ↔ UI 合同桥接（`ui-adapter.ts` 纯函数：wire→UI 快照、UiIntent→wire 动作/提交，P4 结构化提交返回 none fail closed；ui-adapter 8 项单测）；
- Card/Review/Today 三入口 flag on 时切到 `/learning-runs/new`（review 携带 generation CAS——后端 sanitized 列表补充 generation 字段并更新泄漏白名单）；`LearningCardActions` 增加 live 文案。

**P5 Bridge 完成**（Electron broker + 服务端 hydration）：
- shared：Bridge V2 合同 + `computeContextRevisionV2`（子路径 `@ailearn/shared/companion-bridge-revision`，node:crypto 不进客户端 bundle）；
- 服务端：`assistant_page_contexts` 表（0122 迁移，RLS）+ `POST /companion/bridge/contexts`（publish：EntityRef 白名单归属校验、安全字段由认证 session 覆盖）+ renew（CAS）+ revoke（`COMPANION_BRIDGE_V2=true` 门控）；真实 DB 集成 2/2 pass；
- Electron：`registerCompanionBridgeBroker`（sender 校验、pageInstance 注册表、UI event 序号、in_page 命令 freshness 拒绝、命令回执 relay、窗口销毁清理）+ Main/Pet 两个 preload 窄接口（不暴露 channel/ipcRenderer）。

### 9.5 P4 结构 Task（practice 首发路径，2026-08-13 三续）

- **合同演进**：AssessmentPublic source 增加 `deterministic_structured`（§12.6 确定性方案的第三评估来源，0123 迁移）；TaskInteraction 的 ordering/relation/repair 增加 labels 可选字段（展示层，非答案承载）。
- **确定性生成器**（`run-structured.ts`）：ordering（claim 断句 → 哈希 id token 乱序）/ relation（claim↔quote 节点 + supports 正确边）/ repair（挖最长词 + 哈希 id 干扰项乱序），private solution 存 private 表（api 角色保持无 SELECT）。
- **V1 首发上限（§7.7 严格执行）**：无 qualification 数据 → `purpose=practice`、`ceiling=practice_only`；确定性评估（worker 角色连接读 solution）只产 verdicts 供学习反馈，结算 `practice_completed` + 恰好一个 practice trail event，**0 canonical / 0 schedule**。
- **Review 修复**：评估按提交 Variant 的 ceiling 取 min 钳制（换模态到 standby 也无法绕过 practice 上限）+ commit 双门禁（trustClass 与 ceiling 都须 mastery）+ 泄题修复（token/选项 id 内容哈希派生、选项乱序、token 双重去重）+ fail closed（worker 读取失败 → not_assessable checkpoint）。终审 verdict=pass。
- **真实 DB 纵切**：`learning-runs-structured-postgres.integration.ts` 2/2（正确提交 practice 结算 + 非法 payload 400）；P2 回归 3/3。

### 9.6 P4 补全与 P6 Journey V2（2026-08-13 四续）

**P4 relation/repair 补全**：structured kind 映射扩展（transfer→relation）；quote 原文透传（relation 节点 label）；结构题纵切集成 4/4（ordering 正/非法 + relation + repair，全部 practice 结算 0 canonical/0 schedule）。

**P6 Journey V2 核心纵切**：
- shared 合同：CompanionInvitationV2 / CompanionJourneyV2 / 动作与请求（zod，deferredUntil datetime 校验）；
- 三表（0124 迁移 + RLS）：`companion_account_invitations`（账号级，user-only policy）、`companion_journeys`（workspace 级，同账号至多一个非终态的唯一索引）、`companion_journey_pending_events`（(journeyId, domainEventId) 幂等 buffer）；
- `journey-reducer.ts` 纯函数状态机：动作（pause/resume/dismiss/skip/retry/switch_branch 含 branch_locked）与领域事件推进（learning_run.completed + created/rescheduled schedule → completed(real_first_loop)；无 schedule → first_schedule 等待）；skip 终态不伪造里程碑；终端态不接受推进；
- `journey-service.ts`：bootstrap/invitation CAS（defer/skip/start_journey/replay，非终态冲突预检 + 23505 映射 409）/journey 动作 CAS（resumeToken 校验）/领域事件应用（FOR UPDATE 行锁 + applied 短路带 workspace 过滤）；
- Run 完成事件真实挂钩：run-processing-tick 在结算事务内同步推进（同事务原子，失败整体回滚由 outbox 命令重试）；
- 集成 3/3（含 ailearn_api 角色 RLS 负向：跨 user 拒绝 + 自 user 可读对照）；
- forced-security review 三轮：初审 3 MEDIUM + 4 LOW 全部修复，终审 pass。

### 9.7 P6 剩余：里程碑接入 + AssistantSession bootstrap（2026-08-13 五续）

- **里程碑事件接入**：Reducer 扩展 source/note/card/evidence 创建事件分类；材料链顺序守卫（source→note→card→evidence 紧跟前一步推进，迟到事件只合并 refs 不倒退不重放旁白）；first_run/first_schedule 为独立维度（Run 不依赖材料链前置）。
- **跨进程事件链**：api 侧 source/note 创建同事务挂钩（journey-hook）；worker 侧 card/evidence 发布时以 (journeyId, domainEventId) 幂等写 pending events（0125 仅 INSERT 权限）；API 惰性 drain 消费（bootstrap 时按到达序重放，乱序保持 pending 等前置，noop 标 superseded 终止重试）。
- **AssistantSession bootstrap**：start_journey/replay 创建 kind='journey' 的 companion_conversations 会话（0126 扩展枚举）并绑定 assistantSessionId。
- **安全复审两轮**：初审 2 MEDIUM（顺序守卫非单调倒退、applied 检查 TOCTOU）+ 4 LOW（永久 pending 写放大、resumable 过滤、payload 覆盖、worker 信任边界）→ 全部修复 → 复审 pass（残留 2 LOW 不影响放行）。
- **集成 4/4**：里程碑乱序不越级 + drain 补进 + AssistantSession 断言 + 既有 CAS/幂等/RLS 全链。

### 9.8 P7 星图行动面服务端投影（2026-08-13 六续）

- **数据底座（0127/0128 迁移 + RLS）**：`understanding_projection_checkpoints`（opaque token 权威落点 + server-private watermark）、`understanding_change_sets`（Projector 同一幂等事务物化的 immutable before/after 摘要）、`understanding_route_plans`（确定性选路 + 幂等键）。
- **Checkpoint 服务**：HMAC 签名 opaque token（弱密钥 <16 字符拒收 fail closed、篡改拒绝、跨 user 归属校验）；客户端不得解析 watermark。
- **Projector 物化**：canonical/practice source event 应用的同一事务内物化 change set + checkpoint 前移 + outbox status=published（带 workspace/user 条件）。
- **端点**：`GET /understanding/projection`（lens=current_target、checkpoint-aware、minimumCheckpoint 新鲜度不满足 202）；`POST /understanding/routes/plan`（due schedule 确定性选路、checkpoint 作用域+新鲜度 409 route_plan_stale、幂等键参数比对）；`GET /understanding/projection/deltas/:changeSetId`（一次性显影 no-store）。
- **return-contract 升级**：终态按 change set 物化返回 ready（sourceChange/targetCheckpoint/changeSetId）；有结果无物化 → projection_pending(retryAfter)；skipped/ended 无 trail → no_projection_change。
- **安全复审两轮**：初审 2 MEDIUM（minimumCheckpoint/RoutePlan freshness 形同虚设）+ 3 LOW → 全部修复 → 复审 pass。
- **集成 3/3**：canonical/practice 物化 + checkpoint token 纵切；P2 回归 3/3。

### 9.9 P7 前端消费基础件（2026-08-13 七续）

- **api 方法组**：`getUnderstandingProjection`（202/200 双响应透传）、`createUnderstandingRoutePlan`、`getProjectionDelta`；
- **纯函数层**（`features/understanding/projection-client.ts`，3 项单测）：202 → pending 保持旧投影；delta receipt（userId+deviceSessionId+changeSetId 同设备一次、换设备独立）；checkpoint token 按 user 隔离本地保存；
- **useProjectionSync hook**：checkpoint-aware 拉取（本地 minimumCheckpoint）、202 保持旧图、200 保存新 token；
- **graph 页渐进接线**：`STAR_MAP_ACTION_V1` flag 门控——flag on 时投影同步 + changeSetId 显影提示条（同设备一次）；主图渲染仍走旧 reader（**渲染切流属 P7 剩余**，诚实声明）。

### 9.10 P6 sandbox 隔离（2026-08-13 八续）

- **数据底座（0129/0130 迁移 + RLS）**：`companion_sandbox_namespaces`（user/workspace/journey 绑定 + 24h TTL + status 状态机）+ `learning_runs.sandbox_namespace_id`（FK ON DELETE SET NULL）；
- **journey sandbox 分支**：start_journey branch=sandbox_sample 创建 namespace + refs.sandboxNamespaceId；journey 终态（skipped/completed）同事务联动 namespace `exited`（拒绝完整性不依赖 TTL 兜底）；
- **createRun 校验**：onboarding sandbox 必须携带有效 namespace（active + 未过期 + 归属）→ `no_effect(sandbox)` 授权 + run 行写入 namespace；无/他人/过期/exited namespace 均 `context_stale` 拒绝；
- **commit 防火墙**：sandbox run 无论评估结果如何都强制 sandbox_only——sandbox trail（scope=sandbox + 24h TTL）、0 canonical envelope、0 official schedule；
- **projection 双层 scope 过滤**：official personal plane 只投影 `official_user` trail；`materializePracticeChangeSet` 非官方 scope 直接拒绝物化（纵深不依赖调用侧纪律）；
- **安全复审两轮**：初审 2 MEDIUM（namespace 状态联动缺失、projection 混入 sandbox trail 风险）+ 2 LOW → 全部修复 → 复审 pass；
- **集成 2/2**：E02 核心断言（0 canonical/0 official schedule/scope=sandbox/TTL）+ 四种负向拒绝。

### 9.11 P8：主动策略 + durable delivery + 历史分页（2026-08-13 九续）

- **durable delivery**（0131 迁移 + RLS）：`assistant_deliveries`（inboxSequence 分区内单调 + dedupeKey 唯一 + displayLease jsonb）；服务：deliver（dedupe/序列）、claimDisplayLease（单租约 CAS，第二设备 lease_conflict）、ackDelivery（lease 匹配 + 终态幂等重放 + snooze 语义）、listInbox（Last-Event-ID 游标）；真实 DB 纵切 1/1（顺手修掉终态重放 lease 校验顺序 bug）。
- **Policy Engine 纯函数**（§10.2）：availability 与 intervention level 独立枚举；DND/offline/formal_answer/expired 抑制；quiet/moderate 单日预算；dedupe 冷却窗口与次数上限；5 项单测。
- **历史真实 cursor 分页**：服务端 keyset 分页（hasMore/beforeSeq）已被前端真实消费——useCompanionConversations 增加 loadOlderMessages（beforeSeq 拉取 + 按 id 去重合并 + 会话切换丢弃），历史页"载入更早"接线真实回调并更新 limitationNote。

### 9.12 P9：切换 runbook 与旧栈删除清单（2026-08-13 十续）

**capability 边界审计结论**（本轮静态审计）：
- `learning_run_v1`（API `LEARNING_RUN_V1` + 前端 `NEXT_PUBLIC_LEARNING_RUN_V1`）：Card/Review/Today 创建、Player、submission、Assessment/Commit consumer 全部同开关——无双写、无禁止中间态 ✓；
- `star_map_action_v1`：投影同步与 delta 显影前端 flag；projector 物化与 graph reader 解耦（reader 未切流不产生重复消费）✓；
- `system_pet_v2 + journey_v2`：COMPANION_JOURNEY_V2 / COMPANION_BRIDGE_V2 独立 flag；"移除首页/页面伴星 fallback"尚无代码路径（旧 UI 保留），原子性约束在删除旧栈时触发（见下方 runbook）。

**切换顺序（runbook，§22.2）**：
1. 双侧同开 `LEARNING_RUN_V1` + `NEXT_PUBLIC_LEARNING_RUN_V1` → 灰度观察 Card/Review/Today 入口与 Run 结算；
2. 同开 `COMPANION_JOURNEY_V2` + `COMPANION_BRIDGE_V2`（Pet bootstrap 消费完成后）→ Journey V2 与 Bridge 生效；
3. 同开 `STAR_MAP_ACTION_V1`（graph reader 渲染切流完成后）→ 星图行动面；
4. 全部 Gate 通过后删除旧栈（顺序见清单）；
5. 回滚：任何一步失败只关闭新 flag，旧链路保持只读可达；已产生的新事实（Run/Artifact/事件）保留，不删除、不重开旧 writer 覆盖同一 target。

**旧栈删除清单与 Gate 条件**（删除发生在对应新纵切通过 Gate 后）：
| 删除对象 | 位置 | Gate 条件 |
| --- | --- | --- |
| ValidationFocus 正式运行时 | `apps/web/components/ValidationFocus.tsx`、`app/(workspace)/(focus)/review/[scheduleId]`、`cards/[id]/validate` | learning_run_v1 双侧 E2E（E03/E04）通过 |
| 页面级 companion 状态机 | `cards/[id]/companion`、`CompanionRuntimeProvider`/`CompanionShell`/Anchor/Panel | system_pet_v2 E2E（E12/E16）通过 |
| onboarding 大卡与伴星文案 | `components/study/OnboardingGuide.tsx`、首页六步 | journey_v2 E2E（E01/E02）通过 |
| InAppPetHost 浏览器桌宠 | 浏览器内 Pet 副本 | system_pet_v2 双窗口联调通过 |
| 旧显式两步编排 | 前端 submit→assess 双请求路径 | P2 统一 submission E2E 通过 |
| 旧 star map reader 与缓存 | `lib/understanding-graph.ts` 旧聚合消费 | star_map_action_v1 E2E（E10/E11）通过 |
| localStorage 单 dialogueId | 前端当前伴星会话真相 | AssistantSession 解析接线完成 |
| 旧 proactive deliveries（permit-based） | `companion_proactive_deliveries` 表与消费 | durable delivery inbox/ACK E2E（E14）通过 |

**数据迁移检查**（§16.3）：旧 learning_sessions 按 Episode 拆 Run（legacySessionGroupId/legacyEpisodeId/legacyOrdinal 已建列）；旧 companion conversations 迁 AssistantSession；backfill 可重复运行并输出对账报告。

### 9.13 E08/E09 + P8 剩余（记忆/Orchestrator）（2026-08-13 十一续）

- **E08 路径修复**：`finishCriticAssessment` 在 Critic 调用前先查 hint exposure——暴露时直接 practice 结算（不依赖 Critic 可用性）；集成验证 0 canonical/0 schedule；
- **E09 竞态验证**：assessing 阶段 `end(abandonLockedEvidence=true)` epoch 前移 → 迟到评估不写结果、不产 canonical（epoch fence 语义）；
- **分层记忆**（0132 迁移 + RLS）：`assistant_memory_items`（kind/content/来源引用/userStated/userConfirmed/candidate/deletedAt）；服务：upsert（sourceEventId 去重）/confirm（候选→确认）/softDelete（审计保留）/list（默认不含候选）；与 canonical 学习事实解耦；
- **Orchestrator 最小闭环**：Run 结算 → 确定性 Policy 判定（账户 presence/globalEnabled 尊重）→ durable deliver 入队（system_event + dedupe 不重复），同事务原子；
- **集成**：P2 纵切 5/5（含 E08/E09）+ 记忆/Orchestrator 2/2。

### 9.14 E17 backfill + inbox SSE + E15 级联（2026-08-13 十二续）

- **E17 旧栈迁移**（`legacy-backfill.ts` + 0133 部分唯一索引 + `scripts/backfill-legacy-sessions.ts` 入口）：旧 Session 按 Episode 拆 Run；语义投影（active→active、completed→result=null fail closed、stale→target_fingerprint_changed、cancelled→runtime_cancelled、不可解释→跳过计数）；幂等（legacyEpisodeId 查重 + 索引兜底）；`legacyOrdinal` 按同 Session createdAt(+id) 递增编号；真实 DB 2/2（含幂等重跑 + 对账报告）；
- **Proactive inbox SSE**（`inbox-routes.ts`）：`GET /companion/deliveries/inbox/stream`，id=inboxSequence、Last-Event-ID 断线续传（after query 优先 + 标准头 fallback），requireSession + workspace/user 双过滤；
- **E15 删除语义验证**：记忆删除不影响 canonical 学习事实；对话删除保留 inbox 历史（delivery 仅 assistantSessionId 引用）；
- **forced-security 四轮**（3 should-fix + 2 中优先 + 2 轮返工）终审 pass；集成测试全部 FORCE RLS 裸查收敛为同事务 set_config(is_local=true) 模式（事务结束自动恢复，不污染连接池）；
- **SEC-01 审计收敛**：`memory-service.ts`/`projection-service.ts` 写函数参数统一为 `executor:`（审计要求）；source mock 补 journey-hook 零开销链；
- **Timeline 审计端点**（`timeline-routes.ts`）：`GET /companion/deliveries/timeline`（kind 枚举对齐 shared AssistantDeliveryV2 五值 + 过期标记 + 游标）；
- **复审修复**（warn→pass）：SSE `reply.hijack()` 对齐生产模式；inbox/timeline 加 COMPANION_JOURNEY_V2 onRequest 门控（404 fail closed）；backfill origin 显式投影（card/review_schedule→card/review、key_point/question_suggestion→today 降级）；set_config is_local 语义改正（true=事务本地）；
- **验证**：api 全量 3106/3106；E17 2/2；记忆/Orchestrator/E15 3/3。

### 9.15 最终剩余（环境到位后执行）

1. **E01-E18 corpus 验证**（UI trace + API trace + DB/outbox/projector 断言 + 截图；需浏览器/Electron）；
2. **旧栈实际删除**（按 §9.12 清单与 Gate 条件）；
3. **P2 真 Critic Gold**（ASSESSMENT_CRITIC_* 配置后 demonstrated 纵切）；
4. **P8 剩余**：记忆与 Orchestrator 的模型生成接线（当前为确定性最小闭环；时间线审计端点已于 §9.14 落地）。