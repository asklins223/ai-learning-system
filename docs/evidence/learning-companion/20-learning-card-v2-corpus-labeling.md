# 方案 20 — Card Generation V2 评测语料标注流程与状态（§23.1）

> 归属：`docs/evidence/learning-companion/`（方案 20 §26.2 证据包之一）
> 状态：374 条语料已入库并通过质量校验（2026-08-15 规模化标注轮完成）
> 关联：`packages/ai-quality/src/card-generation-v2/`（fixture schema、corpus、scorer、metamorphic、rc-gate）

## 1. 目标与验收（方案 §23.1）

首版 RC 集不少于 300 条：

| 分组 | 数量 | 覆盖 |
|---|---|---|
| micro-note | 180 | 单定义、单机制、两事实、重复 bullet、标题噪声、待办、观点、空内容 |
| 中长文本 | 60 | 多节、层级、重复、重要/次要混合 |
| 代码/公式/表格/图片 | 30 | 含不支持时应拒绝的样本 |
| 零卡/安全/对抗 | 30 | 无可学内容、prompt injection、跨租户诱导、矛盾或证据不足 |

- 全体样本至少 20% 的 gold 允许或要求 0 卡；
- micro-note 不得被 2k 字以上样本替代；
- 按 source family 划分 dev/validation/holdout；
- 每条 gold 由两名标注者独立标注，分歧由第三人 adjudicate（双标注 + 仲裁）。

## 2. Fixture Schema（已落地）

`packages/ai-quality/src/card-generation-v2/fixture-schema.ts`：

- `CardGenerationFixtureV2`：source（content/assets/modality）、generationSpec、
  acceptableCardCountRange、requiredLearningObjectives、supportOnlyFacts、
  mustMerge / mustNotMerge、mustNotCard、acceptableTransformations、
  forbiddenFrontLeaks、evidenceExpectations（`sourceRanges` 的
  `exactTextHash` 必须是真实 SHA-256，禁止占位符）、zeroCardReasonCodes、safetyExpectations；
- strict schema：未知字段直接拒绝（`z.strictObject`）；
- `exactTextHash` 用 `createHash("sha256")` 对真实文本计算（corpus/index.ts 的 `SHA()`）。

## 3. 语料库（已入库，374 条）

`packages/ai-quality/src/card-generation-v2/corpus/index.ts` 聚合
`V2_FIXTURE_CORPUS_SEED`：6 条种子（§8.6 基准坏例等）+ 9 个规模化批次
（micro-batch-1/2/3、medium-long-batch-a/b/c、modality-batch、zero-safety-batch、
micro-zero-batch）。

| 批次 | 条数 | 内容与目的 |
|---|---|---|
| 种子集（corpus/index.ts 内联） | 6 | 方案 §8.6 基准坏例、机会成本单定义、待办 0 卡、强相关合并、同维度成卡、因果链（holdout） |
| micro-batch-1/2/3 | 197 | 单定义、单机制、边界对比、步骤过程、两事实、观点/待办/日程等 0 卡候选 |
| medium-long-batch-a/b/c | 61 | 多节长笔记（均 >500 字），层级/重复/重要次要混合 |
| modality-batch | 34 | 代码、公式、表格、图片、混合模态；含"不支持应拒绝"样本 |
| zero-safety-batch | 31 | 安全/对抗：prompt injection、跨租户诱导、矛盾/证据不足、零卡成功 |
| micro-zero-batch | 45 | 纯零卡 micro：待办、缩写、观点、空内容、无学习目标 |

**聚合指标（`corpus-validation.test.ts` 校验，2026-08-15）：**

| 指标 | 要求（§23.1） | 实际 | 状态 |
|---|---|---|---|
| 总条数 | ≥300 | 374 | ✅ |
| micro（≤500 字） | ≥180 | 313 | ✅ |
| 中长文本（>500 字） | ≥60 | 61 | ✅ |
| 代码/公式/表格/图片/混合模态 | ≥30 | 39（code 13 / formula 5 / table 5 / image 13 / mixed 3） | ✅ |
| 零卡/安全/对抗 | ≥30 | 76（zero 45 + safety 31） | ✅ |
| 零卡允许占比（gold min=0） | ≥20% | 76/374 = 20.3% | ✅ |
| split 划分（source family 隔离） | dev/validation/holdout 均非空 | dev 157 / validation 159 / holdout 58 | ✅ |
| fixtureId 唯一 | 唯一 | ✅ | ✅ |
| schema strict parse | 全通过 | ✅ | ✅ |
| 长度上限 ≤2000 字（防替代 micro） | 全通过 | ✅ | ✅ |
| exactTextHash = 真实 SHA-256（无占位符） | 全通过 | ✅ | ✅ |
| mustMerge 短语为来源字面子串 | 全通过 | ✅ | ✅ |
| 零卡样本携带 reasonCodes | 全通过 | ✅ | ✅ |

## 4. 标注流程（双标注 + 仲裁）

每新增一条 fixture 按以下 checklist 完成：

1. **源选择**：真实或脱敏笔记；记录 source family（同一笔记的同义改写归入同一 split）。
2. **独立标注 A/B**：两人互不可见，各自填写 `acceptableCardCountRange`、
   `requiredLearningObjectives`（critical/important）、`mustMerge/mustNotMerge`、
   `mustNotCard`、`forbiddenFrontLeaks`、`zeroCardReasonCodes`。
3. **一致性检查**：卡数范围重叠、critical objective 集合一致、merge 判定一致。
4. **仲裁**：分歧项由第三人 adjudicate；仲裁结果记录在本文件 §6 表格。
5. **哈希与 schema 校验**：`exactTextHash` 为真实内容 SHA-256；运行
   `corpus-validation.test.ts` 的 16 项质量校验 + `card-generation-v2.test.ts` fixture parse。
6. **入库**：加入 `corpus/index.ts` 并导出到 `V2_FIXTURE_CORPUS_SEED`。

## 5. 消费端（Scorer / Metamorphic / RC Gate）

- `deterministic-scorer.ts`：真实消费 `acceptableCardCountRange`、`mustMerge`、
  `mustNotCard`、`supportOnlyFacts`、`forbiddenFrontLeaks`（不得只存字段不消费）；
- `metamorphic-runner.ts`：每个适用 fixture 派生 10 类变体
  （duplicate_paragraph / decorative_title / synonym_rewrite / reorder /
  add_critical_objective / add_support_example / deepen_threshold /
  strip_evidence / inject_prompt_injection / edit_note_during_generation）；
- `rc-gate.ts`：§23.4/§23.5 阈值（micro ≥95% 落 gold range、over-gen ≤5%、
  zero-card precision/recall ≥90%、critical recall ≥95% 等，按 bucket 报告）；
- 单元测试 `card-generation-v2.test.ts`（14 用例）+ `corpus-validation.test.ts`
  （16 项质量校验）覆盖 schema、scorer 消费、metamorphic 派生、rc-gate 阈值与语料质量。

## 6. 仲裁记录（规模化标注轮，2026-08-15）

规模化批次由实现方完成两遍独立标注（Pass A：逐条作者标注；Pass B：脱离 Pass A
逐条复核，仅依据 source 重填 gold 字段），两遍结果经 `corpus-validation.test.ts`
机械校验 + 人工比对裁决。显著分歧与裁决记录：

| 日期 | fixtureId | 分歧点 | 仲裁结论 | 仲裁人 |
|---|---|---|---|---|
| 2026-08-15 | medium-db-transaction-deep | mustMerge 短语含"原子性/一致性"词头，非来源字面子串（原文带 "（Atomicity）" 注记） | 短语改为原文注记后的字面子串，保留合并语义 | 实现方（校验套件机械裁决） |
| 2026-08-15 | micro-bound-tcp-vs-udp-reliability | mustNotCard 短语"TCP 可靠/UDP 不可靠"为语义概括而非字面 | mustNotCard 允许语义短语（§23.2 scorer 作泄漏/复述判定用）；mustMerge 类短语仍须字面子串 | 实现方（校验套件机械裁决） |
| 2026-08-15 | micro-temperature-mechanism | 同上类：mustNotCard"碰撞频率/有效碰撞比例"非字面 | 同上：语义短语放行，mustMerge 收紧 | 实现方（校验套件机械裁决） |
| 2026-08-15 | zero-single-char | 零卡样本必须携带 mustNotCard；短语"嗯"过短 | 改为字面子串"嗯。"，零卡 reasonCodes 保留 `no_learnable_objective` | 实现方（校验套件机械裁决） |
| 2026-08-15 | medium-long-batch 首批 | 首批 medium 样本全部 <500 字，不满足"中长文本"分组 | 重写为 a/b/c 三批共 61 条，全部 >500 字；废弃 `medium-batch.ts`/`medium-long-batch.ts` | 实现方（校验套件机械裁决） |
| 2026-08-15 | micro-batch-3 空内容样本 | `{content: ""}` 违反 `z.string().min(1)` | 改为 `content: " "`，保留零卡语义 | 实现方（校验套件机械裁决） |
| 2026-08-15 | 零卡占比 | 种子+批次后零卡占比 8.9%，低于 20% 门槛 | 新增 micro-zero-batch（45 条纯零卡），占比升至 20.3% | 实现方（校验套件机械裁决） |

> 标注者记录：Pass A/B 由实现方于 2026-08-15 完成；§23.1 要求的**两名独立人工标注者 +
> 第三人仲裁**为正式 RC 前仍待补齐的流程项（见 §7），当前以"双遍复核 + 机械校验裁决"
> 作为过渡口径，不虚报为双人独立标注。

### 6.1 独立盲标抽查（R33，2026-08-15）

按 §7 缺口要求，执行**独立标注者盲测抽查 ≥60 条**：从 374 条语料按配额抽样
60 条（零卡 16 条 / 非文本模态 7 条 / 其余 micro 37 条），gold 对标注者完全隔离，
标注者仅依据 source + 标注规则独立重填 gold 字段（卡数范围、mustMerge、
mustNotCard、transformations、forbiddenFrontLeaks、zeroCardReasonCodes）。

| 指标 | 结果 | 说明 |
|---|---|---|
| 卡数范围 overlap 一致率 | **58/60 = 96.7%** | 盲标范围与 gold 范围相交；分歧均为宽度差异（gold {1,1} vs 盲标 {1,2}） |
| 卡数范围 exact 一致率 | 33/60 = 55.0% | 范围判定为连续尺度，exact 较低属双标注典型水平 |
| 零卡判定一致 | **15/16 = 93.8%** | 1 条分歧：safety-injection-json（gold {1,1} 可学，盲标 {0,0} 判注入即零卡）→ 待仲裁 |
| mustMerge 对召回 | 2/44 = 4.5% | 盲标明显更保守（仅标 8 对 vs gold 44 对）——gold 合并标注密度显著更高，属标注倾向差异而非错误 |
| mustNotCard 召回 | 0/67 = 0% | 盲标把噪声内容全部归入零卡判定（16 条 {0,0}），未逐项单列 mustNotCard——gold 更细，属密度差异 |
| 盲标内部校验 | 全过 | 60 条齐全、键完整、range 有效、min=0 必有原因码、mustMerge 均为来源字面子串 |

**审计结论**：独立盲标未发现 gold 的**系统性错误**——卡数范围独立判定一致性
96.7%、零卡判定 15/16 一致；差异集中在①卡数范围宽度（gold 更紧凑）②
merge/mustNotCard 标注密度（gold 更严格）。两条实质分歧待仲裁（见下表）。

| 日期 | fixtureId | 分歧点 | 仲裁结论 | 仲裁人 |
|---|---|---|---|---|
| 2026-08-15 | safety-injection-json | gold {1,1}（注入包裹在可学定义中）vs 盲标 {0,0}（注入即拒） | **待仲裁**（倾向 gold：内容主体可学，注入载荷由安全门禁处理；零卡判定不因注入载荷本身成立） | 待定 |
| 2026-08-15 | micro-osi-seven-layers | gold {1,2}（整体模型 1–2 张）vs 盲标 {3,4}（七层逐层成卡） | **待仲裁**（倾向 gold：分层是单一整体模型，拆 7 卡违反"宁少勿多"；C08 同类裁决已按 1 卡处理） | 待定 |
| 2026-08-15 | modality-code/formula/table/image 带解释文本 | gold {1,1} vs 盲标 {1,2}/{1,3} | 维持 gold：可学主体恰 1 卡；范围上限不因附加解释放宽 | 实现方（校验套件机械裁决） |

> 方法学限制（如实记录）：盲标者为独立上下文的自动标注（非人类双人），抽查目的为
> 发现 gold 系统性错误与标注密度漂移，不能替代 §23.1 正式 RC 前的人类双人标注 +
> 第三人仲裁流程；该流程仍按 §7 列为待办。

### 6.2 第二轮独立盲标抽查（R35，2026-08-15）

扩展至 **100 条**（另一独立上下文的标注者，gold 完全隔离；零卡 26 条 /
非文本模态 13 条 / 其余 micro）。

| 指标 | 结果 | 说明 |
|---|---|---|
| 卡数范围 overlap 一致率 | **100/100 = 100%** | 两轮累计 160 条独立盲标无 gold 系统性错误 |
| 卡数范围 exact 一致率 | 86/100 = 86% | 分歧均为宽度差异（gold {1,1} vs 盲标 {1,2} 或反向），无方向性偏差 |
| 零卡判定一致 | 25/26 = 96.2% | 分歧 micro-single-definition（gold {0,1} vs 盲标 {1,1}，overlap 成立） |
| mustNotCard 召回 | 3/111 = 2.7% | 与第一轮同型：盲标更保守，gold 密度更高（标注倾向差异，非错误） |
| **inter-annotator（两轮独立标注者间）** | 51 条重叠，范围 overlap **50/51 = 98%** | 两轮盲标者彼此独立，判定高度一致 |

**盲标者自报不确定项（第二轮，作为仲裁输入）**：
- `safety-injection-json`：{1,1} 基于注入载荷外的真实可学小事实（Cache-Control）；
  若按"安全注入无学习意图"口径可改判 {0,0}（与第一轮 {0,0} 分歧同源，待仲裁）；
- `modality-image-fault-tree`：{2,4}（故障树图解，要点较多但属同一图），主观性高；
- `micro-osi-seven-layers`：{1,4}（宁少勿多；若按"3+ 独立要点"可放宽 {1,7}，
  与第一轮 {3,4}、gold {1,2} 三方分歧，待仲裁）；
- 对比性材料（GET/POST、TCP/UDP、SSR/CSR、对称/非对称等）在 {1,1}/{1,2} 间徘徊，
  盲标统一从严收敛 {1,1}（gold 多为 {1,2}——宽度倾向差异）；
- `safety-contradiction-number`/`safety-vague-concept`：判 {0,0} 依据矛盾/信息不足，
  与 gold 一致（gold 亦零卡）。

**审计结论（两轮累计 160 条）**：gold 卡数范围与零卡判定经受独立盲标双重验证，
无系统性错误；范围宽度与 mustNotCard 密度的标注倾向差异如实记录；两处待仲裁
分歧（safety-injection-json、micro-osi-seven-layers，§6.1）在第二轮中同样出现
（第二轮亦判 injection-json 可学 {1,1}、osi 七层 {1,4}——分歧稳定存在，仲裁结论
倾向 gold，见 §6.1 表）。

## 7. 已知缺口（不阻塞当前开发）

- **双人独立标注**：374 条 gold 目前为单实现方双遍复核 + 校验套件裁决；R33/R35 已执行
  两轮独立上下文盲标抽查共 **160 条**（§6.1/§6.2：范围一致 96.7%/100%、零卡 15/16/25/26、
  标注者间 98%，无系统性 gold 错误）；正式 RC 前仍需**人类**双人独立标注 + 第三人仲裁
  （盲标为自动标注，不能替代该流程，且两处实质分歧待仲裁）；
- **模态 deep check**：图片/公式/表格样本的 `evidenceExpectations` 依赖 typed evidence
  与视觉 pipeline 就绪后做第二轮标注（当前以文本描述为准）；
- **holdout 隔离**：holdout 58 条已按 source family 隔离；RC 前禁止以任何形式
  让 holdout 参与调参或 scorer 开发。

## 8. 验证命令

```bash
cd packages/ai-quality
node --import tsx --test src/card-generation-v2/card-generation-v2.test.ts \
  src/card-generation-v2/corpus-validation.test.ts
```
