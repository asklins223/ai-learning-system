# 阶段 07（W6）：全局伴星、四入口、理解星图与当前目标 Tutor

> **第一层执行顺序第 7 步**
> 前置：阶段 06（W5 纵切）与阶段 05（W4 Global Shell 基础设施）
> 后置：阶段 08（W7 跨模块审计）
> 本文件 = 本阶段下的**第二层：可并行执行的任务**清单。
> 对应原方案 §15「W6」；规范依据：§5.4（全局伴星壳）、§5.5（存在感）、§5.6（三种前台状态）、§5.7（Grounded Tutor）、§5.8（伴侣记忆）、§8（学习卡）、§10（理解星图）、§3（旅程）、§11（个性化）。

---

## 本阶段目标

把伴星从注册/登录贯穿到全部可路由页面，交付首次引导、全路由 coverage、触发仲裁、控制状态、学习卡主行动、星图真实回写与当前 target Tutor，形成完整产品闭环。

## 可并行执行的任务（第二层）

### 任务 07-1：注册/登录静态伴星与首次引导（§3.2/§5.4.3）

**交付物**：公开认证层静态伴星、隔离 sample assets/renderer/demo map、versioned 首次使用引导与设置/帮助重播。

**任务内容（原文 §5.4.3 + §3.2）**：

- 注册/登录/找回账号页：静态或轻量状态说明产品用途，按需提供登录与无障碍帮助；不读取凭据，不调用个性化模型；公开认证层只使用确定性产品动作；
- 注册成功并首次进入系统时，伴星只发出一次账号级设置邀请（"欢迎来到你的理解宇宙。要不要用大约 3 分钟和我走一遍？"）；这是用户尚未选择存在感前唯一一次可主动展示的 consent surface；固定提供三个同级动作：`带我走一遍 / 我自己看看 / 先调整方式`；"我自己看看"就是直接跳过，不使用弱化颜色、倒计时、二次挽留或"推荐"角标；已有偏好为 quiet/temporary hidden/global off 时只在设置/帮助中放被动介绍；
- 引导六步（§5.4.3）：认识边界 → 调整相处方式（默认"安静"）→ 选择起点（沙盒或自己的内容）→ 走过示例流程（`onboarding_sample:*`）→ 看见可信交接（`publishedTargetEligibility=false`）→ 明确结束（从我的内容开始/去星图看看/结束引导）；
- `CompanionOnboardingStateV1` CAS 状态机已在 W1 实现（阶段 02 任务 02-3），本任务完成 UI 与入口接线；
- 引导结束后提供"从我的内容开始 / 去星图看看 / 结束引导"，不自动开始正式航程；完成或跳过后系统不再自动邀请或重放，用户可随时从伴星或帮助入口手动重新开始。

**验收**：注册/首次引导全流程通过；onboarding 对 exposure、学习事实和调度零副作用；own-content 先退出 sandbox 再走正常合同。

---

### 任务 07-2：全路由 coverage registry 与 context/action manifest（§5.4.4/§5.4.6）

**交付物**：public-auth/authenticated 全路由 `CompanionPageCoverageRegistryV1`、页面 context 与 action manifest。

**任务内容（原文 §5.4.4/§5.4.6，W6 bullet）**：

- 覆盖：首页/空 workspace、内容库与 Source/Note 列表/详情、Card Set/Card/Key Point/全屏验证、Review/此刻、星图、工作台/结果、搜索/无结果、导入/生成、邀请/验证/MFA/SSO callback、设置/隐私/历史/账号安全/成员权限/密钥、错误/离线、internal/admin；`CompanionPageCoverageEntryV1`（routePattern、pageKind、surfaceMode、sensitivity、manifestVersion/Hash、manualFallbackTestId、owner）；
- 子路由只有在 sensitivity 和 action allowlist 完全相同时才可显式继承父 manifest；未分类、隐式继承或 manifest hash 失效必须在 CI/启动时失败；
- 页面职责矩阵（§5.4.6，完整表见原方案）：注册/登录/找回账号（解释公开能力、无障碍、确定性登录故障；禁止读凭据/观察输入/建画像/请求麦克风）；首页/空 workspace（开始或恢复引导、选择示例、说明添加第一份材料、恢复暂停任务；禁止强迫上传/自动创建/把 onboarding 做成待清任务）；"此刻"/Review（解释推荐原因、缩短/换一条/稍后/自由漫游；禁止展示债务/红色逾期/静默延期/自动开始）；Source/Note（说明页面、朗读选区、定位证据、展示已发布 Card；禁止未绑定 target 无界问答、把解释直接发布为 canonical Card、读未授权材料）；Card/Key Point（一起学习、让我试试、查看证据、前往星图；禁止 formal 前泄答案/rubric、替用户开始验证）；理解星图（聚焦/切透镜/铺路/恢复视口；禁止自由创建共享关系、把 Scene 连线发布为图真值）；共学工作台（朗读操作、切换模态、一起学习、可信交接、停止；禁止 formal 中给内容提示/代做/代提交/参与评分）；Episode 结果（解释真实变化、返回来源、可选查看星图或用户确认继续；禁止夸大掌握/自动续题/用庆祝动画掩盖 assessment 边界）；搜索/无结果（缩小合法范围、解释无结果、引导添加或选择已有内容；禁止编造结果/跨权限检索）；导入/生成状态（按确定性 job 状态解释进度；禁止虚构百分比/承诺未完成产物/用动画伪装进度）；设置/隐私/历史（解释选项影响、定位控制项、预览导出/删除范围、重播引导；禁止自动改偏好/代确认授权/导出或删除）；账号/安全/成员/权限/密钥/MFA（仅签名静态 allowlist 解释；禁止运行模型/语音、观察字段或交互元数据、读取成员/密钥值、代授权或改变权限）；404/离线/降级（解释已保存状态和可恢复步骤；禁止把系统故障表现成用户失败、阻塞原页面 fallback）；
- Global Shell 启用且 surface 未命中 hide/hidden/off 时，registry 内所有可交互页面必须有与 `surfaceMode` 一致的稳定召唤入口；隐藏/关闭时页面不显示锚点，只保证普通帮助、设置或全局命令中的重新启用入口可达。

**验收**：router 与 `CompanionPageCoverageRegistryV1` 100% 对账；credential/跨 workspace 泄漏与来源伪装为 0。

---

### 任务 07-3：触发仲裁、双预算与建议抑制（§5.4.5）

**交付物**：trigger rule registry、presence/reason 映射、onboarding 与 context/reason 双预算、suggestion suppression、静音/专注/隐藏/关闭。

**任务内容（原文 §5.4.5，W6 bullet）**：

- `CompanionTriggerRuleV1`（reasonId 为 bounded registry enum，never model-authored；sourceEventType、allowedPresenceLevels、allowedPageKinds、requiredCapabilityIds、suppressionModes、stableContextKeyPolicy、cooldownPolicyId、actionManifestId）；`CompanionTriggerPolicyV1` 缺失或 hash 不匹配时主动提示 fail closed，被动召唤与页面原生功能仍可用；
- 合法 reason 只包括：用户已暂停任务的续接、当前操作的可恢复错误说明、canonical 内容变化导致的 stale、commit 后就地展示真实变化、长时间回来后的非强迫恢复、主动建议档下清晰且立即可执行的下一步；注册后的首次 consent surface 使用独立 onboarding 状态机和预算；
- 抑制顺序：`auth_local_hidden / global_off > temporary_hidden > page_muted / page_context_off / focus_until_task_end / suggestion_paused / suppressedSuggestionClassIds > presence level > rule capability/page/action eligibility > stable page budget 与 reason budget`；
- 邀请预算两个稳定身份（不能复用随刷新变化的 pageInstanceId/contextVersion/viewport/临时选择）：

```text
stablePageContextKey = workspace + routePattern + canonical target/origin + targetChangeEpoch
contextBudgetKey      = user + stablePageContextKey + cooldownEpoch
reasonBudgetKey       = user + workspace + canonical target/origin + targetChangeEpoch + boundedReasonId + cooldownEpoch
```

- 一次提示必须在同一数据库事务内：验证 suppression/policy/capability → 以唯一约束插入 `contextBudgetKey` 与 `reasonBudgetKey` → 获取 account-scoped、短 TTL 的 `activeSuggestionLease` → 签发一次性 `CompanionSuggestionPermitV1`；任一 key/lease 冲突整体回滚且前台不得渲染；dismiss、页面离开或 TTL 释放 lease，但不退还已消费预算；
- `targetChangeEpoch` 只在服务端确认 canonical target 发生规则定义的实质变化时单调增加；`reasonId`、`cooldownEpoch`、lease TTL 和 key policy 均由签名 policy 冻结，Agent 无权生成或修改；
- 认证、安全、权限与破坏性操作确认属于页面原生系统 UI，不进入 Companion trigger budget，也不能因隐藏/关闭伴星而消失；
- Companion 固定优先级：用户主动召唤 > 用户明确暂停任务的续接 > 当前操作的可恢复错误说明 > canonical 状态变化 > 普通上下文建议。

**验收**：同一 `contextBudgetKey/reasonBudgetKey` 不重复；多标签/多设备同一用户同时最多一条提示；无有效 permit 不渲染主动提示。

---

### 任务 07-4：存在感设置与控制状态（§5.5/§5.6）

**交付物**：三档存在感、全部控制状态、三种学习前台状态、跨页 origin 恢复。

**任务内容（原文 §5.5/§5.6，W6 bullet）**：

- 存在感：`quiet`（未召唤时只有静态中性锚点且完整 entity context/idle 动画为 0；除新注册一次性 consent surface 外主动提示为 0）、`moderate`（只在恢复、可恢复错误、stale 或 committed change 给一次邀请，未响应即退场）、`active`（在 moderate 基础上允许一条有原因说明的下一步或路线，但不自动开始）；无论哪一档：不自动开启麦克风、不自动进入下一题、不因忽略而失望、不使用红色倒计时或任务债务、可一键隐藏且保留完整手动能力；
- 控制状态：`page_muted`、`page_context_off`、`focus_until_task_end`、`suggestion_paused`、`temporary_hidden`、`global_off`、`animation_off/voice_output_off`（作用域与行为见原方案 §5.5 表；阶段 05 已交付基础设施，本任务完成全站接线）；
- `temporary_hidden` 的持久布尔值只留设备本地；authenticated 客户端另发送短生命周期 `deviceSessionId + surfaceEpoch` runtime-fence；`global_off` 通过 `/me/companion` 做 account revision CAS 并向全部 active device session 广播 fence；两者的迟到结果一律丢弃；`global_off` CAS 失败时设置页明确显示"仅本设备已隐藏，全局关闭尚未同步"，不能谎报成功；
- 只有已经脱离 Companion、由所属 domain service 执行的导入/生成等 job 可以让用户选择"转到手动界面继续 / 取消"；Grounded Tutor、页面解释、建议和其他 Companion job 必须取消；已锁 formal assessment 属于可信内核，可按原 contract drain，但不能因此新增 Companion 提示或调用；
- 首次启用时以中立方式让新老用户选择；未选择前默认"安静"；`suppressedSuggestionClassIds`、稳定页面预算和 bounded reason 预算持久化；
- 三种学习前台状态（§5.6）：一起学习（解释/举例/展示证据/给提示/生成练习 → `practice_only`）、让我试试（朗读净化题面/解释操作/录音控制/无内容鼓励 → 可进入 trusted assessment）、自由探索（回答当前目标问题、操作沙盘；候选关系仅在 Should flag 开启时可见 → 默认 `practice_only`）；用户在"让我试试"中索要知识帮助时只能呈现"切换到一起学习"确认动作，用户确认后由原子 `enter_practice_mode` 端点先记录 assistance 和 exposure 再开放 Grounded Tutor 权限；Agent 不能代点，系统不能先提示再补记。

**验收**：`temporary_hidden/global_off` 后页面监听/context 构造、角色/邀请/预取/后台调用为 0；控制状态作用域正确。

---

### 任务 07-5：学习卡一个主行动与四入口共享内核（§8/§3）

**交付物**：学习卡一个主行动（"开始/继续一小段航程"）、Card/Review/Now/Star 四入口共享 Session/Episode 内核、origin-aware completion。

**任务内容（原文 §8 + §10.3 + §3.3~3.8，W6 bullet）**：

- 学习卡仍是有证据的知识载体；前台只保留一个主行动：**"开始/继续一小段航程"**；Supervisor 决定本轮使用语音、排序、修复还是情境，不把"动/试"做成平级玩法菜单；
- 朗读（TTS 播放摘要/论点/证据）、查看证据（展开 exact evidence 与 semantic support）、问一问（当前 target 有界 Tutor detour）作为内容工具存在，不必创建完整 formal Session；朗读/查看/Tutor 按实际暴露内容记录 exposure，随后开始航程必须遵守 assistance cooldown；
- 学习卡状态不等于用户理解：卡片已发布只表示知识资产通过生成与证据 Gate；打开/收听/收藏只表示接触过；Tutor 解释只产生 practice 事件；只有符合 trusted contract 的验证/复习事件才能改变个人理解投影；
- 四入口：`star_map`（恢复原 viewport/zoom/selection 并显影真实变化）、`card`（返回当前卡片显示能力/复习变化摘要）、`review/now`（展示本 Episode schedule 结果与未处理事实）、scoped Tutor detour（回到原 Episode/保留为练习/明确结束）；每处可"在星图中查看"但不强制跳转；`originRef`、viewport/selection snapshot 和 completion summary contract 在 PREPARE 时冻结；
- 旅程 A~F（阶段 00 任务 00-6）作为验收场景执行。

**验收**：四入口结果一致且就地完成；无键盘主路径可用；学习卡无第二个平级玩法菜单。

---

### 任务 07-6：理解星图两个数据平面与真实回写（§10）

**交付物**：星图两个数据平面、四产品透镜、行动入口、节点详情、真实结果回写与 Canvas 改造。

**任务内容（原文 §10，W6 bullet）**：

- 两个数据平面（§10.1）：共享知识真值（Source/Note/Card/Key Point/Evidence 和确定性血缘，workspace-owned，唯一变化来源 canonical Publish 与现有外键血缘）；个人学习事实及投影（validation/review outcome、时间耐久、能力切面、assistance、问题与可隐藏航迹，user-private，唯一变化来源现有 canonical 学习事实 + outbox/replay）；公测 Must 不把 relation hints 画成共享语义边，也不宣称具备"关系理解"正式状态；
- 四个产品透镜（§10.2）：当前目标（Key Point 与建议路线）、证据（来源/exact evidence/semantic support/版本）、关系（公测只展示确定性血缘）、问题（Should：用户主动保存的探索标记）；到期详情、能力切面、最近验证和 assistance cooldown 放进节点详情，不各自成为全图透镜；
- 星图行动（§10.3）：选中 Card/Key Point 后可开始或继续一小段航程、朗读、查看证据、召唤当前目标 Tutor、返回来源 Note/Card；Scene 内的连线只是当前 Episode 的 Response Artifact，不会自动创建共享边；
- 星图变化规则（§10.4）：浏览/打开/停留/收藏/朗读/看过答案不能点亮理解；只有现有 canonical validation/review outcome 才能改变时间耐久，facet 变化必须能追到合格 assessment；practice 航迹默认只出现在本轮 recap 或短期历史；所有长期投影可由 canonical facts + outbox 重放得到同一 hash；不展示伪精确的"掌握度 87%"，不把活动量包装成知识成长；
- Canvas 改造原则（§10.6）：扩展现有缩放、平移、聚类、选中、LOD 和稳定布局，不为伴侣重写整套图渲染；伴星动作和路线通过受控 overlay/scene layer 实现；低缩放 LOD 按当前目标、official priority、canonical gap 和重要性保留节点，不随机取样；星图不是唯一入口；移动端退化为星域列表 + 路线卡；
- Relationship Governance（§10.5，Should）：candidate（relation hint / Tutor proposal / user proposal）→ 独立 relation support check → authorized human confirm | reject → versioned publish + fingerprint + audit → 上游变化时 stale 支持撤回和重审；个人 workspace 由 owner 确认，协作 workspace 仅 owner/editor 或专门权限角色可确认；所有来源（Generation Claim Critic、Tutor、Session Supervisor、用户 Scene 连线）只能提议 candidate；candidate 为虚线且不进入 formal target。

**验收**：星图正式变化全部来自可重放事件，0 无事件点亮；共享/个人两平面分离；关系 candidate 无法经验证路径 published。

---

### 任务 07-7：当前 target Tutor 与 Grounded Answer Critic（§5.7）

**交付物**：当前 target 有界 detour、逐段 evidence refs/support mode、Grounded Answer Critic、trusted → practice 原子切换。

**任务内容（原文 §5.7，W6 bullet）**：

- Grounded Tutor 是当前 Learning Session 内的**有界 detour**，不是独立聊天通道；每个 detour 必须绑定 `sessionId + episodeId + targetId + questionId`；一次只处理一个问题，公测 v1 最多允许两次澄清；Must 固定结束动作只有"返回原航程 / 结束"，问题标记 Should flag 开启时才增加"保存为问题标记"；Session 外提问只有在用户明确选定一个 published Key Point 后才创建 scoped exploration Session；否则先请用户选择材料，不提供通用无限消息流；
- 输出优先是证据卡、对比 Scene、条件变式或短解释，而不是长文本对话；前台不保留无限滚动聊天历史；
- 答案按支持层级拆分：当前 target（公测 Must：由 canonical evidence 直接支持或有界推导，推导段标记 `derived_from_current_target`）、工作区知识（Should）、扩展说明（Should：明确标注，不进入共享知识真值和正式验证）、未知（明确说明不知道，不编造来源）；每个事实性 segment 携带 support mode；公测 Must 只开放"当前 target"；
- Must 可见动作只有：在当前 target 边界内换一种解释、查看对应证据、生成当前目标的 practice Scene、返回或结束；跨 target 比较、workspace 检索、扩展说明、新笔记/新卡提议和持久问题保存均为 Should，flag 未开时动作本身不可见；
- 伴侣只能**提议**生成新学习卡、关系 candidate 或创建笔记，必须由用户确认并重新经过 Generation Supervisor/Relationship Governance；Tutor 答案不能直接成为 canonical Card 或 published semantic relation；
- 标记为"当前 target"或"工作区知识"的 segment 在展示前还要经过独立 Grounded Answer Critic 的逐段 `supported / partial / unsupported` 检查；`derived_from_current_target` 还必须绑定 premise refs 与推导类型；只有 supported 可以使用对应来源标签，partial/unsupported 必须降为明确的扩展说明（Should 开启时）或 abstain；引用完整不等于语义支撑通过；
- 用户在当前 Card/Episode 中提问时：若正在 trusted challenge，先询问是否切换到一起学习；原子记录 assistance/practice 状态后调用 Tutor；trusted → practice 原子切换。

**验收**：Tutor 直接写掌握/卡片/关系为 0；Grounded Answer Critic mandatory；unsupported segment 只能 abstain；不存在独立无限 message API。

---

### 任务 07-8：跨页、跨设备与失败恢复（§5.4.7）

**交付物**：跨页 origin 恢复、跨设备安全恢复、多设备显式接管、登录过期恢复。

**任务内容（原文 §5.4.7，W6 bullet）**：

- 跨页只携带有界任务摘要、`originRef`、合法 entity refs 和已确认 checkpoint，不携带无限消息流；返回时恢复来源、滚动位置、星图 viewport 与选择态；
- 跨设备同步 onboarding offer 终态、global off、存在感/suggestion suppression、学习目标和合法 Session checkpoint；不跨设备同步 temporary hidden/page mute、未提交输入、原始音频或临时敏感内容；
- 新设备在 presence/trigger 允许时至多询问一次"继续上次任务 / 暂不恢复"，quiet 下只提供被动续接入口，绝不自动展开完整 Scene；展示 target 名称或恢复前先重查 workspace、权限、内容 revision、policy、assistance 与 capability，过期时说明原因并安全重建；
- 同一 Session 多设备并发采用显式接管或只读提示，不能双重提交；未接管设备成功提交为 0；
- 登录过期后重新认证应回到原页面与合法 checkpoint，不能重放旧权限 action；
- Shell、角色、动画、语音或模型失败不能阻塞页面；重试保持幂等，并始终提供"重试 / 使用手动方式 / 退出伴星"；系统不能丢失已经确认的步骤或重复创建副作用。

**验收**：恢复/接管前不暴露未重验 target 名称；未接管设备提交为 0；跨 workspace context/entity 泄漏为 0。

---

### 任务 07-9：个性化偏好与反馈文案（§11）

**交付物**：本轮上下文、长期可编辑偏好、非强迫式游戏感与反馈文案落地。

**任务内容（原文 §11，W6 bullet）**：

- 本轮上下文：3/10/20 分钟或自定义、本轮精力、挑战偏好、静音/可语音/只用触控或键盘、聚焦一个星域/混合复习；默认只要求选择目的地，其余可选；本轮精力不长期保存、不形成心理画像，只影响 route composition/表达/数量/互动选择，不能直接进入 mastery 或 official scheduler；
- 长期可编辑偏好（§11.2 清单）：默认输入优先级、禁用 Encounter、反馈风格、存在感、页面静音/专注、动画/语音输出、全局关闭、临时隐藏、"不再提示" suggestion classes、挑战倾向、单主题/交错、默认时长/每周负荷/时间窗/通知边界、TTS 语速/字幕/音效/reduced-motion/A11y、原始音频保留与隐私选择；设置与帮助中心提供"重新播放首次引导"和"伴星当前可使用哪些页面上下文"；onboarding 完成/跳过属于产品状态不是学习偏好；所有偏好可查看、修改、重置、导出和删除；Agent 只能提出 `suggested preference`，不能静默改变；
- 游戏感来源与反馈文案规则（§11.3/§11.4）：允许选择/预测/操作变化/修复/可信变化显现/问题得到回答/回看理解变化；禁止 XP/等级/金币/连击/宝箱、streak/断签宽限/每日清空/排行榜/失败扣分/随机奖励/内容锁/体力墙/伴星失望催促；文案具体、可行动、非身份化，避免"你落后了""欠了 N 项""完全掌握 92%""再来一题保住进度"。

**验收**：偏好全量可查看/修改/重置/导出/删除；无 XP/streak/排行榜/任务债务/随机奖励/强制每日目标；Agent 不能静默改偏好。

---

## 阶段退出 Gate（07 / W6）

- [x] 注册/首次引导和全部可路由页面 coverage 通过（router 100% 对账）；
- [x] 四入口（Card/Review/Now/Star）结果一致且就地完成；
- [x] Tutor 直接写掌握/卡片/关系为 0；
- [x] credential/跨 workspace 泄漏与来源伪装为 0；
- [x] `temporary_hidden/global_off` 后页面监听/context 构造、角色/邀请/预取/后台调用为 0；
- [x] workspace/扩展 Tutor、持久问题、semantic relation 保持非阻塞 Should flag。

通过后进入阶段 08（W7 跨模块审计）。

### 本阶段执行记录

- 执行日期：2026-08-08（分支 v1.0）
- 任务完成：07-1~07-9 全部实施并签署（契约/服务/测试/决策记录均落盘）
- 验证：apps/api 2195/2195、packages/shared 374/374、packages/db 5/5、apps/web 674/674、workers typecheck、git diff --check 全部通过
- security_review：1 轮 warn（3 MEDIUM：nonce 仅非空校验 / together 分支谎报权限 / accountEpoch 缺省 0）→ 修复后复查 **pass**（nonce 服务端一次性校验、权限真实开放、accountEpoch 必填）
- 承接：阶段 08（W7 跨模块 A11y、安全、隐私与可观测性审计）
