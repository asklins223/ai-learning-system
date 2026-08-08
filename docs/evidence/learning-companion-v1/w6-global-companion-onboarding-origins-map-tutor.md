# W6 证据：全局伴星、注册引导、四入口、星图与当前目标 Tutor

> 对应任务 11-2 证据文件 8。佐证 DoD 7、9、10、11、12、14、25、27、28、29、30、31。
> 决策记录：`docs/plans/learning-companion/07-w6-global-companion-map-tutor.md`（任务 07-1~07-9）与 `07-1-onboarding-first-guide.md` ~ `07-9-preferences-feedback.md`。
> 状态：**Frozen** ｜ 执行：阶段 11 / W11 任务 11-2 ｜ 日期：2026-08-08

## 1. 实现文件核验（路径存在）

| 单元 | 路径 | 对应任务 |
| --- | --- | --- |
| onboarding-state | `apps/web/lib/learning-companion/onboarding-state.ts`（+ `onboarding-state.test.ts`）+ 组件 `OnboardingGuide.tsx`、`OnboardingInvite.tsx` | 07-1 |
| page-coverage-registry | `apps/web/lib/learning-companion/page-coverage-registry.ts`（+ `page-coverage-registry.test.ts`） | 07-2 |
| trigger-arbitration | `apps/api/src/modules/companion-shell/trigger-arbitration.ts`（+ `trigger-arbitration.test.ts`） | 07-3 |
| presence-control | `apps/api/src/modules/companion-shell/presence-control.ts`（+ `presence-control.test.ts`） | 07-4 |
| star-map-projections | `apps/api/src/modules/learning-sessions/star-map-projections.ts`（+ `star-map-projections.test.ts`） | 07-6 |
| relation-governance | `apps/api/src/modules/learning-sessions/relation-governance.ts`（+ `relation-governance.test.ts`） | 07-6 |
| grounded-tutor | `workers/ai-worker/src/learning-agent/roles/grounded-tutor.ts`（+ `grounded-tutor.test.ts`） | 07-7 |
| tutor-detour | `apps/api/src/modules/learning-sessions/tutor-detour.ts`（+ `tutor-detour.test.ts`） | 07-7 |
| cross-device-recovery | `apps/api/src/modules/learning-sessions/cross-device-recovery.ts`（+ `cross-device-recovery.test.ts`） | 07-8 |
| session-preferences | `apps/api/src/modules/learning-sessions/session-preferences.ts`（+ `session-preferences.test.ts`） | 07-9 |
| feedback-copy | `apps/web/lib/learning-companion/feedback-copy.ts`（+ `feedback-copy.test.ts`） | 07-9 |
| 配套（Global Shell 服务层） | `apps/api/src/modules/companion-shell/`（shell-actions、auth-surface、routes、service、capability-deployment 等） | 07-2/07-3/03-5 |

## 2. 注册/登录静态伴星与首次引导（07-1，佐证 DoD 7、9、10）

- `onboarding-state.ts` + 组件接线：注册/登录/找回账号页伴星只做静态或轻量状态说明（产品用途、登录与无障碍帮助），不读取凭据、不调用个性化模型、不建画像、不请求麦克风（佐证 DoD 9 的公开认证层边界；签名静态 allowlist 见 `w1` 证据 02-5 与 `companion-shell/auth-surface.ts`）。
- 首次引导：账号级设置邀请只发一次（三个同级动作"带我走一遍 / 我自己看看 / 先调整方式"，无弱化颜色/倒计时/二次挽留/"推荐"角标）；引导六步（认识边界 → 调整相处方式默认"安静" → 选择起点 → 示例流程 `onboarding_sample:*` → 可信交接 `publishedTargetEligibility=false` → 明确结束）；引导结束后"从我的内容开始 / 去星图看看 / 结束引导"，不自动开始正式航程（佐证 DoD 10）。
- onboarding CAS：scoped-token + revision CAS 恢复（`not_offered→offered` 唯一 display permit、consumed 单调不被系统重放、offered 不重弹）；`onboarding_sample:*` 物理隔离、无 published eligibility，对 assessment/mastery/exposure/schedule 与正式星图为 0（佐证 DoD 10；CAS 判定层测试见 `w1` 证据 02-2/02-8）。

## 3. 全路由 coverage 与页面动作治理（07-2，佐证 DoD 11、12）

- `page-coverage-registry.ts`：`CompanionPageCoverageRegistryV1` 覆盖 public-auth 与 authenticated 全部可路由页面（首页/内容库/Source/Note/Card Set/Card/Key Point/全屏验证/Review/此刻/星图/工作台/搜索/导入/生成/邀请/验证/MFA/SSO/设置/隐私/账号安全/成员/密钥/错误/离线/internal/admin）；`CompanionPageCoverageEntryV1`（routePattern/pageKind/surfaceMode/sensitivity/manifestVersion+Hash/manualFallbackTestId/owner）；子路由仅当 sensitivity 与 action allowlist 完全相同才可显式继承，未分类/隐式继承/manifest hash 失效在 CI/启动时失败；router 与 registry 100% 对账（佐证 DoD 11）。
- 页面职责矩阵：页面切换/权限/workspace 变化使旧 action stale，跨页可恢复 origin；未接入或 Companion 故障时手动主路径完整（佐证 DoD 11）。
- `companion-shell/shell-actions.ts`：所有 Companion 页面写入动作带影响预览、current context/permission/capability 重验、nonce/idempotency 与用户确认，由所属 domain service 执行；Global Shell 直接领域写入为 0（佐证 DoD 12）。

## 4. 触发仲裁与建议预算（07-3，佐证 DoD 14）

- `trigger-arbitration.ts`：`CompanionTriggerRuleV1`（reasonId 为 bounded registry enum，never model-authored；sourceEventType/allowedPresenceLevels/allowedPageKinds/requiredCapabilityIds/suppressionModes/stableContextKeyPolicy/cooldownPolicyId/actionManifestId）；policy 缺失或 hash 不匹配时主动提示 fail closed，被动召唤与页面原生功能仍可用。
- 双预算：`contextBudgetKey = user + stablePageContextKey + cooldownEpoch`、`reasonBudgetKey = user + workspace + canonical target/origin + targetChangeEpoch + boundedReasonId + cooldownEpoch`；一次提示在同一数据库事务内验证 suppression/policy/capability → 唯一约束插入双 key → 获取 account-scoped 短 TTL `activeSuggestionLease` → 签发一次性 `CompanionSuggestionPermitV1`；任一冲突整体回滚且前台不渲染；dismiss/离开/TTL 释放 lease 但不退还已消费预算；`targetChangeEpoch` 仅服务端按规则单调增加（佐证 DoD 14：多标签/多设备同时最多一条，刷新与非 canonical 变化不重置资格）。

## 5. 存在感与控制状态（07-4，佐证 DoD 30）

- `presence-control.ts`：三档存在感（quiet 未召唤时只有静态中性锚点且完整 entity context/idle 动画为 0，除一次性 consent surface 外主动提示为 0；moderate 只对恢复/可恢复错误/stale/committed change 给一次邀请；active 允许一条有原因说明的下一步/路线但不自动开始）；无论哪档不自动开麦、不自动进入下一题、无红色倒计时或任务债务。
- 控制状态：page_muted/page_context_off/focus_until_task_end/suggestion_paused/temporary_hidden/global_off/animation_off/voice_output_off 作用域明确；`temporary_hidden` 持久布尔只留设备本地（`deviceSessionId + surfaceEpoch` ephemeral runtime-fence），`global_off` 通过 `/me/companion` account revision CAS 并向全部 active device session 广播 fence，CAS 失败如实报告"仅本设备已隐藏"；context-off/hidden/off 后 observer/context 构造为 0，hidden/off 后角色/声音/邀请/预取/新增后台调用与迟到结果采用为 0（佐证 DoD 30；客户端侧 `companion-control-state.ts`/`page-companion-context.ts` 见 `w4` 证据 05-5）。

## 6. 四入口与学习卡主行动（07-5，佐证 DoD 25）

- 学习卡前台只保留一个主行动"开始/继续一小段航程"，不把"动/试"做成平级玩法菜单；朗读/查看证据/问一问（当前 target 有界 Tutor detour）为内容工具，朗读/查看/Tutor 按实际暴露记录 exposure，随后开始航程遵守 assistance cooldown。
- 四入口（star_map/card/review/now/scoped Tutor detour）共享 Session/Episode 内核、origin-aware completion；每处可"在星图查看"但不强制跳转；`four-entry-origin.ts` 实现与 PREPARE 冻结语义见 `w5` 证据 §7（佐证 DoD 25）。

## 7. 星图两平面与关系治理（07-6，佐证 DoD 28、29）

- `star-map-projections.ts`：两个数据平面分离——共享知识真值（Source/Note/Card/Key Point/Evidence 与确定性血缘，workspace-owned，唯一变化来源 canonical Publish）与个人学习事实及投影（validation/review outcome、能力切面、assistance，user-private，唯一变化来源 canonical 学习事实 + outbox/replay）；公测只展示确定性血缘，relation hints 不画成共享语义边，不宣称"关系理解"正式状态；长期投影由 canonical facts + outbox 重放得到同一 hash；浏览/打开/停留/收藏/朗读/看过答案不能点亮理解，facet 变化必须能追到合格 assessment；不展示伪精确"掌握度"（佐证 DoD 28、29）。
- `relation-governance.ts`（§10.5，非阻塞 Should flag）：candidate（relation hint/Tutor proposal/user proposal）→ 独立 relation support check → authorized human confirm|reject → versioned publish + fingerprint + audit → 上游变化 stale 支持撤回重审；个人 workspace 由 owner 确认；所有来源只能提议 candidate，candidate 为虚线且不进入 formal target（佐证 DoD 28 的 Should 边界；flag 关闭时不可见）。

## 8. Grounded Tutor 与有界 detour（07-7，佐证 DoD 27）

- `tutor-detour.ts` + `roles/grounded-tutor.ts`：Grounded Tutor 是当前 Learning Session 内的**有界 detour**，绑定 `sessionId + episodeId + targetId + questionId`，一次一个问题、公测最多两次澄清；Must 结束动作只有"返回原航程 / 结束"；输出优先证据卡/对比 Scene/条件变式/短解释，前台无无限滚动聊天历史、不存在独立无限 message API。
- 答案按支持层级拆分，公测 Must 只开放"当前 target"（canonical evidence 直接支持或有界推导，推导段标记 `derived_from_current_target` 并绑定 premise refs）；`roles/grounded-answer-critic.ts` 对每个 segment 做 mandatory `supported / partial / unsupported` 检查，`derived_from_current_target` 必须绑定 premise refs 与推导类型；unsupported 在扩展 flag 关闭时只能 abstain（引用完整不等于语义支撑通过）（佐证 DoD 27）。
- trusted → practice 原子切换：用户在"让我试试"中索要知识帮助只能呈现"切换到一起学习"确认动作，确认后由原子 `enter_practice_mode` 先记录 assistance/exposure 再开放 Tutor 权限；Agent 不能代点；Tutor 只能提议生成新卡/关系 candidate，必须用户确认并经 Generation Supervisor/Relationship Governance（Tutor 直接写掌握/卡片/关系为 0）。

## 9. 跨设备恢复与偏好/文案（07-8/07-9，佐证 DoD 14、30、31）

- `cross-device-recovery.ts`：跨页只携带有界任务摘要、`originRef`、合法 entity refs 与已确认 checkpoint；跨设备同步 onboarding 终态、global off、存在感/suggestion suppression、学习目标与合法 Session checkpoint，不跨设备同步 temporary hidden/page mute、未提交输入、原始音频或临时敏感内容；新设备在 presence/trigger 允许时至多询问一次"继续上次任务/暂不恢复"，展示 target 名称前重查 workspace/权限/内容 revision/policy/assistance/capability；同一 Session 多设备显式接管或只读提示，不能双重提交；登录过期重新认证回原页面与合法 checkpoint，不重放旧权限 action（佐证 DoD 14、30 侧）。
- `session-preferences.ts`：本轮上下文（3/10/20 分钟、精力、挑战偏好、输入模态、聚焦/混合）默认只要求目的地；本轮精力不长期保存、不进 mastery/scheduler；长期偏好（默认输入优先级、禁用 Encounter、反馈风格、存在感、静音/专注、动画/语音输出、全局关闭、临时隐藏、suggestion classes、挑战倾向、单主题/交错、时长/每周负荷/时间窗/通知边界、TTS 语速/字幕/音效/reduced-motion/A11y、原始音频保留）全部可查看/修改/重置/导出/删除；Agent 只能提出 suggested preference，不能静默改变。
- `feedback-copy.ts`：反馈文案具体、可行动、非身份化；不存在 XP/streak/排行榜/每日清空/任务债务/随机奖励/内容锁/体力墙/伴星失望催促文案（佐证 DoD 31）。

## 10. 判定层证据

- 决策记录 `07-1`~`07-9` 头部状态均为 **Frozen（已冻结）**；阶段 07 退出 Gate 6 项全部勾选（router 100% 对账、四入口一致且就地完成、Tutor 直接写为 0、credential/跨 workspace 泄漏 0、hidden/off 后零监听零调用、workspace/扩展 Tutor 与 semantic relation 保持非阻塞 Should）。
- 阶段 07 执行记录：apps/api 2195/2195、packages/shared 374/374、packages/db 5/5、apps/web 674/674、workers typecheck、git diff --check 通过；security_review 1 轮 warn（nonce 仅非空校验 / together 分支谎报权限 / accountEpoch 缺省 0）→ 修复后复查 **pass**（nonce 服务端一次性校验、权限真实开放、accountEpoch 必填）。
