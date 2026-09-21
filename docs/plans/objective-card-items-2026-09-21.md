# 客观题（选择 / 判断 / 排序 / 配对）落地方案

日期：2026-09-21　负责 agent：本线程
关联：`docs/plans/note-to-card-flow-fixes-2026-09-20.md`（18 条实走复盘，本文是其 #3 的后续）

## 0. 文档定位

用户走完整条「笔记 → 学习卡 → 作答」之后提出的第二个结构性问题：**从始至终没见过一道非主观题**。
本文先给实测根因，再给设计与批次；实施按 §5 的顺序推进，每批交付都带测量数字。

## 1. 根因（2026-09-21 实测，不是推测）

| # | 断点 | 证据 |
|---|---|---|
| 1 | 生成侧几乎只产散文答案 | 全库 226 个目标修订：`canonical_answer` 为 NULL 179；有值 47 个里 `text` 36、`bullets` 9、`ordered_steps` 2、`mapping` 0、`comparison` 0 |
| 2 | 答案没有结构 → 客观题造不出来 | `generateStructuredFromSnapshot` 只吃 `ordered_steps/mapping/comparison`，其余退到"从 relations 造关系图"。157 个冻结快照里只有 3 个答案结构可机械比对 |
| 3 | relations 恒为空 | 2026-09-21 真跑批次 4 张卡 `objective_draft->'relations'` 长度全 0；prompt v16「只在证据明确表达时输出」 |
| 4 | 有结构也几乎拿不到 | `responsePreference` 客户端硬编码 `adaptive`（`action-resolver.ts:39`），主位结构题要显式 `"structured"`，全仓库只有集成测试发过 |
| 5 | 选择 / 判断从来没实现 | 交互种类只有 `ordering / relation_canvas / repair`（`learning-run-contracts.ts:112-133`）；`single_choice`/`true_false` 全库零命中 |

**引擎没坏**：把真卡的 `ordered_steps` 喂进 `generateStructuredFromSnapshot` 返回 `interaction=ordering`；确定性判分（`deterministic_structured`，migration 0123「只产 verdicts，绝不产 canonical」）与界面编辑器（`OrderingEditor`「顺序整理」、「关系搭建」、「组合证明」）都已存在。

**我此前的验收口径错了**：#3 我只量了"不是清一色 recall"，而 7 种策略全是产出型框架 —— 铺开之后仍然是 100% 主观题。

## 2. 产品约束（来自既有文档，不与之冲突）

- `00-decision-and-scope.md:140`、`00-4-current-baseline.md:36`：纯选择题不能可靠证明理解。
- `14-…multimodal-reconstruction.md:97`：选择题/识别型点击**只用于练习与诊断**，不替代正式理解判定。
- `16-…:145`：不以更多选择题掩盖主观理解问题。
- `run-structured.ts:313-318`（§16.5）：禁止用标点/固定字符数/claim 切片造题；结构题只能来自显式结构，distractor 必须有证据支撑，判断不足则不生成（返回 null）。

## 3. 设计决策

**D1 客观题是"卡上的练习件"，不是卡的答案本体。**
`objectiveDraft` 新增 `practiceItem`（与 `canonicalAnswer` 并列）：卡仍然有产出型标准答案与 rubric，正式验证路径一字不改；练习/诊断路径用 `practiceItem`。
理由：若把 `canonicalAnswer` 本身换成 `single_choice`，这张卡就永远无法被正式验证 —— 直接撞 §2 第一条。
落地红利：`objective_draft` / `canonical_answer` / `learning_objective_revisions_v2` / `learning_target_snapshots_v2` 都是 jsonb 列，**不需要迁移**。

**D2 客观题判分只走确定性通道。**
选择/判断/排序/配对 → 现有 `deterministic_structured` 路由，`templateTrustCeiling = practice_only`。一次点击都不额外花模型配额，且答完立刻出结果（不等 critic 往返）。

**D3 泄题防护沿用 ordering 的姿态。**
option id 由内容哈希派生（`opt:<sha256(token)[:10]>`），正确项只存在于私有 solution，public 载荷带不了它；选项顺序确定性乱序。
`practiceItem` 属于判分内容 → **进 revision 哈希闭包**（与 hints 相反，hints 当初被明确要求排除在外）。

**D4 干扰项必须由作者在同一轮产出并绑定证据。**
每个 distractor 带 `evidenceRefIds` 或取自该卡自己的 `misconception`；作者给不出有证据的干扰项 → 该卡不出练习件（不伪造，§16.5）。

**D5 可达性：练习入口把客观题提到一等公民。**
`adaptive` 下只要 `practiceItem` 存在就必须生成变体；「换一种方式」改为**显式列出可用模态**（含"做一道选择题"），而不是藏在备位。正式验证不受影响。

**D6 一批里的客观题占比设下限，但只作用于练习件。**
planner 已有 `allocateStrategies`（策略配额）；练习件配额独立于策略：一批 N 张卡里至少 ⌈N/2⌉ 张带练习件，且四种模态尽量铺开。凑不满不强造（D4 优先）。

## 4. 合同形状

```ts
// packages/shared/src/learning-run-contracts.ts —— TaskInteractionV1 增两支
| { kind: "single_choice"; publicOptionIds: string[]; publicOptionLabels?: Record<string, string> }
| { kind: "true_false"; proposition: string }

// 私有 solution
{ kind: "choice";     correctOptionId: string; rubricTargetIds: string[] }
{ kind: "true_false"; expected: boolean;       rubricTargetIds: string[] }

// objectiveDraft.practiceItem（作者产出，进哈希闭包）
{ kind: "single_choice"; stem; options: [{unitId, text, evidenceRefIds[]}]; correctUnitId; whyWrong?: Record<unitId,string> }
| { kind: "true_false"; proposition; expected: boolean; note; evidenceRefIds[] }
| { kind: "ordering";  orderedUnits: [{unitId, text, evidenceRefIds[]}] }      // 来自映射/步骤，非切片
| { kind: "matching";  pairs: [{leftId, leftText, rightId, rightText}] }
```

## 5. 批次（每批都要 typecheck + 测试绿了才进下一批）

1. **合同 + 确定性判分**：`single_choice` / `true_false` 两支交互、solution、`assessStructuredPayload` 分支；测试先行（含"提交未命中不得 covered"、"public 载荷不含正确项"）。
2. **生成侧**：作者 prompt v23 产 `practiceItem`（四模态），grounding critic 校验干扰项证据绑定；分配器加练习件配额（D6）；缺证据即不产。
3. **可达性**：planner 在 `adaptive` 下从 `practiceItem` 造变体；「换一种方式」列出可用模态；激活 → 目标快照 → 变体一条链打通。
4. **界面**：选择/判断作答控件（抄 `OrderingEditor` 形状），即时判分反馈文案；审核页预览练习件。
5. **一次真跑验收**（唯一一次模型配额，同时补 #2/#6）：长笔记 → 阶段阶梯逐格上升（#2）、题型 × 模态分布、客观题确定性判分、主观题真 critic 出结果（#6）。

## 6. 明确不做

- 不用客观题换掌握/排期（migration 0123 + §2 文档双重禁止）。
- 不改 `canonicalAnswerV2` 现有 7 种 kind，不加数据库迁移。
- 不引入"第五种策略"：策略是认知框架，模态是作答方式，两者正交。

## 7. 实施进度（滚动）

| 批次 | 状态 | 实测 |
|---|---|---|
| 1 合同 + 确定性判分 | 完成 | `run-structured.test.ts` 15/15；shared 330/330；desktop 129 files 全绿；三端 typecheck 干净 |
| 2 练习件落库 + 接进规划器（落库/判分/可达三半） | 完成 | api 我范围 370/370；迁移 0245 + journal 登记（diff 只 +7 行，未重排） |
| 2 剩余：作者 prompt 真产出 practiceItem | **未做** | 所以现在还没有一张真卡带练习件 |
| 3 界面作答控件（选择/判断/配对） | 未做 | `OrderingEditor` 已有，可照形状做 |
| 4 一次真跑验收 | 未做 | —— |

**两处被自己的测试抓到的静默失效（很重要，记录失败形状）**
1. `buildStructuredInteraction` 只认 ordering/relation/repair，新种类掉进注释写着「永远不该到达」的兜底，**静默退化成 `text_response`** —— 即"练习件白写一场，用户仍拿到文本框"，而且测试不红。现已改为显式抛错 + 三个分支。
2. 判分路由表（`run-service.ts:2818`）逐字枚举 payload.kind，新种类不在表内 → 选择题会被丢给 **assessment_critic**（花钱 + 语义错）。现改为共用 `isDeterministicStructuredPayload()` 一张表，杜绝再抄漏。

这两条与用户抱怨的是**同一个失效模式**：链路"看起来通了"，最后一公里静默降级。

**范围偏离（明确报备）**：§5.2 原写"排序已由 canonicalAnswer 反推覆盖"，实际把 `matching` 也做成一等交互（`publicLeftIds/publicRightIds` + 私有 `correctPairs` + 反穷举判分），因为用户选了"排序配对全上"；否则 `matching` 会是个没人消费的死字段。

**存量兼容**：`PlannerV2Target.practiceItem` 用 `?? null` 兜老快照；`target.practiceItem` 在快照合同里是**必填可空**——这样漏设会当场编译错，而不是静默当成"没有"。

**此刻仓库里不是我的红**（并行 agent 的 note 协作改动）：
- `content-workspace-transaction.test.ts` 钉 note handlers=9，他们新增 `collaboration.ts` 后变 10 → 1 条子测试红。
- `apps/api` typecheck 另有 `src/modules/note/routes.ts(39)` 一处错（`IncomingMessage` vs `Request`）。
两者都在 `src/modules/note/`，本批次未触碰。

## 8. 第二次真实生成（长笔记）+ 激活到作答现场的实测

目标：4916 字 / 72 文本块的 IndexTTS 笔记，run `406b213c`，开跑前已确认容器里是 v23。

| 测量 | 结果 |
|---|---|
| 候选 | 3 张；`cloze` 1（grounding 失败）、`sequence` 2（过门禁） |
| **练习件真的产出了** | `objective_draft->'practiceItem'` 非空 **2/3**，kind 全是 `ordering`；`single_choice` / `true_false` **0** |
| 来源 | 这 2 条来自**零模型派生**（canonicalAnswer 是 `ordered_steps` 四步），不是模型自己写的 practiceItem —— v23 提了要求，这一批模型没交 |
| 激活搬运 | `learning_objective_revisions_v2.practice_item` 出现 2 行 `ordering` —— 迁移 0245 + 激活接线在真实数据上成立 |
| 到作答现场 | 用其中一条目标开真旅程（HTTP 201）：`primary=text_response`（正式验证仍是产出型，符合 §2），`availableAlternatives` 里出现 **`family:"structured"`** —— 客观题第一次到达作答界面 |
| 提交那一跳 | **没验成**：我的脚本 `switch_variant` 返回 400，日志只给 `request_error` 不给字段。判分链路目前只有单测证据，缺一次线上实证 |
| 终态 | `needs_attention` + `quality_gate_failed`（deck gate：3 张里 1 张 grounding 失败） |

**#2「假进度」的真因，这次才量到**：把采样降到 800ms、换 4916 字长笔记，`progress` 仍然是 `planning → 终态` 一步跨完。原因不是采样太快，而是**候选是在 author 结束时一次性批量 INSERT 的**（`persistAuthorCandidates` 多行单语句），所以服务端根本没有中间态可观测。要让进度真的"一格一格走"，得改成逐候选落库（或至少分批），这是新的一刀，不在原 18 条范围内。

**待办增补**
- `single_choice` / `true_false` 目前只有合同与判分，模型侧零产出：要么在 v24 里把要求改成结构化字段级（而非规则段落），要么承认客观题只靠派生（那选择题就是纸面能力）。
- 线上实证 `switch_variant → ordering 提交 → deterministic_structured`。

## 9. #24 线上实证：客观题真的判分了，且一分钱模型没花

（上一轮 `switch_variant` 一直 400 的原因：内层 `action` **不能带 `version`**——路由用的是
`learningRunActionSchema`，与带 version 的旧形状不同。用真 schema 原地 safeParse 一次就定位到了，
比继续猜字段快得多。）

用带 `practice_item` 的真目标（`ordered_steps` 四步派生的 ordering）走完 HTTP 链路：

| 步骤 | 结果 |
|---|---|
| `POST /learning-runs` | 201 |
| 快照 `activeVariant.interaction.kind` | `text_response`（正式验证仍是产出型） |
| `availableAlternatives` | 含 `family:"structured"` |
| `switch_variant`（只带 alternativeId） | 200，切换后主变体 `ordering`，public tokens 3 个 |
| 提交 `payload.kind="ordering"`（正确顺序） | 201，`learning_artifacts` 落库 |
| `learning_assessments.source` | **`deterministic_structured`** |
| 同时段 `assessment_critic` 调用数 | **0**（真值：`ai_audit_log` 自 04:35 起计数为 0） |

结论：客观题从"作者产出/派生 → 激活 → 冻结快照 → 规划器出变体 → 界面可换 → 提交 → 确定性判分"
**整条链路在跑着的系统上成立**，并且如设计所承诺：不额外调用模型。

## 10. v24：把"没交"和"不想交"分开

v23 实测暴露的只能是一个**未定义问题**：`practiceItem` 是可省略字段，于是一整批模型全部
不写这个键，`single_choice`/`true_false` 产出 0，两条练习件全靠服务端零模型派生。
"模型不会写选择题"和"模型看见了但选择省略"在数据上完全同形，再跑十次也分不出来。

改法：author 输出 schema 里 `practiceItem` 改成**必填可空**（`nullable()`，不再 `optional()`），
prompt 同步把"省略该字段即可"改成"交不出就写 `null`，不许省略这个键"。

验收测试（`card-generation-v2-practice-item.test.ts`，全确定性、不花配额）：
显式 `null` → 通过；删掉这个键 → 不通过，且拒绝原因必须指到 `practiceItem` 本身。

回归：worker typecheck 干净 + 690/690；api 1411 tests（1410 pass / 0 fail）+ typecheck 干净；
api 的 prompt 版本同步测试要求两侧一起升，故 `generation-run-service.ts` 四个 stage 种子
一并 v23 → v24。

**#25 仍未结案**：这次改动能不能让模型真交出选择题，只有下一次真跑才知道（配额原因按
§4 的约定留到批次末尾一次跑完）。

## 11. 批次 3 收尾：审核页说出「随卡练习」

服务端只投影**种类 + 计数**（`helpers.ts`：`practiceItemSummary`），选项文本与正确项**不下发**——
练习件含正确项，随候选列表下发等于绕过答案查看记账（与 0234 给 hints 定的同一条线）。
界面新增一行「随卡练习」：`排序题 · 排 4 步` / `选择题 · 3 个选项` / `判断题 · 对不对二选一` /
`配对题 · 3 组`；没有则直说「没有，只能用自己的话答」，不假装有一道题。

回归：shared / desktop(web) / api typecheck 全部干净；desktop 132 文件全绿（含新增 2 条）、
api 1411（1410 pass / 0 fail）、worker 690/690。

**未做**：这一行的真机复测。CDP `:9222` 此刻拒绝连接（桌面端被重起且未带调试端口），
所以"审核页真的显示出这行"目前只有 jsdom 证据，不算验证完成。端口恢复后测 run `406b213c`
（它那 2 张过门禁的卡带 `ordering` 练习件）。

## 12. #2「进度不逐格走」的真因，比我先前写的更硬

先前记的是"候选在 author 结束时一次性批量 INSERT，所以没有中间态"。核对代码后这条**只对一半**：

- `insertAuthoredCandidatesBatched` 在 `card-generation-v2-handler.ts:1481` 被调用，
  而它接收的 `tx` 就是 `withWorkerWorkspaceTransaction` 那**一个事务**（1104 行起）——
  整个四阶段 LLM 管道从头到尾都在这个事务里。
- 于是**即使改成逐候选 INSERT，HTTP 轮询也看不见**：那些行还没提交，
  `readGenerationProgressV2` 走的是另一个连接/事务，读不到未提交数据。
  "分批写"最多让最后一次提交里行数不同，对界面无意义。

而 1108-1112 的注释明确写着这里**故意不拆事务**：run 行的 `FOR UPDATE` 覆盖整条管道，
是为了防同 run 双 job 并发跑完 LLM（双份计费 / 双写终态，W2 的本意）。
所以这不是一个"把 INSERT 挪个位置"就能解决的样式问题，而是：

**进度要能逐格走，就必须有一个独立于该事务、且被允许在管道中途写入的通道。**
可选形状（都还没做，需先定方向）：
1. 管道中途用**短事务**只写一张进度旁表（run 行锁不动，进度另行提交）；读侧改读旁表；
2. 或阶段边界把 `run.status` 提前提交（queued→planning→authoring→checking），
   进度数字仍最后给 —— 界面至少能显示"到第几步"，而不是假称"几张已写好"；
3. 或者接受现实：把进度文案改成不承诺逐张（现在是 `{plannedCards/authored/gatePassed/gateFailed}`），
   不要给出看起来会逐格涨的数字。

我倾向 2 + 3 组合：不为了一个进度条去拆那把防双付的锁。

## 13. v24 供给侧实测（run `eae682d2`，4778 字笔记）

先说代价：这一批被并行改动打断两次（worker 05:34、05:36 连着重启，每次杀掉在跑的 job、
事务回滚），我把孤儿作业手动回队后才跑完。三次重启不是我改的 v24 造成的。

结果：**3 张候选 / 2 张过门禁 / 2 张带练习件**，种类 `ordering ×2`，
`single_choice 0`、`true_false 0`、`matching 0`。整轮 **author schema 违规 0 次**。

关键判别（区分"模型写的"还是"我派生的"）：练习件 unitId 是 `opt-1..opt-n`，
而 canonicalAnswer 的步骤是 `step-1..step-n`。我的 `derivePracticeItemFromCanonicalAnswer`
原样沿用 `step-N`，所以这两条**是模型自己产出的** —— v24 的必填可空确实起效了：
模型开始回答这个字段，并且带着 `evidenceRefIds`。

剩下的缺口比原先判断的窄，但性质变了：不是"没供给"，而是**形状偏置** ——
模型在有自由时一律挑最省事的 `ordering`（把步骤按原序重述），回避设计干扰项。
因此 #25 的下一步不是再逼它填字段（已经填了），而是按知识形态限定该出哪种：
`fact`/`definition`/`boundary` 这类没有内在次序的知识，才应该要求 `single_choice`/`true_false`；
`procedure`/`sequence` 用 `ordering` 本来就是对的。这个可以在 planner 分配阶段按
knowledgeForm 给约束，确定性可测。

（另：run 终态仍是 `needs_attention` + `quality_gate_failed`，3 张里 1 张被 grounding 拒。）

## 14. 更正 §13 的结论（我自己差点把样本读成能力缺陷）

§13 写"模型有形状偏置、一律挑最省事的 ordering"。查知识形态后这句**不成立**：

| strategy | knowledgeForm | canonicalAnswer | practiceItem |
|---|---|---|---|
| sequence | sequence | ordered_steps | ordering |
| sequence | procedure | ordered_steps | ordering |
| cloze | fact | bullets | （无） |

两张有练习件的卡，知识形态正是"有内在次序"的两类，`ordering` 是**正确答案**，不是偷懒。
我按 unitId 命名（`opt-N` vs `step-N`）判明它们出自模型之手，这点仍成立。

所以这次真跑实际回答了的只有：v24 的必填可空让模型**开始回答这个字段**（2/3，且带
`evidenceRefIds`，整轮 0 schema 违规）。
**没回答的**仍是 #25 的原问题：`fact`/`definition`/`boundary` 这类无次序知识，模型会不会
自己写出 `single_choice`/`true_false`——本批只有 1 张 fact 卡，它没写，样本量 1，
不足以判定能力，也不足以判定"需要再改提示"。

下一步不花配额能做的：给 author 增加一条按 knowledgeForm 限定形状的规则（v25），
并在分配阶段就按形态决定"这张该出哪种"。要不要为验证它再花一次真跑，由用户定；
若要跑，应当挑**事实/定义类知识为主**的材料，才能把 fact→选择题这条路径真正压出来
（这次挑的 IndexTTS 笔记是流程型材料，天然出不了这个信号）。

## 15. v25 已落地（提交 a8d77886）

`knowledgeForm → 允许的 practiceItem 形状` 做成共享层一张表
（`PRACTICE_FORMS_BY_KNOWLEDGE_FORM` + `practiceFormsForKnowledgeForm`），author 系统提示
按本卡形态注入"只允许这些形状，交不出写 null，不要换成别的"。
提示里提要求是一回事，能被测试钉住是另一回事：现在"fact 卡该出选择题"是一条断言。

回归：shared 335/335、api 1413（1412 pass / 0 fail，含两侧 prompt 版本同步）、
worker 695/695、四端 typecheck 干净。桌面 134 文件里有 1 个文件红：
`src/main/desktop-ipc-note-doc.test.ts`（笔记协同 IPC，对应他们三个在途的 main 文件），不是我这批改的。

**仍未答**：v25 能不能让模型真为 fact/definition 写出选择题。要答它必须换材料——
挑事实/定义密集的笔记再跑一次；这次的流程型笔记天然压不出这个信号。

## 16. #2 的界面口径改动：写了，又撤了（记录原因）

按方案 B 改过一版：在途时把「第 N 步 / 共 4 步」换成「正在生成 · 写完一批一次给齐」，
并把百分比那块整体不渲染（附了注释说明为什么不能亮假刻度）。源码编译通过。

**但测试打不到绿，所以整个改动回退了。** 这条改动同时需要一个能跑到绿的红测试，
和真机复测——CDP `:9222` 此刻无端口，两样都缺。留一个未验证的界面改动在树里，
比不改更接近用户一直反对的"看着绿了"。回退后 review 测试恢复 14/14。

重做时需要的两件事，记在这里免得下次又踩：
1. 审核板的进度块由 `run && progressView` 双重把关，测试桩的 runSnapshot 里**没有 progress 字段**
   （我加了仍不渲染，说明 `progressView` 的构造还依赖别的字段，要顺着 `progressView` 的
   来源读到底，别再猜）；
2. 真机复测要等 CDP 端口回来，量的是"在途那一屏到底显示了什么"——
   而这恰好是最难在真机上抓的窗口（管道 <1 分钟且中途不可见），
   现实可行的做法是把 run.status 手工置为 authoring 再截图，而不是追真跑的瞬时窗口。

## 17. #25 结案：模型会写选择题，前提是形状被按知识形态限定

材料：现造的一篇定义集（25 块，8 组「定义 + 适用边界」），note `1e212b93` /
version `57c31bbf`。run `d375f218` 终态 **review_ready**（不再是 needs_attention）。

| 指标 | v24 流程型笔记 | **v25 定义型笔记** |
|---|---|---|
| 候选 / 过门禁 | 3 / 2 | 8 / 6 |
| 带练习件 | 2 | **5** |
| single_choice | 0 | **4** |
| true_false | 0 | **1** |
| ordering | 2 | 0 |
| author schema 违规 | 0 | 0 |

形状与知识形态逐条对上，正是 v25 那张表要求的：
`definition → single_choice`（2 张）、`boundary → true_false`、
`causal_model → single_choice`、`application_rule → single_choice`。

干扰项证据：4 张选择题里 **3 张的每个选项都带 evidenceRefIds**；另一张只有 1/3 带证据
（它没有被 sanitize 丢掉，说明该卡有 misconception 兜底——这符合 D4 的判据，但值得抽查
那条 misconception 是不是真来自证据，属于下一轮该看的点）。

结论：**"模型写不出选择题"是错的判断**。此前 0 产出是因为 practiceItem 既可省略、又没有
形状约束，模型自然挑最省事的 ordering；把它按知识形态钉住之后，选择题立刻出现。
所以 #25 从"能力问题"改判为"规格缺口"，缺口已补。

新的待看点（不是回归）：① 4 张选择题的 `correctUnitId` 全是 `opt-1`（作者总把正确项写在
第一个）——公开顺序由内容哈希重排，界面不会因此泄题，但这说明可以在 prompt 里要求乱序书写
以增强干扰项质量；② 那张 1/3 证据的卡的 misconception 需要抽查。

## 18. 方案 A 的执行设计（逐候选可见）——写定，未实施

**为什么不在这里直接改**：这一刀动的是防重复计费的那把锁，且横跨 outbox 领取、租约续期、
门禁与激活的时序；在上下文末尾改一半比不改更糟。下面是要点与判据，实现可独立成批。

### 现状（实测，非推测）
`processCardGenerationPlan` 全程在**一个** `withWorkerWorkspaceTransaction` 里
（handler 1104 起），`insertAuthoredCandidatesBatched` 也在其中（1481）。因此：
- 候选行与 `run.status` 都到提交才可见；
- 两次真跑（消防 / IndexTTS 4916 字）HTTP 侧只能观测到 `planning → 终态`；
- `run.status=authoring` 期间的 `authored` 恒为 0 —— 界面无从逐格走。

1108-1112 的注释明确说这里**故意不拆**：`FOR UPDATE` 覆盖整条管道，是为了防同一 run 的两个
job 并发跑完 LLM（双份计费 + 双写终态）。所以"拆事务"必须先有等价互斥，不能裸拆。

### 等价互斥的候选：fence token，而不是行锁
1. `card_generation_run_outbox_v2` 领取时生成 `lease_token`（已有）；把它同时写入 run 行的
   `active_lease_token`（新列）。
2. 管道内每一次**独立短事务**写候选/状态时，`WHERE active_lease_token = $myToken` ——
   租约被抢走后旧 worker 的写入自然 0 行，不会双写终态。
3. 续租：一个定时器把 `lease_expires_at` 往后推；续租失败即 abort（现有 `signal` 已在）。
4. 提交前的"最终裁决"（run 终态、deck gate 结论）仍在**一个短事务 + 行锁**内完成——
   锁只覆盖毫秒级的写，不再覆盖分钟级的 LLM 调用。

这样双付防护从"锁住整条管道"变成"过期 token 写不进去"，语义等价且更弱耦。

### 迁移与回滚判据
- 必须**默认关闭**（env 开关），因为一旦中途崩溃，半提交批次会留下"有候选无终态"的 run；
  现成的 `needs_attention` 死批次豁免逻辑要能识别这种半提交态（否则守卫会把笔记锁死——
  这正是 §7 修过一次的那类洞）。
- 验收不看"代码合并了"，看这两条实测：
  1. 长笔记真跑时 HTTP 轮询能采到 `authored` 从 0 单调涨到 N，且中间值**至少出现 2 次**；
  2. 双 job 竞态注入测试：同一 run 让两个 worker 同时跑，第二个在所有写入点都必须 0 行受影响，
     且 run 终态只被写一次。
- 不满足第 2 条就不合。这是防双付，没有"先上了再说"。

### 与已做的 B 的关系
B（提交 66a0049f）已经让界面不再撒谎。A 做完后，把 B 里那句
"这一步的中间计数要等这一批写完"和 `inFlight` 分支一起去掉，恢复逐步读数——
两处都有注释指向本节，不会漏。

## 19. 边界审计：正确项有没有可能从别的接口漏到客户端（真数据验证）

正确项就躺在 `objective_draft.practiceItem` 里，所以"只投影种类+计数"这件事必须被验证，
不能被我自己的代码注释说服。查了三条路径：

| 路径 | 结论 |
|---|---|
| `GET /v2/card-generation-runs/:runId/candidates` | 服务端在 `helpers.ts` 里重组成 `{kind, optionCount}`；**实测**（run `d375f218`，含 4 道真选择题）响应体里 `correctUnitId` / `correctTokenIds` 均不存在，库里那 4 个正确项 id 在响应中命中 **0/4** |
| `reveal` 接口 | 逐字段组装（只取 canonicalAnswer / learningSupport 三项 / evidenceRefIds），不含 practiceItem，且出口再过 strict 的 `parseCandidateRevealV2` |
| 候选审核写路径 | 那里出现整包 `objectiveDraft` 是服务端哈希输入与 DB 写入，不对外返回 |

一处如实记录的粗糙：`true_false` 的 `optionCount` 是 0（摘要只数 options/units/pairs）。
界面标签是硬编码的「判断题 · 对不对二选一」，所以显示不受影响，但这个字段对判断题没有意义——
下次要么给它 2 的语义，要么让标签不读计数。**已在 §20 处理：选了后者前置的那一步（不发这个键）。**

## 20. 把 §19 那处粗糙改掉，顺带踩到一个会骗人的开发环境行为

选了"不发这个键"而不是"给判断题 2"：2 是在替这条数据编一个它没有的选项集合，
而且界面本来就不读它。三处一起改：

- `apps/api/.../helpers.ts`：`...(practiceItemOptionCount ? { optionCount: ... } : {})`；
- `packages/shared/src/card-generation-desktop-contracts.ts`：`optionCount` 改成 `min(1).max(12).optional()`；
- `CardGenerationSurface.tsx`：标签的计数改为 `item.optionCount ?? "?"`（判断题那一行本来就不读计数）。

测试：api 侧新增 2 条（选择题 `deepEqual {kind, optionCount:3}`；判断题 `Object.keys(summary)` 恰为
`["kind"]`），桌面侧新增 1 条（判断题卡面的「随卡练习」行不含数字）。新测试都做过**改前红**确认：
把投影临时退回 `optionCount ?? 0` 时，判断题那条确实 `not ok`，不是摆设。

### 那个会骗人的行为（值得记住）

改完之后 `GET /v2/card-generation-runs/:runId/candidates` 直接 **500**，日志只有
`ZodError`（fastify 把 `issues` 吞了）。排查结果不是代码错：

- api 容器里 `npm run dev` = `tsx watch src/server.ts`，日志显示它**只对 `./src/**` 的变更重启**
  （`[tsx] change in ./src/modules/card-generation-v2/helpers.ts Restarting...`）；
- 我先落的是 `helpers.ts`（06:32:07 重启，投影已经不再发 optionCount），后落的是
  `packages/shared/.../card-generation-desktop-contracts.ts`（06:32:19，**没触发重启**）；
- 于是**活进程拿着旧的"optionCount 必填"schema 去校验已经不发这个键的投影** → 500。

`touch apps/api/src/modules/card-generation-v2/helpers.ts` 让进程重载后同一个请求 200。
教训：**改 `packages/shared` 的合同不会让 api 容器自己重启**，验证前先碰一下 api 的 src 文件，
否则会把"进程里是旧合同"当成"新代码写坏了"。这与 §桌面端符号链接那条记忆相反方向：
那边是改了 shared 立刻生效，这边是改了 shared 要手动踢活进程一把。

### 恢复后的真数据（run `d375f218`，重载后又打了一次）

```
['null', '{"kind": "true_false"}', 'null', '{"kind": "single_choice", "optionCount": 2}',
 'null', '{"kind": "single_choice", "optionCount": 3}', '{"kind": "single_choice", "optionCount": 3}',
 '{"kind": "single_choice", "optionCount": 3}']
```

判断题只带种类；六个含答案的键（`correctUnitId` / `correctTokenIds` / `correctOptionId` /
`expected` / `correctPairs` / `answerPairs`）在整个响应里出现 **0 次**。

### 顺带记一条别人的红（不修，只报）

`apps/api` typecheck 现在报两处，都在 note 链路上，不是本批改动：
`src/__tests__/note-service-extra.test.ts(11,12)` 想要 `cleanTitleCandidate` / `deriveNoteTitle`，
而 `modules/note/service.ts`（工作区里被在途批次 4.x 改动）已经不导出它们。

## 21. 方案 A 拆成 A1/A2：A1 经调研判定为"现在做会引入永久锁死"，只做 A2

§18 写的 A（fence token 取代整管道行锁）先做了一轮消费方调研（4 个问题，逐条 file:line），
结果推翻了它自己的前提。两条致命发现：

1. **重放会变成静默空转**：入口守卫是 `handlers/card-generation-v2-handler.ts:1140`
   `if (run.status !== "planning") return;`。今天 `authoring` 只在那个大事务里写（`:1464`），
   回滚后仍是 `planning`，所以 reaper 重投的 job 真的会重跑。一旦逐候选提交，
   `authoring` 已经落库 → 重投的 job 直接 return → 事务收尾把 job 标成 `completed`
   （`:357`）→ **run 永远停在 `authoring`**。而 `generation-run-service.ts:177-194` 的
   in-flight 守卫只看 `status + error_code`，`authoring` 既不在豁免里也不在终态里 →
   这篇笔记之后每次生成都吃 `409 note_generation_in_flight`，还白占一个
   `MAX_INFLIGHT_RUNS` 槽。reaper 也救不了：它只在 `attempts+1>=6` 时把 run 打成
   `needs_attention`（`:501-511`），而那 5 次重投每次都空转 completed，attempts 根本不涨。
2. **候选写入不是幂等的**：`insertAuthoredCandidatesBatched`（`:3156-3193`）是普通多行
   INSERT，主键 `randomUUID()`，**没有 ON CONFLICT、没有先删后插**。今天的防重复完全来自
   "行锁 + status==planning"这一对。逐候选提交等于把重复候选直接放出来。

另外两条会让界面变得难看但可接受：`getGenerationRunCandidatesV2`（`generation-run-service.ts:521-543`）
对 run 状态**零守卫**，逐候选提交后审核页会列出半批；激活的"未决即丢弃"清扫
（`activation-service.ts:462-472`）会漏掉提交时还不存在的候选。

**结论**：A1 的真实前置是"重放语义 + 候选幂等"（按 `plan_objective_local_id` +
`card_content_epoch` 建唯一索引、入口守卫改成可续跑的状态机、半提交批次要能被 §7 那类
豁免识别）。这是独立一批的活，不该塞在"让进度真的走起来"里顺手做。**A1 继续挂着，不改判据。**

### A2（本批做的）：只把读数改成真的，一行锁都不动

用户 #2 抱怨的是"进度不是一格格走的"，不是"卡没一张张冒出来"。所以把**读数**做真，
把**产物**保持原子提交：

- 新表 `card_generation_run_progress_v2(run_id, workspace_id, lease_token, progress jsonb, updated_at)`，
  **故意不加 FK**：FK 会对 `card_generation_runs_v2` 取 KEY SHARE，而大事务正持着那一行的
  `FOR UPDATE`（`:1119-1127`）——加了 FK，进度写入会一直阻塞到整批 LLM 跑完，等于白做。
- 写进度前先在最简事务里做一次**只读**租约核对（`status='processing' AND lease_token=$token
  AND lease_expires_at>now()`）。只读是刻意的：大事务里的 `fenceV2OutboxLease`（`:336-347`）
  会 UPDATE 同一行并持锁到提交，若这里用 `FOR UPDATE` 就会排在它后面阻塞分钟级。
  核对不过就静默跳过——过期租约的旧 worker 写不进读数。
-  tick 点就在 `:1437 authoredCount += 1` 旁边：作者循环是 `mapWithConcurrency(planObjectives,
  V2_STAGE_CONCURRENCY, …)`，每张卡写完各触发一次 ≤1ms 的独立事务，N 张就有 N 格。
- 读取端 `readGenerationProgressV2`（api `helpers.ts:125-162`）：run 处于
  `planning/authoring/checking` 且读数行合法时用读数，其余情况仍回候选表数（终态真相不变）。
  `CardGenerationProgressV1` 的形状一个字段都不改，桌面合同不动。
- 进度写失败**绝不影响管道**：整段包成 best-effort（记 warn 后继续），读数只是读数。
- A2 做完**并不能**把 B 的 `inFlight` 分支去掉——这条是我先写错、做完才发现的：
  `run.status` 的那一列仍然写在大事务里，所以在途期间对外永远是 `planning`，
  "第 N 步"提前报会和详情页对不上。**留下的就是步数**，被换源的只有候选计数。
  真正改的是 `detail`：`planning` 分支现在也会说"已写出 3 / 8 张候选"。

### 验收（A2 版判据，替代 §18 第 1 条）
1. 把某个 run 的 status 置 `authoring` 并用 worker 的写入函数塞读数 → HTTP 轮询必须看到
   `progress.authored` 从 0 走到中间值（不再恒 0）。
2. 用**别人的** lease_token 调用同一个写入函数 → 读数行必须 0 影响、内容不变。
这两条都能用确定性路径验，不烧 AI；真跑留到本批最后测一次阶梯。

### A2 的实测（全部确定性路径，0 次 AI 调用）

新增 `workers/ai-worker/src/integration-tests/card-generation-v2-live-progress-postgres.integration.ts`
（真 Postgres，写入方以 `ailearn_worker`（NOBYPASSRLS）跑，RLS 与授权清单都被真走一遍）：

| 用例 | 断言 | 改前是否红（人为退化验证） |
|---|---|---|
| 读数在提交前就可见 | 候选表 0 行时视图报 `authored=3 / planned=8` | 把 `LIVE_PROGRESS_STATUSES` 清空 → **红**（同时带红第 3 条） |
| fence：租约被抢走 | 旧 job 再写 → 返回 false，行内容仍是 4 | 把 `if (alive.length === 0) return false` 改成永不返回 → **红** |
| 租约一死读数退役 | 过期租约 → 视图回到候选表的真 0 | 同上（清空换源） |
| 到终态读数不参与 | `review_ready` 时报候选表的 0 | — |

界面口径 `cardGenerationProgressView` 补 1 条用例（planning 内 1/4/8 三步 detail 与
percent 严格递增，且步数仍不报）；同样做过人为退化验证（去掉 planning 分支 → 该条红）。
生成中那一屏（`CardGenerationSurface.tsx`）随读数换源一起改了两处：
去掉"这一步的中间计数要等这一批写完才读得到"（0249 之后它是假话）与进度条上的
`hidden={inFlight}`（条现在会走）。这一改先补了测试（`CardGenerationSurface.review.test.tsx`
新增"生成中这一屏：张数是实时的"，改前红），并就地改掉两条钉着旧文案的断言
（`CardGenerationSurface.test.tsx` 里的 `中间计数`）。

计数：worker 集成 4/4、worker 相关单测 67/67、api card-generation-v2 全部 237/237、
桌面全量 1094/1094（其中本批三张文件 10+16+13）；shared 与桌面 typecheck 干净。

跑真接口那一段（`GET /v2/card-generation-runs/:id`，不是测试进程）：

```
lease alive   : ('authoring', {'plannedCards': 12, 'authored': 11, 'gatePassed': 5, 'gateFailed': 3})
lease expired : ('authoring', {'plannedCards': 8,  'authored': 8,  'gatePassed': 5, 'gateFailed': 3})
```

（拿 `d375f218` 这条已有 run 临时造的租约与读数：活租约时读数**盖过**已提交的 8 张，
租约过期后自动退回候选表的真相。测完已复原：run 回 `review_ready`、outbox 回
`completed`、读数表清空。）

### 唯一没测到的那条：真跑阶梯——被别人的在途迁移挡住了（如实报，不替他改）

`POST /v2/card-generation-runs` 现在在跑着的 dev API 上直接 **500**：

```
route: "/v2/card-generation-runs"  err: { category: "database", name: "Error" }
```

原因不在本批：工作区里 `notes` 的 drizzle schema 已经带 `share_scope`，而
`apps/api/src/db/migrations/0248_note_share_scope.sql` 还是**未跟踪文件、也没应用**
（`information_schema` 查 `notes.share_scope` = 0 列）。`generation-run-service.ts:160`
是全列 SELECT `notes`，于是创建生成运行直接炸。同一原因让我这条批的集成测试
一开始也起不来，我改成自己落 run 行绕开了它——**但没有替别人把 0248 应用到共享开发库**，
那是他们的在途决定。谁先跑 `db:migrate`（或应用 0248），这条 500 就消失；
在那之前任何"真跑一次看阶梯"都做不了。

## 22. 真跑阶梯：一次被并发保存杀掉，改成用确定性管道把它钉死

0248 由 note 侧应用之后（`notes.share_scope` 已存在），`POST /v2/card-generation-runs`
恢复到 202（我第一版探针按 `st==200` 判断，直接把脚本吓退了——202 才是受理码）。
挑了一篇新笔记（自造夹具，1162 字）建 run `f5ca6d61`：

```
07:51:50 V2 outbox job processing / V2 pipeline route classified
07:51:55 WARN V2 card generation outbox poll failed  (relation_error：交错/区块那对关系被判矛盾)
07:53:54 [tsx] change in ./src/handlers/companion-dialogue-content.ts Restarting...
07:53:59 [tsx] Process didn't exit in 5s. Force killing...
```

**整条管道在作者阶段被并发保存 force kill**，outbox 停在 `processing`、租约挂到 08:23:50，
run 停在 `planning`——这正是记忆里那条"崩一次赔 30 分钟 + 重投要再花一遍钱"。
我没有手动回队再跑一次：那等于为同一个测量再付一次全量 LLM，而且在这个会话里
companion 侧平均每 2-4 分钟存一次盘，第二次大概率同样被杀。

改成把**真正还没证明的那件事**钉成确定性测试（0 次 AI 调用）：前四条用例只证明
"调用写入函数时行为正确"，而调用点在 `mapWithConcurrency` 的循环体里——**位置在不在活路径上**
是它们测不到的。新增第 5 条用例用确定性 provider 把整条真管道跑完，然后断言
读数表里留下的最后一次 tick **等于候选表真正写出的张数**（`authored === COUNT(DISTINCT candidate_id)`，
且 ≥1）。这条断言对两种退化都会红：把循环里的 tick 删掉 → 读数停在 0；两处都删 → 没有行。

### 顺带修的一处别人的红（在本文档范围内）

`workers/ai-worker/src/integration-tests/card-generation-v2-postgres.integration.ts`
**自迁移 0237 起就在 before 钩子里红**：种子还在往 `workspaces` 写 `ai_consent_version`
（42703）。已改成只写 `(id, owner_id, name)`。修完之后它红在更深的一处：
`pollV2Outbox(5)` 返回 0——**dev 容器里的 worker 在轮询同一个库，会把 pending job 抢走**。
这是共享开发库上的结构性竞争，不是那条测试自己的错，我没有改它的认领方式（它测的就是
poll 路径）。我新加的那个文件因此用 `UPDATE … WHERE status='pending' RETURNING` 守卫式认领，
抢不过时明确喊"dev 容器的 worker 抢走了这条 job（重跑即可）"，而不是把租约归属当前提。

### 还没做

§18 的第 1 条判据（真 LLM 跑一次、HTTP 采到 ≥2 个中间值）仍未测。它现在唯一缺的是
**一个没有并发保存的窗口**：机制本身已经被第 5 条用例钉住，剩下的只是"真 LLM 的时间尺度上
每一格都会被采到"。下次跑之前先确认 worker 进程能安静几分钟，再考虑手动回队。
夹具笔记已删除（`notes` 级联清掉了它的 run/outbox/候选），读数表当前 0 行。
