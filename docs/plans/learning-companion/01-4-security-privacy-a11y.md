# 冻结记录 01-4：安全、隐私、无障碍与可靠性规则（§13）

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 01 W0 执行）
> 日期：2026-08-07
> 来源：`01-w0-contracts-and-baseline.md` 任务 01-4（原方案 §13）
> 约束级别：规则冻结；W1/W6/W7/W8 分别实现与验证。

## 交付物

答案泄漏边界、音频/transcript 治理、RLS 攻击面、A11y 硬门禁、降级与恢复规则。

## 13.1 答案泄漏边界

trusted 提交前，前台 Companion DTO、RSC/hydration、prefetch、cache 和 DOM 不得包含以下任何内容：

- private contract 字段
- 完整 claim 结论
- secret solution
- 正确映射或 distractor 身份
- hidden rubric
- expected target
- private evidence/quote
- 历史正确答案或相同题目反馈
- 能排除错误项的内部 gap verdict
- Tutor 提示内容

例外与约束：

- 经 `scene-safety-v1` 批准、完成操作所必需的 public token 可以出现，但必须属于 `PublicSceneContract` allowlist。
- public token 的 `disclosureProfileHash` 进入 template trust ceiling 和 `FrozenProbeRef`。
- 公开 token 暴露的内容不得再被计作无提示 recall。
- DOM Gold 同时校验 public allowlist 与 private denylist，不能只做粗暴 substring 禁止。
- 安全依赖 schema 与工具权限，不依赖模型"自觉不泄题"。

## 13.2 音频与 transcript 治理

- raw audio 加密、user-private、短 TTL，默认不进入长期备份。
- 用户确认的 transcript 是 canonical answer，raw audio 不是 canonical assessment 输入；确认后删除或 TTL 到期不改变既有 trust/outcome。
- transcript、transcript/audio hash、ASR version/confidence 属于敏感学习数据，进入导出与删除边界。
- 音频、transcript、题面、答案不进入普通日志、Prometheus label 或 analytics payload。
- ASR/TTS Provider、model、region、retention、training-use policy、consent version 和 data category 固定到 artifact/contract。
- 关键术语无法可靠识别时进入 `not_assessable`，不以模型猜测补全。
- 用户可随时关闭语音：关闭后不上传音频，仍有静音 canonical 路径。
- 删除 raw audio 只结束声音复核能力，不影响已确认 transcript。
- 删除 transcript 将 artifact 标为 `redacted`，不能同时宣称该 assessment 仍可做完整语义重审。
- 级联 redaction 覆盖：artifact transcript/segments/hash、assessment `answerExcerpt`、复述用户答案的 Critic rationale、Tutor/Critic job payload、retry payload、对象引用与 cache。
- assessment rationale 默认内容最小化：只存 reason code 和必要的 rubric/evidence ref。
- 删除后对数据库、对象存储、队列与 cache 做内容扫描，用户答案残留为 0，仅保留不含内容的 tombstone ID、删除原因、policy/version 和历史 outcome ref。
- 回放分两级：
  - canonical event/assessment 可确定性重放既有 outcome 与投影；
  - 只有未 redacted artifact 才能被新版 Critic 做 semantic re-audit。
- 用户删除对应学习结果时系统写 compensating invalidation event，不改写历史事件。
- official scheduler 在同一事务 supersede/cancel 由该结果派生的 current pending schedule，再依据剩余有效事实产生恰好一个 active schedule。
- UI 在删除前明确展示 raw audio、answer content、learning result 三种删除影响。

## 13.3 RLS 与攻击面

- credential 页面的账号、密码、验证码、token、私有输入及字段焦点/长度/粘贴/自动填充/时序元数据进入 Companion DTO、RSC/hydration/cache、analytics、日志、模型请求、截图或持久上下文必须为 0。
- 未登录页最多保存一个设备本地布尔值，不关联 user/workspace/登录标识/错误历史/学习数据。
- `PageCompanionContextV1`、页面 manifest 和 action token 做 schema、版本、签名/来源、workspace、permission snapshot、contextVersion 与 allowlist 校验；页面切换后 stale action fail closed。
- workspace/角色切换原子清空全局任务上下文；跨 workspace entity refs、onboarding resumeRef 和邀请 key 不得复用。
- account-scoped Companion 表只按认证 user_id 授权。
- workspace-scoped Companion/学习表用 workspace_id + user_id 双条件 RLS。
- device-local hide 不写持久表，runtime-fence 仅保留 user/device session/surface epoch/TTL。
- 共享知识真值继续使用 workspace-owned 策略。
- prompt injection、伪 evidence/node/token/option ID、跨版本引用、音频替换和 replay 攻击 fail closed。
- drag/order/scenario payload 校验 allowlisted IDs、数量、版本和 hash。
- semantic relation candidate 不能通过回答接口变成 published。
- Scene Author、伴星、Tutor、Grounded Answer Critic、Session Supervisor、Rubric/Scene Critic 和 Assessment Critic 使用不同工具 allowlist。
- `temporary_hidden` 本地生效且 runtime-fence 确认后：当前 device session 的页面 observer、context DTO、角色、应用内邀请/声音/预取与新增 Companion job 为 0。
- `global_off` CAS 后还要求：所有设备 lease 失效、Companion 系统通知和跨设备调用为 0。

## 13.4 A11y 硬门禁

- 首次引导"跳过"在每一步都是视觉、键盘和读屏同级动作。
- 引导可返回、暂停、恢复和主动重播，不用困住焦点的 tooltip 链。
- 伴星锚点、当前上下文、建议原因、忙碌/退场和页面 action 均有语义标签；关闭面板后焦点回到原触发位置；live region 只播报必要状态。
- 所有支持 voice 的 Key Point 有零打字 canonical 路径；所有 Key Point 有 `text_or_mixed` canonical fallback；profile-eligible 目标另有通过跨模态 Gold 的零语音零打字 `structured-proof-v1`。
- 所有拖拽有 tap-select-place、键盘和 Switch 等价操作。
- screen reader 可理解节点、关系、路线、Scene 和结果。
- 颜色、空间位置和动画不是唯一信息载体。
- 触控目标至少 44×44 CSS px。
- 200% zoom 不丢功能。
- 390/768/1440 三视口无主路径阻断。
- reduced-motion 完整支持。
- 语音输出默认不自动播放；可暂停、重听、确认 transcript 和切换模态。
- 无倒计时评分、无操作速度评分。
- 麦克风权限拒绝后可进入 text 或 eligibility 合格的 structured proof，不出现操作死路。

## 13.5 降级与恢复

- Global Companion Shell 不可用时：认证、导航、导入、设置和所有学习页面仍有标准手动入口。
- 页面未注册或上下文 stale 时：伴星只提供通用导航/静态帮助。
- Companion/Tutor 不可用时：用户仍可进入现有 question-first 验证或已审核手动 Scene。
- ASR 不可用时：eligibility 合格目标可切换触控结构操作，其余切换文字。
- 向量召回不可用时：current-target Tutor 使用 `PublishedLearningAssetContractV1` 精确证据，不扩大搜索不伪造来源。
- Assessment Critic 不可用时：进入 `evaluation_retryable`，不由 Supervisor 代签。
- star overlay/动画故障时：降级为列表和静态路线卡。
- 降级不能把 practice 提升为 trusted，也不能减少 evidence/coverage 资格。
- Tutor 降级只用于发布后短时故障：current-target Tutor 仍是正式公测 Must，未通过其 Grounded Answer Gate 时 W9 不得设为 public-beta default；workspace/扩展 Tutor 不在该阻塞条件内。

## 验收标准

规则冻结；W1/W6/W7/W8 分别实现与验证。
