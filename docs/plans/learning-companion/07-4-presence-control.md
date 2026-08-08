# 决策记录 07-4：存在感设置与控制状态（§5.5/§5.6）

> 状态：**Frozen（已冻结）**
> 执行：阶段 07（W6）任务 07-4
> 日期：2026-08-08
> 来源：`07-w6-global-companion-map-tutor.md` 任务 07-4（原方案 §5.5/§5.6）；
> 冻结记录 01-9（非强迫个性化）、05-5（Global Shell 前端控制状态纯逻辑）
> 约束级别：同一 `contextBudgetKey`/`reasonBudgetKey` 不重复；
> 多标签/多设备同一用户同时最多一条提示；无有效 permit 不渲染主动提示。

## 1. 交付物

- `apps/api/src/modules/companion-shell/presence-control.ts` —— 存在感三档 +
  三种学习前台状态的纯逻辑核心与事务语义封装：
  - 三档存在感 `quiet/moderate/active`：行为元数据、presence → reason class
    映射（`PRESENCE_TO_ALLOWED_REASON_CLASSES`）、硬性不变量
    （`PRESENCE_INVARIANTS`：不自动开麦/不自动进下一题/不因忽略失望/无红色
    倒计时/可一键隐藏且保留完整手动能力）；首次启用未选择前默认 `quiet`；
  - 控制状态全站接线：8 个 versioned 控制状态的 id/scope（
    `temporary_hidden` 仅设备本地、`global_off`/`suggestion_paused`/动画/语音
    账号同步、page 级路由作用域、focus 任务作用域）；
  - 设备 fence：`buildDeviceFence`（deviceSessionId + surfaceEpoch）与
    `validateSurfaceEpoch`（迟到 epoch 一律丢弃）；
  - global_off CAS：`evaluateGlobalOffCas`（account revision 乐观锁）、
    `nextEpochAfterGlobalOff`（epoch 单调递增供广播 fence 撤销）、
    `describeGlobalOffSync`（CAS 失败 → 设置页显示「仅本设备已隐藏，全局关闭
    尚未同步」，不得谎报成功）；
  - 三种学习前台状态 `together / let_me_try / free_explore`：信任域
    （`foregroundTrustDomain`，together/free_explore → practice_only、
    let_me_try → trusted assessment）、动作矩阵（`LEARNING_FOREGROUND_ACTIONS`）、
    知识帮助门（`resolveKnowledgeHelpGate`：let_me_try 下只能呈现「切换到一起
    学习」确认）；
  - `enterPracticeMode`：原子切换（同事务内**先**记录 assistance/exposure、
    **后**开放 Grounded Tutor 权限、再写「一起学习」前台状态）；无用户确认
    nonce（Agent 不能代点）→ `USER_CONFIRMATION_REQUIRED`；迟到 fence →
    `STALE_SURFACE_EPOCH`；free_explore → `INVALID_FOREGROUND_TRANSITION`；
    已 together 幂等；任一步失败整体回滚（Tutor 权限绝不先于
    assistance/exposure 记录开放）。
- `apps/api/src/modules/companion-shell/presence-control.test.ts` —— 单测
  （内存 repo + 模拟事务快照/回滚）。

## 2. 决策：三档存在感是行为契约，不是可自由组合的开关

`quiet` 未召唤时只有静态中性锚点且完整 entity context/idle 动画为 0，除新注册
一次性 consent surface 外主动提示为 0；`moderate` 只在恢复、可恢复错误、stale
或 committed change 给一次邀请，未响应即退场；`active` 在 moderate 基础上允许
一条有原因说明的下一步或路线，但不自动开始。任一档不自动开麦、不自动进入下一
题、不因忽略而失望、不使用红色倒计时或任务债务、可一键隐藏且保留完整手动
能力。presence → reason class 映射供 trigger-arbitration 的
`allowedPresenceLevels` 落地；未选择前默认 quiet。

## 3. 决策：控制状态作用域与设备 fence

`temporary_hidden` 的持久布尔只留设备本地（跨设备不同步）；authenticated 客户
端另发送短生命周期 `deviceSessionId + surfaceEpoch` runtime-fence（02-3 的
runtime-fences 端点承载）；`global_off` 经 `/me/companion` 做 account revision
CAS 并向全部 active device session 广播 fence（epoch 单调递增）；两者迟到结果
一律丢弃（`validateSurfaceEpoch`）。`global_off` CAS 失败时设置页明确显示
「仅本设备已隐藏，全局关闭尚未同步」，不能谎报成功。suppressedSuggestionClassIds
与稳定页面预算、bounded reason 预算持久化（account state suppression + 07-3
ledger），本模块提供语义，落库由既有 02-3/02-4 承载。

## 4. 决策：三种学习前台状态与原子 enter_practice_mode

- 一起学习 → practice_only 域（解释/举例/展示证据/给提示/生成练习）；
- 让我试试 → 可进入 trusted assessment（朗读净化题面/解释操作/录音控制/无内容
  鼓励）；索要知识帮助只能呈现「切换到一起学习」确认动作；
- 自由探索 → 默认 practice_only（回答当前目标问题、操作沙盘；候选关系仅
  Should flag 开启时可见）。

用户在「让我试试」中索要知识帮助 → UI 只呈现「切换到一起学习」确认 → 用户确认
后调 `enterPracticeMode`（**Agent 不能代点**：无用户确认 nonce 拒绝；系统不能
先提示再补记）→ 同一事务先记录 assistance/exposure 再开放 Grounded Tutor 权限，
任一步失败回滚。学习前台状态的持久化由路由接线层提供 `LearningFrontRepo`
实现（复用 learning-unit exposure 与账号级偏好存储），本模块保证顺序与原子性。

## 5. 验收与证据

- [x] `temporary_hidden`/`global_off` 语义与 scope 正确
  （DEVICE_LOCAL_ONLY_STATES / ACCOUNT_SYNCED_STATES / scope 表用例）。
- [x] 设备 fence 迟到结果丢弃（`validateSurfaceEpoch` 用例）。
- [x] global_off CAS 成功/失败与未同步文案（`describeGlobalOffSync` 用例）。
- [x] 学习前台三态信任域/动作矩阵/知识帮助门正确；enter_practice_mode 顺序
  （record → open-tutor → write）与原子回滚、幂等、free_explore 拒绝、迟到
  fence 丢弃、Agent 无确认 nonce 拒绝（21 用例）。
- [x] `npm test --prefix apps/api` 通过（# tests 2173, # pass 2173, # fail 0，
  含 presence-control.test.ts 21 用例）。
- [x] `npm run typecheck --prefix apps/api` 通过（TypeScript 严格模式）。

## 6. 不做的边界（后续任务）

- 本任务不实现学习前台状态的持久化表与 `/me/companion/foreground` 等 HTTP 路由；
  `LearningFrontRepo`/`transaction` 由路由接线层注入（后续接线任务）。
- 页面级 UI（QuietAnchor/CompanionSidePanel 挂载、设置页渲染）属 05-5/07-1 与
  前端接线任务。
- 已锁 formal assessment 属可信内核，可按原 contract drain；本模块不为此新增
  Companion 提示或调用。
