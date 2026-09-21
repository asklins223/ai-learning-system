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

## 23. "作者总把正确项写在第 1 位"查完了：是书写习惯，不是泄漏

把 `d375f218` 那 4 道选择题的原文捞出来看（服务端读自己的库，不涉及下发）：

| 正确项在作者序列里的位置 | 选项文本 |
|---|---|
| `opt-1`（1/2） | 「逐渐拉长时间间隔，且仅适用于可独立提取的知识」 vs 「集中在一次里完成，适用于所有类型的学习材料」 |
| `opt-1`（1/3） | 「自己产生的材料比直接呈现的更易记住」/「通过主动回忆来巩固记忆」/「把复习安排在逐渐拉长的时间间隔上」 |
| `opt-1`（1/3） | 「削减外在负荷，避免削减内在负荷」/ 内在+外在一起削 / 主要削减相关负荷 |
| `opt-1`（1/3） | 「每次成功提取都会强化该条目的检索路径」/ 重新阅读加深印象 / 拉长间隔 |

**4/4 正确项都是作者写的第一个**——这就是原本记在待办里的那条"干扰项质量"线索。查下去的结论是
它**不构成答案泄漏**：`generateChoiceTask`（`run-structured.ts:268-299`）不吃作者的 id，
它先按文本去重，再给每个选项重新算 `choiceOptionId(text)`（sha256 前 10 位），
公开序列是 `[...ids].sort()`。所以屏幕上第几个是正确项，由**选项文本的哈希**决定，
与作者把它写在第几位无关，也不同卡片间不可预测。这条性质本来就有断言守着：
`run-structured.test.ts:117-119`「选项序列按内容哈希定序：与作者书写顺序无关」。
于是这一项从"待修"改判成"已验证不是缺陷"，不改 prompt、不加码。

真正剩下的只有内容质量的一点观察：第 2 题里「自己产生的材料更易记住」（生成性效应）与
干扰项「通过主动回忆来巩固记忆」（提取练习）边界偏近——两者在原文里是相邻的两个概念。
这是"干扰项够不够锐"的问题，不是错误；等下一次真跑顺带多看几道再决定要不要在 prompt 里
要求"干扰项必须来自另一个概念而不是同一概念的近义改写"。

### §22 尾注：第二次真跑尝试也没能开跑（08:14 起 dev API 不是我们的代码起不来）

08:06 前后 worker 已连续 8 分钟没有重启，于是重建夹具准备再试一次真跑。脚本在**登录请求**上
就被断开：`ready` 探测返回空（curl exit 52）。日志给的是别人的在途状态，两条连着来：

```
8:14:15 [tsx] change in ./src/modules/note/service.ts Rerunning...
  SyntaxError: The requested module '../note/service.ts' does not provide an export named 'computeContentHash'
8:14:50 [tsx] change in ./src/modules/import/markdown-import-service.ts Rerunning...
  TransformError: markdown-import-service.ts:18:74: Unexpected "}"
```

也就是说此刻 api 进程**根本起不来**（不是某个路由 500）。这不是我该动的文件，没有替他们改。
夹具笔记已删（级联带走它的 run/候选），读数表 0 行。

顺带清出来的一条旧账（不动，只报）：库里还有一挂 `planning` 的 run `9b536df1`（2026-08-19，
笔记"间隔重复是一种学习策略…"，它的 outbox job 已是 `failed`）——它就是 §7 那类
"死批次"豁免要认得的形态，占着一个 `MAX_INFLIGHT_RUNS` 槽。

真跑阶梯**目前不是关键路径**：tick 落在活路径上这件事已由第 5 条确定性用例钉住
（`authored` 读数 == 候选表张数）。真跑只剩"真实时间尺度上每一格都会被采到"这一条观感，
需要的前提有两个：api 能起来，且那一次生成期间没有 agent 在存 `workers/ai-worker/src`。

## 24. 把"被并发保存杀掉"的代价从 30 分钟压到秒级（关停时交还租约）

§22 那次的真实损失不是"跑失败了"，而是**付费管道被 tsx 强杀之后，这条 run 的租约还要挂
满 30 分钟**：`reapStaleV2OutboxJobs` 的认领条件是 `lease_expires_at < now()`，而 V2 的租约
本来就是 30 分钟（为了不把正常的分钟级管道误回收）。这半小时里那篇笔记被 in-flight 守卫
锁死，钱也已经付了。drain 分支帮不上：它的注释早就写明"orphaned running jobs will be
reaped by the next worker startup"，但下一个 worker 启动时租约**还没过期**，reap 空转。

改法是加一条"交还"，不改任何既有的接管语义：

- `releaseV2OutboxLease(jobId, leaseToken)`：`SET lease_token = NULL, lease_expires_at = now()`
  （带 `status='processing' AND lease_token=$token` 的 CAS）。
  清 token 是关键——本进程那个还没提交的大事务随后会在自己的 `fenceV2OutboxLease` 上失败并
  回滚，迟到的 complete/fail 也过不了 token CAS，**双付防护照常成立**，只是不再挂 30 分钟。
- 不动 `status`：重投继续由唯一那条 reaper 路径负责（attempts+1 + 退避 + pending），
  不另起一条"快速接管"，免得两处语义漂移。
- `index.ts` 的 drain 分支在等排空**之前**调用 `releaseInflightV2OutboxLeases()`。
  顺序是有意的：tsx 只给 5 秒，交还必须先发生。为此把 `v2Inflight` 从 `Set<Promise>` 换成
  `Map<Promise, {jobId, leaseToken}>`（`getV2OutboxInflightCount` / `waitForV2OutboxDrain`
  跟着改，行为不变）。

### 测到了什么、没测到什么（说清楚）

用例 6（`…live-progress-postgres.integration.ts`）钉住三件事，全在真 Postgres 上：
交还返回 true、重复交还返回 false；**迟到的 `completeV2OutboxJob` 0 行**（job 仍 processing，
不会由将死的进程替别人结算）；交还后的行**正好落在 reaper 自己的认领谓词里**
（`status='processing' AND lease_expires_at < now()`），即"下一轮 sweep 必重投"。

没测的是那 6 行调用点本身：`releaseInflightV2OutboxLeases` 需要一个在途 job 才有条目，
而模拟它要么给产品代码开测试后门，要么在本机再起一个 worker 抢同一张队列——两个都不做。
日志里新加的那行 `V2 outbox leases returned…` 会在下一次"保存正好撞上有 run 在跑"时给出实证。

### 一处我造成的副作用（如实记）

写第一版用例 6 时我直接调了 `reapStaleV2OutboxJobs(100)`。它按 `ORDER BY created_at LIMIT n`
**全表扫**，于是把库里若干条早就没人管的 outbox 行顺手结了（worker 日志里三条
`V2 outbox job failed … semantic spec schema violation`）。核对后没有伤到活数据：
那 25 分钟内没有任何 run 行被改写（查过），仍在进行中的 run 还是 1 条（就是 §22 提到的
那挂 8-19 僵尸 `9b536df1`，它的 job 早就是 `failed`，reaper 也救不动它）。
用例已改成上面那条**本地谓词断言**，不再调全局 reaper——测试不该扫别人的表。

## 25. A2 的读数其实没实时：tick 加入了管道大事务（已修 + 已钉）

§21 说 A2 做完"读数在整批提交之前就能被 API 读到"，§22 说"tick 落在活路径上"已由第 5 条
用例钉住。**这两句都过强了**，16:45 那次真跑把它证伪了。

### 真跑现场（夹具笔记「进度阶梯实测夹具：记忆与学习的七个概念」）

run `c1fbba41`：19 次真 LLM 调用（qwen3.8-flash 全 success）、管道 **124.3 秒**、8 张候选
（4 过门禁，含 2 张 `single_choice` 练习件）、终态 `review_ready`。HTTP 轮询只看到两个值：

```
    0.0s planning        planned=0 authored=0
  124.3s review_ready    planned=8 authored=8
authored 采样序列: [0, 8]
```

### 根因：`withWorkerWorkspaceTransaction` 会加入当前作用域那条事务

- `writeCardGenerationLiveProgress` 调 `withWorkerWorkspaceTransaction`，而
  `workers/ai-worker/src/db.ts` 的语义是"**已经在一个 worker 事务作用域里就直接加入它**"
  （`const active = workerScope.requireActive(normalized); if (active) return operation(active.transaction)`）。
- 两个 tick 调用点（handler `:1517` 规划后、`:1545` 每张卡写完）就在
  `processCardGenerationPlan` 自己那条分钟级事务里（`:1205` 开的 scope），context 同为
  `{ workspaceId, userId: null }` → AsyncLocalStorage 必然命中 → **读数写进了大事务**。
- 于是"独立短事务"只存在于设计文字里：§21 的实测（拿 d375f218 手造租约与读数）和第 1 条
  用例都是**在作用域之外**调用写入函数，那才会走到真正独立的分支；第 5 条只断言
  "最终读数 == 候选张数"，不校验"提交前可见"，所以照样全绿。

三条互相印证的证据：

| 证据 | 读数 |
|---|---|
| 读数行 `updated_at` | `08:45:24.170456+00` —— 与候选行、事件、`run.updated_at` **逐微秒相同**（都是大事务的 `now()`） |
| outbox `processed_at` | `08:47:28.103708` —— 真实结束时间，比读数晚 124 秒 |
| `ladder3.log` | 124.3 秒里 `authored` 只取到 `[0, 8]` |

### 改法（本次）

1. `db.ts` 的 `withWorkerWorkspaceTransaction` 增第三个参数 `{ isolated?: true }`：给了它就
   **强制** `db.transaction(...)` 开新连接，不加入 ambient scope（RLS 上下文照旧在事务内设置）。
2. `writeCardGenerationLiveProgress` 传 `{ isolated: true }`。
3. 新用例「**tick 不加入调用方的事务：外层回滚，读数仍在**」精确复现活路径条件——在
   `withWorkerWorkspaceTransaction` 里调写入函数然后故意回滚，读数必须留得下。
   改前红（`expected 2` / 实际没有行），改后绿；这条比"轮询等中间值"确定性得多。

回归：worker 集成 7/7（原 6 条 + 新增 1 条）、worker 单测 700/700、`workers/ai-worker`
typecheck 干净。

### 真跑阶梯：修完当场复测，成立

同一篇夹具内容（3085 字节的「记忆与学习的七个概念」）新建 run `aabb1ff1`，修复后的 worker
（tsx 已重载）跑真 LLM：

```
   19.5s planning   planned=8 authored=0
   39.9s planning   planned=8 authored=1
   41.0s planning   planned=8 authored=2
   42.0s planning   planned=8 authored=3
   43.0s planning   planned=8 authored=5
   44.0s planning   planned=8 authored=6
   48.1s planning   planned=8 authored=8
  103.2s review_ready planned=8 authored=8 passed=7 failed=1
authored 采样序列: [0 ×39, 1, 2, 3, 5, 6, 6, 6, 6, 8, 8 …]
不同取值: [0, 1, 2, 3, 5, 6, 8] → 中间值 5 个
```

§18 的判据（"`authored` 从 0 单调涨到 N，且中间值至少出现 2 次"）**满足**；对比修复前那次
`[0, 8]`（两个值、124 秒）。第二条独立证据：读数行 `updated_at = 09:14:35.282` 而 outbox
`processed_at = 09:15:30.371` —— 相差 55 秒，读数确实是**管道中途**提交的；修复前这两个
时间戳逐微秒相同。

顺带复现了 v25 的产出（这批 8 张候选里 4 张 `single_choice` + 1 张 `true_false`）。
夹具笔记与读数行测完即删（读数表无 FK，需单独删）。

### 仍未做

- §18 的 A1（逐候选提交，让"张数"之外还能报"第几步"）仍按 §21 的判定挂着：前置是重放
  语义 + 候选幂等，独立成批。现在读数这一半已经真了，界面上"第几步"仍只在 planning 分支
  有文案（`run.status` 那一列还是跟着大事务走）。

### 顺带记一条别人的红（未修，只报）

`apps/desktop-client/src/renderer/src/components/CardGenerationSurface.tsx` 之外，
`docs` 里那份 note-to-card 文档提到的 `apps/api` typecheck 两处仍在（`note-service-extra.test.ts`
要 `cleanTitleCandidate` / `deriveNoteTitle`，而 `modules/note/service.ts` 在途改动已不导出）。

## 26. 客观题第一次被真人在界面上答完：第三处"逐字枚举"把判分静默掐了（已修）

### 现场（用户截图 + 库）

在真机上把激活的 `single_choice` 卡答完（选中正确项、提交），界面停在：

> 等待下一步 / 正在准备下一步。 —— 用户原话："我就一直在这里等着？所以我打完题之后是在干嘛"

`learning_assessments`：`source=deterministic_structured`、`status=**not_assessable**`、
`rubric_results=[]`、run 落在 `checkpoint`。答案本身是对的，判分却什么也没说。

### 根因：`finishStructuredAssessment` 里还留着**第二份**逐字枚举

`run-service.ts` 的**路由**那一侧上一批已经改用共用表（§7 第 2 条记过），但
`run-processing-tick.ts` 的评估侧仍是：

```ts
if (payloadKind !== "ordering" && payloadKind !== "relation"
    && payloadKind !== "repair" && payloadKind !== "structured_bundle") {
  throw new CriticOutputError("structured assessment: unsupported payload kind");
}
```

`choice` / `true_false` / `matching` 三种客观题载荷走到这里必然抛错 → 外层 catch 把它
收成 `not_assessable` + `checkpoint{kind:"not_assessable"}` → 就是截图那一屏。

**这是同一个失效形状的第三次出现**（§7 的两条 + 这一条）：新种类加进合同与路由，
却漏了最后一公里那张手抄的表，而且**单测全绿**——`run-structured.test.ts` 测的是
`assessStructuredPayload` 本身，根本走不到这道闸门。

### 改法

1. 闸门改成共用表：`isDeterministicStructuredPayload(payloadKind)`（`run-structured.ts`
   导出的那一张），两侧不再各抄一份。
2. `run-structured.test.ts` 补一条：planner 造得出的七种结构化载荷必须全部为 true，
   `text_response` / `voice_teachback` / `declared_unable` 必须为 false。
3. **checkpoint 不再装成"后台在准备"**（同一张截图的第二个问题）：
   - 真机复测发现 `activate_followup` / `finish_without_commit` 这两个**下一步**落在
     折叠的「更多选择」里，屏上只剩「安全退出」→ 现在提到明面上；
   - 文案改成说清为什么停住（"这次没有形成可记录的结论"/"这次只证明了一部分"），
     不再写"正在准备下一步。"——checkpoint 等的是用户，不是后台。
   - 桌面测试补一条，断言这两个按钮 `closest("details") === null`（**改前红**：
     `expected <details> to be null`；只断言"查得到按钮"是不够的，jsdom 在折叠
     details 里也查得到）。

### 真机复测（第二个目标 `d90329cb`，走完整界面链路）

星窗 → 目标详情 → 开始首次验证 → 「改做选择题」→ 选中正确项 → 提交：

```
learning_assessments: deterministic_structured | completed | practice_only
rubric_results: [{facet:"recall", verdict:"covered", userFacingReason:"选择正确"}]
learning_runs.phase: completed
同一时段模型调用: 0 次
```

界面实读「练习完成 / 逐条判定：回忆 · 说清了 / 选择正确 / 本次属于练习，不改变复习」。

### 顺带修好的两件（真机复测的入场券）

1. **备选模态终于说得出名字**（§3 D5 的后半）：`taskAlternativeDescriptorSchema` 增
   `interactionKind`，`run-view.ts` 随备选一起下发；按钮从清一色「换一种方式」变成
   「改做选择题」/「改用语音讲解」/「改用自己的话回答」。
2. **桌面端接上 `packages/shared` 实时源码**（§4 第 2 条记的那笔基建债）：
   `tsconfig.web/node.json` 加 `paths`、`electron.vite.config.ts` 给 main/preload/renderer
   加 alias（外加 renderer 的 `server.fs.allow`）。此前改 shared 的合同在桌面端
   **默认不可见**，只能手工 rsync 覆写 pnpm 快照——这次改 `interactionKind` 时先被它绊了一下。

### 顺带修的别人的断点（只报 + 最小修复）

- 桌面主进程起不来：笔记协同带进来的 `ws` 让 Vite 给可选 peer `bufferutil` 生成了
  **模块顶层 throw** → 整个 app 打不开。已在 main 的 `rollupOptions.external` 里放行这两个
  可选原生依赖（运行时 require 失败 → ws 自己退纯 JS）。
- 笔记库整页「暂时不可用」：`GET /v2/notes/:id` 500。根因不在代码，而在**手写的夹具行**：
  `note_versions.content_hash` 是 `'staircase-fixture'` 这类非 32 位 hex，strict 投影直接
  拒绝。按仓库自己的不变量（migration 0029：`md5(content_json::text)`）全库校正了
  1063 行，接口恢复 200。

## 27. D6 落地：练习件配额（planner 按整批点名）+ #18 后半

### D6 的实现形状

和 `allocateStrategies` 同源——**配额是整批的事**，逐张出题的作者看不到同批其他卡：

- `allocatePracticeForms(forms)`：一批 N 张至少 **⌈N/2⌉** 张被点名"必须交练习件"；
  在同一形态允许的形状里取**本批用得最少**的那个（模态铺开），并列取该形态首选；
  **形态边界优先于铺开**（`sequence` 只有 ordering，不会为了铺开塞选择题）。
- `PlannedObjectiveV2.practiceForm`（planner 分配、必填可空）随规划冻结；author 提示
  v26 按名字点名：「这一批要求本卡必须交出一道 `true_false` 练习件」。
- 提示里同时写明 **"证据确实不支持时仍然写 null —— 配额不是伪造干扰项的理由"**：
  D6 的"凑不满不强造"与 D4 的"干扰项必须有证据"是同一条线，配额只决定"要求谁交"。
- 缺额怎么记：作者交 null 时不重跑、不淘汰候选（练习件不是判分内容），这一批的
  实际带件数在候选表上直接可数（`objective_draft->'practiceItem'`）。

回归：shared 336/336（新增 1 条：4 张卡至少 2 张被点名、同形态内形状铺开、
形态边界优先）、worker 700/700（新增 1 条：点名的卡在提示里点名到具体形状）、
api card-generation 243/243（含两侧 prompt 版本同步 v25 → v26）。

### #18 后半：来源行「笔记已出卡」

服务端一次批量聚合（不按行发请求）：批次按 `note_id` 直连，正式目标经
`learning_objective_origins_v2.note_id` 连——目标自己没有 sourceId，它的来路记在 origins 上。
界面在「已生成 N 篇笔记」下面补一枚 chip，三档互斥：
`已出 N 张学习卡` / `N 批学习卡待审核` / `还没出学习卡`；没出笔记的材料**不显示**这一档
（不替它编一个进展）。

真机实读（来源目录）：

```
IndexTTS 2.5 … → 已就绪 / 已生成 1 篇笔记 / 已出 4 张学习卡
IndexTTS 2.5 … → 已就绪 / 已生成 1 篇笔记 / 已出 2 张学习卡
间隔重复是一种学习策略… → 已就绪 / 已生成 1 篇笔记 / 1 批学习卡待审核
GitHub - asklins223/… → 已就绪 / 还没生成笔记        （没有第三档）
```

### 仍未做（如实）

- **A1（逐候选提交）**：按 §21 的判定继续挂着。它要动的是防重复计费那把锁，前置是
  **重放语义 + 候选幂等**（唯一索引 + 可续跑的状态机），并且方案自己写了硬判据
  （双 job 竞态注入测试，第二个 worker 在所有写入点必须 0 行受影响）。A2 已经把用户
  可见的那一半（候选计数逐格走）做成真的并经真跑验证；剩下的是界面上的"第几步"，
  不值得在同一个会话里赶工动那把锁。
- 桌面 `desktop-ipc-note-doc.test.ts`（3 条）与 `source-service-extra.test.ts`（1 条）
  此刻是红的，都是并行 agent 在途的笔记协同/内容哈希改动，本批未触碰。



## 26. 复核 D6：配额点名了，但没人回答"到底交没交上"（已补）

§25 之后回看 D6（`4432fe90` + `b76fb759`，别的会话落的）。分配那一半是对的
（⌈N/2⌉、形态边界优先于铺开、`practice_quota_required` 进 reasonCodes），但**结项那一半只在
注释里存在**：`planner-service.ts:678` 写着"缺额由 `practice_quota_short` 记账"，而全仓库
grep 这个词只命中这一行注释——没有任何代码发出它。author 提示又明确要求"证据不支持时写
null"（这条本身是对的，D4 不许造题），于是结果就是：**点名之后交没交、交的是不是被要求的
形状，数据上完全读不出来**。

这和 `strategy-allocation.test.ts` 文件头记的那个老缺陷同形——"题型勾选写进 spec 却没人读"，
配置存在而闭环不存在。所以补的不是"更硬的配额"，是**结算**：

- `summarizePracticeQuotaV2(objectives, deliveredFormByObjective)`（planner-service，纯函数）
  返回 `{ requiredCount, metCount, misses[] }`。三条判据都有用例：
  **形状对上才算兑现**（要求 `true_false` 交了 `matching` 记缺额——铺开没发生就不算数）、
  **候选被淘汰也算缺额**（映射里没有这个 localId → `deliveredForm: null`）、
  **没被点名的卡自愿多交不占别人的名额**（`metCount` 只数被点名的）。
- 管道在终态判定前（handler `:2377` `survivors` 之后）发一条
  `card_generation.practice_quota_short`，载荷就是上面三个数加逐条 miss。
  事件载荷的 key 不在 `BLOCKED_EVENT_PAYLOAD_KEYS` 里（那几个键不带内容，只带形状名），
  出口过滤照旧通过；`survivors.length === 0` 时不发（那条路径已有
  `deck_gate_report` / `no_cards_recommended` 说明为什么是零）。
- 注释改成指向真正的发出点，不留"注释承诺、代码不做"的下一次。

**没做的**：这条事件目前只在库里，界面上没有"配额缺 N 张"的读数。要不要显、显在哪
（生成完成回执？审核页头部？）是产品决定，不在这次顺手加。

### 复核过别人的三批改动（不采信提交信息，逐条重跑）

| 改动 | 我的复核 |
|---|---|
| `2d6d102e` A2 缺陷（tick 加进了管道大事务） | 成立。`withWorkerWorkspaceTransaction` 命中 ambient scope 是 `db.ts` 的既有语义，我的两个 tick 就开在那条分钟级事务里；我原来的三条"可见性"用例都是**在作用域外**调用写入函数，所以全绿却什么都没测。他们新增的「外层回滚、读数仍在」正是缺的那条——我复跑 7/7 绿，并确认 `{ isolated: true }` 只被 tick 使用。真跑复测 `[0,1,2,3,5,6,8]` 有 `ai_audit_log` 09:14:06–09:15:30 的 18 次 success 佐证。 |
| `a90bcf8f` 客观题判分第二份逐字枚举 | 成立且是**我的**遗留：上一批我只把路由那一侧改成共用表，`finishStructuredAssessment` 里还留着第二份 kind 枚举，choice/true_false/matching 走到这里必然 fail closed → `not_assessable`。补的"七种结构化载荷全部为 true"断言是对的修法。 |
| `b76fb759` D6 分配 | 分配正确、正交于 strategy；缺结算（本节已补）。另注意 `4432fe90` 与它是同一标题的两个提交（后者只改 1 行测试），读历史时别当成两件事。 |

回归（我自己重跑，不看提交信息）：shared 全量 337/338、worker 单测 698/698、
api card-generation 237/237、四端 typecheck；那 1 条 shared 红是**别人未提交的**
`note-projection-contracts.ts` 在途改动（`git status` 里它是 M，测试文件却是旧提交里的），
不在本批范围内，只报不改。

## 27. 结算函数拿库里 630 个真实批次跑了一遍：D6 还没被任何一批喂过

不需要 api、不需要 AI，先把能测的测掉：把 `card_generation_plans_v2.result->objectives`
与每批的最新修订候选全量导出（630 批），用 §26 那个 `summarizePracticeQuotaV2` 逐批结算。

```
库里带计划的批次总数: 630
被 D6 点名过的批次数: 0（其余 630 批是 D6 之前的计划，practiceForm 全为 null）
全部批次里实际存在的练习件形状: ordering 6、single_choice 6、true_false 1、matching 0
```

两点要如实说：

1. **D6 到目前为止一次都没被真跑喂过。** 最新几批计划的目标对象里连 `practiceForm` 这个
   key 都没有（不是 null，是没有），而合同是 `.strict()` 必填可空——说明这些计划都写在 v26
   之前。所以 §26 那条结算"接上了但还没吃过数据"，第一个 D6 批次跑出来后才是它第一次真验收。
   （旁证：D6 提交在 18:30，而库里最后的生成是 08:45 与 09:14 两轮。）
2. **配对题仍然是 0。** `relationship` / `comparison` 这两个形态本来就只在 D6 的铺开表里
   才会被点名成 `matching`，所以这条也只能等第一批 D6 生成。

### 顺带把"干扰项够不够锐"这条量完（判：不动 prompt）

把那 6 道选择题的选项原文全捞出来看了。两条最新的是这样：

- 样例效应：正确项「对新手提供完整解答，对熟手提供问题」，干扰项是**同一条规律的镜像倒置**
  （「对新手提供问题，对熟手提供完整解答」）加一条「无论新手熟手都只给解答」。
- 必要难度：正确项「难度来自提取过程本身」，干扰项「难度来自材料含糊或指引不清」，
  而原文恰好明确把后一种排除在定义之外。

6 条里 5 条是这种"倒置/越界"型干扰项，1 条偏近（生成性学习与提取练习那对）。三个选项都带
`evidenceRefIds`。结论是**不加**"干扰项必须来自另一个概念"这类提示：现有证据绑定要求已经
把造题压住了，加这条反而更容易把模型推向"换个不相干的概念编一个"，那是 D4 明确不许的方向。
留到第一个 D6 批次出来后再看一次样本。

### 现场又被同一类原因挡住了（第三次，记全）

`packages/shared/src/note-share-contracts.ts` 是别人**未提交**的新文件，
`apps/api/src/modules/note/routes.ts:28` 深导入它，但 `packages/shared/package.json` 的
`exports` 里**没有登记这个子路径** → api 进程启动即
`ERR_PACKAGE_PATH_NOT_EXPORTED`，`/ready` 空回复，桌面端整个停在「学习服务暂时不可用」。
陷阱在于 `tsc` 查不到：api/worker 的类型走 tsconfig `paths` 看活源码，运行时 Node ESM 走
`exports`，两边可以一个绿一个炸。容器里 `node_modules/@ailearn/shared` 已确认是指向
`/app/packages/shared` 的软链，所以**不是**快照过期，不要去重装依赖或 rsync。

这条不在我的范围里（是别人在途的归属边界批次），只报不改。等它补上 exports 之后，
#29 那两处真机界面复测才有条件跑。

## 28. 把 D6 套在真实形态分布上投影：配对题是"没被要求过"，不是"造不出来"

还是不需要 api、不需要 AI：用真的 `allocatePracticeForms` 跑 §27 导出那份存量计划
（630 批里 456 批的目标带 `knowledgeForm`，共 1533 个目标）。

```
点名总数: 933 张（占目标 61%）
形状分布: single_choice 345 / matching 338 / true_false 183 / ordering 67
允许形状为空、永远点不到名的形态: 无
```

每批目标数与点名比例：

| N | 批次数 | 平均每批点名 | 占比 |
|---|---|---|---|
| 1 | 175 | 1.00 | 100% |
| 2 | 13 | 1.00 | 50% |
| 4 | 89 | 2.00 | 50% |
| 5 | 135 | 3.00 | 60% |
| 8 | 6 | 4.00 | 50% |

三条结论：

1. **61% 这个高于"至少一半"的数是 ⌈N/2⌉ 的进位造成的，不是配额松了。** 单卡批次有 175 个
   （占 38%），N=1 时下限就是 1，等于"这批唯一一张必须交练习件"。真实笔记里也有单卡批次，
   所以这不是纯夹具问题——要不要给 N≤2 留"不强求"的余地，是产品决定，我没动配额。
2. **配对题的缺额是需求侧从没被点名。** 存量形态里 `relationship` 385 个、`comparison` 221 个，
   这两个形态的允许形状第一位就是 `matching`；D6 一旦生效，仅 N≥5 的 167 批就应点名
   约 155 次 matching，而库里历史上 matching 练习件是 **0 张**。所以 §27 那句"配对题还是 0"
   的真正原因是"作者从来没被要求过"。这条给了第一批 D6 一个可证伪的预期：
   **点名里有 matching，交出来的却还是 0，那才是作者侧供给问题**（配套事件见 §26）。
3. **投影的可信度以子集为准。** 只取 N≥5 的 167 批重算：点名 58%，形状分布
   `single_choice 206 / matching 155 / true_false 149 / ordering 33`，与全体一致，
   说明结论不是被那 175 个单卡夹具批次撑出来的。

（另：截至本节写作时 dev api 仍因 §27 末尾那条缺 `exports` 的在途改动起不来，
#29 的两处真机界面复测与"第一批 D6 真实生成"都还压着。）

### 首批 D6 的对账查询（已在存量上跑过，可执行、返回 0 行）

```sql
-- D6 首批验收：对账"计划点了名"与"作者实际交出的形状"，并列出缺额。
-- 与 summarizePracticeQuotaV2 同一判据：形状对上才算兑现；候选被淘汰也记缺额。
-- 跑出行的那一刻就是第一批 D6 生效的证据。事件是否落下另查：
--   select payload from card_generation_events_v2
--   where run_id = :'run_id' and event_type = 'card_generation.practice_quota_short';
WITH named AS (
  SELECT r.id AS run_id,
         r.created_at,
         o ->> 'objectiveLocalId' AS oid,
         o ->> 'knowledgeForm'     AS knowledge_form,
         o ->> 'practiceForm'      AS required_form
  FROM card_generation_runs_v2 r
  JOIN card_generation_plans_v2 p
    ON p.run_id = r.id AND p.plan_version = r.current_plan_version
  CROSS JOIN LATERAL jsonb_array_elements(p.result -> 'objectives') o
  -- 关键：键必须存在（不是判 null），旧批次的目标对象里根本没有这个键
  WHERE o ? 'practiceForm' AND o ->> 'practiceForm' IS NOT NULL
), latest AS (
  SELECT DISTINCT ON (c.run_id, c.plan_objective_local_id)
         c.run_id,
         c.plan_objective_local_id AS oid,
         c.quality_state,
         c.objective_draft #>> '{practiceItem,kind}' AS delivered_form
  FROM card_generation_candidates_v2 c
  ORDER BY c.run_id, c.plan_objective_local_id, c.revision DESC
)
SELECT n.run_id,
       n.created_at::timestamp(0),
       count(*) AS required_cards,
       count(*) FILTER (WHERE l.delivered_form = n.required_form) AS met_cards,
       count(*) FILTER (WHERE l.run_id IS NULL)                    AS dropped,
       count(*) FILTER (WHERE l.run_id IS NOT NULL
                          AND coalesce(l.delivered_form, 'null') <> n.required_form) AS wrong_shape,
       string_agg(DISTINCT n.required_form, ',')                  AS required_shapes,
       string_agg(DISTINCT coalesce(l.delivered_form, '-'), ',')  AS delivered_shapes
FROM named n
LEFT JOIN latest l ON l.run_id = n.run_id AND l.oid = n.oid
GROUP BY n.run_id, n.created_at
ORDER BY n.created_at DESC;
```

判据写死了两件事：**必须用 `o ? 'practiceForm'` 判键存在**（旧批次不是值为 null，是压根没有这个键，只判 null 会把它们全筛进来）；
**`dropped` 与 `wrong_shape` 分开数**——被淘汰的候选和交错形状的缺额是两回事，只有后者才说明
"要求 true_false 却交了 matching"。事件侧另查 `card_generation_events_v2` 里那条
`card_generation.practice_quota_short`（注释里带了语句）。

## 29. 重放防护有了用例，但它顺手纠正了 §21 的一处推断

新用例 8（`card-generation-v2-live-progress-postgres.integration.ts`）钉的是今天的现状：
同一个 run 的 job 换一把新租约重投之后，**不新增候选、不新增 authored 事件、不动终态**，
并且 job 必须被正常结算为 `completed`（守卫认出 run 已不在 `planning`，安静让路）。

写它的时候差点留下一条空测试：只断言前三件"没变"的事，我把入口守卫
（`card-generation-v2-handler.ts:1250` `if (run.status !== "planning") return;`）整段摘掉，
用例**照样全绿**——因为"重投炸在半路"和"重投安静让路"在候选数与事件数上完全同形。
补上"job 必须 completed"之后，同一个变异立刻让它变红。这条教训另存了一份记忆
（否定式断言必须配一条肯定式）。

红的时候报出来的东西比"守卫很重要"更有用，它纠正了 §21 里我的一句话：

- §21 写的是"逐候选提交等于把重复候选放出来"。今天实测的边界是：**只拿掉入口守卫并不会双写候选**，
  第二次执行会去撞同一个 `plan_version`（唯一索引），失败后 job 退回 `pending`。
  也就是说，缺守卫得到的不是"两批卡"，而是**重试循环**（每轮再付一次钱）。
- 所以 A1 的前置要这样改：入口守卫是现在**唯一**让重投安静下来的机制。换成"可续跑的状态机"时，
  如果只加幂等的候选写入而没给守卫一个等价替代，得到的是重复计费的重试风暴，不是重复卡片。
  候选幂等仍然是必需的（防的是另一件事：同一目标被写两遍），但它不是全部。

用例 8 之后这个文件共 8 条，全绿；两次变异（摘守卫、放松形状判据）都验证过会红。

另记一条现场：`workers/ai-worker` 的 typecheck 现在有一条红在别人的在途文件上
（`src/handlers/companion-daily-summary.test.ts:3` 要 `buildSummaryText`，
`companion-daily-summary.ts` 已不导出）。不在本批范围，只报不改。

## 30. 真机复测（一处成了、一处被热重载打断）+ 库清理，顺带撞出一个删除缺陷

### 审核页这一处：过了，是在跑着的 app 里逐张读的

`cdp` 走真鼠标点击进 笔记库 → 「学习科学术语定义集」→ 审核学习卡，把 8 张候选逐张翻完，
读右侧那张表里的「随卡练习」行：

| 候选 | 界面读到 |
|---|---|
| 1 | 没有，只能用自己的话答 |
| 2 | 判断题 · 对不对二选一 |
| 3 | 没有，只能用自己的话答 |
| 4 | 选择题 · 2 个选项 |
| 5 | 没有，只能用自己的话答 |
| 6-8 | 选择题 · 3 个选项 |

与库里那批的 `practice_item` 一字不差（1 张判断 + 4 张选择，选项数 2/3/3/3，其余 3 张没有），
顺序也对得上。截图留在 `/tmp/cdp-review.png`：这一行没有把选项文本或正确项带上界面，
也没出现别的会话刚修过的那类竖排挤压。

### 生成中那一屏：没抓到图，原因不在产品

要读的是 `.card-generation-progress` 那块（在途时"已写出 N / M 张"与进度条不再被藏）。
我用夹具 run 造了一次活租约 + 读数（测完已还原：run 回 `activated`、outbox 回 `completed`、
读数行删净，`card_generation_run_progress_v2` 现在 0 行）。但每次点进去，界面就被重置回房间——
note 侧此刻正在改 `desktop-ipc.ts` / `note-doc-state.ts`，渲染层每隔几十秒被 HMR 打断一次。
这一处现有的证据是：组件用例（改前红过）+ 真路由实测（活租约报 11/12、租约过期回候选表真相 8/8）。
图等他们停手再补，不在别人的保存缝隙里硬撑。

### 库清理（你批准的三件）

- **8-19 那挂僵尸 run 已取消**（`9b536df1…` → `cancelled`），现在库里"仍在进行中"的 run 是 0。
  顺带记我自己的一个错：第一次我用了一个**抄错的 uuid** 打 cancel，拿到 404 就差点写成"它已经不在了"，
  回库按主键一查才发现是 id 错。以后"报不存在"之前必须先查一次。
- **夹具笔记已进回收站**（`DELETE /notes/:id` 返回 204）。它留下的 **2 张已激活卡我没动**——
  那已经是产品数据，要不要一并撤掉你说一声。
- **`f01c70ec` 那两批的实情变了**：09-21 那批（`e87dc46f`）已经 `activated`，不再是"两批并存"；
  现在只剩 09-18 的 `dcc809e2` 有 4 张待决定，在界面里点保留或「结束本次审核」就行，不用我代做决定。

### 撞出来的一个缺陷（note 侧，只报不改）

彻底删除这篇夹具笔记时 `DELETE /notes/:id/permanent` 返回 **500**。日志把 DB 细节吞了
（`category: "database"`，无 message），我在回滚事务里复现同一条删除才拿到真因：

```
ERROR: update or delete on table "note_versions" violates foreign key constraint
       "learning_cards_v2_note_version_id_fkey" on table "learning_cards_v2"
DETAIL: Key (id)=(336e0654-…) is still referenced from table "learning_cards_v2".
```

也就是说：**笔记派生出的卡还活着时，"彻底删除"不是被拒绝，而是崩**。用户看到的是一句
"服务器内部错误"，拿不到"这篇笔记还有 N 张卡在复习队列里"这个真实原因。按本仓库的口径
这该是一个带原因码的 409。不在我的域里，没动。

## 31. 第一批 D6 真跑：配额 3/3 兑现、史上第一张配对题；顺手挖出一个会烧掉整批的修复缺陷

api 恢复后（见 §30 之前那条 exports 纠正）拿夹具笔记跑了一次真生成，run `dbf061fb`。

### 阶梯：这次是完整走出来的

第一次尝试（12:05 起）：`planned=8`，`authored` 依次 `0 → 2 → 3 → 4 → 5 → 6 → 7 → 8`（33.5s→77.6s）。
第二次尝试（重投后）：`planned=6`，`authored` `0 → 1 → 2 → 3 → 4 → 5 → 6`。
两轮的中间值都在 HTTP 轮询里被采到，§18 第 1 条判据这次是真的满足了（不是手造租约，是真管道）。

### D6 对账：点名 3 张，兑现 3 张，形状全对

| 目标 | 形态 | 点名 | 实交 | 判定 |
|---|---|---|---|---|
| obj-atom-1 | definition | single_choice | single_choice | 兑现 |
| obj-atom-2 | comparison | **matching** | matching | 兑现 |
| obj-atom-3 | causal_model | true_false | true_false | 兑现 |
| obj-atom-4 | application_rule | - | - | 未点名 |
| obj-atom-5 | boundary | - | - | 未点名 |
| obj-atom-6 | procedure | - | ordering | 未点名（作者自愿交） |

三点值得记：⌈6/2⌉=3 与实际点名数一致；`practice_quota_short` **没有**落（因为没有缺额，
这正是"只在缺的时候喊"的设计）；那张没被点名的 procedure 卡自己交了 ordering，
而结算没有拿它去抵别人的账（§26 定的规则在真数据上生效了）。

**配对题从 0 变成 1。** 内容不是摆设：`提取练习→产生可迁移的提取路径`、
`重新阅读→产生熟悉感`、`掌握错觉→衡量识别流畅度`，三对各带 evidenceRefIds。
这印证了 §28 的投影结论——过去 matching 为 0 是"从来没被要求过"，不是模型造不出来。

### 挖出来的缺陷：有界修复会把整批已付费的调用作废

第一次尝试跑到 pedagogy 判 `repair` 之后**抛 TypeError 死掉**：

```
TypeError: Cannot read properties of undefined (reading 'label')
    at buildAuthorSystemPrompt (prompts.ts:581)
    at CardAuthoringProvider.authorCandidate (providers.ts:836)
    at boundedRepairCandidate (card-generation-v2-handler.ts:3039)
```

根因是修复路径现场拼了个只有 `objectiveLocalId/objectiveStatement/knowledgeForm` 三字段的
**计划目标替身**，再用 `as never` 绕过 provider 的入参类型。而 `authorCandidate` 第一行就是
`const strategy = input.planObjective.strategy` → undefined → 提示构建查表落空。
代价是：一张卡要修复，整条 run 的 8 张已写候选 + 全部已付费调用一起作废、job 重投再付一遍。

修法是取回真正的计划目标（`plannedObjectiveForCandidateV2`，shared 里的纯函数，按
`planObjectiveLocalId` 在预算内的那批目标里找；找不到就明确抛，不给替身），并把 `as never` 去掉
——留着它，下次同样的错类型系统还是不会拦。两道守卫都做过变异验证：
把调用点改回替身，读源码那条用例立刻红。

**还没被真跑验到的部分**：修复路径本身。这次是第二次尝试 pedagogy 没再判 repair，
所以"修好之后修复真能跑通"仍然只是类型与单测层面的结论，得等下一次真出现 `repair` 判定的批次。

## 32. 那张真实配对题走完了出题到判分（纯函数层，六种答卷）

§31 只证明"作者交得出 matching"，没证明"它出得了题、判得了分"。把库里那张
`dbf061fb` 的 `practice_item` 原样取出来，喂给生产构造函数与判分器：

```
出题：左 3 右 3，标签 6 条
公开载荷里出现正确答案吗: false
判分路由（不该花钱调 critic）: true
  全部配对         → covered        「全部 3 对都配对了」
  错开一位         → partial        「1/3 对正确」
  只对一个         → partial        「1/3 对正确」
  多交一条噪声边      → partial        「有左端配了多条，只算一次」
  一个左端配两条      → partial        「有左端配了多条，只算一次」
  空提交          → not_assessable 「没有提交配对」
```

读出来的四件事：作者自报的 `leftId/rightId` 过得了交叉引用检查（`practiceItemCrossRefError` 返回 null）；
两列各自按内容哈希定序，所以"第 i 个对第 i 个"这种一眼看穿的排布没有出现；公开载荷里
没有 `correctPairs`、也没有任何 `rightId` 字段；判分走 `isDeterministicStructuredPayload`，
不需要 critic。反穷举那两条（多交、一个左端配两条）在真数据上也按预期只算一次。

写脚本时自己踩了两个小坑，都记下来免得下次再犯：`assessStructuredPayload` 是**位置参数**
（`kind, payload, solution`），我一开始传了一个对象，结果六种答卷全判 `not_assessable`，
差点误报成产品缺陷；`practiceItemCrossRefError` 合法时返回的是 `null` 不是 `undefined`。
"错开一位"拿到 1/3 而不是 0/3 也不是 bug——正确映射的顺序与公开左列顺序不同，循环错开
会碰巧对上一对。

### 界面那一处仍然只差一张图

这轮试过一次：造好活租约与读数（`planned=8 authored=3`）准备进生成中那一屏，
点进去发现应用停在**伴星中心的日记页**——有人正在用它。那就抢界面了：立刻把造出来的
状态还原（run 回 `review_ready`、outbox 回 `completed`、我插的读数行删掉）。
库里现在唯一剩下的读数行是 `dbf061fb` 那次真跑的最后一次 tick（`authored=6`，run 已是
`review_ready`，读取端按设计忽略它）——留着当证据，也顺带说明这张表"到终态不删"的取舍。
等应用空闲我再补这张图，或者你在界面上自己看一眼：造一次生成就能看到"已写出 N / M 张"。

## 33. 生成中那一屏也在跑着的 app 里量到了；顺手清掉界面里剩下的「服务端」

造一次活租约 + 读数（`planned=8 authored=3`）挂到 `d375f218` 上，从 笔记库 → 那篇笔记 →
入口按钮（此时已自动变成「**查看生成进度**」）进去，读到的是：

```
eyebrow  正在生成 · 写完一批一次给齐
状态     正在编写候选
meta     已写出 8 / 8 张候选 · 最后更新 7 小时前
gauge    存在、未被 hidden 遮住，aria-valuenow=49
四段     读取笔记已完成 / 形成问题进行中 / 对齐证据待进行 / 等待审核待进行
```

截图在 `/tmp/cdp-generating.png`。**为什么显示 8/8 而不是我塞进去的 3**：读取端取的是
`max(实时读数, 候选表已提交数)`，这条 run 早就提交了 8 张候选，所以 8 是真相、3 被盖住——
这正是"读数不能低于已提交事实"的规则在界面上生效。中间值会走这件事由 §31 的真跑采样证明
（`0→2→3→4→5→6→7→8`），这一张证明的是**渲染路径**：数字上屏、进度条不再整块隐藏。
测完状态已还原（run 回 `review_ready`、outbox 回 `completed`、我插的读数行删掉）。

### 截图里抓到的一句违规文案

那屏上写着「收到**服务端**事件会自动更新」，两处（生成中页的说明行 + 阶段卡的更新时间）。
这正是复盘 #14 定的禁用词。改成「有新进展会自动更新」。

顺带加了一条只扫 `CardGenerationSurface.tsx` 一个文件的守卫，放在
`src/main/renderer-copy-guard.test.ts`——**为什么放 main 侧**：读源码要用 `node:fs`，
而 `tsconfig.web.json` 的编译图里没有 Node 类型，放进 renderer 测试会直接报
`Cannot find module 'node:fs'` / `Cannot find name 'process'`（本仓那条老坑的新实例）。
守卫做过双向验证：现在绿；把「服务端」塞回去就红并把整句打出来；还原再绿。
不做全仓扫描——那是 #14 那次清扫的口径，扫别人正在改的界面只会制造噪音。

回归：桌面 138 文件 1128/1128、typecheck 干净（另两条红是别人在途的
`companion-center-surface.test.ts`）。

## 34. repair 分支：不为了测它给产品开缝，改成把崩溃那一端钉死

想把"修复 → 新修订 → 重跑门禁"整条走一遍，只有两条路：把 `boundedRepairCandidate`
导出（给产品代码开一个只为测试存在的缝），或者在测试里重建一整套
`sealed + plan + candidate + sourceContent` 夹具。两个都不做——前者是我不想留的债，
后者的夹具本身就可能与真实结构漂移，测出来也不算数。

改成钉**崩溃的那一端**（`author-prompt-strategy.test.ts`）：

- 七种题型逐个建提示，断言题型写进去了、被点名的卡有配额那句、没被点名的卡说的是另一句
  （不能出现强制语气）；
- `buildAuthorSystemPrompt` 现在对未知题型**明确抛** `author prompt got an unknown strategy: X`。
  这不是防御性代码：`strategy` 来自持久化的 jsonb，运行时可能不是枚举值，而这条路径
  真炸过一次。变异验证时去掉守卫，测试打印出来的正是当初那句
  `TypeError: Cannot read properties of undefined (reading 'label')`——等于把事故现场
  变成了断言。

**仍然没验到的**：修复之后的候选落库、`candidateRevisionHash` 重算、recheck 收口这三段。
它们要等一次 pedagogy 真判 `repair` 的批次（确定性 provider 永远判 `pass`，
所以测试里也走不到）。下次动这块要么就等真批次，要么认真讨论"要不要给 repair 开一个
可注入的 provider 缝"——那是设计决定，不该由补测试顺手做掉。

回归：worker 715/715、typecheck 干净（另有一条红是别人在途的 `companion-daily-summary.test.ts`）。

### 顺带查出来：配对题的作答界面现在**没有活样本**可点

想在真界面里点一次 `MatchingEditor`，就得有一条带配对变体的学习运行。查了一圈：

- 已激活的卡里带练习件的只有 4 张（2 张 ordering、2 张 single_choice），**没有 matching**；
- 唯一一张 `canonicalAnswer.kind = mapping`（本应派生出配对题）的激活卡，
  实际给出的变体是 `single_choice` + 语音——因为它自己带了一个作者写的 `single_choice` 练习件，
  而规划器按设计**让显式练习件优先于从答案反推的备位结构题**。

所以点不到不是缺陷，是这条优先规则的结果。要验那条 UI 路径只能激活 D6 那批里的配对卡
（那篇笔记在回收站里），这是会往你卡堆里加卡的动作，我没自己做。

**但这条优先规则有个值得你想一下的后果**：一张卡的答案本身就是"两组东西的对应关系"
（mapping）时，作者另写的一道选择题会**盖掉**从答案派生的配对题——而配对题恰好是那种答案
最自然的练法。要不要在"答案形状与练习件形状不冲突时并列给出两个变体"，是产品决定，
不是 bug，我停在这里。

探测期间我建了一条真实学习运行（`14e7009a`），已按服务端签发的允许集合用 `skip_run`
收掉（`phase: skipped`），没留在队列里。顺带记一次工具用错：`skip_run` 的
`confirmationRequired` 是**签发侧**的字段，请求里带上它会 400；本地 `safeParse` 一跑
就看清了（`Unrecognized key(s): confirmationRequired`）——又一次印证"别猜 schema"。

## 35. 第二批 D6 + 关停交还租约的第一次现场生效

为了等一次真判 `repair` 的批次，用同一篇内容新建了一篇夹具笔记跑真生成
（run `6f0047e2`）。这一批没等到 repair（见第 4 条），但捡到了三件别的东西。

### 1. `releaseInflightV2OutboxLeases` 第一次在真实事故里跑通

13:26:27 companion 侧存 `companion-thought.ts` → tsx 5 秒后 force kill。日志：

```
[13:26:27] V2 outbox leases returned so the next worker can take over immediately
[13:26:27] shutdown signal received, waiting for in-flight jobs to finish…
[13:26:48] V2 outbox job processing        ← 新 worker 接手，相隔 21 秒
```

§24 里我写过"调用点那 6 行没测到，要测得开测试后门"——现在它被现场测到了：
交还发生在 drain 之前，所以赶上了 5 秒窗口；没有这一步，这条 run 要挂满 30 分钟。
（第一次尝试已付的调用仍然作废，那是强杀的固有代价，这条改动只解决"多久能重来"。）

### 2. 阶梯在第二批上复现

`authored` 序列 `[0,0,1,2,3,0,0,1,2,3,4,5,6,6]`——前半是第一次尝试（跑到 3 被杀），
后半是重投后完整走到 6。终态 `review_ready`，5 过 1 挂。

### 3. D6 配额第二批：点名 3、兑现 3，形状与第一批逐个相同

| 目标 | 形态 | 点名 | 实交 | 判定 |
|---|---|---|---|---|
| obj-atom-1 | definition | single_choice | single_choice | 兑现 |
| obj-atom-2 | comparison | matching | matching | 兑现 |
| obj-atom-3 | causal_model | true_false | true_false | 兑现 |
| obj-atom-6 | sequence | - | ordering | 未点名（自愿交） |

两批独立真跑都是 3/3 兑现、都出了 matching（库里 matching 累计 2 张），
`practice_quota_short` 两批都没落——因为没有缺额，这正是"只在缺的时候喊"。
配额这一头可以认为稳定了。

### 4. repair 尾段仍未被现场验到（不粉饰）

这批 pedagogy 判的是 keep/drop：候选表里 `revision` 全是 1，没有任何一条重写修订。
两批里一批判了 repair（就是撞出 `strategy` 替身崩溃的那批）、一批没判——
**它是内容相关的，等不来**。要关掉这条只能二选一：给 repair 开一个可注入 provider 的缝
（设计决定，我不顺手做），或者去库里找一批历史上真判过 repair 的旧 run 复现它。
下次动这块先做这个决定，不再"等下一次"。

夹具笔记 `a75da5d4` 已进回收站（软删可恢复），它留下的 6 张候选未激活。

## 36. 结算事件能不能活着走出 api：能

§34 说"事件暂时只落库"，那还差一步没查：它出不出得来（这个仓库的事件出口有一张
`BLOCKED_EVENT_PAYLOAD_KEYS`，`answer`/`front`/`objectiveDraft` 这类键会被递归删掉，
未知键也可能被过滤，不验就不知道）。

做法：给一条真实 run 手工插一条缺额事件（载荷故意带上 `misses[]` 与 `deliveredForm: null`
这种最容易在过滤里丢的形状），走 `GET /v2/card-generation-runs/:runId/events` 读回来：

```json
{"eventSeq": 29, "eventType": "card_generation.practice_quota_short",
 "payload": {"misses": [{"requiredForm": "matching", "deliveredForm": null,
               "objectiveLocalId": "obj-atom-2"}], "metCount": 1, "requiredCount": 3}}
```

原样出来了：事件类型没被白名单挡掉，嵌套数组里的字段一个没少，`null` 也没被抹成缺键。
SSE 走的是同一个查询（`getGenerationRunEventsV2`），所以两条路都通。
**验证完那条假事件已删掉**（库里现在 `practice_quota_short` 计数 0——两批真跑都没有缺额，
本来就不该有）。

到这里，配额这一头从"planner 点名 → 作者交付 → 结算 → 事件 → api 出口"整条都能读到了，
只是界面上还没有任何地方显示它（§26 里留的那个产品决定）。

## 37. 缺额显示在哪：审核页头部（决定 + 落地 + 实测量）

§26 留的那个产品决定这一轮定了：**审核页头部加计数**（不是完成回执，也不是不显示）。

落地的形状是"服务端结算、界面只读"：

- `GET /v2/card-generation-runs/:runId/candidates` 的响应多一个 `practiceQuota`
  （`{requiredCount, metCount}`），由 `summarizePlanPracticeQuotaV2(planResult, candidates)`
  算，内部调的还是 worker 落 `practice_quota_short` 事件那支 `summarizePracticeQuotaV2`。
  缺额若在服务和界面各算一遍，事件里的数和屏幕上写的数就会给出两个答案。
- 头部那一行：`候选 1 / 6 · 6 张还没决定 · 带练习件 4 张，该配的都配上了`
  （这一行的前两段是 `6f0047e2` 的真实读数，后一段是新加的），
  有缺额时后半句换成 `该配的 3 张里漏了 1 张`。`requiredCount: 0`（这批没点名要练习件，
  或 plan 是 D6 之前封存的）时后半句整段不出现——不给一次没有发生过的要求报缺额。
- 两个数各自成立：`带练习件 N 张` 数的是卡上真的有道题的张数（含自愿交的），
  `该配的 M 张` 是点名数。实测那一批就是 4 与 3 同时出现，两句话都不假。

一处 shared 的结构性障碍值得记：`cardPlanV2Schema` 用了 `superRefine`，包一层之后
不再暴露 `.shape`，读路径拿不到嵌套的 `result` 合同（第一次实现就在这一点上抛
`Cannot read properties of undefined`）。改成把结论联合类型抽成 `cardPlanResultV2Schema`
再被 `cardPlanV2Schema` 引用，而不是复制一份——复制的那份会悄悄过期。

**测试先写、并且验过它真的会红**：

- 桌面组件测 3 条（缺额 / 配齐 / 没点名）。改动前 2 红（缺额、配齐），实现后全绿；
  再把"requiredCount 为 0 就整段不显示"这一句拿掉，第 3 条转红——它不是永远绿的负向断言。
- api 单测 `getGenerationRunCandidatesV2` 3 条：去重（顺带确认返回结构）、
  点名的 3 张里"形状对上才算兑现"（obj-1 交 single_choice 算、obj-2 要求 true_false 却交
  ordering 算缺额、obj-3 没点名的自愿交 matching 不占配额 → `{requiredCount:2, metCount:1}`）、
  以及 D6 之前的 plan 行（没有 `practiceForm` 键）解析不过 → `{0,0}`。
- 回归面：shared 340/340、api `run-service` 23/23、桌面 30/30（含文案守卫）、
  api / shared / desktop / worker 四份 typecheck 全过。

**服务端这一步是真跑出来的**，不是只测函数：owner 登录打真实 HTTP，
`6f0047e2` 与 `dbf061fb` 两批都回 `practiceQuota:{requiredCount:3, metCount:3}`，
同一批候选里带练习件的是 4 张（4>3 正是"自愿交的不算进配额"那个形状），
与直接在库里按最新 revision 对的 `required / delivered` 逐条一致。

**界面这一屏今天量不了**：桌面 dev 渲染层 5173 已经没人监听（`curl` 直接 000），
在跑的 Electron 窗口停在 `chrome-error://`，而它的渲染层没有 HMR——按并发会话的说明，
要看到新头部必须重启桌面端。所以这一条的主张只到"服务端已下发 + jsdom 已断言文本"，
真机读数等下一次重启窗口。

## 38. A1 的前置约束落地：候选的幂等键，以及第一版键选错了这件事

用户催的是"别等迁移，直接应用"。先量了一下到底有什么可应用：
`__drizzle_migrations` 有 260 行，journal 有 252 条，把 252 条各自的 SQL 文件算 sha256
逐个对库——**252 条全部命中**，也就是仓库里没有任何"写了没应用"的迁移（那 8 行是历史上
被改过内容/重编号留下的旧 hash，不影响）。所以"等"不是等迁移器，是等我自己没写的那条迁移。

于是补 A1（§18/§21 里那条"逐候选可见要先有候选幂等"）的前置：
`0253_candidate_objective_revision_unique.sql`——给
`card_generation_candidates_v2` 建唯一索引。它不改任何写路径，只是把
"重投的 job 第二次插同一目标"从"悄悄多出几张候选"变成"当场失败"。

**第一版的键选错了，而且错得看不出来。** 我按 dev 库实测选的
`(workspace_id, run_id, plan_objective_local_id, revision)`：1600 行候选里
`distinct (run, objective, revision) = 1600`（建得起来、不动数据），
`distinct (run, objective) = 1545`（同一目标确实有 revision 2，所以 revision 不能拿掉）。
应用完之后去读 replan 那条路才发现漏了一列：`card_generation_replan_set` 会把旧计划的候选
`supersede` 而**不删除**（immutable），再用 `planVersion+1` 的新计划重新一批 author，
而新计划的 `objectiveLocalId` 同样由原子下标导出（`obj-atom-1`…）、revision 也从 1 起
——旧键会把「再生成一次候选」和整条 replan 路当场打死。dev 库里 `plan_version>1` 的候选
是 0 行，所以旧键也"建得起来"：**能建索引只证明历史没走过这条路，不证明键选对了**。
现在键里带上 `plan_version`，并 DROP 掉初版那条名字不同的索引（两条语句都幂等，
文件 hash 变了会让迁移器重跑一次，重跑安全）。

四条探针（都在 `BEGIN … ROLLBACK` 里跑完，事后 `candidate_revision_id='ffff…'` 计数 0）：

| 探针 | 结果 |
|---|---|
| 同 run / 同 plan_version / 同目标 / 同 revision 再插一行 | `duplicate key … "cg_v2_cand_plan_objective_revision_idx"`，键值原样报出 `(workspace, run, obj-atom-1, 1)` |
| 同目标同 revision 但 `plan_version=2`（replan 那一波） | `INSERT 0 1` |
| 同目标同 plan_version 但 `revision=2`（regenerate / 有界修复） | `INSERT 0 1` |
| `pg_indexes` 终态 | 只剩带 plan_version 的那条唯一索引，初版名字已消失 |

迁移测先写后红再绿，并且做了变异检查：把 SQL 里的 `plan_version` 删掉，
`索引里缺列 plan_version` 立刻红——这条断言不是装饰。

**与并发会话的编号冲突（要人裁决，不是我能单干的）**：这个工作树里 journal 的
idx 252 是 `0253_candidate_objective_revision_unique`（我写的、已应用的），磁盘上
**没有** `0253_companion_self_correction_learned.sql`；对面报的那批文件
（`0247_companion_synthesis_latency` / `0252_objective_fact_recall_severity` /
`0254_…` / `0255_…`）与那几个 commit 号，在本树 `git log --all`、`ls` 里全部不存在。
两边都以为自己在同一条树上给 idx 252 登记了不同的 tag——共享的是那个 dev 库，
不共享的是 journal 文件。谁后提交，谁就把对方的登记覆盖成"文件在、清单没有"，
而那条迁移就永远不被应用（正是 `migration-journal-coverage` 守的那个坑）。

A1 本身还没做：这条索引只是让它有可能开始写。剩下的两步是
①入口守卫从"看 `run.status`"改成"看自己那条 outbox 租约"（否则重投对着已提交的
`authoring` 静默空转，把 run 钉死、这篇笔记此后每次生成都吃 409，§21），
②逐候选提交时按目标"已有则跳过/补 revision"，而不是裸 INSERT。
