# 冻结记录 01-6：测试、故障与安全矩阵基线（§17）

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 01 W0 执行）
> 日期：2026-08-07
> 来源：`01-w0-contracts-and-baseline.md` 任务 01-6（原方案 §17）
> 约束级别：基线冻结；W7/W8 按此执行。

## 1. 任务定位

**交付物**：必测行为清单与故障矩阵（W7/W8 执行）。

**忠实性说明**：本记录按原方案 §17 全文冻结。源文档任务 01-6 的必测行为为要点摘录；凡摘录未列出、但原方案 §17.1 含有的必测行为条目，均已按原方案补全并以「*（原文 §17.1 补充）*」标注；未标注条目即摘录与原文一致。

## 2. 必测行为清单（§17.1）

以下为原方案 §17.1 完整清单，逐条冻结；W7/W8 测试计划必须逐条覆盖：

1. **credential 页零采集 fuzz**：public-auth 与 authenticated credential 页的签名 manifest、字段/焦点/长度/粘贴/自动填充/时序 fuzz；认证数据流入 Companion DTO / RSC / hydration / cache / 日志 / analytics / 模型为 0；防枚举归一错误码，只提供纯静态帮助。
2. **首次引导全路径与 CAS 竞争**：首次引导完整流程、一步跳过、每步返回/暂停、刷新/重登/跨设备恢复、manual replay、版本升级和老用户 quiet/off；`not_offered→offered` 双标签/双设备 CAS；CAS 成功但首帧前崩溃不重弹；offer consumed 单调；scoped resume token/expiry；旧设备不能回退终态。
3. **onboarding sandbox 隔离**：`onboarding_sample:*` namespace 物理隔离、`publishedTargetEligibility=false`、demo map 还原；对 assessment/mastery/exposure/schedule 为 0；own-content 分支先终止 sandbox，并进入正常 capability/exposure 合同。
4. **router 与 coverage registry 对账**：router 全量 route 与 `CompanionPageCoverageRegistryV1` 对账、`PageCompanionContextV1`/action manifest、四种 surface mode、移动端收起、未接入 fallback、未保存离页保护和关闭后手动主路径。
5. **trigger 双预算与多设备竞争**：`CompanionTriggerRuleV1` registry、presence reason 映射、context/reason 唯一约束 + account suggestion lease + permit 的多标签/多设备事务竞争、`targetChangeEpoch`、onboarding 独立预算、稳定 cooldown 与 suggestion class suppression；quiet/page-muted/context-off/focus/paused/hidden/off 和 formal/录音/输入/拖拽期间 0 非法内容建议。
6. **quiet 零主动面与完整 context 升级门**：quiet 静态锚点、零 idle 动画、显式召唤后短 TTL context；moderate/active 只用 `CompanionTriggerContextV1`，permit + 接受后才升级完整 context。
7. **认证/安全/权限/破坏性确认不依赖伴星**：认证、安全、权限和破坏性确认在 Companion hidden/off 时仍由页面原生 UI 完整展示，且不消费 Companion budget。*（原文 §17.1 补充）*
8. **stale action 与多设备恢复/接管**：页面切换、workspace/角色切换、权限撤回和 contextVersion 变化后的 stale action；跨设备恢复前重验与多设备显式接管。
9. **上下文关闭零传输与 action 重验**：当前页面上下文关闭后的零 entity/context 传输；页面 action 的影响预览、nonce、permission/context 重验、domain service 再鉴权和 Global Shell 零直接写。*（原文 §17.1 补充）*
10. **audit/ledger 用途隔离与 TTL**：Companion page/action audit 与 invitation ledger 的用途隔离、TTL expiry、content-free tombstone、导出/删除、全存储残留扫描和删除后不重新打扰。
11. **hidden/off 边界**：device-local hidden 与 ephemeral runtime-fence、account global-off CAS/epoch fanout/active-device lease expiry/CAS 失败诚实状态；确认后的页面 observer/context、预取、Companion Provider/job 与迟到结果为 0；domain import/generation 可手动移交、Tutor 必须取消、已锁 formal core 只 drain 的分离。
12. **新设备 account bootstrap**：新设备认证后的 account state bootstrap；global off 解析前不挂载 authenticated Companion surface；未登录页只使用不关联身份的 local hide。
13. **A11y 焦点/读屏/zoom**：onboarding tooltip/侧板焦点不陷阱、跳过一级动作、关闭后焦点返回、读屏 live region、200% zoom 与 390 px 不遮挡。
14. **语音 Teach-back 全流程**：语音 Teach-back、重录、确认、低置信和切模态。
15. **`structured-proof-v1` bundle 完整性**：`structured-proof-v1` 全 bundle、缺一 Scene、跨模态公平性，以及 ordering/graph/repair 的 formal/practice 两态。
16. **Public Scene 零 private 字段**：Public Scene 的 network/RSC/prefetch/cache/DOM 零 private contract/solution/rubric/evidence 字段。
17. **assistance 先写后返回**：用户请求提示时 assistance 先写后返回内容。
18. **多标签并发 reveal/lock/submit**：同一 target 在多标签页/多设备并发 reveal/lock/submit。
19. **legacy/new exposure 竞态三组**：legacy reveal → new Episode lock、new reveal → legacy submit、Scene/Rubric/policy rollover 三组共享 `contentExposureKey` 竞态。
20. **lock 后不可变**：first artifact lock 后 rubric/target/evidence 不能改变。
21. **Supervisor turn/deadline 上限**：Session Supervisor 最多 follow-up、最大 turns 和 deadline。
22. **Critic mandatory**：Critic mandatory，Supervisor/Tutor 不能代签。
23. **multi-Episode partial commit**：multi-Episode partial commit/stale/cancel。
24. **schedule exactly-once 与 successor**：input schedule exactly-once、恰好一个 successor、facet-only 零 schedule side effect。
25. **disposition 矩阵**：并发 `create_initial`、`consume_pending` exactly-once；完整 `record_only/no_effect` disposition 矩阵；未到期 user-selected 与 early-review policy。
26. **semantic relation 不可经验证路径 published**：semantic relation candidate 无法通过验证路径 published（启用 Should flag 时）。
27. **hidden-answer 负向权限**：companion hidden-answer 工具负向权限。
28. **问题标记 RLS**：问题标记 user-private/RLS/export/delete（启用 Should flag 时）。
29. **四 origin 就地完成**：Card/Review/Now/Star 四种 origin 的就地完成、可选查看星图和事件驱动变化。
30. **无键盘主路径**：所有入口无键盘主路径。
31. **无任务债务文案**：长时间回归无任务债务文案。
32. **`temporary_hidden`/`global_off` 完整边界**：`temporary_hidden` 时手动产品完整，当前 device session 的页面 context listener/DTO、角色/声音/应用内邀请/应用内通知/预取/后台调用为 0，另行 opt-in 的系统 push 偏好不变；`global_off` 时上述边界扩展到全部设备，且 Companion 系统 push 为 0。*（原文 §17.1 补充）*
33. **transcript 治理**：transcript revision、raw audio TTL、全复制面 transcript redaction/残留扫描、semantic re-audit 与 learning-result/schedule invalidation。
34. **kill/cancel/stale/publish 与 COMMIT 交错**：kill/cancel/stale/publish 与 COMMIT 的双顺序交错、late Provider/Critic response、soft drain 与 legacy reader compatibility。
35. **root capability 反向依赖闭包与原子 apply/rollback**：root capability 关闭的反向依赖闭包、单 config revision 原子 apply/rollback、任一节点失败整体回滚，以及运行中从不暴露非法 flag 组合。

## 3. 故障矩阵（§17.2）

以下为原方案 §17.2 完整故障矩阵，逐行冻结；W7/W8 故障注入测试必须逐行覆盖：

| 故障 | 预期行为 |
| --- | --- |
| Global Shell/角色资源失败 | 页面、认证和全部手动功能先加载；降级为静态帮助或完全不显示，不阻塞主任务 |
| auth-surface manifest 无效 | fail closed 为无伴星的标准认证页；不得改用模型生成帮助或读取表单 |
| page context/action token stale | 拒绝动作，刷新净化上下文；未保存内容、workspace 和权限状态不被绕过 |
| onboarding 中断/登录过期 | 保存已确认步骤；重新认证后只用 scoped token + revision CAS 从合法 step/origin 恢复，offer consumed 不回退或被系统主动重放 |
| 多设备同时恢复同一 Session | 后进入设备明确选择接管或只读；未接管设备不能提交 |
| hidden/off 后 Companion late response | 丢弃且不渲染、不写状态、不触发后续 job；必要的 locked formal core 只按原 contract 完成 |
| ASR timeout/low confidence | transcript 未确认，`not_assessable`；允许重录/换模态，无理解副作用 |
| Session Supervisor crash | 从 contract/probe/artifact/event 恢复，不重做已锁输入 |
| Critic unavailable | `evaluation_retryable`，不由 Supervisor 替代 |
| formal budget unavailable before start | 不展示 Scene、不收回答，给出非惩罚稍后/换 practice 路径 |
| budget/Provider incident after answer lock | 使用预留 envelope 或进入有 SLA 的 recovery queue；超时 operational-only，0 学习副作用 |
| Grounded Tutor unavailable | trusted 主链仍可完成，额外问题可稍后恢复 |
| duplicate tool/response | artifact 与副作用 exactly-once |
| Card/Key Point/Evidence 更新 | 对应未提交 Episode stale，保留历史，无 mastery/schedule 写入 |
| cancel/断线 | 持久化事件恢复，不重复 Provider 和 commit |
| raw audio storage failure | transcript 确认前停止 voice lock，可重录或走 silent bundle；确认后 raw audio 丢失不影响 canonical transcript/outcome |
| vector/retrieval failure | 当前-target Tutor 直接用 published exact evidence；Should 搜索层关闭，不扩大或伪造来源 |
| star overlay failure | 静态路线卡/列表回退，理解内核不受影响 |
| cross-tenant/forged ID | 拒绝并记录安全事件 |
| publish/commit 响应丢失 | 同一 canonical result 和 schedule，0 重复副作用 |
| privacy/trust/scheduler hard incident | bump runtime epoch、fence 全部未 commit Episode、取消未完成外部 job，禁止 trusted 恢复 |
| late result after hard kill | 仅低敏审计摘要，不写可恢复 probe/artifact/assessment staging |

## 4. hard invariant 100% 通过要求

- 关键 **crash、retry、cancel、stale 和并发** 场景必须重复执行，hard invariant 必须 **100% 通过**（W7/W8 通用硬性要求，非抽样软指标）。
- 覆盖场景至少包括：kill/cancel/stale/publish 与 COMMIT 双顺序交错、late Provider/Critic response、Session Supervisor crash、duplicate tool/response、cancel/断线、publish/commit 响应丢失、late result after hard kill、多标签/多设备并发 reveal/lock/submit、schedule 与 disposition 并发 exactly-once、root capability 关闭与 config revision 原子 apply/rollback。
- 任一次重复执行出现 hard invariant 破坏即视为该场景失败，需修复并全量重跑通过后才允许进入下一阶段。

## 5. 验收标准

- 必测行为清单与故障矩阵作为 W7/W8 的测试、故障注入与验收基线，已随本记录冻结；
- W7/W8 按本记录第 2、3 节逐条/逐行执行，第 4 节 hard invariant 重复执行必须 100% 通过；
- 本记录即 W7（audit/observability）与 W8（quality/capacity/RC）的验收基准；如后续任何工作文档与本文不一致，以本文（冻结）为准。

## 6. 补全说明（相对源文档任务 01-6 摘录）

以下内容为源文档摘录未单独列出、按原方案 §17.1 补全的必测行为条目（均已写入上文对应小节并标注）：

- §17.1：认证、安全、权限和破坏性确认在 Companion hidden/off 时仍由页面原生 UI 完整展示且不消费 Companion budget（本记录第 7 条）。
- §17.1：当前页面上下文关闭后的零 entity/context 传输，页面 action 的影响预览、nonce、permission/context 重验、domain service 再鉴权和 Global Shell 零直接写（本记录第 9 条）。
- §17.1：`temporary_hidden` 时手动产品完整及 device session 零监听/零调用边界、`global_off` 扩展到全部设备且系统 push 为 0 的完整表述（本记录第 32 条）。
- §17.2 故障矩阵整体以原方案表格为准：源文档摘录为要点文本，本记录按原方案 §17.2 表格逐行冻结（本记录第 3 节）。

> 本记录与「项目知识/原方案 §17」共同构成该基线；冻结内容以本记录为准。
