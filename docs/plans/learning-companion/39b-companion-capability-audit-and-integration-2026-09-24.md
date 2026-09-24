# 伴星能力调研与统一学习系统接入方案

> 日期：2026-09-24
>
> 地位：方案 39 的代码调研与设计附件；发现、目标设计与验证状态分别记录。本文没有实施运行代码，也不把历史审计的结论当成已经成立的产品决定。
>
> 覆盖：伴星现状与接入（§1–§8）；原方案 40 的供给侧设计与输出闸处置已于同日并入 §9–§14，原 40 文档已删除，伴星侧的跨文档编号一律以本文为准。
>
> 主文档：[理解引擎完整产品方案](./39-adaptive-note-learning-system-prd-2026-09-24.md)。

## 1. 结论与改造边界

伴星已经有真实工具、动作提案、记忆、主动消息和语音链路，不是只有人格提示词的聊天框。主要短板是各链路的目标身份、上下文、执行结果和学习事实没有完全贯通。统一模型调用只能减少少量重复，不能单独解决这些问题。

本次应同时完成三件事：抽取公共 Agent 运行基础；让伴星、页面与学习卡调用相同业务能力；让伴星能在同一学习任务内持续教学、恢复进度并解释实际结果。人格、Live2D、语音和陪伴节奏保留为伴星的专属呈现，不作为新的业务事实源。

应现在确定上下文、动作、产物、帮助记录、记忆和送达的合同，按阶段接通；不为防止未来返工而提前建设通用插件平台、任意工作流或多 Agent 社会。

学习卡侧的完整执行设计见 [39c：生成到作答与复习的 AI 链路重做](./39c-card-ai-lifecycle-rebuild-2026-09-24.md)。伴星调用其中同一生成、教学和回答评估能力；不能只共用制卡入口，却继续在聊天里维护另一套提示、判分或结果提交逻辑。

## 2. 已有能力：保留什么

| 能力 | 当前代码可确认的基础 | 本次处理 |
| --- | --- | --- |
| 对话与工具执行 | 工具注册、参数校验、有限循环、动作提案和结果记录 | 抽取运行共性，保留业务约束；不能直接把整个伴星运行器作为公共内核 |
| 材料与页面感知 | 笔记搜索/读取、页面 broker、读图/显示图片、图示工具 | 补全读取范围、页面覆盖和版本一致性 |
| 学习协作 | 启动/恢复、暂停、提示、切换任务变体、延期动作桥 | 改成明确对象且不依赖卡片；与页面共用领域服务 |
| 记忆 | 空间/用户过滤、偏好跨空间规则、候选与忽略过滤、向量检索和关键词回退 | 保留；补足任务身份、冲突与修订关联，不能用记忆代替表现证据 |
| 主动性 | 例行与触发式消息区分、节奏、静默配置、展示反馈与收件箱 | 复用统一下一步信息；区分到达与弹出/朗读 |
| 语音与形象 | 分段合成、音频时钟驱动字幕、取消、失败回报和文本降级 | 保留；将语音关联同一内容与任务，补跨入口中断及帮助记录 |

主要依据：[工具登记](../../../packages/shared/src/companion-agent-registry.ts)、[动作桥](../../../apps/api/src/modules/companion-conversation/learning-action-bridge.ts)、[记忆抽取](../../../workers/ai-worker/src/handlers/companion-memory-extractor.ts)、[记忆召回](../../../workers/ai-worker/src/handlers/companion-memory-vector.ts)、[主动策略](../../../packages/shared/src/companion-proactive-policy.ts)、[语音播放](../../../apps/desktop-client/src/renderer/src/app/companion-voice-playback.ts)。既有文档中早期记录的语音失败、忽略记忆仍召回等问题，不能直接当作本轮仍存在的缺陷。

## 3. 当前缺陷与新方案缺口

分类：**代码缺陷**表示当前合同/调用可确认不一致，不表示已经用真实数据库复现；**结构缺口**表示当前实现无法充分支撑目标体验；**待实测**表示尚不能断言实际发生频率。P0/P1 是本方案实施优先级，不是线上事故等级。

### C1 · P0 · 学习动作没有明确目标，仍依赖卡片（结构缺口）

工具 `companion_start_learning`、`companion_resume_learning` 的参数均为空。运行器 `buildActionPayload` 为恢复选择最近更新的运行，为开始选择最近更新且有 active 卡片的目标。这不能可靠表达“继续昨天那篇”或“学眼前这篇没有卡的笔记”；存在多个对象时也不能把“最新”当成用户指代。

改造：开始接受可验证的笔记/目标引用和范围；恢复接受明确 runId。上下文唯一且匹配用户请求时直接用，多个匹配时给少量候选，缺失时说明缺失。不得生成假卡来满足入口。依据：[工具合同](../../../packages/shared/src/companion-agent-registry.ts) 的 start/resume；[运行器](../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts) 的 `buildActionPayload`。

### C2 · P0 · 任务列表漏掉正在进行的任务（代码缺陷）

`companion_list_task_queue` 查询 `pending/presented/in_progress`；当前 `LearningTask` 合同使用 `pending/active/answered/skipped/completed/stale`，run-service 创建当前任务时写入 `active`。因此这条查询会排除 active 任务。现有待办文案不能被当成可靠的统一下一步入口。

改造：移除伴星独有的任务状态与推荐查询口径，复用主系统的可访问任务投影；实际运行、待回访、已授权待办要区分。依据：[运行器](../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts) 的 `companion_list_task_queue`、[任务合同](../../../packages/shared/src/learning-run-contracts.ts)、[运行服务](../../../apps/api/src/modules/learning-runs/run-service.ts) 的 `learningTasks` 写入。

### C3 · P0 · 到期查询与延期动作不能完整衔接（代码缺陷与结构缺口）

`companion_defer_review` 必需 scheduleGeneration；`companion_list_due_reviews` 返回 scheduleId、cardId、标题和逾期时长，没有这个版本参数。不能要求模型猜 generation。该查询还内连接 active 目标与卡片，无法支撑新方案的无卡回访；结果中的“无卡”分支不消除这个依赖。

改造：查询返回权威安排引用、版本、可执行动作及必要限制；延期调用唯一调度服务，并校验提交时版本。对象过期则刷新并解释变化，不能自动把确认应用到另一项安排。用户明确要求延期且符合权限策略时可在伴星内完成，不必额外导航点击。依据：[工具登记](../../../packages/shared/src/companion-agent-registry.ts)、[运行器](../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts) 的 due/defer。

### C4 · P0 · 当前页面上下文有两条来源，覆盖不完整（结构缺口）

客户端 `bridgePageContext` 提供页面、实体、敏感状态与 readableView；同文件普通 turn 的 `pageContext` 只为 today/queue/graph 提供简要信息，正式作答另走 grant。运行器能通过 read_current_page 读取 broker，但自动组装上下文与工具读取并非天然一致。当前 `usePageReadableView` 调用分布在 5 个组件文件，覆盖 6 种视图，笔记阅读/编辑和结果页等仍需补齐，不能以“已有页面工具”推断全站可读。

改造：以请求所属页面实例和空间为锚，使用同一版本化上下文；页面摘要负责“我在哪”，正文按需读。选区、未保存草稿和已保存笔记分别标识；正式学习用冻结快照。切页后明确是继续原任务还是指向新页，不按全局最新时间戳跨窗口选上下文。依据：[客户端上下文](../../../apps/desktop-client/src/renderer/src/app/companion-chat-session.tsx)、[turn 保存](../../../apps/api/src/modules/companion-conversation/turn-service.ts)、[即时上下文](../../../workers/ai-worker/src/handlers/companion-here-and-now.ts)。

### C5 · P1 · 有读取工具，但不能完整读长材料（结构缺口）

`companion_read_note` 正文最多 3000 字符，有 truncated 标记，却只有 noteId 输入，没有章节或继续读取游标；图片引用列表也有上限。当前工具表没有来源正文读取工具。反复调用同一个读取工具不能解决“解释最后一节”或“对照原文这一段”。

改造：共用材料读取能力，按章节/片段分页，返回稳定定位、版本、截断与下一段；图片也可定位和分页。来源没有解析或无权限时明确说明。读取更多内容受预算限制，不能谎称已读全文。文档中的命令只是材料内容，不改变用户授权或运行规则。依据：[运行器](../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts) 的 `NOTE_READ_MAX_CHARS`、`companion_read_note`；[工具表](../../../packages/shared/src/companion-agent-registry.ts)。

### C6 · P0 · 对象别名和宽泛参数会继续传播旧模型（结构缺口）

`open_card` 接受 cardId，却同时按 card_id/objective_id 查询；`focus_graph` 的 keyPointId 实际查 objective_id；`plan_route` 的 request 是任意记录。它们能暂时接旧系统，却不适合作为笔记、目标、卡片与安排分离后的公共能力合同。

改造：使用有类型的实体引用与领域输入校验；同一引用能从读取结果传给动作，无需模型改名、猜 ID。迁移调用方后移除旧别名，不新增一套永久兼容工具。依据：[工具表](../../../packages/shared/src/companion-agent-registry.ts)、[运行器](../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts) 的 open_card/focus_graph、[动作桥](../../../apps/api/src/modules/companion-conversation/learning-action-bridge.ts)。

### C7 · P0 · 正式提示有受控入口，普通聊天帮助仍需统一记录（结构缺口；影响范围待实测）

已有 request_hint 动作走 LearningRun，正式辅导使用授权上下文，并跳过普通记忆召回，这是应保留的基础。在检查的普通对话/运行器输出路径中，未见把自由生成的讲解、图示和语音统一关联为相应目标的帮助事实；因此不能据“正式提示按钮受控”宣称所有入口都能维持独立作答条件。

改造：用户请求当前题的具体帮助时，经同一教学能力产生内容，并关联目标修订、任务和产物。区分生成、呈现与实际作答；读取材料给模型不等于用户看到答案，重复播放不产生新的学习表现。已呈现的相关帮助跨页面关联，不能通过换入口清掉。未能确认呈现结果时保留未知状态，暂不认定独立证据；恢复后对账。无需监控应用外行为。

不能仅用“答案原文是回复的子串”判断暴露，改述、图示和语音同样可能给出帮助；普通鼓励、重复题面也不应自动当泄题。依据：[动作桥](../../../apps/api/src/modules/companion-conversation/learning-action-bridge.ts) 的 request_hint、[辅导上下文](../../../apps/api/src/modules/companion-conversation/learning-run-context.ts)、[对话编排](../../../workers/ai-worker/src/handlers/companion-dialogue.ts)。

### C8 · P1 · 记忆有空间边界，但 task scope 不等于绑定某个任务（结构缺口）

当前 `deriveMemoryScope` 按页面种类选择 task/workspace；向量与关键词查询均允许当前 scope，却没有以本次 runId/taskId 限制 task 记忆。即使有 memory_links，所检查召回查询也没有用它约束本任务。可能在同空间内召回别轮学习的临时上下文；语义相关性不能代替身份约束。

改造：临时任务信息绑定具体任务或目标版本，缺少绑定时不能默认为全任务通用。偏好、用户自述、模型推测、正式学习观察分别带来源；冲突时优先当前明确表达与当前权威记录。旧的“这次没懂”不能覆盖后续已确认的表现。遗忘/纠正传播到召回和摘要，不改写正式历史；撤销材料权限后不能经旧摘要再读出正文。依据：[上下文编排](../../../workers/ai-worker/src/handlers/companion-context-orchestrator.ts)、[两种召回路径](../../../workers/ai-worker/src/handlers/companion-memory-vector.ts)。

### C9 · P1 · 意图判断与执行修补增加延迟和分支（结构复杂度；效果待实测）

`companionNeedsTool` 增加一次最长 8 秒的模型判断，失败返回 null；运行器以 `=== true` 处理。运行器还承担文字缓冲、动作引导、结果措辞检查等职责。代码说明有额外调用与分支，不能据此给出未经测量的失败率或宣称删掉后一定更快更准。

改造：明确的页面命令直接调用同一任务；自然语言由对话工具选择处理，不将额外意图分类器设为所有任务必经阶段。权限允许写入只说明“能做”，不说明用户“要做”。成功状态与事实结果由服务端回执呈现，模型负责解释；无回执不能展示成功。先用现有坏例、人工场景和各实际 provider 的小批样本验证替代机制，再删失去作用的修补链。依据：[分类器](../../../workers/ai-worker/src/handlers/companion-tool-intent.ts)、[运行器](../../../workers/ai-worker/src/handlers/companion-agent-runtime.ts)。

### C10 · P0 · 提醒送达与正式作答安静需要明确衔接（合同缺口；最终打扰待实测）

共享策略中 triggered 提前返回，不检查 formalAnswerInProgress/静默时段；这是当前“约定提醒不受例行频率限制”的设计。客户端另有页面安静、形象显示和语音开关。仅凭服务端允许不能证明实机一定打断，但新方案必须消除不同层对“送达”的不同解释。

改造：约定消息按时进入持久收件箱，不被例行频率丢弃；正式作答/录音期间不自动弹出教学线索或朗读，结束后合并提示待看消息。已有安静时段中约定提醒的例外要如实展示；勿扰、用户主动询问与到点提醒各自有明确规则，不把音量、形象隐藏和订阅取消混为一事。依据：[主动策略](../../../packages/shared/src/companion-proactive-policy.ts)、[最终展示](../../../apps/desktop-client/src/renderer/src/components/companion/CompanionPresence.tsx)、[语音播放](../../../apps/desktop-client/src/renderer/src/app/companion-voice-playback.ts)。

## 4. 本次一起设计的能力提升

| 用户请求/情境 | 目标行为 | 复用位置 | 交付 |
| --- | --- | --- | --- |
| “这段到底什么意思？” | 定位当前选区/片段，基于可访问材料解释并可回到原文 | 材料读取、引用与教学任务 | 阶段一 |
| “继续昨天没弄懂的那篇” | 暂停轮次恢复原位置，已结束轮次则以遗留问题新开；歧义时只询问缺失项 | 学习运行与个人历史 | 阶段一 |
| “换个例子，别再讲定义了” | 保留当前目标与已知帮助，生成不同表达并留回本轮 | 教学任务与产物 | 阶段一 |
| “我只有五分钟” | 提议缩小本轮范围，可记录部分完成，不能偷偷删订阅 | 计划修订与下一步投影 | 阶段一 |
| “把刚才容易混的地方做成卡” | 携带明确范围调用同一制卡任务，返回可审核候选 | 简化制卡、去重与审核 | 阶段二 |
| “这项明天再提醒；以后别给我排了” | 区分本次延期和持续停订，展示对象与结果，复用权威调度 | 调度与授权服务 | 单次阶段一，持续阶段二 |
| “你为什么觉得这里还要练？” | 引用对应观察、帮助条件和日期，允许纠正；没有依据就说不知道 | 个人学习观察与下一步投影 | 阶段一 |
| “我已经改了这篇笔记” | 区分当前修订与历史快照，不沿用已失效的薄弱点断言 | 变更影响与历史 | 阶段一 |
| 生成很久，用户换页/打断 | 任务有可见进度与持久结果；停止朗读、停止对话、取消生成分别处理 | 公共运行事件、产物引用 | 阶段一基础，制卡阶段二 |
| 星图里问“这两篇为什么有关” | 解释已记录的关系与依据；建议确认关系，不自己改掌握度 | 星图关系服务 | 阶段三 |

上述“阶段一”限定在首期支持的材料与教学类型内，不承诺任意学科、任意动画或联网研究。能在短对话中清楚回答就直接回答；完整讲解、练习与保存动作有稳定的页面结果，不要求用户重复口述。

## 5. 防止返工的最小公共合同

本节规定语义，不要求按名称新建表或微服务。优先扩展已有合同，未发生真实复用的能力不提前抽象。

| 合同 | 必须保持一致的内容 |
| --- | --- |
| 上下文与实体引用 | user/workspace、请求入口、页面实例与版本、材料定位/快照、目标与任务；可用权限来自服务端，页面文本不成为授权 |
| 动作请求与回执 | 明确业务对象、输入版本、用户意图/适用确认、幂等键；区分待确认、执行中、成功、部分完成、失败、取消/过期；结果含实际业务记录与可恢复入口 |
| 教学与制卡产物 | 类型、归属、依据、内容版本和呈现位置；同一份内容可在主纸面、聊天摘要、图示或语音中使用，不各生成一份互相漂移的答案 |
| 帮助与学习观察 | 提供/呈现的帮助、受影响目标修订、回答和评估分别记录；聊天推测不直接写成能力事实 |
| 记忆与偏好 | 来源、适用空间/具体任务、有效性、纠正/遗忘；学习状态回读权威观察，不作为另一份记忆评分缓存 |
| 消息与播放 | 内容生成、持久送达、可见呈现、音频播放各自状态；正式作答注意力策略在最终输出前执行，不能仅靠模型提示词 |
| 伴星输出守卫 | 只允许三类判据：集合包含、封闭词表、结构；不新增以中文措辞为判据的守卫。数字与事实由服务端填充；删一条守卫需反事实重放台 `still-leaks=0` 与真实流量连续 0 触发两份证据（§9–§10） |

后台教学生成/制卡需要持久执行；即时对话允许更短超时与预算。共用核心，不强制共享一条队列；取消对话不能默认撤销已经提交成功的业务动作。草稿修改需预览差异和版本检查；已成功的安排变更应走新的撤销/修改动作。

普通选区问答没有现成学习轮次时，产物留在对话并保留材料引用，不自动造一轮学习历史；用户明确开始学习后再关联到笔记旅程。未保存草稿只支持标明版本的临时讨论，正式任务遵守主文档 §3.4。帮助与回答以锁定顺序对账，提交后正常反馈不追溯改变原回答的条件。结束学习默认继续处理已受理评估，明确取消评估才停止该任务；提醒暂停、目标排除与单次改期按主文档 §9.1 分别处理。

## 6. 原方案 40 的并入记录与不采用清单

原方案 40《伴星供给侧重构：拆闸，不加闸》（2026-09-24）已于同日并入本文并删除原文档。并入理由：伴星供给侧重构不是独立补丁，而是统一 Agent 体系下伴星侧的同一批工作；两份同日方案在同一批文件上各写一套编号（C1–C10 / P1–P6 / B0–B7）会让实施重复或漏做。

并入去向：

| 原 40 的内容 | 现位置 |
| --- | --- |
| 11 道输出闸的分布与逐条去向、4 处 prompt 授权句、3 条结构判据 | §9.1–§9.2 |
| 机制 P1 实体先行解析（`<this_turn_facts>`） | §9.3 |
| 机制 P2 读数由服务端填充（`{{f:key}}` span 目录） | §9.4 |
| 机制 P3 动作通道收口（`tool_choice:required`、删分类器） | §9.5（与 C9 合并） |
| 机制 P4 感知补全与词表统一（16 页、四套词表收一） | §9.6（与 C4、C5 合并） |
| 机制 P5 暴露接入（写 `learning_exposures_v2`） | §9.7（与 C7 合并） |
| 机制 P6 工具面判决（原"今天成立"与"等 39 采纳"两栏） | §9.8 统一按主文档 §17 的阶段归入，不再单列"等采纳"栏 |
| 反事实重放台、逐闸台账、棘轮 | §10 |
| 批次 B0–B7、验收、已知会漏、前置与环境限制 | §11–§14 |

以下 7 条是并入时**明确不采用**的原 40 处方，作为裁定记录保留：

| 议题 | 本文取舍 |
| --- | --- |
| 用“存在可写工具且有权限”强制调工具 | 不采用。问候/知识提问也可能拥有写权限，不能由权限推导操作意图 |
| 事实占位符与数字真实性 | 统计/动作状态优先用带口径和时间的结构化结果；引用用实际定位。模板可辅助展示，不能证明任意自由文本不造数，也不能禁止教学例子里的正常数字 |
| 用逐字匹配判断答案暴露 | 不作为唯一机制。使用任务关联、帮助来源与实际呈现，覆盖改述/图示/语音；单纯重复题面不等于泄题 |
| 伴星不能改安排等于只能导航 | 不采用。伴星可承接授权命令并调用同一领域服务；不能自行决定用户未授权的写入 |
| 主纸面承载教学等于聊天不能画图 | 不采用。短图示可以就地帮助；完整产物可保存、回访并关联本轮 |
| 依赖 30 天线上数据才允许替代 | 不设为固定前置。本项目尚未上线，使用可用历史样本、构造场景与受控模型验证；不伪造真实流量结论 |
| 当前表能装下所有新学习语义 | 不预先保证。先核无卡目标、修订和呈现状态能否表达，再按主文档 §15.4 决定 schema 调整 |

## 7. 端到端演练与验收

以下是目标行为演练，不是已运行成功的集成结果。

1. 打开无卡笔记的末节，问“用图说明这里”：上下文定位末节，按需续读，图示带引用留在对话；已有学习轮次并明确在该轮求助时才保存到本轮。不能只读前 3000 字回答，也不能由普通问答自动创建学习轮次。
2. 打开另一篇笔记，说“继续刚才那轮”：若“刚才”明确指向原轮次则恢复原轮，不选择全空间最新卡片；多轮歧义给候选。切空间后没有材料权限则阻止读取和旧摘要泄露。
3. 正式作答时说“举个类似例子”：同目标教学内容关联帮助记录；用户看到帮助后提交，结果按借助条件记录。文字已呈现但语音失败仍算已呈现，全部未送达则不凭生成成功认定已帮助；呈现未知不签发独立证据。
4. 此时约定提醒到点：收件箱有记录，页面不突然朗读；结束后看到待处理提醒。同一事件不产生两份安排或两次完成。
5. 说“把刚才混淆的两点做成卡”：携带原目标与材料版本启动共同制卡任务；换页仍可找到候选，保存前可核对，不默认持续复习。
6. 说“把这项推到明天”，同时另页已经改期：服务端拒绝旧版本并展示新日期，不猜 generation、不延到另一项。确认成功后网络重试恢复同一回执。
7. 用户说“不要记住这次临时状态”：召回与后续摘要遵守遗忘范围，正式学习历史仍可查；另轮 task 记忆不因同空间自动注入。
8. 用户只有问候但有全部可写权限：自然回应，不启动学习、不修改设置。用户问实际完成数则使用带计数口径与时点的查询结果。
9. 用户停止说话播放：立刻停止朗读；制卡是否继续有清楚状态，不能把“停止声音”理解成撤销已保存卡片。

验收同时观察正确对象、真实完成、上下文连续性、帮助记录、恢复和重复写入；再量首个有效反馈时间、整任务耗时、模型调用/成本、无谓确认次数。确定性用例要求无错对象/越权/重复提交；开放教学质量人工核查，每个 provider 的失败分开统计。不设未经基线测量的性能达标数字。

## 8. 本轮验证与尚未证明的内容

编写本附件时核查了工具合同、运行器、学习动作桥、页面上下文、记忆召回/抽取、主动策略与语音播放代码，并阅读相关既有方案。当时实际运行 worker 的现有 `companion-agent-runtime`、`companion-context-orchestrator`、`companion-grounded-evidence`、`companion-tool-intent`、`companion-memory-extractor` 五个测试文件：**67 项通过，0 失败**。后续文档复审不把这份既有结果重复算作新功能验收。

这些单元测试只能证明已有测试覆盖的行为通过，未覆盖 C2/C3 的业务合同错配不因此消失。本轮未启动数据库复现、真实 provider 端到端、桌面多窗口或麦克风/扬声器实机验证；未测量当前完整任务成功率与改造后的性能收益。后续实施需要将 §7 场景落成跨工具/服务验收，不能仅用工具单测数宣称闭环完成。

阶段一纳入 C1–C4、C6–C7、C10 的相关主路径，以及 C5 长材料读取、C8 任务记忆、C9 简化运行的最小适配；阶段二完成制卡与持续调度；阶段三扩展星图关系陪伴。这里的排序不允许把错误对象、帮助漏记和用户约定消息处理推迟为外观优化。

## 9. 伴星输出闸与供给侧重构（并入自原方案 40）

> 本节至 §14 由并行会话对伴星运行器的代码审计并入。代码坐标按编写时核对（工具注册表 31 项、11 道闸的函数行号、四个循环常量均已复量）。这四条硬约束适用于统一运行基础下的伴星输出。

1. **不新增任何以自然语言措辞为判据的输出守卫。** 允许新增的判据只有三种形状：集合包含（输出 ⊆ 本轮来源集）、封闭词表（内部 token 名，从注册表生成）、结构（长度／未闭合括号／JSON 信封）。
2. **删一条守卫要有证据。** 证据 = 反事实重放台判"这条闸的历史触发全部已被供给侧覆盖"（`still-leaks=0`）+ 真实流量连续 0 触发；两条缺一不删。
3. **删完不许让她变成"不敢说话"。** 每条守卫退休都要同时给出"她还能说什么"的路径（preflight 给了事实／工具还在面上／读不到就明说读不到），并带反向验收：她没有因为守卫缺失而被判成"这轮不许作答"。
4. 供给（她说什么，§9.1–§9.7）与工具面（她能做什么，§9.8）分开设计。

### 9.1 现行 11 道输出闸：分布与逐条去向

11 道按**触发前提**分三类：

| 类 | 判据 | 前提 | 数量 |
|---|---|---|---|
| A：只在"没有工具"时成立 | G1 `unverifiedNumericClaims`（`companion-dialogue-content.ts:527`）、G2 `claimsNothingDueAgainstFacts`（`:509`）、G3 `claimsLookupThatNeverRan`（`:485`）、G4 `looksLikeUnfulfilledActionNarration`（`:436`）、G6 `unverifiedQuoteClaims`（`:569`），全部汇进 `planStepSteer` | 硬前提 `stepCalls===0 && toolCallCount===0`（`companion-agent-runtime.ts:160-164`） | 5 |
| A′（同一前提的弱版） | G5 `looksTruncatedReply`（`:409`）→ repair ladder | `calls.length===0 && !stepEmitted && replyIsTruncated`（`:3031-3039`） | 1 |
| B：输出形状，与工具无关 | G7 `containsCompanionInternalToken`（`:187`）、G8 `looksLikeJsonEnvelope`（`:111`）、G9 `looksLikeJsonFragment`（`companion-dialogue-stream.ts:106`） | 无 | 3 |
| C：念头链，那里根本没有工具 | G10 `introducesUnverifiedNumbers`（`companion-thought.ts:252`）、G11 `readsOutStatistics`（`:397`） | 无 | 2 |

共同形状：**她一句话把这轮结了（没有工具），而那句话需要一个出处。** 现在的反应是在输出侧追问（正则扫正文，扫到再补一步，必要时换兜底模型），天花板受限于"追模型的措辞"。

逐条去向（四种：保留／被替代后删除／直接删除（前提消失）／降级为已知会漏）：

| # | 判据 | 现在靠什么判 | 去向 | 依据 |
|---|---|---|---|---|
| G1 | `unverifiedNumericClaims` | 数字＋量词正则，再比上下文集 | P2 落地后删除 | 正文数字面收窄到服务端填充的 span，无出处数字没有出口 |
| G2 | `claimsNothingDueAgainstFacts` | 两条中文交替 × 环境块那个数 | P1 落地后降级为已知会漏 → 下版删 | P1 之后"到期列表是空的"是**与环境块矛盾**的话，不是措辞问题；残留漏口不补 |
| G3 | `claimsLookupThatNeverRan`（3 块模式） | 中文动词×宾语×完成体 | P1 落地后删除 | 假阴性动机是"手上什么都没有"；P1 把"库里没有匹配，最接近的是《Y》"变成她手上有的话 |
| G4 | `looksLikeUnfulfilledActionNarration` | 14 条承诺措辞 + ≤24 字 | P3 落地后删除 | 中文不标时态；P3 之后那一步没有 prose 通道 |
| G5 | `looksLikeTruncatedReply` | 长度线 + 未闭合括号／裸数字尾巴 | 保留 | 结构判据，是 repair ladder 的唯一入口（`:3038`） |
| G6 | `unverifiedQuoteClaims` | 逐字比对来源集 | 保留并升级 | 判据不因换措辞失效；P2 之后来源集多一项 `fact_spans` |
| G7 | `containsCompanionInternalToken` | 内部标记 + uuid + `companion_[a-z_]{4,}` | 保留，改成从注册表生成 | 手写词表必然漂（工具名漏口补过一次） |
| G8 | `looksLikeJsonEnvelope` | 首字符／结构 | 保留 | 结构 |
| G9 | `looksLikeJsonFragment` | 结构 | 保留 | 结构；流式路径唯一防线 |
| G10 | `introducesUnverifiedNumbers` | 数字 token 集包含 | P2 落地后删除 | 念头链也走 span，她不再抄数字 |
| G11 | `readsOutStatistics` | 数字 + 统计量词形状 | P2 落地后删除 | 形状判据的极限：`《IndexTTS 2.5》` 必须放过，永远要靠 `withoutQuotedNames` 打补丁（`:390-397` 的注释就是一条漏报的事故报告） |

两条轴别混：分类按**触发前提**，去向按**判据质量**。"同一个前提下的闸要一起留或一起删"是错的直觉，删的依据只能是判据质量。

### 9.2 同时要拆的 4 处 prompt 授权句 + 新增 3 条结构判据

prompt 里写着规则、代码不去核对，等于没写。4 处从"叮嘱"改成"机制"：

| 位置 | 现在 | 改成 |
|---|---|---|
| `companion-dialogue-content.ts:902-940`（C 层前言） | "用户没问…就不要报数字…别念原值" | 撤掉禁令，改成"要报任何读数就写 `{{f:key}}`，不写具体数值"——没问的键不在本轮目录里，她想违规也没有对象 |
| `companion-agent-registry.ts:93`（`list_due_reviews` 描述） | "不要把数字主动报给用户" | 同上；描述只保留"什么时候该调它" |
| `companion-here-and-now.ts:655` | 到期数留给 G2 用 | P1 之后 `due_count` 同时是 span 和环境块一行，**两个读数同一个来源**（不许出现第二份） |
| `companion-tool-intent.ts:29-34`（分类器 system prompt） | 判断是否需要工具 | 整文件删除（P3） |

新增 3 条静态判据，都不判她说了什么，判"代码长回原样会不会红"：

- `companion-gate-ratchet.test.ts`（新）：数出导出且被 runtime 调用的判据函数个数，钉成 `GATE_BASELINE`，断言方向唯一——只允许调低。判据按 `export function 名字(` 的形状匹配（import 行会喂出假绿），这条测试自己要先红一次（把已删函数加回去必须红）；每删一条闸，基线同格减一，减不到就是没删干净。
- **consequential 写工具必须能指名对象**：扫 31 个注册项里 `riskClass === "consequential"` 的 7 个，参数 schema 必须含 ≥1 个 required 的 uuid／已登记实体引用，且不许 `z.record(z.unknown())`。今天会红三处：`companion_plan_route`（`:105`）、`companion_start_learning`、`companion_resume_learning`（`:98,99`）。范围刻意收在 consequential——`companion_cancel_reminder` 的 `reminderId` 可选是有意设计，放宽到 `reversible_low` 会把有意项一起误伤。
- **id 语义不许跨表**：每个工具的参数名要能在执行体找到同名表／列，在 `tool()` 里显式登记「参数名 → 目标表.列」，没登记即红。`companion_focus_graph` 的 `keyPointId` 今天打的是 `learning_objectives_v2.objective_id`（`runtime:1375,1382`），必须红。

### 9.3 P1 实体先行解析 —— 替代 G3、压住 G2

原事故：用户问「为啥第四张学习卡这么慢」，她拿 `list_task_queue` 的真读数推出一个假结论——两个工具都答对了，问题问的是第三个东西。

做法：回合读阶段（`loadHereAndNow` 那次事务里，不新开连接）跑确定性解析器，把用户这句话**指到的实体**先查出来。

- 指称语法封闭 5 条（扫的是**用户输入**，不是她的输出）：① `《X》`／`「X」` 括号内的字面标题；② 序数指代 `第[一二三…N]张/条/篇/个` → 当前可读视图的 `items[].ordinal`（`companion-bridge-contracts.ts:437`）；③ 代词 `这篇/那篇/这条/那张/它` → 当前视图 `title`，取不到不解析；④ 上一轮工具结果里出现过的显式 id（`companion_agent_tool_calls.arguments` 真参数已落库，migration `0213:88-115`）；⑤ 裸标题 → 已有按词 AND 逻辑（`noteSearchTerms`，`:400-406`）。
- 一次事务批量查 notes／cards／reminders／memory／due reviews 五类，上限 6 个指称 × 5 类，**总预算 ≤ 120 ms**，超预算丢弃本轮 preflight 不拖回合（拿 `/ready` 那把尺量）。
- 产出块 `<this_turn_facts>`：命中给"找到，id=…，状态=…，关键读数…"；**未命中给"库里没有匹配；最接近的是《Y》（相似度…）；候选工具：…"**。第二行是本机制的价值所在——"没有这篇"由服务端替她说完了，还附赠一个更接近的真东西，她没有编造的必要。
- 该块进 `keepRecomputedBlocks` 白名单（`:576-580` 现只有 4 个块），由本轮重算，不会把她的谎洗成回忆。
- **工具面一条不减**：漏接方向是安全的（preflight 没解析出来 → 她照常调工具 → 与今天一致）。
- 扫用户输入不算"扫措辞"：方向不同，漏一次代价是退回调工具；用户措辞是有限、稳定、可枚举的分布，规则 ②③④ 靠结构化数据（ordinal／id）而不是词。

### 9.4 P2 读数由服务端填充 —— 替代 G1、G10、G11

照抄本项目已验证过的形状：日记「她只给编号，真货由服务端带」（`companion-daily-summary.ts:1568-1571`，测试 `companion-daily-summary.test.ts:351-353`）。

- 回合开始 `buildFactSpans()` 产出一个本轮 span 目录 `{ key, value, askable }`（`today_minutes`／`week_minutes`／`due_count`／`card_count`／`streak_days`），顺带在 P1 那次事务里出，不额外查库。
- **`askable` 由用户输入决定**（有没有疑问词＋量词的组合），未 askable 的键根本不出现在 prompt 里——"没问就不要报数"从叮嘱＋形状闸变成**没有可报错的对象**。
- 她写 `{{f:today_minutes}}`，服务端在下发前渲染；未知键沿用日记策略：丢那半句、留正文、warn，不整体失败、不漏 `{{f:...}}` 到屏幕上。
- **环境块随之瘦身**（`今日已学 42 分钟` 这类撤出）。**唯一前置**：`due_count` 的 span 与 `到期待复习 N 项` 那行必须同源同一次查询，撤的是重复来源，不是数据本身。
- 做完后她正文里的数字只有三种来源：① 服务端 span；② 用户自己说的话；③ 名字里的数字（`withoutQuotedNames` 那条例外变成不需要）。

### 9.5 P3 动作通道收口 —— 替代 G4、删除分类器（并入 C9）

现状成本：`companionNeedsTool` 一轮一次额定 LLM 调用（`companion-tool-intent.ts:8-45`，8 秒超时，异常返回 `null`；调用点 `:2700` 判据 `=== true` ⇒ **null 与 false 同路 = fail-open**）；最多 4 步主循环（`AGENT_LOOP_MAX_STEPS = 4`，`:207`）＋终答宽限 2 步；最多 2 次 steer；动作轮整段攒住（`BUFFERED_STEP_HOLD_CHARS = 1_000_000`，`:100`）。而 `tool_choice:"required"` 是 provider 原生能力、已在契约里端到端透传（`card-agent-contracts.ts:189`、`openai-compatible.ts:605-607`，dashscope preset 与 GLM 同路径）——一次布尔分类去决定"要不要用原生机制"，是拿钱买一个本来就能要的东西。

- **顺序先测再删。** S1 探针取 30 天 `tool_choice` 曾为 required 的轮＋人工构造的动作请求轮，分模型（qwen／GLM 分开）量 ① required 下返回 0 个 tool_calls 的比例、② 返回的 tool_calls 里参数不合 schema 的比例。判决线：**① < 2% 才允许删 G4 与分类器**；不达标退 P3-alt。`providers/mock.ts:67` 完全忽略 `toolChoice`，任何"required 生效"的测试必须先给 mock 补分支。
- 达标后：删 `companion-tool-intent.ts` 整文件；`userRequiresTool` 换成确定性判据 `writeToolsOffered && permissionAllowsWrite`；参数可满足性看本轮 `<this_turn_facts>` 里有没有动作需要的 id；该步 `toolChoice:"required"`，不产 prose。连带可删攒住的动作档、steer 的 2 次档、`planStepSteer` 的 `userAskedForAction` 输入。
- **必须同步补**：`tool_choice` 目前只在 tools 非空时发出（`openai-compatible.ts:605`），要加断言**同一请求里不许同时出现 `tools:[]` 与 `toolChoice:"required"`**（2026-09-22 那 3 次 `INTERNAL_ERROR` 里 2 次的成因，`:3090-3111`）。
- **P3-alt（S1 不达标时；独立于 S1 结果，属必做）**：分类器留着，但 `null → 按 true 处理`（宁可安静几秒，不要把一句没兑现的话落到屏上）。

### 9.6 P4 感知补全与词表统一（并入 C4、C5）

先修正四处计数（一处一个来源）：

| 原 doc 37 说法 | 实测 | 出处 |
|---|---|---|
| §4「首批接线的六个页面」／§7.4「其余 11 个页面」 | **5 个调用点覆盖 6 页；未登记 16 页** | `CardGenerationSurface.tsx:771`（`:729` 按 page 分出 candidate／card_generation 两个 pageId）、`StudySurface.tsx:612`、`ReviewSurface.tsx:885`、`graph-surface.tsx:527`、`HomeV2ObjectLayer.tsx:224` |
| §7.1「`PAGE_KIND_LABELS` 那 9 个」 | **10 个 key** | `companion-here-and-now.ts:556` |
| §7.2「`open_page` 白名单列出 7 个」 | **10 条** | `companion-bridge-contracts.ts:361-383` |
| §4 括号里的未接页面清单写"11" | 实为 **16**（`HudPageId` 共 22） | `components/hud/hud-pages.ts:9-31` |

四套词表同时在用：`HudPageId` 22／bridge `pageKind` 11（`companion-bridge-contracts.ts:481-484`）／`open_page` 落点 10／`PAGE_KIND_LABELS` 10。这是"读得到却跳不回去"的直接原因。

- 收成一个真源：`COMPANION_PAGE_DESTINATIONS_V2`（10 条，带 `label/aliases/route`）为准；`HudPageId` 22 项每项标 `destination: <kind> | none`；`open_page` enum 从该表生成；`PAGE_KIND_LABELS` 与 bridge 枚举同源取；**卡片生成页必须成为落点**（她读得到 `generating` 却跳不回去，就是这张表没它）；新增对账断言"`HudPageId` 全集 = 有 destination ∪ 显式标 none"，判据从 schema 现读、不写死数字；顺手删 `login`／`register` 死分支（没有任何组件发布，只被 sensitivity 分支与一个测试引用）。
- 「问了才读」→「本来就知道」：现状是同一份"我在哪一屏"在渲染层算了两遍——`bridgePageContext`（`companion-chat-session.tsx:495-563`）认得 11 种 pageKind、带 `readableView`，但只有调 `companion_read_current_page` 才读；窄的那份（`:620-624`＋assessment 特判）只有 today／queue／graph 三条，**她的环境块用的是这一份**（`companion-dialogue.ts:355-361`），且 `turn-service.ts:67` 的 `sanitizeContext` 根本不带 `readableView`。主动链更彻底：`companion-thought.ts:733-737` 不传 pageContext，她主动开口时永远不知道用户在哪儿。改法：只留实时那条，`here_and_now` 改从 `assistant_page_contexts` 取（worker 侧已只读，`roles.sql:1068`），`readable_view` 折进「用户正在看」2–3 行；`run.page_context` 退化为审计字段＋grounded_tutor grant 载体（assessment 分支的 grant 不能顺手删）。
- 16 页登记分三批（按会不会被问）：P4-a 学习主流程 `assessment`／`result`／`note-read`／`note-edit`／`notes`（`assessment` 一屏沿用 doc 37 §3 的服务端裁剪，`formal_assessment` 只报条数，登记侧不许绕过）；P4-b 资料与库 `sources`／`source-detail`／`goals`／`goal-detail`／`search`／`resumable`；P4-c 系统页 `settings`／`companion`／`space`（`credential_surface` 形状一律不登记）。每页数字**复用该组件已经在渲染的那个 view**（不重新计算）；挂载即发布的组件按自身早退条件收口。
- 三处小缺口：`TOOL_LABELS`（`app/companion-agent-nodes.ts:76-106`）26 条 vs registry 31 个工具，缺 `pause_learning`／`resume_learning`／`request_hint`／`switch_task_variant`／`plan_route`（落到界面是「正在处理…」），补齐并加集合相等断言；`planStepSteer` 的 `by` 分支实有 5 个值（含 `promise-shape`），日志口径分开报；dev 库 `0275`／`0276` 记账不一致列为硬前置（§14）。

### 9.7 P5 她自己是泄露源（并入 C7）

性质：答案暴露在本项目里是**已经存在、已经有表**的事实类别，缺的只有她这一头没往里写。

| 已有的东西 | 位置 | 带什么 |
|---|---|---|
| `learning_exposures_v2` | migration `0138:441-457` | `objective_id` + `objective_revision` + `card_id`/`card_revision` + `exposure_kind IN ('answer_reveal','evidence_reveal','answer_editor_view')` + `context_hash` + **`idempotency_key` 唯一约束** |
| `validation_assistance_exposures` | `0040:163-185` | `key_point_id → card_key_points`、`last_exposure_kind`、`unassisted_eligible_after` |
| 主进程作答面策略 | `apps/desktop-client/src/main/formal-assessment-guard.ts` | `assistancePolicy: { hintLevels, exposureLowersTrust: true }` |

后果是一个**无损绕过**：在作答页问她一句、她把题面条件说出来，回主页面继续答，那条回答在记录上仍然是"未借助"。

改法（只接入已有表，不新建事实类别、**零 schema 变更**）：

- **写入门在服务端，不在她嘴里。** 她不需要一个"我泄露了"的工具；判据是集合关系：她这句话有多少 ⊆ 本题题面／已揭示内容——即 G6 逐字比对能力的**反向用法**。
- 触发取现成的 `interactionState === "formal_answer"`（`companion-chat-session.tsx:513-514`）；`objective_id`／`objective_revision` 取**这一题冻结的那一版**；`turn-service.ts:100-105` 的 grant 快照哈希与 `expiresAt` 同形状可复用。
- `exposure_kind` 按内容分档：只给到线索 `evidence_reveal`，给出本题答案本体 `answer_reveal`。两档的信任后果已经在库里，不发明新语义。
- **幂等直接用 `idempotency_key` 唯一约束**，重试／重发不许记成两次暴露，别另建去重。
- RLS 陷阱：该表策略也是 `CURRENT_USER='ailearn_worker' OR (workspace_id=… AND user_id=…)`（`0138:462`）⇒ 行级隔离对 worker 不存在，集测要钉"换 user 写不进也读不到"。
- 她**读不到**这条记账（它是证据元数据，不是可播报的事实），`<this_turn_facts>` 不含 exposure 行——不许她因为"反正要记账"而开始用暴露解释用户的表现。

### 9.8 P6 工具面判决（31 个逐条过一遍）

原方案分"今天成立／等 39 采纳"两栏；并入后统一按主文档 §17 的阶段实施：

| 工具 | 现状 | 问题 | 改法 |
|---|---|---|---|
| `companion_plan_route`（`registry:105`） | consequential + 要确认 | 参数是 `z.record(z.unknown())`——31 个里唯一能改状态却**零字段校验**的写工具 | 换成带 `noteId` + 理由枚举 + 服务端预算钳制的形状；**先核真调用方**（30 天 181 次工具调用里出现几次），零调用方就按 AGENTS.md 整条删 |
| `companion_focus_graph`（`:97`） | 参数名 `keyPointId` | 执行侧注释自认「keyPointId 是 objectiveId 的别名」；而库里 `key_point_id` 是**另一个 id-space**（`validation_assistance_exposures.key_point_id → card_key_points.id`，`0040:167`） | 改名 `objectiveId`，与 `learning_exposures_v2.objective_id` 对齐；不许一个别名跨两张表（`open_card` 的 `subject_id` 是同一形状，一起钉掉） |
| `companion_start_learning`／`companion_resume_learning`（`:98,99`） | `emptyParameters` | 无法指名哪一篇、哪一轮；多对象时只能服务端挑，挑错用户看不出为什么 | 参数收 `noteId`（uuid）+ 服务端回填"这篇已有 N 轮在暂停／进行中" |
| `companion_get_learning_stats`（`:93`） | read | 描述自称"与首页同一口径"——那是一条需要断言的关系，不是注释 | 加对账测试：同一时刻她的读数与首页读数逐项相等（`一处一个来源` 的补课） |
| `companion_switch_task_variant`（`:103`） | consequential + 要确认 | 换一道题要弹确认，用户在求助流程里被连弹两次 | 降 `reversible_low` 免确认；换题**必须**写一条带理由的计划修订 |
| `companion_request_hint`（`:102`） | consequential + 要确认 | 用户开口求助时弹"确定吗"，等于拒绝求助 | 免确认；后果告知由服务端渲染（`assistance_consequence` span） |

原"等 39 采纳"七项按主文档阶段归入，不再单列：到期批次视图与 `defer_review` 走统一调度（单次延期阶段一、持续授权阶段二）、`get_learning_stats` 的复用口径（阶段二，随主文档 §9.5）、学习页／回忆页分页与 `companion_read_current_page` 页面合同（阶段一，随 §9.6 词表统一）、`companion_render_diagram` 落回主纸面、新增 `companion_read_next_step` 读"统一下一步及其 reason"（31 个工具里现在没有一个能读它）、触发式推送在 `formal_answer` 期间延后投递（阶段一，按主文档 §12.2——这推翻 2026-09-21"触发式不进任何频率限制"裁定的一半，实施时重新拍板并更新设置说明）。

`companion-proactive-policy.ts:145-150` 的注释说顺序含"是不是正在正式作答"，而函数第一行对 triggered 早退（`:152-154`），`:158` 的 `formalAnswerInProgress` 它永远走不到；集测把该行为钉成了合同（`proactive-hook-postgres.integration.ts:106`）。并入后：注释改成它真正描述的那一半（顺序只适用于 routine），行为变更按主文档 §12.2 在阶段一落实。求助后果 `assistance_consequence` span 的 `askable` **恒为真**、与 `formal-assessment-guard.ts` 的 `exposureLowersTrust` 同源，不许两处手写。

### 9.9 与 §3 缺陷列表的对应

| §3 | 并入机制 |
|---|---|
| C1 学习动作没有明确目标 | §9.8 `start`／`resume` 收 `noteId` + 服务端回填 |
| C3 到期查询与延期衔接 | §9.8 批次视图与统一调度归入 |
| C4 页面上下文有两条来源 | §9.6 词表统一 + 只留实时那条 |
| C5 不能完整读长材料 | §9.6 页面登记 + C5 自身的材料分页 |
| C6 对象别名与宽泛参数 | §9.2 id 语义跨表判据 + §9.8 改名与收形状 |
| C7 普通聊天帮助未记账 | §9.7 暴露接入 + §9.8 `assistance_consequence` |
| C8 任务记忆身份 | 按 §5 记忆合同与 §9.3 的实体身份处理 |
| C9 意图判断与执行修补 | §9.5 确定性判据替换分类器 |
| C10 提醒送达与作答安静 | §9.8 + 主文档 §12.2 |

### 9.10 预期终态

- **闸从 11 条降到 5 条**：G5／G6／G7／G8／G9 留（全是集合／封闭词表／结构判据），G1／G3／G4／G10／G11 删，G2 视 B0 读数可能留。棘轮基线 11 → 5–6，且只允许继续降。
- **每轮少一次 LLM 调用**（分类器）以及一次 steer（一步 provider 调用 + 一次可能的换模型）；这条要在 B7 用台账的"平均代价"字段核，不许拿"省 N 次调用"当未经核实的读数。
- **她的知识面从 6/22 屏到 21/22 屏**（除 login／register），且从"问了才读"变成"本来就知道"。
- **她不再是那条无损绕过的入口**（§9.7）。一句话的检验：在作答页问她一句这道题的条件，然后回主页面把题答完——今天是"一次干净的独立作答"，做完之后是"一行 `answer_reveal`"。
- **写工具面收口**（§9.8）：7 个 consequential 里"改状态却指名不了对象／零字段校验"的从 3 个到 0 个；"参数名指向 A 表、执行打 B 列"的从 1 个到 0 个；两处免确认（换题、求助）方向相反——那两条不是防线太弱，是门档放错了。
- **一句话可检验的差别**：今天她报出一个没出处的数字，是我们的正则放过了她；做完之后她**没有一个数字可以自己写**。

## 10. 删闸的证据方法：反事实重放台与逐闸台账

发给模型的完整 prompt **没有落库**（`companion_agent_steps` 只有 `request_hash`/`result_hash` char(64)，migration `0213:66-85`；`ai_audit_log` 只有 size/tokens 且 90 天清理；`companion_stream_events` 有 TTL）。但删闸要问的问题不需要逐字重放：P1／P2 是纯 SQL ＋纯函数，它们的输入在库里都是真的——用户原话与她的终答（`companion_messages.blocks->0->>'text'`）、本轮工具真参数与回执摘要（`companion_agent_tool_calls.arguments`，`0213:88-115`）、注入了哪些记忆（`memory_usage_log`，`0170:249-258`）、当时那一屏的可读视图（`assistant_page_contexts.readable_view`，`0277`）。

- `scripts/companion-gate-counterfactual.py`（新，只读，不产生模型调用）：对 30 天内每一条真实回合（编写时实测量：`companion_turn_runs` 631 → 扣 `scripted-runs.txt` 里 62 个 id → 569 → 限定真实账号 **509**；`companion_agent_steps` 791、`companion_agent_tool_calls` 181）重跑 11 道闸（**不信任日志，重算**）+ 重跑 P1 的 5 条指称规则与 `buildFactSpans()`，把每个触发分类为 `covered`（P1／P2 有确定的真值可填）／`rescued-by-tool`（该调的工具仍在面上）／`still-leaks`。
- 退出码非 0 条件：任一被标成"删除"的闸 `covered + rescued-by-tool < 100%`。即：**只有 `still-leaks = 0` 的闸才允许删。**
- 逐闸台账（`scripts/companion-quality-report.py` 后追加）：每条闸 30 天触发次数、steer 之后正文实际改变的比例、平均代价（步数／毫秒）。触发 = 0 → 删；触发 > 0 但"改变结果" = 0 → 删（**它不是控制，是税**：每次触发多烧一步 + 一次模型调用，然后把同一句话再交付一遍）。台账数字必须打印在报告里，不接受"为了安全先留着"这种没有读数的保留理由。

## 11. 实施批次与依赖顺序（B0–B7）

顺序有硬依赖：**先有尺（B0）→ 收词表与工具形状（B1）→ 补感知（B2）→ 换供给（B3/B5）→ 动协议（B4）→ 接暴露（B6）→ 最后才删闸（B7）**。B6 排在 B5 之后（复用其 span）；B7 排最后（要前面每一批的读数）。

| 批 | 内容 | 退出条件 | 花模型的钱 |
|---|---|---|---|
| B0 | 反事实重放台 + 逐闸台账 + `GATE_BASELINE` 棘轮 | 重放台对 509 轮跑通、逐闸触发数打印、棘轮对现状绿且加回一个已删函数会红 | 否 |
| B1 | §9.6 词表统一 + 三处小缺口 + 删 login/register + 修 doc 37 四处计数 + §9.8 工具形状（`focus_graph` 改名、`plan_route`／`start`／`resume` 收形状、先核真调用方）+ §9.8 注释更正 | 集合相等断言全绿；`HudPageId` 对账差集为空；`plan_route` 调用方计数打印在交付说明 | 否 |
| B2 | §9.6 感知通道（here_and_now 改读实时表）+ P4-a 五页 | 真窗口量到：她不调工具也能说出当前屏 statusLine；16 页里 5 页登记；`<this_turn_facts>` 未上线前不改变现有读数 | 一批真跑（末尾） |
| B3 | §9.3 实体先行解析 + `<this_turn_facts>` 进白名单 + 重跑 G3 覆盖判定 + `start`／`resume` 收 `noteId` + `get_learning_stats` 对账测试 | 重放台判 G3 的 `still-leaks = 0`；preflight p95 ≤ 120 ms；对账测试在人为错开首页口径时必须红 | 否 |
| B4 | §9.5 P3-alt 先行（`null → true`）→ S1 探针 → 达标才做 P3 + 两行免确认（`switch_task_variant` 降档并写计划修订；`request_hint` 免确认） | S1 报告分模型打印 ①②；① < 2% 才允许删 G4 与分类器；mock 补 `toolChoice` 分支 | 是（一次专项批） |
| B5 | §9.4 span 机制（对话＋念头）+ 撤环境块重复读数 | 未知键丢半句留正文；`due_count` 的 span 与那行同源；G1／G10／G11 重放台 `still-leaks = 0` | 否 |
| B6 | §9.7 暴露接入 + `assistance_consequence` span | 答一句"条件是 X"后该表多一行且 `exposure_kind` 判对；重发不产生第二行（撞幂等键）；换 user 写不进；**反向**：普通闲聊轮写入次数必须为 0 | 否 |
| B7 | 逐条删闸（台账驱动）、棘轮同格调低、漏清单与文档对账 | 四包全量 + typecheck 绿；每条删除在实施日志里有自己的读数 | 末尾一次真跑 |

批次纪律：**一条闸都没删掉之前，不许对外说"闸修好了"**；B0–B6 的交付都是"供给上线 + 闸仍在但不再触发"，删除只在 B7。中途任何一批停下，系统行为不会比今天差。

## 12. 验收

确定性层（先跑完，再花模型的钱）：span 渲染（未知键丢半句留正文、`askable=false` 不进目录、渲染值与 `buildFactSpans` 逐字一致）；preflight 指称（五条规则各自的命中／不命中、序数指代落到 `items[].ordinal`、`第4张` 与 `第四张` 同一解析、预算超限整块放弃）；事实块可信（`<this_turn_facts>` 在 `keepRecomputedBlocks` 白名单，`memory_data`／`conversation_summary`／`persona_data` 仍不在）；词表（四集合派生关系、卡片生成页在落点里、`tools:[] ∧ required` 组合被拒）；页面登记（每页屏上那句话与视图字段**逐字**相同、数字复用已渲染 view——让它重新计算必须红）；棘轮（`export function 名字(` 匹配、加回已删函数会红）；consequential 指名对象；id 语义不跨表；暴露判定（含"反向：普通闲聊轮、非作答页轮 → 零行"）；求助后果同源；集测跨 user 读不到（含换 user 的 preflight 也查不到那条实体）。

真跑（每批末尾一次）：结果门禁三条——① 没问就不报数（正文数字全部由 span 渲染而来、`askable` 全为真；把 span 换成模型自己写数字立刻红）；② 读不到就说读不到（不许出现假阴性结论，也不许出现"我读完了"；本批之后应 `steps=1 / tools=0` 就答对）；③ 让她做事要落地（`tools ≥ 1` 且动作轮正文与工具回执一致，B4 前后两种机制下都必须绿）。反例门禁：30 天里所有 6 字以内的正常闲聊轮重放，本批机制对它们的**干预次数必须为 0**（没有这条，所有指标会朝"少说话"反向优化）。

回归口径：四包全量 + typecheck；基线（2026-09-24 实测）`packages/shared` 387、`workers/ai-worker` 815、`apps/desktop-client` 195 文件/1606 条、`apps/api` 1591（1590 pass / 1 既有 skip）。删除会**降低**用例数——每条删除必须在实施日志里指明删了哪几条测试，总数差 = 删除数，不许出现"莫名少了"。`0 个失败文件` 算绿的一部分，且摘要里不许出现 `Errors` 段。

## 13. 已知会漏（登记，不补同义词）

| 漏口 | 为什么无解 | 现在/预计的漏率 | 处置 |
|---|---|---|---|
| 她换一种说法下假阴性结论（G2 的 `still-leaks`） | P1 未解析出实体时（新词／别名），"没有这篇"仍然可说，且不报数、形状也不像统计 | B0 重放台给数 | **保留 G2 不删**，同时在 `<this_turn_facts>` 里给"未解析成功"的显式回执 |
| 比喻／拟人化的动作添写 | 「像乱麻一样缠过来」「我扫了一眼」没有真值可比 | 日记侧已实测：三稿里最后一稿仍有 1 句 | **不设闸**，是人格创作的方差 |
| 第二人称回忆句被 `CLAIMED_LOOKUP_TEST` ② 误伤 | 中文施事者可能落在 20 字之外 | 保留 G3 期间的现存代价 | B7 删 G3 时这条 FP 一起消失，不修 |
| 主动念头的 span 目录为空的那些天 | 没有可播报的事实就不该有气泡 | — | 不放宽，宁可少发 |

## 14. 前置条件、风险与环境限制

- **最大风险：拆早了 = 谎直接上线。** 纪律：B0–B6 期间闸一条都不删；每条删除只在 B7，且必须同时有 (a) 重放台 `still-leaks=0` 与 (b) 真实流量 0 触发两份数。
- **硬前置：dev 库迁移账。** `0275`／`0276` 的 hash 记账与对象状态不一致（表已存在但 ledger 没记），`npm run db:migrate` 会停在 0275 挡住后面每一条（doc 37 §7.5）。B1 之前必须先解决；属并行会话在途工作，先确认状态，不要在别人在途的文件上抢着补账。
- **性能：§9.6 的感知改造每轮多一次表读。** 量法照旧：`/ready` 4.5 ms 那把尺 + 整版前后各采一批、带控制端点判负载；**p95 增加 > 15 ms 就不合并该改法**，改成只在 `readable_view.pageInstanceId` 与本轮已知 id 不同时才查。
- 环境限制（不是产品缺陷）：本机 0 个 `audioinput`（端到端录音验不了）；全库 0/852 账号 `dataPolicy.sendImageContent=true`（读图主路径在应用内永不触发）；`v1.0` 不在 CI 的 push 触发分支里（`.github/workflows/ci.yml` 的 `branches`），本批验证只有本地算数——B0 起把重放台与棘轮接进 `ci.yml` 的**点名列**，并记录：接入点名列 ≠ 会被跑，还要确认分支（67 份集测只接了 24，其中一份缺 critic 就整条静默 skip）。
- 并发干扰：`assistant_page_contexts` 的 RLS 对 `ailearn_worker` 按用户名放行，SQL 里的 workspace／user 条件是唯一的闸 → P1 任何新增读取必须在集测里钉"换 user 什么都读不到"；共享 dev 库还池着其他 agent 的集测行，任何失败率读数要带工作区数与时间跨度。
