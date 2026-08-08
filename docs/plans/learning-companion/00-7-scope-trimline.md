# 决策记录 00-7：版本范围与删减线冻结（§14）

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 00 执行指令）
> 日期：2026-08-04
> 来源：`00-decision-and-scope.md` 任务 00-7（原方案 §14）
> 约束级别：Must/Should/Could 与删减线作为 W0 冻结输入的组成部分；Should 不进入公测关键路径。

## 交付物

Must / Should / Could / 删减线清单（W0 冻结输入的组成部分）。

---

## 1. Must 清单（正式公测的最小完整闭环）

以下为源文档原文（§14）Must 段落，逐字保留：

> `LearningSession` 编排容器、单 Key Point `LearningEpisode` canonical 单元和四阶段确定性外壳；`PublicSceneContract / PrivateSceneSolution / PrivateLearningEpisodeContract` 物理分离、formal probes 首次回答前全部冻结；Response Artifact、服务端 effective Trust Class、Rubric/Scene Critic、独立 Assessment Critic、deterministic reducer/commit；`Global Companion Shell` 从注册/登录覆盖全部可路由页面（coverage registry、credential-safe 静态 manifest、`CompanionTriggerContextV1/PageCompanionContextV1` 最小化升级、页面 action token、`CompanionTriggerRuleV1`、双预算、origin 恢复、静态 fallback）；versioned 首次使用引导（开始/返回/暂停/跳过/CAS 恢复/manual replay；隔离 `onboarding_sample:*` 且 `publishedTargetEligibility=false`；own-content 先退出 sandbox）；伴星学习会话层 typed actions + quiet/moderate/active + 页面静音/专注/暂停建议 + device-local temporary hidden + account-scoped global off；统一拟人化动画基础角色、`CompanionVisualStateV1`、typed-action 动画映射、`assessment_handoff`、静态与 reduced-motion fallback；语音 Teach-back（TTS/ASR/用户确认/not-assessable/隐私闭环）；universal `text_or_mixed` canonical fallback；versioned `SilentProofProfile` registry + eligibility matrix + 跨模态 Gold 验证的 `structured-proof-v1`（合格目标至少两个互补预冻结无中途反馈 Scene 完整覆盖 required rubric 获得同级 canonical outcome 资格）；Structured Scene DSL、deterministic safety、A11y 等价操作、禁止任意生成 UI；Formal/Practice/Diagnostic/Not-assessable 数据和视觉彻底分离；`stabilize/clarify` 完整闭环、单 Key Point `transfer` 最小切片、practice-only explore；学习卡一个主行动；Card/复习/"此刻"/星图进入同一 Session/Episode 内核并按 origin 就地完成；Grounded Tutor 仅当前 target evidence-grounded 有界 detour、始终 practice-only；星图两个数据平面、确定性血缘、Card/Key Point 行动入口、真实结果回写；key-point 能力切面与时间耐久分离；official scheduler 唯一写入权（FSRS 可 shadow 不阻塞）；显式输入/反馈/伴星/A11y 偏好；account-scoped onboarding/global off/presence/suppression 跨设备一致、workspace 邀请/任务状态不越界、device-local hidden 不泄露身份；非强迫恢复、明确结束、无自动续题；RLS、assistance、stale、幂等、取消、恢复、导出、删除和回滚；真 Provider、ASR、数据库和浏览器 Gate。

逐条展开（全部条目，无删减）：

1. `LearningSession` 编排容器、单 Key Point `LearningEpisode` canonical 单元和四阶段确定性外壳。
2. `PublicSceneContract / PrivateSceneSolution / PrivateLearningEpisodeContract` 物理分离；formal probes 首次回答前全部冻结。
3. Response Artifact、服务端 effective Trust Class、Rubric/Scene Critic、独立 Assessment Critic、deterministic reducer/commit。
4. `Global Companion Shell` 从注册/登录覆盖全部可路由页面：coverage registry、credential-safe 静态 manifest、`CompanionTriggerContextV1/PageCompanionContextV1` 最小化升级、页面 action token、`CompanionTriggerRuleV1`、双预算、origin 恢复、静态 fallback。
5. versioned 首次使用引导：开始/返回/暂停/跳过/CAS 恢复/manual replay；隔离 `onboarding_sample:*` 且 `publishedTargetEligibility=false`；own-content 先退出 sandbox。
6. 伴星学习会话层 typed actions + quiet/moderate/active + 页面静音/专注/暂停建议 + device-local temporary hidden + account-scoped global off。
7. 统一拟人化动画基础角色、`CompanionVisualStateV1`、typed-action 动画映射、`assessment_handoff`、静态与 reduced-motion fallback。
8. 语音 Teach-back（TTS/ASR/用户确认/not-assessable/隐私闭环）。
9. universal `text_or_mixed` canonical fallback。
10. versioned `SilentProofProfile` registry + eligibility matrix + 跨模态 Gold 验证的 `structured-proof-v1`：合格目标至少两个互补预冻结、无中途反馈的 Scene 完整覆盖 required rubric，获得同级 canonical outcome 资格。
11. Structured Scene DSL、deterministic safety、A11y 等价操作、禁止任意生成 UI。
12. Formal/Practice/Diagnostic/Not-assessable 数据和视觉彻底分离。
13. `stabilize/clarify` 完整闭环、单 Key Point `transfer` 最小切片、practice-only explore。
14. 学习卡一个主行动。
15. Card/复习/"此刻"/星图进入同一 Session/Episode 内核并按 origin 就地完成。
16. Grounded Tutor 仅当前 target evidence-grounded 有界 detour、始终 practice-only。
17. 星图两个数据平面、确定性血缘、Card/Key Point 行动入口、真实结果回写。
18. key-point 能力切面与时间耐久分离。
19. official scheduler 唯一写入权（FSRS 可 shadow 不阻塞）。
20. 显式输入/反馈/伴星/A11y 偏好。
21. account-scoped onboarding/global off/presence/suppression 跨设备一致、workspace 邀请/任务状态不越界、device-local hidden 不泄露身份。
22. 非强迫恢复、明确结束、无自动续题。
23. RLS、assistance、stale、幂等、取消、恢复、导出、删除和回滚。
24. 真 Provider、ASR、数据库和浏览器 Gate。

---

## 2. Should 清单

源文档原文（§14）Should 段落，逐字保留：

> 故障定位与修复、反例构造；问题标记手工保存/归档/解决/路线 origin（Agent 只能提议）；Grounded Tutor 的 workspace evidence 检索与标注扩展说明；Relationship Governance、published semantic relation、关系透镜、个人关系理解、跨 Card/Note challenge；航程回放和个人学习变化时间轴；更丰富的代码/公式/图表/参数沙盘；显式偏好建议和单主题/交错复习；本地或端侧 ASR 可行性；达独立 Gate 后 feature-flagged FSRS 正式接管。

逐条展开（全部条目，无删减）：

1. 故障定位与修复、反例构造。
2. 问题标记手工保存/归档/解决/路线 origin（Agent 只能提议）。
3. Grounded Tutor 的 workspace evidence 检索与标注扩展说明。
4. Relationship Governance、published semantic relation、关系透镜、个人关系理解、跨 Card/Note challenge。
5. 航程回放和个人学习变化时间轴。
6. 更丰富的代码/公式/图表/参数沙盘。
7. 显式偏好建议和单主题/交错复习。
8. 本地或端侧 ASR 可行性。
9. 达独立 Gate 后 feature-flagged FSRS 正式接管。

---

## 3. Could 清单

源文档原文（§14）Could 段落，逐字保留：

> 伴星配色/服饰/声音/轻量动作个性化；用户自建和收藏路线；手写/图形化/摄像头实物演示；经授权 Web 检索与引用；可分享不比较成绩的路线模板；更丰富环境音和主题（默认关闭）。

逐条展开（全部条目，无删减）：

1. 伴星配色/服饰/声音/轻量动作个性化。
2. 用户自建和收藏路线。
3. 手写/图形化/摄像头实物演示。
4. 经授权 Web 检索与引用。
5. 可分享不比较成绩的路线模板。
6. 更丰富环境音和主题（默认关闭）。

---

## 4. 删减线（容量不足时依次裁剪，1→7）

源文档原文（§14）删减线段落，逐字保留：

> 伴星外观个性化/环境音/非状态必需复杂动画 → 航程回放和学习时间轴 → 反例构造/复杂代码/公式场景 → 问题标记和 Relationship Governance 整体保持 Should → 跨 Note 迁移只保留单 Key Point transfer 切片 → Grounded Tutor workspace/扩展层只保留当前 target → 超出 eligibility coverage 的丰富 Scene 类型（最小 SilentProofProfile registry 只有仍满足冻结覆盖门槛才能缩减）。

裁剪顺序（容量不足时依次裁剪，1 → 7）：

1. 伴星外观个性化/环境音/非状态必需复杂动画。
2. 航程回放和学习时间轴。
3. 反例构造/复杂代码/公式场景。
4. 问题标记和 Relationship Governance 整体保持 Should。
5. 跨 Note 迁移只保留单 Key Point transfer 切片。
6. Grounded Tutor workspace/扩展层只保留当前 target。
7. 超出 eligibility coverage 的丰富 Scene 类型（最小 SilentProofProfile registry 只有仍满足冻结覆盖门槛才能缩减）。

---

## 5. 不可裁剪清单

源文档原文（§14）不可裁剪段落，逐字保留：

> Global Companion Shell、可跳过且零学习副作用的首次引导、全部可路由页面 coverage registry 与净化 context/action manifest、credential 零读取、关闭后零监听/调用、Episode 事务单位、public/private contract 分离、Formal/Practice 分离、Response Artifact、双 Critic、deterministic commit、语音确认/隐私、universal text fallback、eligible silent canonical profile、assistance/stale、official scheduler、星图真实回写、origin-aware completion、当前 target Tutor、统一拟人化基础角色及必要状态动画、明确结束、非强迫规则和全部安全/RLS Gate。若这些无法完成，应推迟版本而不是降低可信性。

逐条展开（全部条目，无删减）：

1. Global Companion Shell。
2. 可跳过且零学习副作用的首次引导。
3. 全部可路由页面 coverage registry 与净化 context/action manifest。
4. credential 零读取。
5. 关闭后零监听/调用。
6. Episode 事务单位。
7. public/private contract 分离。
8. Formal/Practice 分离。
9. Response Artifact。
10. 双 Critic。
11. deterministic commit。
12. 语音确认/隐私。
13. universal text fallback。
14. eligible silent canonical profile。
15. assistance/stale。
16. official scheduler。
17. 星图真实回写。
18. origin-aware completion。
19. 当前 target Tutor。
20. 统一拟人化基础角色及必要状态动画。
21. 明确结束。
22. 非强迫规则和全部安全/RLS Gate。

**兜底约束**：若上述不可裁剪项无法完成，应推迟版本而不是降低可信性。

---

## 6. 验收标准

1. Must / Should / Could 与删减线冻结。
2. Should 不进入公测关键路径。
